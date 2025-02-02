require('dotenv').config();
//require("newrelic");
var express = require('express');
const http = require('http');
const fs = require('fs');

const { logger } = require('./LogService');
const { v4: uuidv4 } = require('uuid');

var app = express();
var server = http.createServer(app);
const requestAPI = require('request');
//---center
const { promisify, inspect } = require('util');
const Redis = require('./Utility/redisConnector');
const client = null;
var RedisClustr = require('redis-clustr');
var redisCluster = client;
const redisGet = null;

//! Attach DynamoDB helper
const {
    dynamo_insert,
    dynamo_insert_many,
    dynamo_update,
    dynamo_find_query,
    dynamo_get_all,
} = require('./DynamoServiceManager');
//....
var fastFilter = require('fast-filter');
const escapeStringRegexp = require('escape-string-regexp');
var otpGenerator = require('otp-generator');
const urlParser = require('url');
const moment = require('moment');
const { default: axios } = require('axios');
const LocationPersistModel = require('./models/LocationPersistModel');
const EnrichedLocationPersistModel = require('./models/EnrichedLocationPersistModel');

const cities_center = {
    windhoek: '-22.558926,17.073211', //Conventional center on which to biais the search results
    swakopmund: '-22.6507972303997,14.582524465837887',
};

const conventionalSearchRadius = 8000000; //The radius in which to focus the search;

//GLOBALS
const _CITY = 'Windhoek';
const _COUNTRY = 'Namibia';
const _MINIMAL_SEARCH_CACHED_RESULTS_TOLERANCE = 5; //Cached result for search must have at least X results, otherwise launch a new search
const _LIMIT_LOCATION_SEARCH_RESULTS = 50; //Limit of the search result from the MAP API
let dateObject;
let chaineDateUTC;

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

function logObject(obj) {
    logger.info(
        inspect(obj, {
            maxArrayLength: null,
            depth: null,
            showHidden: true,
            colors: true,
        })
    );
}

function getCityCenter(city, res) {
    city = city.toLowerCase().trim();
    let cityCenter = cities_center[city];
    return cityCenter;
}

const checkName = (name, str) => {
    var pattern = str
        .split('')
        .map((x) => {
            return `(?=.*${x})`;
        })
        .join('');
    var regex = new RegExp(`${pattern}`, 'g');
    return name.match(regex);
};

function similarityCheck_locations_search(arrayLocations, query, res) {
    //logObject(arrayLocations);
    if (arrayLocations.length > 0) {
        arrayLocations = fastFilter(arrayLocations, function (element) {
            if (
                element.location_name != undefined &&
                element.location_name != false
            ) {
                return (
                    element.location_name
                        .toLowerCase()
                        .includes(query.toLowerCase().trim()) ||
                    checkName(
                        element.location_name.toLowerCase(),
                        query.toLowerCase()
                    )
                );
            } else {
                return false;
            }
        });
        //..
        logger.info(arrayLocations);
        if (arrayLocations.length > 0) {
            res(arrayLocations.sort());
        } //Empty
        else {
            res(false);
        }
    } else {
        res(false);
    }
}

/**
 * @func newLoaction_search_engine
 * Responsible for performing new location seearches based on some specific keywords.
 * @param {*} keyREDIS: to save the global final result for 2 days
 * @param {*} queryOR
 * @param {*} city
 * @param {*} cityCenter
 * @param {*} res
 * @param {*} timestamp
 * @param {*} trailingData: will contain the full data needed coming from the user request
 */

const newLoaction_search_engine = async (
    keyREDIS,
    queryOR,
    city,
    timestamp,
    trailingData
) => {
    //? 1. Check if it was written in dynamo
    const previousSearch = await LocationPersistModel.query('query')
        .eq(queryOR)
        .filter('city')
        .eq(city)
        .filter('state')
        .eq(trailingData.state.replace(/ Region/i, '').trim())
        .exec();

    if (previousSearch.count > 0) {
        logger.warn('FOUND SOME DYNAMO RECORDS');
        logger.info(previousSearch);

        const finalSearchResults = {
            search_timestamp: timestamp,
            result: removeResults_duplicates(previousSearch).slice(0, 5),
        };

        //?Cache
        Redis.set(
            keyREDIS,
            JSON.stringify(finalSearchResults),
            'EX',
            3600 * 48
        );

        return finalSearchResults;
    } //Fresh search
    else {
        logger.warn('NO DYNAMO RECORDS< MAKE A FRESH SEARCH');

        const finalSearchResults = await initializeFreshGetOfLocations(
            queryOR,
            city,
            timestamp,
            trailingData
        );

        //?Cache
        Redis.set(
            keyREDIS,
            JSON.stringify(finalSearchResults),
            'EX',
            3600 * 48
        );

        return finalSearchResults;
    }
};

/**
 * @func initializeFreshGetOfLocations
 * Responsible for launching the request for fresh locations from Google
 * @param {*} keyREDIS: to save the global final result for 2 days
 * @param {*} queryOR
 * @param {*} city
 * @param {*} cityCenter
 * @param {*} res
 * @param {*} timestamp
 * @param {*} trailingData: will contain the full data needed coming from the user request
 */
const initializeFreshGetOfLocations = async (
    queryOR,
    city,
    timestamp,
    trailingData
) => {
    try {
        const query = encodeURIComponent(queryOR.toLowerCase());

        //TODO: could allocate the country dynamically for scale.
        let urlRequest = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${query}&key=${process.env.GOOGLE_API_KEY}&components=country:na&language=en&radius=${conventionalSearchRadius}&limit=1000`;

        const searches = await axios.get(urlRequest);

        const body = searches?.data;

        if (body?.predictions && body?.predictions?.length > 0) {
            let searchResults = (
                await Promise.all(
                    body.predictions.map(async (locationPlace, index) => {
                        let averageGeo = 0;
                        //? Deduct the street, city and country
                        let locationName =
                            locationPlace.structured_formatting.main_text;
                        //Get the street city and country infos
                        let secondaryDetailsCombo = locationPlace
                            ?.structured_formatting?.secondary_text
                            ? locationPlace.structured_formatting.secondary_text.split(
                                  ', '
                              )
                            : 'none'; //Will contain the street, city and country respectively
                        let streetName =
                            secondaryDetailsCombo !== false
                                ? secondaryDetailsCombo.length >= 3
                                    ? secondaryDetailsCombo[
                                          secondaryDetailsCombo.length - 3
                                      ]
                                    : locationPlace?.structured_formatting
                                          ?.secondary_text
                                : locationPlace?.structured_formatting
                                      ?.secondary_text;
                        //city
                        let cityName =
                            secondaryDetailsCombo !== false
                                ? secondaryDetailsCombo.length >= 2
                                    ? secondaryDetailsCombo[
                                          secondaryDetailsCombo.length - 2
                                      ]
                                    : 'none'
                                : 'none';
                        //Country
                        let countryName =
                            secondaryDetailsCombo !== false
                                ? secondaryDetailsCombo.length >= 1
                                    ? secondaryDetailsCombo[
                                          secondaryDetailsCombo.length - 1
                                      ]
                                    : 'none'
                                : 'none';

                        //...
                        let littlePack = {
                            indexSearch: index,
                            location_id: locationPlace.place_id,
                            location_name: locationName,
                            coordinates: null, //To be completed!
                            averageGeo: averageGeo,
                            city: cityName,
                            street: streetName,
                            state: null, //To be completed!
                            country: countryName,
                            query: queryOR,
                        };
                        //! Get the coordinates and save them in dynamo - to save on cost
                        const littlePackAndCoords =
                            await attachCoordinatesAndRegion(littlePack);

                        return littlePackAndCoords;
                    })
                )
            )
                .filter((item) => item !== false && item !== null)
                .filter((item) => {
                    //? Remove all the out of context cities
                    //! 1. Filter by town only for Windhoek in the Khomas region
                    if (
                        /windhoek/i.test(city.trim()) &&
                        /khomas/i.test(
                            trailingData.state.replace(/ Region/i, '').trim()
                        )
                    ) {
                        //Khomas region
                        logger.info('KHOMAS');
                        let regFilterCity = new RegExp(city.trim(), 'i');
                        return item.city !== false && item.city !== undefined
                            ? regFilterCity.test(item.city.trim())
                            : false;
                    } //Other regions
                    else {
                        logger.error(val);
                        let regFilterState = new RegExp(
                            trailingData.state.trim(),
                            'i'
                        );
                        return item.state !== false && item.state !== undefined
                            ? regFilterState.test(item.state.trim())
                            : false;
                    }
                });

            console.log(searchResults);

            //Persist
            // await Promise.all(
            //   searchResults.map(async (location) =>
            //     LocationPersistModel.create({
            //       id: uuidv4(),
            //       ...location,
            //     })
            //   )
            // );

            const finalResults = {
                search_timestamp: timestamp,
                result: removeResults_duplicates(searchResults).slice(0, 5),
            };

            return finalResults;
        } else {
            return false;
        }
    } catch (error) {
        console.error(error);
        return false;
    }
};

/**
 * @func arrangeAndExtractSuburbAndStateOrMore
 * Responsible for handling the complex regex and operations of getting the state and suburb
 * from a raw google response and returning a dico of the wanted values.
 * @param body: a copy of the google response.
 * @param location_name: for suburbs exception
 */
function arrangeAndExtractSuburbAndStateOrMore(body, location_name) {
    //Coords
    let coordinates = [
        body.result.geometry.location.lat,
        body.result.geometry.location.lng,
    ];

    //State
    let state =
        body.result.address_components.filter((item) =>
            item.types.includes('administrative_area_level_1')
        )[0] !== undefined &&
        body.result.address_components.filter((item) =>
            item.types.includes('administrative_area_level_1')
        )[0] !== null
            ? body.result.address_components
                  .filter((item) =>
                      item.types.includes('administrative_area_level_1')
                  )[0]
                  .short_name.replace(' Region', '')
            : false;

    //DONE
    return {
        coordinates: coordinates,
        state: state,
    };
}

/**
 * @func applySuburbsExceptions
 * Responsible for applying suburb exception to some locations only if neccessary.
 * @param location_name: the current location name
 * @param suburb: the current suburb
 */
function applySuburbsExceptions(location_name, suburb) {
    //!EXCEPTIONS SUBURBS
    //! 1. Make suburb Elisenheim if anything related to it (Eg. location_name)
    suburb = /Elisenheim/i.test(location_name) ? 'Elisenheim' : suburb;
    //! 2. Make suburb Ausspannplatz if anything related to it
    suburb = /Ausspannplatz/i.test(location_name) ? 'Ausspannplatz' : suburb;
    //! 3. Make suburb Brakwater if anything related to it
    suburb = /Brakwater/i.test(location_name) ? 'Brakwater' : suburb;

    //! Add /CBD for Windhoek Central suburb
    suburb =
        suburb !== false &&
        suburb !== undefined &&
        /^Windhoek Central$/i.test(suburb)
            ? `${suburb} / CBD`
            : suburb;

    //DONE
    return suburb;
}

/**
 * @func attachCoordinatesAndRegion
 * Responsible as the name indicates of addiing the coordinates of the location and the region.
 * @param littlePack: the incomplete location to complete
 * @param resolve
 */
const attachCoordinatesAndRegion = async (littlePack) => {
    //? Check if its wasn't cached before
    let redisKey = `${littlePack.location_id}-coordinatesAndRegion`;

    const cachedData = await Redis.get(redisKey);

    if (
        cachedData &&
        cachedData !== 'false' &&
        JSON.parse(cachedData)?.result?.geometry
    ) {
        const cachedProcessed = JSON.parse(cachedData);
        logger.warn('Using cached coordinates and region');
        //Has a previous record
        let refinedExtractions = arrangeAndExtractSuburbAndStateOrMore(
            cachedProcessed,
            littlePack.location_name
        );
        let coordinates = refinedExtractions.coordinates;
        let state = refinedExtractions.state;
        //...
        littlePack.coordinates = coordinates;
        littlePack.state = state;
        littlePack.suburb = false;
        return littlePack;
    }

    //? Check if it was written in dynamo
    const previousSearches = await LocationPersistModel.query('query')
        .eq(littlePack.query)
        .filter('location_id')
        .eq(littlePack.location_id)
        .exec();

    if (previousSearches.count > 0 && previousSearches[0]?.result?.geometry) {
        //Found
        const previousData = previousSearches[0];
        //Has a previous record
        let refinedExtractions = arrangeAndExtractSuburbAndStateOrMore(
            previousData,
            littlePack.location_name
        );
        let coordinates = refinedExtractions.coordinates;
        let state = refinedExtractions.state;
        //...
        littlePack.coordinates = coordinates;
        littlePack.state = state;
        littlePack.suburb = 'false';

        const peristedLocation = await LocationPersistModel.create({
            id: uuidv4(),
            ...littlePack,
        });

        Redis.set(redisKey, JSON.stringify(peristedLocation), 'EX', 3600 * 48);

        return littlePack;
    } //Never peristed
    else {
        console.log('Get fresh data -> doFreshGoogleSearchAndReturn');
        const results = await doFreshGoogleSearchAndReturn(
            littlePack,
            redisKey
        );

        Redis.set(redisKey, JSON.stringify(results), 'EX', 3600 * 48);

        return results;
    }
};

/**
 * @func doFreshGoogleSearchAndReturn
 * Responsible for doing a clean google maps search, save the value in mongo, cache it and return an updated object.
 */
const doFreshGoogleSearchAndReturn = async (littlePack, redisKey) => {
    let urlRequest = `https://maps.googleapis.com/maps/api/place/details/json?placeid=${littlePack.location_id}&key=${process.env.GOOGLE_API_KEY}&fields=formatted_address,address_components,geometry,place_id&language=en`;

    try {
        //Check if an enriched location was saved
        const enrichedLocation = await EnrichedLocationPersistModel.query(
            'place_id'
        )
            .eq(littlePack.location_id)
            .exec();

        if (
            enrichedLocation.count > 0 &&
            enrichedLocation[0]?.result?.geometry
        ) {
            const enrichedLocationData = enrichedLocation[0];
            let refinedExtractions = arrangeAndExtractSuburbAndStateOrMore(
                enrichedLocationData,
                littlePack.location_name
            );
            let coordinates = refinedExtractions.coordinates;
            let state = refinedExtractions.state;
            //...
            littlePack.coordinates = coordinates;
            littlePack.state = state;
            littlePack.suburb = 'false';

            await LocationPersistModel.create({
                id: uuidv4(),
                ...littlePack,
            });
            return littlePack;
        } else {
            const results = await axios.get(urlRequest);

            const body = results?.data;

            if (body?.result?.address_components && body?.result?.geometry) {
                let refinedExtractions = arrangeAndExtractSuburbAndStateOrMore(
                    body,
                    littlePack.location_name
                );
                let coordinates = refinedExtractions.coordinates;
                let state = refinedExtractions.state;
                //...
                littlePack.coordinates = coordinates;
                littlePack.state = state;
                littlePack.suburb = 'false';

                await EnrichedLocationPersistModel.create({
                    id: uuidv4(),
                    place_id: littlePack.location_id,
                    ...body,
                });
                return littlePack;
            } //Invalid data
            else {
                return false;
            }
        }
    } catch (error) {
        logger.warn(error);
        return false;
    }
};

function removeResults_duplicates(arrayResults) {
    //logger.info(arrayResults);
    let arrayResultsClean = [];
    let arrayIds = [];
    arrayResults.map((location) => {
        let tmpId =
            location.location_name +
            ' ' +
            location.city +
            ' ' +
            location.street +
            ' ' +
            location.country;
        if (!arrayIds.includes(tmpId)) {
            //New location
            arrayIds.push(tmpId);
            arrayResultsClean.push(location);
        }
    });
    return arrayResultsClean;
}

/**
 * @func getLocationList_five
 * Responsible for getting the list of the 5 most accurate locations based on some keywords.
 * It should consider the city and country from where the search was made.
 * @param {*} queryOR
 * @param {*} city
 * @param {*} country
 * @param {*} cityCenter
 * @param {*} res
 * @param {*} timestamp
 * @param {*} trailingData: will contain the full data needed coming from the user request
 */

const getLocationList_five = async (
    queryOR,
    city,
    country,
    timestamp,
    trailingData
) => {
    resolveDate();
    //Check if cached results are available
    let keyREDIS = `search_locations-${city.trim().toLowerCase()}-${country
        .trim()
        .toLowerCase()}-${queryOR}-${trailingData.state}`; //! Added time for debug

    const cachedData = await Redis.get(keyREDIS);

    if (cachedData && JSON.parse(cachedData)?.result) {
        if (JSON.parse(cachedData)?.result.length > 0) {
            const cachedProcessed = JSON.parse(cachedData);
            //Exceptions check
            cachedProcessed.result = cachedProcessed.result.map((location) => {
                location.suburb = applySuburbsExceptions(
                    location.location_name,
                    location.suburb
                );
                return location;
            });
            //!Update search record time
            cachedProcessed.search_timestamp = timestamp;
            return cachedProcessed;
        }
    }

    //? 1. Check if it was written in dynamo
    const previousSearch = await LocationPersistModel.query('query')
        .eq(queryOR)
        .filter('city')
        .eq(city)
        .filter('state')
        .eq(trailingData.state.replace(/ Region/i, '').trim())
        .exec();

    console.log(previousSearch);

    if (previousSearch.count > 0) {
        const finalSearchResults = {
            search_timestamp: timestamp,
            result: removeResults_duplicates(previousSearch).slice(0, 5),
        };

        //?Cache
        Redis.set(
            keyREDIS,
            JSON.stringify(finalSearchResults),
            'EX',
            3600 * 48
        );

        return finalSearchResults;
    } //Fresh search
    else {
        logger.warn('NO DYNAMO RECORDS< MAKE A FRESH SEARCH');

        const finalSearchResults = await initializeFreshGetOfLocations(
            queryOR,
            city,
            timestamp,
            trailingData
        );

        //?Cache
        Redis.set(
            keyREDIS,
            JSON.stringify(finalSearchResults),
            'EX',
            3600 * 48
        );

        return finalSearchResults;
    }
};

/**
 * @func brieflyCompleteEssentialsForLocations
 * Responsible for briefly completing the essentials like the suburb and state (if any) for the given location.
 * @param coordinates: {latitude:***, longitude:***}
 * @param location_name: the location name
 * @param city: the city
 * @param resolve
 */
function brieflyCompleteEssentialsForLocations(
    coordinates,
    location_name,
    city,
    resolve
) {
    let redisKey = `${JSON.stringify(
        coordinates
    )}-${location_name}-${city}`.replace(/ /g, '_');
    logger.info(redisKey);

    //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
    //? 1. Destination
    //? Get temporary vars
    let pickLatitude1 = parseFloat(coordinates.latitude);
    let pickLongitude1 = parseFloat(coordinates.longitude);
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
            coordinates.latitude = pickLongitude1;
            coordinates.longitude = pickLatitude1;
        }
    }
    //! -------

    //? Check if there are any cached result
    redisGet(redisKey)
        .then((resp) => {
            logger.error(resp);
            if (resp !== null) {
                //Has some results
                try {
                    resp = JSON.parse(resp);

                    if (
                        resp.suburb !== false &&
                        resp.suburb !== 'false' &&
                        resp.suburb !== undefined &&
                        resp.suburb !== null &&
                        resp.state !== false &&
                        resp.state !== 'false' &&
                        resp.state !== undefined &&
                        resp.state !== null
                    ) {
                        logger.warn(
                            'Found some cached records for the suburbs autcomplete.'
                        );
                        //? Quickly return
                        resolve(resp);
                    } //Make a clean search
                    else {
                        logger.warn(
                            'Found a porblem with the cached values, making a clean search!'
                        );
                        new Promise((resCompute) => {
                            execBrieflyCompleteEssentialsForLocations(
                                coordinates,
                                location_name,
                                city,
                                resCompute
                            );
                        })
                            .then((result) => {
                                //! Cache if relevant
                                new Promise((resCache) => {
                                    if (
                                        result.suburb !== false &&
                                        result.suburb !== 'false' &&
                                        result.suburb !== undefined &&
                                        result.suburb !== null &&
                                        result.state !== false &&
                                        result.state !== 'false' &&
                                        result.state !== undefined &&
                                        result.state !== null
                                    ) {
                                        redisCluster.setex(
                                            redisKey,
                                            300 * 864,
                                            JSON.stringify(result)
                                        );
                                        resCache(true);
                                    } else {
                                        resCache(false);
                                    }
                                })
                                    .then()
                                    .catch();
                                //!----

                                resolve(result);
                            })
                            .catch((error) => {
                                logger.error(error);
                                resolve({
                                    coordinates: coordinates,
                                    state: false,
                                    suburb: false,
                                });
                            });
                    }
                } catch (error) {
                    logger.error(error);
                    new Promise((resCompute) => {
                        execBrieflyCompleteEssentialsForLocations(
                            coordinates,
                            location_name,
                            city,
                            resCompute
                        );
                    })
                        .then((result) => {
                            //! Cache if relevant
                            new Promise((resCache) => {
                                if (
                                    result.suburb !== false &&
                                    result.suburb !== 'false' &&
                                    result.suburb !== undefined &&
                                    result.suburb !== null &&
                                    result.state !== false &&
                                    result.state !== 'false' &&
                                    result.state !== undefined &&
                                    result.state !== null
                                ) {
                                    redisCluster.setex(
                                        redisKey,
                                        300 * 864,
                                        JSON.stringify(result)
                                    );
                                    resCache(true);
                                } else {
                                    resCache(false);
                                }
                            })
                                .then()
                                .catch();
                            //!----

                            resolve(result);
                        })
                        .catch((error) => {
                            logger.error(error);
                            resolve({
                                coordinates: coordinates,
                                state: false,
                                suburb: false,
                            });
                        });
                }
            } //No cached results
            else {
                new Promise((resCompute) => {
                    execBrieflyCompleteEssentialsForLocations(
                        coordinates,
                        location_name,
                        city,
                        resCompute
                    );
                })
                    .then((result) => {
                        //! Cache if relevant
                        new Promise((resCache) => {
                            if (
                                result.suburb !== false &&
                                result.suburb !== 'false' &&
                                result.suburb !== undefined &&
                                result.suburb !== null &&
                                result.state !== false &&
                                result.state !== 'false' &&
                                result.state !== undefined &&
                                result.state !== null
                            ) {
                                redisCluster.setex(
                                    redisKey,
                                    300 * 864,
                                    JSON.stringify(result)
                                );
                                resCache(true);
                            } else {
                                resCache(false);
                            }
                        })
                            .then()
                            .catch();
                        //!----
                        resolve(result);
                    })
                    .catch((error) => {
                        logger.error(error);
                        resolve({
                            coordinates: coordinates,
                            state: false,
                            suburb: false,
                        });
                    });
            }
        })
        .catch((error) => {
            logger.error(error);
            new Promise((resCompute) => {
                execBrieflyCompleteEssentialsForLocations(
                    coordinates,
                    location_name,
                    city,
                    resCompute
                );
            })
                .then((result) => {
                    //! Cache if relevant
                    new Promise((resCache) => {
                        if (
                            result.suburb !== false &&
                            result.suburb !== 'false' &&
                            result.suburb !== undefined &&
                            result.suburb !== null &&
                            result.state !== false &&
                            result.state !== 'false' &&
                            result.state !== undefined &&
                            result.state !== null
                        ) {
                            redisCluster.setex(
                                redisKey,
                                300 * 864,
                                JSON.stringify(result)
                            );
                            resCache(true);
                        } else {
                            resCache(false);
                        }
                    })
                        .then()
                        .catch();
                    //!----

                    resolve(result);
                })
                .catch((error) => {
                    logger.error(error);
                    resolve({
                        coordinates: coordinates,
                        state: false,
                        suburb: false,
                    });
                });
        });
}

/**
 * Execute the above function
 */
function execBrieflyCompleteEssentialsForLocations(
    coordinates,
    location_name,
    city,
    resolve
) {
    //Get the osm place id and check in mongo first
    let url =
        `${
            /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
        }` +
        ':' +
        process.env.SEARCH_SERVICE_PORT +
        '/getUserLocationInfos';
    //...
    requestAPI.post(
        {
            url,
            form: {
                latitude: coordinates.latitude,
                longitude: coordinates.longitude,
                user_fingerprint: `internal_${new Date(
                    chaineDateUTC
                ).getTime()}${otpGenerator.generate(14, {
                    upperCase: false,
                    specialChars: false,
                    alphabets: false,
                })}`,
            },
        },
        function (error, response, body) {
            logger.info(url);
            logger.info(body, error);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    //? OSM ID
                    let osm_id = body.osm_id;
                    //Check if there are any record in mongodb
                    dynamo_find_query({
                        table_name: 'autocompleted_location_suburbs',
                        IndexName: 'osm_id',
                        KeyConditionExpression: 'osm_id = :val1',
                        ExpressionAttributeValues: {
                            ':val1': osm_id,
                        },
                    })
                        .then((locationData) => {
                            if (
                                locationData !== undefined &&
                                locationData.length > 0
                            ) {
                                logger.warn(
                                    `Found mongo record for the related suburb - ${osm_id}`
                                );
                                //Found a record
                                locationData = locationData[0];
                                //...
                                resolve({
                                    coordinates: coordinates,
                                    state: locationData.results[0].components
                                        .state,
                                    suburb: locationData.results[0].components
                                        .suburb,
                                });
                            } //Make a fresh search
                            else {
                                new Promise((resCompute) => {
                                    doFreshBrieflyCompleteEssentialsForLocations(
                                        coordinates,
                                        location_name,
                                        city,
                                        osm_id,
                                        resCompute
                                    );
                                })
                                    .then((result) => {
                                        resolve(result);
                                    })
                                    .catch((error) => {
                                        logger.error(error);
                                        resolve({
                                            coordinates: coordinates,
                                            state: false,
                                            suburb: false,
                                        });
                                    });
                            }
                        })
                        .catch((error) => {
                            logger.error(error);
                            //Make a fresh search
                            new Promise((resCompute) => {
                                doFreshBrieflyCompleteEssentialsForLocations(
                                    coordinates,
                                    location_name,
                                    city,
                                    osm_id,
                                    resCompute
                                );
                            })
                                .then((result) => {
                                    resolve(result);
                                })
                                .catch((error) => {
                                    logger.error(error);
                                    resolve({
                                        coordinates: coordinates,
                                        state: false,
                                        suburb: false,
                                    });
                                });
                        });
                } catch (error) {
                    resolve({
                        coordinates: coordinates,
                        state: false,
                        suburb: false,
                    });
                }
            } else {
                resolve({
                    coordinates: coordinates,
                    state: false,
                    suburb: false,
                });
            }
        }
    );
}

/**
 * Do fresh reverse geocoding for the suburb
 */
function doFreshBrieflyCompleteEssentialsForLocations(
    coordinates,
    location_name,
    city,
    osm_id,
    resolve
) {
    let localRedisKey =
        `${osm_id}-localSuburbInfos-${city}-${location_name}`.replace(
            / /g,
            '_'
        );
    //? Check from redis first
    redisGet(localRedisKey)
        .then((resp) => {
            logger.error(resp);
            if (resp !== null) {
                //Has some records
                try {
                    resp = JSON.parse(resp);
                    if (
                        resp.results[0].components.suburb !== false &&
                        resp.results[0].components.suburb !== undefined &&
                        resp.results[0].components.suburb !== 'false' &&
                        resp.results[0].components.suburb !== null &&
                        resp.results[0].components.state !== false &&
                        resp.results[0].components.state !== 'false' &&
                        resp.results[0].components.state !== undefined &&
                        resp.results[0].components.state !== null
                    ) {
                        //Has valid data
                        //? Quickly return
                        resolve({
                            coordinates: coordinates,
                            state: resp.results[0].components.state,
                            suburb: resp.results[0].components.suburb,
                        });
                    } //Has invalid data
                    else {
                        new Promise((resCompute) => {
                            makeFreshOpenCageRequests(
                                coordinates,
                                osm_id,
                                localRedisKey,
                                resCompute
                            );
                        })
                            .then((result) => {
                                resolve(result);
                            })
                            .catch((error) => {
                                logger.error(error);
                                resolve({
                                    coordinates: coordinates,
                                    state: false,
                                    suburb: false,
                                });
                            });
                    }
                } catch (error) {
                    logger.error(error);
                    new Promise((resCompute) => {
                        makeFreshOpenCageRequests(
                            coordinates,
                            osm_id,
                            localRedisKey,
                            resCompute
                        );
                    })
                        .then((result) => {
                            resolve(result);
                        })
                        .catch((error) => {
                            logger.error(error);
                            resolve({
                                coordinates: coordinates,
                                state: false,
                                suburb: false,
                            });
                        });
                }
            } //No records make fresh one
            else {
                new Promise((resCompute) => {
                    makeFreshOpenCageRequests(
                        coordinates,
                        osm_id,
                        localRedisKey,
                        resCompute
                    );
                })
                    .then((result) => {
                        resolve(result);
                    })
                    .catch((error) => {
                        logger.error(error);
                        resolve({
                            coordinates: coordinates,
                            state: false,
                            suburb: false,
                        });
                    });
            }
        })
        .catch((error) => {
            logger.error(error);
            new Promise((resCompute) => {
                makeFreshOpenCageRequests(
                    coordinates,
                    osm_id,
                    localRedisKey,
                    resCompute
                );
            })
                .then((result) => {
                    resolve(result);
                })
                .catch((error) => {
                    logger.error(error);
                    resolve({
                        coordinates: coordinates,
                        state: false,
                        suburb: false,
                    });
                });
        });
}

/**
 * Responsible for making the open cage request freshly, save them in Mongo and cache them
 */
function makeFreshOpenCageRequests(coordinates, osm_id, redisKey, resolve) {
    //request
    let url = `https://api.opencagedata.com/geocode/v1/json?q=${coordinates.latitude}%2C${coordinates.longitude}&key=${process.env.OPENCAGE_API}&language=en&pretty=1&limit=1`;

    requestAPI(url, function (error, response, body) {
        logger.info(url);
        logger.info(body, error);
        if (error === null) {
            try {
                body = JSON.parse(body);

                if (
                    body.results[0].components !== undefined &&
                    (body.results[0].components.suburb !== undefined ||
                        body.results[0].components.neighbourhood !==
                            undefined ||
                        body.results[0].components.residential !== undefined)
                ) {
                    body.results[0].components['suburb'] =
                        body.results[0].components.suburb !== undefined
                            ? body.results[0].components.suburb
                            : body.results[0].components.neighbourhood !==
                              undefined
                            ? body.results[0].components.neighbourhood
                            : body.results[0].components.residential; //Ge the accurate suburb
                    //Has valid data
                    //?Save in Mongo
                    new Promise((resSaveMongo) => {
                        body['osm_id'] = osm_id; //! Add osm id

                        dynamo_insert('autocompleted_location_suburbs', body)
                            .then((result) => {
                                resSaveMongo(true);
                            })
                            .catch((error) => {
                                logger.error(error);
                                resSaveMongo(true);
                            });
                    })
                        .then()
                        .catch();

                    //? Cache
                    new Promise((resCache) => {
                        body['osm_id'] = osm_id; //! Add osm id
                        redisCluster.setex(
                            redisKey,
                            300 * 864,
                            JSON.stringify(body)
                        );
                        resCache(true);
                    })
                        .then()
                        .catch();

                    //? Quickly return
                    resolve({
                        coordinates: coordinates,
                        state: body.results[0].components.state,
                        suburb: body.results[0].components.suburb,
                    });
                } //Not valid infos
                else {
                    logger.error(
                        `LOGGER IS -> ${JSON.stringify(
                            body.results[0].components
                        )}`
                    );
                    resolve({
                        coordinates: coordinates,
                        state:
                            body.results[0].components.state !== undefined &&
                            body.results[0].components.state !== null
                                ? body.results[0].components.state
                                      .replace(' Region', '')
                                      .trim()
                                : false,
                        suburb: false,
                    });
                }
            } catch (error) {
                resolve({
                    coordinates: coordinates,
                    state: false,
                    suburb: false,
                });
            }
        } else {
            resolve({
                coordinates: coordinates,
                state: false,
                suburb: false,
            });
        }
    });
}

/**
 * @func reverseGeocodeUserLocation
 * @param resolve
 * @param req: user coordinates, and fingerprint
 * Responsible for finding out the current user (passenger, driver, etc) location details
 * REDIS propertiy
 * user_fingerprint+reverseGeocodeKey -> currentLocationInfos: {...}
 */
const reverseGeocodeUserLocation = async (
    latitude,
    longitude,
    user_fingerprint
) => {
    const geocodingData = await reverseGeocoderExec(latitude, longitude);

    if (geocodingData !== false) {
        if (!geocodingData?.coordinates) {
            geocodingData.coordinates = [latitude, longitude];
        }
    }

    return geocodingData;
};
/**
 * @func reverseGeocoderExec
 * @param updateCache: to known whether to update the cache or not if yes, will have the value of the hold cache.
 * @param req: the user basic data (fingerprint, etc)
 * @param redisKey: the redis key to cache the data to
 * Responsible for executing the geocoding new fresh requests
 */
const reverseGeocoderExec = async (latitude, longitude) => {
    //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
    //? 1. Destination
    //? Get temporary vars
    const pickLatitude1 = parseFloat(latitude);
    const pickLongitude1 = parseFloat(longitude);
    //! Coordinates order fix - major bug fix for ocean bug
    if (
        pickLatitude1 &&
        pickLatitude1 !== 0 &&
        pickLongitude1 &&
        pickLongitude1 !== 0
    ) {
        //? Switch latitude and longitude - check the negative sign
        if (parseFloat(pickLongitude1) < 0) {
            //Negative - switch
            latitude = pickLongitude1;
            longitude = pickLatitude1;
        }
    }
    //! -------
    const url = `${process.env.URL_SEARCH_SERVICES}reverse?lon=${longitude}&lat=${latitude}`;

    try {
        const photonData = await axios.get(url);

        const body = photonData?.data;
        if (body != undefined) {
            if (body.features[0].properties != undefined) {
                //Check if a city was already assigned
                //? Deduct consistently the town
                const urlNominatim = `${process.env.URL_NOMINATIM_SERVICES}/reverse?lat=${latitude}&lon=${longitude}&zoom=10&format=json`;

                const nominatimData = await axios.get(urlNominatim);

                const body2 = nominatimData?.data;

                try {
                    if (body.features[0].properties.street != undefined) {
                        //? Update the city
                        body.features[0].properties['city'] =
                            body2.address.city !== undefined
                                ? body2.address.city
                                : body.features[0].properties['city'];
                        //? -----
                        return body.features[0].properties;
                    } else if (body.features[0].properties.name != undefined) {
                        //? Update the city
                        body.features[0].properties['city'] =
                            body2.address.city !== undefined
                                ? body2.address.city
                                : body.features[0].properties['city'];
                        //? -----
                        body.features[0].properties.street =
                            body.features[0].properties.name;
                        return body.features[0].properties;
                    } else {
                        return false;
                    }
                } catch (error) {
                    logger.error(error);
                    if (body.features[0].properties.street != undefined) {
                        return body.features[0].properties;
                    } else if (body.features[0].properties.name != undefined) {
                        body.features[0].properties.street =
                            body.features[0].properties.name;
                        return body.features[0].properties;
                    } else {
                        return false;
                    }
                }
            } else {
                return false;
            }
        } else {
            return false;
        }
    } catch (error) {
        logger.error(error);
        logger.warn(
            `${process.env.URL_NOMINATIM_SERVICES}/reverse?lat=${latitude}&lon=${longitude}&zoom=10&format=json`
        );
        return false;
    }
};

// /**
//  * @func r/everseGeocodeUserLocation
//  * @param resolve
//  * @param req: user coordinates, and fingerprint
//  * Responsible for finding out the current user (passenger, driver, etc) location details
//  * REDIS propertiy
//  * user_fingerprint+reverseGeocodeKey -> currentLocationInfos: {...}
//  */
// function r/everseGeocodeUserLocation(resolve, req) {
//   //Form the redis key
//   let redisKey = req.user_fingerprint + "-reverseGeocodeKey";
//   //Check if redis has some informations already
//   redisGet(redisKey).then(
//     (resp) => {
//       if (resp !== null) {
//         //Do a fresh request to update the cache
//         //Make a new reseach
//         new Promise((res) => {
//           //logger.info("Fresh geocpding launched");
//           rev/erseGeocoderExec(res, req, JSON.parse(resp), redisKey);
//         }).then(
//           (result) => {},
//           (error) => {
//             logger.error(error);
//           }
//         );

//         //Has already a cache entry
//         //Check if an old current location is present
//         resp = JSON.parse(resp);
//         if (resp.currentLocationInfos !== undefined) {
//           //Make a rehydration request
//           new Promise((res) => {
//             reve/rseGeocoderExec(res, req, false, redisKey);
//           }).then(
//             (result) => {
//               //Updating cache and replying to the main thread
//               let currentLocationEntry = { currentLocationInfos: result };
//               redisCluster.setex(
//                 redisKey,
//                 300,
//                 JSON.stringify(currentLocationEntry)
//               );
//             },
//             (error) => {
//               logger.error(error);
//             }
//           );
//           //Send
//           resolve(resp.currentLocationInfos);
//         } //No previously cached current location
//         else {
//           //Make a new reseach
//           new Promise((res) => {
//             reverseGe/ocoderExec(res, req, false, redisKey);
//           }).then(
//             (result) => {
//               //Updating cache and replying to the main thread
//               let currentLocationEntry = { currentLocationInfos: result };
//               redisCluster.setex(
//                 redisKey,
//                 300,
//                 JSON.stringify(currentLocationEntry)
//               );
//               resolve(result);
//             },
//             (error) => {
//               logger.error(error);
//               resolve(false);
//             }
//           );
//         }
//       } //No cache entry, create a new one
//       else {
//         //Make a new reseach
//         new Promise((res) => {
//           reverseGeoco/derExec(res, req, false, redisKey);
//         }).then(
//           (result) => {
//             //Updating cache and replying to the main thread
//             let currentLocationEntry = { currentLocationInfos: result };
//             redisCluster.setex(
//               redisKey,
//               300,
//               JSON.stringify(currentLocationEntry)
//             );
//             resolve(result);
//           },
//           (error) => {
//             logger.error(error);
//             resolve(false);
//           }
//         );
//       }
//     },
//     (error) => {
//       logger.error(error);
//       resolve(false);
//     }
//   );
// }
// /**
//  * @func revers/eGeocoderExec
//  * @param updateCache: to known whether to update the cache or not if yes, will have the value of the hold cache.
//  * @param req: the user basic data (fingerprint, etc)
//  * @param redisKey: the redis key to cache the data to
//  * Responsible for executing the geocoding new fresh requests
//  */
// function rever/seGeocoderExec(resolve, req, updateCache = false, redisKey) {
//   //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
//   //? 1. Destination
//   //? Get temporary vars
//   let pickLatitude1 = parseFloat(req.latitude);
//   let pickLongitude1 = parseFloat(req.longitude);
//   //! Coordinates order fix - major bug fix for ocean bug
//   if (
//     pickLatitude1 !== undefined &&
//     pickLatitude1 !== null &&
//     pickLatitude1 !== 0 &&
//     pickLongitude1 !== undefined &&
//     pickLongitude1 !== null &&
//     pickLongitude1 !== 0
//   ) {
//     //? Switch latitude and longitude - check the negative sign
//     if (parseFloat(pickLongitude1) < 0) {
//       //Negative - switch
//       req.latitude = pickLongitude1;
//       req.longitude = pickLatitude1;
//     }
//   }
//   //! -------
//   let url =
//     process.env.URL_SEARCH_SERVICES +
//     "reverse?lon=" +
//     req.longitude +
//     "&lat=" +
//     req.latitude;

//   logger.info(url);

//   requestAPI(url, function (error, response, body) {
//     try {
//       body = JSON.parse(body);
//       if (body != undefined) {
//         if (body.features[0].properties != undefined) {
//           //Check if a city was already assigned
//           //? Deduct consistently the town
//           let urlNominatim = `${process.env.URL_NOMINATIM_SERVICES}/reverse?lat=${req.latitude}&lon=${req.longitude}&zoom=10&format=json`;

//           requestAPI(urlNominatim, function (error2, response2, body2) {
//             // logger.error(body2);
//             try {
//               body2 = JSON.parse(body2);
//               // logger.warn(body2.address.city);
//               if (body.features[0].properties.street != undefined) {
//                 //? Update the city
//                 body.features[0].properties["city"] =
//                   body2.address.city !== undefined
//                     ? body2.address.city
//                     : body.features[0].properties["city"];
//                 //? -----
//                 if (updateCache !== false) {
//                   //Update cache
//                   updateCache.currentLocationInfos =
//                     body.features[0].properties;
//                   redisCluster.setex(
//                     redisKey,
//                     300,
//                     JSON.stringify(updateCache)
//                   );
//                 }
//                 //...
//                 resolve(body.features[0].properties);
//               } else if (body.features[0].properties.name != undefined) {
//                 //? Update the city
//                 body.features[0].properties["city"] =
//                   body2.address.city !== undefined
//                     ? body2.address.city
//                     : body.features[0].properties["city"];
//                 //? -----
//                 body.features[0].properties.street =
//                   body.features[0].properties.name;
//                 if (updateCache !== false) {
//                   //Update cache
//                   updateCache.currentLocationInfos =
//                     body.features[0].properties;
//                   redisCluster.setex(
//                     redisKey,
//                     300,
//                     JSON.stringify(updateCache)
//                   );
//                 }
//                 //...
//                 resolve(body.features[0].properties);
//               } else {
//                 resolve(false);
//               }
//             } catch (error) {
//               logger.error(error);
//               if (body.features[0].properties.street != undefined) {
//                 if (updateCache !== false) {
//                   //Update cache
//                   updateCache.currentLocationInfos =
//                     body.features[0].properties;
//                   redisCluster.setex(
//                     redisKey,
//                     300,
//                     JSON.stringify(updateCache)
//                   );
//                 }
//                 //...
//                 resolve(body.features[0].properties);
//               } else if (body.features[0].properties.name != undefined) {
//                 body.features[0].properties.street =
//                   body.features[0].properties.name;
//                 if (updateCache !== false) {
//                   //Update cache
//                   updateCache.currentLocationInfos =
//                     body.features[0].properties;
//                   redisCluster.setex(
//                     redisKey,
//                     300,
//                     JSON.stringify(updateCache)
//                   );
//                 }
//                 //...
//                 resolve(body.features[0].properties);
//               } else {
//                 resolve(false);
//               }
//             }
//           });
//         } else {
//           resolve(false);
//         }
//       } else {
//         resolve(false);
//       }
//     } catch (error) {
//       logger.warn(error);
//       resolve(false);
//     }
//   });
// }

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
            'pathToDestinationPreview-' +
            JSON.stringify(pointData.user_fingerprint);
        //Add redis key to pointData
        pointData.redisKey = null;
        pointData.redisKey = redisKey;
        logger.info(redisKey);
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
                                    300,
                                    JSON.stringify(resp)
                                );
                                res(true);
                            } catch (error) {
                                //Create a fresh one
                                redisCluster.setex(
                                    pointData.redisKey,
                                    300,
                                    JSON.stringify([result])
                                );
                                res(false);
                            }
                        } //No records -create a fresh one
                        else {
                            redisCluster.setex(
                                pointData.redisKey,
                                300,
                                JSON.stringify([result])
                            );
                            res(true);
                        }
                    },
                    (error) => {
                        //create fresh record
                        redisCluster.setex(
                            pointData.redisKey,
                            300,
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
 * REVERSE GEOCODER
 * To get the exact approx. location of the user or driver.
 * REDIS propertiy
 * user_fingerprint -> currentLocationInfos: {...}
 */
exports.getUserLocationInfos = async (latitude, longitude, userId) => {
    try {
        const result = await reverseGeocodeUserLocation(
            latitude,
            longitude,
            userId
        );

        if (result) {
            //! SUPPORTED CITIES & SERVICES
            const SUPPORTED_CITIES = {
                windhoek: ['delivery', 'shopping'],
            };
            //? Attach the supported city state

            result['isCity_supported'] =
                !!SUPPORTED_CITIES[result.city.trim().toLowerCase()];

            result['supported_services'] = result?.isCity_supported
                ? SUPPORTED_CITIES[result.city.trim().toLowerCase()]
                : [];

            //Add suburb from district if none
            if (!result?.suburb && result?.district) {
                result['suburb'] = result?.district;
            }

            //Add location name from street name if none
            if (!result?.location_name && result?.street) {
                result['location_name'] = result?.street;
                result['street_name'] = result?.street;
            }

            //! Replace Samora Machel Constituency by Wanaheda
            if (
                result.suburb !== undefined &&
                result.suburb !== null &&
                /Samora Machel Constituency/i.test(result.suburb)
            ) {
                result.suburb = 'Wanaheda';
                return result;
            }

            return result;
        } //False returned

        return false;
    } catch (error) {
        console.error(error);
        return false;
    }
};

//1. SEARCH API
exports.getSearchedLocations = async (query) => {
    try {
        resolveDate();
        const { country, city, user_fp, query: userQuery } = query;
        let state = query?.state;
        //..
        logger.info(query);
        //Update search timestamp
        const search_timestamp = new Date().getTime();
        state =
            state !== undefined
                ? state.replace(/ Region/i, '').trim()
                : 'Khomas'; //Default to Khomas

        const result = await getLocationList_five(
            userQuery,
            city,
            country,
            search_timestamp,
            query
        );

        //Add suburb as district if not found
        if (result?.result) {
            result.result = result.result.map((location) => {
                if (!location?.suburb && location?.district) {
                    location['suburb'] = location.district;
                }
                return location;
            });
        }

        return result;
    } catch (error) {
        console.error(error);
        return false;
    }
};

//Cached restore OR initialized
app.use(
    express.json({
        limit: '1000mb',
        extended: true,
    })
).use(
    express.urlencoded({
        limit: '1000mb',
        extended: true,
    })
);

//2. BRIEFLY COMPLETE THE SUBURBS AND STATE
app.get('/brieflyCompleteSuburbAndState', function (request, res) {
    new Promise((resCompute) => {
        resolveDate();

        let params = urlParser.parse(request.url, true);
        request = params.query;
        //...
        if (
            request.latitude !== undefined &&
            request.latitude !== null &&
            request.longitude !== undefined &&
            request.longitude !== null
        ) {
            brieflyCompleteEssentialsForLocations(
                {
                    latitude: request.latitude,
                    longitude: request.longitude,
                },
                request.location_name,
                request.city,
                resCompute
            );
        } //Invalida data received
        else {
            logger.warn(
                'Could not briefly complete the location due to invalid data received.'
            );
            resCompute({
                coordinates: {
                    latitude: request.latitude,
                    longitude: request.longitude,
                },
                state: false,
                suburb: false,
            });
        }
    })
        .then((result) => {
            res.send(result);
        })
        .catch((error) => {
            logger.error(error);
            res.send({
                coordinates: {
                    latitude: request.latitude,
                    longitude: request.longitude,
                },
                state: false,
                suburb: false,
            });
        });
});

/**
 * REVERSE GEOCODER
 * To get the exact approx. location of the user or driver.
 * REDIS propertiy
 * user_fingerprint -> currentLocationInfos: {...}
 */
app.post('/geocode_this_point', function (req, res) {
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
            //TODO: Save the history of the geolocation in Redis
            // new Promise((resHistory) => {
            //   if (request.geolocationData !== undefined) {
            //     bundleData = {
            //       user_fingerprint: request.user_fingerprint,
            //       gps_data: request.geolocationData,
            //       date: new Date(chaineDateUTC),
            //     };
            //     //..
            //     collectionHistoricalGPS.insertOne(
            //       bundleData,
            //       function (err, reslt) {
            //         if (err) {
            //           logger.error(err);
            //           resHistory(false);
            //         }
            //         //...
            //         logger.info("Saved GPS data");
            //         resHistory(true);
            //       }
            //     );
            //   } //No required data
            //   else {
            //     logger.info("No required GPS data for logs");
            //     resHistory(false);
            //   }
            // })
            //   .then()
            //   .catch();

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
                        //! SUPPORTED CITIES
                        let SUPPORTED_CITIES = [
                            'WINDHOEK',
                            'SWAKOPMUND',
                            'WALVIS BAY',
                        ];
                        //? Attach the supported city state
                        result['isCity_supported'] = SUPPORTED_CITIES.includes(
                            result.city !== undefined && result.city !== null
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
                            /Samora Machel Constituency/i.test(result.suburb)
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
 * ROUTE TO DESTINATION previewer
 * Responsible for showing to the user the preview of the first destination after selecting on the app the destination.
 */
app.post('/getRouteToDestinationSnapshot', function (req, res) {
    new Promise((resMAIN) => {
        req = req.body;
        // logger.info(req);
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
                        req.request_fp !== undefined && req.request_fp !== null
                            ? req.request_fp
                            : false,
                };
                findDestinationPathPreview(res, tmp);
            }).then(
                (result) => {
                    resMAIN(result);
                },
                (error) => {
                    logger.error(error);
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
            logger.error(error);
            res.send(false);
        });
});

server.listen(process.env.SEARCH_SERVICE_PORT);
//dash.monitor({server: server});
