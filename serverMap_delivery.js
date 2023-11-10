require('dotenv').config();
//require("newrelic");
//var dash = require("appmetrics-dash");
var express = require('express');
const http = require('http');
const fs = require('fs');

const { logger } = require('./LogService');

var app = express();
var server = http.createServer(app);
const helmet = require('helmet');
const requestAPI = require('request');
//....
const { promisify, inspect } = require('util');
const urlParser = require('url');

const redis = require('redis');

const client = /production/i.test(String(process.env.EVIRONMENT))
    ? null
    : redis.createClient({
          host: process.env.REDIS_HOST,
          port: process.env.REDIS_PORT,
      });
var RedisClustr = require('redis-clustr');
var redisCluster = /production/i.test(String(process.env.EVIRONMENT))
    ? new RedisClustr({
          servers: [
              {
                  host: process.env.REDIS_HOST_ELASTICACHE,
                  port: process.env.REDIS_PORT_ELASTICACHE,
              },
          ],
          createClient: function (port, host) {
              // this is the default behaviour
              return redis.createClient(port, host);
          },
      })
    : client;
const redisGet = promisify(redisCluster.get).bind(redisCluster);

var chaineDateUTC = null;
var dateObject = null;
const moment = require('moment');
const { stringify, parse } = require('flatted');

//! Attach DynamoDB helper
const {
    dynamo_insert,
    dynamo_update,
    dynamo_find_get,
    dynamo_find_query,
} = require('./DynamoServiceManager');

const { filter } = require('compression');

function resolveDate() {
    //Resolve date
    var date = new Date();
    date = moment(date.getTime()).utcOffset(2);

    dateObject = date;
    date =
        date.year() +
        '-' +
        (date.month() + 1) +
        '-' +
        date.date() +
        ' ' +
        date.hour() +
        ':' +
        date.minute() +
        ':' +
        date.second();
    chaineDateUTC = new Date(date).toISOString();
}
resolveDate();

//--------------DRIVER'S DEBUG DATA-------------------------------------------------------------------
/*const driverCacheData = {
  user_fingerprint:
    "23c9d088e03653169b9c18193a0b8dd329ea1e43eb0626ef9f16b5b979694a429710561a3cb3ddae",
  latitude: -22.567989,
  longitude: 17.084384,
  date_logged: chaineDateUTC,
};
//Cache
////logger.info("[1] Initialize debug data in cache");
redisCluster.set(
  driverCacheData.user_fingerprint,
  JSON.stringify(driverCacheData),
  
);*/
//-----------------------------------------------------------------------------------------------------

function logObject(obj) {
    ////logger.info(inspect(obj, { maxArrayLength: null, depth: null, showHidden: true, colors: true }));
}

function logToSimulator(socket, data) {
    socket.emit('updateTripLog', { logText: data });
}

/**
 * Responsible for finding vital ETA and route informations from one point
 * to another.
 * @param simplifiedResults: to only return the ETA and distance infos
 * @param cache: to cache the results to the provided REDIS key at the provided value index, DO NOT OVERWRITE
 */
function getRouteInfosDestination(
    coordsInfos,
    resolve,
    simplifiedResults = false,
    cache = false
) {
    let destinationPosition = coordsInfos.destination;
    let passengerPosition = coordsInfos.passenger;
    //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
    //? 1. Destination
    //? Get temporary vars
    let pickLatitude1 = parseFloat(destinationPosition.latitude);
    let pickLongitude1 = parseFloat(destinationPosition.longitude);
    //! Coordinates order fix - major bug fix for ocean bug
    if (
        pickLatitude1 !== undefined &&
        pickLatitude1 !== null &&
        pickLatitude1 !== 0 &&
        pickLongitude1 !== undefined &&
        pickLongitude1 !== null &&
        pickLongitude1 !== 0
    ) {
        //? Switch latitude and longitude - check the negative sign
        if (parseFloat(pickLongitude1) < 0) {
            //Negative - switch
            destinationPosition.latitude = pickLongitude1;
            destinationPosition.longitude = pickLatitude1;
        }
    }
    //? 2. Passenger
    //? Get temporary vars
    let pickLatitude2 = parseFloat(passengerPosition.latitude);
    let pickLongitude2 = parseFloat(passengerPosition.longitude);
    //! Coordinates order fix - major bug fix for ocean bug
    if (
        pickLatitude2 !== undefined &&
        pickLatitude2 !== null &&
        pickLatitude2 !== 0 &&
        pickLongitude2 !== undefined &&
        pickLongitude2 !== null &&
        pickLongitude2 !== 0
    ) {
        //? Switch latitude and longitude - check the negative sign
        if (parseFloat(pickLongitude2) < 0) {
            //Negative - switch
            passengerPosition.latitude = pickLongitude2;
            passengerPosition.longitude = pickLatitude2;
        }
    }
    //!!! --------------------------
    let url =
        process.env.URL_ROUTE_SERVICES +
        'point=' +
        passengerPosition.latitude +
        ',' +
        passengerPosition.longitude +
        '&point=' +
        destinationPosition.latitude +
        ',' +
        destinationPosition.longitude +
        '&heading_penalty=0&avoid=residential&avoid=ferry&ch.disable=true&locale=en&details=street_name&details=time&optimize=true&points_encoded=false&details=max_speed&snap_prevention=ferry&profile=car&pass_through=true';
    //Add instructions if specified so
    if (
        coordsInfos.setIntructions !== undefined &&
        coordsInfos.setIntructions !== null &&
        coordsInfos.setIntructions
    ) {
        url += '&instructions=true';
    } //Remove instructions details
    else {
        url += '&instructions=false';
    }
    requestAPI(url, function (error, response, body) {
        if (body != undefined) {
            if (body.length > 20) {
                try {
                    body = JSON.parse(body);
                    if (body.paths[0].distance != undefined) {
                        let distance = body.paths[0].distance;
                        let eta =
                            body.paths[0].time / 1000 >= 60
                                ? Math.round(body.paths[0].time / 60000) +
                                  ' min away'
                                : Math.round(body.paths[0].time / 1000) +
                                  ' sec away'; //Sec
                        //...
                        if (cache !== false) {
                            //Update the cache
                            //Check for previous redis record
                            new Promise((res) => {
                                redisGet(cache.redisKey).then(
                                    (resp) => {
                                        if (resp !== null) {
                                            //Has a record, update the provided value inddex with the result
                                            try {
                                                resp = JSON.parse(resp);
                                                resp[cache.valueIndex] = {
                                                    eta: eta,
                                                    distance: distance,
                                                };
                                                redisCluster.setex(
                                                    cache.redisKey,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(resp)
                                                );
                                                res(true);
                                            } catch (error) {
                                                //Write new record
                                                let tmp = {};
                                                tmp[cache.valueIndex] = {
                                                    eta: eta,
                                                    distance: distance,
                                                };
                                                redisCluster.setex(
                                                    cache.redisKey,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(tmp)
                                                );
                                                res(true);
                                            }
                                        } //Write brand new record
                                        else {
                                            let tmp = {};
                                            tmp[cache.valueIndex] = {
                                                eta: eta,
                                                distance: distance,
                                            };
                                            redisCluster.setex(
                                                cache.redisKey,
                                                process.env
                                                    .REDIS_EXPIRATION_5MIN,
                                                JSON.stringify(tmp)
                                            );
                                            res(true);
                                        }
                                    },
                                    (error) => {
                                        //Skip caching
                                        res(false);
                                    }
                                );
                            }).then(
                                () => {
                                    ////logger.info("Updated relative eta cache.");
                                },
                                () => {}
                            );
                        }
                        //...
                        if (simplifiedResults === false) {
                            var rawPoints = body.paths[0].points.coordinates;
                            var pointsTravel = rawPoints;
                            //=====================================================================
                            resolve({
                                routePoints: pointsTravel,
                                driverNextPoint: pointsTravel[0],
                                destinationPoint: [
                                    destinationPosition.longitude,
                                    destinationPosition.latitude,
                                ],
                                instructions:
                                    coordsInfos.setIntructions !== undefined &&
                                    coordsInfos.setIntructions !== null
                                        ? body.paths[0].instructions
                                        : null,
                                eta: eta,
                                distance: distance,
                            });
                        } //Simplify results
                        else {
                            //=====================================================================
                            resolve({
                                eta: eta,
                                distance: distance,
                            });
                        }
                    } else {
                        resolve(false);
                    }
                } catch (error) {
                    resolve(false);
                }
            } else {
                resolve(false);
            }
        } else {
            resolve(false);
        }
    });
}

/**
 * @func getRouteInfos()
 * Inputs: coordsInfos, resolve
 * - coordsInfos: information about the user's location.
 * Get the route details for all the case scenarios
 * Scenarios: Route to pickup, route to destination
 * routeInfos is present to distinuish between pickup route requests, destinations route request or other scenarios
 * FOR DRIVERS AND PASSENGERS.
 * @distance : meters
 * @eta : minutes or seconds
 */
function getRouteInfos(coordsInfos, resolve) {
    let driverPosition =
        coordsInfos.driver === undefined
            ? coordsInfos.passenger_origin
            : coordsInfos.driver; //CAREFUL COULD BE THE PASSENGER'S ORIGIN POINT, especially useful when a request is still pending.
    let passengerPosition =
        coordsInfos.passenger === undefined
            ? coordsInfos.passenger_destination
            : coordsInfos.passenger; //CAREFUL COULD BE THE PASSENGER'S PICKUP LOCATION OF DESTINATION (ref. to the app code).
    let destinationPosition =
        coordsInfos.destination === undefined ? false : coordsInfos.destination; //Deactive when a request is still in progress as the destination information is already contained in @var passenger_destination.
    /*if (coordsInfos.destination !== undefined) {
    destinationPosition = coordsInfos.destination;
  }*/
    //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
    //? 1. Driver
    //? Get temporary vars
    let pickLatitude1 = parseFloat(driverPosition.latitude);
    let pickLongitude1 = parseFloat(driverPosition.longitude);
    //! Coordinates order fix - major bug fix for ocean bug
    if (
        pickLatitude1 !== undefined &&
        pickLatitude1 !== null &&
        pickLatitude1 !== 0 &&
        pickLongitude1 !== undefined &&
        pickLongitude1 !== null &&
        pickLongitude1 !== 0
    ) {
        //? Switch latitude and longitude - check the negative sign
        if (parseFloat(pickLongitude1) < 0) {
            //Negative - switch
            driverPosition.latitude = pickLongitude1;
            driverPosition.longitude = pickLatitude1;
        }
    }
    //? 2. Passenger
    //? Get temporary vars
    let pickLatitude2 = parseFloat(passengerPosition.latitude);
    let pickLongitude2 = parseFloat(passengerPosition.longitude);
    //! Coordinates order fix - major bug fix for ocean bug
    if (
        pickLatitude2 !== undefined &&
        pickLatitude2 !== null &&
        pickLatitude2 !== 0 &&
        pickLongitude2 !== undefined &&
        pickLongitude2 !== null &&
        pickLongitude2 !== 0
    ) {
        //? Switch latitude and longitude - check the negative sign
        if (parseFloat(pickLongitude2) < 0) {
            //Negative - switch
            passengerPosition.latitude = pickLongitude2;
            passengerPosition.longitude = pickLatitude2;
        }
    }
    //? 3. Destination
    //? Get temporary vars
    if (destinationPosition !== false && destinationPosition !== undefined) {
        var pickLatitude3 = parseFloat(destinationPosition.latitude);
        var pickLongitude3 = parseFloat(destinationPosition.longitude);
        //! Coordinates order fix - major bug fix for ocean bug
        if (
            pickLatitude3 !== undefined &&
            pickLatitude3 !== null &&
            pickLatitude3 !== 0 &&
            pickLongitude3 !== undefined &&
            pickLongitude3 !== null &&
            pickLongitude3 !== 0
        ) {
            //? Switch latitude and longitude - check the negative sign
            if (parseFloat(pickLongitude3) < 0) {
                //Negative - switch
                destinationPosition.latitude = pickLongitude3;
                destinationPosition.longitude = pickLatitude3;
            }
        }
    }
    //!!! --------------------------
    //logger.info(`DRIVER POSITION -> ${JSON.stringify(driverPosition)}`);
    //logger.info(`PASSENGER POSITION -> ${JSON.stringify(passengerPosition)}`);
    //logger.info(`DESTINATION POSITION -> ${JSON.stringify(destinationPosition)}`);

    url =
        process.env.URL_ROUTE_SERVICES +
        'point=' +
        driverPosition.latitude +
        ',' +
        driverPosition.longitude +
        '&point=' +
        passengerPosition.latitude +
        ',' +
        passengerPosition.longitude +
        '&heading_penalty=0&avoid=residential&avoid=ferry&ch.disable=true&locale=en&details=street_name&details=time&optimize=true&points_encoded=false&details=max_speed&snap_prevention=ferry&profile=car&pass_through=true&instructions=false';

    ////logger.info(url);

    requestAPI(url, function (error, response, body) {
        if (body != undefined) {
            if (body.length > 20) {
                try {
                    body = JSON.parse(body);
                    if (body.paths[0].distance != undefined) {
                        let distance = body.paths[0].distance;
                        let eta =
                            body.paths[0].time / 1000 >= 60
                                ? Math.round(body.paths[0].time / 60000) +
                                  ' min away'
                                : Math.round(body.paths[0].time / 1000) +
                                  ' sec away'; //Sec

                        let rawPoints = body.paths[0].points.coordinates;
                        let pointsTravel = rawPoints;
                        //=====================================================================
                        //Get destination's route infos
                        if (destinationPosition !== false) {
                            new Promise((res) => {
                                let bundleData = {
                                    passenger: passengerPosition,
                                    destination: destinationPosition,
                                };
                                getRouteInfosDestination(
                                    bundleData,
                                    res,
                                    false,
                                    coordsInfos.redisKey
                                );
                            }).then(
                                (result) => {
                                    //logger.info("Ready to place");
                                    if (
                                        result !== false &&
                                        result !== undefined &&
                                        result != null
                                    ) {
                                        resolve({
                                            routePoints: pointsTravel,
                                            destinationData: result,
                                            driverNextPoint: pointsTravel[0],
                                            pickupPoint:
                                                coordsInfos.passenger_origin ===
                                                undefined
                                                    ? [
                                                          passengerPosition.longitude,
                                                          passengerPosition.latitude,
                                                      ]
                                                    : [
                                                          driverPosition.longitude,
                                                          driverPosition.latitude,
                                                      ],
                                            //driverNextPoint: pointsTravel[pointsTravel.length - 1],
                                            eta: eta,
                                            distance: distance,
                                        });
                                    } else {
                                        resolve({
                                            routePoints: pointsTravel,
                                            destinationData: null,
                                            pickupPoint:
                                                coordsInfos.passenger_origin ===
                                                undefined
                                                    ? [
                                                          passengerPosition.longitude,
                                                          passengerPosition.latitude,
                                                      ]
                                                    : [
                                                          driverPosition.longitude,
                                                          driverPosition.latitude,
                                                      ],
                                            driverNextPoint: pointsTravel[0],
                                            eta: eta,
                                            distance: distance,
                                        });
                                    }
                                },
                                () => {
                                    resolve({
                                        routePoints: pointsTravel,
                                        destinationData: null,
                                        pickupPoint:
                                            coordsInfos.passenger_origin ===
                                            undefined
                                                ? [
                                                      passengerPosition.longitude,
                                                      passengerPosition.latitude,
                                                  ]
                                                : [
                                                      driverPosition.longitude,
                                                      driverPosition.latitude,
                                                  ],
                                        driverNextPoint: pointsTravel[0],
                                        eta: eta,
                                        distance: distance,
                                    });
                                }
                            );
                        } else {
                            resolve({
                                routePoints: pointsTravel,
                                destinationData:
                                    coordsInfos.passenger_destination ===
                                    undefined
                                        ? 'routeTracking'
                                        : 'requestToDestinationTracking_pending', //Check whether the request is still pending (requestToDest...) or is accepted and is in progress (routeTracking)
                                driverNextPoint: pointsTravel[0],
                                pickupPoint:
                                    coordsInfos.passenger_origin === undefined
                                        ? [
                                              passengerPosition.longitude,
                                              passengerPosition.latitude,
                                          ]
                                        : [
                                              driverPosition.longitude,
                                              driverPosition.latitude,
                                          ],
                                destinationPoint: [
                                    passengerPosition.longitude,
                                    passengerPosition.latitude,
                                ],
                                eta: eta,
                                distance: distance,
                            });
                        }
                    } else {
                        resolve(false);
                    }
                } catch (error) {
                    resolve(false);
                }
            } else {
                resolve(false);
            }
        } else {
            resolve(false);
        }
    });
}

/**
 * @func updateRidersRealtimeLocationData()
 * @param collectionRidesDeliveries_data: list of trips.
 * @params mongoCollection, collectionRidersLocation_log, collectionDrivers_profiles, locationData
 * Update the rider's location informations in monogDB everytime a change occurs in the rider's app
 * related to the positioning.
 * Use promises as much as possible.
 */
function updateRidersRealtimeLocationData(
    collectionRidesDeliveries_data,
    collectionRidersLocation_log,
    collectionDrivers_profiles,
    collectionPassengers_profiles,
    locationData,
    resolve
) {
    resolveDate();
    //Update location log for riders
    new Promise((res) => {
        updateRiderLocationsLog(
            collectionRidersLocation_log,
            collectionDrivers_profiles,
            collectionPassengers_profiles,
            locationData,
            res
        );
    }).then(
        () => {
            resolve(true);
        },
        () => {
            resolve(false);
        }
    );
}

/**
 * @func updateRiderLocationsLog()
 * @params  collectionRidersLocation_log, collectionDrivers_profiles,  locationData, resolve
 * Responsible for updating any rider location change received.
 * Avoid duplicates as much as possible.
 */
function updateRiderLocationsLog(
    collectionRidersLocation_log,
    collectionDrivers_profiles,
    collectionPassengers_profiles,
    locationData,
    resolve
) {
    resolveDate();
    //? Update the hisotry locations
    //New record
    new Promise((resCompute) => {
        let dataBundle = {
            user_fingerprint: locationData.user_fingerprint,
            coordinates: {
                latitude: locationData.latitude,
                longitude: locationData.longitude,
            },
            date_logged: new Date(chaineDateUTC),
        };

        dynamo_insert('historical_positioning_logs', dataBundle)
            .then((result) => {
                resCompute(result);
            })
            .catch((error) => {
                logger.error(error);
                resCompute(false);
            });
    })
        .then(() => {})
        .catch((error) => logger.error(error));
    //?....

    if (/rider/i.test(locationData.user_nature)) {
        //Riders handler
        //! Update the pushnotfication token
        dynamo_insert(
            'passengers_profiles',
            {
                user_fingerprint: locationData.user_fingerprint,
            },
            'set pushnotif_token = :val1',
            {
                ':val1': locationData.pushnotif_token,
            }
        )
            .then((result) => {
                resolve(result);
            })
            .catch((error) => {
                logger.error(error);
                resolve(false);
            });
    } else if (/driver/i.test(locationData.user_nature)) {
        //Drivers handler
        //Update the driver's operstional position
        let filterDriver = {
            driver_fingerprint: locationData.user_fingerprint,
        };
        //! Update the pushnotfication token
        dynamo_update(
            'drivers_profiles',
            filterDriver,
            'set #o.#p = :val1',
            {
                ':val1': locationData.pushnotif_token,
            },
            {
                '#o': 'operational_state',
                '#p': 'push_notification_token',
            }
        )
            .then((result) => {})
            .catch((error) => {
                logger.error(error);
            });

        //First get the current coordinate
        dynamo_find_query({
            table_name: 'drivers_profiles',
            IndexName: 'driver_fingerprint',
            KeyConditionExpression: 'driver_fingerprint = :val1',
            ExpressionAttributeValues: {
                ':val1': locationData.user_fingerprint,
            },
        })
            .then((driverData) => {
                if (driverData !== undefined && driverData.length > 0) {
                    if (
                        driverData !== undefined &&
                        driverData !== null &&
                        driverData[0] !== undefined &&
                        driverData[0] !== null &&
                        driverData[0].operational_state !== undefined &&
                        driverData[0].operational_state !== null &&
                        driverData[0].operational_state.last_location !==
                            null &&
                        driverData[0].operational_state.last_location !==
                            undefined &&
                        driverData[0].operational_state.last_location
                            .coordinates !== undefined
                    ) {
                        //Get the previous location
                        if (
                            driverData[0].operational_state.last_location
                                .prev_coordinates !== undefined
                        ) {
                            //? Here it gets the current coords which are becoming prev.
                            let prevCoordsWhichWasNewHere =
                                driverData[0].operational_state.last_location
                                    .coordinates;
                            //...
                            let dataBundle = {
                                $set: {
                                    'operational_state.last_location.coordinates':
                                        {
                                            latitude: locationData.latitude,
                                            longitude: locationData.longitude,
                                        },
                                    'operational_state.last_location.prev_coordinates':
                                        prevCoordsWhichWasNewHere,
                                    'operational_state.last_location.date_updated':
                                        new Date(chaineDateUTC),
                                    date_updated: new Date(chaineDateUTC),
                                },
                            };

                            dynamo_update(
                                'drivers_profiles',
                                filterDriver,
                                'set #o.#l.#c = :val1, #o.#l.#prv = :val2, #o.#l.#d = :val3, date_updated = :val4',
                                {
                                    ':val1': {
                                        latitude: locationData.latitude,
                                        longitude: locationData.longitude,
                                    },
                                    ':val2': prevCoordsWhichWasNewHere,
                                    ':val3': new Date(
                                        chaineDateUTC
                                    ).toISOString(),
                                    ':val4': new Date(
                                        chaineDateUTC
                                    ).toISOString(),
                                },
                                {
                                    '#o': 'operational_state',
                                    '#l': 'last_location',
                                    '#prv': 'prev_coordinates',
                                    '#d': 'date_updated',
                                }
                            )
                                .then((result) => {
                                    //! Update the city and the country
                                    new Promise((resUpdateRest) => {
                                        completeLastLoccation_infosSubsAndRest(
                                            locationData,
                                            collectionDrivers_profiles,
                                            resUpdateRest
                                        );
                                    }).then(
                                        () => {},
                                        () => {}
                                    );
                                    resolve(result);
                                })
                                .catch((error) => {
                                    logger.error(error);
                                    resolve(false);
                                });
                        } //No previous location -- update current location and prev to the same value
                        else {
                            let dataBundle = {
                                $set: {
                                    'operational_state.last_location': {
                                        coordinates: {
                                            latitude: locationData.latitude,
                                            longitude: locationData.longitude,
                                        },
                                        prev_coordinates: {
                                            latitude: locationData.latitude,
                                            longitude: locationData.longitude,
                                        },
                                        date_updated: new Date(chaineDateUTC),
                                        date_logged: new Date(chaineDateUTC),
                                    },
                                },
                            };

                            dynamo_update(
                                'drivers_profiles',
                                filterDriver,
                                'set #o.#l = :val1',
                                {
                                    ':val1': {
                                        coordinates: {
                                            latitude: locationData.latitude,
                                            longitude: locationData.longitude,
                                        },
                                        prev_coordinates: {
                                            latitude: locationData.latitude,
                                            longitude: locationData.longitude,
                                        },
                                        date_updated: new Date(
                                            chaineDateUTC
                                        ).toISOString(),
                                        date_logged: new Date(
                                            chaineDateUTC
                                        ).toISOString(),
                                    },
                                },
                                {
                                    '#o': 'operational_state',
                                    '#l': 'last_location',
                                }
                            )
                                .then((result) => {
                                    //! Update the city and the country
                                    new Promise((resUpdateRest) => {
                                        completeLastLoccation_infosSubsAndRest(
                                            locationData,
                                            collectionDrivers_profiles,
                                            resUpdateRest
                                        );
                                    }).then(
                                        () => {},
                                        () => {}
                                    );
                                    resolve(result);
                                })
                                .catch((error) => {
                                    logger.error(error);
                                    resolve(false);
                                });
                        }
                    } //No location data yet - update the previous location and current to the same value
                    else {
                        //! Auto initialize fields
                        let dataBundle = {
                            $set: {
                                'operational_state.last_location': {
                                    coordinates: {
                                        latitude: locationData.latitude,
                                        longitude: locationData.longitude,
                                    },
                                    prev_coordinates: {
                                        latitude: locationData.latitude,
                                        longitude: locationData.longitude,
                                    },
                                    date_updated: new Date(chaineDateUTC),
                                    date_logged: new Date(chaineDateUTC),
                                },
                            },
                        };

                        dynamo_update(
                            'drivers_profiles',
                            filterDriver,
                            'set #o.#l = :val1',
                            {
                                ':val1': {
                                    coordinates: {
                                        latitude: locationData.latitude,
                                        longitude: locationData.longitude,
                                    },
                                    prev_coordinates: {
                                        latitude: locationData.latitude,
                                        longitude: locationData.longitude,
                                    },
                                    date_updated: new Date(
                                        chaineDateUTC
                                    ).toISOString(),
                                    date_logged: new Date(
                                        chaineDateUTC
                                    ).toISOString(),
                                },
                            },
                            {
                                '#o': 'operational_state',
                                '#l': 'last_location',
                            }
                        )
                            .then((result) => {
                                //! Update the city and the country
                                new Promise((resUpdateRest) => {
                                    completeLastLoccation_infosSubsAndRest(
                                        locationData,
                                        collectionDrivers_profiles,
                                        resUpdateRest
                                    );
                                }).then(
                                    () => {},
                                    () => {}
                                );
                                resolve(result);
                            })
                            .catch((error) => {
                                logger.error(error);
                                resolve(false);
                            });
                    }
                } //No record - strange
                else {
                    resolve(false);
                }
            })
            .catch((error) => {
                logger.error(error);
                resolve(false);
            });
    }
}

/**
 * @func completeLastLoccation_infosSubsAndRest
 * Responsible for completing the last location data like city, country and suburb if any.
 * ? Makes sense for the drivers only.
 * @param locationData: the bundle containing the user's location and coordinates.
 * @param collectionDrivers_profiles: list of all the drivers.
 * @param resolve
 */
function completeLastLoccation_infosSubsAndRest(
    locationData,
    collectionDrivers_profiles,
    resolve
) {
    //? Prepare the obj
    let objFinal = {
        city: null,
        country: null,
        street: null,
        suburb: null,
        location_name: null,
        geographic_extent: null,
    };
    //1. Get the general location infos
    let url =
        `${
            /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
        }` +
        ':' +
        process.env.MAP_SERVICE_PORT +
        '/getUserLocationInfos';
    //....
    requestAPI.post(
        {
            url,
            form: {
                latitude: locationData.latitude,
                longitude: locationData.longitude,
                user_fingerprint: locationData.user_fingerprint,
            },
        },
        function (error, response, body) {
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    //? Partially complete the final object
                    objFinal.city = body.city;
                    objFinal.country = body.country;
                    objFinal.street =
                        body.street !== undefined ? body.street : false;
                    objFinal.location_name = body.name;
                    objFinal.geographic_extent =
                        body.extent !== undefined ? body.extent : false;
                    //1. Get the suburb
                    let url =
                        `${
                            /production/i.test(process.env.EVIRONMENT)
                                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                                : process.env.LOCAL_URL
                        }` +
                        ':' +
                        process.env.PRICING_SERVICE_PORT +
                        '/getCorrespondingSuburbInfos?location_name=' +
                        objFinal.location_name +
                        '&street_name=' +
                        objFinal.street +
                        '&city=' +
                        objFinal.city +
                        '&country=' +
                        objFinal.country +
                        '&latitude=' +
                        locationData.latitude +
                        '&longitude=' +
                        locationData.longitude +
                        '&user_fingerprint=' +
                        locationData.user_fingerprint;
                    requestAPI(url, function (error, response, body) {
                        if (error === null) {
                            try {
                                body = JSON.parse(body);
                                ////logger.info(body);
                                //? Complete the suburb data
                                objFinal.suburb =
                                    body.suburb !== undefined
                                        ? body.suburb
                                        : false;
                                //Update the user's profile
                                if (
                                    objFinal.city !== null &&
                                    objFinal.country !== null &&
                                    objFinal.city !== 'null' &&
                                    objFinal.country !== 'null' &&
                                    objFinal.city !== undefined &&
                                    objFinal.country !== undefined &&
                                    objFinal.city !== 'undefined' &&
                                    objFinal.country !== 'undefined'
                                ) {
                                    //! Avoid to overwrite good values by nulls
                                    dynamo_update(
                                        'drivers_profiles',
                                        {
                                            driver_fingerprint:
                                                locationData.user_fingerprint,
                                        },
                                        'set #o.#l.#c = :val1, #o.#l.#cou = :val2, #o.#l.#sub = :val3, #o.#l.#str = :val4, #o.#l.#loc = :val5, #o.#l.#geo = :val6',
                                        {
                                            ':val1': objFinal.city,
                                            ':val2': objFinal.country,
                                            ':val3': objFinal.suburb,
                                            ':val4': objFinal.street,
                                            ':val5': objFinal.location_name,
                                            ':val6': objFinal.geographic_extent,
                                        },
                                        {
                                            '#o': 'operational_state',
                                            '#l': 'last_location',
                                            '#c': 'city',
                                            '#cou': 'country',
                                            '#sub': 'suburb',
                                            '#str': 'street',
                                            '#loc': 'location_name',
                                            '#geo': 'geographic_extent',
                                        }
                                    )
                                        .then((result) => {
                                            resolve(result);
                                        })
                                        .catch((error) => {
                                            logger.error(error);
                                            resolve(false);
                                        });
                                } else {
                                    resolve(false);
                                }
                            } catch (error) {
                                resolve(false);
                            }
                        } else {
                            resolve(false);
                        }
                    });
                } catch (error) {
                    resolve(false);
                }
            } else {
                resolve(false);
            }
        }
    );
}

/**
 * @func tripChecker_Dispatcher()
 * inputs:
 * collectionRidesDeliveries_data: rider's front metadata
 * user_fingerprint: fingerprint of the user requesting the information
 * user_nature: rider or driver
 * Responsible for finding out if there is any trip in progress linked to the user fingerprint
 * and dispatch accordingly the information to the correct driver and rider
 * @var isArrivedToDestination
 * @true when the passenger confirms his/her drop off
 * @var isRideCompleted_driverSide
 * @param driverData: the profile of THIS driver requesting for data
 * @param requestType: ONLY FOR DRIVERS - ride, delivery or scheduled
 * @true when the driver confirms that the trip is over from his/her side
 * REQUEST STATUS: pending, inRouteToPickup, inRouteToDropoff, completedDriverConfimed
 */
function tripChecker_Dispatcher(
    driverData,
    user_fingerprint,
    user_nature,
    requestType = 'DELIVERY',
    resolve
) {
    let RIDE_REDIS_KEY = `${user_fingerprint}-rideDeliveryMade-holder-${requestType}`;

    redisGet(RIDE_REDIS_KEY)
        .then((resp) => {
            if (resp !== null) {
                logger.error('CACHED');
                //Has a record
                try {
                    //! DEBUG - Make a rehydrate request
                    new Promise((resCompute) => {
                        execTripChecker_Dispatcher(
                            driverData,
                            user_fingerprint,
                            user_nature,
                            requestType,
                            RIDE_REDIS_KEY,
                            resolve
                        );
                        //...
                        resCompute(true);
                    })
                        .then(
                            () => {},
                            () => {}
                        )
                        .catch((error) => {
                            logger.error(error);
                        });

                    resp = JSON.parse(resp);
                    //....
                    resolve(resp);
                } catch (error) {
                    logger.error(error);
                    //Make a fresh request
                    new Promise((resCompute) => {
                        execTripChecker_Dispatcher(
                            driverData,
                            user_fingerprint,
                            user_nature,
                            requestType,
                            RIDE_REDIS_KEY,
                            resolve
                        );
                        //...
                        resCompute(true);
                    })
                        .then(() => {})
                        .catch((error) => {
                            logger.error(error);
                        });
                }
            } //No record
            else {
                // logger.error("FRESH");
                //Make a fresh request
                new Promise((resCompute) => {
                    execTripChecker_Dispatcher(
                        driverData,
                        user_fingerprint,
                        user_nature,
                        requestType,
                        RIDE_REDIS_KEY,
                        resolve
                    );
                    //...
                    resCompute(true);
                })
                    .then(() => {})
                    .catch((error) => {
                        logger.error(error);
                    });
            }
        })
        .catch((error) => {
            logger.warn(error);
            //Make a fresh request
            new Promise((resCompute) => {
                execTripChecker_Dispatcher(
                    driverData,
                    user_fingerprint,
                    user_nature,
                    requestType,
                    RIDE_REDIS_KEY,
                    resolve
                );
                //...
                resCompute(true);
            })
                .then(() => {})
                .catch((error) => {
                    logger.error(error);
                });
        });
}

/**
 * @func execTripChecker_Dispatcher
 * Responsible for execute the above @func tripChecker_Dispatcher
 * @var isArrivedToDestination
 * @true when the passenger confirms his/her drop off
 * @var isRideCompleted_driverSide
 * @param driverData: the profile of THIS driver requesting for data
 * @param requestType: ONLY FOR DRIVERS - ride, delivery or scheduled
 * @true when the driver confirms that the trip is over from his/her side
 * @param resolve: Highest level parent promise resolver.
 * REQUEST STATUS: pending, inRouteToPickup, inRouteToDropoff, completedDriverConfimed
 */
function execTripChecker_Dispatcher(
    driverData,
    user_fingerprint,
    user_nature,
    requestType = 'DELIVERY',
    RIDE_REDIS_KEY,
    resolve
) {
    //...
    //Check if the driver has an accepted and not completed request already
    dynamo_find_query({
        table_name: 'requests_central',
        IndexName: 'ride_mode',
        KeyConditionExpression: 'ride_mode = :val1',
        FilterExpression:
            '#r.#isAcc = :val2 AND #r.#icoDrop = :val3 AND NOT contains(intentional_request_decline, :val5)',
        ExpressionAttributeValues: {
            ':val1': driverData.operation_clearances,
            ':val2': true,
            ':val3': false,
            // ":val4": false,
            ':val5': user_fingerprint,
        },
        ExpressionAttributeNames: {
            '#r': 'request_state_vars',
            '#isAcc': 'isAccepted',
            '#icoDrop': 'completedDropoff',
        },
    })
        .then((acceptedRidesArray) => {
            logger.info(acceptedRidesArray);
            if (
                acceptedRidesArray !== undefined &&
                acceptedRidesArray.length > 0
            ) {
                logger.warn('Hass some accepted rides');
                logger.warn(requestType);
                //? Check if the app is only requesting for the accepted trips
                if (/accepted/i.test(requestType)) {
                    //Only for the accepted
                    //! Allow drivers to only see the accepted trips
                    new Promise((res) => {
                        execGetDrivers_requests_and_provide(
                            driverData,
                            requestType,
                            'ONLY_ACCEPTED_REQUESTS',
                            acceptedRidesArray,
                            collectionRidesDeliveries_data,
                            collectionPassengers_profiles,
                            res
                        );
                    }).then(
                        (resultFinal) => {
                            //! SAVE THE FINAL FULL RESULT - for 24h ------
                            redisCluster.setex(
                                RIDE_REDIS_KEY,
                                parseInt(process.env.REDIS_EXPIRATION_5MIN) *
                                    288,
                                JSON.stringify(resultFinal)
                            );
                            //! ----------------------------------------------
                            resolve(resultFinal);
                        },
                        (error) => {
                            //logger.info(error);
                            resolve(false);
                        }
                    );
                } //For the basic ones
                else {
                    //Has accepted some rides already
                    new Promise((res) => {
                        execGetDrivers_requests_and_provide(
                            driverData,
                            requestType,
                            'ACCEPTED_AND_ADDITIONAL_REQUESTS',
                            acceptedRidesArray,
                            res
                        );
                    }).then(
                        (resultFinal) => {
                            //! SAVE THE FINAL FULL RESULT - for 24h ------
                            redisCluster.setex(
                                RIDE_REDIS_KEY,
                                parseInt(process.env.REDIS_EXPIRATION_5MIN) *
                                    288,
                                JSON.stringify(resultFinal)
                            );
                            //! ----------------------------------------------
                            resolve(resultFinal);
                        },
                        (error) => {
                            logger.error(error);
                            resolve(false);
                        }
                    );
                }
            } //NO rides already accepted yet - send full list of allowed to see rides
            else {
                //logger.info("FULL_ALLLOWEDTOSEE_REQUESTS");
                new Promise((res) => {
                    execGetDrivers_requests_and_provide(
                        driverData,
                        requestType,
                        'FULL_ALLLOWEDTOSEE_REQUESTS',
                        false,
                        res
                    );
                }).then(
                    (resultFinal) => {
                        //! SAVE THE FINAL FULL RESULT - for 24h ------
                        redisCluster.setex(
                            RIDE_REDIS_KEY,
                            parseInt(process.env.REDIS_EXPIRATION_5MIN) * 288,
                            JSON.stringify(resultFinal)
                        );
                        //! ----------------------------------------------
                        resolve(resultFinal);
                    },
                    (error) => {
                        logger.error(error);
                        resolve(false);
                    }
                );
            }
        })
        .catch((error) => {
            logger.error(error);
            resolve(false);
        });
}

/**
 * @func sharedTripChecker_Dispatcher
 * inputs:
 * collectionRidesDeliveries_data: rider's front metadata
 * user_fingerprint: fingerprint of the user requesting the information
 * user_nature: rider or driver
 * Responsible for finding out if there is any shared trip in progress linked to the user fingerprint
 * and dispatch accordingly the information to only rider to which the link was shared to.
 * @var isArrivedToDestination
 * @true when the passenger confirms his/her drop off
 * @var isRideCompleted_driverSide
 * @param collectionDrivers_profiles: list of all the drivers
 * @param collectionPassengers_profiles: the list of all the passengers profiles.
 * @param requestType: ONLY FOR DRIVERS - ride, delivery or scheduled
 * @true when the driver confirms that the trip is over from his/her side
 * REQUEST STATUS: pending, inRouteToPickup, inRouteToDropoff, completedDriverConfimed
 */
function sharedTripChecker_Dispatcher(
    collectionRidesDeliveries_data,
    collectionDrivers_profiles,
    collectionPassengers_profiles,
    user_fingerprint,
    user_nature,
    requestType = 'ride',
    resolve
) {
    //logger.info("share the trip action");
}

/**
 * @func execGetDrivers_requests_and_provide
 * Responsible for getting all driver's requests based on the following 3 scenarios:
 * ? 1. PENDING_CONNECTME: when the driver has an uncompleted connectMe request in progress.
 * ? 2. ACCEPTED_AND_ADDITIONAL_REQUESTS: when the driver has already accepted some requests, and add on top of that some new allowed to see requests.
 * ? 3. FULL_ALLLOWEDTOSEE_REQUESTS: when the driver haven't accepted any requests yet, return a full list of maximum allowed to see requests based on the car capacity.
 * Limit the number of requests to the maximum capacity of the car + 3
 * Return requests based on the type of car supported.
 * Return requests based on the destination type : private location, taxi rank or airport.
 * @param driverData: the driver's complete information.
 * @param requestType: the type of request to get - ride, delivery or scheduled - default: rides
 * @param scenarioString: one of the 3 enumerated scenarios.
 * @param alreadyFetchedData: the requests already fetched from the @func tripChecker_Dispatcher function to avoid repetition.
 * @param collectionRidesDeliveries_data: the list of all the requests made
 * @param collectionPassengers_profiles: the list of all the passengers profiles.
 * @param resolve
 */
function execGetDrivers_requests_and_provide(
    driverData,
    requestType,
    scenarioString,
    alreadyFetchedData,
    resolve
) {
    if (/PENDING_CONNECTME/i.test(scenarioString)) {
        //Scenario 1
        //Just send the alreadyFetchedData for the connectMe
        //PARSE THE FINAL REQUESTS
        new Promise((res) => {
            parseRequests_forDrivers_view(
                alreadyFetchedData,
                collectionPassengers_profiles,
                driverData,
                res
            );
        }).then(
            (resultFinal) => {
                resolve(resultFinal);
            },
            (error) => {
                //logger.info(error);
                resolve(false);
            }
        );
    } else if (/ACCEPTED_AND_ADDITIONAL_REQUESTS/i.test(scenarioString)) {
        logger.info('ACCEPTED_AND_ADDITIONAL_REQUESTS');
        //Scenario 2
        //! If the current city is the same as the city in which he has clearance, all good.
        dynamo_find_query({
            table_name: 'requests_central',
            IndexName: 'shopper_id',
            KeyConditionExpression: 'shopper_id = :val1',
            FilterExpression:
                '#r.#isAcc = :val2 AND #r.#icoDrop = :val3 AND NOT contains(intentional_request_decline, :val5) AND #locs.#pick.#ct = :val7 AND ride_mode = :val8',
            ExpressionAttributeValues: {
                ':val1': 'false',
                ':val2': false,
                ':val3': false,
                // ":val4": false,
                ':val5': driverData.driver_fingerprint,
                ':val7': driverData.regional_clearances.includes(
                    driverData.operational_state.last_location.city
                )
                    ? driverData.operational_state.last_location.city
                    : 'UNAUTHORIZED_CITY_DETECTED',
                ':val8': driverData.operation_clearances,
            },
            ExpressionAttributeNames: {
                '#r': 'request_state_vars',
                '#isAcc': 'isAccepted',
                '#icoDrop': 'completedDropoff',
                '#locs': 'locations',
                '#pick': 'pickup',
                '#ct': 'city',
            },
        })
            .then((requestsData) => {
                if (requestsData !== undefined && requestsData.length > 0) {
                    //Found some data
                    //1. Filter the requests based on the clearances of the driver - ride/delivery
                    let clearancesString = driverData.operation_clearances;
                    let max_passengers_capacity =
                        driverData.operational_state.default_selected_car
                            .max_passengers !== undefined &&
                        driverData.operational_state.default_selected_car
                            .max_passengers !== null
                            ? driverData.operational_state.default_selected_car
                                  .max_passengers
                            : 4;
                    //...
                    let refinedRequests = requestsData.filter((request) => {
                        let tmpReg = new RegExp(request.ride_mode, 'i');
                        return tmpReg.test(clearancesString);
                    });
                    //2. ADD THE ALREADY ACCEPTED REQUESTS IN FRONT
                    refinedRequests = [
                        ...refinedRequests,
                        ...alreadyFetchedData,
                    ];
                    //Slice based on the max capacity
                    //refinedRequests = refinedRequests.slice(0, max_passengers_capacity);
                    //...
                    //PARSE THE FINAL REQUESTS
                    new Promise((res) => {
                        parseRequests_forDrivers_view(
                            refinedRequests,
                            driverData,
                            res
                        );
                    }).then(
                        (resultFinal) => {
                            // logger.info(resultFinal);
                            resolve(resultFinal);
                        },
                        (error) => {
                            //logger.info(error);
                            resolve(false);
                        }
                    );
                } //No requests - send the already accepted requests.
                else {
                    //PARSE THE FINAL REQUESTS
                    new Promise((res) => {
                        parseRequests_forDrivers_view(
                            alreadyFetchedData,
                            driverData,
                            res
                        );
                    }).then(
                        (resultFinal) => {
                            resolve(resultFinal);
                        },
                        (error) => {
                            logger.info(error);
                            resolve(false);
                        }
                    );
                }
            })
            .catch((error) => {
                logger.error(error);
                resolve(false);
            });
    } else if (/FULL_ALLLOWEDTOSEE_REQUESTS/i.test(scenarioString)) {
        logger.warn('FULL_ALLLOWEDTOSEE_REQUESTS');
        //Scenario 3
        //default_selected_car.[max_passengers, vehicle_type]
        dynamo_find_query({
            table_name: 'requests_central',
            IndexName: 'shopper_id',
            KeyConditionExpression: 'shopper_id = :val1',
            FilterExpression:
                '#r.#isAcc = :val2 AND #r.#icoDrop = :val3 AND NOT contains(intentional_request_decline, :val5) AND #locs.#pick.#ct = :val7 AND ride_mode = :val8',
            ExpressionAttributeValues: {
                ':val1': 'false',
                ':val2': false,
                ':val3': false,
                // ":val4": false,
                ':val5': driverData.driver_fingerprint,
                ':val7': driverData.regional_clearances.includes(
                    driverData.operational_state.last_location.city
                )
                    ? driverData.operational_state.last_location.city
                    : 'UNAUTHORIZED_CITY_DETECTED',
                ':val8': driverData.operation_clearances,
            },
            ExpressionAttributeNames: {
                '#r': 'request_state_vars',
                '#isAcc': 'isAccepted',
                '#icoDrop': 'completedDropoff',
                '#locs': 'locations',
                '#pick': 'pickup',
                '#ct': 'city',
            },
        })
            .then((requestsData) => {
                // logger.info(requestsData);
                if (requestsData !== undefined && requestsData.length > 0) {
                    //Found some data
                    //! 1. Filter the requests based on the clearances of the driver - ride/delivery
                    let clearancesString = driverData.operation_clearances;
                    // let max_passengers_capacity =
                    //   driverData.operational_state.default_selected_car.max_passengers !==
                    //     undefined &&
                    //   driverData.operational_state.default_selected_car.max_passengers !==
                    //     null
                    //     ? driverData.operational_state.default_selected_car.max_passengers
                    //     : 4;
                    //...
                    let refinedRequests = requestsData.filter((request) => {
                        let tmpReg = new RegExp(request.ride_mode, 'i');
                        return tmpReg.test(clearancesString);
                    });
                    //Slice based on the max capacity
                    //refinedRequests = refinedRequests.slice(0, max_passengers_capacity);
                    //PARSE THE FINAL REQUESTS
                    new Promise((res) => {
                        parseRequests_forDrivers_view(
                            refinedRequests,
                            driverData,
                            res
                        );
                    }).then(
                        (resultFinal) => {
                            // logger.info(resultFinal);
                            resolve(resultFinal);
                        },
                        (error) => {
                            //logger.info(error);
                            resolve(false);
                        }
                    );
                } //No requests
                else {
                    resolve({ response: 'no_requests' });
                }
            })
            .catch((err) => {
                logger.error(err);
                resolve(false);
            });
    } else if (/ONLY_ACCEPTED_REQUESTS/i.test(scenarioString)) {
        //FOr only the accepted requests
        //2. ADD THE ALREADY ACCEPTED REQUESTS IN FRONT
        refinedRequests = alreadyFetchedData;
        //Slice based on the max capacity
        //refinedRequests = refinedRequests.slice(0, max_passengers_capacity);
        //...
        //PARSE THE FINAL REQUESTS
        new Promise((res) => {
            parseRequests_forDrivers_view(refinedRequests, driverData, res);
        }).then(
            (resultFinal) => {
                resolve(resultFinal);
            },
            (error) => {
                //logger.info(error);
                resolve(false);
            }
        );
    }
    //Unknown scenario
    else {
        resolve(false);
    }
}

/**
 * @func arrayEquals
 * ! Responsible for comparing 2 arrays.
 */
function arrayEquals(a, b) {
    return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((val, index) => val === b[index])
    );
}

/**
 * @func parseRequests_forDrivers_view
 * Responsible for parsing the raw requests data into an app friendly format, limiting the data
 * to ONLY the needed ones.
 * @param requestsArray: the array containing all the found requests.
 * @param driverData: the full drivers profile data
 * @param resolve
 * CACHE EVERY SINGLE PROCCESSED REQUESTS: redisKey: request_fp+cached_tempo-parsed-request
 */
function parseRequests_forDrivers_view(requestsArray, driverData, resolve) {
    let batchRequestProcessing = requestsArray.map((request) => {
        return new Promise((res) => {
            //Build the redis key unique template
            let driverCity =
                driverData.operational_state.last_location !== null &&
                driverData.operational_state.last_location !== undefined &&
                driverData.operational_state.last_location.city !== undefined &&
                driverData.operational_state.last_location.city != null
                    ? driverData.operational_state.last_location.city
                    : false;

            let redisKey = `${request.request_fp}-cached_tempo-parsed-request-${driverCity}`;
            //CHECK for any previous parsing
            new Promise((resFresh) => {
                execDriver_requests_parsing(
                    request,
                    driverData,
                    redisKey,
                    resFresh
                );
            }).then(
                (resultParsed) => {
                    // console.log(resultParsed);
                    res(resultParsed);
                },
                (error) => {
                    logger.error(error);
                    res(false);
                }
            );
        });
    });
    //...
    Promise.all(batchRequestProcessing)
        .then(
            (batchRequestsResults) => {
                //Remove any false values
                batchRequestsResults = batchRequestsResults.filter(
                    (request) => request !== false
                );
                //! Remove irrelevant requests based on the locations
                let parentPromisesFilter = batchRequestsResults.map((trip) => {
                    // logger.info(trip);
                    return new Promise((resFilter) => {
                        //Default - no intercity preference - take it as false - filter based on the drivers location
                        let driverCity =
                            driverData.operational_state.last_location !==
                                null &&
                            driverData.operational_state.last_location !==
                                undefined &&
                            driverData.operational_state.last_location.city !==
                                undefined &&
                            driverData.operational_state.last_location.city !=
                                null
                                ? driverData.operational_state.last_location
                                      .city
                                : 'Windhoek';
                        //...
                        // logger.error(
                        //   trip.origin_destination_infos.pickup_infos.city
                        //     .trim()
                        //     .toUpperCase(),
                        //   driverCity.trim().toUpperCase()
                        // );
                        resFilter(
                            trip.origin_destination_infos.pickup_infos.city
                                .trim()
                                .toUpperCase() ===
                                driverCity.trim().toUpperCase()
                                ? trip
                                : false
                        );
                    });
                });
                //DONE WITH BATCH REQUESTS
                Promise.all(parentPromisesFilter)
                    .then((batchRequestsResultsFiltered) => {
                        //Remove any false values
                        batchRequestsResultsFiltered =
                            batchRequestsResultsFiltered.filter(
                                (request) => request !== false
                            );
                        //? DONE

                        resolve(batchRequestsResultsFiltered);
                    })
                    .catch((error) => {
                        logger.error(error);
                        resolve(false);
                    });
            },
            (error) => {
                logger.error(error);
                resolve(false);
            }
        )
        .catch((error) => {
            logger.error(error);
            resolve(false);
        });
}

/**
 * @func execDriver_requests_parsing
 * Responsible for executing the parsing for the individual requests fetched by the drivers
 * @param request: raw single request straight from Mongo
 * @param driverData: the full drivers profile data
 * @param redisKey: the redis key to cache the result after computing
 * @param resolve
 */
function execDriver_requests_parsing(request, driverData, redisKey, resolve) {
    let res = resolve;
    let parsedRequestsArray = {
        request_fp: null,
        request_type: null, //! RIDE, DELIVERY OR SHOPPING
        isIntercity_trip: null,
        passenger_infos: {
            name: null,
            phone_number: null,
        },
        eta_to_passenger_infos: {
            eta: null,
            distance: null,
        },
        delivery_basic_infos: {
            payment_method: null,
            wished_pickup_time: null, //Very important for scheduled requests
            date_state_wishedPickup_time: null, //To indicate "Today" or "Tomorrow" for the pickup time.
            totals_delivery: null, //Holds all the fees details.
            ride_style: null,
            isAccepted: null,
            inRouteToDropoff: null,
            completedDropoff: null,
            ride_mode: null, //ride or delivery
            request_type: null, //immediate or scheduled
            pickup_note: null, //If not set - null
            rider_infos: null,
        },
        origin_destination_infos: {
            pickup_infos: {
                location_name: null,
                street_name: null,
                suburb: null,
                city: null,
                country: null,
                region: null,
                coordinates: null,
            },
            eta_to_destination_infos: {
                eta: null,
                distance: null,
            },
            destination_infos: null, //Array of n destination(s) - location_name, street_name, suburb, passenger_id
        },
        security: null, //Will hold the security PIN
    };
    //...
    //Start the individual parsing
    //...
    let dynamicRequesterFetcher = {
        table_name: 'users_central',
        IndexName: 'user_identifier',
        KeyConditionExpression: 'user_identifier = :val1',
        ExpressionAttributeValues: {
            ':val1': request.client_id,
        },
    };

    //1. Add the passenger infos
    dynamo_find_query(dynamicRequesterFetcher)
        .then((passengerData) => {
            if (passengerData !== undefined && passengerData.length > 0) {
                //Found some data
                //...
                passengerData = passengerData[0];
                //...
                parsedRequestsArray.passenger_infos.name = request
                    .request_state_vars.isAccepted
                    ? passengerData.name
                    : null;
                parsedRequestsArray.passenger_infos.phone_number = request
                    .request_state_vars.isAccepted
                    ? passengerData.phone_number
                    : null;
                //2. Add the basic trip infos
                parsedRequestsArray.delivery_basic_infos.payment_method =
                    request.payment_method;
                parsedRequestsArray.delivery_basic_infos.wished_pickup_time =
                    request.date_requested;
                //? Check if Today or Tomorrow Only for scheduled requests
                if (/scheduled/i.test(request.request_type)) {
                    //Scheduled request
                    parsedRequestsArray.delivery_basic_infos.date_state_wishedPickup_time =
                        new Date(request.wished_pickup_time).getDate() ===
                        new Date(chaineDateUTC).getDate()
                            ? 'Today'
                            : new Date(request.wished_pickup_time).getDate() >
                              new Date(chaineDateUTC).getDate()
                            ? 'Tomorrow'
                            : 'Yesterday';
                } //Immediate request
                else {
                    parsedRequestsArray.delivery_basic_infos.date_state_wishedPickup_time =
                        null;
                }
                //! Attach intercity state
                parsedRequestsArray.isIntercity_trip =
                    request.isIntercity_trip !== undefined &&
                    request.isIntercity_trip !== null
                        ? request.isIntercity_trip
                        : false;
                //?---
                parsedRequestsArray.delivery_basic_infos.totals_delivery =
                    request.totals_request;

                parsedRequestsArray.delivery_basic_infos.request_type =
                    request.request_type;
                parsedRequestsArray.delivery_basic_infos.ride_mode =
                    request.ride_mode;
                parsedRequestsArray.delivery_basic_infos.ride_style = 'shared';
                parsedRequestsArray.delivery_basic_infos.isAccepted =
                    request.request_state_vars.isAccepted;
                parsedRequestsArray.delivery_basic_infos.inRouteToDropoff =
                    request.request_state_vars.inRouteToDropoff;
                parsedRequestsArray.delivery_basic_infos.completedDropoff =
                    request.request_state_vars.completedDropoff;
                //...
                parsedRequestsArray.delivery_basic_infos.pickup_note =
                    /false/i.test(request.request_documentation.note) ||
                    request.request_documentation.note === 'false' ||
                    request.request_documentation.note === false ||
                    request.request_documentation.length === 0
                        ? null
                        : request.request_documentation.note;

                //! Attach the security
                parsedRequestsArray.security = request.security;
                //...
                //3. Compute the ETA to passenger
                new Promise((res0) => {
                    getRouteInfosDestination(
                        {
                            destination: {
                                latitude: parseFloat(
                                    driverData.operational_state.last_location
                                        .coordinates.latitude
                                ),
                                longitude: parseFloat(
                                    driverData.operational_state.last_location
                                        .coordinates.longitude
                                ),
                            },
                            passenger: {
                                latitude: parseFloat(
                                    request.locations.pickup.coordinates
                                        .latitude
                                ),
                                longitude: parseFloat(
                                    request.locations.pickup.coordinates
                                        .longitude
                                ),
                            },
                        },
                        res0,
                        true,
                        request.request_fp + '-cached-etaToPassenger-requests'
                    );
                })
                    .then(
                        (resultEtaToPassenger) => {
                            //Save the eta and distancee
                            parsedRequestsArray.eta_to_passenger_infos.eta =
                                resultEtaToPassenger !== false
                                    ? resultEtaToPassenger.eta
                                    : 'Awaiting';
                            parsedRequestsArray.eta_to_passenger_infos.distance =
                                resultEtaToPassenger !== false
                                    ? resultEtaToPassenger.distance
                                    : 'Awaiting';
                            //4. Add the destination informations
                            parsedRequestsArray.origin_destination_infos.pickup_infos.location_name =
                                request.locations.pickup.location_name !==
                                    undefined &&
                                request.locations.pickup.location_name !== false
                                    ? request.locations.pickup.location_name
                                    : request.locations.pickup.street_name;
                            parsedRequestsArray.origin_destination_infos.pickup_infos.street_name =
                                request.locations.pickup.street_name;
                            parsedRequestsArray.origin_destination_infos.pickup_infos.suburb =
                                request.locations.pickup.suburb;
                            parsedRequestsArray.origin_destination_infos.pickup_infos.coordinates =
                                request.locations.pickup.coordinates;
                            //?Attach region, city and country for the pickup
                            parsedRequestsArray.origin_destination_infos.pickup_infos.city =
                                request.locations.pickup.city;
                            parsedRequestsArray.origin_destination_infos.pickup_infos.country =
                                request.locations.pickup.country;
                            parsedRequestsArray.origin_destination_infos.pickup_infos.region =
                                request.locations.pickup.state
                                    .replace(/ Region/i, '')
                                    .trim()
                                    .toUpperCase();

                            //ADD THE REQUEST TYPE
                            parsedRequestsArray.request_type =
                                /(now|immediate)/i.test(request.request_type)
                                    ? request.ride_mode
                                    : 'scheduled';

                            //Compute the ETA to destination details
                            new Promise((res1) => {
                                getRouteInfosDestination(
                                    {
                                        destination: {
                                            latitude: parseFloat(
                                                request.locations.dropoff[0]
                                                    .dropoff_location
                                                    .coordinates[1]
                                            ),
                                            longitude: parseFloat(
                                                request.locations.dropoff[0]
                                                    .dropoff_location
                                                    .coordinates[0]
                                            ),
                                        },
                                        passenger: {
                                            latitude: parseFloat(
                                                request.locations.pickup
                                                    .coordinates.latitude
                                            ),
                                            longitude: parseFloat(
                                                request.locations.pickup
                                                    .coordinates.longitude
                                            ),
                                        },
                                    },
                                    res1,
                                    true,
                                    request.request_fp +
                                        '-cached-etaToDestination-requests'
                                );
                            })
                                .then(
                                    (resultETAToDestination) => {
                                        if (resultETAToDestination !== false) {
                                            //Save the ETA to destination data
                                            parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.eta =
                                                resultETAToDestination.eta;
                                            parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.distance =
                                                resultETAToDestination.distance;
                                            //4. Save the destination data
                                            parsedRequestsArray.origin_destination_infos.destination_infos =
                                                request.locations.dropoff;
                                            //Add the request fingerprint
                                            parsedRequestsArray.request_fp =
                                                request.request_fp;
                                            //DONE
                                            //CACHE
                                            new Promise((resCache) => {
                                                redisCluster.setex(
                                                    redisKey,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(
                                                        parsedRequestsArray
                                                    )
                                                );
                                                resCache(true);
                                            }).then(
                                                () => {
                                                    //logger.info("Single processing cached!");
                                                },
                                                () => {}
                                            );
                                            //Return the answer
                                            res(parsedRequestsArray);
                                        } //! Error - Salvage anyway
                                        else {
                                            //Save the ETA to destination data
                                            parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.eta =
                                                'Awaiting';
                                            parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.distance =
                                                'Awaiting';
                                            //4. Save the destination data
                                            parsedRequestsArray.origin_destination_infos.destination_infos =
                                                request.locations.dropoff;
                                            //Add the request fingerprint
                                            parsedRequestsArray.request_fp =
                                                request.request_fp;
                                            //DONE
                                            //CACHE
                                            new Promise((resCache) => {
                                                redisCluster.setex(
                                                    redisKey,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(
                                                        parsedRequestsArray
                                                    )
                                                );
                                                resCache(true);
                                            }).then(
                                                () => {
                                                    //logger.info("Single processing cached!");
                                                },
                                                () => {}
                                            );
                                            //Return the answer
                                            res(parsedRequestsArray);
                                        }
                                    },
                                    (error) => {
                                        logger.error(error);
                                        //! Salvage anyway
                                        //Save the ETA to destination data
                                        parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.eta =
                                            'Awaiting';
                                        parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.distance =
                                            'Awaiting';
                                        //4. Save the destination data
                                        parsedRequestsArray.origin_destination_infos.destination_infos =
                                            request.locations.dropoff;
                                        //Add the request fingerprint
                                        parsedRequestsArray.request_fp =
                                            request.request_fp;
                                        //DONE
                                        //CACHE
                                        new Promise((resCache) => {
                                            redisCluster.setex(
                                                redisKey,
                                                process.env
                                                    .REDIS_EXPIRATION_5MIN,
                                                JSON.stringify(
                                                    parsedRequestsArray
                                                )
                                            );
                                            resCache(true);
                                        }).then(
                                            () => {
                                                //logger.info("Single processing cached!");
                                            },
                                            () => {}
                                        );
                                        //Return the answer
                                        res(parsedRequestsArray);
                                    }
                                )
                                .catch((error) => {
                                    logger.error(error);
                                    //! Salvage anyway
                                    //Save the ETA to destination data
                                    parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.eta =
                                        'Awaiting';
                                    parsedRequestsArray.origin_destination_infos.eta_to_destination_infos.distance =
                                        'Awaiting';
                                    //4. Save the destination data
                                    parsedRequestsArray.origin_destination_infos.destination_infos =
                                        request.locations.dropoff;
                                    //Add the request fingerprint
                                    parsedRequestsArray.request_fp =
                                        request.request_fp;
                                    //DONE
                                    //CACHE
                                    new Promise((resCache) => {
                                        redisCluster.setex(
                                            redisKey,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(parsedRequestsArray)
                                        );
                                        resCache(true);
                                    }).then(
                                        () => {
                                            //logger.info("Single processing cached!");
                                        },
                                        () => {}
                                    );
                                    //Return the answer
                                    res(parsedRequestsArray);
                                });
                        },
                        (error) => {
                            logger.error(error);
                            res(false);
                        }
                    )
                    .catch((error) => {
                        logger.error(error);
                        resolve(false);
                    });
            } //No data found - strange
            else {
                resolve(false);
            }
        })
        .catch((error) => {
            logger.error(error);
            res(false);
        });
}

/**
 * @func getMongoRecordTrip_cacheLater()
 * @param collectionDrivers_profiles: list of all the drivers
 * Responsible for getting user record from mongodb, compute route infos, cache it (and cache the user's trip infos for later use).
 * CAN BE USED FOR RIDERS AND DRIVERS
 * @param RIDE_REDIS_KEY: the redis key to keep the result
 */
function getMongoRecordTrip_cacheLater(
    collectionRidesDeliveries_data,
    collectionDrivers_profiles,
    user_fingerprint,
    user_nature,
    request_fp,
    RIDE_REDIS_KEY,
    resolve
) {
    //Check if there are any requests in MongoDB
    let queryFilter = {
        client_id: user_fingerprint,
        request_fp: request_fp,
    }; //? Indexed

    dynamo_find_query({
        table_name: 'rides_deliveries_requests',
        IndexName: 'request_fp',
        KeyConditionExpression: 'request_fp = :val1, client_id = :val2',
        ExpressionAttributeValues: {
            ':val1': queryFilter.request_fp,
            ':val2': queryFilter.client_id,
        },
    })
        .then((result) => {
            //Compute route via compute skeleton
            computeRouteDetails_skeleton(
                result,
                collectionDrivers_profiles,
                RIDE_REDIS_KEY,
                resolve
            );
        })
        .catch((error) => {
            logger.error(error);
            resolve(false);
        });
}
/**
 * @func computeRouteDetails_skeleton
 * Compute route details template.
 * @param collectionDrivers_profiles: list of all the drivers
 * MUST convert input into a unique indexed array, eg: [result]
 * CAN BE USED FOR RIDERS AND DRIVERS
 * @param RIDE_REDIS_KEY: the redis key to save the result.
 */
function computeRouteDetails_skeleton(
    result,
    collectionDrivers_profiles,
    RIDE_REDIS_KEY,
    resolve
) {
    if (result.length > 0 && result[0].request_fp !== undefined) {
        //There is a ride
        let rideHistory = result[0];
        let riderCoords = rideHistory.pickup_location_infos.coordinates;
        if (rideHistory.ride_state_vars.isAccepted) {
            //Get all the driver's informations
            //? Indexed
            provideDataForCollection(
                collectionDrivers_profiles,
                'collectionDrivers_profiles',
                { driver_fingerprint: rideHistory.taxi_id }
            )
                .then((driverProfile) => {
                    if (driverProfile.length > 0) {
                        //Found the driver's profile
                        driverProfile = driverProfile[0];
                        //...EXPLORE RIDE SCENARIOS
                        //3 Scenarios:
                        //- In route to pickup
                        //- In route to drop off
                        //- Trip over, confirm drop off rider
                        if (
                            rideHistory.ride_state_vars.inRideToDestination ===
                                false &&
                            rideHistory.ride_state_vars
                                .isRideCompleted_driverSide === false
                        ) {
                            //logger.info("IN ROUTE TO PICKUP -- HERE");
                            //In route to pickup
                            let requestStatusMain = 'inRouteToPickup';
                            //Get driver's coordinates
                            //Get driver coords from cache, it non existant, get from mongo
                            redisGet(rideHistory.taxi_id).then(
                                (resp) => {
                                    if (resp !== null) {
                                        //Check for any trip record related to the route infos in the cache
                                        //KEY: request_fp
                                        redisGet(rideHistory.request_fp).then(
                                            (resp0) => {
                                                if (
                                                    resp0 !== null &&
                                                    resp0.justLeaveMe !==
                                                        undefined
                                                ) {
                                                    try {
                                                        //Compute next route update ---------------------------------------------------
                                                        new Promise((reslv) => {
                                                            computeAndCacheRouteDestination(
                                                                resp,
                                                                rideHistory,
                                                                driverProfile,
                                                                riderCoords,
                                                                requestStatusMain,
                                                                RIDE_REDIS_KEY,
                                                                reslv
                                                            );
                                                        }).then(
                                                            () => {},
                                                            () => {}
                                                        );
                                                        //............Return cached
                                                        let tripData =
                                                            JSON.parse(resp0);
                                                        //Found a precomputed record
                                                        ////logger.info("Trip data cached found!");
                                                        //logger.info(tripData);
                                                        //! SAVE THE FINAL FULL RESULT - for 15 min ------
                                                        if (
                                                            rideHistory.request_globality ===
                                                                undefined ||
                                                            rideHistory.request_globality ===
                                                                'normal'
                                                        ) {
                                                            redisCluster.setex(
                                                                RIDE_REDIS_KEY,
                                                                parseInt(
                                                                    process.env
                                                                        .REDIS_EXPIRATION_5MIN
                                                                ) * 3,
                                                                JSON.stringify(
                                                                    tripData
                                                                )
                                                            );
                                                        }
                                                        //! ----------------------------------------------
                                                        resolve(tripData);
                                                    } catch (error) {
                                                        //logger.info(error);
                                                        resolve(false);
                                                    }
                                                } //no record create a new one
                                                else {
                                                    //Compute next route update ---------------------------------------------------
                                                    new Promise((reslv) => {
                                                        computeAndCacheRouteDestination(
                                                            resp,
                                                            rideHistory,
                                                            driverProfile,
                                                            riderCoords,
                                                            requestStatusMain,
                                                            RIDE_REDIS_KEY,
                                                            reslv
                                                        );
                                                    }).then(
                                                        () => {
                                                            //Get route infos from cache.
                                                            redisGet(
                                                                rideHistory.request_fp
                                                            ).then(
                                                                (result) => {
                                                                    //logger.info(result);
                                                                    resolve(
                                                                        result
                                                                    );
                                                                },
                                                                (error) => {
                                                                    ////logger.info(error);
                                                                    resolve(
                                                                        false
                                                                    );
                                                                }
                                                            );
                                                        },
                                                        (error) => {
                                                            resolve(false);
                                                        }
                                                    );
                                                }
                                            },
                                            (err0) => {
                                                //logger.info(err0);
                                                //Compute next route update ---------------------------------------------------
                                                new Promise((reslv) => {
                                                    computeAndCacheRouteDestination(
                                                        resp,
                                                        rideHistory,
                                                        driverProfile,
                                                        riderCoords,
                                                        requestStatusMain,
                                                        RIDE_REDIS_KEY,
                                                        reslv
                                                    );
                                                }).then(
                                                    () => {
                                                        //Get route infos from cache.
                                                        redisGet(
                                                            rideHistory.request_fp
                                                        ).then(
                                                            (result) => {
                                                                resolve(result);
                                                            },
                                                            (error) => {
                                                                ////logger.info(error);
                                                                resolve(false);
                                                            }
                                                        );
                                                    },
                                                    (error) => {
                                                        resolve(false);
                                                    }
                                                );
                                            }
                                        );
                                    } else {
                                        //logger.info("Skip cache");
                                        //GET THE DRIVER'S LOCATION FROM MONGO DB
                                        //! auto cache the driver's location - Major performance update!
                                        redisCluster.setex(
                                            rideHistory.taxi_id,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(
                                                driverProfile.operational_state
                                                    .last_location.coordinates
                                            )
                                        );
                                        //Compute next route update ---------------------------------------------------
                                        new Promise((reslv) => {
                                            computeAndCacheRouteDestination(
                                                JSON.stringify(
                                                    driverProfile
                                                        .operational_state
                                                        .last_location
                                                        .coordinates
                                                ),
                                                rideHistory,
                                                driverProfile,
                                                riderCoords,
                                                requestStatusMain,
                                                RIDE_REDIS_KEY,
                                                reslv
                                            );
                                        }).then(
                                            () => {
                                                //Get route infos from cache.
                                                redisGet(
                                                    rideHistory.request_fp
                                                ).then(
                                                    (result) => {
                                                        resolve(
                                                            JSON.parse(result)
                                                        );
                                                    },
                                                    (error) => {
                                                        ////logger.info(error);
                                                        resolve(false);
                                                    }
                                                );
                                            },
                                            (error) => {
                                                resolve(false);
                                            }
                                        );
                                    }
                                },
                                (error) => {
                                    ////logger.info(error);
                                    resolve(false);
                                }
                            );
                        } else if (
                            rideHistory.ride_state_vars.inRideToDestination ===
                                true &&
                            rideHistory.ride_state_vars
                                .isRideCompleted_driverSide === false
                        ) {
                            //In route to drop off
                            ////logger.info("In route to drop off");
                            let requestStatusMain = 'inRouteToDestination';
                            //Get driver coords from cache, it non existant, get from mongo
                            redisGet(rideHistory.taxi_id).then(
                                (resp) => {
                                    if (resp !== null) {
                                        //Check for any trip record related to the route infos in the cache
                                        //KEY: request_fp
                                        redisGet(rideHistory.request_fp).then(
                                            (resp0) => {
                                                if (resp0 !== null) {
                                                    try {
                                                        //Compute next route update ---------------------------------------------------
                                                        new Promise((reslv) => {
                                                            computeAndCacheRouteDestination(
                                                                resp,
                                                                rideHistory,
                                                                driverProfile,
                                                                riderCoords,
                                                                requestStatusMain,
                                                                RIDE_REDIS_KEY,
                                                                reslv
                                                            );
                                                        }).then(
                                                            () => {
                                                                //logger.info("Updated");
                                                            },
                                                            () => {}
                                                        );
                                                        //............Return cached
                                                        let tripData =
                                                            JSON.parse(resp0);
                                                        //Found a precomputed record
                                                        //logger.info("Trip data cached found!");
                                                        resolve(tripData);
                                                    } catch (error) {
                                                        ////logger.info(error);
                                                        //Compute next route update ---------------------------------------------------
                                                        new Promise((reslv) => {
                                                            computeAndCacheRouteDestination(
                                                                resp,
                                                                rideHistory,
                                                                driverProfile,
                                                                riderCoords,
                                                                requestStatusMain,
                                                                RIDE_REDIS_KEY,
                                                                reslv
                                                            );
                                                        }).then(
                                                            () => {
                                                                //Get route infos from cache.
                                                                redisGet(
                                                                    rideHistory.request_fp
                                                                ).then(
                                                                    (
                                                                        result
                                                                    ) => {
                                                                        resolve(
                                                                            result
                                                                        );
                                                                    },
                                                                    (error) => {
                                                                        logger.error(
                                                                            error
                                                                        );
                                                                        resolve(
                                                                            false
                                                                        );
                                                                    }
                                                                );
                                                            },
                                                            (error) => {
                                                                resolve(false);
                                                            }
                                                        );
                                                    }
                                                } //no record create a new one
                                                else {
                                                    //Compute next route update ---------------------------------------------------
                                                    new Promise((reslv) => {
                                                        computeAndCacheRouteDestination(
                                                            resp,
                                                            rideHistory,
                                                            driverProfile,
                                                            riderCoords,
                                                            requestStatusMain,
                                                            RIDE_REDIS_KEY,
                                                            reslv
                                                        );
                                                    }).then(
                                                        () => {
                                                            //Get route infos from cache.
                                                            redisGet(
                                                                rideHistory.request_fp
                                                            ).then(
                                                                (result) => {
                                                                    resolve(
                                                                        result
                                                                    );
                                                                },
                                                                (error) => {
                                                                    ////logger.info(error);
                                                                    resolve(
                                                                        false
                                                                    );
                                                                }
                                                            );
                                                        },
                                                        (error) => {
                                                            resolve(false);
                                                        }
                                                    );
                                                }
                                            },
                                            (err0) => {
                                                ////logger.info(err0);
                                                //Compute next route update ---------------------------------------------------
                                                new Promise((reslv) => {
                                                    computeAndCacheRouteDestination(
                                                        resp,
                                                        rideHistory,
                                                        driverProfile,
                                                        riderCoords,
                                                        requestStatusMain,
                                                        RIDE_REDIS_KEY,
                                                        reslv
                                                    );
                                                }).then(
                                                    () => {
                                                        //Get route infos from cache.
                                                        redisGet(
                                                            rideHistory.request_fp
                                                        ).then(
                                                            (result) => {
                                                                resolve(result);
                                                            },
                                                            (error) => {
                                                                ////logger.info(error);
                                                                resolve(false);
                                                            }
                                                        );
                                                    },
                                                    (error) => {
                                                        resolve(false);
                                                    }
                                                );
                                            }
                                        );
                                    } else {
                                        //GET THE DRIVER'S LOCATION FROM MONGO DB
                                        //! auto cache the driver's location - Major performance update!
                                        redisCluster.setex(
                                            rideHistory.taxi_id,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(
                                                driverProfile.operational_state
                                                    .last_location.coordinates
                                            )
                                        );
                                        //Compute next route update ---------------------------------------------------
                                        new Promise((reslv) => {
                                            computeAndCacheRouteDestination(
                                                JSON.stringify(
                                                    driverProfile
                                                        .operational_state
                                                        .last_location
                                                        .coordinates
                                                ),
                                                rideHistory,
                                                driverProfile,
                                                riderCoords,
                                                requestStatusMain,
                                                RIDE_REDIS_KEY,
                                                reslv
                                            );
                                        }).then(
                                            () => {
                                                //Get route infos from cache.
                                                redisGet(
                                                    rideHistory.request_fp
                                                ).then(
                                                    (result) => {
                                                        resolve(
                                                            JSON.parse(result)
                                                        );
                                                    },
                                                    (error) => {
                                                        ////logger.info(error);
                                                        resolve(false);
                                                    }
                                                );
                                            },
                                            (error) => {
                                                resolve(false);
                                            }
                                        );
                                    }
                                },
                                (error) => {
                                    ////logger.info(error);
                                    resolve(false);
                                }
                            );
                        } else if (
                            rideHistory.ride_state_vars
                                .isRideCompleted_driverSide === true &&
                            rideHistory.ride_state_vars
                                .isRideCompleted_riderSide === false &&
                            rideHistory.isArrivedToDestination === false
                        ) {
                            //Rider's confirmation for the drop off left
                            //Gather basic ride infos (origin, destination, ride mode - RIDE/DELIVERY, date requested, request_fp) and basic driver infos(name, picture)
                            //riderDropoffConfirmation_left
                            let confirmation_request_schema = {
                                request_status: 'riderDropoffConfirmation_left',
                                trip_details: {
                                    pickup_name: null,
                                    destination_name: null,
                                    ride_mode: null, //Ride or delivery
                                    date_requested: null, //dd/mm/yy, hh/mm/ss
                                    request_fp: null,
                                },
                                driver_details: {
                                    name: null,
                                    profile_picture: null,
                                    phone_number: null,
                                    car_brand: null,
                                    plate_number: null,
                                },
                                birdview_infos: /DELIVERY/i.test(
                                    rideHistory.ride_mode
                                )
                                    ? {
                                          number_of_packages:
                                              rideHistory.passengers_number,
                                          fare: rideHistory.fare,
                                          date_requested:
                                              rideHistory.date_requested,
                                          dropoff_details:
                                              rideHistory.destinationData,
                                          pickup_details:
                                              rideHistory.pickup_location_infos,
                                      }
                                    : null,
                            };
                            //logger.info("Riders confirmation of drop off");

                            //1. Resolve pickup location name
                            confirmation_request_schema.trip_details.pickup_name =
                                rideHistory.pickup_location_infos
                                    .location_name !== false &&
                                rideHistory.pickup_location_infos
                                    .location_name !== 'false' &&
                                rideHistory.pickup_location_infos
                                    .location_name !== undefined
                                    ? rideHistory.pickup_location_infos
                                          .location_name
                                    : rideHistory.pickup_location_infos
                                          .street_name !== false &&
                                      rideHistory.pickup_location_infos
                                          .street_name !== 'false' &&
                                      rideHistory.pickup_location_infos
                                          .street_name !== undefined
                                    ? rideHistory.pickup_location_infos
                                          .street_name
                                    : rideHistory.pickup_location_infos
                                          .suburb !== false &&
                                      rideHistory.pickup_location_infos
                                          .suburb !== 'false' &&
                                      rideHistory.pickup_location_infos
                                          .suburb !== undefined
                                    ? rideHistory.pickup_location_infos.suburb
                                    : 'Your location.';
                            //2. Resolve the destinations
                            rideHistory.destinationData.map((location) => {
                                if (
                                    confirmation_request_schema.trip_details
                                        .destination_name === null
                                ) {
                                    //Still empty
                                    confirmation_request_schema.trip_details.destination_name =
                                        location.location_name !== false &&
                                        location.location_name !== 'false' &&
                                        location.location_name !== undefined
                                            ? location.location_name
                                            : location.suburb !== false &&
                                              location.suburb !== undefined
                                            ? location.suburb
                                            : 'Click for more';
                                } //Add
                                else {
                                    confirmation_request_schema.trip_details.destination_name +=
                                        ', ' +
                                        (location.location_name !== false &&
                                        location.location_name !== 'false' &&
                                        location.location_name !== undefined
                                            ? location.location_name
                                            : location.suburb !== false &&
                                              location.suburb !== undefined
                                            ? location.suburb
                                            : 'Click for more');
                                }
                            });
                            //3. Add ride mode
                            confirmation_request_schema.trip_details.ride_mode =
                                rideHistory.ride_mode.toUpperCase();
                            //4. Add the date requested
                            //Reformat the data
                            let dateRequest = new Date(
                                rideHistory.date_requested
                            );
                            dateRequest = moment(dateRequest.getTime());
                            dateRequest =
                                (String(dateRequest.date()).length > 1
                                    ? dateRequest.date()
                                    : '0' + dateRequest.date()) +
                                '/' +
                                (String(dateRequest.month() + 1).length > 1
                                    ? dateRequest.month() + 1
                                    : '0' + (dateRequest.month() + 1)) +
                                '/' +
                                dateRequest.year() +
                                ', ' +
                                (String(dateRequest.hour()).length > 1
                                    ? dateRequest.hour()
                                    : '0' + dateRequest.hour()) +
                                ':' +
                                (String(dateRequest.minute()).length > 1
                                    ? dateRequest.minute()
                                    : '0' + dateRequest.minute());
                            //Save
                            confirmation_request_schema.trip_details.date_requested =
                                dateRequest;
                            //5. Add the request_fp - Very important
                            confirmation_request_schema.trip_details.request_fp =
                                rideHistory.request_fp;
                            //6. Add the driver's name and profile picture
                            confirmation_request_schema.driver_details.name =
                                driverProfile.name;
                            confirmation_request_schema.driver_details.profile_picture = `${process.env.AWS_S3_DRIVERS_PROFILE_PICTURES_PATH}/${driverProfile.identification_data.profile_picture}`;
                            confirmation_request_schema.driver_details.phone_number =
                                driverProfile.phone_number;
                            confirmation_request_schema.driver_details.car_brand =
                                driverProfile.cars_data[0].car_brand;
                            confirmation_request_schema.driver_details.plate_number =
                                driverProfile.cars_data[0].plate_number;

                            //! Add the requester fingerprint
                            confirmation_request_schema.requester_fp =
                                rideHistory.client_id;
                            //!----
                            //Done
                            //! SAVE THE FINAL FULL RESULT - for 15 min ------
                            if (
                                rideHistory.request_globality === undefined ||
                                rideHistory.request_globality === 'normal'
                            ) {
                                redisCluster.setex(
                                    RIDE_REDIS_KEY,
                                    parseInt(
                                        process.env.REDIS_EXPIRATION_5MIN
                                    ) * 3,
                                    JSON.stringify(confirmation_request_schema)
                                );
                            }
                            //! ----------------------------------------------
                            resolve(confirmation_request_schema);
                        } //No action needed
                        else {
                            //! SAVE THE FINAL FULL RESULT - for 15 min ------
                            redisCluster.setex(
                                RIDE_REDIS_KEY,
                                parseInt(process.env.REDIS_EXPIRATION_5MIN) * 3,
                                JSON.stringify(true)
                            );
                            //! ----------------------------------------------
                            resolve(true);
                        }
                    } //No driver's profile found - error - very strange isn't it
                    else {
                        //! SAVE THE FINAL FULL RESULT - for 15 min ------
                        redisCluster.setex(
                            RIDE_REDIS_KEY,
                            parseInt(process.env.REDIS_EXPIRATION_5MIN) * 3,
                            JSON.stringify(false)
                        );
                        //! ----------------------------------------------
                    }
                })
                .catch((err) => {
                    logger.error(err);
                    resolve(false);
                });
        } //Request pending
        else {
            ////logger.info("request pending...");
            //!!! ONLY SUPPORT ONE DESTINATION TRACKING.
            /*let bundle = {
        driver: undefined,
        passenger_origin: {
          latitude: rideHistory.rider_pickupLocation.point.latitude,
          longitude: rideHistory.rider_pickupLocation.point.longitude,
        },
        passenger_destination: {
          latitude: rideHistory.rider_destination.destination1.point.latitude,
          longitude: rideHistory.rider_destination.destination1.point.longitude,
        },
      };

      new Promise((reslv) => {
        getRouteInfos(bundle, reslv);
      }).then(
        (result) => {
          //Add request status variable - pending
          result["request_status"] = "pending";
          resolve(result);
        },
        (error) => {
          ////logger.info(error);
          resolve(false);
        }
      );*/
            let dataSource = {
                pickupLocation_name:
                    rideHistory.pickup_location_infos.location_name,
                pickupLocation_point: [
                    rideHistory.pickup_location_infos.coordinates.longitude,
                    rideHistory.pickup_location_infos.coordinates.latitude,
                ],
                request_fp: rideHistory.request_fp,
                requester_fp: rideHistory.client_id,
                request_status: 'pending',
                birdview_infos: {
                    number_of_packages: rideHistory.passengers_number,
                    fare: rideHistory.fare,
                    date_requested: rideHistory.date_requested,
                    dropoff_details: rideHistory.destinationData,
                    pickup_details: rideHistory.pickup_location_infos,
                },
            };
            //Cache response
            new Promise((res) => {
                //! SAVE THE FINAL FULL RESULT - for 15 min ------
                redisCluster.setex(
                    RIDE_REDIS_KEY,
                    parseInt(process.env.REDIS_EXPIRATION_5MIN) * 3,
                    JSON.stringify(dataSource)
                );
                //! ----------------------------------------------
                //Get previous record
                redisGet(rideHistory.request_fp).then(
                    (reslt) => {
                        if (reslt !== null) {
                            try {
                                reslt = JSON.parse(reslt);
                                //Update old record
                                reslt.rides_history = dataSource;
                                //..
                                redisCluster.setex(
                                    rideHistory.client_id,
                                    process.env.REDIS_EXPIRATION_5MIN,
                                    JSON.stringify(reslt)
                                );
                                res(true);
                            } catch (error) {
                                //Ignore
                                res(false);
                            }
                        } //Create fresh record
                        else {
                            redisCluster.setex(
                                rideHistory.request_fp,
                                process.env.REDIS_EXPIRATION_5MIN,
                                JSON.stringify({
                                    rides_history: dataSource,
                                })
                            );
                            res(true);
                        }
                    },
                    (error) => {
                        //Ignore
                        res(false);
                    }
                );
            }).then(
                () => {},
                () => {}
            );
            //Add request status variable - pending
            resolve(dataSource);
        }
    } //No ride present
    else {
        //logger.info("No ride in progress");
        //! SAVE THE FINAL FULL RESULT - for 15 min ------
        redisCluster.setex(
            RIDE_REDIS_KEY,
            parseInt(process.env.REDIS_EXPIRATION_5MIN) * 3,
            JSON.stringify(true)
        );
        //! ----------------------------------------------
        resolve(true);
    }
}

/**
 * ACCEPTED RIDES ONLY
 * @func computeAndCacheRouteDestination()
 * @param rideHistory: contains the infos about the passenger's ride history
 * @param driverProfile: the profile information of the driver who accepted the request.
 * @param driverInfos: contains the infos of the associated driver from cache or mongo IN TEXT FROM - Use JSON.parse to make a useful object.
 * @param resolve: resover for the promise.
 * @param request_status: responsible for specifying if the computation is done for in route to pickup, in route to drop off or any other case.
 * Responsible for finding all the trip information for a sepcific ride and cache it for later and efficient use.
 * UPDATE DRIVER AND PASSENGER CACHE RIDE HISTORY.
 * Promisify!
 */
function computeAndCacheRouteDestination(
    driverInfos,
    rideHistory,
    driverProfile = false,
    riderCoords = false,
    request_status,
    RIDE_REDIS_KEY,
    resolve
) {
    //Compute next route update ---------------------------------------------------
    let resp = JSON.parse(driverInfos); //The coordinates
    let bundle = {};

    new Promise((reslv) => {
        let redisKey = `${rideHistory.client_id}-${rideHistory.taxi_id}`;
        if (request_status === 'inRouteToPickup') {
            //For to pickup only
            bundle = {
                driver: {
                    latitude: resp.latitude,
                    longitude: resp.longitude,
                },
                passenger: {
                    latitude: riderCoords.latitude,
                    longitude: riderCoords.longitude,
                },
                redisKey: redisKey,
                //Take the passenger's 1 destination as reference
                //destination: rideHistory.destinationData[0].coordinates,
            };
            //...
            getRouteInfos(bundle, reslv);
        } else if (request_status === 'inRouteToDestination') {
            //logger.info("in route to destination");
            //For to drop off only
            bundle = {
                passenger_origin: {
                    latitude: riderCoords.latitude,
                    longitude: riderCoords.longitude,
                },
                redisKey: redisKey,
                passenger_destination: {
                    latitude:
                        rideHistory.destinationData[0].coordinates.longitude,
                    longitude:
                        rideHistory.destinationData[0].coordinates.latitude,
                },
            };
            //...
            getRouteInfos(bundle, reslv);
        }
    }).then(
        (result) => {
            //Do the preliminary caching
            new Promise((resolvePreli) => {
                //Update driver old trip cached ride history
                redisGet(resp.user_fingerprint).then(
                    (res) => {
                        if (res !== null) {
                            try {
                                let prevDriverCache = JSON.parse(res);
                                prevDriverCache.rides_history = rideHistory;
                                redisCluster.setex(
                                    resp.user_fingerprint,
                                    process.env.REDIS_EXPIRATION_5MIN,
                                    JSON.stringify(prevDriverCache)
                                );
                                //Update rider old trip cached ride history
                                redisGet(rideHistory.client_id).then(
                                    (res1) => {
                                        if (res !== null) {
                                            try {
                                                let prevRiderCache =
                                                    JSON.parse(res1);
                                                prevRiderCache.rides_history =
                                                    rideHistory;
                                                redisCluster.setex(
                                                    rideHistory.client_id,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(
                                                        prevRiderCache
                                                    )
                                                );
                                                resolvePreli(true);
                                            } catch (error) {
                                                resolvePreli(true);
                                            }
                                        } else {
                                            resolvePreli(true);
                                        }
                                    },
                                    () => {
                                        resolvePreli(true);
                                    }
                                );
                            } catch (error) {
                                resolvePreli(true);
                            }
                        } else {
                            resolvePreli(true);
                        }
                    },
                    () => {
                        resolvePreli(true);
                    }
                );
                //--------
            })
                .then(
                    () => {},
                    (error) => {
                        logger.warn(error);
                    }
                )
                .catch((error) => {
                    logger.warn(error);
                });

            //Add request status variable - inRouteToPickup, inRouteToDestination
            result['request_status'] = request_status;
            let additionalInfos = {
                ETA_toDestination: null,
                request_status: null, //inRouteToPickup, inRouteToDestination, pending
                driverDetails: {
                    name: null,
                    profile_picture: null,
                    global_rating: null,
                    phone_number: null,
                },
                carDetails: {
                    taxi_number: null,
                    car_brand: null,
                    car_image: null,
                    plate_number: null,
                    verification_status: 'Verified',
                },
                basicTripDetails: {
                    pickup_name: null,
                    destination_name: null, //comma concatenated list of destinations
                    payment_method: null, //CASH or WALLET
                    fare_amount: null,
                    passengers_number: null,
                    ride_mode: null, //Ride or delivery
                    ride_simplified_id: null, //Very useful for sharing/tracking the trip infos
                    request_fp: null, //! VERY IMPORTANT
                    isGoingUntilHome:
                        rideHistory.isGoingUntilHome !== undefined &&
                        rideHistory.isGoingUntilHome !== null
                            ? rideHistory.isGoingUntilHome
                            : false, //To know whether or not the rider is going until home
                },
                birdview_infos: /DELIVERY/i.test(rideHistory.ride_mode)
                    ? {
                          number_of_packages: rideHistory.passengers_number,
                          fare: rideHistory.fare,
                          date_requested: rideHistory.date_requested,
                          dropoff_details: rideHistory.destinationData,
                          pickup_details: rideHistory.pickup_location_infos,
                      }
                    : null,
            }; //Will contain all the additional informations needed
            //Add the driver's basic information (name, profile picture, taxi number-if any, car brand, car image, general rating, plate number, phone number)
            additionalInfos.driverDetails.name = driverProfile.name;
            additionalInfos.driverDetails.profile_picture = `${process.env.AWS_S3_DRIVERS_PROFILE_PICTURES_PATH}/${driverProfile.identification_data.profile_picture}`;
            additionalInfos.driverDetails.global_rating =
                driverProfile.operational_state.global_rating !== undefined &&
                driverProfile.operational_state.global_rating !== null
                    ? driverProfile.operational_state.global_rating
                    : 4.9;
            additionalInfos.driverDetails.phone_number =
                driverProfile.phone_number;
            //Add the current car details
            //! Get the correct car information
            let currentVehicle = null;
            driverProfile.cars_data.map((car) => {
                if (
                    car.car_fingerprint ===
                    driverProfile.operational_state.default_selected_car
                        .car_fingerprint
                ) {
                    //Found the car
                    currentVehicle = car;
                }
            });
            //! Get the first car registered if null was found
            currentVehicle =
                currentVehicle !== null && currentVehicle !== undefined
                    ? currentVehicle
                    : driverProfile.cars_data[0];
            //!------
            //Complete the car's infos
            additionalInfos.carDetails.taxi_number = currentVehicle.taxi_number;
            additionalInfos.carDetails.car_brand = currentVehicle.car_brand;
            additionalInfos.carDetails.car_image = `${process.env.AWS_S3_VEHICLES_PICTURES_PATH}/${currentVehicle.taxi_picture}`;
            additionalInfos.carDetails.plate_number =
                currentVehicle.plate_number;
            //Add pickup name and destination name
            additionalInfos.basicTripDetails.pickup_name =
                rideHistory.pickup_location_infos.location_name !== false &&
                rideHistory.pickup_location_infos.location_name !== undefined &&
                rideHistory.pickup_location_infos.location_name !== null
                    ? rideHistory.pickup_location_infos.location_name
                    : rideHistory.pickup_location_infos.street_name !== false &&
                      rideHistory.pickup_location_infos.street_name !==
                          undefined &&
                      rideHistory.pickup_location_infos.street_name !== null
                    ? rideHistory.pickup_location_infos.street_name
                    : rideHistory.pickup_location_infos.suburb !== false &&
                      rideHistory.pickup_location_infos.suburb !== undefined &&
                      rideHistory.pickup_location_infos.suburb !== null
                    ? rideHistory.pickup_location_infos.suburb
                    : 'Close to you';
            //Add ddestination name(s)
            rideHistory.destinationData.map((location) => {
                if (
                    additionalInfos.basicTripDetails.destination_name === null
                ) {
                    //Still empty
                    additionalInfos.basicTripDetails.destination_name =
                        location.location_name !== false &&
                        location.location_name !== undefined &&
                        location.location_name !== null
                            ? location.location_name
                            : location.suburb !== false &&
                              location.suburb !== undefined &&
                              location.suburb !== null
                            ? location.suburb
                            : 'Click for more';
                } //Add
                else {
                    additionalInfos.basicTripDetails.destination_name +=
                        ', ' +
                        (location.location_name !== false &&
                        location.location_name !== undefined &&
                        location.location_name !== null
                            ? location.location_name
                            : location.suburb !== false &&
                              location.suburb !== undefined &&
                              location.suburb !== null
                            ? location.suburb
                            : 'Click for more');
                }
            });
            //Add payment method
            additionalInfos.basicTripDetails.payment_method =
                rideHistory.payment_method.toUpperCase();
            //Addd fare amount
            additionalInfos.basicTripDetails.fare_amount = rideHistory.fare;
            //Add the number of passengers
            additionalInfos.basicTripDetails.passengers_number =
                rideHistory.passengers_number;
            //Add the ride mode
            additionalInfos.basicTripDetails.ride_mode =
                rideHistory.ride_mode.toUpperCase();
            //Add the simplified id
            additionalInfos.basicTripDetails.ride_simplified_id =
                rideHistory.trip_simplified_id;
            //! Add the ride fingerprint
            additionalInfos.basicTripDetails.request_fp =
                rideHistory.request_fp;
            //! Add the requester fingerprint
            additionalInfos.requester_fp = rideHistory.client_id;
            //! Get the requester details
            //? Get dynamically the requester details based on the scope of the request - normal or corporate
            let isNormalrequestScope =
                /normal/i.test(rideHistory.request_globality) ||
                rideHistory.request_globality === undefined;
            //...
            let dynamicRequesterFetcher = isNormalrequestScope
                ? {
                      table_name: 'passengers_profiles',
                      IndexName: 'user_fingerprint',
                      KeyConditionExpression: 'user_fingerprint = :val1',
                      ExpressionAttributeValues: {
                          ':val1': rideHistory.client_id,
                      },
                  }
                : {
                      table_name: 'dedicated_services_accounts',
                      IndexName: 'company_fp',
                      KeyConditionExpression: 'company_fp = :val1',
                      ExpressionAttributeValues: {
                          ':val1': rideHistory.client_id,
                      },
                  };

            dynamicRequesterFetcher.toArray(function (err, requesterData) {
                if (requesterData !== undefined && requesterData.length > 0) {
                    //? Add the requester's name and phone
                    additionalInfos['requester_infos'] = {};
                    additionalInfos.requester_infos.requester_name =
                        isNormalrequestScope
                            ? requesterData[0].name
                            : requesterData[0].company_name;
                    additionalInfos.requester_infos.requester_surname =
                        isNormalrequestScope
                            ? requesterData[0].surname
                            : requesterData[0].user_registerer.last_name;
                    additionalInfos.requester_infos.phone = isNormalrequestScope
                        ? requesterData[0].phone_number
                        : requesterData[0].phone;
                    //? --------
                    //? Add the delivery details
                    additionalInfos['delivery_information'] = {};
                    additionalInfos['delivery_information']['packageSize'] =
                        rideHistory.delivery_infos.packageSize !== undefined &&
                        rideHistory.delivery_infos.packageSize !== null
                            ? rideHistory.delivery_infos.packageSize
                            : null;
                    additionalInfos.delivery_information.receiver_infos =
                        rideHistory.delivery_infos;
                    //Found the requester data
                    //Get the estimated time TO the destination (from the current's user position)
                    new Promise((res4) => {
                        let url =
                            `${
                                /production/i.test(process.env.EVIRONMENT)
                                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                                    : process.env.LOCAL_URL
                            }` +
                            ':' +
                            process.env.MAP_SERVICE_PORT +
                            '/getRouteToDestinationSnapshot?org_latitude=' +
                            rideHistory.pickup_location_infos.coordinates
                                .latitude +
                            '&org_longitude=' +
                            rideHistory.pickup_location_infos.coordinates
                                .longitude +
                            '&dest_latitude=' +
                            rideHistory.destinationData[0].coordinates
                                .longitude +
                            '&dest_longitude=' +
                            rideHistory.destinationData[0].coordinates
                                .latitude +
                            '&user_fingerprint=' +
                            rideHistory.client_id;
                        requestAPI(url, function (error, response, body) {
                            if (error === null) {
                                try {
                                    body = JSON.parse(body);
                                    res4(body.eta);
                                } catch (error) {
                                    res4(false);
                                }
                            } else {
                                res4(false);
                            }
                        });
                    })
                        .then(
                            (estimated_travel_time) => {
                                //Add the eta to destination
                                //? Change the ETA based on the request status
                                additionalInfos.ETA_toDestination =
                                    /inRouteToPickup/i.test(request_status)
                                        ? result.eta
                                        : estimated_travel_time;
                                additionalInfos.request_status = request_status;
                                //?---
                                result = { ...result, ...additionalInfos }; //Merge all the data
                                //Cache-
                                //Cache computed result
                                new Promise((resPromiseresult) => {
                                    redisGet(rideHistory.request_fp).then(
                                        (cachedTripData) => {
                                            if (cachedTripData !== null) {
                                                redisCluster.setex(
                                                    rideHistory.request_fp,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(result)
                                                );
                                                resPromiseresult(true);
                                            } //Update cache anyways
                                            else {
                                                ////logger.info("Update cache");
                                                redisCluster.setex(
                                                    rideHistory.request_fp,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(result)
                                                );
                                                resPromiseresult(true);
                                            }
                                        },
                                        (errorGet) => {
                                            ////logger.info("Update cache");
                                            redisCluster.setex(
                                                rideHistory.request_fp,
                                                process.env
                                                    .REDIS_EXPIRATION_5MIN,
                                                JSON.stringify(result)
                                            );
                                            resPromiseresult(true);
                                        }
                                    );
                                }).then(
                                    () => {},
                                    () => {}
                                );
                                //...
                                //! SAVE THE FINAL FULL RESULT - for 15 min ------
                                if (
                                    rideHistory.request_globality ===
                                        undefined ||
                                    rideHistory.request_globality === 'normal'
                                ) {
                                    redisCluster.setex(
                                        RIDE_REDIS_KEY,
                                        parseInt(
                                            process.env.REDIS_EXPIRATION_5MIN
                                        ) * 3,
                                        JSON.stringify(result)
                                    );
                                }
                                //! ----------------------------------------------
                                ///DONE
                                resolve(result);
                            },
                            (error) => {
                                //logger.warn(error);
                                //If couldn't get the ETA to destination - just leave it as null
                                result = { ...result, ...additionalInfos }; //Merge all the data
                                //Cache-
                                //Cache computed result
                                new Promise((resPromiseresult) => {
                                    redisGet(rideHistory.request_fp).then(
                                        (cachedTripData) => {
                                            if (cachedTripData !== null) {
                                                redisCluster.setex(
                                                    rideHistory.request_fp,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(result)
                                                );
                                                resPromiseresult(true);
                                            } //Update cache anyways
                                            else {
                                                ////logger.info("Update cache");
                                                redisCluster.setex(
                                                    rideHistory.request_fp,
                                                    process.env
                                                        .REDIS_EXPIRATION_5MIN,
                                                    JSON.stringify(result)
                                                );
                                                resPromiseresult(true);
                                            }
                                        },
                                        (errorGet) => {
                                            ////logger.info("Update cache");
                                            redisCluster.setex(
                                                rideHistory.request_fp,
                                                process.env
                                                    .REDIS_EXPIRATION_5MIN,
                                                JSON.stringify(result)
                                            );
                                            resPromiseresult(true);
                                        }
                                    );
                                }).then(
                                    () => {},
                                    () => {}
                                );
                                //...
                                //! SAVE THE FINAL FULL RESULT - for 15 min ------
                                if (
                                    rideHistory.request_globality ===
                                        undefined ||
                                    rideHistory.request_globality === 'normal'
                                ) {
                                    redisCluster.setex(
                                        RIDE_REDIS_KEY,
                                        parseInt(
                                            process.env.REDIS_EXPIRATION_5MIN
                                        ) * 3,
                                        JSON.stringify(result)
                                    );
                                }
                                //! ----------------------------------------------
                                ///DONE
                                resolve(result);
                            }
                        )
                        .catch((error) => {
                            //logger.warn(error);
                        });
                } //No requester data found
                else {
                    resolve(false);
                }
            });
        },
        (error) => {
            //logger.warn(error);
            resolve(false);
        }
    );
}

/**
 * @func storedUpDriversGeospatialData
 * Responsible to store up the driver's geospatial data based on the city and
 * vehicle type.
 * @param req: generic request data
 * @param resolve
 */
function storedUpDriversGeospatialData(req, resolve) {
    let redisKeyDriverProfileData = `${req.user_fingerprint}-driverBasicProfileData`;
    redisGet(redisKeyDriverProfileData)
        .then(
            (resp) => {
                if (resp !== null) {
                    //Stored up some data
                    try {
                        resp = JSON.stringify(resp);
                        //...
                        //drivers-city-vehicleType
                        let redisKeyGeospatialStore = `drivers-${resp.operational_state.last_location.city}-${resp.operational_state.default_selected_car.vehicle_type}`;
                        redisCluster.geoadd(
                            redisKeyGeospatialStore,
                            `${req.longitude}`,
                            `${req.latitude}`,
                            req.user_fingerprint
                        );
                        resolve(true);
                    } catch (error) {
                        resolve(false);
                    }
                } //No data - set
                else {
                    //Get the driver's data
                    dynamo_find_query({
                        table_name: 'drivers_profiles',
                        IndexName: 'driver_fingerprint',
                        KeyConditionExpression: 'driver_fingerprint = :val1',
                        ExpressionAttributeValues: {
                            ':val1': req.user_fingerprint,
                        },
                    })
                        .then((driverData) => {
                            if (
                                driverData !== undefined &&
                                driverData.length > 0
                            ) {
                                //Found some data
                                driverData = driverData[0];
                                //Cache the driver's basic profile info
                                redisCluster.set(
                                    redisKeyDriverProfileData,
                                    JSON.stringify(driverData)
                                );
                                //...
                                //drivers-city-vehicleType
                                let redisKeyGeospatialStore = `drivers-${driverData.operational_state.last_location.city}-${driverData.operational_state.default_selected_car.vehicle_type}`;
                                redisCluster.geoadd(
                                    redisKeyGeospatialStore,
                                    `${req.longitude}`,
                                    `${req.latitude}`,
                                    req.user_fingerprint
                                );
                                resolve(true);
                            } //Non data found
                            else {
                                resolve(false);
                            }
                        })
                        .catch((error) => {
                            logger.error(error);
                            resolve(false);
                        });
                }
            },
            (error) => {
                resolve(false);
            }
        )
        .catch((error) => {
            resolve(false);
        });
}

/**
 * @func updateRiderLocationInfosCache()
 * Responsible for updating the cache infos about the rider's trip location.
 * RIDERS/DRIVERS
 * @param req: contains all the user informations biased to the location aspect
 * @param resolve: resolver for promise
 * IMPORTANT
 */
async function updateRiderLocationInfosCache(req, resolve) {
    resolveDate();
    req.date_logged = new Date(chaineDateUTC); //Attach date
    //! Update geospatial data cached -----
    if (/rider/i.test(req.user_nature)) {
        //Rider
        redisCluster.geoadd(
            'riders',
            `${req.longitude}`,
            `${req.latitude}`,
            req.user_fingerprint
        );
    } else if (/driver/i.test(req.user_nature)) {
        //Driver
        //Enrich the driver's data to be stored in the right set in redis geospatial
        //drivers-city-vehicleType
        // new Promise((reqUpdate) => {
        //   storedUpDriversGeospatialData(req, reqUpdate);
        // })
        //   .then((result) => {
        //     logger.warn("Successfully updated the driver geospatial data!");
        //   })
        //   .catch((error) => {
        //     logger.warn(error);
        //   });
        //! Save the drivers location point in cache
        let driver_details_cached_key = `${req.user_fingerprint}-cached_useful_data`;
        redisCluster.rpush(
            driver_details_cached_key,
            JSON.stringify({
                latitude: req.latitude,
                longitude: req.longitude,
            })
        );

        // redisCluster.lrange(driver_details_cached_key, 0, -1, (err, items) => {
        //   if (err) {
        //     logger.error(err);
        //   }
        //   logger.info(items);
        // });

        //..
        resolve(true);
    }
    //!------------------------------------
    //Check if a previous entry alreay exist
    // redisGet(req.user_fingerprint).then(
    //   (resp) => {
    //     if (resp !== null) {
    //       //Has already a cache entry
    //       try {
    //         let prevCache = JSON.parse(resp);
    //         //Update the previous cache
    //         prevCache.latitude = req.latitude;
    //         prevCache.longitude = req.longitude;
    //         prevCache.date_logged = req.date_logged; //Updated cache data
    //         redisCluster.setex(
    //           req.user_fingerprint.trim(),
    //           process.env.REDIS_EXPIRATION_5MIN,
    //           JSON.stringify(prevCache)
    //         );
    //         resolve(true);
    //       } catch (error) {
    //         resolve(false);
    //       }
    //     } //No cache entry, create a new one
    //     else {
    //       redisCluster.setex(
    //         req.user_fingerprint.trim(),
    //         process.env.REDIS_EXPIRATION_5MIN,
    //         JSON.stringify(req)
    //       );
    //       resolve(true);
    //     }
    //   },
    //   (error) => {
    //     //logger.info(error);
    //     //Create or update the current cache entry
    //     redisCluster.setex(
    //       req.user_fingerprint.trim(),
    //       process.env.REDIS_EXPIRATION_5MIN,
    //       JSON.stringify(req)
    //     );
    //     resolve(true);
    //   }
    // );
}

/**
 * @func reverseGeocodeUserLocation
 * @param resolve
 * @param req: user coordinates, and fingerprint
 * Responsible for finding out the current user (passenger, driver, etc) location details
 * REDIS propertiy
 * user_fingerprint+reverseGeocodeKey -> currentLocationInfos: {...}
 */
function reverseGeocodeUserLocation(resolve, req) {
    //Form the redis key
    let redisKey = req.user_fingerprint + '-reverseGeocodeKey';
    //Check if redis has some informations already
    redisGet(redisKey).then(
        (resp) => {
            if (resp !== null) {
                //Do a fresh request to update the cache
                //Make a new reseach
                new Promise((res) => {
                    //logger.info("Fresh geocpding launched");
                    reverseGeocoderExec(res, req, JSON.parse(resp), redisKey);
                }).then(
                    (result) => {},
                    (error) => {
                        logger.error(error);
                    }
                );

                //Has already a cache entry
                //Check if an old current location is present
                resp = JSON.parse(resp);
                if (resp.currentLocationInfos !== undefined) {
                    //Make a rehydration request
                    new Promise((res) => {
                        reverseGeocoderExec(res, req, false, redisKey);
                    }).then(
                        (result) => {
                            //Updating cache and replying to the main thread
                            let currentLocationEntry = {
                                currentLocationInfos: result,
                            };
                            redisCluster.setex(
                                redisKey,
                                process.env.REDIS_EXPIRATION_5MIN,
                                JSON.stringify(currentLocationEntry)
                            );
                        },
                        (error) => {
                            logger.error(error);
                        }
                    );
                    //Send
                    resolve(resp.currentLocationInfos);
                } //No previously cached current location
                else {
                    //Make a new reseach
                    new Promise((res) => {
                        reverseGeocoderExec(res, req, false, redisKey);
                    }).then(
                        (result) => {
                            //Updating cache and replying to the main thread
                            let currentLocationEntry = {
                                currentLocationInfos: result,
                            };
                            redisCluster.setex(
                                redisKey,
                                process.env.REDIS_EXPIRATION_5MIN,
                                JSON.stringify(currentLocationEntry)
                            );
                            resolve(result);
                        },
                        (error) => {
                            logger.error(error);
                            resolve(false);
                        }
                    );
                }
            } //No cache entry, create a new one
            else {
                //Make a new reseach
                new Promise((res) => {
                    reverseGeocoderExec(res, req, false, redisKey);
                }).then(
                    (result) => {
                        //Updating cache and replying to the main thread
                        let currentLocationEntry = {
                            currentLocationInfos: result,
                        };
                        redisCluster.setex(
                            redisKey,
                            process.env.REDIS_EXPIRATION_5MIN,
                            JSON.stringify(currentLocationEntry)
                        );
                        resolve(result);
                    },
                    (error) => {
                        logger.error(error);
                        resolve(false);
                    }
                );
            }
        },
        (error) => {
            logger.error(error);
            resolve(false);
        }
    );
}
/**
 * @func reverseGeocoderExec
 * @param updateCache: to known whether to update the cache or not if yes, will have the value of the hold cache.
 * @param req: the user basic data (fingerprint, etc)
 * @param redisKey: the redis key to cache the data to
 * Responsible for executing the geocoding new fresh requests
 */
function reverseGeocoderExec(resolve, req, updateCache = false, redisKey) {
    //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
    //? 1. Destination
    //? Get temporary vars
    let pickLatitude1 = parseFloat(req.latitude);
    let pickLongitude1 = parseFloat(req.longitude);
    //! Coordinates order fix - major bug fix for ocean bug
    if (
        pickLatitude1 !== undefined &&
        pickLatitude1 !== null &&
        pickLatitude1 !== 0 &&
        pickLongitude1 !== undefined &&
        pickLongitude1 !== null &&
        pickLongitude1 !== 0
    ) {
        //? Switch latitude and longitude - check the negative sign
        if (parseFloat(pickLongitude1) < 0) {
            //Negative - switch
            req.latitude = pickLongitude1;
            req.longitude = pickLatitude1;
        }
    }
    //! -------
    let url =
        process.env.URL_SEARCH_SERVICES +
        'reverse?lon=' +
        req.longitude +
        '&lat=' +
        req.latitude;

    logger.info(url);

    requestAPI(url, function (error, response, body) {
        try {
            body = JSON.parse(body);
            if (body != undefined) {
                if (body.features[0].properties != undefined) {
                    //Check if a city was already assigned
                    //? Deduct consistently the town
                    let urlNominatim = `${process.env.URL_NOMINATIM_SERVICES}/reverse?lat=${req.latitude}&lon=${req.longitude}&zoom=10&format=json`;

                    requestAPI(
                        urlNominatim,
                        function (error2, response2, body2) {
                            // logger.error(body2);
                            try {
                                body2 = JSON.parse(body2);
                                // logger.warn(body2.address.city);
                                if (
                                    body.features[0].properties.street !=
                                    undefined
                                ) {
                                    //? Update the city
                                    body.features[0].properties['city'] =
                                        body2.address.city !== undefined
                                            ? body2.address.city
                                            : body.features[0].properties[
                                                  'city'
                                              ];
                                    //? -----
                                    if (updateCache !== false) {
                                        //Update cache
                                        updateCache.currentLocationInfos =
                                            body.features[0].properties;
                                        redisCluster.setex(
                                            redisKey,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(updateCache)
                                        );
                                    }
                                    //...
                                    resolve(body.features[0].properties);
                                } else if (
                                    body.features[0].properties.name !=
                                    undefined
                                ) {
                                    //? Update the city
                                    body.features[0].properties['city'] =
                                        body2.address.city !== undefined
                                            ? body2.address.city
                                            : body.features[0].properties[
                                                  'city'
                                              ];
                                    //? -----
                                    body.features[0].properties.street =
                                        body.features[0].properties.name;
                                    if (updateCache !== false) {
                                        //Update cache
                                        updateCache.currentLocationInfos =
                                            body.features[0].properties;
                                        redisCluster.setex(
                                            redisKey,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(updateCache)
                                        );
                                    }
                                    //...
                                    resolve(body.features[0].properties);
                                } else {
                                    resolve(false);
                                }
                            } catch (error) {
                                logger.error(error);
                                if (
                                    body.features[0].properties.street !=
                                    undefined
                                ) {
                                    if (updateCache !== false) {
                                        //Update cache
                                        updateCache.currentLocationInfos =
                                            body.features[0].properties;
                                        redisCluster.setex(
                                            redisKey,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(updateCache)
                                        );
                                    }
                                    //...
                                    resolve(body.features[0].properties);
                                } else if (
                                    body.features[0].properties.name !=
                                    undefined
                                ) {
                                    body.features[0].properties.street =
                                        body.features[0].properties.name;
                                    if (updateCache !== false) {
                                        //Update cache
                                        updateCache.currentLocationInfos =
                                            body.features[0].properties;
                                        redisCluster.setex(
                                            redisKey,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(updateCache)
                                        );
                                    }
                                    //...
                                    resolve(body.features[0].properties);
                                } else {
                                    resolve(false);
                                }
                            }
                        }
                    );
                } else {
                    resolve(false);
                }
            } else {
                resolve(false);
            }
        } catch (error) {
            logger.warn(error);
            resolve(false);
        }
    });
}

/**
 * @func findoutPickupLocationNature
 * @param point: location point
 * @param user_fingerprint: fingerprint of the user. (INCLUDED IN POINT)
 * Responsible for check if the pickup location is a Taxi rank or private location (only these 2 for now)
 * Radius in meters - default: 2meters
 * Possible types
 * Airport
 * TaxiRank     //private location
 * PrivateLocation  //Private location
 */
function findoutPickupLocationNature(resolve, point) {
    let radius = 2; //meters
    let locationIdentity = { locationType: 'PrivateLocation' }; //Default private location
    new Promise((resCheck) => {
        /*taxiRanksDb.map((location) => {
      let centerLat = parseFloat(location.central_coord.split(",")[0]);
      let centerLng = parseFloat(location.central_coord.split(",")[1]);
      //...
      const center = { lat: parseFloat(centerLat), lon: parseFloat(centerLng) };
      let checkPosition = geolocationUtlis.insideCircle(
        { lat: parseFloat(point.latitude), lon: parseFloat(point.longitude) },
        center,
        radius
      );
      if (checkPosition) {
        locationIdentity = location;
        //Can be changed here to include more places detections
        location = { locationType: "TaxiRank" }; //Set to taxi rank only
        //...
        resCheck(location);
      } //Private location
      else {
        locationIdentity = { locationType: "PrivateLocation" };
      }
    });*/
        //...Send private location by default
        resCheck(locationIdentity);
    })
        .then(
            (result) => {
                let locationIdentityRSLT = result;
                //Check for airport if Private location
                if (locationIdentityRSLT.locationType !== 'TaxiRank') {
                    //Check if it's an airport -reverse geocode and deduct from the name of the place
                    new Promise((res) => {
                        reverseGeocodeUserLocation(res, point);
                    })
                        .then(
                            (result) => {
                                if (result !== false) {
                                    if (result.name !== undefined) {
                                        if (/airport/i.test(result.name)) {
                                            //Airport detected
                                            locationIdentityRSLT = {
                                                locationType: 'Airport',
                                                name: result.name,
                                            };
                                            resolve(locationIdentityRSLT);
                                        } //Private location
                                        else {
                                            locationIdentityRSLT = {
                                                locationType: 'PrivateLocation',
                                            };
                                            resolve(locationIdentityRSLT);
                                        }
                                    } else {
                                        locationIdentityRSLT = {
                                            locationType: 'PrivateLocation',
                                        };
                                        resolve(locationIdentityRSLT);
                                    }
                                } else {
                                    locationIdentityRSLT = {
                                        locationType: 'PrivateLocation',
                                    };
                                    resolve(locationIdentityRSLT);
                                }
                            },
                            (error) => {
                                locationIdentityRSLT = {
                                    locationType: 'PrivateLocation',
                                };
                                resolve(locationIdentityRSLT);
                            }
                        )
                        .catch((error) => {
                            locationIdentityRSLT = {
                                locationType: 'PrivateLocation',
                            };
                            resolve(locationIdentityRSLT);
                        });
                } //Taxirank
                else {
                    //...
                    resolve(locationIdentity);
                }
            },
            (error) => {
                //Defaults to private location
                locationIdentity = { locationType: 'PrivateLocation' };
                resolve(locationIdentity);
            }
        )
        .catch((error) => {
            //Defaults to private location
            locationIdentity = { locationType: 'PrivateLocation' };
            resolve(locationIdentity);
        });
}

/**
 * @func findDestinationPathPreview
 * @param resolve
 * @param pointData: origin and destination of the user selected from the app.
 * Responsible for getting the polyline and eta to destination based on the selected destination location.
 * REDIS
 * key: pathToDestinationPreview+user_fingerprint
 * value: [{...}, {...}]
 */
function findDestinationPathPreview(resolve, pointData) {
    if (pointData.origin !== undefined && pointData.destination !== undefined) {
        //Create the redis key
        let redisKey =
            pointData.request_fp !== undefined && pointData.request_fp !== null
                ? 'pathToDestinationPreview-' + pointData.request_fp
                : 'pathToDestinationPreview-' + pointData.user_fingerprint;
        //Add redis key to pointData
        pointData.redisKey = null;
        pointData.redisKey = redisKey;
        //Check from redis first
        redisGet(redisKey).then(
            (resp) => {
                if (resp !== null) {
                    //Found something cached
                    try {
                        //Check for needed record
                        let neededRecord = false; //Will contain the needed record if exists or else false
                        resp = JSON.parse(resp);
                        resp.map((pathInfo) => {
                            if (
                                pathInfo.origin !== undefined &&
                                pathInfo.origin.latitude ===
                                    pointData.origin.latitude &&
                                pathInfo.origin.longitude ===
                                    pointData.origin.longitude &&
                                pathInfo.destination.latitude ===
                                    pointData.destination.latitude &&
                                pathInfo.destination.longitude ===
                                    pointData.destination.longitude
                            ) {
                                neededRecord = pathInfo;
                            }
                        });
                        //...
                        if (neededRecord !== false) {
                            //Make a light request to update the eta
                            new Promise((res) => {
                                findRouteSnapshotExec(res, pointData);
                            }).then(
                                () => {},
                                () => {}
                            );
                            //Found record - respond to the user
                            resolve(neededRecord);
                        } //Not record found - do fresh search
                        else {
                            new Promise((res) => {
                                findRouteSnapshotExec(res, pointData);
                            }).then(
                                (result) => {
                                    resolve(result);
                                },
                                (error) => {
                                    resolve(false);
                                }
                            );
                        }
                    } catch (error) {
                        //Error - do a fresh search
                        new Promise((res) => {
                            findRouteSnapshotExec(res, pointData);
                        }).then(
                            (result) => {
                                resolve(result);
                            },
                            (error) => {
                                resolve(false);
                            }
                        );
                    }
                } //Nothing- do a fresh search
                else {
                    new Promise((res) => {
                        findRouteSnapshotExec(res, pointData);
                    }).then(
                        (result) => {
                            resolve(result);
                        },
                        (error) => {
                            resolve(false);
                        }
                    );
                }
            },
            (error) => {
                //Error - do a fresh search
                new Promise((res) => {
                    findRouteSnapshotExec(res, pointData);
                }).then(
                    (result) => {
                        resolve(result);
                    },
                    (error) => {
                        resolve(false);
                    }
                );
            }
        );
    }
    //Invalid data
    else {
        resolve(false);
    }
}
/**
 * @func findRouteSnapshotExec
 * @param resolve
 * @param pointData: containing
 * Responsible to manage the requests of getting the polylines from the ROUTING engine
 * of DulcetDash.
 */
function findRouteSnapshotExec(resolve, pointData) {
    let org_latitude = pointData.origin.latitude;
    let org_longitude = pointData.origin.longitude;
    let dest_latitude = pointData.destination.latitude;
    let dest_longitude = pointData.destination.longitude;
    //...
    new Promise((res) => {
        getRouteInfosDestination(
            {
                passenger: {
                    latitude: org_latitude,
                    longitude: org_longitude,
                },
                destination: {
                    latitude: dest_latitude,
                    longitude: dest_longitude,
                },
            },
            res
        );
    }).then(
        (result) => {
            result.origin = {
                latitude: org_latitude,
                longitude: org_longitude,
            };
            result.destination = {
                latitude: dest_latitude,
                longitude: dest_longitude,
            };
            //Save in cache
            new Promise((res) => {
                //Check if there was a previous redis record
                redisGet(pointData.redisKey).then(
                    (resp) => {
                        if (resp !== null) {
                            //Contains something
                            try {
                                //Add new record to the array
                                resp = JSON.parse(resp);
                                resp.push(result);
                                resp = [
                                    ...new Set(resp.map(JSON.stringify)),
                                ].map(JSON.parse);
                                redisCluster.setex(
                                    pointData.redisKey,
                                    process.env.REDIS_EXPIRATION_5MIN,
                                    JSON.stringify(resp)
                                );
                                res(true);
                            } catch (error) {
                                //Create a fresh one
                                redisCluster.setex(
                                    pointData.redisKey,
                                    process.env.REDIS_EXPIRATION_5MIN,
                                    JSON.stringify([result])
                                );
                                res(false);
                            }
                        } //No records -create a fresh one
                        else {
                            redisCluster.setex(
                                pointData.redisKey,
                                process.env.REDIS_EXPIRATION_5MIN,
                                JSON.stringify([result])
                            );
                            res(true);
                        }
                    },
                    (error) => {
                        //create fresh record
                        redisCluster.setex(
                            pointData.redisKey,
                            process.env.REDIS_EXPIRATION_5MIN,
                            JSON.stringify([result])
                        );
                        res(false);
                    }
                );
            }).then(
                () => {},
                () => {}
            );
            //Respond already
            resolve(result);
        },
        (error) => {
            //logger.info(error);
            resolve(false);
        }
    );
}

/**
 * @func updateRelativeDistancesRiderDrivers
 * @param relativeHeader: includes the city, country, distance and ETA rider fingerprint and rider fingerprint
 * @param collectionRelativeDistances: realtive distances btw the riders and drivers
 * @param resolve
 * Responsible for updating the relative distances of a rider relative to the closeby drivers (city, country)
 */
function updateRelativeDistancesRiderDrivers(
    collectionRelativeDistances,
    relativeHeader,
    resolve
) {
    resolveDate();
    //Check if a previous mongo record already exists
    let queryChecker = {
        user_fingerprint: relativeHeader.user_fingerprint,
        driver_fingerprint: relativeHeader.driver_fingerprint,
    };

    dynamo_find_query({
        table_name: 'relative_distances_riders_drivers',
        IndexName: 'user_fingerprint',
        KeyConditionExpression:
            'user_fingerprint = :val1, driver_fingerprint = :val2',
        ExpressionAttributeValues: {
            ':val1': queryChecker.user_fingerprint,
            ':val2': queryChecker.driver_fingerprint,
        },
    })
        .then((record) => {
            if (record.length === 0) {
                //Empty - create a new record
                let record = {
                    user_fingerprint: relativeHeader.user_fingerprint,
                    driver_fingerprint: relativeHeader.driver_fingerprint,
                    driver_coordinates: relativeHeader.driver_coordinates,
                    city: relativeHeader.city,
                    country: relativeHeader.country,
                    eta: relativeHeader.eta,
                    distance: relativeHeader.distance,
                    date_updated: new Date(chaineDateUTC).toISOString(),
                };
                //...
                dynamo_insert('relative_distances_riders_drivers', record)
                    .then((result) => {
                        resolve(result);
                    })
                    .catch((error) => {
                        logger.error(error);
                        resolve(false);
                    });
            } //Not empty - just update
            else {
                let updatedRecord = {
                    $set: {
                        driver_coordinates: relativeHeader.driver_coordinates,
                        city: relativeHeader.city,
                        country: relativeHeader.country,
                        eta: relativeHeader.eta,
                        distance: relativeHeader.distance,
                        date_updated: new Date(chaineDateUTC),
                    },
                };
                //...
                dynamo_update(
                    'relative_distances_riders_drivers',
                    record._id,
                    'set driver_coordinates = :val1, city = :val2, country = :val3, eta = :val4, distance = :val5, date_updated = :val6',
                    {
                        ':val1': relativeHeader.driver_coordinates,
                        ':val2': relativeHeader.city,
                        ':val3': relativeHeader.country,
                        ':val4': relativeHeader.eta,
                        ':val5': relativeHeader.distance,
                        ':val6': new Date(chaineDateUTC).toISOString(),
                    }
                )
                    .then((result) => {
                        resolve(result);
                    })
                    .catch((error) => {
                        logger.error(error);
                        resolve(false);
                    });
            }
        })
        .catch((error) => {
            logger.error(error);
            resolve(false);
        });
}

/**
 * @func cleanAndAdjustRelativeDistancesList
 * Responsible for cleaning the relative distances of drivers and passengers of all false values and
 * limiting the result number based on the @param list_limit parameter
 * @param list_limit: for limiting the result returned or "all" for all the results (not recommended for mobile responses).
 * @param resolve
 */
function cleanAndAdjustRelativeDistancesList(rawList, list_limit = 7, resolve) {
    //Remove any false values
    //? Bypass if all the drivers are required
    rawList = rawList.filter((element) =>
        /all/i.test(list_limit)
            ? true
            : element !== false && element.eta !== false
    );
    //Sort based on the distance
    //! Sort normally and place all the nulls at the end for "all"
    rawList = /all/i.test(list_limit)
        ? rawList
              .sort((a, b) => (a.distance === null ? 1 : -1))
              .sort((a, b) =>
                  a.distance !== null && b.distance !== null
                      ? a.distance - b.distance
                      : 1
              )
        : rawList.sort((a, b) => a.distance - b.distance);
    //! Remove drivers with undefined, false or null coordinates
    rawList = rawList.filter((element) =>
        element.driver_coordinates !== undefined &&
        element.driver_coordinates !== false &&
        element.driver_coordinates !== null &&
        element.driver_coordinates.latitude !== undefined &&
        element.driver_coordinates.latitude !== false &&
        element.driver_coordinates.latitude !== null &&
        element.driver_coordinates.longitude !== undefined &&
        element.driver_coordinates.longitude !== false &&
        element.driver_coordinates.longitude !== null &&
        //...
        element.prev_driver_coordinates !== undefined &&
        element.prev_driver_coordinates !== false &&
        element.prev_driver_coordinates !== null &&
        element.prev_driver_coordinates.latitude !== undefined &&
        element.prev_driver_coordinates.latitude !== false &&
        element.prev_driver_coordinates.latitude !== null &&
        element.prev_driver_coordinates.longitude !== undefined &&
        element.prev_driver_coordinates.longitude !== false &&
        element.prev_driver_coordinates.longitude !== null
            ? true
            : false
    );
    //!....
    //...
    if (/all/i.test(list_limit)) {
        //All the closest drivers in order
        //Check if there are any results
        if (rawList.length > 0) {
            //has a close driver
            resolve(rawList);
        } //No close drivers
        else {
            resolve({ response: 'no_close_drivers_found' });
        }
    } //Limit the results
    else {
        try {
            list_limit = parseInt(list_limit);
            rawList = rawList.slice(0, list_limit);
            //Check if there are any results
            if (rawList.length > 0) {
                //has a close driver
                resolve(rawList);
            } //No close drivers
            else {
                resolve({ response: 'no_close_drivers_found' });
            }
        } catch (error) {
            //logger.info(error);
            list_limit = 7;
            rawList = rawList.slice(0, list_limit);
            //Check if there are any results
            if (rawList.length > 0) {
                //has a close driver
                resolve(rawList);
            } //No close drivers
            else {
                resolve({ response: 'no_close_drivers_found' });
            }
        }
    }
    //...
}

/**
 * @func getFreshProximity_driversList
 * Responsible for actively getting the drivers list proximity and caching the result.
 * @param req: classic request data bundle containing all the neccessary goodies.
 * @param redisKey: the redis key to store the proximity data
 * @param collectionDrivers_profiles: list of all the drivers.
 * @param collectionRidesDeliveries_data: list of all the rides.
 * @param collectionPassengers_profiles: list of all the rides/deliveries
 * @param resolveMother
 *
 * ? includeOfflineDrivers
 * Param used to also include offline drivers with the wanted criteria, very useful for dispatching requests.
 */
function getFreshProximity_driversList(
    req,
    redisKey,
    collectionDrivers_profiles,
    collectionRidesDeliveries_data,
    collectionPassengers_profiles,
    resolveMother
) {
    //Get the list of drivers match the availability criteria
    let driverFilter = {
        'operational_state.status':
            req.includeOfflineDrivers !== undefined &&
            req.includeOfflineDrivers !== null
                ? { $in: ['online', 'offline'] }
                : 'online',
        'operational_state.last_location.city': req.city,
        'operational_state.last_location.country': req.country,
        operation_clearances: {
            $in: ['Ride', 'Delivery', 'ride', 'delivery', 'RIDE', 'DELIVERY'],
        },
        //Filter the drivers based on the vehicle type if provided
        'operational_state.default_selected_car.vehicle_type':
            req.ride_type !== undefined && req.ride_type !== false
                ? req.ride_type
                : {
                      $in: [
                          'normalTaxiEconomy',
                          'electricEconomy',
                          'comfortNormalRide',
                          'comfortElectricRide',
                          'luxuryNormalRide',
                          'luxuryElectricRide',
                          'electricBikes',
                          'bikes',
                          'carDelivery',
                          'vanDelivery',
                      ],
                  },
    }; //?Indexed
    logger.info(driverFilter);
    //...
    collectionDrivers_profiles
        .find(driverFilter)
        .toArray(function (err, driversProfiles) {
            if (err) {
                logger.info(err);
                resolveMother({ response: 'no_close_drivers_found' });
            }
            //check that some drivers where found
            if (driversProfiles.length > 0) {
                //yep
                //Filter the drivers based on their car's maximum capacity (the amount of passengers it can handle)
                //They can receive 3 additional requests on top of the limit of sits in their selected cars.
                //! Add 30 possible passengers on top of the base passengers limit.
                /*driversProfiles = driversProfiles.filter(
          (dData) =>
            dData.operational_state.accepted_requests_infos === null ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number <=
              dData.operational_state.default_selected_car.max_passengers +
                30 ||
            dData.operational_state.accepted_requests_infos === undefined ||
            dData.operational_state.accepted_requests_infos === null ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number === undefined ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number === null
        );*/
                //...
                let mainPromiser = driversProfiles.map((driverData) => {
                    return new Promise((resolve) => {
                        //Check for the coords
                        if (
                            driverData.operational_state.last_location !==
                                null &&
                            driverData.operational_state.last_location !==
                                undefined &&
                            driverData.operational_state.last_location
                                .coordinates !== null &&
                            driverData.operational_state.last_location
                                .coordinates !== undefined &&
                            driverData.operational_state.last_location
                                .coordinates.latitude !== undefined &&
                            driverData.operational_state.last_location
                                .coordinates.longitude !== undefined
                        ) {
                            //...
                            let tmp = {
                                passenger: {
                                    latitude: req.org_latitude,
                                    longitude: req.org_longitude,
                                },
                                destination: {
                                    latitude:
                                        driverData.operational_state
                                            .last_location.coordinates.latitude,
                                    longitude:
                                        driverData.operational_state
                                            .last_location.coordinates
                                            .longitude,
                                },
                            };
                            let redisKey =
                                req.user_fingerprint +
                                '-' +
                                driverData.driver_fingerprint;
                            let valueIndex = 'relativeEta';
                            //CHeck for cache value
                            redisGet(redisKey).then(
                                (resp) => {
                                    if (resp !== null) {
                                        //Has some record
                                        //Check if the wanted value is present
                                        try {
                                            resp = JSON.parse(resp);
                                            if (
                                                resp[valueIndex] !==
                                                    undefined &&
                                                resp[valueIndex] !== null &&
                                                resp[valueIndex] !== false
                                            ) {
                                                ////logger.info("Foudn cached data");
                                                //Update the cache as well
                                                new Promise((res) => {
                                                    makeFreshSearch_ETA_2points(
                                                        tmp,
                                                        redisKey,
                                                        valueIndex,
                                                        collectionRelativeDistances,
                                                        driverData,
                                                        res
                                                    );
                                                })
                                                    .then(
                                                        () => {},
                                                        () => {}
                                                    )
                                                    .catch(() => {});
                                                //Update the relative mongo records
                                                if (
                                                    resp[valueIndex] !==
                                                        false &&
                                                    resp[valueIndex] !==
                                                        undefined &&
                                                    resp[valueIndex].eta !==
                                                        undefined
                                                ) {
                                                    new Promise((res1) => {
                                                        let relativeHeader = {
                                                            user_fingerprint:
                                                                req.user_fingerprint,
                                                            status: driverData
                                                                .operational_state
                                                                .status,
                                                            driver_fingerprint:
                                                                driverData.driver_fingerprint,
                                                            driver_coordinates:
                                                                {
                                                                    latitude:
                                                                        driverData
                                                                            .operational_state
                                                                            .last_location
                                                                            .coordinates
                                                                            .latitude,
                                                                    longitude:
                                                                        driverData
                                                                            .operational_state
                                                                            .last_location
                                                                            .coordinates
                                                                            .longitude,
                                                                },
                                                            push_notification_token:
                                                                driverData.push_notification_token,
                                                            eta: resp[
                                                                valueIndex
                                                            ].eta,
                                                            distance:
                                                                resp[valueIndex]
                                                                    .distance,
                                                            city: req.city,
                                                            country:
                                                                req.country,
                                                        };
                                                        updateRelativeDistancesRiderDrivers(
                                                            collectionRelativeDistances,
                                                            relativeHeader,
                                                            res1
                                                        );
                                                    }).then(
                                                        () => {},
                                                        () => {}
                                                    );
                                                }
                                                //has something, return that
                                                resp[valueIndex].status =
                                                    driverData.operational_state.status; //? Online or offline
                                                resp[
                                                    valueIndex
                                                ].driver_fingerprint =
                                                    driverData.driver_fingerprint; //Add the driver fingerprint to the response
                                                resp[
                                                    valueIndex
                                                ].driver_coordinates = {
                                                    latitude:
                                                        driverData
                                                            .operational_state
                                                            .last_location
                                                            .coordinates
                                                            .latitude,
                                                    longitude:
                                                        driverData
                                                            .operational_state
                                                            .last_location
                                                            .coordinates
                                                            .longitude,
                                                }; //Add the driver coordinates to the response
                                                resp[
                                                    valueIndex
                                                ].prev_driver_coordinates = {
                                                    latitude:
                                                        driverData
                                                            .operational_state
                                                            .last_location
                                                            .prev_coordinates
                                                            .latitude,
                                                    longitude:
                                                        driverData
                                                            .operational_state
                                                            .last_location
                                                            .prev_coordinates
                                                            .longitude,
                                                }; //Add the driver's previous coordinates to the response
                                                resp[
                                                    valueIndex
                                                ].push_notification_token =
                                                    driverData.operational_state
                                                        .push_notification_token !==
                                                        null &&
                                                    driverData.operational_state
                                                        .push_notification_token !==
                                                        undefined
                                                        ? driverData
                                                              .operational_state
                                                              .push_notification_token
                                                              .userId
                                                        : null; //Add the push notification token
                                                resolve(resp[valueIndex]);
                                            } //The wanted index is not present, make a new search
                                            else {
                                                new Promise((res) => {
                                                    makeFreshSearch_ETA_2points(
                                                        tmp,
                                                        redisKey,
                                                        valueIndex,
                                                        collectionRelativeDistances,
                                                        driverData,
                                                        res
                                                    );
                                                })
                                                    .then(
                                                        (result) => {
                                                            resolve(result);
                                                        },
                                                        (error) => {
                                                            //logger.info(error);
                                                            let driverRepr = {
                                                                eta: null,
                                                                distance: null,
                                                                status: driverData
                                                                    .operational_state
                                                                    .status,
                                                                driver_fingerprint:
                                                                    driverData.driver_fingerprint,
                                                                driver_coordinates:
                                                                    null,
                                                                prev_driver_coordinates:
                                                                    null,
                                                                push_notification_token:
                                                                    driverData
                                                                        .operational_state
                                                                        .push_notification_token !==
                                                                        undefined &&
                                                                    driverData
                                                                        .operational_state
                                                                        .push_notification_token !==
                                                                        null
                                                                        ? driverData
                                                                              .operational_state
                                                                              .push_notification_token
                                                                              .userId
                                                                        : null,
                                                            };
                                                            resolve(driverRepr);
                                                        }
                                                    )
                                                    .catch((error) => {
                                                        //logger.info(error);
                                                        let driverRepr = {
                                                            eta: null,
                                                            distance: null,
                                                            status: driverData
                                                                .operational_state
                                                                .status,
                                                            driver_fingerprint:
                                                                driverData.driver_fingerprint,
                                                            driver_coordinates:
                                                                null,
                                                            prev_driver_coordinates:
                                                                null,
                                                            push_notification_token:
                                                                driverData
                                                                    .operational_state
                                                                    .push_notification_token !==
                                                                    undefined &&
                                                                driverData
                                                                    .operational_state
                                                                    .push_notification_token !==
                                                                    null
                                                                    ? driverData
                                                                          .operational_state
                                                                          .push_notification_token
                                                                          .userId
                                                                    : null,
                                                        };
                                                        resolve(driverRepr);
                                                    });
                                            }
                                        } catch (error) {
                                            //logger.info(error);
                                            //Make a fresh search
                                            new Promise((res) => {
                                                makeFreshSearch_ETA_2points(
                                                    tmp,
                                                    redisKey,
                                                    valueIndex,
                                                    collectionRelativeDistances,
                                                    driverData,
                                                    res
                                                );
                                            })
                                                .then(
                                                    (result) => {
                                                        resolve(result);
                                                    },
                                                    (error) => {
                                                        //logger.info(error);
                                                        let driverRepr = {
                                                            eta: null,
                                                            distance: null,
                                                            status: driverData
                                                                .operational_state
                                                                .status,
                                                            driver_fingerprint:
                                                                driverData.driver_fingerprint,
                                                            driver_coordinates:
                                                                null,
                                                            prev_driver_coordinates:
                                                                null,
                                                            push_notification_token:
                                                                driverData
                                                                    .operational_state
                                                                    .push_notification_token !==
                                                                    undefined &&
                                                                driverData
                                                                    .operational_state
                                                                    .push_notification_token !==
                                                                    null
                                                                    ? driverData
                                                                          .operational_state
                                                                          .push_notification_token
                                                                          .userId
                                                                    : null,
                                                        };
                                                        resolve(driverRepr);
                                                    }
                                                )
                                                .catch((error) => {
                                                    //logger.info(error);
                                                    let driverRepr = {
                                                        eta: null,
                                                        distance: null,
                                                        status: driverData
                                                            .operational_state
                                                            .status,
                                                        driver_fingerprint:
                                                            driverData.driver_fingerprint,
                                                        driver_coordinates:
                                                            null,
                                                        prev_driver_coordinates:
                                                            null,
                                                        push_notification_token:
                                                            driverData
                                                                .operational_state
                                                                .push_notification_token !==
                                                                undefined &&
                                                            driverData
                                                                .operational_state
                                                                .push_notification_token !==
                                                                null
                                                                ? driverData
                                                                      .operational_state
                                                                      .push_notification_token
                                                                      .userId
                                                                : null,
                                                    };
                                                    resolve(driverRepr);
                                                });
                                        }
                                    } //No records make a fresh search
                                    else {
                                        new Promise((res) => {
                                            makeFreshSearch_ETA_2points(
                                                tmp,
                                                redisKey,
                                                valueIndex,
                                                collectionRelativeDistances,
                                                driverData,
                                                res
                                            );
                                        })
                                            .then(
                                                (result) => {
                                                    resolve(result);
                                                },
                                                (error) => {
                                                    //logger.info(error);
                                                    let driverRepr = {
                                                        eta: null,
                                                        distance: null,
                                                        status: driverData
                                                            .operational_state
                                                            .status,
                                                        driver_fingerprint:
                                                            driverData.driver_fingerprint,
                                                        driver_coordinates:
                                                            null,
                                                        prev_driver_coordinates:
                                                            null,
                                                        push_notification_token:
                                                            driverData
                                                                .operational_state
                                                                .push_notification_token !==
                                                                undefined &&
                                                            driverData
                                                                .operational_state
                                                                .push_notification_token !==
                                                                null
                                                                ? driverData
                                                                      .operational_state
                                                                      .push_notification_token
                                                                      .userId
                                                                : null,
                                                    };
                                                    resolve(driverRepr);
                                                }
                                            )
                                            .catch((error) => {
                                                //logger.info(error);
                                                let driverRepr = {
                                                    eta: null,
                                                    distance: null,
                                                    status: driverData
                                                        .operational_state
                                                        .status,
                                                    driver_fingerprint:
                                                        driverData.driver_fingerprint,
                                                    driver_coordinates: null,
                                                    prev_driver_coordinates:
                                                        null,
                                                    push_notification_token:
                                                        driverData
                                                            .operational_state
                                                            .push_notification_token !==
                                                            undefined &&
                                                        driverData
                                                            .operational_state
                                                            .push_notification_token !==
                                                            null
                                                            ? driverData
                                                                  .operational_state
                                                                  .push_notification_token
                                                                  .userId
                                                            : null,
                                                };
                                                resolve(driverRepr);
                                            });
                                    }
                                },
                                (error) => {
                                    //logger.info(error);
                                    //Make a fresh search
                                    new Promise((res) => {
                                        makeFreshSearch_ETA_2points(
                                            tmp,
                                            redisKey,
                                            valueIndex,
                                            collectionRelativeDistances,
                                            driverData,
                                            res
                                        );
                                    })
                                        .then(
                                            (result) => {
                                                resolve(result);
                                            },
                                            (error) => {
                                                //logger.info(error);
                                                let driverRepr = {
                                                    eta: null,
                                                    distance: null,
                                                    status: driverData
                                                        .operational_state
                                                        .status,
                                                    driver_fingerprint:
                                                        driverData.driver_fingerprint,
                                                    driver_coordinates: null,
                                                    prev_driver_coordinates:
                                                        null,
                                                    push_notification_token:
                                                        driverData
                                                            .operational_state
                                                            .push_notification_token !==
                                                            undefined &&
                                                        driverData
                                                            .operational_state
                                                            .push_notification_token !==
                                                            null
                                                            ? driverData
                                                                  .operational_state
                                                                  .push_notification_token
                                                                  .userId
                                                            : null,
                                                };
                                                resolve(driverRepr);
                                            }
                                        )
                                        .catch((error) => {
                                            //logger.info(error);
                                            let driverRepr = {
                                                eta: null,
                                                distance: null,
                                                status: driverData
                                                    .operational_state.status,
                                                driver_fingerprint:
                                                    driverData.driver_fingerprint,
                                                driver_coordinates: null,
                                                prev_driver_coordinates: null,
                                                push_notification_token:
                                                    driverData.operational_state
                                                        .push_notification_token !==
                                                        undefined &&
                                                    driverData.operational_state
                                                        .push_notification_token !==
                                                        null
                                                        ? driverData
                                                              .operational_state
                                                              .push_notification_token
                                                              .userId
                                                        : null,
                                            };
                                            resolve(driverRepr);
                                        });
                                }
                            );
                        } else {
                            //! Form a driver with null values for positionning
                            let driverRepr = {
                                eta: null,
                                distance: null,
                                status: driverData.operational_state.status,
                                driver_fingerprint:
                                    driverData.driver_fingerprint,
                                driver_coordinates: null,
                                prev_driver_coordinates: null,
                                push_notification_token:
                                    driverData.operational_state
                                        .push_notification_token !==
                                        undefined &&
                                    driverData.operational_state
                                        .push_notification_token !== null
                                        ? driverData.operational_state
                                              .push_notification_token.userId
                                        : null,
                            };
                            resolve(driverRepr);
                        }
                    });
                });
                //Resolve all
                Promise.all(mainPromiser).then(
                    (result) => {
                        //Done- exlude all false
                        new Promise((res) => {
                            cleanAndAdjustRelativeDistancesList(
                                result,
                                req.list_limit,
                                res
                            );
                        }).then(
                            (reslt) => {
                                //! Cache the list for 30minutes
                                new Promise((resCacheDriversList) => {
                                    redisCluster.setex(
                                        redisKey,
                                        process.env.REDIS_EXPIRATION_5MIN * 6,
                                        stringify(reslt)
                                    );
                                    resCacheDriversList(true);
                                })
                                    .then(
                                        () => {},
                                        () => {}
                                    )
                                    .catch((error) => {
                                        //logger.info(error);
                                    });
                                //? DONE
                                resolveMother(reslt);
                            },
                            (error) => {
                                //logger.info(error);
                                resolveMother({
                                    response: 'no_close_drivers_found',
                                });
                            }
                        );
                    },
                    (error) => {
                        //logger.info(error);
                        resolveMother({ response: 'no_close_drivers_found' });
                    }
                );
            } //No close drivers
            else {
                resolveMother({ response: 'no_close_drivers_found' });
            }
        });
}

/**
 * @func makeFreshSearch_ETA_2points
 * Responsible for finding the ETA and the distance between 2 distincts points.
 * @param tmp: origin - destination pair coordinates
 * @param redisKey: the cache key where to search.
 * @param valueIndex: the value where the index was stored.
 * @param collectionRelativeDistances: the list of all the relative distances.
 * @param driverData: the driver data fetched.
 * @param resolve
 */
function makeFreshSearch_ETA_2points(
    tmp,
    redisKey,
    valueIndex,
    collectionRelativeDistances,
    driverData,
    resolve
) {
    new Promise((res) => {
        getRouteInfosDestination(tmp, res, true, {
            redisKey: redisKey,
            valueIndex: valueIndex,
        }); //Only get simplified data : ETA and distance
    }).then(
        (result) => {
            //Update the relative mongo records
            if (
                result !== false &&
                result !== undefined &&
                result.eta !== undefined
            ) {
                new Promise((res1) => {
                    let relativeHeader = {
                        user_fingerprint: req.user_fingerprint,
                        status: driverData.operational_state.status,
                        driver_fingerprint: driverData.driver_fingerprint,
                        driver_coordinates: {
                            latitude:
                                driverData.operational_state.last_location
                                    .coordinates.latitude,
                            longitude:
                                driverData.operational_state.last_location
                                    .coordinates.longitude,
                        },
                        push_notification_token:
                            driverData.push_notification_token,
                        eta: result.eta,
                        distance: result.distance,
                        city: req.city,
                        country: req.country,
                    };
                    updateRelativeDistancesRiderDrivers(
                        collectionRelativeDistances,
                        relativeHeader,
                        res1
                    );
                }).then(
                    () => {},
                    () => {}
                );
            }
            //...
            result.status = driverData.operational_state.status; //? Online or offline
            result.driver_fingerprint = driverData.driver_fingerprint; //Add the driver fingerprint to the response
            result.driver_coordinates = {
                latitude:
                    driverData.operational_state.last_location.coordinates
                        .latitude,
                longitude:
                    driverData.operational_state.last_location.coordinates
                        .longitude,
            }; //Add the driver coordinates to the response
            result.prev_driver_coordinates = {
                latitude:
                    driverData.operational_state.last_location.prev_coordinates
                        .latitude,
                longitude:
                    driverData.operational_state.last_location.prev_coordinates
                        .longitude,
            }; //Add the driver's previous coordinates to the response
            result.push_notification_token =
                driverData.operational_state.push_notification_token !== null &&
                driverData.operational_state.push_notification_token !==
                    undefined
                    ? driverData.operational_state.push_notification_token
                          .userId
                    : null; //Add push token
            resolve(result);
        },
        (error) => {
            //logger.info(error);
            let driverRepr = {
                eta: null,
                distance: null,
                status: driverData.operational_state.status,
                driver_fingerprint: driverData.driver_fingerprint,
                driver_coordinates: null,
                prev_driver_coordinates: null,
                push_notification_token:
                    driverData.operational_state.push_notification_token !==
                        undefined &&
                    driverData.operational_state.push_notification_token !==
                        null
                        ? driverData.operational_state.push_notification_token
                              .userId
                        : null,
            };
            resolve(driverRepr);
        }
    );
}

/**
 * @function getDriversProfile
 * Responsible for getting very efficiently the drivers profile, first checking from the cache.
 * @param req: the request data which MUST contain the user_fingerprint
 * @param resolve
 */
function getDriversProfile(req, resolve) {
    let redisKey = `${req.user_fingerprint}-driverProfile-cached`;

    //Check from the cache first
    redisGet(redisKey)
        .then((resp) => {
            if (resp !== null) {
                //Has some data
                try {
                    resp = JSON.parse(resp);
                    //...
                    resolve(resp);
                } catch (error) {
                    logger.error(error);
                    new Promise((resCompute) => {
                        exec_getDriversProfile(req, redisKey, resCompute);
                    })
                        .then((result) => {
                            resolve(result);
                        })
                        .catch((error) => {
                            logger.error(error);
                            resolve(false);
                        });
                }
            } //No cached data
            else {
                //Make fresh request
                new Promise((resCompute) => {
                    exec_getDriversProfile(req, redisKey, resCompute);
                })
                    .then((result) => {
                        resolve(result);
                    })
                    .catch((error) => {
                        logger.error(error);
                        resolve(false);
                    });
            }
        })
        .catch((error) => {
            //Make fresh request
            logger.error(error);
            new Promise((resCompute) => {
                exec_getDriversProfile(req, redisKey, resCompute);
            })
                .then((result) => {
                    resolve(result);
                })
                .catch((error) => {
                    logger.error(error);
                    resolve(false);
                });
        });
}

function exec_getDriversProfile(req, redisKey, resolve) {
    dynamo_find_query({
        table_name: 'drivers_shoppers_central',
        IndexName: 'driver_fingerprint',
        KeyConditionExpression: 'driver_fingerprint = :val1',
        ExpressionAttributeValues: {
            ':val1': req.user_fingerprint,
        },
    })
        .then((driverData) => {
            if (driverData !== undefined && driverData.length > 0) {
                //Found user data
                //!Cache for 5min*1440 - > 5 days
                redisCluster.setex(
                    redisKey,
                    parseInt(process.env.REDIS_EXPIRATION_5MIN) * 1440,
                    JSON.stringify(driverData[0])
                );
                //...
                resolve(driverData[0]);
            } //No user data?
            else {
                resolve(false);
            }
        })
        .catch((error) => {
            logger.error(error);
            resolve(false);
        });
}

/**
 * MAIN
 */
var collectionRidesDeliveries_data = null;
var collectionRelativeDistances = null;
var collectionDrivers_profiles = null;

redisCluster.on('connect', function () {
    logger.info('[*] Redis connected');

    //if (err) throw err;
    logger.info('[+] MAP services active.');
    app.get('/', function (req, res) {
        res.send('Map services up');
    })
        .use(
            express.json({
                limit: process.env.MAX_DATA_BANDWIDTH_EXPRESS,
                extended: true,
            })
        )
        .use(
            express.urlencoded({
                limit: process.env.MAX_DATA_BANDWIDTH_EXPRESS,
                extended: true,
            })
        )
        .use(helmet());

    /**
     * PASSENGER/DRIVER LOCATION UPDATE MANAGER
     * Responsible for updating in the databse and other caches new passenger's/rider's locations received.
     * Update CACHE -> MONGODB (-> TRIP CHECKER DISPATCHER)
     */
    app.post('/updatePassengerLocation_delivery', function (req, res) {
        new Promise((resMAIN) => {
            //DEBUG
            /*let testData = {
          latitude: -22.5704981,
          longitude: 17.0809425,
          user_fingerprint:
            "23c9d088e03653169b9c18193a0b8dd329ea1e43eb0626ef9f16b5b979694a429710561a3cb3ddae",
          user_nature: "driver",
          requestType: "scheduled",
          pushnotif_token: {
            hasNotificationPermission: true,
            isEmailSubscribed: false,
            isPushDisabled: false,
            isSubscribed: true,
            pushToken:
              "fNA8f12fQ225K3IHb4Xwdf:APA91bGQW7bJrNzOcIslIDTApTenhWaueP9QC-EJN4IM7ugZm43sJlk8jsj-lJxJN8JB70NsA5ZsDah2egABIm7L3ex-hndQiJEI-ziBggaO0se0rBI3CEE6ytpY2-USaM3yXe3HqKW9",
            userId: "a0989fbc-2ec1-4b9c-b469-881dfaa345d8",
          },
        };
        req = testData;*/
            //DEBUG
            //let params = urlParser.parse(req.url, true);
            req = req.body;

            //? Generic updates
            //? 1. Update cache for this user's location
            if (
                req !== undefined &&
                req.latitude !== undefined &&
                req.latitude !== null &&
                req.longitude !== undefined &&
                req.longitude !== null &&
                req.user_fingerprint !== null &&
                req.user_fingerprint !== undefined
            ) {
                new Promise((resolve1) => {
                    updateRiderLocationInfosCache(req, resolve1);
                })
                    .then(() => {})
                    .catch((error) => logger.error(error));
            }

            //? 2. Get the driver's profile
            new Promise((resGetDriverProfile) => {
                getDriversProfile(req, resGetDriverProfile);
            })
                .then((driverProfile) => {
                    //! Only  if the driver is online
                    if (
                        driverProfile !== false &&
                        driverProfile !== undefined &&
                        driverProfile.operational_state.status === 'online'
                    ) {
                        //?Has some data
                        //? 3. Get the rides, deliveries or shopping requests
                        //Check for any existing ride
                        new Promise((res) => {
                            logger.info(req);
                            tripChecker_Dispatcher(
                                driverProfile,
                                req.user_fingerprint,
                                'rider',
                                req.requestType !== undefined &&
                                    req.requestType !== null
                                    ? req.requestType
                                    : 'RIDE',
                                res
                            );
                        }).then(
                            (result) => {
                                //Update the rider
                                if (result !== false) {
                                    if (result != 'no_rides') {
                                        resMAIN(result);
                                    } //No rides
                                    else {
                                        resMAIN({ request_status: 'no_rides' });
                                    }
                                } //No rides
                                else {
                                    resMAIN({ request_status: 'no_rides' });
                                }
                            },
                            (error) => {
                                logger.error(error);
                                resMAIN({ request_status: 'no_rides' });
                            }
                        );
                    } //No driver profile data found
                    else {
                        resMAIN({ request_status: 'no_rides' });
                    }
                })
                .catch((error) => {
                    logger.error(error);
                    resMAIN({ request_status: 'no_rides' });
                });
        })
            .then((result) => {
                if (/driver/i.test(req.user_nature)) {
                    //?Sort the requests
                    if (result.length !== undefined && result.length > 1) {
                        //Sort only when needed - last arrival on top
                        result = result.sort((a, b) =>
                            new Date(a.ride_basic_infos.wished_pickup_time) >
                            new Date(b.ride_basic_infos.wished_pickup_time)
                                ? -1
                                : new Date(
                                      a.ride_basic_infos.wished_pickup_time
                                  ) <
                                  new Date(
                                      b.ride_basic_infos.wished_pickup_time
                                  )
                                ? 1
                                : 0
                        );

                        res.send(result);
                    } //No need to sort
                    else {
                        res.send(result);
                    }
                } //Rider send as is
                else {
                    logger.warn(result.length);
                    res.send(result);
                }
            })
            .catch((error) => {
                //logger.info(error);
                res.send({ request_status: 'no_rides' });
            });
    });

    /**
     * REVERSE GEOCODER
     * To get the exact approx. location of the user or driver.
     * REDIS propertiy
     * user_fingerprint -> currentLocationInfos: {...}
     */
    app.post('/getUserLocationInfos', function (req, res) {
        new Promise((resMAIN) => {
            let request = req.body;
            resolveDate();

            if (
                request.latitude != undefined &&
                request.latitude != null &&
                request.longitude != undefined &&
                request.longitude != null &&
                request.user_fingerprint !== null &&
                request.user_fingerprint !== undefined
            ) {
                logger.error(JSON.stringify(request.user_fingerprint));
                //Save the history of the geolocation
                new Promise((resHistory) => {
                    if (request.geolocationData !== undefined) {
                        bundleData = {
                            user_fingerprint: request.user_fingerprint,
                            gps_data: request.geolocationData,
                            date: new Date(chaineDateUTC),
                        };
                        //..
                        dynamo_insert('historical_gps_positioning', bundleData)
                            .then((result) => {
                                if (result === false) {
                                    resHistory(false);
                                }
                                //...
                                logger.info('Saved GPS data');
                                resHistory(true);
                            })
                            .catch((error) => {
                                logger.error(error);
                                resHistory(false);
                            });
                    } //No required data
                    else {
                        logger.info('No required GPS data for logs');
                        resHistory(false);
                    }
                })
                    .then()
                    .catch();

                //Hand responses
                new Promise((resolve) => {
                    reverseGeocodeUserLocation(resolve, request);
                }).then(
                    (result) => {
                        if (
                            result !== false &&
                            result !== 'false' &&
                            result !== undefined &&
                            result !== null
                        ) {
                            //? Compute the list of closest drivers of all categories to this rider
                            // new Promise((resCompute) => {
                            //   //1. Get the list of cars categories
                            //   let carsCategories = [
                            //     "normalTaxiEconomy",
                            //     "electricEconomy",
                            //     "comfortNormalRide",
                            //     "comfortElectricRide",
                            //     "luxuryNormalRide",
                            //     "luxuryElectricRide",
                            //     "electricBikes",
                            //     "bikes",
                            //     "carDelivery",
                            //     "vanDelivery",
                            //   ];
                            //   //2. Batch request
                            //   let parentPromises = carsCategories.map((cars) => {
                            //     return new Promise((resBatch) => {
                            //       //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
                            //       //? 1. Destination
                            //       //? Get temporary vars
                            //       let pickLatitude1 = parseFloat(request.latitude);
                            //       let pickLongitude1 = parseFloat(request.longitude);
                            //       //! Coordinates order fix - major bug fix for ocean bug
                            //       if (
                            //         pickLatitude1 !== undefined &&
                            //         pickLatitude1 !== null &&
                            //         pickLatitude1 !== 0 &&
                            //         pickLongitude1 !== undefined &&
                            //         pickLongitude1 !== null &&
                            //         pickLongitude1 !== 0
                            //       ) {
                            //         //? Switch latitude and longitude - check the negative sign
                            //         if (parseFloat(pickLongitude1) < 0) {
                            //           //Negative - switch
                            //           request.latitude = pickLongitude1;
                            //           request.longitude = pickLatitude1;
                            //         }
                            //       }
                            //       //! -------

                            //       let url =
                            //         `${
                            //           /production/i.test(process.env.EVIRONMENT)
                            //             ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                            //             : process.env.LOCAL_URL
                            //         }` +
                            //         ":" +
                            //         process.env.MAP_SERVICE_PORT +
                            //         "/getVitalsETAOrRouteInfos2points?user_fingerprint=" +
                            //         request.user_fingerprint +
                            //         "&org_latitude=" +
                            //         request.latitude +
                            //         "&org_longitude=" +
                            //         request.longitude +
                            //         "&ride_type=" +
                            //         cars +
                            //         "&city=" +
                            //         result.city +
                            //         "&country=" +
                            //         result.country +
                            //         "&list_limit=all";
                            //       requestAPI(url, function (error, response, body) {
                            //         if (error === null) {
                            //           try {
                            //             body = JSON.parse(body);
                            //             // logger.warn(body);
                            //             resBatch(true);
                            //           } catch (error) {
                            //             logger.error(error);
                            //             resBatch(false);
                            //           }
                            //         } else {
                            //           resBatch(false);
                            //         }
                            //       });
                            //     });
                            //   });
                            //   //? Wrap up
                            //   Promise.all(parentPromises)
                            //     .then((resultBatch) => {
                            //       logger.info(resultBatch);
                            //     })
                            //     .catch((error) => {
                            //       logger.error(error);
                            //     });
                            //   //? Done
                            //   resCompute(true);
                            // })
                            //   .then()
                            //   .catch((error) => logger.error(error));

                            //! SUPPORTED CITIES
                            let SUPPORTED_CITIES = [
                                'WINDHOEK',
                                'SWAKOPMUND',
                                'WALVIS BAY',
                            ];
                            //? Attach the supported city state
                            result['isCity_supported'] =
                                SUPPORTED_CITIES.includes(
                                    result.city !== undefined &&
                                        result.city !== null
                                        ? result.city.trim().toUpperCase()
                                        : result.name !== undefined &&
                                          result.name !== null
                                        ? result.name.trim().toUpperCase()
                                        : 'Unknown city'
                                );
                            result['isCity_supported'] = true;
                            //! Replace Samora Machel Constituency by Wanaheda
                            if (
                                result.suburb !== undefined &&
                                result.suburb !== null &&
                                /Samora Machel Constituency/i.test(
                                    result.suburb
                                )
                            ) {
                                result.suburb = 'Wanaheda';
                                resMAIN(result);
                            } else {
                                resMAIN(result);
                            }
                        } //False returned
                        else {
                            resMAIN(false);
                        }
                    },
                    (error) => {
                        logger.error(error);
                        resMAIN(false);
                    }
                );
            }
        })
            .then((result) => {
                res.send(result);
            })
            .catch((error) => {
                //logger.info(error);
                res.send(false);
            });
    });

    /**
     * PLACES IDENTIFIER
     * Route name: identifyPickupLocation
     * ? Responsible for finding out the nature of places (ge. Private locations, taxi ranks or other specific plcaes of interest)
     * This one will only focus on Pvate locations AND taxi ranks.
     * False means : not a taxirank -> private location AND another object means taxirank
     */
    app.get('/identifyPickupLocation', function (req, res) {
        new Promise((resMAIN) => {
            let params = urlParser.parse(req.url, true);
            req = params.query;
            //...
            if (
                req.latitude !== undefined &&
                req.latitude !== null &&
                req.longitude !== undefined &&
                req.longitude !== null &&
                req.user_fingerprint !== undefined &&
                req.user_fingerprint !== null
            ) {
                new Promise((res) => {
                    findoutPickupLocationNature(res, req);
                })
                    .then(
                        (result) => {
                            resMAIN(result);
                        },
                        (error) => {
                            //Default to private location on error
                            resMAIN({ locationType: 'PrivateLocation' });
                        }
                    )
                    .catch((error) => {
                        resMAIN({ locationType: 'PrivateLocation' });
                    });
            } //Default to private location - invalid params
            else {
                resMAIN({ locationType: 'PrivateLocation' });
            }
        })
            .then((result) => {
                res.send(result);
            })
            .catch((error) => {
                //logger.info(error);
                res.send({ locationType: 'PrivateLocation' });
            });
    });

    /**
     * ROUTE TO DESTINATION previewer
     * Responsible for showing to the user the preview of the first destination after selecting on the app the destination.
     */
    app.get('/getRouteToDestinationSnapshot', function (req, res) {
        new Promise((resMAIN) => {
            let params = urlParser.parse(req.url, true);
            req = params.query;
            //logger.info("here");
            //...
            if (
                req.user_fingerprint !== undefined &&
                req.org_latitude !== undefined &&
                req.org_longitude !== undefined
            ) {
                new Promise((res) => {
                    let tmp = {
                        origin: {
                            latitude: req.org_latitude,
                            longitude: req.org_longitude,
                        },
                        destination: {
                            latitude: req.dest_latitude,
                            longitude: req.dest_longitude,
                        },
                        user_fingerprint: req.user_fingerprint,
                        request_fp:
                            req.request_fp !== undefined &&
                            req.request_fp !== null
                                ? req.request_fp
                                : false,
                    };
                    findDestinationPathPreview(res, tmp);
                }).then(
                    (result) => {
                        resMAIN(result);
                    },
                    (error) => {
                        //logger.info(error);
                        resMAIN(false);
                    }
                );
            } //error
            else {
                resMAIN(false);
            }
        })
            .then((result) => {
                res.send(result);
            })
            .catch((error) => {
                //logger.info(error);
                res.send(false);
            });
    });

    /**
     * GET VITALS ETAs OR ROUTE INFOS
     * Responsible for returning the ordered list (any specified number) of all the closest online drivers IF ANY (finds Etas or route infos between 2 points natively).
     * The details of the response must inlude the drives fingerprints, the eta and the distances.
     * Drivers filter criteria: should be online, should be able to pick up, same city, same country.
     * @param user_fingerprint: the rider's fingerprint
     * @param org_latitude: rider's latitude
     * @param org_longitude: rider's longitude
     * @param city: rider's city
     * @param country: rider's country
     * @param list_limit: the number of the closest drivers to fetch, OR "all" for the full list (very important after requesting a ride or delivery) - default: 7
     * @param ride_type: RIDE or DELIVERY (depending on which scenario it is) - should match the operation clearances for the drivers
     * @param make_new: whether or not to return the cached result first (false) or the compute fresh results (true)
     * VERY IMPORTANT FOR BACH RIDER - DRIVERS MATCHING.
     * Redis key: user_fingerprint-driver-fingerprint
     * valueIndex: 'relativeEta'
     */
    app.get('/getVitalsETAOrRouteInfos2points', function (req, res) {
        new Promise((resMAIN) => {
            let params = urlParser.parse(req.url, true);
            req = params.query;
            //...
            if (
                req.user_fingerprint !== undefined &&
                req.org_latitude !== undefined &&
                req.org_longitude !== undefined &&
                req.city !== undefined &&
                req.country !== undefined &&
                req.ride_type !== undefined
            ) {
                //? Form the redis key
                let redisKey = `${req.user_fingerprint}-driversListCachedData`;
                //Check the list limit
                if (req.list_limit === undefined) {
                    req.list_limit = 7;
                }
                //! CHECK FOR CACHED RESULT FIRST IF INSTRUCTED SO
                if (
                    req.make_new !== undefined ||
                    req.make_new === 'true' ||
                    req.make_new
                ) {
                    logger.info('MAKE NEW');
                    //Get the list of drivers match the availability criteria
                    new Promise((resGetFreshList) => {
                        getFreshProximity_driversList(
                            req,
                            redisKey,
                            collectionDrivers_profiles,
                            collectionRidesDeliveries_data,
                            collectionPassengers_profiles,
                            resGetFreshList
                        );
                    })
                        .then(
                            (result) => {
                                //? DONE
                                resMAIN(result);
                            },
                            (error) => {
                                //logger.info(error);
                                resMAIN({ response: 'no_close_drivers_found' });
                            }
                        )
                        .catch((error) => {
                            //logger.info(error);
                            resMAIN({ response: 'no_close_drivers_found' });
                        });
                } //Get the cached first
                else {
                    //logger.info("Get cached first");
                    redisGet(redisKey)
                        .then(
                            (resp) => {
                                if (resp !== null) {
                                    logger.info('FOUND CACHED DRIVER LIST');
                                    //Has some cached data
                                    try {
                                        //Rehydrate the data
                                        new Promise((resGetFreshList) => {
                                            getFreshProximity_driversList(
                                                req,
                                                redisKey,
                                                collectionDrivers_profiles,
                                                collectionRidesDeliveries_data,
                                                collectionPassengers_profiles,
                                                resGetFreshList
                                            );
                                        })
                                            .then(
                                                (result) => {
                                                    //? DONE
                                                },
                                                (error) => {
                                                    //logger.info(error);
                                                }
                                            )
                                            .catch((error) => {
                                                //logger.info(error);
                                            });
                                        //...
                                        resp = parse(resp);
                                        //? Quickly respond
                                        resMAIN(resp);
                                    } catch (error) {
                                        //logger.info(error);
                                        //Get the list of drivers match the availability criteria
                                        new Promise((resGetFreshList) => {
                                            getFreshProximity_driversList(
                                                req,
                                                redisKey,
                                                collectionDrivers_profiles,
                                                collectionRidesDeliveries_data,
                                                collectionPassengers_profiles,
                                                resGetFreshList
                                            );
                                        })
                                            .then(
                                                (result) => {
                                                    //? DONE
                                                    resMAIN(result);
                                                },
                                                (error) => {
                                                    //logger.info(error);
                                                    resMAIN({
                                                        response:
                                                            'no_close_drivers_found',
                                                    });
                                                }
                                            )
                                            .catch((error) => {
                                                //logger.info(error);
                                                resMAIN({
                                                    response:
                                                        'no_close_drivers_found',
                                                });
                                            });
                                    }
                                } //No cached data - get fresh one
                                else {
                                    //Get the list of drivers match the availability criteria
                                    new Promise((resGetFreshList) => {
                                        getFreshProximity_driversList(
                                            req,
                                            redisKey,
                                            collectionDrivers_profiles,
                                            collectionRidesDeliveries_data,
                                            collectionPassengers_profiles,
                                            resGetFreshList
                                        );
                                    })
                                        .then(
                                            (result) => {
                                                //? DONE
                                                logger.warn(result);
                                                resMAIN(result);
                                            },
                                            (error) => {
                                                logger.info(error);
                                                resMAIN({
                                                    response:
                                                        'no_close_drivers_found',
                                                });
                                            }
                                        )
                                        .catch((error) => {
                                            logger.info(error);
                                            resMAIN({
                                                response:
                                                    'no_close_drivers_found',
                                            });
                                        });
                                }
                            },
                            (error) => {
                                logger.info(error);
                                //Get the list of drivers match the availability criteria
                                new Promise((resGetFreshList) => {
                                    getFreshProximity_driversList(
                                        req,
                                        redisKey,
                                        collectionDrivers_profiles,
                                        collectionRidesDeliveries_data,
                                        collectionPassengers_profiles,
                                        resGetFreshList
                                    );
                                })
                                    .then(
                                        (result) => {
                                            //? DONE
                                            resMAIN(result);
                                        },
                                        (error) => {
                                            //logger.info(error);
                                            resMAIN({
                                                response:
                                                    'no_close_drivers_found',
                                            });
                                        }
                                    )
                                    .catch((error) => {
                                        //logger.info(error);
                                        resMAIN({
                                            response: 'no_close_drivers_found',
                                        });
                                    });
                            }
                        )
                        .catch((error) => {
                            //logger.info(error);
                            //Get the list of drivers match the availability criteria
                            new Promise((resGetFreshList) => {
                                getFreshProximity_driversList(
                                    req,
                                    redisKey,
                                    collectionDrivers_profiles,
                                    collectionRidesDeliveries_data,
                                    collectionPassengers_profiles,
                                    resGetFreshList
                                );
                            })
                                .then(
                                    (result) => {
                                        //? DONE
                                        resMAIN(result);
                                    },
                                    (error) => {
                                        //logger.info(error);
                                        resMAIN({
                                            response: 'no_close_drivers_found',
                                        });
                                    }
                                )
                                .catch((error) => {
                                    //logger.info(error);
                                    resMAIN({
                                        response: 'no_close_drivers_found',
                                    });
                                });
                        });
                }
            } else {
                resMAIN({ response: 'no_close_drivers_found' });
            }
        })
            .then((result) => {
                res.send(result);
            })
            .catch((error) => {
                //logger.info(error);
                res.send({ response: 'no_close_drivers_found' });
            });
    });

    /**
     * PROVIDE REALTIME ROUTE TRACKING DATA
     * Responsible for computing, caching and delivering real-time tracking information from  point A to a point B.
     * Include the direction intructions.
     * @param user_fingerprint: the user's fingerprint.
     * @param request_fp: the request fingerprint or unique identifiyer of the operation that requires the active tracking.
     * @param org_latitude: latitude of the origin point
     * @param org_longitude: longitude of the origin point
     * @param dest_latitude: latitude of the destination point.
     * @param dest_longitude: longitude of the destination point.
     * Redis key format: realtime-tracking-operation-user_fingerprint-request_fp
     */
    app.get('/getRealtimeTrackingRoute_forTHIS', function (req, res) {
        new Promise((resMAIN) => {
            let params = urlParser.parse(req.url, true);
            req = params.query;

            if (
                req.user_fingerprint !== undefined &&
                req.user_fingerprint !== null &&
                req.request_fp !== undefined &&
                req.request_fp !== null &&
                req.org_latitude !== undefined &&
                req.org_latitude !== null &&
                req.org_longitude !== undefined &&
                req.org_longitude !== null &&
                req.dest_latitude !== undefined &&
                req.dest_latitude !== null
            ) {
                //Valid format
                //Create the redis key
                let redisKey =
                    'realtime-tracking-operation-' +
                    req.user_fingerprint +
                    '-' +
                    req.request_fp;
                //Get the cached data first if any
                redisGet(redisKey).then(
                    (resp) => {
                        if (resp !== null) {
                            //Has a previous recordd
                            try {
                                //Update the old cache
                                new Promise((res0) => {
                                    getRouteInfosDestination(
                                        {
                                            passenger: {
                                                latitude: req.org_latitude,
                                                longitude: req.org_longitude,
                                            },
                                            destination: {
                                                latitude: req.dest_latitude,
                                                longitude: req.dest_longitude,
                                            },
                                            setIntructions: true,
                                        },
                                        res0,
                                        false,
                                        false
                                    );
                                }).then(
                                    (result) => {
                                        //Update cache if the result is not fallsee
                                        if (result !== false) {
                                            redisCluster.setex(
                                                redisKey,
                                                process.env
                                                    .REDIS_EXPIRATION_5MIN,
                                                JSON.stringify(result)
                                            );
                                        }
                                    },
                                    (error) => {
                                        //logger.info(error);
                                    }
                                );
                                //.....
                                resp = JSON.parse(resp);
                                //logger.info("Found realtime REDIS record!");
                                //Quickly return data
                                resMAIN(resp);
                            } catch (error) {
                                //logger.info(error);
                                //Error - make a fresh search
                                new Promise((res0) => {
                                    getRouteInfosDestination(
                                        {
                                            passenger: {
                                                latitude: req.org_latitude,
                                                longitude: req.org_longitude,
                                            },
                                            destination: {
                                                latitude: req.dest_latitude,
                                                longitude: req.dest_longitude,
                                            },
                                            setIntructions: true,
                                        },
                                        res0,
                                        false,
                                        false
                                    );
                                }).then(
                                    (result) => {
                                        //Update cache if the result is not fallsee
                                        if (result !== false) {
                                            redisCluster.setex(
                                                redisKey,
                                                process.env
                                                    .REDIS_EXPIRATION_5MIN,
                                                JSON.stringify(result)
                                            );
                                            //...
                                            resMAIN(result);
                                        } //Error
                                        else {
                                            resMAIN(false);
                                        }
                                    },
                                    (error) => {
                                        //logger.info(error);
                                        //...
                                        resMAIN(false);
                                    }
                                );
                            }
                        } //No previous record - make a fresh search
                        else {
                            new Promise((res0) => {
                                getRouteInfosDestination(
                                    {
                                        passenger: {
                                            latitude: req.org_latitude,
                                            longitude: req.org_longitude,
                                        },
                                        destination: {
                                            latitude: req.dest_latitude,
                                            longitude: req.dest_longitude,
                                        },
                                        setIntructions: true,
                                    },
                                    res0,
                                    false,
                                    false
                                );
                            }).then(
                                (result) => {
                                    //Update cache if the result is not fallsee
                                    if (result !== false) {
                                        redisCluster.setex(
                                            redisKey,
                                            process.env.REDIS_EXPIRATION_5MIN,
                                            JSON.stringify(result)
                                        );
                                        //...
                                        resMAIN(result);
                                    } //Error
                                    else {
                                        resMAIN(false);
                                    }
                                },
                                (error) => {
                                    //logger.info(error);
                                    //...
                                    resMAIN(false);
                                }
                            );
                        }
                    },
                    (error) => {
                        //logger.info(error);
                        //Error - make a fresh search
                        new Promise((res0) => {
                            getRouteInfosDestination(
                                {
                                    passenger: {
                                        latitude: req.org_latitude,
                                        longitude: req.org_longitude,
                                    },
                                    destination: {
                                        latitude: req.dest_latitude,
                                        longitude: req.dest_longitude,
                                    },
                                    setIntructions: true,
                                },
                                res0,
                                false,
                                false
                            );
                        }).then(
                            (result) => {
                                //Update cache if the result is not fallsee
                                if (result !== false) {
                                    redisCluster.setex(
                                        redisKey,
                                        process.env.REDIS_EXPIRATION_5MIN,
                                        JSON.stringify(result)
                                    );
                                    //...
                                    resMAIN(result);
                                } //Error
                                else {
                                    resMAIN(false);
                                }
                            },
                            (error) => {
                                //logger.info(error);
                                //...
                                resMAIN(false);
                            }
                        );
                    }
                );
            } //Invalid data
            else {
                resMAIN(false);
            }
        })
            .then((result) => {
                res.send(result);
            })
            .catch((error) => {
                //logger.info(error);
                res.send(false);
            });
    });

    /**
     * GET THE NECESSARY INFOS FOR ONLY THE SHARED TRIPS.
     * Responsible for retrieving data about any shared trips from one user to one or many others.
     * @param sharedTo_user_fingerprint: the fingerprint of the user to which the request was shared to.
     * @param trip_simplified_id: the simplified request fp of the ride.
     * ! Can only share rides for now.
     */
    app.get('/getSharedTrip_information', function (req, res) {
        resolveDate();
        let params = urlParser.parse(req.url, true);
        req = params.query;

        if (
            req.sharedTo_user_fingerprint !== undefined &&
            req.sharedTo_user_fingerprint !== null &&
            req.trip_simplified_id !== undefined &&
            req.trip_simplified_id !== null
        ) {
            let timeTaken = new Date();
            timeTaken = timeTaken.getTime();
            //Get the user fingerprint of the owner of this ride as long as it is still active
            dynamo_find_query({
                table_name: 'rides_deliveries_requests',
                IndexName: 'trip_simplified_id',
                KeyConditionExpression: 'trip_simplified_id = :val1',
                ExpressionAttributeValues: {
                    ':val1': req.trip_simplified_id,
                },
            })
                .then((parentTripDetails) => {
                    if (
                        parentTripDetails !== undefined &&
                        parentTripDetails !== null &&
                        parentTripDetails.length > 0
                    ) {
                        //There's a trip in progress
                        //Save the event of an external user getting the trip infos and all the corresponding data
                        let eventBundle = {
                            sharedTo_user_fingerprint:
                                req.sharedTo_user_fingerprint,
                            trip_simplified_id: req.trip_simplified_id,
                            owner_rider_fingerprint:
                                parentTripDetails[0].client_id,
                            request_fp: parentTripDetails[0].request_fp,
                            response_got: null, //The response of the request.
                            date_captured: new Date(chaineDateUTC),
                        };
                        //Check for any existing ride
                        new Promise((res) => {
                            ////logger.info("fetching data");
                            tripChecker_Dispatcher(
                                true,
                                collectionRidesDeliveries_data,
                                collectionDrivers_profiles,
                                collectionPassengers_profiles,
                                parentTripDetails[0].client_id,
                                'rider',
                                'rides',
                                res
                            );
                        }).then(
                            (result) => {
                                let doneTime = new Date();
                                timeTaken = doneTime.getTime() - timeTaken;
                                ////logger.info("[" + chaineDateUTC + "] Compute and dispatch time (trip) ------>  " + timeTaken + " ms");
                                //Save the shared result event
                                new Promise((resSharedEvent) => {
                                    //Complete the event bundle with the response of the request
                                    eventBundle.response_got = result;
                                    dynamo_insert('global_events', eventBundle)
                                        .then((result) => {
                                            resSharedEvent(result);
                                        })
                                        .catch((error) => {
                                            logger.error(error);
                                            resSharedEvent(false);
                                        });
                                }).then(
                                    () => {
                                        //logger.info("Save the shared ride event");
                                    },
                                    () => {}
                                );
                                //Update the rider
                                if (
                                    result !== null &&
                                    result !== undefined &&
                                    result !== false
                                ) {
                                    if (result != 'no_rides') {
                                        //!Get the sender's details and attach it the to response
                                        dynamo_find_query({
                                            table_name: 'passengers_profiles',
                                            IndexName: 'user_fingerprint',
                                            KeyConditionExpression:
                                                'user_fingerprint = :val1',
                                            ExpressionAttributeValues: {
                                                ':val1':
                                                    parentTripDetails[0]
                                                        .client_id,
                                            },
                                        })
                                            .then((riderTripOwner) => {
                                                if (
                                                    riderTripOwner.length > 0 &&
                                                    riderTripOwner[0]
                                                        .user_fingerprint !==
                                                        undefined
                                                ) {
                                                    //Found the owner of the ride
                                                    let ownerInfoBundle = {
                                                        name: riderTripOwner[0]
                                                            .name,
                                                        profile_picture: `${process.env.AWS_S3_RIDERS_PROFILE_PICTURES_PATH}/${riderTripOwner[0].media.profile_picture}`,
                                                    };
                                                    //? attach to the global trip details AND the success status
                                                    result[
                                                        'riderOwnerInfoBundle'
                                                    ] = ownerInfoBundle;
                                                    result['responsePass'] =
                                                        'success';
                                                    //! Remove the driver's phone number and the car plate number
                                                    if (
                                                        result.driverDetails !==
                                                            undefined &&
                                                        result.driverDetails
                                                            .phone_number !==
                                                            undefined
                                                    ) {
                                                        result.driverDetails.phone_number =
                                                            null;
                                                        result.driverDetails.plate_number =
                                                            null;
                                                        res.send(result);
                                                    } //No relevant details
                                                    else {
                                                        res.send(result);
                                                    }
                                                } //Stange - no ride owner linked to this ride
                                                else {
                                                    res.send({
                                                        request_status:
                                                            'no_rides',
                                                    });
                                                }
                                            })
                                            .catch((error) => {
                                                logger.error(error);
                                                res.send({
                                                    request_status: 'no_rides',
                                                });
                                            });
                                    } //No rides
                                    else {
                                        res.send({
                                            request_status: 'no_rides',
                                        });
                                    }
                                } //No rides
                                else {
                                    res.send({ request_status: 'no_rides' });
                                }
                            },
                            (error) => {
                                logger.error(error);
                                res.send({ request_status: 'no_rides' });
                            }
                        );
                    } //No rides in progress
                    else {
                        res.send({ request_status: 'no_rides' });
                    }
                })
                .catch((error) => {
                    logger.error(error);
                    res.send({ request_status: 'no_rides' });
                });
        } //Invalid data
        else {
            res.send({ response: 'error_invalid_data', flag: false });
        }
    });

    /**
     * SIMULATION
     * Responsible for managing different map or any services simulation scenarios from the simulation tool.
     * Scenarios:
     * 1. MAP
     * -Pickup simulation
     * -Drop off sumlation
     */
    //Origin coords - driver
    //const blon = 17.099327;
    //const blat = -22.579195;
    //const blon = 17.060507;
    //const blat = -22.514987;
    //Destination coords
    //const destinationLat = -22.577673;
    //const destinationLon = 17.086427;

    //1. Pickup simulation
    /*socket.on("startPickupSim", function (req) {
    logToSimulator(socket, "Pickup simulation successfully started.");
    let bundle = {
      driver: { latitude: blat, longitude: blon },
      passenger: {
        latitude: this.state.latitude,
        longitude: this.state.longitude,
      },
      destination: {
        latitude: destinationLat,
        longitude: destinationLon,
      },
    };
    });*/
});
server.listen(process.env.MAP_SERVICE_DELIVERY);
//dash.monitor({ server: server });
