require("dotenv").config();
//require("newrelic");
var express = require("express");
const http = require("http");
const fs = require("fs");
const MongoClient = require("mongodb").MongoClient;
// const certFile = fs.readFileSync("./rds-combined-ca-bundle.pem");

const { logger } = require("./LogService");

var app = express();
var server = http.createServer(app);
const requestAPI = require("request");
//---center
const { promisify, inspect } = require("util");
const redis = require("redis");
const client = /production/i.test(String(process.env.EVIRONMENT))
  ? null
  : redis.createClient({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    });
var RedisClustr = require("redis-clustr");
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
//....
var fastFilter = require("fast-filter");
const escapeStringRegexp = require("escape-string-regexp");
var otpGenerator = require("otp-generator");
const urlParser = require("url");
const moment = require("moment");

const cities_center = {
  windhoek: "-22.558926,17.073211", //Conventional center on which to biais the search results
  swakopmund: "-22.6507972303997,14.582524465837887",
};

const conventionalSearchRadius = 8000000; //The radius in which to focus the search;

//GLOBALS
const _CITY = "Windhoek";
const _COUNTRY = "Namibia";
const _MINIMAL_SEARCH_CACHED_RESULTS_TOLERANCE = 5; //Cached result for search must have at least X results, otherwise launch a new search
const _LIMIT_LOCATION_SEARCH_RESULTS = 50; //Limit of the search result from the MAP API

function resolveDate() {
  //Resolve date
  var date = new Date();
  date = moment(date.getTime()).utcOffset(2);

  dateObject = date;
  date =
    date.year() +
    "-" +
    (date.month() + 1) +
    "-" +
    date.date() +
    " " +
    date.hour() +
    ":" +
    date.minute() +
    ":" +
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
  res(cityCenter);
}

checkName = (name, str) => {
  var pattern = str
    .split("")
    .map((x) => {
      return `(?=.*${x})`;
    })
    .join("");
  var regex = new RegExp(`${pattern}`, "g");
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
          checkName(element.location_name.toLowerCase(), query.toLowerCase())
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

function newLoaction_search_engine(
  keyREDIS,
  queryOR,
  city,
  cityCenter,
  res,
  timestamp,
  trailingData
) {
  //? 1. Check if it was written in mongodb
  collectionSearchedLocationPersist
    .find({
      query: queryOR,
      city: city,
      state: trailingData.state.replace(/ Region/i, "").trim(),
    })
    .toArray(function (err, searchedData) {
      if (err) {
        logger.error(err);
        //Fresh search
        new Promise((resCompute) => {
          initializeFreshGetOfLocations(
            keyREDIS,
            queryOR,
            city,
            cityCenter,
            resCompute,
            timestamp,
            trailingData
          );
        })
          .then((result) => {
            res(result);
          })
          .catch((error) => {
            logger.error(error);
            res(false);
          });
      }
      //...
      if (
        searchedData !== undefined &&
        searchedData !== null &&
        searchedData.length > 0
      ) {
        logger.warn("FOUND SOME MONGODB RECORDS");
        logger.info(searchedData);
        //TODO: could twik this value to allow a minimum limit of values
        let finalSearchResults = {
          search_timestamp: timestamp,
          result: removeResults_duplicates(searchedData).slice(0, 5),
        };
        //! Cache globally the final result
        new Promise((resCache) => {
          redisCluster.setex(
            keyREDIS,
            parseFloat(process.env.REDIS_EXPIRATION_5MIN) * 24,
            JSON.stringify(finalSearchResults)
          );
          resCache(true);
        })
          .then()
          .catch();
        //...DONE
        res(finalSearchResults);
      } //Fresh search
      else {
        logger.warn("NO MONG RECORDS< MAKE A FRESH SEARCH");
        new Promise((resCompute) => {
          initializeFreshGetOfLocations(
            keyREDIS,
            queryOR,
            city,
            cityCenter,
            resCompute,
            timestamp,
            trailingData
          );
        })
          .then((result) => {
            res(result);
          })
          .catch((error) => {
            logger.error(error);
            res(false);
          });
      }
    });
}

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
function initializeFreshGetOfLocations(
  keyREDIS,
  queryOR,
  city,
  cityCenter,
  res,
  timestamp,
  trailingData
) {
  query = encodeURIComponent(queryOR.toLowerCase());

  //TODO: could allocate the country dynamically for scale.
  let urlRequest = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${query}&key=${process.env.GOOGLE_API_KEY}&components=country:na&language=en&radius=${conventionalSearchRadius}&limit=1000`;
  logger.error(urlRequest);

  requestAPI(urlRequest, function (err, response, body) {
    try {
      body = JSON.parse(body);
      logger.error(body);

      if (body != undefined) {
        if (
          body.predictions !== undefined &&
          body.predictions !== null &&
          body.predictions.length > 0
        ) {
          //...
          //.
          let request0 = body.predictions.map((locationPlace, index) => {
            return new Promise((resolve) => {
              let averageGeo = 0;
              //? Deduct the street, city and country
              let locationName = locationPlace.structured_formatting.main_text;
              //Get the street city and country infos
              let secondaryDetailsCombo =
                locationPlace.structured_formatting.secondary_text !==
                  undefined &&
                locationPlace.structured_formatting.secondary_text !== null
                  ? locationPlace.structured_formatting.secondary_text.split(
                      ", "
                    )
                  : false; //Will contain the street, city and country respectively
              let streetName =
                secondaryDetailsCombo !== false
                  ? secondaryDetailsCombo.length >= 3
                    ? secondaryDetailsCombo[secondaryDetailsCombo.length - 3]
                    : false
                  : false;
              //city
              let cityName =
                secondaryDetailsCombo !== false
                  ? secondaryDetailsCombo.length >= 2
                    ? secondaryDetailsCombo[secondaryDetailsCombo.length - 2]
                    : false
                  : false;
              //Country
              let countryName =
                secondaryDetailsCombo !== false
                  ? secondaryDetailsCombo.length >= 1
                    ? secondaryDetailsCombo[secondaryDetailsCombo.length - 1]
                    : false
                  : false;

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
              //! Get the coordinates and save them in mongodb - to save on cost
              new Promise((resCompute) => {
                attachCoordinatesAndRegion(littlePack, resCompute);
              })
                .then((result) => {
                  resolve(result);
                })
                .catch((error) => {
                  logger.error(error);
                  resolve(false);
                });
            });
          });
          //Done with grathering result of brute API search
          Promise.all(request0).then((val) => {
            logger.info(val);
            //Remove all the false values
            let result = fastFilter(val, function (element) {
              return element !== false && element !== null;
            });
            //? Remove all the out of context cities
            //! 1. Filter by town only for Windhoek in the Khomas region
            if (
              /windhoek/i.test(city.trim()) &&
              /khomas/i.test(trailingData.state.replace(/ Region/i, "").trim())
            ) {
              //Khomas region
              logger.info("KHOMAS");
              result = fastFilter(val, function (element) {
                let regFilterCity = new RegExp(city.trim(), "i");
                return element.city !== false && element.city !== undefined
                  ? regFilterCity.test(element.city.trim())
                  : false;
              });
            } //Other regions
            else {
              logger.error(val);
              result = fastFilter(val, function (element) {
                let regFilterState = new RegExp(trailingData.state.trim(), "i");
                return element.state !== false && element.state !== undefined
                  ? regFilterState.test(element.state.trim())
                  : false;
              });
            }

            //! Save in mongo search persist - Cost reduction
            new Promise((saveMongo) => {
              if (result.length > 0) {
                collectionSearchedLocationPersist.insertMany(
                  result,
                  function (err, reslt) {
                    saveMongo(true);
                    logger.warn("SAVED IN MONGO PERSIST!");
                  }
                );
              } //Nothing to save
              else {
                saveMongo(false);
              }
            })
              .then()
              .catch();
            //...
            if (result.length > 0) {
              let finalSearchResults = {
                search_timestamp: timestamp,
                result: removeResults_duplicates(result).slice(0, 5),
              };
              logger.warn(finalSearchResults);
              //populated
              res(finalSearchResults);
            } //empty
            else {
              res(false);
            }
          });
        } else {
          res(false);
        }
      } else {
        res(false);
      }
    } catch (error) {
      logger.warn("HERE5");
      logger.warn(error);
      res(false);
      // initializeFreshGetOfLocations(
      //   keyREDIS,
      //   queryOR,
      //   city,
      //   cityCenter,
      //   res,
      //   timestamp
      // );
    }
  });
}

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
      item.types.includes("administrative_area_level_1")
    )[0] !== undefined &&
    body.result.address_components.filter((item) =>
      item.types.includes("administrative_area_level_1")
    )[0] !== null
      ? body.result.address_components
          .filter((item) =>
            item.types.includes("administrative_area_level_1")
          )[0]
          .short_name.replace(" Region", "")
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
  suburb = /Elisenheim/i.test(location_name) ? "Elisenheim" : suburb;
  //! 2. Make suburb Ausspannplatz if anything related to it
  suburb = /Ausspannplatz/i.test(location_name) ? "Ausspannplatz" : suburb;
  //! 3. Make suburb Brakwater if anything related to it
  suburb = /Brakwater/i.test(location_name) ? "Brakwater" : suburb;

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
function attachCoordinatesAndRegion(littlePack, resolve) {
  //? Check if its wasn't cached before
  let redisKey = `${littlePack.location_id}-coordinatesAndRegion`;
  redisGet(redisKey).then((resp) => {
    if (resp !== null) {
      try {
        logger.warn("Using cached coordinates and region");
        resp = JSON.parse(resp);
        //? Quickly complete
        body = resp;
        //Has a previous record
        let refinedExtractions = arrangeAndExtractSuburbAndStateOrMore(
          body,
          littlePack.location_name
        );
        let coordinates = refinedExtractions.coordinates;
        let state = refinedExtractions.state;
        //...
        littlePack.coordinates = coordinates;
        littlePack.state = state;
        littlePack.suburb = false;
        //...done
        resolve(littlePack);
      } catch (error) {
        logger.warn("HERE2");
        logger.warn(error);
        //Do a fresh search or from mongo
        new Promise((resCompute) => {
          doFreshGoogleSearchAndReturn(littlePack, redisKey, resCompute);
        })
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            logger.error(error);
            resolve(false);
          });
      }
    } //Not cached - check Mongo
    else {
      //? First check in mongo
      collectionSearchedLocationPersist
        .find({ "result.place_id": littlePack.location_id })
        .toArray(function (err, placeInfo) {
          if (err) {
            logger.error(err);
            //fresh
            new Promise((resCompute) => {
              doFreshGoogleSearchAndReturn(littlePack, redisKey, resCompute);
            })
              .then((result) => {
                resolve(result);
              })
              .catch((error) => {
                logger.error(error);
                resolve(false);
              });
          }
          //...
          if (
            placeInfo !== undefined &&
            placeInfo !== null &&
            placeInfo.length > 0
          ) {
            body = placeInfo[0];
            //Has a previous record
            let refinedExtractions = arrangeAndExtractSuburbAndStateOrMore(
              body,
              littlePack.location_name
            );
            let coordinates = refinedExtractions.coordinates;
            let state = refinedExtractions.state;
            //...
            littlePack.coordinates = coordinates;
            littlePack.state = state;
            littlePack.suburb = false;
            //..Save the body in mongo
            body["date_updated"] = new Date(chaineDateUTC);
            new Promise((resSave) => {
              collectionEnrichedLocationPersist.updateOne(
                { "result.place_id": littlePack.place_id },
                {
                  $set: body,
                },
                { upsert: true },
                function (err, res) {
                  logger.error(err);
                  resSave(true);
                }
              );
            })
              .then()
              .catch();
            //...Cache it
            new Promise((resCache) => {
              redisCluster.setex(
                redisKey,
                parseFloat(process.env.REDIS_EXPIRATION_5MIN) * 24,
                JSON.stringify(body)
              );
              resCache(true);
            });
            //...done
            resolve(littlePack);
          } //No previous mongo record - do fresh
          else {
            new Promise((resCompute) => {
              doFreshGoogleSearchAndReturn(littlePack, redisKey, resCompute);
            })
              .then((result) => {
                resolve(result);
              })
              .catch((error) => {
                logger.error(error);
                resolve(false);
              });
          }
        });
    }
  });
}

/**
 * @func doFreshGoogleSearchAndReturn
 * Responsible for doing a clean google maps search, save the value in mongo, cache it and return an updated object.
 */
function doFreshGoogleSearchAndReturn(littlePack, redisKey, resolve) {
  let urlRequest = `https://maps.googleapis.com/maps/api/place/details/json?placeid=${littlePack.location_id}&key=${process.env.GOOGLE_API_KEY}&fields=formatted_address,address_components,geometry,place_id&language=en`;

  requestAPI(urlRequest, function (err, response, body) {
    logger.info(body);
    try {
      body = JSON.parse(body);
      if (
        body.result !== undefined &&
        body.result.address_components !== undefined &&
        body.result.geometry !== undefined
      ) {
        // body["result"] = body.results[0];

        let refinedExtractions = arrangeAndExtractSuburbAndStateOrMore(
          body,
          littlePack.location_name
        );
        let coordinates = refinedExtractions.coordinates;
        let state = refinedExtractions.state;
        //...
        littlePack.coordinates = coordinates;
        littlePack.state = state;
        littlePack.suburb = false;
        //..Save the body in mongo
        body["date_updated"] = new Date(chaineDateUTC);
        new Promise((resSave) => {
          collectionEnrichedLocationPersist.updateOne(
            { "result.place_id": littlePack.place_id },
            { $set: body },
            { upsert: true },
            function (err, res) {
              logger.error(err);
              resSave(true);
            }
          );
        })
          .then()
          .catch();
        //...Cache it
        new Promise((resCache) => {
          redisCluster.setex(
            redisKey,
            parseFloat(process.env.REDIS_EXPIRATION_5MIN) * 24,
            JSON.stringify(body)
          );
          resCache(true);
        });
        //...done
        resolve(littlePack);
      } //Invalid data
      else {
        resolve(false);
      }
    } catch (error) {
      logger.warn("HERE3");
      logger.warn(error);
      resolve(false);
    }
  });
}

function removeResults_duplicates(arrayResults, resolve) {
  //logger.info(arrayResults);
  let arrayResultsClean = [];
  let arrayIds = [];
  arrayResults.map((location) => {
    let tmpId =
      location.location_name +
      " " +
      location.city +
      " " +
      location.street +
      " " +
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

function getLocationList_five(
  queryOR,
  city,
  country,
  cityCenter,
  res,
  timestamp,
  trailingData
) {
  resolveDate();
  //Check if cached results are available
  let keyREDIS = `search_locations-${city.trim().toLowerCase()}-${country
    .trim()
    .toLowerCase()}-${queryOR}-${trailingData.state}`; //! Added time for debug
  logger.info(keyREDIS);
  //-------------------------------------
  redisGet(keyREDIS).then(
    (resp) => {
      if (resp != null && resp !== undefined) {
        logger.warn(
          "[*] Found global search results for the same query input."
        );
        //logObject(JSON.parse(reslt));
        try {
          //Rehydrate records
          new Promise((resCompute) => {
            newLoaction_search_engine(
              keyREDIS,
              queryOR,
              city,
              cityCenter,
              resCompute,
              timestamp,
              trailingData
            );
          })
            .then()
            .catch();
          //...
          resp = JSON.parse(resp);
          //Exceptions check
          resp.result = resp.result.map((location) => {
            location.suburb = applySuburbsExceptions(
              location.location_name,
              location.suburb
            );
            return location;
          });
          logger.error(resp);
          //!Update search record time
          resp.search_timestamp = timestamp;
          res(resp);
        } catch (error) {
          logger.warn("HERE");
          logger.warn(error);
          logger.info("Launch new search");
          newLoaction_search_engine(
            keyREDIS,
            queryOR,
            city,
            cityCenter,
            res,
            timestamp,
            trailingData
          );
        }
      } //No cached results
      else {
        //Launch new search
        logger.info("Launch new search");
        newLoaction_search_engine(
          keyREDIS,
          queryOR,
          city,
          cityCenter,
          res,
          timestamp,
          trailingData
        );
      }
    },
    (error) => {
      //Launch new search
      logger.warn(error);
      logger.info("Launch new search");
      newLoaction_search_engine(
        keyREDIS,
        queryOR,
        city,
        cityCenter,
        res,
        timestamp,
        trailingData
      );
    }
  );
}

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
  )}-${location_name}-${city}`.replace(/ /g, "_");
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
            resp.suburb !== "false" &&
            resp.suburb !== undefined &&
            resp.suburb !== null &&
            resp.state !== false &&
            resp.state !== "false" &&
            resp.state !== undefined &&
            resp.state !== null
          ) {
            logger.warn(
              "Found some cached records for the suburbs autcomplete."
            );
            //? Quickly return
            resolve(resp);
          } //Make a clean search
          else {
            logger.warn(
              "Found a porblem with the cached values, making a clean search!"
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
                    result.suburb !== "false" &&
                    result.suburb !== undefined &&
                    result.suburb !== null &&
                    result.state !== false &&
                    result.state !== "false" &&
                    result.state !== undefined &&
                    result.state !== null
                  ) {
                    redisCluster.setex(
                      redisKey,
                      process.env.REDIS_EXPIRATION_5MIN * 864,
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
                  result.suburb !== "false" &&
                  result.suburb !== undefined &&
                  result.suburb !== null &&
                  result.state !== false &&
                  result.state !== "false" &&
                  result.state !== undefined &&
                  result.state !== null
                ) {
                  redisCluster.setex(
                    redisKey,
                    process.env.REDIS_EXPIRATION_5MIN * 864,
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
                result.suburb !== "false" &&
                result.suburb !== undefined &&
                result.suburb !== null &&
                result.state !== false &&
                result.state !== "false" &&
                result.state !== undefined &&
                result.state !== null
              ) {
                redisCluster.setex(
                  redisKey,
                  process.env.REDIS_EXPIRATION_5MIN * 864,
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
              result.suburb !== "false" &&
              result.suburb !== undefined &&
              result.suburb !== null &&
              result.state !== false &&
              result.state !== "false" &&
              result.state !== undefined &&
              result.state !== null
            ) {
              redisCluster.setex(
                redisKey,
                process.env.REDIS_EXPIRATION_5MIN * 864,
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
    ":" +
    process.env.SEARCH_SERVICE_PORT +
    "/getUserLocationInfos";
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
          collectionAutoCompletedSuburbs
            .find({ osm_id: osm_id })
            .toArray(function (err, locationData) {
              if (err) {
                logger.error(err);
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
              }

              //...
              if (locationData !== undefined && locationData.length > 0) {
                logger.warn(
                  `Found mongo record for the related suburb - ${osm_id}`
                );
                //Found a record
                locationData = locationData[0];
                //...
                resolve({
                  coordinates: coordinates,
                  state: locationData.results[0].components.state,
                  suburb: locationData.results[0].components.suburb,
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
    `${osm_id}-localSuburbInfos-${city}-${location_name}`.replace(/ /g, "_");
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
            resp.results[0].components.suburb !== "false" &&
            resp.results[0].components.suburb !== null &&
            resp.results[0].components.state !== false &&
            resp.results[0].components.state !== "false" &&
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
            body.results[0].components.neighbourhood !== undefined ||
            body.results[0].components.residential !== undefined)
        ) {
          body.results[0].components["suburb"] =
            body.results[0].components.suburb !== undefined
              ? body.results[0].components.suburb
              : body.results[0].components.neighbourhood !== undefined
              ? body.results[0].components.neighbourhood
              : body.results[0].components.residential; //Ge the accurate suburb
          //Has valid data
          //?Save in Mongo
          new Promise((resSaveMongo) => {
            body["osm_id"] = osm_id; //! Add osm id
            collectionAutoCompletedSuburbs.insertOne(
              body,
              function (err, reslt) {
                resSaveMongo(true);
              }
            );
          })
            .then()
            .catch();

          //? Cache
          new Promise((resCache) => {
            body["osm_id"] = osm_id; //! Add osm id
            redisCluster.setex(
              redisKey,
              process.env.REDIS_EXPIRATION_5MIN * 864,
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
            `LOGGER IS -> ${JSON.stringify(body.results[0].components)}`
          );
          resolve({
            coordinates: coordinates,
            state:
              body.results[0].components.state !== undefined &&
              body.results[0].components.state !== null
                ? body.results[0].components.state.replace(" Region", "").trim()
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
function reverseGeocodeUserLocation(resolve, req) {
  //Form the redis key
  let redisKey = req.user_fingerprint + "-reverseGeocodeKey";
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
              let currentLocationEntry = { currentLocationInfos: result };
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
              let currentLocationEntry = { currentLocationInfos: result };
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
            let currentLocationEntry = { currentLocationInfos: result };
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
    "reverse?lon=" +
    req.longitude +
    "&lat=" +
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

          requestAPI(urlNominatim, function (error2, response2, body2) {
            // logger.error(body2);
            try {
              body2 = JSON.parse(body2);
              // logger.warn(body2.address.city);
              if (body.features[0].properties.street != undefined) {
                //? Update the city
                body.features[0].properties["city"] =
                  body2.address.city !== undefined
                    ? body2.address.city
                    : body.features[0].properties["city"];
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
              } else if (body.features[0].properties.name != undefined) {
                //? Update the city
                body.features[0].properties["city"] =
                  body2.address.city !== undefined
                    ? body2.address.city
                    : body.features[0].properties["city"];
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
              if (body.features[0].properties.street != undefined) {
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
              } else if (body.features[0].properties.name != undefined) {
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
          });
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

var collectionSearchedLocationPersist = null;
var collectionAutoCompletedSuburbs = null;
var collectionEnrichedLocationPersist = null;

redisCluster.on("connect", function () {
  logger.info("[*] Redis connected");
  MongoClient.connect(process.env.DB_URL_MONGODB, function (err, clientMongo) {
    if (err) throw err;
    logger.info("Connected to Mongodb");
    const dbMongo = clientMongo.db(process.env.DB_NAME_MONGODDB);
    collectionSearchedLocationPersist = dbMongo.collection(
      "searched_locations_persist"
    );
    collectionAutoCompletedSuburbs = dbMongo.collection(
      "autocompleted_location_suburbs"
    );
    collectionEnrichedLocationPersist = dbMongo.collection(
      "enriched_locationSearch_persist"
    ); //Will hold all the google locations searched using the place id
    //-------------
    //Cached restore OR initialized
    app
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
      );

    //1. SEARCH API
    app.post("/getSearchedLocations", function (request, res) {
      resolveDate();
      //..
      request = request.body;
      // logger.info(request);
      //Update search timestamp
      //search_timestamp = dateObject.unix();
      // let search_timestamp = request.query.length;
      let search_timestamp = new Date(chaineDateUTC).getTime();
      request.state =
        request.state !== undefined
          ? request.state.replace(/ Region/i, "").trim()
          : "Khomas"; //Default to Khomas
      //...
      //   request.city = "Windhoek";
      //   request.country = "Namibia";
      //   request.user_fp = "abcd";
      //   request.query = "kh";

      let redisKeyConsistencyKeeper = `${request.user_fp}-autocompleteSearchRecordTime-${request.city}-${request.state}`;
      //1. Get the cityCenter
      request0 = new Promise((res) => {
        //Save in Cache
        redisCluster.set(redisKeyConsistencyKeeper, request.query);
        getCityCenter(request.city, res);
      }).then(
        (result) => {
          let cityCenter = result;
          //Get the location
          new Promise((res) => {
            let tmpTimestamp = search_timestamp;
            getLocationList_five(
              request.query,
              request.city,
              request.country,
              cityCenter,
              res,
              tmpTimestamp,
              request
            );
          }).then(
            (result) => {
              //? Get the redis record time and compare
              redisGet(redisKeyConsistencyKeeper)
                .then((resp) => {
                  if (
                    resp !== null &&
                    result !== false &&
                    result.result !== undefined &&
                    result.result[0].query !== undefined
                  ) {
                    logger.warn(`Redis last time record: ${resp}`);
                    logger.warn(
                      `Request time record: ${result.result[0].query}`
                    );
                    logger.warn(
                      `Are search results consistent ? --> ${
                        resp === result.result[0].query
                      }`
                    );
                    if (resp === result.result[0].query) {
                      logger.warn(result);
                      //Inconsistent - do not update
                      logger.info("Consistent");
                      //res.send(false);
                      res.send({ result: result });
                    } //Consistent - update
                    else {
                      logger.info("Inconsistent");
                      //logObject(result);
                      // res.send({ result: result });
                      res.send(false);
                    }
                  } //Nothing the compare to
                  else {
                    res.send(false);
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  res.send(false);
                });
            },
            (error) => {
              logger.warn("HERE10");
              logger.warn(error);
              res.send(false);
            }
          );
        },
        (error) => {
          logger.warn(error);
          res.send(false);
        }
      );
    });

    //2. BRIEFLY COMPLETE THE SUBURBS AND STATE
    app.get("/brieflyCompleteSuburbAndState", function (request, res) {
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
            { latitude: request.latitude, longitude: request.longitude },
            request.location_name,
            request.city,
            resCompute
          );
        } //Invalida data received
        else {
          logger.warn(
            "Could not briefly complete the location due to invalid data received."
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
    app.post("/geocode_this_point", function (req, res) {
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
              collectionHistoricalGPS.insertOne(
                bundleData,
                function (err, reslt) {
                  if (err) {
                    logger.error(err);
                    resHistory(false);
                  }
                  //...
                  logger.info("Saved GPS data");
                  resHistory(true);
                }
              );
            } //No required data
            else {
              logger.info("No required GPS data for logs");
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
                result !== "false" &&
                result !== undefined &&
                result !== null
              ) {
                //! SUPPORTED CITIES
                let SUPPORTED_CITIES = ["WINDHOEK", "SWAKOPMUND", "WALVIS BAY"];
                //? Attach the supported city state
                result["isCity_supported"] = SUPPORTED_CITIES.includes(
                  result.city !== undefined && result.city !== null
                    ? result.city.trim().toUpperCase()
                    : result.name !== undefined && result.name !== null
                    ? result.name.trim().toUpperCase()
                    : "Unknown city"
                );
                result["isCity_supported"] = true;
                //! Replace Samora Machel Constituency by Wanaheda
                if (
                  result.suburb !== undefined &&
                  result.suburb !== null &&
                  /Samora Machel Constituency/i.test(result.suburb)
                ) {
                  result.suburb = "Wanaheda";
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
  });
});

server.listen(process.env.SEARCH_SERVICE_PORT);
//dash.monitor({server: server});
