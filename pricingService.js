require("dotenv").config();
//require("newrelic");
var express = require("express");
const http = require("http");
const fs = require("fs");

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

//! Attach DynamoDB helper
const {
  dynamo_insert,
  dynamo_update,
  dynamo_find_query,
  dynamo_delete,
  dynamo_get_all,
} = require("./DynamoServiceManager");
//....
var fastFilter = require("fast-filter");
const escapeStringRegexp = require("escape-string-regexp");
var otpGenerator = require("otp-generator");
const urlParser = require("url");
const moment = require("moment");
const { resolveAny } = require("dns");

const cities_center = {
  windhoek: "-22.558926,17.073211", //Conventional center on which to biais the search results
  swakopmund: "-22.6507972303997,14.582524465837887",
};

const conventionalSearchRadius = 8000000; //The radius in which to focus the search;

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

redisCluster.on("connect", function () {
  logger.info("[*] Redis connected");

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

  app.post("/computeFares", function (req, res) {
    new Promise((resolve) => {
      req = req.body;
      logger.info(req);

      if (
        req.pickup_location !== undefined &&
        req.pickup_location !== null &&
        req.dropoff_locations !== undefined &&
        req.dropoff_locations !== null &&
        req.user_fingerprint !== undefined &&
        req.user_fingerprint !== null &&
        req.ride_type !== undefined &&
        req.ride_type !== null
      ) {
        //! DISABLE WHEN TESTING WITH POSTMAN
        req.pickup_location = JSON.parse(req.pickup_location);
        req.dropoff_locations = JSON.parse(req.dropoff_locations);

        //?1. Compute the general base fare
        let parentBaseFare = req.dropoff_locations.map(
          (dropoff_location, index) => {
            // dropoff_location = dropoff_location.dropoff_location; //? WORKS WITH POSTMAN TESTING
            //Add the passenger number
            dropoff_location["passenger_id"] = index;
            //! Complete the missing suburb
            return new Promise((resCompute1) => {
              let url =
                `${
                  /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
                }` +
                ":" +
                process.env.SEARCH_SERVICE_PORT +
                `/brieflyCompleteSuburbAndState?latitude=${dropoff_location.coordinates[0]}&longitude=${dropoff_location.coordinates[1]}&city=${dropoff_location.city}&location_name=${dropoff_location.location_name}`;

              requestAPI(url, function (error, response, body) {
                logger.error(body);
                try {
                  body = JSON.parse(body);
                  //? Complete the suburb
                  dropoff_location.suburb = body.suburb;
                  dropoff_location.state = body.state;
                  //...
                  resCompute1(dropoff_location);
                } catch (error) {
                  logger.error(error);
                  resCompute1(dropoff_location);
                }
              });
            });
          }
        );

        //...Done 1
        Promise.all(parentBaseFare)
          .then((cleanDropOffs) => {
            //?2. Sum all the locations to come up with the base fare
            //Get all the vehicle types
            dynamo_find_query({
              table_name: "vehicles_collection_infos",
              IndexName: "ride_type",
              KeyConditionExpression: "ride_type = :val1",
              FilterExpression: "category = :val2",
              ExpressionAttributeValues: {
                ":val1": req.ride_type.toUpperCase().trim(),
                ":val2": "Economy", //!Stay in Economy first
              },
            })
              .then((vehicles_batch) => {
                if (vehicles_batch !== undefined && vehicles_batch.length > 0) {
                  let parentPromisesCompute = vehicles_batch.map(
                    (vehicle, index) => {
                      //Found the vehicles
                      let BASE_FARE = 0;
                      //! Compute the general base fare per vehicle
                      return new Promise((resCompute) => {
                        let parentComputeInsider = cleanDropOffs.map(
                          (dropoff) => {
                            return new Promise((resAdd) => {
                              // let recordChecker = {
                              //   city: dropoff.city,
                              //   country: dropoff.country,
                              //   destination_suburb: dropoff.suburb,
                              //   pickup_suburb: ,
                              //   region: dropoff.state,
                              // };
                              // logger.info(dropoff);
                              //...
                              dynamo_find_query({
                                table_name: "global_prices_to_locations_map",
                                IndexName: "pickup_suburb",
                                KeyConditionExpression: "pickup_suburb = :val1",
                                FilterExpression:
                                  "destination_suburb = :val2 and city = :val3 and country = :val4 and #region_word = :val5",
                                ExpressionAttributeValues: {
                                  ":val1": req.pickup_location.suburb,
                                  ":val2": dropoff.suburb,
                                  ":val3": dropoff.city,
                                  ":val4": dropoff.country,
                                  ":val5": dropoff.state,
                                },
                                ExpressionAttributeNames: {
                                  "#region_word": "region",
                                },
                              })
                                .then((priceRecord) => {
                                  if (
                                    priceRecord !== undefined &&
                                    priceRecord.length > 0
                                  ) {
                                    //Has a record
                                    BASE_FARE += parseFloat(
                                      priceRecord[0]["fare"]
                                    );
                                    resAdd(true);
                                  } //No record found - should be logged and attended to later
                                  else {
                                    BASE_FARE += parseFloat(
                                      vehicle["base_fare"]
                                    );
                                    resAdd(false);
                                  }
                                })
                                .catch((error) => {
                                  logger.error(error);
                                  //Set the base fare as the car's one
                                  BASE_FARE += parseFloat(vehicle["base_fare"]);
                                  resAdd(false);
                                });
                            });
                          }
                        );
                        //...
                        Promise.all(parentComputeInsider)
                          .then((resultInsider) => {
                            resolveDate();
                            //! Add the pickup fee
                            BASE_FARE += 10;
                            //! Double for 23h - 4h
                            BASE_FARE *=
                              new Date(chaineDateUTC).getHours() >= 23 ||
                              new Date(chaineDateUTC).getHours() <= 4
                                ? 2
                                : 1;
                            //Only get relevant information form the metadata
                            let {
                              category,
                              ride_type,
                              country,
                              city,
                              // base_fare,
                              car_type,
                              app_label,
                              description,
                              media,
                              availability,
                            } = vehicle;
                            let vehicle_fare_model = {
                              id: index,
                              category: category,
                              ride_type: ride_type,
                              country: country,
                              city: city,
                              base_fare: BASE_FARE,
                              car_type: car_type,
                              app_label: app_label,
                              description: description,
                              media: media,
                              availability: availability,
                            };
                            //...
                            resCompute(vehicle_fare_model);
                          })
                          .catch((error) => {
                            logger.error(error);
                            resCompute([]);
                          });
                      });
                    }
                  );

                  //...
                  Promise.all(parentPromisesCompute)
                    .then((vehicleFares) => {
                      //Flip the results
                      vehicleFares.reverse();
                      //...
                      resolve(vehicleFares);
                    })
                    .catch((error) => {
                      logger.error(error);
                      resolve([]);
                    });
                } //No vehicles found?
                else {
                  resolve([]);
                }
              })
              .catch((error) => {
                logger.error(error);
                resolve([]);
              });
          })
          .catch((error) => {
            logger.error(error);
            resolve([]);
          });
      } //Invalid data
      else {
        resolve([]);
      }
    })
      .then((result) => {
        logger.info(result);
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send([]);
      });
  });
});

server.listen(process.env.PRICING_SERVICE_PORT);
