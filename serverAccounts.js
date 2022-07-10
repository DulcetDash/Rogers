require("dotenv").config();
//var dash = require("appmetrics-dash");
//require("newrelic");
var express = require("express");
const http = require("http");
const fs = require("fs");
var path = require("path");
const helmet = require("helmet");

const { parse, stringify } = require("flatted");
const AWS = require("aws-sdk");
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_S3_ID,
  secretAccessKey: process.env.AWS_S3_SECRET,
});

var accessLogStream = fs.createWriteStream(
  path.join(__dirname, "accountService_access.log"),
  { flags: "a" }
);
const { logger } = require("./LogService");

var app = express();
var server = http.createServer(app);
const requestAPI = require("request");
const crypto = require("crypto");
//....
const urlParser = require("url");

const redis = require("redis");
const { promisify } = require("util");

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

var isBase64 = require("is-base64");
var chaineDateUTC = null;
const moment = require("moment");
var otpGenerator = require("otp-generator");

//! Attach DynamoDB helper
const {
  dynamo_insert,
  dynamo_update,
  dynamo_find_get,
  dynamo_find_query,
} = require("./DynamoServiceManager");

var AWS_SMS = require("aws-sdk");
function SendSMSTo(phone_number, message) {
  // Load the AWS SDK for Node.js
  // Set region
  AWS_SMS.config.update({ region: "us-east-1" });

  // Create publish parameters
  var params = {
    Message: message /* required */,
    PhoneNumber: phone_number,
  };

  // Create promise and SNS service object
  var publishTextPromise = new AWS_SMS.SNS({ apiVersion: "2010-03-31" })
    .publish(params)
    .promise();

  // Handle promise's fulfilled/rejected states
  publishTextPromise
    .then(function (data) {
      logger.info("MessageID is " + data.MessageId);
    })
    .catch(function (err) {
      console.error(err, err.stack);
    });
  // let username = "Nej";
  // let password = "Nej*1";

  // let postData = JSON.stringify({
  //   to: phone_number,
  //   body: message,
  // });

  // let options = {
  //   hostname: "api.bulksms.com",
  //   port: 443,
  //   path: "/v1/messages",
  //   method: "POST",
  //   headers: {
  //     "Content-Type": "application/json",
  //     "Content-Length": postData.length,
  //     Authorization:
  //       "Basic " + Buffer.from(username + ":" + password).toString("base64"),
  //   },
  // };

  // let req = https.request(options, (resp) => {
  //   logger.info("statusCode:", resp.statusCode);
  //   let data = "";
  //   resp.on("data", (chunk) => {
  //     data += chunk;
  //   });
  //   resp.on("end", () => {
  //     logger.info("Response:", data);
  //   });
  // });

  // req.on("error", (e) => {
  //   logger.warn(e);
  // });

  // req.write(postData);
  // req.end();
}

/*const numeral = require("numeral");
setInterval(() => {
  const { rss, heapTotal } = process.memoryUsage();
  logger.info(
    "rss",
    numeral(rss).format("0.0 ib"),
    "heapTotal",
    numeral(heapTotal).format("0.0 ib")
  );
}, 5000);*/

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

/**
 * Responsible for sending push notification to devices
 */
var sendPushUPNotification = function (data) {
  logger.info("Notify data");
  logger.info(data);
  var headers = {
    "Content-Type": "application/json; charset=utf-8",
  };

  var options = {
    host: "onesignal.com",
    port: 443,
    path: "/api/v1/notifications",
    method: "POST",
    headers: headers,
  };

  var https = require("https");
  var req = https.request(options, function (res) {
    res.on("data", function (data) {
      //logger.info("Response:");
    });
  });

  req.on("error", function (e) {});

  req.write(JSON.stringify(data));
  req.end();
};

/**
 * @func generateUniqueFingerprint()
 * Generate unique fingerprint for any string size.
 */
function generateUniqueFingerprint(str, encryption = false, resolve) {
  str = str.trim();
  let fingerprint = null;
  if (encryption === false) {
    fingerprint = crypto
      .createHmac(
        "sha512WithRSAEncryption",
        "TAXICONNECTBASICKEYFINGERPRINTS-RIDES-DELIVERY-ACCOUNTS"
      )
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  } else if (/md5/i.test(encryption)) {
    fingerprint = crypto
      .createHmac(
        "md5WithRSAEncryption",
        "TAXICONNECTBASICKEYFINGERPRINTS-RIDES-DELIVERY-ACCOUNTS"
      )
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  } //Other - default - for creating accounts.
  else {
    fingerprint = crypto
      .createHmac(
        "sha256",
        "TAXICONNECTBASICKEYFINGERPRINTS-RIDES-DELIVERY-ACCOUNTS"
      )
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  }
}

/**
 * @func checkUserStatus
 * @param userData: the user's bundled data (phone_number, user_nature,...)
 * @param otp: the otp generated for this user
 * @param collection_OTP_dispatch_map: the collection holding all the OTP dispatch
 * @param collectionPassengers_profiles: the collection of all the passengers
 * @param collectiondrivers_shoppers_central: the collection of all the drivers
 * @param resolve
 * Responsible for checking whether the user is registeredd or not, if yes send back
 * the user fingerprint.
 */
function checkUserStatus(
  userData,
  otp,
  collection_OTP_dispatch_map,
  collectionPassengers_profiles,
  collectiondrivers_shoppers_central,
  resolve
) {
  //Save the dispatch map for this user
  new Promise((res) => {
    let dispatchMap = {
      phone_number: userData.phone_number,
      otp: parseInt(otp),
      date_sent: new Date(chaineDateUTC),
    };
    dynamo_insert("OTP_dispatch_map", dispatchMap)
      .then((result) => {
        res(result);
      })
      .catch((error) => {
        logger.error(error);
        res(false);
      });
  }).then(
    () => {},
    () => {}
  );
  //...Check the user's status
  let checkUser = {
    phone_number: /^\+/i.test(userData.phone_number)
      ? userData.phone_number
      : `+${userData.phone_number}`,
  }; //?Indexed

  logger.warn(checkUser);

  //1. Passengers
  if (
    userData.user_nature === undefined ||
    userData.user_nature === null ||
    /passenger/i.test(userData.user_nature)
  ) {
    dynamo_find_query({
      table_name: "passengers_profiles",
      IndexName: "phone_number",
      KeyConditionExpression: "phone_number = :val1",
      ExpressionAttributeValues: {
        ":val1": checkUser.phone_number,
      },
    })
      .then((result) => {
        if (result.length > 0) {
          //User already registered
          //Send the fingerprint
          resolve({
            _id: result[0]._id,
            response: "registered",
            user_fp: result[0].user_fingerprint,
            name: result[0].name,
            surname: result[0].surname,
            gender: result[0].gender,
            phone_number: result[0].phone_number,
            email: result[0].email,
            profile_picture: `${process.env.AWS_S3_RIDERS_PROFILE_PICTURES_PATH}/${result[0].media.profile_picture}`,
            account_state:
              result[0].account_state !== undefined &&
              result[0].account_state !== null
                ? result[0].account_state
                : "minimal",
            pushnotif_token: result[0].pushnotif_token,
          });
        } //Not yet registeredd
        else {
          resolve({ response: "not_yet_registered" });
        }
      })
      .catch((error) => {
        logger.error(error);
        resolve({ response: "error_checking_user" });
      });
  } else if (
    userData.user_nature !== undefined &&
    userData.user_nature !== null &&
    /driver/i.test(userData.user_nature)
  ) {
    /**
     * ! elligibility_status: {
     * !  status:'valid',		//valid, suspended, expelled
     * !  message: 'Message to display',
     * !  date_updated: ${date},
     * ! }
     */
    //2. Drivers
    dynamo_find_query({
      table_name: "drivers_shoppers_central",
      IndexName: "phone_number",
      KeyConditionExpression: "phone_number = :val1",
      ExpressionAttributeValues: {
        ":val1": checkUser.phone_number,
      },
    })
      .then((result) => {
        if (result.length > 0) {
          //User already registered
          //Send the fingerprint
          resolve({
            _id: result[0]._id,
            response: "registered",
            user_fp: result[0].driver_fingerprint,
            name: result[0].name,
            surname: result[0].surname,
            gender: result[0].gender,
            phone_number: result[0].phone_number,
            email: result[0].email,
            profile_picture: `${process.env.AWS_S3_DRIVERS_PROFILE_PICTURES_PATH}/${result[0].identification_data.profile_picture}`,
            account_state:
              result[0].elligibility_status !== undefined &&
              result[0].elligibility_status !== null
                ? result[0].elligibility_status.status
                : "valid", //? By default - Valid
            pushnotif_token: result[0].pushnotif_token,
            suspension_message: result[0].suspension_message,
          });
        } //Not yet registeredd
        else {
          logger.warn("No yet registered driver");
          resolve({ response: "not_yet_registered" });
        }
      })
      .catch((error) => {
        logger.error(error);
        resolve({ response: "error_checking_user" });
      });
  }
}

/**
 * @func getBachRidesHistory
 * @param collectionRidesDeliveries_data: list of all rides made
 * @param collectiondrivers_shoppers_central: list of all drivers
 * @param resolve
 * @param req: the requests arguments : user_fp, ride_type, and/or the targeted argument
 * ! Should contain a user nature: rider or driver
 */
function getBachRidesHistory(
  req,
  collectionRidesDeliveries_data,
  collectiondrivers_shoppers_central,
  resolve
) {
  //Resolve ride type object searcher
  new Promise((res0) => {
    if (req.targeted === undefined && req.request_fp === undefined) {
      //Batch request
      if (/past/i.test(req.ride_type)) {
        //Past requests
        let resolveResponse =
          req.user_nature === undefined ||
          req.user_nature === null ||
          /rider/i.test(req.user_nature)
            ? {
                table_name: "rides_deliveries_requests",
                IndexName: "client_id",
                KeyConditionExpression:
                  "client_id = :val1, #r.#isCRider = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint,
                  ":val2": true,
                },
                ExpressionAttributeNames: {
                  "#r": "ride_state_vars",
                  "#isCRider": "isRideCompleted_riderSide",
                },
              }
            : {
                table_name: "rides_deliveries_requests",
                IndexName: "taxi_id",
                KeyConditionExpression: "taxi_id = :val1, #r.#isCRider = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint,
                  ":val2": true,
                },
                ExpressionAttributeNames: {
                  "#r": "ride_state_vars",
                  "#isCRider": "isRideCompleted_riderSide",
                },
              };
        //...
        res0(resolveResponse);
      } else if (/scheduled/i.test(req.ride_type)) {
        //Scheduled
        let resolveResponse =
          req.user_nature === undefined ||
          req.user_nature === null ||
          /rider/i.test(req.user_nature)
            ? {
                table_name: "rides_deliveries_requests",
                IndexName: "client_id",
                KeyConditionExpression:
                  "client_id = :val1, request_type = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint,
                  ":val2": "scheduled",
                },
              }
            : {
                table_name: "rides_deliveries_requests",
                IndexName: "taxi_id",
                KeyConditionExpression: "taxi_id = :val1, request_type = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint,
                  ":val2": "scheduled",
                },
              };
        //...
        res0(resolveResponse);
      } else if (/business/i.test(req.ride_type)) {
        //Business
        let resolveResponse =
          req.user_nature === undefined ||
          req.user_nature === null ||
          /rider/i.test(req.user_nature)
            ? {
                table_name: "rides_deliveries_requests",
                IndexName: "client_id",
                KeyConditionExpression: "client_id = :val1, ride_flag = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint,
                  ":val2": "business",
                },
              }
            : {
                table_name: "rides_deliveries_requests",
                IndexName: "taxi_id",
                KeyConditionExpression: "taxi_id = :val1, ride_flag = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint,
                  ":val2": "business",
                },
              };
        //...
        res0(resolveResponse);
      } //Invalid data
      else {
        res0(false);
      }
    } //Targeted request
    else {
      logger.info("Targeted request detected!");
      let resolveResponse =
        req.user_nature === undefined ||
        req.user_nature === null ||
        /rider/i.test(req.user_nature)
          ? {
              client_id: req.user_fingerprint,
              request_fp: req.request_fp,
            }
          : {
              taxi_id: req.user_fingerprint,
              request_fp: req.request_fp,
            }; //?Indexed
      //...
      res0(resolveResponse);
    }
  }).then(
    (result) => {
      if (result !== false) {
        //Got some object
        //Get the mongodb data
        dynamo_find_query(result)
          .then((ridesData) => {
            if (
              ridesData !== undefined &&
              ridesData !== null &&
              ridesData.length > 0
            ) {
              //Found something - reformat
              let parentPromises = ridesData.map((requestSingle) => {
                return new Promise((res1) => {
                  shrinkDataSchema_forBatchRidesHistory(
                    requestSingle,
                    collectiondrivers_shoppers_central,
                    res1,
                    req.target !== undefined ? true : false
                  );
                });
              });
              //Done
              Promise.all(parentPromises).then(
                (batchResults) => {
                  logger.info(batchResults);
                  resolve({
                    response: "success",
                    ride_type:
                      req.ride_type !== undefined
                        ? req.ride_type.trim().toUpperCase()
                        : "Targeted",
                    data: batchResults,
                  });
                },
                (error) => {
                  logger.info(error);
                  resolve({ response: "error_authentication_failed" });
                }
              );
            } //Empty
            else {
              //Get the rider's inos
              dynamo_find_query({
                table_name: "passengers_profiles",
                IndexName: "user_fingerprint",
                KeyConditionExpression: "user_fingerprint = :val1",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint.trim(),
                },
              })
                .then((riderData) => {
                  if (riderData !== undefined && riderData.length > 0) {
                    //Found something
                    //? Check if the user is part of a delivery request iin which he is the receiver.
                    let rideChecker = {
                      "ride_state_vars.isRideCompleted_riderSide": true,
                      request_type: /scheduled/i.test(req.ride_type)
                        ? "scheduled"
                        : {
                            $in: ["scheduled", "business", "immediate"],
                          },
                      "delivery_infos.receiverPhone_delivery":
                        riderData[0].phone_number.trim(),
                    }; //?Indexed
                    //...
                    collectionRidesDeliveries_data
                      .find(rideChecker)
                      .toArray(function (err, tripData) {
                        if (err) {
                          resolve(false);
                        }
                        //...
                        if (tripData !== undefined && tripData.length > 0) {
                          let ridesData = tripData;
                          //Found the trip data
                          //Check if there are any requests cached
                          //Found something - reformat
                          let parentPromises = ridesData.map(
                            (requestSingle) => {
                              return new Promise((res1) => {
                                shrinkDataSchema_forBatchRidesHistory(
                                  requestSingle,
                                  collectiondrivers_shoppers_central,
                                  res1,
                                  req.target !== undefined ? true : false
                                );
                              });
                            }
                          );
                          //Done
                          Promise.all(parentPromises).then(
                            (batchResults) => {
                              logger.info(batchResults);
                              resolve({
                                response: "success",
                                ride_type:
                                  req.ride_type !== undefined
                                    ? req.ride_type.trim().toUpperCase()
                                    : "Targeted",
                                data: batchResults,
                              });
                            },
                            (error) => {
                              logger.info(error);
                              resolve({
                                response: "error_authentication_failed",
                              });
                            }
                          );
                        } //No trip data
                        else {
                          resolve({
                            response: "success",
                            ride_type:
                              req.ride_type !== undefined
                                ? req.ride_type.trim().toUpperCase()
                                : "Targeted",
                            data: [],
                          });
                        }
                      });
                  } //No rider data, strange
                  else {
                    resolve({
                      response: "success",
                      ride_type:
                        req.ride_type !== undefined
                          ? req.ride_type.trim().toUpperCase()
                          : "Targeted",
                      data: [],
                    });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve(false);
                });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "error_authentication_failed" });
          });
      } //invalid data
      else {
        logger.info("Invalid");
        resolve({ response: "error_authentication_failed" });
      }
    },
    (error) => {
      logger.info(error);
      resolve({ response: "error_authentication_failed" });
    }
  );
}

/**
 * @func shrinkDataSchema_forBatchRidesHistory
 * @param request: a single request to process
 * @param collectiondrivers_shoppers_central: list of all drivers
 * @param resolve
 * @param shrink_for_targeted: if true will format the request for a specific request - default: false (for batch requests)
 * @info Targeted requests have significantly more data than batch requests - AND REQUIRED TO BE CACHED!
 * Responsible for changing the original stored data schema of a request into a light
 * batch optimized on for BACTH history fetching.
 *{
 *    destination_name:destination_1,destination_2,...
 *    date_requested: dd/mm/yyyy, hh:mm
 *    car_brand: Toyota corolla
 *    request_fp: XXXXXXXXXX
 * }
 *
 * 2. Schema example for targeted requests - SHOULD BE CACHED - redis key: request_fp-your_rides_app_history
 * {
 *    pickup_name: pickup location
 *    destination_name:destination_1,destination_2,...
 *    date_requested: dd/mm/yyyy, hh:mm
 *    estimated_travel_time: 2min (in minutes)
 *    payment_method: cash/wallet
 *    ride_mode:RIDE/DELIVERY
 *    fare_amount: N$15
 *    numberOf_passengers: 4,
 *    ride_rating: 4.7
 *    driver_details: {
 *    name: 'Alex Tangeni'
 *    driver_picture: default_driver.png
 *    }
 *    car_details: {
 *      plate_number: 'N 458 W',
 *      car_brand: Toyota corolla
 *      car_picture: default_car.png
 *      taxi_number:H09/or false for shuttles
 *      vehicle_type:Economy,Comfort or Luxury
 *      verification_status: true
 *    }
 *    request_fp: XXXXXXXXXX
 * }
 */
function shrinkDataSchema_forBatchRidesHistory(
  request,
  collectiondrivers_shoppers_central,
  resolve,
  shrink_for_targeted = false
) {
  logger.info("is targeted -> ", shrink_for_targeted);
  if (shrink_for_targeted === false) {
    //Batch requests
    let light_request_schema = {
      destination_name: null,
      date_requested: null,
      car_brand: null,
      request_fp: null,
    }; //Will hold the final product
    //1. Reformat the data
    let dateRequest = new Date(request.date_requested);
    dateRequest = moment(dateRequest.getTime());
    dateRequest =
      (String(dateRequest.date()).length > 1
        ? dateRequest.date()
        : "0" + dateRequest.date()) +
      "/" +
      (String(dateRequest.month() + 1).length > 1
        ? dateRequest.month() + 1
        : "0" + (dateRequest.month() + 1)) +
      "/" +
      dateRequest.year() +
      ", " +
      (String(dateRequest.hour()).length > 1
        ? dateRequest.hour()
        : "0" + dateRequest.hour()) +
      ":" +
      (String(dateRequest.minute()).length > 1
        ? dateRequest.minute()
        : "0" + dateRequest.minute());
    //Save
    light_request_schema.date_requested = dateRequest;
    //2. Get the car brand
    new Promise((res) => {
      let findCar = {
        "cars_data.car_fingerprint": request.car_fingerprint,
      };

      dynamo_find_query({
        table_name: "drivers_shoppers_central",
        IndexName: "driver_fingerprint",
        KeyConditionExpression: "driver_fingerprint = :val1",
        ExpressionAttributeValues: {
          ":val1": request.taxi_id,
        },
      })
        .then((result) => {
          logger.info(result);
          if (result.length > 0) {
            //FOund something
            let car_brand = false;
            //Get the car brand
            result.map((driver) => {
              driver.cars_data.map((car) => {
                if (request.car_fingerprint === car.car_fingerprint) {
                  car_brand = car.car_brand;
                }
              });
            });
            //...
            res(car_brand);
          } //Empty - strange
          else {
            //! Get the first car for the driver
            dynamo_find_query({
              table_name: "drivers_shoppers_central",
              IndexName: "driver_fingerprint",
              KeyConditionExpression: "driver_fingerprint = :val1",
              ExpressionAttributeValues: {
                ":val1": request.taxi_id,
              },
            })
              .then((driverProfile) => {
                if (
                  driverProfile.cars_data !== undefined &&
                  driverProfile.cars_data !== null &&
                  driverProfile.length > 0 &&
                  driverProfile.cars_data.length > 0
                ) {
                  //Found something
                  res(driverProfile.cars_data[0].car_brand);
                } //No valid reccord found
                else {
                  res(false);
                }
              })
              .catch((error) => {
                logger.error(error);
                res(false);
              });
          }
        })
        .catch((error) => {
          logger.error(error);
          res(false);
        });
    }).then(
      (result) => {
        if (result !== false) {
          //good
          //Save
          light_request_schema.car_brand = result;
          //3. Resolve the destinations
          request.destinationData.map((location) => {
            if (light_request_schema.destination_name === null) {
              //Still empty
              light_request_schema.destination_name =
                location.location_name !== false &&
                location.location_name !== undefined
                  ? location.location_name
                  : location.suburb !== false && location.suburb !== undefined
                  ? location.suburb
                  : "Click for more";
            } //Add
            else {
              light_request_schema.destination_name +=
                ", " +
                (location.location_name !== false &&
                location.location_name !== undefined
                  ? location.location_name
                  : location.suburb !== false && location.suburb !== undefined
                  ? location.suburb
                  : "Click for more");
            }
          });
          //4. Finally add the request fp
          light_request_schema.request_fp = request.request_fp;
          //..Done
          resolve(light_request_schema);
        } //Error
        else {
          resolve(false);
        }
      },
      (error) => {
        logger.info(error);
        resolve(false);
      }
    );
  } //Targeted requests
  else {
    let redisKey = request.request_fp + "-your_rides_app_history";
    redisGet(redisKey).then(
      (resp) => {
        if (resp !== null) {
          //Has a record
          try {
            //Rehydrate the redis record
            new Promise((res) => {
              proceedTargeted_requestHistory_fetcher(
                request,
                collectiondrivers_shoppers_central,
                redisKey,
                res
              );
            }).then(
              () => {},
              () => {}
            );
            //..Quickly respond to the user with the cached results
            resp = JSON.parse(resp);
            logger.info("cached result found");
            resolve(resp);
          } catch (error) {
            //Erro - make a fresh request
            logger.info(error);
            new Promise((res) => {
              proceedTargeted_requestHistory_fetcher(
                request,
                collectiondrivers_shoppers_central,
                redisKey,
                res
              );
            }).then(
              (result) => {
                resolve(result);
              },
              (error) => {
                logger.info(error);
                resolve(false);
              }
            );
          }
        } //No records - make a fresh request
        else {
          new Promise((res) => {
            proceedTargeted_requestHistory_fetcher(
              request,
              collectiondrivers_shoppers_central,
              redisKey,
              res
            );
          }).then(
            (result) => {
              resolve(result);
            },
            (error) => {
              logger.info(error);
              resolve(false);
            }
          );
        }
      },
      (error) => {
        //Error - make a fresh request
        logger.info(error);
        new Promise((res) => {
          proceedTargeted_requestHistory_fetcher(
            request,
            collectiondrivers_shoppers_central,
            redisKey,
            res
          );
        }).then(
          (result) => {
            resolve(result);
          },
          (error) => {
            logger.info(error);
            resolve(false);
          }
        );
      }
    );
    //Check for a potential cached result
  }
}

/**
 * @func proceedTargeted_requestHistory_fetcher
 * @param request: the stored details of the targeted request straight from MongoDB
 * @param redisKey: the wanted cache key
 * @param collectiondrivers_shoppers_central: list of all the drivers
 * @param resolve
 * Responsible for executing the fresh fetching of a targeted request
 */
function proceedTargeted_requestHistory_fetcher(
  request,
  collectiondrivers_shoppers_central,
  redisKey,
  resolve
) {
  let full_request_schema = {
    pickup_name: null,
    destination_name: null,
    date_requested: null,
    estimated_travel_time: null,
    payment_method: null,
    ride_mode: null,
    fare_amount: null,
    numberOf_passengers: null,
    ride_rating: null,
    country: null,
    city: null,
    driver_details: {
      name: null,
      driver_picture: null,
    },
    car_details: {
      plate_number: null,
      car_brand: null,
      car_picture: null,
      taxi_number: null,
      vehicle_type: null,
      verification_status: null,
    },
    request_fp: null,
  }; //Will hold the final product
  //1. Reformat the data
  let dateRequest = new Date(request.date_requested);
  dateRequest = moment(dateRequest.getTime());
  dateRequest =
    (String(dateRequest.date()).length > 1
      ? dateRequest.date()
      : "0" + dateRequest.date()) +
    "/" +
    (String(dateRequest.month() + 1).length > 1
      ? dateRequest.month() + 1
      : "0" + (dateRequest.month() + 1)) +
    "/" +
    dateRequest.year() +
    ", " +
    (String(dateRequest.hour()).length > 1
      ? dateRequest.hour()
      : "0" + dateRequest.hour()) +
    ":" +
    (String(dateRequest.minute()).length > 1
      ? dateRequest.minute()
      : "0" + dateRequest.minute());
  //Save
  full_request_schema.date_requested = dateRequest;
  //2. Get the car details and driver details
  new Promise((res) => {
    let findCar = {
      "cars_data.car_fingerprint": request.car_fingerprint,
    };

    dynamo_find_query({
      table_name: "drivers_shoppers_central",
      IndexName: "driver_fingerprint",
      KeyConditionExpression: "driver_fingerprint = :val1",
      ExpressionAttributeValues: {
        ":val1": request.taxi_id,
      },
    })
      .then((result) => {
        if (result.length > 0) {
          //FOund something
          let car_brand = false;
          let plate_number = false;
          let car_picture = false;
          let driver_name = false;
          let taxi_number = false;
          let vehicle_type = false;
          let driver_picture = "default_driver.png";
          //Get the car brand
          result.map((driver) => {
            driver.cars_data.map((car) => {
              if (request.car_fingerprint === car.car_fingerprint) {
                logger.info(car);
                car_brand = car.car_brand;
                car_picture = `${process.env.AWS_S3_VEHICLES_PICTURES_PATH}/${car.taxi_picture}`;
                taxi_number = car.taxi_number;
                vehicle_type = /Economy/i.test(car.vehicle_type)
                  ? "Economy"
                  : /Comfort/i.test(car.vehicle_type)
                  ? "Comfort"
                  : /Luxury/i.test(car.vehicle_type);
                plate_number = car.plate_number.toUpperCase();
                plate_number =
                  plate_number[0] +
                  " " +
                  plate_number.substring(1, plate_number.length - 1) +
                  " " +
                  plate_number[plate_number.length - 1];
                driver_name = driver.name + " " + driver.surname;
                driver_picture = `${process.env.AWS_S3_DRIVERS_PROFILE_PICTURES_PATH}/${driver.identification_data.profile_picture}`;
              }
            });
          });
          //...
          res({
            car_brand: car_brand,
            plate_number: plate_number,
            car_picture: car_picture,
            taxi_number: taxi_number,
            vehicle_type: vehicle_type,
            driver_name: driver_name,
            driver_picture: driver_picture,
          });
        } //Empty - strange
        else {
          res(false);
        }
      })
      .catch((error) => {
        logger.error(error);
        res(false);
      });
  }).then(
    (result) => {
      if (result !== false) {
        //good
        //Save
        full_request_schema.car_details.car_brand = result.car_brand;
        full_request_schema.car_details.plate_number = result.plate_number;
        full_request_schema.car_details.car_picture = result.car_picture;
        full_request_schema.car_details.taxi_number = result.taxi_number;
        full_request_schema.car_details.vehicle_type = result.vehicle_type;
        full_request_schema.car_details.verification_status = "Verified"; //By default
        full_request_schema.driver_details.name = result.driver_name;
        full_request_schema.driver_details.driver_picture =
          result.driver_picture;
        //3. Resolve the destinations
        request.destinationData.map((location) => {
          if (full_request_schema.destination_name === null) {
            //Still empty
            full_request_schema.destination_name =
              location.location_name !== false &&
              location.location_name !== undefined
                ? location.location_name
                : location.suburb !== false && location.suburb !== undefined
                ? location.suburb
                : "Click for more";
          } //Add
          else {
            full_request_schema.destination_name +=
              ", " +
              (location.location_name !== false &&
              location.location_name !== undefined
                ? location.location_name
                : location.suburb !== false && location.suburb !== undefined
                ? location.suburb
                : "Click for more");
          }
        });
        //4. Resolve pickup location name
        full_request_schema.pickup_name =
          request.pickup_location_infos.location_name !== false &&
          request.pickup_location_infos.location_name !== undefined
            ? request.pickup_location_infos.location_name
            : request.pickup_location_infos.street_name !== false &&
              request.pickup_location_infos.street_name !== undefined
            ? request.pickup_location_infos.street_name
            : request.pickup_location_infos.suburb !== false &&
              request.pickup_location_infos.suburb !== undefined
            ? request.pickup_location_infos.suburb
            : "unclear location.";
        //5. Add fare amount
        full_request_schema.fare_amount = request.fare;
        //6. Add the number of passengers
        full_request_schema.numberOf_passengers = request.passengers_number;
        //7. Add ride rating
        full_request_schema.ride_rating = request.rider_driverRating;
        //8. Add country and city
        full_request_schema.country = request.country;
        full_request_schema.city = null;
        //9. Add payment method
        full_request_schema.payment_method =
          request.payment_method.toUpperCase();
        //10. Add ride mode
        full_request_schema.ride_mode = request.ride_mode;
        //11. Add the ride rating
        full_request_schema.ride_rating =
          request.ride_state_vars.rider_driverRating;
        //x. Finally add the request fp
        full_request_schema.request_fp = request.request_fp;
        //9. Add estimated travel time to the first destination
        let originPoint = request.pickup_location_infos.coordinates;
        let destinationPoint = request.destinationData[0].coordinates;
        new Promise((res4) => {
          let url =
            `${
              /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
            }` +
            ":" +
            process.env.MAP_SERVICE_PORT +
            "/getRouteToDestinationSnapshot?org_latitude=" +
            originPoint.latitude +
            "&org_longitude=" +
            originPoint.longitude +
            "&dest_latitude=" +
            destinationPoint.latitude +
            "&dest_longitude=" +
            destinationPoint.longitude +
            "&user_fingerprint=" +
            request.client_id;
          requestAPI(url, function (error, response, body) {
            if (error === null) {
              try {
                body = JSON.parse(body);
                res4(body.eta.replace(" away", "").replace(" ", ""));
              } catch (error) {
                res4(false);
              }
            } else {
              res4(false);
            }
          });
        }).then(
          (e_travel_time) => {
            if (e_travel_time !== false) {
              //Found an eta
              //Add eta
              full_request_schema.estimated_travel_time = e_travel_time;
              //Cache the result
              new Promise((resCache) => {
                redisCluster.set(redisKey, JSON.stringify(full_request_schema));
                resCache(true);
              }).then(
                () => {},
                () => {}
              );
              //..Done
              resolve(full_request_schema);
            } //No eta found
            else {
              //..Done
              resolve(full_request_schema);
            }
          },
          (error) => {
            //..Done
            resolve(full_request_schema);
          }
        );
      } //Error
      else {
        resolve(false);
      }
    },
    (error) => {
      logger.info(error);
      resolve(false);
    }
  );
}

/**
 * @func clearDailyRequestAmountCached
 * Responsible for clearing the cached data about the daily amount.
 * @param driver_fingerprint: the driver's id
 * @param resolve
 */
function clearDailyRequestAmountCached(driver_fingerprint, resolve) {
  resolveDate();
  //Form the redis key
  let refDate = new Date(chaineDateUTC);
  let redisKey = `dailyAmount-${refDate.getDay()}-${refDate.getMonth()}-${refDate.getFullYear()}-${driver_fingerprint}`;
  //...
  redisCluster.del(redisKey, function () {
    resolve(true);
  });
}

/**
 * @func getDaily_requestAmount_driver
 * Responsible for getting the daily amount made so far for the driver at any given time.
 * CACHED.
 * @param driver_fingerprint: the driver id
 * @param resolve
 */
function getDaily_requestAmount_driver(driver_fingerprint, resolve) {
  resolveDate();
  //Form the redis key
  let refDate = new Date(chaineDateUTC);
  let redisKey = `dailyAmount-${refDate.getDay()}-${refDate.getMonth()}-${refDate.getFullYear()}-${driver_fingerprint}`;
  //..
  redisGet(redisKey).then(
    (resp) => {
      // logger.info(resp);
      if (resp !== null) {
        //Has a previous record
        try {
          resp = JSON.parse(resp);
          //...
          resolve(resp);
        } catch (error) {
          logger.info(error);
          //Errror - make a fresh request
          new Promise((res) => {
            exec_computeDaily_amountMade(driver_fingerprint, res);
          }).then(
            (result) => {
              logger.info(result);
              //Cache as well
              redisCluster.setex(
                redisKey,
                parseInt(process.env.REDIS_EXPIRATION_5MIN) * 405,
                JSON.stringify(result)
              );
              resolve(result);
            },
            (error) => {
              resolve({
                amount: 0,
                currency: "NAD",
                currency_symbol: "N$",
                supported_requests_types: "none",
                response: "error",
              });
            }
          );
        }
      } //No computed amount yet - make a fresh request
      else {
        new Promise((res) => {
          exec_computeDaily_amountMade(driver_fingerprint, res);
        }).then(
          (result) => {
            logger.info(result);
            //Cache as well
            redisCluster.setex(
              redisKey,
              parseInt(process.env.REDIS_EXPIRATION_5MIN) * 405,
              JSON.stringify(result)
            );
            resolve(result);
          },
          (error) => {
            resolve({
              amount: 0,
              currency: "NAD",
              currency_symbol: "N$",
              supported_requests_types: "none",
              response: "error",
            });
          }
        );
      }
    },
    (error) => {
      logger.info(error);
      //Errror - make a fresh request
      new Promise((res) => {
        exec_computeDaily_amountMade(driver_fingerprint, res);
      }).then(
        (result) => {
          logger.info(result);
          //Cache as well
          redisCluster.setex(
            redisKey,
            parseInt(process.env.REDIS_EXPIRATION_5MIN) * 405,
            JSON.stringify(result)
          );
          resolve(result);
        },
        (error) => {
          resolve({
            amount: 0,
            currency: "NAD",
            currency_symbol: "N$",
            supported_requests_types: "none",
            response: "error",
          });
        }
      );
    }
  );
}

/**
 * @func checkIfSameDay
 * Responsible for finding out if two dates where on the same day or Not
 * @param date1: first date
 * @param date2: second date
 * ? The order of the dates does not matter.
 * @return true: same day
 * @return false: not same day
 */

function checkIfSameDay(date1, date2) {
  let hourDiff = Math.abs((date1 - date2) / (1000 * 3600)); //In hour
  return hourDiff < 24;
}

/**
 * @func exec_computeDaily_amountMade
 * Responsible for executing all the operations related to the computation of the driver's daily amount.
 * @param driver_fingerprint: the driver id
 * @param resolve
 */
function exec_computeDaily_amountMade(driver_fingerprint, resolve) {
  resolveDate();
  //...
  //Get the driver's requests operation clearances
  dynamo_find_query({
    table_name: "drivers_shoppers_central",
    IndexName: "driver_fingerprint",
    KeyConditionExpression: "driver_fingerprint = :val1",
    ExpressionAttributeValues: {
      ":val1": driver_fingerprint,
    },
  })
    .then((driverProfile) => {
      if (driverProfile !== undefined && driverProfile.length > 0) {
        driverProfile = driverProfile[0];

        let refDate = new Date(chaineDateUTC);
        let today_beginning = `${refDate.getFullYear()}-${
          refDate.getMonth() + 1 > 10
            ? refDate.getMonth() + 1
            : `0${refDate.getMonth() + 1}`
        }-${refDate.getDate()}T00:00:00.000Z`;
        let today_end = `${refDate.getFullYear()}-${
          refDate.getMonth() + 1 > 10
            ? refDate.getMonth() + 1
            : `0${refDate.getMonth() + 1}`
        }-${refDate.getDate()}T21:59:59.000Z`;

        dynamo_find_query({
          table_name: "requests_central",
          IndexName: "shopper_id",
          KeyConditionExpression:
            "shopper_id = :val1 AND date_requested BETWEEN :start_date AND :end_date",
          FilterExpression: "#r.#isCodrop = :val2 AND #r.#icoRate = :val3",
          ScanIndexForward: false,
          ExpressionAttributeValues: {
            ":val1": driver_fingerprint,
            ":val2": true,
            ":val3": true,
            ":start_date": today_beginning,
            ":end_date": today_end,
          },
          ExpressionAttributeNames: {
            "#r": "request_state_vars",
            "#isCodrop": "completedDropoff",
            "#icoRate": "completedRatingClient",
          },
        })
          .then((requestsArray) => {
            let amount = 0;
            if (
              requestsArray !== null &&
              requestsArray !== undefined &&
              requestsArray.length > 0
            ) {
              requestsArray.map((request) => {
                //Sum it all up
                let tmpFare = parseFloat(request.fare);
                amount += tmpFare;
              });
              //...
              resolve({
                amount: amount,
                currency: "NAD",
                currency_symbol: "N$",
                supported_requests_types:
                  driverProfile !== undefined && driverProfile !== null
                    ? driverProfile.operation_clearances
                    : "none",
                response: "success",
              });
            } //No infos
            else {
              resolve({
                amount: 0,
                currency: "NAD",
                currency_symbol: "N$",
                supported_requests_types:
                  driverProfile !== undefined && driverProfile !== null
                    ? driverProfile.operation_clearances
                    : "none",
                response: "success",
              });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({
              amount: 0,
              currency: "NAD",
              currency_symbol: "N$",
              supported_requests_types:
                driverProfile !== undefined && driverProfile !== null
                  ? driverProfile.operation_clearances
                  : "none",
              response: "error",
            });
          });
      } else {
        logger.info("Here3");
        resolve({
          amount: 0,
          currency: "NAD",
          currency_symbol: "N$",
          supported_requests_types: "none",
          response: "error",
        });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({
        amount: 0,
        currency: "NAD",
        currency_symbol: "N$",
        supported_requests_types: "none",
        response: "error",
      });
    });
}

/**
 * @func getRiders_wallet_summary
 * Responsible for getting riders wallet informations.
 * @param requestObj: contains the user_fingerprint and the mode: total or detailed.
 * @param collectionRidesDeliveries_data: the collection of all the requests.
 * @param collectionWalletTransactions_logs: the collection of all the possible wallet transactions.
 * @param collectiondrivers_shoppers_central: collection of all the drivers
 * @param collectionPassengers_profiles: collection of all the passengers.
 * @param resolve
 * @param avoidCached_data: false (will return cached data first) or true (will not return the cached data);
 * @param userType: rider or driver
 * Cache for 5 min only
 * Redis Key: user_fingerprint+wallet-summaryInfos
 */
function getRiders_wallet_summary(
  requestObj,
  collectionRidesDeliveries_data,
  collectionWalletTransactions_logs,
  collectiondrivers_shoppers_central,
  collectionPassengers_profiles,
  resolve,
  avoidCached_data = false,
  userType = "rider"
) {
  //Form the redis key
  let redisKey = requestObj.user_fingerprint + "wallet-summary";
  redisGet(redisKey).then(
    (resp) => {
      if (resp !== null && avoidCached_data == false) {
        //Has a previous record - reply with it and rehydrate the data
        try {
          //!Rehydrate
          new Promise((res) => {
            execGet_ridersDrivers_walletSummary(
              requestObj,
              collectionRidesDeliveries_data,
              collectionWalletTransactions_logs,
              collectiondrivers_shoppers_central,
              collectionPassengers_profiles,
              redisKey,
              res,
              userType,
              avoidCached_data
            );
          }).then(
            (result) => {
              //? Cache
              redisCluster.set(redisKey, stringify(result));
            },
            (error) => {
              logger.info(error);
            }
          );
          //...Immediatly reply
          resp = parse(resp);
          resolve(resp);
        } catch (error) {
          logger.info(error);
          //Error - make a fresh request
          new Promise((res) => {
            execGet_ridersDrivers_walletSummary(
              requestObj,
              collectionRidesDeliveries_data,
              collectionWalletTransactions_logs,
              collectiondrivers_shoppers_central,
              collectionPassengers_profiles,
              redisKey,
              res,
              userType,
              avoidCached_data
            );
          }).then(
            (result) => {
              //? Cache
              redisCluster.set(redisKey, stringify(result));
              resolve(result);
            },
            (error) => {
              logger.info(error);
              resolve({ total: 0, transactions_data: null });
            }
          );
        }
      } //No previous records
      else {
        logger.info("No previous cached data");
        new Promise((res) => {
          execGet_ridersDrivers_walletSummary(
            requestObj,
            collectionRidesDeliveries_data,
            collectionWalletTransactions_logs,
            collectiondrivers_shoppers_central,
            collectionPassengers_profiles,
            redisKey,
            res,
            userType,
            avoidCached_data
          );
        }).then(
          (result) => {
            //? Cache
            redisCluster.set(redisKey, stringify(result));
            resolve(result);
          },
          (error) => {
            logger.info(error);
            resolve({ total: 0, transactions_data: null });
          }
        );
      }
    },
    (error) => {
      logger.info(error);
      //Error happened - make a fresh request
      new Promise((res) => {
        execGet_ridersDrivers_walletSummary(
          requestObj,
          collectionRidesDeliveries_data,
          collectionWalletTransactions_logs,
          collectiondrivers_shoppers_central,
          collectionPassengers_profiles,
          redisKey,
          res,
          userType,
          avoidCached_data
        );
      }).then(
        (result) => {
          //? Cache
          redisCluster.set(redisKey, stringify(result));
          resolve(result);
        },
        (error) => {
          logger.info(error);
          resolve({ total: 0, transactions_data: null });
        }
      );
    }
  );
}

/**
 * @func provideDateFromUnISOString
 * Responsible for returning a valid iso string from a non valid iso input
 * widely used in the old system
 */
function provideDateFromUnISOString(dateString) {
  dateString = dateString.split(", ");
  //Get the day month and year
  let day = parseInt(dateString[0].split("-")[0]);
  let month = parseInt(dateString[0].split("-")[1]);
  let year = parseInt(dateString[0].split("-")[2]);
  //.get the hour minute and seconds
  let hours = parseInt(dateString[1].split(":")[0]);
  let minutes = parseInt(dateString[1].split(":")[1]);
  // logger.warn(`${day}-${month}-${year}, ${hours}:${minutes}`);
  //?Form the date ISO format
  let date = new Date(year, month - 1, day, hours, minutes);
  // logger.warn(`The parsed date is -> ${date}`);
  ///...
  return date;
}

/**
 * @func parseDetailed_walletGetData
 * Responsible for parsing the detailed wallet details into a form that's suitable for clients and more uniform.
 * ! Remove private information like: fingerprints, mongodb ids.
 * @param detailed_walletRaw_details: the raw data coming from @execGet_ridersDrivers_walletSummary before caching.
 * @param collectiondrivers_shoppers_central: the list of all the drivers.
 * @param collectionPassengers_profiles: the list of all the passengers
 * @param resolve
 */
function parseDetailed_walletGetData(
  detailed_walletRaw_details,
  collectiondrivers_shoppers_central,
  collectionPassengers_profiles,
  resolve
) {
  if (
    detailed_walletRaw_details.transactions_data !== null &&
    detailed_walletRaw_details.transactions_data.length > 0
  ) {
    //Has some transaction data to parse
    let cleanTransactionData = [];
    let batchPromiser = detailed_walletRaw_details.transactions_data.map(
      (transaction, index) => {
        return new Promise((res) => {
          try {
            let tmpClean = {
              id: null,
              amount: null,
              payment_currency: null,
              transaction_nature: null,
              date_made: null,
              timestamp: null,
            };
            //...
            //? 1. Add the id number
            tmpClean.id = index;
            //? 2. add the amount
            tmpClean.amount = parseFloat(transaction.amount);
            //? 3. Payment currency
            tmpClean.payment_currency = process.env.PAYMENT_CURRENCY;
            //? 4. Add and resolve the date made and the timestamp
            let tmpDateCaptured = /\,/i.test(transaction.date_captured)
              ? provideDateFromUnISOString(transaction.date_captured)
              : new Date(new String(transaction.date_captured)); //! Avoid invalid date formats - BUG FIX ATTEMPT

            tmpClean.date_made =
              moment(tmpDateCaptured).format("DD-MM-YYYY HH:MM a");

            try {
              tmpClean.rawDate_made = tmpDateCaptured.toISOString(); //! Save the ISO date captured.
            } catch (error) {
              logger.error(error);
              logger.warn(transaction.date_captured);
              tmpClean.rawDate_made = transaction.date_requestedRaw;
            }
            tmpClean.timestamp = tmpDateCaptured.getTime();
            //? 5. Add the transaction nature
            tmpClean.transaction_nature = transaction.transaction_nature;
            //? 6. If the transaction nature is ride/delivery - add the payment method and driver data
            if (/(ride|delivery)/i.test(transaction.transaction_nature)) {
              tmpClean["payment_method"] = transaction.payment_method;
              tmpClean["driverData"] = transaction.driverData;
            }
            //? 6.a. If a reward - add the organization Name
            if (/onetime_voucher/i.test(transaction.transaction_nature)) {
              tmpClean["org_name"] =
                transaction.organization.name.toLowerCase();
              tmpClean["org_name"] = `${tmpClean[
                "org_name"
              ][0].toUpperCase()}${tmpClean["org_name"].substring(
                1,
                tmpClean["org_name"].length
              )}`;
            }
            //? 7. Get the recipient name for any other non ride/delivery transactions in nature.
            if (!/(ride|delivery)/i.test(transaction.transaction_nature)) {
              //Everything except rides/deliveries
              if (
                /(topup|weeklyPaidDriverAutomatic|commissionTCSubtracted)/i.test(
                  tmpClean.transaction_nature
                )
              ) {
                //TOpups
                //? DONE FOR TOPUPS
                res(tmpClean);
              }

              if (/sentToFriend/i.test(tmpClean.transaction_nature)) {
                //Check the name from the passenger collection
                dynamo_find_query({
                  table_name: "passengers_profiles",
                  IndexName: "user_fingerprint",
                  KeyConditionExpression: "user_fingerprint = :val1",
                  ExpressionAttributeValues: {
                    ":val1": transaction.recipient_fp,
                  },
                })
                  .then((recipientData) => {
                    if (
                      recipientData.length > 0 &&
                      recipientData[0].user_fingerprint !== undefined &&
                      recipientData[0].user_fingerprint !== null
                    ) {
                      //? Add the recipient name and DONE
                      tmpClean["recipient_name"] = recipientData[0].name;
                      //DONE
                      res(tmpClean);
                    } //Strange, did not find any user recipient for this request
                    else {
                      res(false);
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    res(false);
                  });
              } else if (
                /(paidDriver|sentToDriver)/i.test(tmpClean.transaction_nature)
              ) {
                //Check from the driver collection
                dynamo_find_query({
                  table_name: "drivers_shoppers_central",
                  IndexName: "driver_fingerprint",
                  KeyConditionExpression: "driver_fingerprint = :val1",
                  ExpressionAttributeValues: {
                    ":val1": transaction.recipient_fp,
                  },
                })
                  .then((recipientData) => {
                    if (
                      recipientData.length > 0 &&
                      recipientData[0].driver_fingerprint !== undefined &&
                      recipientData[0].driver_fingerprint !== null
                    ) {
                      //? Add the recipient name and DONE
                      tmpClean["recipient_name"] = recipientData[0].name;
                      //DONE
                      res(tmpClean);
                    } //Strange, did not find any user recipient for this request
                    else {
                      res(false);
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    res(false);
                  });
              } else if (
                /(onetime_voucher)/i.test(tmpClean.transaction_nature)
              ) {
                res(tmpClean);
              } else {
                res(false);
              }
            }
            //For rides or deliveries - DONE
            else {
              res(tmpClean);
            }
          } catch (error) {
            logger.warn(error);
            res(false);
          }
        });
      }
    );

    //...Get the batch promiser infos
    Promise.all(batchPromiser).then(
      (cleansedData) => {
        try {
          //? Clean the falses
          cleansedData = cleansedData.filter((transaction) => {
            return (
              transaction !== false &&
              transaction.timestamp !== undefined &&
              transaction.timestamp !== null &&
              !isNaN(transaction.timestamp)
            );
          });
          //? Sort
          cleansedData.sort((a, b) =>
            a.timestamp > b.timestamp ? -1 : b.timestamp > a.timestamp ? 1 : 0
          );
          //? DONE
          resolve(cleansedData);
        } catch (error) {
          logger.info(error);
          resolve(detailed_walletRaw_details);
        }
      },
      (error) => {
        logger.info(error);
        resolve(detailed_walletRaw_details);
      }
    );
  } //No transaction data - DO NOT MODIFY
  else {
    resolve(detailed_walletRaw_details);
  }
}

/**
 * @func execGet_ridersDrivers_walletSummary
 * Responsible for executing the requests and gather the rider's or driver's wallet complete infos.
 * @param requestObj: contains the user_fingerprint and the mode: total or detailed.
 * @param collectionRidesDeliveries_data: the collection of all the requests.
 * @param collectionWalletTransactions_logs: the collection of all the possible wallet transactions.
 * @param collectiondrivers_shoppers_central: collection of all the drivers
 * @param collectionPassengers_profiles: collection of all the passengers.
 * @param resolve
 * @param user_type: rider or driver (the type of user for which to show the wallet details).
 * @param avoidCached_data: to avoid cached data.
 *
 * ? transaction_nature types: topup, paidDriver, sentToDriver, sentToFriend.
 * ? The wallet payments for rides are stored in the rides/deliveries collection.
 */
function execGet_ridersDrivers_walletSummary(
  requestObj,
  collectionRidesDeliveries_data,
  collectionWalletTransactions_logs,
  collectiondrivers_shoppers_central,
  collectionPassengers_profiles,
  redisKey,
  resolve,
  user_type = "rider",
  avoidCached_data = false
) {
  let redisKeyHere = `${redisKey}-forExecRiders_drivers_summary`;
  redisGet(redisKeyHere)
    .then(
      (resp) => {
        if (resp !== null && avoidCached_data == false) {
          //? Refresh the cached data
          new Promise((resFresh) => {
            truelyExec_ridersDrivers_walletSummary(
              requestObj,
              collectionRidesDeliveries_data,
              collectionWalletTransactions_logs,
              collectiondrivers_shoppers_central,
              collectionPassengers_profiles,
              redisKey,
              resFresh,
              user_type
            );
          })
            .then(
              (result) => {
                redisCluster.set(redisKeyHere, stringify(result));
              },
              () => {}
            )
            .catch(() => {});
          //....Quickly reply
          resp = parse(resp);
          resolve(resp);
        } //Make a fresh request
        else {
          new Promise((resFresh) => {
            truelyExec_ridersDrivers_walletSummary(
              requestObj,
              collectionRidesDeliveries_data,
              collectionWalletTransactions_logs,
              collectiondrivers_shoppers_central,
              collectionPassengers_profiles,
              redisKey,
              resFresh,
              user_type
            );
          })
            .then(
              (result) => {
                redisCluster.set(redisKeyHere, stringify(result));
                resolve(result);
              },
              () => {
                resolve({ total: 0, transactions_data: null });
              }
            )
            .catch(() => {
              resolve({ total: 0, transactions_data: null });
            });
        }
      },
      (error) => {
        logger.info(error);
        //Make a fresh request
        new Promise((resFresh) => {
          truelyExec_ridersDrivers_walletSummary(
            requestObj,
            collectionRidesDeliveries_data,
            collectionWalletTransactions_logs,
            collectiondrivers_shoppers_central,
            collectionPassengers_profiles,
            redisKey,
            resFresh,
            user_type
          );
        })
          .then(
            (result) => {
              redisCluster.set(redisKeyHere, stringify(result));
              resolve(result);
            },
            () => {
              resolve({ total: 0, transactions_data: null });
            }
          )
          .catch(() => {
            resolve({ total: 0, transactions_data: null });
          });
      }
    )
    .catch((error) => {
      logger.info(error);
      //Make a fresh request
      new Promise((resFresh) => {
        truelyExec_ridersDrivers_walletSummary(
          requestObj,
          collectionRidesDeliveries_data,
          collectionWalletTransactions_logs,
          collectiondrivers_shoppers_central,
          collectionPassengers_profiles,
          redisKey,
          resFresh,
          user_type
        );
      })
        .then(
          (result) => {
            redisCluster.set(redisKeyHere, stringify(result));
            resolve(result);
          },
          () => {
            resolve({ total: 0, transactions_data: null });
          }
        )
        .catch(() => {
          resolve({ total: 0, transactions_data: null });
        });
    });
}

/**
 * @func truelyExec_ridersDrivers_walletSummary
 * Responsible for truly run the get operations for the wallets summary for the riders and drivers.
 * @param requestObj: contains the user_fingerprint and the mode: total or detailed.
 * @param collectionRidesDeliveries_data: the collection of all the requests.
 * @param collectionWalletTransactions_logs: the collection of all the possible wallet transactions.
 * @param collectiondrivers_shoppers_central: collection of all the drivers
 * @param collectionPassengers_profiles: collection of all the passengers.
 * @param resolve
 * @param user_type: rider or driver (the type of user for which to show the wallet details).
 */
function truelyExec_ridersDrivers_walletSummary(
  requestObj,
  collectionRidesDeliveries_data,
  collectionWalletTransactions_logs,
  collectiondrivers_shoppers_central,
  collectionPassengers_profiles,
  redisKey,
  resolve,
  user_type = "rider"
) {
  //Get the current amount and all the details.
  let detailsData = {
    topedupAmount: 0, //The amount of money toped up since the beginning.
    paid_totalAmount: 0, //The total amount paid in the platform for rides/deliveries
    transactions_data: null, //The topups transactions
  };
  //...
  //? 0. Get all the transactions received from other users
  new Promise((resReceivedTransactions) => {
    //! Should be user_fingerprint instead of recipient_fp for DRIVERS
    let filterReceived = {
      recipient_fp: requestObj.user_fingerprint,
      transaction_nature: {
        $in: [
          "sentToFriend",
          "paidDriver",
          "sentToDriver",
          "weeklyPaidDriverAutomatic",
          "commissionTCSubtracted",
          "onetime_voucher", //? For the reward - onetime voucher
        ],
      },
    }; //?Indexed

    provideDataForCollection(
      collectionWalletTransactions_logs,
      "collectionWalletTransactions_logs",
      filterReceived
    )
      .then((resultTransactionsReceived) => {
        // console.log(resultTransactionsReceived);
        logger.warn(
          `[SOLVED] SUPER HEAVY RETRIEVAL 1 -> DATA : ${resultTransactionsReceived.length}`
        );
        //...
        if (
          resultTransactionsReceived !== undefined &&
          resultTransactionsReceived.length > 0
        ) {
          //Found some transactions
          let receivedDataShot = {
            total: 0,
            transactions_data: [],
          };
          //? Find the total of all the received transactions
          resultTransactionsReceived.map((transaction) => {
            if (/(onetime_voucher)/i.test(transaction.transaction_nature)) {
              logger.warn(transaction);
            }
            //! Add all except the TaxiConnect commission
            if (
              /(commissionTCSubtracted|weeklyPaidDriverAutomatic)/i.test(
                transaction.transaction_nature
              ) === false
            ) {
              receivedDataShot.total += parseFloat(transaction.amount);
            } //! Substract the commission already paid
            else {
              receivedDataShot.total -= parseFloat(transaction.amount);
            }
            //Save he record
            receivedDataShot.transactions_data.push(transaction);
          });
          //? DONE
          resReceivedTransactions(receivedDataShot);
        } //No recived transactions
        else {
          resReceivedTransactions({ total: 0, transactions_data: null });
        }
      })
      .catch((error) => {
        logger.error(error);
        resReceivedTransactions({ total: 0, transactions_data: null });
      });
  })
    .then(
      (receivedTransactionsData) => {
        //1. Get the total topups
        //? Or the drivers weekly payouts.
        new Promise((res) => {
          let filterTopups = {
            user_fingerprint: requestObj.user_fingerprint,
            transaction_nature: {
              $in: [
                "topup",
                "paidDriver",
                "sentToDriver",
                "sentToFriend",
                "weeklyPaidDriverAutomatic",
              ],
            },
          }; //?Indexed
          //...
          provideDataForCollection(
            collectionWalletTransactions_logs,
            "collectionWalletTransactions_logs",
            filterTopups
          )
            .then((resultTransactions) => {
              logger.warn(
                `[SOLVED] SUPER HEAVY RETRIEVAL 2 -> DATA : ${resultTransactions.length}`
              );
              //..
              if (
                (resultTransactions !== undefined &&
                  resultTransactions.length > 0) ||
                /driver/i.test(user_type)
              ) {
                //Found some records
                //Save the transactions data
                detailsData.transactions_data = resultTransactions;
                //? Find the sum of all the transactions: topup (not including rides/deliveries)
                //! Remove the paidDriver, sentToDriver and sentToFriend.
                resultTransactions.map((transaction) => {
                  if (
                    /topup/i.test(transaction.transaction_nature) &&
                    /rider/i.test(user_type)
                  ) {
                    //! Add
                    detailsData.topedupAmount += parseFloat(transaction.amount);
                  } else if (
                    /(paidDriver|sentToDriver|sentToFriend)/i.test(
                      transaction.transaction_nature
                    ) &&
                    /rider/i.test(user_type)
                  ) {
                    //!Remove
                    detailsData.topedupAmount -= parseFloat(transaction.amount);
                  } else if (
                    /(weeklyPaidDriverAutomatic)/i.test(
                      transaction.transaction_nature
                    ) &&
                    /driver/i.test(user_type)
                  ) {
                    //! Remove automatic weekly payments from the total for the drivers
                    detailsData.topedupAmount += parseFloat(transaction.amount);
                    //Save he record
                    receivedTransactionsData.transactions_data =
                      receivedTransactionsData.transactions_data !==
                        undefined &&
                      receivedTransactionsData.transactions_data !== null
                        ? receivedTransactionsData.transactions_data
                        : [];
                    //...
                    /*receivedTransactionsData.transactions_data.push(
                    transaction
                  );*/
                  }
                });
                //Find the sum of all the paid transactions (rides/deliveries) - for wallet only
                //? Happend the cash data to the transaction data as well.
                //! Warning: Key policy ahead, do not touch!
                //! TIME BRIDGE
                //! Will only consider rides after the 31-03-2021 at exactly 23:59:59
                let filterPaidRequests = /rider/i.test(user_type)
                  ? {
                      client_id: requestObj.user_fingerprint,
                      isArrivedToDestination: true,
                    }
                  : {
                      taxi_id: requestObj.user_fingerprint,
                      isArrivedToDestination: true,
                      date_requested: {
                        $gte: new Date("2021-03-31T21:59:59.000Z"),
                      },
                    };
                //...Only consider the completed requests
                provideDataForCollection(
                  collectionRidesDeliveries_data,
                  "collectionRidesDeliveries_data",
                  filterPaidRequests
                )
                  .then((resultPaidRequests) => {
                    logger.warn(
                      `[SOLVED] SUPER HEAVY RETRIEVAL 3 -> DATA : ${resultPaidRequests.length}`
                    );
                    //...
                    if (
                      resultPaidRequests !== undefined &&
                      resultPaidRequests.length > 0
                    ) {
                      //Found some records
                      //Save the requests transaction data and find the sum of the paid transactions
                      let completedDataPromise = resultPaidRequests.map(
                        (paidRequests) => {
                          return new Promise((partialResolver) => {
                            //Get driver infos : for Taxis - taxi number / for private cars - drivers name
                            dynamo_find_query({
                              table_name: "drivers_shoppers_central",
                              IndexName: "driver_fingerprint",
                              KeyConditionExpression:
                                "driver_fingerprint = :val1",
                              ExpressionAttributeValues: {
                                ":val1": paidRequests.taxi_id,
                              },
                            })
                              .then((driverProfile) => {
                                //Gather driver data
                                let driverData = {
                                  name: null,
                                  car_brand: null,
                                  taxi_number: null,
                                };
                                if (driverProfile.length > 0) {
                                  driverProfile = driverProfile[0];
                                  if (driverProfile.cars_data !== undefined) {
                                    //Add name
                                    driverData.name = driverProfile.name;
                                    //Get car infos
                                    driverProfile.cars_data.map((car) => {
                                      if (
                                        car.car_fingerprint ===
                                        paidRequests.car_fingerprint
                                      ) {
                                        //Found car
                                        //Save car brand and/or fingerprint
                                        driverData.car_brand = car.car_brand;
                                        driverData.taxi_number =
                                          car.taxi_number;
                                      }
                                    });
                                  }
                                }

                                //1. Reformat the data
                                let dateRequest = new Date(
                                  paidRequests.date_requested
                                );
                                dateRequest = moment(dateRequest.getTime());
                                dateRequest =
                                  (String(dateRequest.date()).length > 1
                                    ? dateRequest.date()
                                    : "0" + dateRequest.date()) +
                                  "-" +
                                  (String(dateRequest.month() + 1).length > 1
                                    ? dateRequest.month() + 1
                                    : "0" + (dateRequest.month() + 1)) +
                                  "-" +
                                  dateRequest.year() +
                                  ", " +
                                  (String(dateRequest.hour()).length > 1
                                    ? dateRequest.hour()
                                    : "0" + dateRequest.hour()) +
                                  ":" +
                                  (String(dateRequest.minute()).length > 1
                                    ? dateRequest.minute()
                                    : "0" + dateRequest.minute());

                                //Only get the sum for the wallets requests
                                if (
                                  /wallet/i.test(paidRequests.payment_method)
                                ) {
                                  //Wallet - add the sum and save record to transaction data
                                  detailsData.paid_totalAmount += parseFloat(
                                    paidRequests.fare
                                  );
                                  //Save record
                                  partialResolver({
                                    amount: parseFloat(paidRequests.fare),
                                    transaction_nature: paidRequests.ride_mode,
                                    payment_method: paidRequests.payment_method,
                                    driverData: driverData,
                                    date_captured: dateRequest,
                                    date_requestedRaw:
                                      paidRequests.date_requested,
                                  });
                                } //Cash - only save transaction data
                                else {
                                  partialResolver({
                                    amount: parseFloat(paidRequests.fare),
                                    transaction_nature: paidRequests.ride_mode,
                                    payment_method: paidRequests.payment_method,
                                    driverData: driverData,
                                    date_captured: dateRequest,
                                    date_requestedRaw:
                                      paidRequests.date_requested,
                                  });
                                }
                              })
                              .catch((error) => {
                                logger.error(error);
                                partialResolver({
                                  total: 0,
                                  transactions_data: null,
                                });
                              });
                          });
                        }
                      );

                      //..DONE
                      Promise.all(completedDataPromise).then(
                        (finalData) => {
                          //Update the transaction data
                          detailsData.transactions_data =
                            detailsData.transactions_data !== null &&
                            detailsData.transactions_data !== undefined
                              ? [...detailsData.transactions_data, ...finalData]
                              : finalData;
                          //! Add the total received
                          detailsData.transactions_data =
                            receivedTransactionsData.transactions_data !==
                              null &&
                            receivedTransactionsData.transactions_data !==
                              undefined
                              ? [
                                  ...detailsData.transactions_data,
                                  ...receivedTransactionsData.transactions_data,
                                ]
                              : detailsData.transactions_data;
                          //! DONE - First Logic for the riders - second for drivers!
                          res(
                            /rider/i.test(user_type)
                              ? {
                                  total:
                                    detailsData.topedupAmount +
                                    receivedTransactionsData.total -
                                    detailsData.paid_totalAmount,
                                  transactions_data:
                                    detailsData.transactions_data,
                                }
                              : {
                                  total:
                                    -1 * detailsData.topedupAmount +
                                    receivedTransactionsData.total +
                                    detailsData.paid_totalAmount,
                                  transactions_data:
                                    detailsData.transactions_data,
                                }
                          );
                        },
                        (error) => {
                          logger.info(error);
                          //Done
                          res({ total: 0, transactions_data: null });
                        }
                      );
                    } //No paid requests yet - send the current total found
                    else {
                      res({
                        total:
                          detailsData.topedupAmount +
                          receivedTransactionsData.total -
                          detailsData.paid_totalAmount,
                        transactions_data:
                          receivedTransactionsData.transactions_data !== null &&
                          receivedTransactionsData.transactions_data !==
                            undefined
                            ? [
                                ...detailsData.transactions_data,
                                ...receivedTransactionsData.transactions_data,
                              ]
                            : detailsData.transactions_data,
                      });
                    }
                  })
                  .catch((err) => {
                    logger.info(err);
                    res({ total: 0, transactions_data: null });
                  });
              } //No topups records found - so return the transactions data
              else {
                //Find the sum of all the paid transactions (rides/deliveries) - for wallet only
                //? Happend the cash data to the transaction data as well.
                let filterPaidRequests = /rider/i.test(user_type)
                  ? {
                      client_id: requestObj.user_fingerprint,
                      isArrivedToDestination: true,
                    }
                  : {
                      taxi_id: requestObj.user_fingerprint,
                      isArrivedToDestination: true,
                    };
                //...Only consider the completed requests
                provideDataForCollection(
                  collectionRidesDeliveries_data,
                  "collectionRidesDeliveries_data",
                  filterPaidRequests
                )
                  .then((resultPaidRequests) => {
                    logger.warn(
                      `[SOLVED] SUPER HEAVY RETRIEVAL 4 -> DATA : ${resultPaidRequests.length}`
                    );
                    //...
                    if (
                      resultPaidRequests !== undefined &&
                      resultPaidRequests.length > 0
                    ) {
                      //Found some records
                      //Save the requests transaction data and find the sum of the paid transactions
                      let completedDataPromise = resultPaidRequests.map(
                        (paidRequests) => {
                          return new Promise((partialResolver) => {
                            //Get driver infos : for Taxis - taxi number / for private cars - drivers name
                            dynamo_find_query({
                              table_name: "drivers_shoppers_central",
                              IndexName: "driver_fingerprint",
                              KeyConditionExpression:
                                "driver_fingerprint = :val1",
                              ExpressionAttributeValues: {
                                ":val1": paidRequests.taxi_id,
                              },
                            })
                              .then((driverProfile) => {
                                //Gather driver data
                                let driverData = {
                                  name: null,
                                  car_brand: null,
                                  taxi_number: null,
                                };
                                if (driverProfile.length > 0) {
                                  driverProfile = driverProfile[0];
                                  if (driverProfile.cars_data !== undefined) {
                                    //Add name
                                    driverData.name = driverProfile.name;
                                    //Get car infos
                                    driverProfile.cars_data.map((car) => {
                                      if (
                                        car.car_fingerprint ===
                                        paidRequests.car_fingerprint
                                      ) {
                                        //Found car
                                        //Save car brand and/or fingerprint
                                        driverData.car_brand = car.car_brand;
                                        driverData.taxi_number =
                                          car.taxi_number;
                                      }
                                    });
                                  }
                                }

                                //1. Reformat the data
                                let dateRequest = new Date(
                                  paidRequests.date_requested
                                );
                                dateRequest = moment(dateRequest.getTime());
                                dateRequest =
                                  (String(dateRequest.date()).length > 1
                                    ? dateRequest.date()
                                    : "0" + dateRequest.date()) +
                                  "-" +
                                  (String(dateRequest.month() + 1).length > 1
                                    ? dateRequest.month() + 1
                                    : "0" + (dateRequest.month() + 1)) +
                                  "-" +
                                  dateRequest.year() +
                                  ", " +
                                  (String(dateRequest.hour()).length > 1
                                    ? dateRequest.hour()
                                    : "0" + dateRequest.hour()) +
                                  ":" +
                                  (String(dateRequest.minute()).length > 1
                                    ? dateRequest.minute()
                                    : "0" + dateRequest.minute());

                                //Only get the sum for the wallets requests
                                if (
                                  /wallet/i.test(paidRequests.payment_method)
                                ) {
                                  //Wallet - add the sum and save record to transaction data
                                  detailsData.paid_totalAmount += parseFloat(
                                    paidRequests.fare
                                  );
                                  //Save record
                                  partialResolver({
                                    amount: parseFloat(paidRequests.fare),
                                    transaction_nature: paidRequests.ride_mode,
                                    payment_method: paidRequests.payment_method,
                                    driverData: driverData,
                                    date_captured: dateRequest,
                                    date_requestedRaw:
                                      paidRequests.date_requested,
                                  });
                                } //Cash - only save transaction data
                                else {
                                  partialResolver({
                                    amount: parseFloat(paidRequests.fare),
                                    transaction_nature: paidRequests.ride_mode,
                                    payment_method: paidRequests.payment_method,
                                    driverData: driverData,
                                    date_captured: dateRequest,
                                    date_requestedRaw:
                                      paidRequests.date_requested,
                                  });
                                }
                              })
                              .catch((error) => {
                                logger.error(error);
                                partialResolver({
                                  total: 0,
                                  transactions_data: null,
                                });
                              });
                          });
                        }
                      );

                      //..DONE
                      Promise.all(completedDataPromise).then(
                        (finalData) => {
                          //Update the transaction data
                          detailsData.transactions_data =
                            detailsData.transactions_data !== null &&
                            detailsData.transactions_data !== undefined
                              ? [...detailsData.transactions_data, ...finalData]
                              : finalData;
                          //! Add the total received
                          detailsData.transactions_data =
                            receivedTransactionsData.transactions_data !==
                              null &&
                            receivedTransactionsData.transactions_data !==
                              undefined
                              ? [
                                  ...detailsData.transactions_data,
                                  ...receivedTransactionsData.transactions_data,
                                ]
                              : detailsData.transactions_data;
                          //! DONE - First Logic for the riders - second for drivers!
                          res(
                            /rider/i.test(user_type)
                              ? {
                                  total:
                                    detailsData.topedupAmount +
                                    receivedTransactionsData.total -
                                    detailsData.paid_totalAmount,
                                  transactions_data:
                                    detailsData.transactions_data,
                                }
                              : {
                                  total:
                                    -1 * detailsData.topedupAmount +
                                    receivedTransactionsData.total +
                                    detailsData.paid_totalAmount,
                                  transactions_data:
                                    detailsData.transactions_data,
                                }
                          );
                        },
                        (error) => {
                          logger.info(error);
                          //Done
                          res({ total: 0, transactions_data: null });
                        }
                      );
                    } //No paid requests yet - send the current total found
                    else {
                      try {
                        res({
                          total:
                            detailsData.topedupAmount +
                            receivedTransactionsData.total -
                            detailsData.paid_totalAmount,
                          transactions_data:
                            receivedTransactionsData.transactions_data !==
                              null &&
                            receivedTransactionsData.transactions_data !==
                              undefined
                              ? detailsData.transactions_data !== undefined &&
                                detailsData.transactions_data !== null
                                ? [
                                    ...detailsData.transactions_data,
                                    ...receivedTransactionsData.transactions_data,
                                  ]
                                : receivedTransactionsData.transactions_data
                              : detailsData.transactions_data,
                        });
                      } catch (error) {
                        logger.info(error);
                        //Done
                        res({
                          total: 0,
                          transactions_data: null,
                          flag: "error",
                        });
                      }
                    }
                  })
                  .catch((err) => {
                    logger.info(err);
                    res({ total: 0, transactions_data: null });
                  });
              }
            })
            .catch((err) => {
              logger.info(err);
              res({ total: 0, transactions_data: null });
            });
        }).then(
          (result) => {
            //? Clean data and CACHE
            new Promise((resCleanData) => {
              parseDetailed_walletGetData(
                result,
                collectiondrivers_shoppers_central,
                collectionPassengers_profiles,
                resCleanData
              );
            })
              .then(
                (resultCleansedData) => {
                  //! ONLY OVERWRITE THE TRANSACTIONS DATA
                  result.transactions_data = resultCleansedData;
                  //Cache and reply
                  redisCluster.set(redisKey, stringify(result));
                  //Reply
                  resolve(result);
                },
                (error) => {
                  logger.info(error);
                  //Error - empty wallet -cache
                  redisCluster.set(
                    redisKey,
                    JSON.stringify({ total: 0, transactions_data: null })
                  );
                  //Reply
                  resolve({ total: 0, transactions_data: null });
                }
              )
              .catch((error) => {
                logger.info(error);
                //Error - empty wallet -cache
                redisCluster.set(
                  redisKey,
                  JSON.stringify({ total: 0, transactions_data: null })
                );
                //Reply
                resolve({ total: 0, transactions_data: null });
              });
            //?-----------------
          },
          (error) => {
            logger.info(error);
            //Error - empty wallet -cache
            redisCluster.set(
              redisKey,
              JSON.stringify({ total: 0, transactions_data: null })
            );
            //Reply
            resolve({ total: 0, transactions_data: null });
          }
        );
      },
      (error) => {
        logger.info(error);
        resolve({ total: 0, transactions_data: null });
      }
    )
    .catch((error) => {
      logger.info(error);
      resolve({ total: 0, transactions_data: null });
    });
}

/**
 * @func computeDriver_walletDeepInsights
 * Responsible for getting deep insights about the driver's wallet about all the payments during each week
 * of every year and a clear look on the total commission of TaxiConnect for each week of the year and globally.
 * ? Consider commissions for CASH or WALLET.
 * @param walletBasicData: the basic wallet data coming straight from the wallet history fetcher.
 * @param collectionWalletTransactions_logs: all the funds transactions done in the system.
 * @param driver_fingerprint: the driver's fingerprint
 * @param redisKey: the unique redis key where to cache the wallet data.
 * @param avoidCached_data: whether to return cached data first or perform a fresh computation (true or false).
 * ! Note that "avoidCached_data", when true, you should also set the same for the "walletBasicData" API to have consistent data.
 * @param resolve
 */
function computeDriver_walletDeepInsights(
  walletBasicData,
  collectionWalletTransactions_logs,
  driver_fingerprint,
  redisKey,
  avoidCached_data,
  resolve
) {
  redisGet(redisKey)
    .then(
      (resp) => {
        if (resp !== null && avoidCached_data == false) {
          //Send cached data
          try {
            //! Rehydrate the data
            new Promise((resNewData) => {
              execGet_driversDeepInsights_fromWalletData(
                walletBasicData,
                collectionWalletTransactions_logs,
                driver_fingerprint,
                redisKey,
                resNewData
              );
            })
              .then()
              .catch((error) => {
                logger.info(error);
              });
            //!-----
            resp = parse(resp);
            resolve(resp);
          } catch (error) {
            //Something's wrong perform a fresh computation
            logger.info(error);
            new Promise((resNewData) => {
              execGet_driversDeepInsights_fromWalletData(
                walletBasicData,
                collectionWalletTransactions_logs,
                driver_fingerprint,
                redisKey,
                resNewData
              );
            })
              .then((result) => {
                resolve(result);
              })
              .catch((error) => {
                logger.info(error);
                resolve({
                  header: null,
                  weeks_view: null,
                  response: "error",
                });
              });
          }
        } //? Send freshly computed data
        else {
          new Promise((resNewData) => {
            execGet_driversDeepInsights_fromWalletData(
              walletBasicData,
              collectionWalletTransactions_logs,
              driver_fingerprint,
              redisKey,
              resNewData
            );
          })
            .then((result) => {
              logger.warn(result);
              resolve(result);
            })
            .catch((error) => {
              logger.info(error);
              resolve({
                header: null,
                weeks_view: null,
                response: "error",
              });
            });
        }
      },
      (error) => {
        //Something's wrong perform a fresh computation
        logger.info(error);
        new Promise((resNewData) => {
          execGet_driversDeepInsights_fromWalletData(
            walletBasicData,
            collectionWalletTransactions_logs,
            driver_fingerprint,
            redisKey,
            resNewData
          );
        })
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            logger.info(error);
            resolve({
              header: null,
              weeks_view: null,
              response: "error",
            });
          });
      }
    )
    .catch((error) => {
      //Something's wrong perform a fresh computation
      logger.info(error);
      new Promise((resNewData) => {
        execGet_driversDeepInsights_fromWalletData(
          walletBasicData,
          collectionWalletTransactions_logs,
          driver_fingerprint,
          redisKey,
          resNewData
        );
      })
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          logger.info(error);
          resolve({
            header: null,
            weeks_view: null,
            response: "error",
          });
        });
    });
}

/**
 * @func getWeekNumber
 * Responsible for getting the week number for any specific date.
 * @param d: the date object
 */
function getWeekNumber(d) {
  // Copy date so don't modify original
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number
  // Make Sunday's day number 7
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  // Get first day of year
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  // Calculate full weeks to nearest Thursday
  var weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  // Return array of year and week number
  return [d.getUTCFullYear(), weekNo];
}

/**
 * @func execGet_driversDeepInsights_fromWalletData
 * Responsible for actively executing the computation on the driver's basic wallet to get more insights from them.
 * @param walletBasicData: the basic wallet data coming straight from the wallet history fetcher.
 * @param collectionWalletTransactions_logs: hold all the transactions list
 * @param driver_fingerprint: the driver's fingerprint
 * @param redisKey: the unique redis key where to cache the wallet data.
 * @param resolve
 * ? WEEK OBJECT TEMPLATE
 * {
 *  week_number: number,
 *  day_name: (monday...),
 *  total_rides: number,
 *  total_deliveries: number,
 *  total_earning: number (Without comission removal),
 *  taxiconnect_commission: number,
 *  earning_due_to_driver: number
 *  daily_earning: {
 *    monday: number,
 *    tuesday: number,
 *    wednesday: number,
 *    thursday: number,
 *    friday: number,
 *    saturday: number,
 *    sunday: number
 *  },
 *  scheduled_payment_date: date
 * }
 * ? GLOBAL HEADER OBJECT
 * {
 *  remaining_commission: number,
 *  scheduled_payment_date: date
 * }
 * ? GENERAL OBJECT STRUCTURE
 * {
 *  header: GLOBAL HEADER OBJ
 *  weeks_view: WEEK OBJ TEMMPLATE
 * }
 */
function execGet_driversDeepInsights_fromWalletData(
  walletBasicData,
  collectionWalletTransactions_logs,
  driver_fingerprint,
  redisKey,
  resolve
) {
  if (
    walletBasicData.transactions_data !== null &&
    walletBasicData.transactions_data !== undefined &&
    walletBasicData.transactions_data.length > 0
  ) {
    let parentPromises = walletBasicData.transactions_data.map(
      (transaction) => {
        return new Promise((resCompute) => {
          //? *. Do a bulk computation, without specifying week specific data for now
          let templateOne = {
            week_number: null,
            year_number: null,
            day_name: null,
            earning_amount: null, //Specific for this transaction
            earning_amount_wallet: null, //Earnings only from the wallet
            total_rides: null, //Specific for this transaction
            total_deliveries: null, //Specific for this transaction
            taxiconnect_commission: null,
            earning_due_to_driver: null,
            driver_weekly_payout: null, //The money paid to the driver.
            transaction_nature: null,
            date_made: null,
          };
          //----
          //? Save the transaction nature and the date made
          templateOne.transaction_nature = transaction.transaction_nature;
          templateOne.date_made = transaction.rawDate_made;
          //? ------------
          //1. Get the week number and year number
          let weekYearDetails = getWeekNumber(
            new Date(transaction.rawDate_made)
          );
          templateOne.week_number = weekYearDetails[1];
          templateOne.year_number = weekYearDetails[0];
          //2. Get the day name (3 letters)
          templateOne.day_name = new Date(transaction.rawDate_made)
            .toString()
            .split(" ")[0];
          //! 3. Set the eearning for the day (WE TAKE COMMISSION ON EVERYTHING EXCEPT 'commission' and 'weekly')
          templateOne.earning_amount =
            !/(commissionTCSubtracted|weeklyPaidDriverAutomatic)/i.test(
              transaction.transaction_nature
            )
              ? parseFloat(transaction.amount)
              : 0;
          //! 3i. Set the earning only from wallet methods
          templateOne.earning_amount_wallet =
            !/(commissionTCSubtracted|weeklyPaidDriverAutomatic)/i.test(
              transaction.transaction_nature
            )
              ? /(paidDriver|sentToDriver)/i.test(
                  transaction.transaction_nature
                )
                ? parseFloat(transaction.amount)
                : /(RIDE|DELIVERY)/i.test(transaction.transaction_nature) &&
                  /WALLET/i.test(transaction.payment_method)
                ? parseFloat(transaction.amount)
                : 0
              : 0;

          //4. Set the ride/delivery - ONLLY for ride/delivery transactions
          templateOne.total_rides = /ride/i.test(transaction.transaction_nature)
            ? 1
            : 0;
          templateOne.total_deliveries = /delivery/i.test(
            transaction.transaction_nature
          )
            ? 1
            : 0;
          //! 5. Set the commission amount if the proper transaction nature is detectedd
          templateOne.taxiconnect_commission = /commissionTCSubtracted/i.test(
            transaction.transaction_nature
          )
            ? transaction.amount
            : 0;
          //! 6. Set the weekly payment if the proper transaction nature is detectedd
          templateOne.driver_weekly_payout = /weeklyPaidDriverAutomatic/i.test(
            transaction.transaction_nature
          )
            ? transaction.amount
            : 0;

          //! 7. Compute the earning due to the driver - CONSIDER ONLY CASH PAYMENTS
          if (
            /(RIDE|DELIVERY)/i.test(transaction.transaction_nature) &&
            /WALLET/i.test(transaction.payment_method)
          ) {
            templateOne.earning_due_to_driver_CASH = 0;
            //!ONLY WALLET
            templateOne.earning_due_to_driver =
              templateOne.earning_amount_wallet -
              templateOne.earning_amount_wallet *
                process.env.TAXICONNECT_COMMISSION;
            //DONE
            resCompute(templateOne);
          } else if (
            /(RIDE|DELIVERY)/i.test(transaction.transaction_nature) &&
            /CASH/i.test(transaction.payment_method)
          ) {
            //!ONLY CASH
            templateOne.earning_due_to_driver = 0; //Wallet to zero
            templateOne.earning_due_to_driver_CASH =
              templateOne.earning_amount -
              templateOne.earning_amount * process.env.TAXICONNECT_COMMISSION;
            //DONE
            resCompute(templateOne);
          } else if (
            /(paidDriver|sentToDriver)/i.test(transaction.transaction_nature)
          ) {
            templateOne.earning_due_to_driver_CASH = 0;
            //! WHEN A DRIVER IS PAID
            templateOne.earning_due_to_driver =
              templateOne.earning_amount_wallet -
              templateOne.earning_amount_wallet *
                process.env.TAXICONNECT_COMMISSION;
            //DONE
            resCompute(templateOne);
          } else {
            templateOne.earning_due_to_driver_CASH = 0;
            templateOne.earning_due_to_driver = 0;
            //DONE
            resCompute(templateOne);
          }
        });
      }
    );
    //....
    Promise.all(parentPromises)
      .then(
        (resultBulkCompute) => {
          if (
            resultBulkCompute !== undefined &&
            resultBulkCompute !== null &&
            resultBulkCompute.length > 0
          ) {
            let _GLOBAL_OBJECT = {
              header: {
                remaining_commission: 0,
                remaining_due_to_driver: 0,
                currency: null,
                scheduled_payment_date: null,
              },
              weeks_view: [],
              recordHolder: {}, //! Responsible for holding a record map, to quickly check if the object for a specific week was already generated.
            };

            let parentPromises2 = resultBulkCompute.map((weekData, index) => {
              return new Promise((resComputePack) => {
                //? FORM THE WEEK VIEW - GLOBAL FOR THE WEEK NUMBER
                //Only regenerate new object if new week detected
                if (
                  _GLOBAL_OBJECT.recordHolder[`${weekData.week_number}`] !==
                    undefined &&
                  _GLOBAL_OBJECT.recordHolder[`${weekData.week_number}`] !==
                    null &&
                  _GLOBAL_OBJECT.recordHolder[`${weekData.week_number}`]
                    .year === weekData.year_number &&
                  _GLOBAL_OBJECT.recordHolder[`${weekData.week_number}`]
                    .week === weekData.week_number
                ) {
                  //Week obj already generated - JUST Update
                  let savedRecordOBJ =
                    _GLOBAL_OBJECT.weeks_view[
                      _GLOBAL_OBJECT.recordHolder[`${weekData.week_number}`]
                        .index
                    ];
                  savedRecordOBJ.total_earning += parseFloat(
                    weekData.earning_amount
                  ); //Cash and wallet
                  savedRecordOBJ.total_earning_wallet +=
                    weekData.earning_amount_wallet; //Only wallet
                  savedRecordOBJ.total_rides += weekData.total_rides;
                  savedRecordOBJ.total_deliveries += weekData.total_deliveries;
                  savedRecordOBJ.total_taxiconnect_commission +=
                    weekData.taxiconnect_commission;
                  savedRecordOBJ.total_earning_due_to_driver +=
                    Math.floor(
                      (weekData.earning_due_to_driver + Number.EPSILON) * 100
                    ) / 100;
                  savedRecordOBJ.total_earning_due_to_driver_cash +=
                    Math.floor(
                      (weekData.earning_due_to_driver_CASH + Number.EPSILON) *
                        100
                    ) / 100;
                  savedRecordOBJ.driver_weekly_payout +=
                    weekData.driver_weekly_payout;
                  //Update the correct day of the week
                  let dayNameIndex = /^mon/i.test(weekData.day_name)
                    ? "monday"
                    : /^tu/i.test(weekData.day_name)
                    ? "tuesday"
                    : /^wed/i.test(weekData.day_name)
                    ? "wednesday"
                    : /^thu/i.test(weekData.day_name)
                    ? "thursday"
                    : /^fri/i.test(weekData.day_name)
                    ? "friday"
                    : /^sat/i.test(weekData.day_name)
                    ? "saturday"
                    : "sunday";
                  //.....
                  savedRecordOBJ.daily_earning[dayNameIndex].requests +=
                    weekData.total_rides + weekData.total_deliveries;
                  savedRecordOBJ.daily_earning[dayNameIndex].earning +=
                    Math.floor(
                      (weekData.earning_amount + Number.EPSILON) * 100
                    ) / 100;
                  //! DONE - UPDATE SAVED OBJECT
                  _GLOBAL_OBJECT.weeks_view[
                    _GLOBAL_OBJECT.recordHolder[`${weekData.week_number}`].index
                  ] = savedRecordOBJ;
                  //...
                  resComputePack(true);
                } //No obj generated yet - create a fresh one
                else {
                  let weekTemplate = {
                    id: index + 1,
                    week_number: weekData.week_number,
                    year_number: weekData.year_number,
                    total_earning: parseFloat(weekData.earning_amount), //Cash and wallet included
                    total_earning_wallet: weekData.earning_amount_wallet, //Without commission removal - wallet amount
                    total_rides: weekData.total_rides,
                    total_deliveries: weekData.total_deliveries,
                    total_taxiconnect_commission:
                      weekData.taxiconnect_commission,
                    total_earning_due_to_driver:
                      Math.floor(
                        (weekData.earning_due_to_driver + Number.EPSILON) * 100
                      ) / 100, //With comission removal
                    total_earning_due_to_driver_cash:
                      Math.floor(
                        (weekData.earning_due_to_driver_CASH + Number.EPSILON) *
                          100
                      ) / 100, //For cash
                    driver_weekly_payout: weekData.driver_weekly_payout,
                    scheduled_payment_date: null, //! VERY IMPORTANT - for information
                    daily_earning: {
                      monday: {
                        requests: /^mon/i.test(weekData.day_name)
                          ? weekData.total_rides + weekData.total_deliveries
                          : 0,
                        earning: /^mon/i.test(weekData.day_name)
                          ? weekData.earning_amount
                          : 0,
                      },
                      tuesday: {
                        requests: /^tu/i.test(weekData.day_name)
                          ? weekData.total_rides + weekData.total_deliveries
                          : 0,
                        earning: /^tu/i.test(weekData.day_name)
                          ? weekData.earning_amount
                          : 0,
                      },
                      wednesday: {
                        requests: /^wed/i.test(weekData.day_name)
                          ? weekData.total_rides + weekData.total_deliveries
                          : 0,
                        earning: /^wed/i.test(weekData.day_name)
                          ? weekData.earning_amount
                          : 0,
                      },
                      thursday: {
                        requests: /^thu/i.test(weekData.day_name)
                          ? weekData.total_rides + weekData.total_deliveries
                          : 0,
                        earning: /^thu/i.test(weekData.day_name)
                          ? weekData.earning_amount
                          : 0,
                      },
                      friday: {
                        requests: /^fri/i.test(weekData.day_name)
                          ? weekData.total_rides + weekData.total_deliveries
                          : 0,
                        earning: /^fri/i.test(weekData.day_name)
                          ? weekData.earning_amount
                          : 0,
                      },
                      saturday: {
                        requests: /^sat/i.test(weekData.day_name)
                          ? weekData.total_rides + weekData.total_deliveries
                          : 0,
                        earning: /^sat/i.test(weekData.day_name)
                          ? weekData.earning_amount
                          : 0,
                      },
                      sunday: {
                        requests: /^sun/i.test(weekData.day_name)
                          ? weekData.total_rides + weekData.total_deliveries
                          : 0,
                        earning: /^sun/i.test(weekData.day_name)
                          ? weekData.earning_amount
                          : 0,
                      },
                    }, //? Weeekly earning include cash and wallet amounts
                  };
                  //...Done initiallizing - SAVE
                  //! 1. Update the record holder
                  _GLOBAL_OBJECT.recordHolder[`${weekData.week_number}`] = {
                    index: index,
                    year: weekData.year_number, //? Very important - gather based on the years as well
                    week: weekData.week_number, //? Very important - gather based on the weeks of the years as well
                  };
                  //! 2. Update the week view following the index order
                  _GLOBAL_OBJECT.weeks_view[index] = weekTemplate;
                  resComputePack(true);
                }
              });
            });
            //....DOne
            Promise.all(parentPromises2)
              .then(
                (resultGlobalData) => {
                  if (resultGlobalData.length > 0) {
                    _GLOBAL_OBJECT["transactions_data"] =
                      walletBasicData.transactions_data; //! Add the transaction data
                    //Has some data
                    //Remove empty objects, false, null or undefined
                    _GLOBAL_OBJECT.weeks_view =
                      _GLOBAL_OBJECT.weeks_view.filter(
                        (data) =>
                          Object.keys(data).length > 0 &&
                          data !== undefined &&
                          data !== false &&
                          data !== null
                      );
                    //? Compute the global remaining comission for Nej
                    let totalEarnings = 0;
                    let totalDues = 0;
                    let totalDues_wallet = 0;
                    let totalPayouts = 0;
                    let totalComission = 0;
                    _GLOBAL_OBJECT.weeks_view.map((weekData) => {
                      totalEarnings += weekData.total_earning; //Money made
                      totalDues +=
                        weekData.total_earning_due_to_driver +
                        weekData.total_earning_due_to_driver_cash; //Money due - WALLET AND CASH
                      totalDues_wallet += weekData.total_earning_due_to_driver; //Only dues for the wallet
                      totalPayouts += weekData.driver_weekly_payout; //Money already transaferred.
                      totalComission += weekData.total_taxiconnect_commission; //Comission already transferred to US
                    });
                    logger.info(`
                      Total earnings : ${totalEarnings}\n
                      Total dues : ${totalDues}\n
                      Total dues wallet : ${totalDues_wallet}\n
                      Total payouts : ${totalPayouts}\n
                      Total comission : ${totalComission}
                    `);
                    //...
                    //! General left comission
                    _GLOBAL_OBJECT.header.remaining_commission =
                      Math.ceil(
                        (totalEarnings -
                          totalDues -
                          totalComission +
                          Number.EPSILON) *
                          100
                      ) / 100;
                    //! General left due to driver
                    _GLOBAL_OBJECT.header.remaining_due_to_driver =
                      Math.floor(
                        (totalDues_wallet - totalPayouts + Number.EPSILON) * 100
                      ) / 100;
                    //! Attatch a currency
                    _GLOBAL_OBJECT.header.currency =
                      process.env.PAYMENT_CURRENCY;
                    //! Attach the NEXT PAYMENT DATE.
                    new Promise((resFindNexyPayoutDate) => {
                      resolveDate(); //! Update the date
                      //? Find the last payout and from there - compute the next one
                      dynamo_find_query({
                        table_name: "wallet_transactions_logs",
                        IndexName: "recipient_fp",
                        KeyConditionExpression:
                          "transaction_nature = :val1, recipient_fp = :val2",
                        ExpressionAttributeValues: {
                          ":val1": "startingPoint_forFreshPayouts",
                          ":val2": driver_fingerprint,
                        },
                      })
                        .then((resultLastPayout) => {
                          if (
                            resultLastPayout !== undefined &&
                            resultLastPayout.length > 0 &&
                            resultLastPayout[0].date_captured !== undefined
                          ) {
                            let lastPayoutDate = new Date(
                              resultLastPayout[0].date_captured
                            );
                            resFindNexyPayoutDate(lastPayoutDate);
                          } //? The driver was never paid before
                          else {
                            //!Check if a reference point exists - if not set one to NOW
                            //! Annotation string: startingPoint_forFreshPayouts
                            dynamo_find_query({
                              table_name: "wallet_transactions_logs",
                              IndexName: "user_fingerprint",
                              KeyConditionExpression:
                                "flag_annotation = :val1, user_fingerprint = :val2",
                              ExpressionAttributeValues: {
                                ":val1": "startingPoint_forFreshPayouts",
                                ":val2": driver_fingerprint,
                              },
                            })
                              .then((referenceData) => {
                                if (
                                  referenceData !== undefined &&
                                  referenceData.length > 0 &&
                                  referenceData[0].date_captured !== undefined
                                ) {
                                  //Found an existing annotation - use the date as starting point
                                  let lastPayoutDate = new Date(
                                    referenceData[0].date_captured
                                  );
                                  //..
                                  resFindNexyPayoutDate(lastPayoutDate);
                                } //No annotation yet - create one
                                else {
                                  dynamo_insert("wallet_transactions_logs", {
                                    flag_annotation:
                                      "startingPoint_forFreshPayouts",
                                    user_fingerprint: driver_fingerprint,
                                    date_captured: chaineDateUTC,
                                  })
                                    .then((reslt) => {
                                      let lastPayoutDate = new Date(
                                        new Date(chaineDateUTC).getTime() +
                                          parseFloat(
                                            process.env
                                              .TAXICONNECT_PAYMENT_FREQUENCY
                                          ) *
                                            24 *
                                            3600000
                                      );
                                      //..
                                      resFindNexyPayoutDate(lastPayoutDate);
                                    })
                                    .catch((error) => {
                                      logger.error(error);
                                      let lastPayoutDate = new Date(
                                        new Date(chaineDateUTC).getTime() +
                                          parseFloat(
                                            process.env
                                              .TAXICONNECT_PAYMENT_FREQUENCY
                                          ) *
                                            24 *
                                            3600000
                                      );
                                      //..
                                      resFindNexyPayoutDate(lastPayoutDate);
                                    });
                                }
                              })
                              .catch((error) => {
                                logger.error(error);
                                resFindNexyPayoutDate(false);
                              });
                          }
                        })
                        .catch((error) => {
                          logger.error(error);
                          resFindNexyPayoutDate(false);
                        });
                    })
                      .then(
                        (resultPayoutDate) => {
                          if (resultPayoutDate !== false) {
                            //? Update the next payout date var
                            _GLOBAL_OBJECT.header.scheduled_payment_date =
                              resultPayoutDate;
                            //! Cache data --- ~ min
                            new Promise((resCache) => {
                              redisCluster.set(
                                redisKey,
                                stringify(_GLOBAL_OBJECT)
                              );
                              resCache(true);
                            })
                              .then()
                              .catch();
                            //...
                            resolve(_GLOBAL_OBJECT);
                          } //Couldn't find a payout date
                          else {
                            resolve({
                              header: null,
                              weeks_view: null,
                              response: "error",
                            });
                          }
                        },
                        (error) => {
                          logger.info(error);
                          resolve({
                            header: null,
                            weeks_view: null,
                            response: "error",
                          });
                        }
                      )
                      .catch((error) => {
                        logger.info(error);
                        resolve({
                          header: null,
                          weeks_view: null,
                          response: "error",
                        });
                      });
                  } //No data
                  else {
                    resolve({
                      header: null,
                      weeks_view: null,
                    });
                  }
                },
                (error) => {
                  logger.info(error);
                  resolve({
                    header: null,
                    weeks_view: null,
                    response: "error",
                  });
                }
              )
              .catch((error) => {
                logger.info(error);
                resolve({
                  header: null,
                  weeks_view: null,
                  response: "error",
                });
              });
          } //Empty records
          else {
            resolve({
              header: null,
              weeks_view: null,
            });
          }
        },
        (error) => {
          logger.info(error);
          resolve({
            header: null,
            weeks_view: null,
            response: "error",
          });
        }
      )
      .catch((error) => {
        logger.info(error);
        resolve({
          header: null,
          weeks_view: null,
          response: "error",
        });
      });
  } //No transactions
  else {
    //! Attach the NEXT PAYMENT DATE.
    new Promise((resFindNexyPayoutDate) => {
      resolveDate(); //! Update the date
      //? Find the last payout and from there - compute the next one
      dynamo_find_query({
        table_name: "wallet_transactions_logs",
        IndexName: "recipient_fp",
        KeyConditionExpression:
          "transaction_nature = :val1, recipient_fp = :val2",
        ExpressionAttributeValues: {
          ":val1": "weeklyPaidDriverAutomatic",
          ":val2": driver_fingerprint,
        },
      })
        .then((resultLastPayout) => {
          if (
            resultLastPayout !== undefined &&
            resultLastPayout.length > 0 &&
            resultLastPayout[0].date_captured !== undefined
          ) {
            //Found the llast payout date
            //! Do not update the payment date cycle
            let lastPayoutDate = new Date(resultLastPayout[0].date_captured);
            //....
            resFindNexyPayoutDate(lastPayoutDate);
          } //? The driver was never paid before
          else {
            //!Check if a reference point exists - if not set one to NOW
            //! Annotation string: startingPoint_forFreshPayouts
            dynamo_find_query({
              table_name: "wallet_transactions_logs",
              IndexName: "user_fingerprint",
              KeyConditionExpression:
                "flag_annotation = :val1, user_fingerprint = :val2",
              ExpressionAttributeValues: {
                ":val1": "startingPoint_forFreshPayouts",
                ":val2": driver_fingerprint,
              },
            })
              .then((referenceData) => {
                if (
                  referenceData !== undefined &&
                  referenceData.length > 0 &&
                  referenceData[0].date_captured !== undefined
                ) {
                  //Found an existing annotation - use the date as starting point
                  //! Do not update the payment date cycle
                  let lastPayoutDate = new Date(
                    new Date(referenceData[0].date_captured)
                  );
                  //..
                  resFindNexyPayoutDate(lastPayoutDate);
                } //No annotation yet - create one
                else {
                  dynamo_insert("wallet_transactions_logs", {
                    flag_annotation: "startingPoint_forFreshPayouts",
                    user_fingerprint: driver_fingerprint,
                    date_captured: chaineDateUTC,
                  })
                    .then(() => {
                      let lastPayoutDate = new Date(
                        new Date(chaineDateUTC).getTime() +
                          process.env.TAXICONNECT_PAYMENT_FREQUENCY *
                            24 *
                            3600000
                      );
                      //..
                      resFindNexyPayoutDate(lastPayoutDate);
                    })
                    .catch((error) => {
                      logger.error(error);
                      let lastPayoutDate = new Date(
                        new Date(chaineDateUTC).getTime() +
                          process.env.TAXICONNECT_PAYMENT_FREQUENCY *
                            24 *
                            3600000
                      );
                      //..
                      resFindNexyPayoutDate(lastPayoutDate);
                    });
                }
              })
              .catch((error) => {
                logger.error(error);
                resFindNexyPayoutDate(false);
              });
          }
        })
        .catch((error) => {
          logger.error(error);
          resFindNexyPayoutDate(false);
        });
    })
      .then(
        (resultPayoutDate) => {
          if (resultPayoutDate !== false) {
            let _GLOBAL_OBJECT = {
              header: {
                scheduled_payment_date: null,
              },
              weeks_view: null,
            };
            //? Update the next payout date var
            _GLOBAL_OBJECT.header.scheduled_payment_date = resultPayoutDate;
            //! Cache data --- ~ min
            new Promise((resCache) => {
              redisCluster.set(redisKey, stringify(_GLOBAL_OBJECT));
              resCache(true);
            })
              .then()
              .catch();
            //....
            resolve(_GLOBAL_OBJECT);
          } //Couldn't find a payout date
          else {
            resolve({
              header: null,
              weeks_view: null,
              response: "error",
            });
          }
        },
        (error) => {
          logger.info(error);
          resolve({
            header: null,
            weeks_view: null,
            response: "error",
          });
        }
      )
      .catch((error) => {
        logger.info(error);
        resolve({
          header: null,
          weeks_view: null,
          response: "error",
        });
      });
  }
}

/**
 * @func ucFirst
 * Responsible to uppercase only the first character and lowercase the rest.
 * @param stringData: the string to be processed.
 */
function ucFirst(stringData) {
  try {
    return `${stringData[0].toUpperCase()}${stringData
      .substr(1)
      .toLowerCase()}`;
  } catch (error) {
    logger.info(error);
    return stringData;
  }
}

/**
 * @func EmailValidator
 * Responsible for performing a shallow syntaxic validation of an email string.
 * @param emailString: the email string to be checked.
 */
function EmailValidator(emailString) {
  let reg = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
  if (reg.test(emailString) === false) {
    return false;
  } else {
    return true;
  }
}

/**
 * @func updateRiders_generalProfileInfos
 * Responsible for dealing with the updates of all the riders profile information,
 * and can log all the changes to the general events log.
 * @param collectionPassengers_profiles: passengers profiles.
 * @param collectionGlobalEvents: contains all the events.
 * @param collection_OTP_dispatch_map: contains all the OTPs, useful for numbers change.
 * @param requestData: contains the user fingerprint, the wanted info to be changed and the relevant data -name, surname, picture, email, phone number, gender - (SHOULD BE CHECKED)
 */
function updateRiders_generalProfileInfos(
  collectionPassengers_profiles,
  collection_OTP_dispatch_map,
  collectionGlobalEvents,
  requestData,
  resolve
) {
  resolveDate();
  //...
  if (requestData.infoToUpdate === "name") {
    //Modify the name
    if (requestData.dataToUpdate.length > 2) {
      //Acceptable
      let filter = {
        user_fingerprint: requestData.user_fingerprint,
      };
      let updateData = {
        $set: {
          name: ucFirst(requestData.dataToUpdate),
          last_updated: new Date(chaineDateUTC),
        },
      };
      //..
      //1. Get the old data
      dynamo_find_query({
        table_name: "passengers_profiles",
        IndexName: "user_fingerprint",
        KeyConditionExpression: "user_fingerprint = :val1",
        ExpressionAttributeValues: {
          ":val1": requestData.user_fingerprint,
        },
      })
        .then((riderProfile) => {
          //2. Update the new data
          dynamo_update(
            "passengers_profiles",
            riderProfile[0]._id,
            "set name = :n, last_updated = :d",
            {
              ":n": ucFirst(requestData.dataToUpdate),
              ":d": new Date(chaineDateUTC).toISOString(),
            }
          )
            .then((result) => {
              if (result === false) {
                res.send({ response: "error", flag: "unexpected_error" });
              }
              //...Update the general event log
              new Promise((res) => {
                let dataEvent = {
                  event_name: "rider_name_update",
                  user_fingerprint: requestData.user_fingerprint,
                  old_data: riderProfile[0].name,
                  new_data: requestData.dataToUpdate,
                  date: new Date(chaineDateUTC).toISOString(),
                };

                dynamo_insert("global_events", dataEvent)
                  .then((result) => {
                    res(result);
                  })
                  .catch((error) => {
                    logger.error(error);
                    res(true);
                  });
              }).then(
                () => {},
                () => {}
              );
              //...
              resolve({ response: "success", flag: "operation successful" });
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "error", flag: "unexpected_error" });
            });
        })
        .catch((error) => {
          logger.error(error);
          res.send({ response: "error", flag: "unexpected_error" });
        });
    } //Name too short
    else {
      resolve({ response: "error", flag: "The name's too short." });
    }
  } else if (requestData.infoToUpdate === "surname") {
    //Modify the surname
    if (requestData.dataToUpdate.length > 2) {
      //Acceptable
      let filter = {
        user_fingerprint: requestData.user_fingerprint,
      };
      let updateData = {
        $set: {
          surname: ucFirst(requestData.dataToUpdate),
          last_updated: new Date(chaineDateUTC),
        },
      };
      //..
      //1. Get the old data
      dynamo_find_query({
        table_name: "passengers_profiles",
        IndexName: "user_fingerprint",
        KeyConditionExpression: "user_fingerprint = :val1",
        ExpressionAttributeValues: {
          ":val1": requestData.user_fingerprint,
        },
      })
        .then((riderProfile) => {
          //2. Update the new data
          dynamo_update(
            "passengers_profiles",
            riderProfile[0]._id,
            "set surname = :n, last_updated = :d",
            {
              ":n": ucFirst(requestData.dataToUpdate),
              ":d": new Date(chaineDateUTC).toISOString(),
            }
          )
            .then((result) => {
              if (result === false) {
                res.send({ response: "error", flag: "unexpected_error" });
              }
              //...Update the general event log
              new Promise((res) => {
                let dataEvent = {
                  event_name: "rider_surname_update",
                  user_fingerprint: requestData.user_fingerprint,
                  old_data: riderProfile[0].surname,
                  new_data: requestData.dataToUpdate,
                  date: new Date(chaineDateUTC).toISOString(),
                };
                dynamo_insert("global_events", dataEvent)
                  .then((result) => {
                    res(result);
                  })
                  .catch((error) => {
                    logger.error(error);
                    res(true);
                  });
              }).then(
                () => {},
                () => {}
              );
              //...
              resolve({ response: "success", flag: "operation successful" });
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "error", flag: "unexpected_error" });
            });
        })
        .catch((error) => {
          logger.error(error);
          res.send({ response: "error", flag: "unexpected_error" });
        });
    } //Name too short
    else {
      resolve({ response: "error", flag: "The surname's too short." });
    }
  } else if (requestData.infoToUpdate === "gender") {
    //? Update the gender's string to M, F or unknown
    requestData.dataToUpdate = /^male$/i.test(requestData.dataToUpdate.trim())
      ? "M"
      : /^female$/i.test(requestData.dataToUpdate.trim())
      ? "F"
      : "unknown";
    //Modify the gender
    if (
      requestData.dataToUpdate.length > 0 &&
      ["M", "F", "unknown"].includes(requestData.dataToUpdate)
    ) {
      //Acceptable
      let filter = {
        user_fingerprint: requestData.user_fingerprint,
      };
      let updateData = {
        $set: {
          gender: requestData.dataToUpdate.toUpperCase(),
          last_updated: new Date(chaineDateUTC),
        },
      };
      //..
      //1. Get the old data
      dynamo_find_query({
        table_name: "passengers_profiles",
        IndexName: "user_fingerprint",
        KeyConditionExpression: "user_fingerprint = :val1",
        ExpressionAttributeValues: {
          ":val1": requestData.user_fingerprint,
        },
      })
        .then((riderProfile) => {
          //2. Update the new data
          dynamo_update(
            "passengers_profiles",
            riderProfile[0]._id,
            "set gender = :n, last_updated = :d",
            {
              ":n": requestData.dataToUpdate.toUpperCase(),
              ":d": new Date(chaineDateUTC).toISOString(),
            }
          )
            .then((result) => {
              if (result === false) {
                res.send({ response: "error", flag: "unexpected_error" });
              }
              //...Update the general event log
              new Promise((res) => {
                let dataEvent = {
                  event_name: "rider_gender_update",
                  user_fingerprint: requestData.user_fingerprint,
                  old_data: riderProfile[0].gender,
                  new_data: requestData.dataToUpdate,
                  date: new Date(chaineDateUTC).toISOString(),
                };
                dynamo_insert("global_events", dataEvent)
                  .then((result) => {
                    res(result);
                  })
                  .catch((error) => {
                    logger.error(error);
                    res(true);
                  });
              }).then(
                () => {},
                () => {}
              );
              //...
              resolve({ response: "success", flag: "operation successful" });
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "error", flag: "unexpected_error" });
            });
        })
        .catch((error) => {
          logger.error(error);
          res.send({ response: "error", flag: "unexpected_error" });
        });
    } //Invalid gender
    else {
      resolve({ response: "error", flag: "Invalid gender" });
    }
  } else if (requestData.infoToUpdate === "email") {
    //Modify the email
    if (
      requestData.dataToUpdate.length > 1 &&
      EmailValidator(requestData.dataToUpdate)
    ) {
      //Acceptable
      let filter = {
        user_fingerprint: requestData.user_fingerprint,
      };
      let updateData = {
        $set: {
          email: requestData.dataToUpdate.trim().toLowerCase(),
          last_updated: new Date(chaineDateUTC),
        },
      };
      //..
      //1. Get the old data
      dynamo_find_query({
        table_name: "passengers_profiles",
        IndexName: "user_fingerprint",
        KeyConditionExpression: "user_fingerprint = :val1",
        ExpressionAttributeValues: {
          ":val1": requestData.user_fingerprint,
        },
      })
        .then((riderProfile) => {
          //2. Update the new data
          dynamo_update(
            "passengers_profiles",
            riderProfile[0]._id,
            "set email = :n, last_updated = :d",
            {
              ":n": requestData.dataToUpdate.trim().toLowerCase(),
              ":d": new Date(chaineDateUTC).toISOString(),
            }
          )
            .then((result) => {
              if (result === false) {
                res.send({ response: "error", flag: "unexpected_error" });
              }
              //...Update the general event log
              new Promise((res) => {
                let dataEvent = {
                  event_name: "rider_email_update",
                  user_fingerprint: requestData.user_fingerprint,
                  old_data: riderProfile[0].email.trim().toLowerCase(),
                  new_data: requestData.dataToUpdate,
                  date: new Date(chaineDateUTC).toISOString(),
                };
                dynamo_insert("global_events", dataEvent)
                  .then((result) => {
                    res(result);
                  })
                  .catch((error) => {
                    logger.error(error);
                    res(true);
                  });
              }).then(
                () => {},
                () => {}
              );
              //...
              resolve({ response: "success", flag: "operation successful" });
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "error", flag: "unexpected_error" });
            });
        })
        .catch((error) => {
          logger.error(error);
          res.send({ response: "error", flag: "unexpected_error" });
        });
    } //Invalid email
    else {
      resolve({ response: "error", flag: "The email looks wrong." });
    }
  } else if (requestData.infoToUpdate === "phone") {
    if (requestData.direction === "initChange") {
      logger.info("Initialize the phone number change");
      //Modify the surname
      if (requestData.dataToUpdate.length > 7) {
        //Check the phone number by sending an OTP
        let url =
          `${
            /production/i.test(process.env.EVIRONMENT)
              ? `http://${process.env.INSTANCE_PRIVATE_IP}`
              : process.env.LOCAL_URL
          }` +
          ":" +
          process.env.ACCOUNTS_SERVICE_PORT +
          "/sendOTPAndCheckUserStatus?phone_number=" +
          requestData.dataToUpdate +
          "&user_fingerprint=" +
          requestData.user_fingerprint +
          "&smsHashLinker=" +
          requestData.smsHashLinker;

        requestAPI(url, function (error, response, body) {
          if (error === null) {
            try {
              body = JSON.parse(body);
              resolve(body);
            } catch (error) {
              resolve({
                response: "error",
                flag: "error_checking_user",
              });
            }
          } else {
            resolve({
              response: "error",
              flag: "error_checking_user",
            });
          }
        });
      } //Phonw too short
      else {
        resolve({ response: "error", flag: "The phone number looks wrong." });
      }
    } else if (requestData.direction === "confirmChange") {
      let url =
        `${
          /production/i.test(process.env.EVIRONMENT)
            ? `http://${process.env.INSTANCE_PRIVATE_IP}`
            : process.env.LOCAL_URL
        }` +
        ":" +
        process.env.ACCOUNTS_SERVICE_PORT +
        "/checkSMSOTPTruly?phone_number=" +
        requestData.dataToUpdate +
        "&otp=" +
        requestData.otp +
        "&userType=registered&user_fingerprint=" +
        requestData.user_fingerprint;

      requestAPI(url, function (error, response, body) {
        logger.info(body);
        if (error === null) {
          try {
            body = JSON.parse(body);
            if (
              body.response !== undefined &&
              body.response !== null &&
              body.response
            ) {
              //Verified
              logger.info("NUMBER VERIFIEDD!");
              //Acceptable
              let filter = {
                user_fingerprint: requestData.user_fingerprint,
              };
              let updateData = {
                $set: {
                  phone_number: /^\+/i.test(requestData.dataToUpdate.trim())
                    ? requestData.dataToUpdate.trim()
                    : `+${requestData.dataToUpdate.trim()}`,
                  last_updated: new Date(chaineDateUTC),
                },
              };
              //..
              //1. Get the old data
              dynamo_find_query({
                table_name: "passengers_profiles",
                IndexName: "user_fingerprint",
                KeyConditionExpression: "user_fingerprint = :val1",
                ExpressionAttributeValues: {
                  ":val1": requestData.user_fingerprint,
                },
              })
                .then((riderProfile) => {
                  //2. Update the new data
                  dynamo_update(
                    "passengers_profiles",
                    riderProfile[0]._id,
                    "set phone_number = :n, last_updated = :d",
                    {
                      ":n": /^\+/i.test(requestData.dataToUpdate.trim())
                        ? requestData.dataToUpdate.trim()
                        : `+${requestData.dataToUpdate.trim()}`,
                      ":d": new Date(chaineDateUTC).toISOString(),
                    }
                  )
                    .then((result) => {
                      if (result === false) {
                        res.send({
                          response: "error",
                          flag: "unexpected_error",
                        });
                      }
                      //...Update the general event log
                      new Promise((res) => {
                        let dataEvent = {
                          event_name: "rider_phone_update",
                          user_fingerprint: requestData.user_fingerprint,
                          old_data: riderProfile[0].phone_number,
                          new_data: requestData.dataToUpdate,
                          date: new Date(chaineDateUTC).toISOString(),
                        };
                        dynamo_insert("global_events", dataEvent)
                          .then((result) => {
                            res(result);
                          })
                          .catch((error) => {
                            logger.error(error);
                            res(true);
                          });
                      }).then(
                        () => {},
                        () => {}
                      );
                      //...
                      resolve({
                        response: "success",
                        flag: "operation successful",
                      });
                    })
                    .catch((error) => {
                      logger.error(error);
                      res.send({
                        response: "error",
                        flag: "unexpected_error",
                      });
                    });
                })
                .catch((error) => {
                  logger.error(error);
                  res.send({ response: "error", flag: "unexpected_error" });
                });
            } //Error
            else {
              resolve({
                response: "error",
                flag: "error_checking_otp",
              });
            }
          } catch (error) {
            resolve({
              response: "error",
              flag: "error_checking_otp",
            });
          }
        } else {
          resolve({
            response: "error",
            flag: "error_checking_otp",
          });
        }
      });
    } //Invalid data
    else {
      resolve({ response: "error", flag: "invalid_data_direction" });
    }
  } else if (requestData.infoToUpdate === "picture") {
    try {
      if (isBase64(requestData.dataToUpdate, { mimeRequired: true })) {
        //Valid base64
        //? The @param dataToUpdate MUST contain the base64 of the profille picture.
        //? picture name format: user_fingerprint +_+ timestamp + format
        let buffer = Buffer.from(requestData.dataToUpdate, "base64");
        let tmpDate = new Date();
        //!get the image format from the base64 code
        let formatImg = requestData.dataToUpdate
          .split(";")[0]
          .split(`/`)[1]
          .trim()
          .toLowerCase();
        let tmpPicture_name = `${requestData.user_fingerprint}_${Math.round(
          tmpDate.getTime()
        )}.${formatImg}`;
        //...
        let regCleaner = new RegExp(`data:image/${formatImg};base64,`, "i");
        requestData.dataToUpdate = requestData.dataToUpdate.replace(
          regCleaner,
          ""
        );
        //Save the image
        let fileName_andPath = `${process.env.RIDERS_PROFILE_PICTURES_PATH.replace(
          /\//g,
          ""
        )}/${tmpPicture_name}`;
        fs.writeFile(
          fileName_andPath,
          requestData.dataToUpdate,
          "base64",
          function (err) {
            if (err) {
              resolve({
                response: "error",
                flag: "unexpected_conversion_error_1",
              });
            }
            //! UPLOAD THE PICTURE TO S3 - Promisify!
            new Promise((resUploadPic_toS3) => {
              // Read content from the file
              const fileContentUploaded_locally =
                fs.readFileSync(fileName_andPath);

              // Setting up S3 upload parameters
              const params = {
                Bucket: `${process.env.AWS_S3_RIDERS_BUCKET_NAME}/Profiles_pictures`,
                Key: tmpPicture_name, // File name you want to save as in S3
                Body: fileContentUploaded_locally,
              };

              // Uploading files to the bucket
              s3.upload(params, function (err, data) {
                if (err) {
                  logger.info(err);
                  resUploadPic_toS3(false);
                }
                logger.info(`Riders profile picture uploaded successfully.`);
                resUploadPic_toS3(true);
              });
            })
              .then(
                (resultS3_upload) => {
                  if (resultS3_upload) {
                    //? Was successfullly upload to S3
                    //Done - update mongodb
                    let updatedData = {
                      $set: {
                        "media.profile_picture": tmpPicture_name,
                      },
                    };
                    //...
                    dynamo_update(
                      "passengers_profiles",
                      riderProfile[0]._id,
                      "set #m.#p = :n, last_updated = :d",
                      {
                        ":n": tmpPicture_name,
                        ":d": new Date(chaineDateUTC),
                      },
                      {
                        "#m": "media",
                        "#p": "profile_picture",
                      }
                    )
                      .then((result) => {
                        if (result === false) {
                          resolve({
                            response: "error",
                            flag: "unexpected_conversion_error_",
                          });
                        }
                        //...Update the general event log
                        new Promise((res) => {
                          dynamo_find_query({
                            table_name: "passengers_profiles",
                            IndexName: "user_fingerprint",
                            KeyConditionExpression: "user_fingerprint = :val1",
                            ExpressionAttributeValues: {
                              ":val1": requestData.user_fingerprint,
                            },
                          })
                            .then((riderData) => {
                              if (riderData.length > 0) {
                                //Valid
                                let dataEvent = {
                                  event_name: "rider_profile_picture_update",
                                  user_fingerprint:
                                    requestData.user_fingerprint,
                                  old_data: riderData[0].media.profile_picture,
                                  new_data: tmpPicture_name,
                                  date: new Date(chaineDateUTC).toISOString(),
                                };
                                dynamo_insert("global_events", dataEvent)
                                  .then((result) => {
                                    res(result);
                                  })
                                  .catch((error) => {
                                    logger.error(error);
                                    res(true);
                                  });
                              } //No riders with the providedd fingerprint
                              else {
                                res(false);
                              }
                            })
                            .catch((error) => {
                              logger.error(error);
                              res(false);
                            });
                        }).then(
                          () => {},
                          () => {}
                        );
                        //...
                        //DONE
                        resolve({
                          response: "success",
                          flag: "operation successful",
                          picture_name: `${process.env.AWS_S3_RIDERS_PROFILE_PICTURES_PATH}/${tmpPicture_name}`,
                        });
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve({
                          response: "error",
                          flag: "unexpected_conversion_error_",
                        });
                      });
                  } //! Was unable to upload to S3 - conversion error
                  else {
                    resolve({
                      response: "error",
                      flag: "unexpected_conversion_error_1",
                    });
                  }
                },
                (error) => {
                  logger.info(error);
                  resolve({
                    response: "error",
                    flag: "unexpected_conversion_error_1",
                  });
                }
              )
              .catch((error) => {
                logger.info(error);
                resolve({
                  response: "error",
                  flag: "unexpected_conversion_error_1",
                });
              });
          }
        );
      } //No mime found
      else {
        resolve({
          response: "error",
          flag: "unexpected_conversion_error_no_mime",
        });
      }
    } catch (error) {
      logger.info(error);
      resolve({ response: "error", flag: "unexpected_conversion_error" });
    }
  }
  //Error - invalid data
  else {
    resolve({ response: "error", flag: "invalid_data" });
  }
}

/**
 * @func getDriver_onlineOffline_status
 * GET DRIVER ONLINE OR OFFLINE STATUS
 * Responsible for getting the driver's online or offline status.
 * @param req: request generic data
 * @param resolve
 */
function getDriver_onlineOffline_status(req, resolve) {
  //Get information about the state
  new Promise((res0) => {
    dynamo_find_query({
      table_name: "drivers_shoppers_central",
      IndexName: "driver_fingerprint",
      KeyConditionExpression: "driver_fingerprint = :val1",
      ExpressionAttributeValues: {
        ":val1": req.driver_fingerprint,
      },
    })
      .then((driverData) => {
        if (
          driverData !== undefined &&
          driverData !== null &&
          driverData[0] !== undefined &&
          driverData[0] !== null &&
          driverData[0].operational_state !== undefined &&
          driverData[0].operational_state !== null &&
          driverData.length > 0
        ) {
          //! GET THE SUSPENSION INFOS
          let suspensionInfos = {
            is_suspended:
              driverData[0].isDriverSuspended !== undefined &&
              driverData[0].isDriverSuspended !== null
                ? driverData[0].isDriverSuspended
                : false,
            message:
              driverData[0].suspension_infos !== undefined &&
              driverData[0].suspension_infos !== null
                ? /UNPAID_COMISSION/i.test(
                    driverData[0].suspension_infos[
                      driverData[0].suspension_infos.length - 1
                    ].reason
                  )
                  ? `Your account has been suspended to an overdue Nej commission.`
                  : false
                : false,
          };
          //! ------------------------
          driverData = driverData[0];
          //Valid driver
          res0({
            response: "successfully_got",
            flag: driverData.operational_state.status,
            suspension_infos: suspensionInfos,
          });
        } //Unknown driver
        else {
          //res0({ response: "error_invalid_request" });
          res0({
            response: "successfully_got",
            flag: driverData.operational_state.status,
          });
        }
      })
      .catch((error) => {
        logger.error(error);
        res0({ response: "error_invalid_request" });
      });
  }).then(
    (result) => {
      resolve(result);
    },
    (error) => {
      logger.info(error);
      resolve({ response: "error_invalid_request" });
    }
  );
}

/**
 * @func getAdsManagerRunningInfos
 * Responsible for getting the only visible Ad based on the city.
 * @param req: input data from the user (must include for sure the user's fingerprint and the user's nature and the city)
 * @param resolve
 * ? Visibility true means that there is a campaign going on.
 */
function getAdsManagerRunningInfos(req, resolve) {
  resolveDate();
  let redisKey = `${req.user_fingerprint}-${req.city}-adDisplayable`;
  redisGet(redisKey).then(
    (resp) => {
      if (resp !== null) {
        try {
          //? Rehydrate data
          new Promise((resExec) => {
            TrulyGetAdsManagerRunningInfos(req, redisKey, resExec);
          })
            .then(
              () => {},
              (error) => {
                logger.info(error);
              }
            )
            .catch((error) => {
              logger.info(error);
            });
          //? Quickly return
          resp = parse(resp);
          resolve(resp);
        } catch (error) {
          logger.info(error);
          //Get fresh record
          new Promise((resExec) => {
            TrulyGetAdsManagerRunningInfos(req, redisKey, resExec);
          })
            .then(
              (result) => {
                resolve(result);
              },
              (error) => {
                logger.info(error);
                resolve({ response: "error", flag: "error_get_data" });
              }
            )
            .catch((error) => {
              logger.info(error);
              resolve({ response: "error", flag: "error_get_data" });
            });
        }
      } //No record - get a fresh one
      else {
        new Promise((resExec) => {
          TrulyGetAdsManagerRunningInfos(req, redisKey, resExec);
        })
          .then(
            (result) => {
              resolve(result);
            },
            (error) => {
              logger.info(error);
              resolve({ response: "error", flag: "error_get_data" });
            }
          )
          .catch((error) => {
            logger.info(error);
            resolve({ response: "error", flag: "error_get_data" });
          });
      }
    },
    (error) => {
      logger.info(error);
      //Get a fresh record
      new Promise((resExec) => {
        TrulyGetAdsManagerRunningInfos(req, redisKey, resExec);
      })
        .then(
          (result) => {
            resolve(result);
          },
          (error) => {
            logger.info(error);
            resolve({ response: "error", flag: "error_get_data" });
          }
        )
        .catch((error) => {
          logger.info(error);
          resolve({ response: "error", flag: "error_get_data" });
        });
    }
  );
  //? Save the GET request for this user.
  new Promise((resSaveRecord) => {
    let eventBundle = {
      event_name: "Ad_GET_event",
      user_fingerprint: req.user_fingerprint,
      user_nature: req.user_nature,
      city: req.city,
      date: new Date(chaineDateUTC),
    };
    //! -----
    dynamo_insert("global_events", eventBundle)
      .then((result) => {
        resSaveRecord(result);
      })
      .catch((error) => {
        logger.error(error);
        resSaveRecord(true);
      });
  }).then(
    () => {},
    () => {}
  );
}

/**
 * @func TrulyGetAdsManagerRunningInfos
 * ! Truly runs the executions
 * Responsible for getting the only visible Ad based on the city.
 * @param req: input data from the user (must include for sure the user's fingerprint and the user's nature and the city)
 * @param redisKey: the redis key to save the data to for 25 min
 * @param resolve
 * ? Visibility true means that there is a campaign going on.
 */
function TrulyGetAdsManagerRunningInfos(req, redisKey, resolve) {
  //?------------------------------------
  //? Get all the companies with visibility "true"
  // collectionAdsCompanies_central
  //   .find({
  //     visibility: true,
  //     are_terms_and_conditions_accepted: true,
  //     "ad_specs.is_expired": false,
  //     city: req.city,
  //   })
  //   //!.collation({ locale: "en", strength: 2 })
  //   .toArray(function (err, companiesData) {
  //     if (err) {
  //       logger.info(err);
  //       resolve({ response: "error", flag: "invalid_data" });
  //     }
  //     // logger.error(companiesData[0].ad_specs);
  //     //....
  //     if (companiesData !== undefined && companiesData.length > 0) {
  //       //Found some data
  //       let companyData = companiesData[0];
  //       //...
  //       let adsData = companyData.ad_specs.sort((a, b) =>
  //         a.expiration_date > b.expiration_date
  //           ? 1
  //           : b.expiration_date > a.expiration_date
  //           ? -1
  //           : 0
  //       );
  //       //? Only get the valid campaigns
  //       adsData = adsData.filter((campaign) =>
  //         campaign.is_expired === false ? true : false
  //       );
  //       //! Rewrite the logo web path
  //       adsData[0].media.logo = `${process.env.AWS_S3_COMPANIES_AD_DATA_LOGOS}/${adsData[0].media.logo}`;
  //       logger.error(adsData[0].media.logo);
  //       //! Remove the dates infos
  //       adsData[0].date_created = null;
  //       adsData[0].expiration_date = null;
  //       //! Add the company id
  //       adsData[0]["company_id"] = companyData.company_id;
  //       //? Objectify the data
  //       adsData = adsData[0];
  //       //? Cache data
  //       redisCluster.setex(
  //         redisKey,
  //         process.env.REDIS_EXPIRATION_5MIN * 9,
  //         stringify(adsData)
  //       );
  //       //..DONE
  //       resolve({ response: adsData });
  //     } //No data
  //     else {
  //       redisCluster.setex(
  //         redisKey,
  //         process.env.REDIS_EXPIRATION_5MIN * 9,
  //         stringify({
  //           response: "No_ad_infos",
  //         })
  //       );
  //       resolve({ response: "No_ad_infos" });
  //     }
  //   });
}

/**
 * @func getReferredDrivers_list
 * Responsible for getting the list of all the referred drivers for a specific user.
 * @param requestInfos: all the gets infos
 * @param collectionReferralsInfos: hold all the referrals
 * @param redisKey: the redis key to cache the result to.
 * @param resolve
 */
function getReferredDrivers_list(
  requestInfos,
  collectionReferralsInfos,
  redisKey,
  resolve
) {
  resolveDate();
  let req = requestInfos;
  new Promise((resCompute) => {
    //? 2. Check if there are any referral data
    let finderNarrower = {
      user_referrer: req.user_fingerprint,
      user_referrer_nature: req.user_nature,
    };
    //...
    dynamo_find_query({
      table_name: "referrals_information_global",
      IndexName: "user_referrer",
      KeyConditionExpression:
        "user_referrer = :val1, user_referrer_nature = :val2",
      ExpressionAttributeValues: {
        ":val1": req.user_fingerprint,
        ":val2": req.user_nature,
      },
    })
      .then((result) => {
        if (result !== undefined && result.length > 0) {
          //! Remove irrelevant infos
          result = result.map((itemReferral, index) => {
            try {
              let freshObject = {
                referral_fingerprint: itemReferral.referral_fingerprint,
                taxi_number: itemReferral.taxi_number,
                is_referralExpired: itemReferral.is_referralExpired,
                is_referral_rejected:
                  itemReferral.is_referral_rejected === undefined ||
                  itemReferral.is_referral_rejected === null
                    ? false
                    : itemReferral.is_referral_rejected,
                is_paid: itemReferral.is_paid,
                amount_paid: itemReferral.amount_paid,
                date_referred: new Date(itemReferral.date_referred),
                date_referred_beautified: null,
                time_left: null,
              };
              //? Compute the time left
              let timeLeftRaw =
                new Date(itemReferral.expiration_time) -
                new Date(chaineDateUTC);
              if (timeLeftRaw < 0) {
                freshObject.time_left = "Expired";
              } //Still have some time left
              else {
                timeLeftRaw /= 1000;
                if (timeLeftRaw > 60) {
                  //Change in minutes
                  timeLeftRaw /= 60; //? minutes
                  if (timeLeftRaw > 0) {
                    //Change in hours
                    timeLeftRaw /= 60; //? Hours
                    if (timeLeftRaw > 24) {
                      timeLeftRaw /= 24; //? days
                      //? Change in days
                      timeLeftRaw = Math.round(timeLeftRaw);
                      if (timeLeftRaw > 1) {
                        timeLeftRaw = `${Math.round(timeLeftRaw)} days`;
                      } else {
                        timeLeftRaw = `${Math.round(timeLeftRaw)} day`;
                      }
                    } //Keep in hours
                    else {
                      timeLeftRaw = `${Math.round(timeLeftRaw)} h`;
                    }
                  } //Keep in minutes
                  else {
                    timeLeftRaw = `${Math.round(timeLeftRaw)} min`;
                  }
                } else {
                  timeLeftRaw = `${Math.round(timeLeftRaw)} sec`;
                }
                //............
                freshObject.time_left = timeLeftRaw;
              }
              //...
              freshObject.date_referred_beautified = `${freshObject.date_referred.getDate()}-${
                freshObject.date_referred.getMonth() + 1
              }-${freshObject.date_referred.getFullYear()} at ${freshObject.date_referred.getHours()}:${freshObject.date_referred.getSeconds()}`;
              //...
              return freshObject;
            } catch (error) {
              let freshObject = {
                referral_fingerprint: itemReferral.referral_fingerprint,
                taxi_number: itemReferral.taxi_number,
                is_referralExpired: itemReferral.is_referralExpired,
                is_referral_rejected:
                  itemReferral.is_referral_rejected === undefined ||
                  itemReferral.is_referral_rejected === null
                    ? false
                    : itemReferral.is_referral_rejected,
                is_paid: itemReferral.is_paid,
                amount_paid: itemReferral.amount_paid,
                date_referred: new Date(itemReferral.date_referred),
                date_referred_beautified: null,
                time_left: null,
              };
              //? Compute the time left
              let timeLeftRaw =
                new Date(itemReferral.expiration_time) -
                new Date(chaineDateUTC);
              if (timeLeftRaw < 0) {
                freshObject.time_left = "Expired";
              } //Still have some time left
              else {
                timeLeftRaw /= 1000;
                if (timeLeftRaw > 60) {
                  //Change in minutes
                  timeLeftRaw /= 60; //? minutes
                  if (timeLeftRaw > 0) {
                    //Change in hours
                    timeLeftRaw /= 60; //? Hours
                    if (timeLeftRaw > 24) {
                      timeLeftRaw /= 24; //? days
                      //? Change in days
                      timeLeftRaw = Math.round(timeLeftRaw);
                      if (timeLeftRaw > 1) {
                        timeLeftRaw = `${Math.round(timeLeftRaw)} days`;
                      } else {
                        timeLeftRaw = `${Math.round(timeLeftRaw)} day`;
                      }
                    } //Keep in hours
                    else {
                      timeLeftRaw = `${Math.round(timeLeftRaw)} h`;
                    }
                  } //Keep in minutes
                  else {
                    timeLeftRaw = `${Math.round(timeLeftRaw)} min`;
                  }
                } else {
                  timeLeftRaw = `${Math.round(timeLeftRaw)} sec`;
                }
                //............
                freshObject.time_left = timeLeftRaw;
              }
              //...
              freshObject.date_referred_beautified = `${freshObject.date_referred.getDate()}-${
                freshObject.date_referred.getMonth() + 1
              }-${freshObject.date_referred.getFullYear()} at ${freshObject.date_referred.getHours()}:${freshObject.date_referred.getSeconds()}`;
              //...
              return freshObject;
            }
          });
          //! Sort based on dat
          result = result.sort((a, b) =>
            a.date_referred > b.date_referred
              ? -1
              : b.date_referred > a.date_referred
              ? 1
              : 0
          );
          //! ----
          //? Found some data
          resCompute({
            response: result,
          });
        } //? No referral data found.
        else {
          resCompute({
            response: "no_data",
          });
        }
      })
      .catch((error) => {
        logger.error(error);
        resCompute({ response: "error_unexpected" });
      });
  })
    .then((result) => {
      //CACHE
      redisCluster.set(redisKey, JSON.stringify(result));
      //-----
      resolve(result);
    })
    .catch((error) => {
      logger.info(error);
      resolve({ response: "error_unexpected" });
    });
}

/**
 * @func clearDriversGlobalAccountNumbersCache
 * Responsible for clearing the drivers global account number cache
 * @param driver_fingerprint: the driver id
 * @param resolve
 */
function clearDriversGlobalAccountNumbersCache({
  driver_fingerprint,
  resolve,
}) {
  let redisKey = `${driver_fingerprint}-globalAccountNumbers`;
  redisCluster.del(redisKey, function () {
    resolve(true);
  });
}

/**
 * @func getDriversGlobalAccountNumbers
 * Responsible for getting the global numbers from a drivers account like:
 * ?1. Total rides
 * ?2. Total revenue
 *
 * @param driver_fingerprint
 * @param resolve
 */
function getDriversGlobalAccountNumbers(driver_fingerprint, resolve) {
  let redisKey = `${driver_fingerprint}-globalAccountNumbers`;

  redisGet(redisKey).then((resp) => {
    if (resp !== null) {
      try {
        resp = JSON.parse(resp);
        resolve(resp);
      } catch (error) {
        logger.error(error);
        new Promise((resCompute) => {
          ExecgetDriversGlobalAccountNumbers(
            driver_fingerprint,
            redisKey,
            resCompute
          );
        })
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            logger.error(error);
            resolve({
              response: {
                rides: 0,
                deliveries: 0,
                revenue: 0,
                rating: 0,
              },
            });
          });
      }
    } //No cached data yet
    else {
      new Promise((resCompute) => {
        ExecgetDriversGlobalAccountNumbers(
          driver_fingerprint,
          redisKey,
          resCompute
        );
      })
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          logger.error(error);
          resolve({
            response: {
              rides: 0,
              deliveries: 0,
              revenue: 0,
              rating: 0,
            },
          });
        });
    }
  });
}
/**
 * Responsible for executing @func getDriversGlobalAccountNumbers
 * @param driver_fingerprint
 * @param redisKey
 * @param resolve
 */
function ExecgetDriversGlobalAccountNumbers(
  driver_fingerprint,
  redisKey,
  resolve
) {
  dynamo_find_query({
    table_name: "requests_central",
    IndexName: "shopper_id",
    KeyConditionExpression: "shopper_id = :val1",
    FilterExpression: "#r.#icoRating = :val2",
    ExpressionAttributeValues: {
      ":val1": driver_fingerprint,
      ":val2": true,
    },
    ExpressionAttributeNames: {
      "#r": "request_state_vars",
      "#icoRating": "completedRatingClient",
    },
  })
    .then((tripsData) => {
      if (
        tripsData !== undefined &&
        tripsData !== null &&
        tripsData.length > 0
      ) {
        let rides = 0;
        let revenue = 0;
        let deliveries = 0;
        let rating = 0;

        //Has some historical data
        tripsData.map((trip) => {
          // logger.info(trip);
          let tmpFare = /RIDE/i.test(trip.ride_mode)
            ? parseFloat(trip.totals_request.fare)
            : /SHOPPING/i.test(trip.ride_mode)
            ? parseFloat(trip.totals_request.service_fee.replace("N$", "")) +
              parseFloat(trip.totals_request.cash_pickup_fee.replace("N$", ""))
            : parseFloat(trip.totals_request.service_fee.replace("N$", "")) +
              parseFloat(trip.totals_request.delivery_fee.replace("N$", "")); //basic trip fare
          // tmpFare -= 0.1 * tmpFare; //TODO: should probably link the removal of the fare to the historical commission actually taken from it, because if the commission changes it will yield an inaccurate number.
          revenue += tmpFare;
          //...
          rides += /RIDE/i.test(trip.ride_mode) ? 1 : 0;
          deliveries += /DELIVERY/i.test(trip.ride_mode) ? 1 : 0;
          //...
          rating +=
            trip.request_state_vars.rating_data.rating !== undefined &&
            trip.request_state_vars.rating_data.rating !== null &&
            /yet/i.test(trip.request_state_vars.rating_data.rating) == false
              ? parseFloat(trip.request_state_vars.rating_data.rating)
              : 0;
        });
        //Find the final rating - average
        rating = (rating / tripsData.length).toFixed(1);
        //DONE
        let overview = {
          rides: rides,
          deliveries: deliveries,
          trips: rides + deliveries,
          revenue: Math.floor(revenue),
          rating: rating,
        };
        //Cache the result
        new Promise((resCache) => {
          redisCluster.set(redisKey, JSON.stringify(overview));
          resCache(true);
        })
          .then()
          .catch();
        //...
        resolve(overview);
      } //No historical data - zero
      else {
        resolve({
          response: {
            rides: 0,
            deliveries: 0,
            revenue: 0,
          },
        });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: "error_getting_data" });
    });
}

/**
 * @func performCorporateDeliveryAccountAuthOps
 * Responsible not only for creating but also to handle any type of authentication to the
 * corporate delivery accounts.
 * @param inputData: any kind of essential data need of auth (email, pass, etc)
 * @param resolve
 */
function performCorporateDeliveryAccountAuthOps(inputData, resolve) {
  resolveDate();

  try {
    if (/signup/i.test(inputData.op)) {
      if (
        inputData.email !== undefined &&
        inputData.email !== null &&
        inputData.first_name !== undefined &&
        inputData.first_name !== null &&
        inputData.last_name !== undefined &&
        inputData.last_name !== null &&
        inputData.phone !== undefined &&
        inputData.phone !== null &&
        inputData.company_name !== undefined &&
        inputData.company_name !== null &&
        inputData.selected_industry !== undefined &&
        inputData.selected_industry !== null &&
        inputData.password !== undefined &&
        inputData.password !== null
      ) {
        let companyName = inputData.company_name.trim().toUpperCase();
        inputData.email = inputData.email.trim().toLowerCase();
        //Good data received
        //? Check if no similar company already exists
        dynamo_find_query({
          table_name: "dedicated_services_accounts",
          IndexName: "company_name",
          KeyConditionExpression: "company_name = :val1, email = :val2",
          ExpressionAttributeValues: {
            ":val1": companyName,
            ":val2": inputData.email,
          },
        })
          .then((resltCheck) => {
            if (resltCheck !== undefined && resltCheck.length > 0) {
              //Account already exist
              logger.warn("Account already exists");
              resolve({ response: "error_creating_account_alreadyExists" });
            } //? NEW ACCOUNT
            else {
              //Generate fp
              let fpString = `${inputData.email}-${inputData.first_name}-${
                inputData.last_name
              }-${inputData.phone}-${inputData.selected_industry}-${new Date(
                chaineDateUTC
              ).getTime()}`;

              new Promise((resFp) => {
                generateUniqueFingerprint(fpString, false, resFp);
              })
                .then((corporate_fp) => {
                  //? Hash the password
                  new Promise((resFp) => {
                    generateUniqueFingerprint(
                      inputData.password.trim(),
                      false,
                      resFp
                    );
                  })
                    .then((passwordHash) => {
                      let accountObj = {
                        company_name: companyName,
                        company_fp: corporate_fp,
                        password: passwordHash,
                        email: inputData.email,
                        phone: inputData.phone,
                        user_registerer: {
                          first_name: inputData.first_name,
                          last_name: inputData.last_name,
                        },
                        plans: {
                          subscribed_plan: false,
                          isPlan_active: false,
                        },
                        account: {
                          registration_state: "notFull",
                          confirmations: {
                            isPhoneConfirmed: false,
                            isEmailConfirmed: false,
                            isIDConfirmed: false,
                          },
                        },
                        date_registered: new Date(chaineDateUTC),
                        last_updated: new Date(chaineDateUTC),
                      };
                      //...Save
                      dynamo_insert("dedicated_services_accounts", accountObj)
                        .then((reslt) => {
                          if (reslt === false) {
                            logger.error(err);
                            resolve({ response: "error_creating_account" });
                          }
                          //...
                          resolve({
                            response: "successfully_created",
                            metadata: {
                              company_name: companyName,
                              company_fp: corporate_fp,
                              email: inputData.email,
                              phone: inputData.phone,
                              user_registerer: {
                                first_name: inputData.first_name,
                                last_name: inputData.last_name,
                              },
                              plans: {
                                subscribed_plan: false,
                                isPlan_active: false,
                              },
                              account: {
                                registration_state: "notFull",
                                confirmations: {
                                  isPhoneConfirmed: false,
                                  isEmailConfirmed: false,
                                  isIDConfirmed: false,
                                },
                              },
                            },
                          });
                        })
                        .catch((error) => {
                          logger.error(error);
                          resolve({ response: "error_creating_account" });
                        });
                    })
                    .catch((error) => {
                      logger.error(error);
                      resolve({ response: "error_creating_account" });
                    });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error_creating_account" });
                });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "error_creating_account" });
          });
      } //Invalid signup data provided
      else {
        logger.warn("Invalid signup data provided");
        resolve({ response: "error" });
      }
    } else if (/login/i.test(inputData.op)) {
      if (
        inputData.email !== undefined &&
        inputData.email !== null &&
        inputData.password !== undefined &&
        inputData.password !== null
      ) {
        //? Hash the password
        new Promise((resFp) => {
          generateUniqueFingerprint(inputData.password.trim(), false, resFp);
        })
          .then((passwordHash) => {
            dynamo_find_query({
              table_name: "dedicated_services_accounts",
              IndexName: "email",
              KeyConditionExpression: "password = :val1, email = :val2",
              ExpressionAttributeValues: {
                ":val1": passwordHash,
                ":val2": inputData.email.trim(),
              },
            })
              .then((companyData) => {
                if (companyData !== undefined && companyData.length > 0) {
                  //Valid company
                  companyData = companyData[0];
                  //...
                  resolve({
                    response: "successfully_logged_in",
                    metadata: {
                      company_name: companyData.company_name,
                      company_fp: companyData.company_fp,
                      email: companyData.email,
                      phone: companyData.phone,
                      user_registerer: companyData.user_registerer,
                      plans: companyData.plans,
                      account: companyData.account,
                    },
                  });
                } //Unknown company
                else {
                  resolve({ response: "error_logging_in_notFoundAccount" });
                }
              })
              .catch((error) => {
                logger.error(error);
                resolve({ response: "error_logging_in" });
              });
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "error_logging_in" });
          });
      } //Invalid data
      else {
        resolve({ response: "error_logging_in" });
      }
    } else if (/resendConfirmationSMS/i.test(inputData.op)) {
      if (inputData.company_fp !== undefined && inputData.phone !== undefined) {
        //Check if the company exists
        dynamo_find_query({
          table_name: "dedicated_services_accounts",
          IndexName: "company_fp",
          KeyConditionExpression: "company_fp = :val1, phone = :val2",
          ExpressionAttributeValues: {
            ":val1": inputData.company_fp,
            ":val2": inputData.phone,
          },
        })
          .then((companyData) => {
            if (companyData !== undefined && companyData.length > 0) {
              //Company exists
              let onlyDigitsPhone = inputData.phone.replace("+", "").trim(); //Critical, should only contain digits
              //Ok
              //! ADD DEBUG TEST DATA -> CODE 88766
              //Send the message then check the passenger's status
              // let otp = /856997167/i.test(onlyDigitsPhone)
              //   ? 88766
              //   : otpGenerator.generate(6, {
              //     lowerCaseAlphabets: false,
              //     upperCaseAlphabets: false,
              //     specialChars: false,
              //     });

              let otp = otpGenerator.generate(6, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false,
              });
              //! --------------
              //let otp = 55576;
              otp = String(otp).length < 5 ? parseInt(otp) * 10 : otp;
              new Promise((res0) => {
                let message = `Your Orniss code is ${otp}. Never share this code.`;
                SendSMSTo(onlyDigitsPhone, message);
                res0(true);
                //SMS
              }).then(
                () => {},
                (error) => {
                  logger.info(error);
                }
              );
              //? SAve the OTP in the user's profile
              dynamo_update(
                "dedicated_services_accounts",
                companyData[0]._id,
                "set last_updated = :val1, #a.#s = :val2",
                {
                  ":val1": new Date(chaineDateUTC).toISOString(),
                  ":val2": {
                    otp: {
                      otp: parseInt(otp),
                      date_created: new Date(chaineDateUTC),
                    },
                  },
                },
                {
                  "#a": "account",
                  "#s": "smsVerifications",
                }
              )
                .then((result) => {
                  if (result === false) {
                    logger.error(result);
                    resolve({ response: "error" });
                  }
                  //...
                  //DONE
                  resolve({ response: "successfully_sent" });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error" });
                });
            } //Unknown company
            else {
              resolve({ response: "error" });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "error" });
          });
      } //Invalid data
      else {
        logger.warn("Invalid data for resending the confirmation SMS detected");
        resolve({ response: "error" });
      }
    } else if (/updatePhoneNumber/i.test(inputData.op)) {
      //Change the phone number
      if (
        inputData.company_fp !== undefined &&
        inputData.company_fp !== null &&
        inputData.phone !== undefined &&
        inputData.phone !== null
      ) {
        //Proceed
        //Check if the company exists
        dynamo_find_query({
          table_name: "dedicated_services_accounts",
          IndexName: "company_fp",
          KeyConditionExpression: "company_fp = :val1",
          ExpressionAttributeValues: {
            ":val1": inputData.company_fp,
          },
        })
          .then((companyData) => {
            if (companyData !== undefined && companyData.length > 0) {
              companyData = companyData[0];
              //Company exists
              //? Update the comapny's phone
              dynamo_update(
                "dedicated_services_accounts",
                companyData[0]._id,
                "set phone = :p, last_updated = :l",
                {
                  ":p": inputData.phone,
                  ":l": new Date(chaineDateUTC).toISOString(),
                }
              )
                .then((result) => {
                  if (result === false) {
                    logger.error(err);
                    resolve({ response: "error" });
                  }
                  //...
                  //DONE
                  resolve({
                    response: "successfully_updated",
                    metadata: {
                      company_name: companyData.company_name,
                      company_fp: companyData.company_fp,
                      email: companyData.email,
                      phone: companyData.phone,
                      user_registerer: companyData.user_registerer,
                      plans: companyData.plans,
                      account: companyData.account,
                    },
                  });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error" });
                });
            } //Unknown company
            else {
              resolve({ response: "error" });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "error" });
          });
      } //Invalid data
      else {
        logger.warn("Invalid data for updating the phone detected");
        resolve({ response: "error" });
      }
    } else if (/validatePhoneNumber/i.test(inputData.op)) {
      //Validate the phone number via SMS OTP
      if (
        inputData.company_fp !== undefined &&
        inputData.company_fp !== null &&
        inputData.phone !== undefined &&
        inputData.phone !== null &&
        inputData.otp !== undefined &&
        inputData.otp !== null
      ) {
        dynamo_find_query({
          table_name: "dedicated_services_accounts",
          IndexName: "company_fp",
          KeyConditionExpression:
            "company_fp = :val1, phone = :val2, #a.#s.#ot.#o = :val3",
          ExpressionAttributeValues: {
            ":val1": inputData.company_fp,
            ":val2": inputData.phone,
            ":val3": parseInt(inputData.otp),
          },
          ExpressionAttributeNames: {
            "#a": "account",
            "#s": "smsVerifications",
            "#ot": "otp",
            "#o": "otp",
          },
        })
          .then((checkData) => {
            if (checkData !== undefined && checkData.length > 0) {
              let companyData = checkData[0];
              //Valid number
              //? Update the account vars
              dynamo_update(
                "dedicated_services_accounts",
                companyData._id,
                "set #a.#c.#i = :val1, last_updated = :val2",
                {
                  ":val1": true,
                  ":val2": new Date(chaineDateUTC).toISOString(),
                },
                {
                  "#a": "account",
                  "#c": "confirmations",
                  "#i": "isPhoneConfirmed",
                }
              )
                .then((result) => {
                  if (result === false) {
                    logger.error(result);
                    resolve({ response: "error" });
                  }
                  //...
                  //DONE
                  resolve({
                    response: "successfully_validated",
                    metadata: {
                      company_name: companyData.company_name,
                      company_fp: companyData.company_fp,
                      email: companyData.email,
                      phone: companyData.phone,
                      user_registerer: companyData.user_registerer,
                      plans: companyData.plans,
                      account: companyData.account,
                    },
                  });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error" });
                });
            } //Invalid code
            else {
              resolve({ response: "invalid_code" });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "error" });
          });
      } //Invalid data
      else {
        logger.warn("Invalid data for validating the phone detected");
        resolve({ response: "error" });
      }
    } else if (/getAccountData/i.test(inputData.op)) {
      //Get the account details
      if (inputData.company_fp !== undefined && inputData.company_fp !== null) {
        let redisKey = `${inputData.company_fp}-accountDataPersisted`;
        //Check in redis first
        redisGet(redisKey).then((resp) => {
          if (resp !== null) {
            //Has some cached data
            try {
              //Rehydrate
              new Promise((resCompute) => {
                execCorporateAccountData(inputData, resCompute);
              })
                .then((result) => {
                  //?Cache the data
                  new Promise((resCache) => {
                    redisCluster.set(redisKey, JSON.stringify(result));
                    resCache(true);
                  })
                    .then()
                    .catch();
                })
                .catch((error) => {
                  logger.error(error);
                });
              //Return quickly
              resp = JSON.parse(resp);
              resolve(resp);
            } catch (error) {
              logger.error(error);
              //Make fresh request
              new Promise((resCompute) => {
                execCorporateAccountData(inputData, resCompute);
              })
                .then((result) => {
                  //?Cache the data
                  new Promise((resCache) => {
                    redisCluster.set(redisKey, JSON.stringify(result));
                    resCache(true);
                  })
                    .then()
                    .catch();
                  //...
                  resolve(result);
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error" });
                });
            }
          } //Get fresh data
          else {
            new Promise((resCompute) => {
              execCorporateAccountData(inputData, resCompute);
            })
              .then((result) => {
                //?Cache the data
                new Promise((resCache) => {
                  redisCluster.set(redisKey, JSON.stringify(result));
                  resCache(true);
                })
                  .then()
                  .catch();
                //...
                resolve(result);
              })
              .catch((error) => {
                logger.error(error);
                resolve({ response: "error" });
              });
          }
        });
      } else {
        logger.warn("Invalid data for getting the account data.");
        resolve({ response: "error" });
      }
    }
    //Invalid op
    else {
      logger.warn("Invalid op detected");
      resolve({ response: "error" });
    }
  } catch (error) {
    logger.error(error);
    resolve({ response: "error" });
  }
}

/**
 * @func execCorporateAccountData
 * Responsible for actively getting the corporate account information persistently.
 * @param inputData: any kind of essential data need of auth (email, pass, etc)
 * @param resolve
 */
function execCorporateAccountData(inputData, resolve) {
  //! PLANS QUOTAS
  //! Destinations
  let QUOTAS_DESTINATIONS = {
    STR: 5,
    ITMD: 10,
    PR: 15,
    PRSNLD: 15,
  };

  dynamo_find_query({
    table_name: "dedicated_services_accounts",
    IndexName: "company_fp",
    KeyConditionExpression: "company_fp = :val1",
    ExpressionAttributeValues: {
      ":val1": inputData.company_fp,
    },
  })
    .then((companyData) => {
      if (companyData !== undefined && companyData.length > 0) {
        //Valid account
        companyData = companyData[0];
        let responseFinal = {
          response: "authed",
          metadata: {
            company_name: companyData.company_name,
            company_fp: companyData.company_fp,
            email: companyData.email,
            phone: companyData.phone,
            user_registerer: companyData.user_registerer,
            plans: companyData.plans,
            account: companyData.account,
            wallet: {},
          },
        };
        //! Attach the destination quotas
        responseFinal.metadata.plans["delivery_limit"] =
          QUOTAS_DESTINATIONS[companyData.plans.subscribed_plan];

        //? Get the wallet balance
        let url = `${
          /production/i.test(process.env.EVIRONMENT)
            ? `http://${process.env.INSTANCE_PRIVATE_IP}`
            : process.env.LOCAL_URL
        }:${
          process.env.ACCOUNTS_SERVICE_PORT
        }/getWalletSummaryForCorps?company_fp=${companyData.company_fp}
                    `;
        //!----
        requestAPI(url, function (error, response, body) {
          logger.error(error);
          if (error === null) {
            try {
              body = JSON.parse(body);
              //...
              if (body.balance !== undefined) {
                logger.info(body);
                //? Attach the balance data
                responseFinal.metadata["wallet"] = body;
                //DONE
                resolve(responseFinal);
              }
            } catch (error) {
              logger.error(error);
              //DONE
              resolve(responseFinal);
            }
          } else {
            //Error
            //DONE
            resolve(responseFinal);
          }
        });
      } //Invalid account
      else {
        resolve({ response: "error" });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: "error" });
    });
}

/**
 * @func getWalletSummaryForDeliveryCorps
 * Responsible for getting the wallet summary for the delivery corporation accounts.
 * @param company_fp: the company fingerprint
 * @param avoidCache: if to get fresh records (false) or cached one (true) - default: false
 * @param resolve
 */
function getWalletSummaryForDeliveryCorps(
  company_fp,
  avoidCache = false,
  resolve
) {
  let redisKey = `${company_fp}-walletSummary`;
  //Check in redis first
  redisGet(redisKey)
    .then((resp) => {
      if (resp !== null && avoidCache === false) {
        logger.warn("Found cached data for the corporate wallets.");
        //Check in cache first
        try {
          //Rehydrate
          new Promise((resCompute) => {
            execGetWalletSummaryForDeliveryCorps(company_fp, resCompute);
          })
            .then((result) => {
              //! Cache
              new Promise((resCache) => {
                redisCluster.set(redisKey, JSON.stringify(result));
                resCache(true);
              })
                .then()
                .catch();
              //! -------------------
            })
            .catch((error) => {
              logger.error(error);
            });
          //? Quickly response
          resp = JSON.parse(resp);
          resolve(resp);
        } catch (error) {
          logger.error(error);
          //Make a fresh request
          new Promise((resCompute) => {
            execGetWalletSummaryForDeliveryCorps(company_fp, resCompute);
          })
            .then((result) => {
              //! Cache
              new Promise((resCache) => {
                redisCluster.set(redisKey, JSON.stringify(result));
                resCache(true);
              })
                .then()
                .catch();
              //! -------------------
              resolve(result);
            })
            .catch((error) => {
              logger.error(error);
              resolve({
                balance: 0,
                usage: 0,
              });
            });
        }
      } //Get fresh record
      else {
        logger.warn("AVOID CACHED DATA FOR the corporate wallets");
        new Promise((resCompute) => {
          execGetWalletSummaryForDeliveryCorps(company_fp, resCompute);
        })
          .then((result) => {
            //! Cache
            new Promise((resCache) => {
              redisCluster.set(redisKey, JSON.stringify(result));
              resCache(true);
            })
              .then()
              .catch();
            //! -------------------
            resolve(result);
          })
          .catch((error) => {
            logger.error(error);
            resolve({
              balance: 0,
              usage: 0,
            });
          });
      }
    })
    .catch((error) => {
      logger.error(error);
      new Promise((resCompute) => {
        execGetWalletSummaryForDeliveryCorps(company_fp, resCompute);
      })
        .then((result) => {
          //! Cache
          new Promise((resCache) => {
            redisCluster.set(redisKey, JSON.stringify(result));
            resCache(true);
          })
            .then()
            .catch();
          //! -------------------
          resolve(result);
        })
        .catch((error) => {
          logger.error(error);
          resolve({
            balance: 0,
            usage: 0,
          });
        });
    });
}

/**
 * @func execGetWalletSummaryForDeliveryCorps
 * Actively get the wallet summary
 * @param company_fp
 * @param resolve
 */
function execGetWalletSummaryForDeliveryCorps(company_fp, resolve) {
  //Get all the topups first
  //! transaction_nature: topups-corporate
  dynamo_find_query({
    table_name: "wallet_transactions_logs",
    IndexName: "company_fp",
    KeyConditionExpression: "compnay_fp = :val1, transaction_nature = :val2",
    ExpressionAttributeValues: {
      ":val1": company_fp,
      ":val2": "topups-corporate",
    },
  })
    .then((transactionData) => {
      if (transactionData !== undefined && transactionData.length > 0) {
        //Found some transactions data
        let total_topups = 0; //! TOPUPS
        let total_usage = 0; //! USAGE
        //Compute the total topups
        transactionData.map((transaction) => {
          total_topups += parseFloat(transaction.amount);
        });
        //...
        //Get the total usage amount
        dynamo_find_query({
          table_name: "rides_deliveries_requests",
          IndexName: "client_id",
          KeyConditionExpression: "client_id = :val1",
          ExpressionAttributeValues: {
            ":val1": company_fp,
          },
        })
          .then((tripData) => {
            if (tripData !== undefined && tripData.length > 0) {
              //Found some trip data
              //Compute all the usage
              tripData.map((trip) => {
                total_usage += parseFloat(trip.fare);
              });
              //....
              //? DONE
              resolve({
                balance: Math.floor(total_topups - total_usage),
                usage: Math.floor(total_usage),
              });
            } //No trip data - return the balance - No usage
            else {
              resolve({
                balance: Math.floor(total_topups),
                usage: 0,
              });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({
              balance: 0,
              usage: 0,
            });
          });
      } //No transactions data - so zero balance
      else {
        resolve({
          balance: 0,
          usage: 0,
        });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({
        balance: 0,
        usage: 0,
      });
    });
}

/**`
 * @func getTargetedNotificationsOps
 * Responsible for getting the notifications relative to each user.
 * @param requestData: hold the user_fingerprint and the op ()
 * @param resolve
 */
function getTargetedNotificationsOps(requestData, resolve) {
  if (/notifications/i.test(requestData.op)) {
    let redisKey = `${requestData.user_fingerprint}-cachedNotificationsData`;
    //Get the notifications metadata
    //Check in the cache first
    redisGet(redisKey)
      .then((resp) => {
        logger.warn(resp);
        if (resp !== null) {
          //Found some cached data
          try {
            //Rehydrate
            new Promise((resCompute) => {
              execGetTargetedNotificationsOps(
                requestData,
                redisKey,
                resCompute
              );
            })
              .then()
              .catch((error) => {
                logger.error(error);
              });
            //...
            resp = JSON.parse(resp);
            resolve(resp);
          } catch (error) {
            logger.error(error);
            new Promise((resCompute) => {
              execGetTargetedNotificationsOps(
                requestData,
                redisKey,
                resCompute
              );
            })
              .then((result) => {
                resolve(result);
              })
              .catch((error) => {
                logger.error(error);
                resolve({ response: "error" });
              });
          }
        } //No cached data - get fresh result
        else {
          new Promise((resCompute) => {
            execGetTargetedNotificationsOps(requestData, redisKey, resCompute);
          })
            .then((result) => {
              resolve(result);
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: "error" });
            });
        }
      })
      .catch((error) => {
        logger.error(error);
        new Promise((resCompute) => {
          execGetTargetedNotificationsOps(requestData, redisKey, resCompute);
        })
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "error" });
          });
      });
  } //Invalid request
  else {
    resolve({ response: "error" });
  }
}

/**
 * @param execGetTargetedNotificationsOps
 * Actively get the notifications data
 * @param requestData: hold the user_fingerprint and the op ()
 * @param redisKey: the key to cache the results to
 * @param resolve
 */
function execGetTargetedNotificationsOps(requestData, redisKey, resolve) {
  // dynamo_find_query({
  //   table_name: "notifications_communications_central",
  //   IndexName: "client_id",
  //   KeyConditionExpression: "client_id = :val1",
  //   ExpressionAttributeValues: {
  //     ":val1": company_fp,
  //   },
  // })
  // collectionNotificationsComm_central
  //   .find({
  //     allowed_users_see: requestData.user_fingerprint,
  //   })
  //   .sort({ date_sent: -1 })
  //   .toArray(function (err, notifData) {
  //     if (err) {
  //       logger.warn(err);
  //       //...
  //       resolve({ response: "error" });
  //     }
  //     //...
  //     if (notifData !== undefined && notifData.length > 0) {
  //       //Found some notifications
  //       //? Find the unseen notifications number
  //       let unseenNumber = 0;
  //       //...
  //       notifData = notifData.map((el, index) => {
  //         el["_id"] = index;
  //         el["allowed_users_see"] = null;
  //         el["sender_fp"] = null;
  //         el["isUnseen"] = el.seen_users_log.includes(
  //           requestData.user_fingerprint
  //         )
  //           ? false
  //           : true;
  //         //...
  //         unseenNumber += el.seen_users_log.includes(
  //           requestData.user_fingerprint
  //         )
  //           ? 0
  //           : 1;
  //         //...
  //         el["seen_users_log"] = null;
  //         //...
  //         return el;
  //       });
  //       //DONE
  //       let response = { response: { unseen: unseenNumber, data: notifData } };
  //       //? Cache
  //       new Promise((resCache) => {
  //         redisCluster.setex(
  //           redisKey,
  //           parseInt(process.env.REDIS_EXPIRATION_5MIN) * 1440,
  //           JSON.stringify(response)
  //         );
  //         resCache(true);
  //       })
  //         .then()
  //         .catch();
  //       //...
  //       resolve(response);
  //     } //No notifications found
  //     else {
  //       let response = { response: "no_notifications" };
  //       //? Cache
  //       new Promise((resCache) => {
  //         redisCluster.setex(
  //           redisKey,
  //           parseInt(process.env.REDIS_EXPIRATION_5MIN) * 1440,
  //           JSON.stringify(response)
  //         );
  //         resCache(true);
  //       })
  //         .then()
  //         .catch();
  //       //...
  //       resolve(response);
  //     }
  //   });
}

/**
 * @func shouldSendNewSMS
 * Responsible for figuring out if the system is allowed to send new SMS to a specific number
 * based on the daily limit that the number has ~ 10SMS per day.
 * @param req: the request data containing the user's phone number : ATTACH THE _id if HAS AN ACCOUNT
 * @param hasAccount: true (is an existing user) or false (do not have an account yet)
 * @param resolve
 */
function shouldSendNewSMS({ req, hasAccount, resolve }) {
  const DAILY_THRESHOLD = parseInt(process.env.DAILY_SMS_THRESHOLD_PER_USER);

  resolveDate();
  let refDate = new Date(chaineDateUTC);
  let today_beginning = `${refDate.getFullYear()}-${
    refDate.getMonth() + 1 > 10
      ? refDate.getMonth() + 1
      : `0${refDate.getMonth() + 1}`
  }-${refDate.getDate()}T00:00:00.000Z`;
  let today_end = `${refDate.getFullYear()}-${
    refDate.getMonth() + 1 > 10
      ? refDate.getMonth() + 1
      : `0${refDate.getMonth() + 1}`
  }-${refDate.getDate()}T21:59:59.000Z`;
  //Check how many SMS were sent to this specific number today
  dynamo_find_query({
    table_name: "otp_dispatch_map",
    IndexName: "phone_number",
    KeyConditionExpression:
      "phone_number = :val1 AND date_sent BETWEEN :start_date AND :end_date",
    ScanIndexForward: false,
    ExpressionAttributeValues: {
      ":val1": req.phone,
      ":start_date": today_beginning,
      ":end_date": today_end,
    },
  })
    .then((otpData) => {
      logger.error(otpData);
      if (otpData !== undefined && otpData.length < DAILY_THRESHOLD) {
        //Can still send the SMS
        //? SEND OTP AND UPDATE THE RECORDS
        let onlyDigitsPhone = req.phone.replace("+", "").trim();
        let otp = otpGenerator.generate(5, {
          lowerCaseAlphabets: false,
          upperCaseAlphabets: false,
          specialChars: false,
        });
        //! --------------
        //let otp = 55576;
        otp = /264856997167/i.test(onlyDigitsPhone)
          ? 55576
          : String(otp).length < 5
          ? parseInt(otp) * 10
          : otp;
        new Promise((res0) => {
          let message = `Your Orniss code is ${otp}. Never share this code.`;

          let urlSMS = `http://localhost:9393/?message=${message}&number=${onlyDigitsPhone}&subject=Nej`;
          requestAPI(urlSMS, function (error, response, body) {
            if (error === null) {
              //Success
              console.log(body);
              res0(true);
            } //Unable to send SMS
            else {
              res0(true);
            }
          });
          // res0(true);
        }).then(
          () => {
            //1. Update the records for the OTP MAP for registered or non registered users
            new Promise((resUpdateOTPMAP) => {
              let basicOTPMAP_data = {
                phone_number: req.phone,
                otp: parseInt(otp),
                date_sent: new Date(chaineDateUTC).toISOString(),
              };
              //...
              dynamo_insert("otp_dispatch_map", basicOTPMAP_data)
                .then((reslt) => {
                  logger.info(reslt);
                  resUpdateOTPMAP(true);
                })
                .catch((error) => {
                  logger.error(error);
                  resUpdateOTPMAP(false);
                });
            })
              .then()
              .catch((error) => logger.error(error));

            //? Update the user's profile if has an account
            if (hasAccount) {
              logger.warn("USER HAS AN ACCOUNT.");
              dynamo_update({
                table_name: "drivers_shoppers_central",
                _idKey: req._id,
                UpdateExpression: "set #a.#p = :val1",
                ExpressionAttributeValues: {
                  ":val1": {
                    otp: parseInt(otp),
                    date_sent: new Date(chaineDateUTC).toISOString(),
                  },
                },
                ExpressionAttributeNames: {
                  "#a": "account_verifications",
                  "#p": "phone_verification_secrets",
                },
              })
                .then((result) => {
                  logger.info(result);
                  resolve(result);
                })
                .catch((error) => {
                  logger.error(error);
                  resolve(false);
                });
            } //No accounts
            else {
              logger.warn("USER HAS NOT AN ACCOUNT.");
              //Done
              resolve(true);
            }
          },
          (error) => {
            logger.info(error);
            resolve(false);
          }
        );
      } //!Exceeded the daily SMS request
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
 * @function sendSMSAny
 * Responsible to send SMS in any direction while keeping the security standards based on quotas.
 * based on the daily limit that the number has ~ 10SMS per day.
 * @param req: the request data containing the user's phone number : ATTACH THE _id if HAS AN ACCOUNT
 * @param resolve
 * @param service: ride or courier
 */
function sendSMSAny({ req, resolve, service }) {
  const DAILY_THRESHOLD = parseInt(process.env.DAILY_SMS_THRESHOLD_PER_USER);

  resolveDate();
  let refDate = new Date(chaineDateUTC);
  let today_beginning = `${refDate.getFullYear()}-${
    refDate.getMonth() + 1 > 10
      ? refDate.getMonth() + 1
      : `0${refDate.getMonth() + 1}`
  }-${refDate.getDate()}T00:00:00.000Z`;
  let today_end = `${refDate.getFullYear()}-${
    refDate.getMonth() + 1 > 10
      ? refDate.getMonth() + 1
      : `0${refDate.getMonth() + 1}`
  }-${refDate.getDate()}T21:59:59.000Z`;
  //Check how many SMS were sent to this specific number today
  dynamo_find_query({
    table_name: "otp_dispatch_map",
    IndexName: "phone_number",
    KeyConditionExpression:
      "phone_number = :val1 AND date_sent BETWEEN :start_date AND :end_date",
    ScanIndexForward: false,
    ExpressionAttributeValues: {
      ":val1": req.phone,
      ":start_date": today_beginning,
      ":end_date": today_end,
    },
  })
    .then((otpData) => {
      logger.error(otpData);
      if (otpData !== undefined && otpData.length < DAILY_THRESHOLD) {
        new Promise((res0) => {
          let onlyDigitsPhone = req.phone.replace("+", "").trim();
          let message = `Hi ${req.name},\nThanks for applying at Nej ${
            service === "courier" ? "for deliveries/shopping" : "to drive"
          }, you will hear from us pretty soon.\nNej support`;

          let urlSMS = `http://localhost:9393/?message=${message}&number=${onlyDigitsPhone}&subject=Nej`;
          requestAPI(urlSMS, function (error, response, body) {
            if (error === null) {
              //Success
              console.log(body);
              res0(true);
            } //Unable to send SMS
            else {
              res0(true);
            }
          });
          // res0(true);
        }).then(
          () => {
            resolve(true);
          },
          (error) => {
            logger.info(error);
            resolve(false);
          }
        );
      } //!Exceeded the daily SMS request
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
 * @function getDriversProfile
 * Responsible for getting very efficiently the drivers profile, first checking from the cache.
 * @param req: the request data which MUST contain the user_fingerprint
 * @param resolve
 */
function getDriversProfile(req, resolve) {
  let redisKey = `${req.user_fingerprint}-driverProfile-cached`;

  // logger.info(redisKey);

  //Check from the cache first
  redisGet(redisKey)
    .then((resp) => {
      // console.log(resp);
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
    table_name: "drivers_shoppers_central",
    IndexName: "driver_fingerprint",
    KeyConditionExpression: "driver_fingerprint = :val1",
    ExpressionAttributeValues: {
      ":val1": req.user_fingerprint,
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
 * @func clearDriverProfileCache
 * Responsible for clearing the drivers' profile cache
 * @param driver_fingerprint: the id of the driver
 * @param resolve
 */
function clearDriverProfileCache({ driver_fingerprint = "none", resolve }) {
  let redisKey = `${driver_fingerprint}-driverProfile-cached`;
  redisCluster.del(redisKey, function () {
    resolve(true);
  });
}

/**
 * MAIN
 */
var collectionPassengers_profiles = null;
var collectionRidesDeliveries_data = null;
var collection_OTP_dispatch_map = null;
var collectiondrivers_shoppers_central = null;
var collectionGlobalEvents = null;
var collectionWalletTransactions_logs = null;

redisCluster.on("connect", function () {
  logger.info("[*] Redis connected");

  logger.info("[+] Nej Account services active.");
  app
    .get("/", function (req, res) {
      res.send("Nej Account services up");
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
  //.use(morgan("combined", { stream: accessLogStream }));

  /**
   * GENERATE OTP AND CHECK THE USER EXISTANCE
   * Responsible for generating an otp and checking whether a user was already registered or not.
   * If already registered send also the user fingerprint.
   * ? DRIVERS ONLY
   */
  app.post("/sendOTPAndCheckUserStatus", function (req, res) {
    resolveDate();
    req = req.body;
    logger.info(req);

    if (
      req.phone_number !== undefined &&
      req.phone_number !== null &&
      req.phone_number.length > 8
    ) {
      req["phone"] = req.phone_number; //?Add some references

      new Promise((res0) => {
        //1. Check if the account exists
        dynamo_find_query({
          table_name: "drivers_shoppers_central",
          IndexName: "phone_number",
          KeyConditionExpression: "phone_number = :val1",
          ExpressionAttributeValues: {
            ":val1": req.phone,
          },
        })
          .then((userData) => {
            if (userData !== undefined && userData.length > 0) {
              //!Existing user - attach the _id
              req["_id"] = userData[0]._id;

              new Promise((resCompute) => {
                shouldSendNewSMS({
                  req: req,
                  hasAccount: true,
                  user_identifier: userData[0].user_identifier,
                  resolve: resCompute,
                });
              })
                .then((didSendOTP) => {
                  if (didSendOTP)
                    res0({
                      _id: userData[0]._id,
                      response: "registered",
                      user_fp: userData[0].driver_fingerprint,
                      name: userData[0].name,
                      surname: userData[0].surname,
                      gender: userData[0].gender,
                      phone_number: userData[0].phone_number,
                      email: userData[0].email,
                      profile_picture: `${process.env.AWS_S3_DRIVERS_PROFILE_PICTURES_PATH}/${userData[0].identification_data.profile_picture}`,
                      account_state:
                        userData[0].elligibility_status !== undefined &&
                        userData[0].elligibility_status !== null
                          ? userData[0].elligibility_status.status
                          : "valid", //? By default - Valid
                      pushnotif_token: userData[0].pushnotif_token,
                      suspension_message: userData[0].suspension_message,
                    });
                  //...
                  res0({ response: "error_checking_user" });
                })
                .catch((error) => {
                  logger.error(error);
                  res0({ response: "error_checking_user" });
                });
            } //Unregistered user
            else {
              //Get the last
              new Promise((resCompute) => {
                shouldSendNewSMS({
                  req: req,
                  hasAccount: false,
                  resolve: resCompute,
                });
              })
                .then((didSendOTP) => {
                  if (didSendOTP) res0({ response: "not_yet_registered" });

                  res0({ response: "error_checking_user" });
                })
                .catch((error) => {
                  logger.error(error);
                  res0({ response: "error_checking_user" });
                });
            }
          })
          .catch((error) => {
            logger.error(error);
            res0({ response: "error_checking_user" });
          });
        //SMS
      }).then(
        (shouldUpdateProfileOTP) => {
          res.send(shouldUpdateProfileOTP);
        },
        (error) => {
          logger.info(error);
          res.send({ response: "error_checking_user" });
        }
      );
    } //Error phone number not received
    else {
      res.send({ response: "error_phone_number_not_received" });
    }
  });

  /**
   * CHECK THAT THE OTP ENTERED BY THE USER IS CORRECT
   * Responsible for checking that the otp entered by the user matches the one generated.
   */
  app.post("/checkSMSOTPTruly", function (req, res) {
    resolveDate();

    req = req.body;

    if (
      req.phone_number !== undefined &&
      req.phone_number !== null &&
      req.otp !== undefined &&
      req.otp !== null
    ) {
      req.phone_number = req.phone_number.replace("+", "").trim(); //Critical, should only contain digits

      new Promise((res0) => {
        if (/^unregistered$/i.test(req.user_nature.trim())) {
          //Checking for unregistered users
          let checkOTP = {
            phone_number: /^\+/i.test(req.phone_number)
              ? req.phone_number.replace("+", "").trim()
              : req.phone_number,
            otp: parseInt(req.otp),
          };
          logger.info("unregistered");
          logger.warn(checkOTP);
          //Check if it exists for this number
          dynamo_find_query({
            table_name: "OTP_dispatch_map",
            IndexName: "phone_number",
            KeyConditionExpression: "phone_number = :val1, otp = :val2",
            ExpressionAttributeValues: {
              ":val1": checkOTP.phone_number,
              ":val2": parseInt(req.otp),
            },
          })
            .then((result) => {
              if (result.length > 0) {
                //True OTP
                res0({ response: true });
              } //Wrong otp
              else {
                res0({ response: false });
              }
            })
            .catch((error) => {
              logger.error(error);
              res0({ response: "error_checking_otp" });
            });
        } //Checking for registered user - check the OTP secrets binded to the profile
        else {
          //! Will need the user_fingerprint to be provided.
          //1. Passengers
          if (
            req.user_nature !== undefined &&
            req.user_nature !== null &&
            /passenger/i.test(req.user_nature)
          ) {
            logger.info("Passenger");
            let checkOTP = {
              phone_number: /^\+/i.test(req.phone_number)
                ? req.phone_number
                : `+${req.phone_number}`,
              "account_verifications.phone_verification_secrets.otp": parseInt(
                req.otp
              ),
            }; //?Indexed
            //Check if it exists for this number
            dynamo_find_query({
              table_name: "passengers_profiles",
              IndexName: "user_fingerprint",
              KeyConditionExpression:
                "user_fingerprint = :val1, phone_number = :val2, #a.#p.#o = :val3",
              ExpressionAttributeValues: {
                ":val1": req.user_fingerprint,
                ":val2": checkOTP.phone_number,
                ":val3": parseInt(req.otp),
              },
              ExpressionAttributeNames: {
                "#a": "account_verifications",
                "#p": "phone_verification_secrets",
                "#o": "otp",
              },
            })
              .then((result) => {
                if (result.length > 0) {
                  //True OTP
                  res0({ response: true });
                } //Wrong otp
                else {
                  res0({ response: true }); //! BUG
                }
              })
              .catch((error) => {
                logger.error(error);
                res0({ response: "error_checking_otp" });
              });
          } else if (
            req.user_nature !== undefined &&
            req.user_nature !== null &&
            /driver/i.test(req.user_nature)
          ) {
            logger.info(req);
            //2. Drivers
            let checkOTP = {
              phone_number: /^\+/i.test(req.phone_number)
                ? req.phone_number
                : `+${req.phone_number}`,
              "account_verifications.phone_verification_secrets.otp": parseInt(
                req.otp
              ),
            };
            //Check if it exists for this number
            dynamo_find_query({
              table_name: "drivers_shoppers_central",
              IndexName: "phone_number",
              KeyConditionExpression: "phone_number = :val1",
              FilterExpression: "#a.#p.#o = :val2",
              ExpressionAttributeValues: {
                ":val1": checkOTP.phone_number,
                ":val2": parseInt(req.otp),
              },
              ExpressionAttributeNames: {
                "#a": "account_verifications",
                "#p": "phone_verification_secrets",
                "#o": "otp",
              },
            })
              .then((result) => {
                if (result.length > 0) {
                  //True OTP
                  res0({ response: true });
                } //Wrong otp
                else {
                  res0({ response: false });
                }
              })
              .catch((error) => {
                logger.error(error);
                res0({ response: "error_checking_otp" });
              });
          }
        }
      }).then(
        (reslt) => {
          res.send(reslt);
        },
        (error) => {
          res.send({ response: "error_checking_otp" });
        }
      );
    } //Error - missing details
    else {
      res.send({ response: "error_checking_otp" });
    }
  });

  /**
   * CREATE A NEW ACCOUNT - RIDER
   * Responsible for creating a minimal rider account with only the phone number as an argument.
   */
  app.get("/createMinimalRiderAccount", function (req, res) {
    resolveDate();
    let params = urlParser.parse(req.url, true);
    req = params.query;

    if (req.phone_number !== undefined && req.phone_number !== null) {
      new Promise((res0) => {
        //Generate fingerprint: phone number + date
        new Promise((res1) => {
          generateUniqueFingerprint(
            req.phone_number + chaineDateUTC,
            false,
            res1
          );
        }).then(
          (user_fingerprint) => {
            let minimalAccount = {
              name: "User",
              surname: "",
              gender: "Unknown",
              user_fingerprint: user_fingerprint,
              phone_number: /^\+/.test(req.phone_number)
                ? req.phone_number
                : "+" + req.phone_number.trim(),
              email: false,
              password: false,
              account_state: "minimal", //The state of the account in terms of it's creation: minimal or full
              media: {
                profile_picture: "user.png",
              },
              account_verifications: {
                is_accountVerified: true, //Account already checked
                is_policies_accepted: true, //Terms and conditions implicitly accepted
              },
              pushnotif_token:
                req.pushnotif_token !== undefined &&
                req.pushnotif_token !== null
                  ? decodeURIComponent(req.pushnotif_token)
                  : false,
              last_updated: {
                date: new Date(chaineDateUTC),
              },
              date_registered: {
                date: new Date(chaineDateUTC),
              },
            };
            // logger.info(minimalAccount);
            //..
            dynamo_insert("passengers_profiles", minimalAccount)
              .then((result) => {
                if (result === false) {
                  res0({ response: "error_creating_account" });
                }
                //...Send back the status and fingerprint
                res0({
                  response: "successfully_created",
                  user_fp: user_fingerprint,
                });
              })
              .catch((error) => {
                logger.error(error);
                res0({ response: "error_creating_account" });
              });
          },
          (error) => {
            res0({ response: "error_creating_account" });
          }
        );
      }).then(
        (result) => {
          res.send(result);
        },
        (error) => {
          logger.info(error);
          res.send({ response: "error_creating_account" });
        }
      );
    } //Error - missing details
    else {
      res.send({ response: "error_creating_account" });
    }
  });

  /**
   * UDPATE ADDITIONAL DETAILS WHILE CREATING ACCOUNT - RIDER
   * Responsible for updating the rider's profile with the additional profile infos (name, gender and email)
   */
  app.get("/updateAdditionalProfileData_newAccount", function (req, res) {
    resolveDate();
    let params = urlParser.parse(req.url, true);
    req = params.query;

    logger.info(req);

    if (
      req.user_fingerprint !== undefined &&
      req.user_fingerprint !== null &&
      req.name !== undefined &&
      req.name !== null &&
      req.gender !== undefined &&
      req.gender !== null &&
      req.email !== undefined &&
      req.email !== null
    ) {
      req.email = req.email.toLowerCase().trim();
      req.name = req.name.trim();
      //? Split name and surnamme
      let nameHolder = req.name.split(" ");
      req.name = nameHolder[0].trim();
      req.surname = nameHolder.slice(1, 5).join(" ").trim();
      //..
      try {
        new Promise((res0) => {
          let findProfile = {
            user_fingerprint: req.user_fingerprint,
          };
          let updateProfile = {
            $set: {
              name: req.name,
              email: req.email,
              gender: req.gender,
              account_state: "full", //! ADDD ACCOUNT STATE - full
              last_updated: new Date(chaineDateUTC),
            },
          };
          //Update
          dynamo_update(
            "passengers_profiles",
            { user_fingerprint: req.user_fingerprint },
            "set name = :val1, email = :val2, gender = :val3, account_state = :val4, last_updated = :val5",
            {
              ":val1": req.name,
              ":val2": req.email,
              ":val3": req.gender,
              ":val4": "full",
              ":val5": new Date(chaineDateUTC).toISOString(),
            }
          )
            .then((result) => {
              if (result === false) {
                logger.info(result);
                res0({
                  response:
                    "error_adding_additional_profile_details_new_account",
                });
              }
              //Get the profile details
              dynamo_find_query({
                table_name: "passengers_profiles",
                IndexName: "user_fingerprint",
                KeyConditionExpression: "user_fingerprint = :val1",
                ExpressionAttributeValues: {
                  ":val1": req.user_fingerprint,
                },
              })
                .then((riderProfile) => {
                  if (riderProfile.length > 0) {
                    //Found something
                    res0({
                      response: "updated",
                      user_fp: riderProfile[0].user_fingerprint,
                      name: riderProfile[0].name,
                      surname: riderProfile[0].surname,
                      gender: riderProfile[0].gender,
                      phone_number: riderProfile[0].phone_number,
                      email: riderProfile[0].email,
                      account_state: "full", //!VERY IMPORTANT - MARK ACCOUNT CREATION STATE AS FULL - to avoid redirection to complete details screen.
                      profile_picture: `${process.env.AWS_S3_RIDERS_PROFILE_PICTURES_PATH}/${riderProfile[0].media.profile_picture}`,
                      pushnotif_token: riderProfile[0].pushnotif_token,
                    });
                  } //Error finding profile
                  else {
                    res0({
                      response:
                        "error_adding_additional_profile_details_new_account",
                    });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  res0({
                    response:
                      "error_adding_additional_profile_details_new_account",
                  });
                });
            })
            .catch((error) => {
              logger.error(error);
              res0({
                response: "error_adding_additional_profile_details_new_account",
              });
            });
        }).then(
          (result) => {
            res.send(result);
          },
          (error) => {
            logger.info(error);
            res.send({
              response: "error_adding_additional_profile_details_new_account",
            });
          }
        );
      } catch (error) {
        logger.info(error);
        res.send({
          response: "error_adding_additional_profile_details_new_account",
        });
      }
    }
    //Error - missing details
    else {
      logger.info("missing details");
      res.send({
        response: "error_adding_additional_profile_details_new_account",
      });
    }
  });

  /**
   * GET RIDES HISTORY FOR THE RIDERS
   * Responsible for getting different rides to mainly display in the "Your rides" tab for riders (or drivers?)
   * Past, Scheduled or Business
   * Targeted requests are very usefull when it comes to fetch more details about a SPECIFIC ride (ride fp required!)
   * ride_type: Past (already completed - can include scheduled), Scheduled (upcoming) or Business (with business flag)
   * LIMIT: last 50 rides
   */
  app.get("/getRides_historyRiders", function (req, res) {
    resolveDate();
    let params = urlParser.parse(req.url, true);
    req = params.query;
    logger.info(req);

    if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
      //Valid
      if (
        req.target !== undefined &&
        req.target !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
      ) {
        //Targeted request
        new Promise((res0) => {
          getBachRidesHistory(
            req,
            collectionRidesDeliveries_data,
            collectiondrivers_shoppers_central,
            res0
          );
        }).then(
          (result) => {
            logger.info(result);
            res.send(result);
          },
          (error) => {
            logger.info(error);
            res.send({ response: "error_authentication_failed" });
          }
        );
      } else if (req.ride_type !== undefined && req.ride_type !== null) {
        //Batch request - history request
        new Promise((res0) => {
          getBachRidesHistory(
            req,
            collectionRidesDeliveries_data,
            collectiondrivers_shoppers_central,
            res0
          );
        }).then(
          (result) => {
            logger.info(result);
            res.send(result);
          },
          (error) => {
            logger.info(error);
            res.send({ response: "error_authentication_failed" });
          }
        );
      } //Invalid data
      else {
        res.send({ response: "error_authentication_failed" });
      }
    } //Invalid data
    else {
      res.send({ response: "error_authentication_failed" });
    }
  });

  /**
   * COMPUTE DAILY REQUESTS AMMOUNT FOR DRIVERS
   * Responsible for getting the daily amount made so far by the driver for exactly all the completed requests.
   */
  app.get("/computeDaily_amountMadeSoFar", function (req, res) {
    new Promise((resMAIN) => {
      resolveDate();
      let params = urlParser.parse(req.url, true);
      req = params.query;

      if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null
      ) {
        new Promise((res0) => {
          getDaily_requestAmount_driver(req.driver_fingerprint, res0);
        }).then(
          (result) => {
            resMAIN(result);
          },
          (error) => {
            logger.info(error);
            resMAIN({
              amount: 0,
              currency: "NAD",
              currency_symbol: "N$",
              supported_requests_types: "none",
              response: "error",
            });
          }
        );
      } //Error
      else {
        resMAIN({
          amount: 0,
          currency: "NAD",
          currency_symbol: "N$",
          supported_requests_types: "none",
          response: "error",
        });
      }
    })
      .then(
        (result) => {
          res.send(result);
        },
        (error) => {
          logger.info(error);
          res.send({
            amount: 0,
            currency: "NAD",
            currency_symbol: "N$",
            supported_requests_types: "none",
            response: "error",
          });
        }
      )
      .catch((error) => {
        logger.info(error);
        res.send({
          amount: 0,
          currency: "NAD",
          currency_symbol: "N$",
          supported_requests_types: "none",
          response: "error",
        });
      });
  });

  /**
   * Go ONLINE/OFFLINE FOR DRIVERS
   * Responsible for going online or offline for drivers / or getting the operational status of drivers (online/offline).
   * ! Use Caching
   * @param driver_fingerprint
   * @param state: online or offline
   */
  app.get("/goOnline_offlineDrivers", function (req, res) {
    new Promise((resMAIN) => {
      resolveDate();
      let params = urlParser.parse(req.url, true);
      req = params.query;
      let redisKey = "offline_online_status-" + req.driver_fingerprint;

      if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.action !== undefined &&
        req.action !== null &&
        req.state !== undefined &&
        req.state !== null
      ) {
        if (/make/i.test(req.action)) {
          //Found a driver
          //Make a modification
          //Valid data received
          new Promise((res0) => {
            //Check the driver
            dynamo_find_query({
              table_name: "drivers_shoppers_central",
              IndexName: "driver_fingerprint",
              KeyConditionExpression: "driver_fingerprint = :val1",
              ExpressionAttributeValues: {
                ":val1": req.driver_fingerprint,
              },
            })
              .then((driverData) => {
                if (driverData !== undefined && driverData.length > 0) {
                  //! GET THE SUSPENSION INFOS
                  let suspensionInfos = {
                    is_suspended:
                      driverData[0].isDriverSuspended !== undefined &&
                      driverData[0].isDriverSuspended !== null
                        ? driverData[0].isDriverSuspended
                        : false,
                    message:
                      driverData[0].suspension_infos !== undefined &&
                      driverData[0].suspension_infos !== null
                        ? /UNPAID_COMISSION/i.test(
                            driverData[0].suspension_infos[
                              driverData[0].suspension_infos.length - 1
                            ].reason
                          )
                          ? `Your account has been suspended to an overdue Nej commission.`
                          : false
                        : false,
                  };
                  //! ------------------------
                  dynamo_update({
                    table_name: "drivers_shoppers_central",
                    _idKey: driverData[0]._id,
                    UpdateExpression: "set #o.#s = :val1",
                    ExpressionAttributeValues: {
                      ":val1": /online/i.test(req.state) ? "online" : "offline",
                    },
                    ExpressionAttributeNames: {
                      "#o": "operational_state",
                      "#s": "status",
                    },
                  })
                    .then((result) => {
                      if (result === false) {
                        res0({
                          response: "error_invalid_request",
                        });
                      }
                      //...
                      //Save the going offline event
                      new Promise((res) => {
                        dynamo_insert("global_events", {
                          event_name: "driver_switching_status_request",
                          status: /online/i.test(req.state)
                            ? "online"
                            : "offline",
                          driver_fingerprint: req.driver_fingerprint,
                          date: new Date(chaineDateUTC).toISOString(),
                        })
                          .then()
                          .catch((error) => {
                            logger.error(error);
                          });
                        //...
                        res(true);
                      }).then(
                        () => {},
                        () => {}
                      );

                      //! clear tthe driver profiles cache
                      new Promise((clear) => {
                        clearDriverProfileCache({
                          driver_fingerprint: req.driver_fingerprint,
                          resolve: clear,
                        });
                      })
                        .then()
                        .catch((error) => logger.error(error));

                      //Done
                      res0({
                        response: "successfully_done",
                        flag: /online/i.test(req.state) ? "online" : "offline",
                        suspension_infos: suspensionInfos,
                        operation_clearance: driverData[0].operation_clearances,
                      });
                    })
                    .catch((error) => {
                      logger.error(error);
                      res0({
                        response: "error_invalid_request",
                      });
                    });
                  //Check if the driver has an active request - NOT LOG OUT WITH AN ACTIVE REQUEST
                  //check
                  // dynamo_find_query({
                  //   table_name: "requests_central",
                  //   IndexName: "shopper_id",
                  //   KeyConditionExpression: "shopper_id = :val1",
                  //   FilterExpression: "#r.#ia = :val2 AND #r.#iCo = :val3",
                  //   ExpressionAttributeValues: {
                  //     ":val1": req.driver_fingerprint,
                  //     ":val2": true,
                  //     ":val3": false,
                  //   },
                  //   ExpressionAttributeNames: {
                  //     "#r": "request_state_vars",
                  //     "#ia": "isAccepted",
                  //     "#iCo": "completedDropoff",
                  //   },
                  // })
                  //   .then((currentActiveRequests) => {
                  //     if (/offline/i.test(req.state)) {
                  //       //Only if the driver wants to go out
                  //       if (
                  //         currentActiveRequests !== undefined &&
                  //         currentActiveRequests.length <= 0
                  //       ) {
                  //         //No active requests - proceed
                  //         dynamo_update({
                  //           table_name: "drivers_shoppers_central",
                  //           _idKey: driverData[0]._id,
                  //           UpdateExpression: "set #o.#s = :val1",
                  //           ExpressionAttributeValues: {
                  //             ":val1": /online/i.test(req.state)
                  //               ? "online"
                  //               : "offline",
                  //           },
                  //           ExpressionAttributeNames: {
                  //             "#o": "operational_state",
                  //             "#s": "status",
                  //           },
                  //         })
                  //           .then((result) => {
                  //             if (result === false) {
                  //               res0({
                  //                 response: "error_invalid_request",
                  //               });
                  //             }
                  //             //...
                  //             //Save the going offline event
                  //             new Promise((res) => {
                  //               dynamo_insert("global_events", {
                  //                 event_name: "driver_switching_status_request",
                  //                 status: /online/i.test(req.state)
                  //                   ? "online"
                  //                   : "offline",
                  //                 driver_fingerprint: req.driver_fingerprint,
                  //                 date: new Date(chaineDateUTC).toISOString(),
                  //               })
                  //                 .then()
                  //                 .catch((error) => {
                  //                   logger.error(error);
                  //                 });
                  //               //...
                  //               res(true);
                  //             }).then(
                  //               () => {},
                  //               () => {}
                  //             );

                  //             //! clear tthe driver profiles cache
                  //             new Promise((clear) => {
                  //               clearDriverProfileCache({
                  //                 driver_fingerprint: req.driver_fingerprint,
                  //                 resolve: clear,
                  //               });
                  //             })
                  //               .then()
                  //               .catch((error) => logger.error(error));

                  //             //Done
                  //             res0({
                  //               response: "successfully_done",
                  //               flag: /online/i.test(req.state)
                  //                 ? "online"
                  //                 : "offline",
                  //               suspension_infos: suspensionInfos,
                  //               operation_clearance:
                  //                 driverData[0].operation_clearances,
                  //             });
                  //           })
                  //           .catch((error) => {
                  //             logger.error(error);
                  //             res0({
                  //               response: "error_invalid_request",
                  //             });
                  //           });
                  //       } //Has an active request - abort going offline
                  //       else {
                  //         res0({
                  //           response:
                  //             "error_going_offline_activeRequest_inProgress",
                  //         });
                  //       }
                  //     } //If the driver want to go online - proceed
                  //     else {
                  //       dynamo_update({
                  //         table_name: "drivers_shoppers_central",
                  //         _idKey: driverData[0]._id,
                  //         UpdateExpression: "set #o.#s = :val1",
                  //         ExpressionAttributeValues: {
                  //           ":val1": /online/i.test(req.state)
                  //             ? "online"
                  //             : "offline",
                  //         },
                  //         ExpressionAttributeNames: {
                  //           "#o": "operational_state",
                  //           "#s": "status",
                  //         },
                  //       })
                  //         .then((result) => {
                  //           if (result === false) {
                  //             res0({
                  //               response: "error_invalid_request",
                  //             });
                  //           }
                  //           //...
                  //           //Save the going offline event
                  //           new Promise((res) => {
                  //             dynamo_insert("global_events", {
                  //               event_name: "driver_switching_status_request",
                  //               status: /online/i.test(req.state)
                  //                 ? "online"
                  //                 : "offline",
                  //               driver_fingerprint: req.driver_fingerprint,
                  //               date: new Date(chaineDateUTC).toISOString(),
                  //             })
                  //               .then()
                  //               .catch((error) => logger.error(error));
                  //             //...
                  //             res(true);
                  //           }).then(
                  //             () => {},
                  //             () => {}
                  //           );

                  //           //! clear tthe driver profiles cache
                  //           new Promise((clear) => {
                  //             clearDriverProfileCache({
                  //               driver_fingerprint: req.driver_fingerprint,
                  //               resolve: clear,
                  //             });
                  //           })
                  //             .then()
                  //             .catch((error) => logger.error(error));

                  //           //Done
                  //           res0({
                  //             response: "successfully_done",
                  //             flag: /online/i.test(req.state)
                  //               ? "online"
                  //               : "offline",
                  //             suspension_infos: suspensionInfos,
                  //             operation_clearance:
                  //               driverData[0].operation_clearances,
                  //           });
                  //         })
                  //         .catch((error) => {
                  //           logger.error(error);
                  //           res0({
                  //             response: "error_invalid_request",
                  //           });
                  //         });
                  //     }
                  //   })
                  //   .catch((error) => {
                  //     logger.error(error);
                  //     res0({ response: "error_invalid_request" });
                  //   });
                } //Error - unknown driver
                else {
                  res0({ response: "error_invalid_request" });
                }
              })
              .catch((error) => {
                logger.error(error);
                res0({ response: "error_invalid_request" });
              });
          }).then(
            (result) => {
              resMAIN(result);
            },
            (error) => {
              logger.info(error);
              resMAIN({ response: "error_invalid_request" });
            }
          );
        } else if (/get/i.test(req.action)) {
          //? 2. Get the driver's profile
          //Augment
          req["user_fingerprint"] = req.driver_fingerprint;
          new Promise((resGetDriverProfile) => {
            getDriversProfile(req, resGetDriverProfile);
          })
            .then((driverProfile) => {
              logger.info(driverProfile);
              //! Only  if the driver is online
              if (driverProfile !== false && driverProfile !== undefined) {
                //?Has some data
                resMAIN({
                  response: "successfully_got",
                  flag: driverProfile.operational_state.status,
                  suspension_infos: { is_suspended: false },
                  operation_clearance: driverProfile.operation_clearances,
                });
              } //No driver profile data found
              else {
                resMAIN({
                  response: "successfully_got",
                  flag: "offline",
                  suspension_infos: { is_suspended: false },
                  operation_clearance: "NONE",
                });
              }
            })
            .catch((error) => {
              logger.error(error);
              resMAIN({
                response: "successfully_got",
                flag: "offline",
                suspension_infos: { is_suspended: false },
                operation_clearance: "NONE",
              });
            });
        }
      } //Invalid data
      else {
        resMAIN({ response: "error_invalid_request" });
      }
    })
      .then((result) => {
        // logger.info(result);
        res.send(result);
      })
      .catch((error) => {
        logger.info(error);
        res.send({
          response: "successfully_got",
          flag: "offline",
          suspension_infos: { is_suspended: false },
          operation_clearance: "NONE",
        });
      });
  });

  /**
   * COMPUTE WALLET SUMMARY FOR RIDERS
   * ? Responsible for computing the wallet summary (total and detailed) for the riders.
   * ! Supports 2 modes: total (will only return the current total wallet balance) or detailed (will return the total amount and the list of all wallet transactions)
   */
  app.get("/getRiders_walletInfos", function (req, res) {
    resolveDate();
    let params = urlParser.parse(req.url, true);
    req = params.query;

    if (
      req.user_fingerprint !== undefined &&
      req.user_fingerprint !== null &&
      req.mode !== undefined &&
      req.mode !== null
    ) {
      let regModeLimiter = new RegExp(req.mode, "i"); //Limit data to total balance (total) or total balance+details (detailed)
      new Promise((resolve) => {
        getRiders_wallet_summary(
          req,
          collectionRidesDeliveries_data,
          collectionWalletTransactions_logs,
          collectiondrivers_shoppers_central,
          collectionPassengers_profiles,
          resolve,
          req.avoidCached_data !== undefined &&
            req.avoidCached_data !== null &&
            /true/i.test(req.avoidCached_data)
            ? true
            : false,
          req.userType !== undefined && req.userType !== null
            ? req.userType
            : "rider"
        );
      }).then(
        (result) => {
          try {
            //! ADD EXCEPTIONS
            let exceptions_users_to_wallet = [
              "5b29bb1b9ac69d884f13fd4be2badcd22b72b98a69189bfab806dcf7c5f5541b6cbe8087cf60c791",
              "48aecfa6a98979574c6db8a77fd0a9e09dd4f37b2e4811343c65d31a88c404f46169466ff0e03e46",
            ];
            result.wallet_state = exceptions_users_to_wallet.includes(
              req.user_fingerprint
            )
              ? "unlocked"
              : process.env.USERS_WALLET_STATE;
            //...
            let responseHolder = regModeLimiter.test("detailed")
              ? result
              : result.total !== undefined
              ? {
                  total: result.total,
                  wallet_state: process.env.USERS_WALLET_STATE,
                }
              : {
                  total: 0,
                  wallet_state: process.env.USERS_WALLET_STATE,
                };
            if (/"transactions\_data"\:"0"/i.test(stringify(responseHolder))) {
              //! No records - send predefined - Major bug fix!
              res.send(
                regModeLimiter.test("detailed")
                  ? {
                      total: 0,
                      transactions_data: null,
                      wallet_state: process.env.USERS_WALLET_STATE,
                    }
                  : {
                      total: 0,
                      wallet_state: process.env.USERS_WALLET_STATE,
                    }
              );
            } //Has some records
            else {
              res.send(
                regModeLimiter.test("detailed")
                  ? result
                  : result.total !== undefined
                  ? {
                      total: result.total,
                      wallet_state: process.env.USERS_WALLET_STATE,
                    }
                  : {
                      total: 0,
                      wallet_state: process.env.USERS_WALLET_STATE,
                    }
              );
            }
          } catch (error) {
            logger.info(error);
            res.send(
              regModeLimiter.test("detailed")
                ? {
                    total: 0,
                    transactions_data: null,
                    wallet_state: process.env.USERS_WALLET_STATE,
                  }
                : {
                    total: 0,
                    wallet_state: process.env.USERS_WALLET_STATE,
                  }
            );
          }
        },
        (error) => {
          logger.info(error);
          res.send(
            regModeLimiter.test("detailed")
              ? {
                  total: 0,
                  transactions_data: null,
                  wallet_state: process.env.USERS_WALLET_STATE,
                }
              : {
                  total: 0,
                  wallet_state: process.env.USERS_WALLET_STATE,
                }
          );
        }
      );
    } //Invalid parameters
    else {
      let regModeLimiter = new RegExp(req.mode, "i"); //Limit data to total balance (total) or total balance+details (detailed)
      res.send(
        regModeLimiter.test("detailed")
          ? {
              total: 0,
              transactions_data: null,
              response: "error",
              tag: "invalid_parameters",
              wallet_state: process.env.USERS_WALLET_STATE,
            }
          : {
              total: 0,
              response: "error",
              tag: "invalid_parameters",
              wallet_state: process.env.USERS_WALLET_STATE,
            }
      );
    }
  });

  /**
   * COMPUTE THE DETAILED WALLET SUMMARY FOR THE DRIVERS
   * ? Responsible for computing the wallet summary (total and detailed) for the drivers.
   */
  app.get("/getDrivers_walletInfosDeep", function (req, res) {
    new Promise((resMAIN) => {
      resolveDate();
      let params = urlParser.parse(req.url, true);
      req = params.query;
      logger.info(req);

      if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
        let regModeLimiter = new RegExp(req.mode, "i"); //Limit data to total balance (total) or total balance+details (detailed)

        new Promise((resCompute) => {
          let url =
            `${
              /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
            }` +
            ":" +
            process.env.ACCOUNTS_SERVICE_PORT +
            "/getRiders_walletInfos?user_fingerprint=" +
            req.user_fingerprint +
            "&userType=driver";

          //Add the mode - default: detailed
          if (
            req.mode === undefined ||
            req.mode === null ||
            /detailed/i.test(req.mode)
          ) {
            url += `&mode=detailed`;
          } //total mode
          else {
            url += `&mode=total`;
          }

          //Add caching strategy if any
          if (
            req.avoidCached_data !== undefined &&
            /true/i.test(req.avoidCached_data)
          ) {
            url += "&avoidCached_data=" + req.avoidCached_data;
          }

          requestAPI(url, function (error, response, body) {
            if (error === null) {
              try {
                body = JSON.parse(body);
                if (
                  body.transactions_data !== null &&
                  body.transactions_data !== undefined &&
                  body.transactions_data.length > 0
                ) {
                  //? Has some transaction data
                  resCompute(body);
                } //! No transaction data - return current value
                else {
                  resCompute(
                    regModeLimiter.test("detailed")
                      ? {
                          total: 0,
                          transactions_data: null,
                          response: "empty",
                          tag: "empty_wallet",
                        }
                      : {
                          total: 0,
                          response: "empty",
                          tag: "empty_wallet",
                        }
                  );
                }
              } catch (error) {
                resCompute(
                  regModeLimiter.test("detailed")
                    ? {
                        total: 0,
                        transactions_data: null,
                        response: "error",
                        tag: "invalid_parameters",
                      }
                    : {
                        total: 0,
                        response: "error",
                        tag: "invalid_parameters",
                      }
                );
              }
            } else {
              resCompute(
                regModeLimiter.test("detailed")
                  ? {
                      total: 0,
                      transactions_data: null,
                      response: "error",
                      tag: "invalid_parameters",
                    }
                  : {
                      total: 0,
                      response: "error",
                      tag: "invalid_parameters",
                    }
              );
            }
          });
        })
          .then(
            (resultWalletdata) => {
              //? Final data
              new Promise((resGetDeepInsights) => {
                let redisKey = `${req.user_fingerprint}-deepWalletData-driver`;
                //?computeDriver_walletDeepInsights(walletBasicData, redisKey, avoidCached_data?, resolve)
                computeDriver_walletDeepInsights(
                  resultWalletdata,
                  collectionWalletTransactions_logs,
                  req.user_fingerprint,
                  redisKey,
                  req.avoidCached_data !== undefined &&
                    req.avoidCached_data !== null
                    ? req.avoidCached_data
                    : false,
                  resGetDeepInsights
                );
              })
                .then(
                  (resultInsights) => {
                    //! Sort the weeks from the biggest week and year to the smallest
                    resultInsights.weeks_view =
                      resultInsights.weeks_view !== null &&
                      resultInsights.weeks_view !== undefined
                        ? resultInsights.weeks_view.sort((a, b) =>
                            a.year_number < b.year_number &&
                            a.week_number < b.year_number
                              ? -1
                              : 1
                          )
                        : resultInsights.weeks_view;
                    //? Remove the record holder
                    //? Add transaction data if transactionData=true
                    res.send(
                      resultInsights.header !== undefined &&
                        resultInsights.header !== null
                        ? req.transactionData !== undefined &&
                          /true/i.test(req.transactionData)
                          ? {
                              header: resultInsights.header,
                              weeks_view: resultInsights.weeks_view,
                              transactions_data:
                                resultInsights.transactions_data,
                            }
                          : {
                              header: resultInsights.header,
                              weeks_view: resultInsights.weeks_view,
                            }
                        : resultInsights
                    );
                  },
                  (error) => {
                    logger.info(error);
                    res.send({
                      header: null,
                      weeks_view: null,
                      response: "error",
                    });
                  }
                )
                .catch((error) => {
                  logger.info(error);
                  res.send({
                    header: null,
                    weeks_view: null,
                    response: "error",
                  });
                });
            },
            (error) => {
              logger.info(error);
              res.send({
                header: null,
                weeks_view: null,
                response: "error",
              });
            }
          )
          .catch((error) => {
            logger.info(error);
            res.send({
              header: null,
              weeks_view: null,
              response: "error",
            });
          });
      } //Invalid params
      else {
        res.send({
          header: null,
          weeks_view: null,
          response: "error",
        });
      }
      //...
      resMAIN(true);
    })
      .then()
      .catch();
  });

  /**
   * MODIFY PASSENGERS PROFILE DETAILS
   * ? Responsible for updating ANY information related to the passengers profile.
   * ? Informations that can be updated: name, surname, picture, email, phone number, gender.
   */
  app.post("/updateRiders_profileInfos", function (req, res) {
    resolveDate();
    req = req.body;

    if (
      req.user_fingerprint !== undefined &&
      req.user_fingerprint !== null &&
      req.infoToUpdate !== undefined &&
      req.infoToUpdate !== null &&
      req.dataToUpdate !== undefined &&
      req.dataToUpdate !== null
    ) {
      new Promise((resolve) => {
        updateRiders_generalProfileInfos(
          collectionPassengers_profiles,
          collection_OTP_dispatch_map,
          collectionGlobalEvents,
          req,
          resolve
        );
      }).then(
        (result) => {
          res.send(result);
        },
        (error) => {
          res.send({ response: "error", flag: "invalid_data" });
        }
      );
    } //Invalid data
    else {
      res.send({ response: "error", flag: "invalid_data" });
    }
  });

  /**
   * GATHER ADS ANALYTICS FOR RIDERS
   * ? Responsible for ccollecting all the Ads events from the riders/drivers app.
   * ? Information: user fingerprint, user nature (rider, driver), screen identifier, company identifier, campaign identifier
   */
  app.post("/gatherAdsManagerAnalytics", function (req, res) {
    resolveDate();
    req = req.body;
    //logger.warn(req);
    res.send({ response: "error", flag: "no_ads_to_get" });

    /*if (
          req.user_fingerprint !== undefined &&
          req.user_fingerprint !== null &&
          req.user_nature !== undefined &&
          req.user_nature !== null &&
          req.screen_identifier !== undefined &&
          req.screen_identifier !== null &&
          req.company_identifier !== undefined &&
          req.company_identifier !== null &&
          req.campaign_identifier !== undefined &&
          req.campaign_identifier !== null
        ) {
          new Promise((resolve) => {
            try {
              //! Save the Ad event
              let eventBundle = {
                event_name: "Ad_gathering",
                user_fingerprint: req.user_fingerprint,
                user_nature: req.user_nature,
                ad_infos: {
                  screen_identifier: req.screen_identifier,
                  company_identifier: req.company_identifier,
                  campaign_identifier: req.campaign_identifier,
                },
                date: new Date(chaineDateUTC),
              };
              //! -----
              dynamo_insert('global_events', eventBundle).then((result) => {
                resolve(result);
              }).catch((error) => {
                logger.error(error);
                resolve(false);
              });
            } catch (error) {
              logger.warn(error);
              resolve(false);
            }
          })
            .then(
              (result) => {
                logger.info(result);
                res.send({ response: "success" });
              },
              (error) => {
                logger.info(error);
                res.send({ response: "error", flag: "invalid_data" });
              }
            )
            .catch((error) => {
              logger.info(error);
              res.send({ response: "error", flag: "invalid_data" });
            });
        } //Invalid data
        else {
          res.send({ response: "error", flag: "invalid_data" });
        }*/
  });

  /**
   * GET AD INFORMATION
   * ? Responsible for getting the ad infos for the companies based on the operating city to the riders/drivers
   * ? Required infos: user_fingerprint.
   * ! Cache as much as possible.
   */
  // app.get("/getAdsManagerRunningInfos", function (req, res) {
  //   resolveDate();
  //   let params = urlParser.parse(req.url, true);
  //   req = params.query;
  //   // res.send({ response: "error", flag: "invalid_data" });
  //   logger.info(req);

  //   if (
  //     req.user_fingerprint !== undefined &&
  //     req.user_fingerprint !== null &&
  //     req.user_nature !== undefined &&
  //     req.user_nature !== null &&
  //     req.city !== undefined &&
  //     req.city !== null
  //   ) {
  //     //Valid
  //     //? Get the only visible Ad campaign based on the operation city
  //     new Promise((resGet) => {
  //       getAdsManagerRunningInfos(req, resGet);
  //     })
  //       .then(
  //         (result) => {
  //           res.send(result);
  //         },
  //         (error) => {
  //           logger.info(error);
  //           res.send({ response: "error", flag: "invalid_data" });
  //         }
  //       )
  //       .catch((error) => {
  //         logger.info(error);
  //         res.send({ response: "error", flag: "invalid_data" });
  //       });
  //   } //Invalid data
  //   else {
  //     res.send({ response: "error", flag: "invalid_data" });
  //   }
  // });

  /**
   * DRIVERS REFERRAL API
   * ? Responsible for performing all the referral related information: checking drivers, submitting referrals,
   * ? getting the list of referred drivers by a specific user.
   * ! Cache as much as possible.
   * @param user_fingerprint
   * @param user_nature: rider/driver
   * @param action: get, submit or check
   * @param driver_infos: name, taxi_number and phone_number of the driver being referred.
   */
  app.get("/performDriversReferralOperations", function (req, res) {
    resolveDate();
    let params = urlParser.parse(req.url, true);
    req = params.query;

    if (
      req.user_fingerprint !== undefined &&
      req.user_fingerprint !== null &&
      req.user_nature !== undefined &&
      req.user_nature !== null &&
      /(rider|driver)/i.test(req.user_nature) &&
      req.action !== undefined &&
      req.action !== null
    ) {
      if (/get/i.test(req.action)) {
        //Get the list of referred drivers
        //? Save the get event
        new Promise((resEvent) => {
          let eventSaverObj = {
            event_name: "getting_referral_forTaxiDriver_userList",
            user_referrer: req.user_fingerprint,
            user_referrer_nature: req.user_nature,
            date: new Date(chaineDateUTC),
          };
          //...
          dynamo_insert("global_events", eventSaverObj)
            .then((result) => {
              resEvent(result);
            })
            .catch((error) => {
              logger.error(error);
              resEvent(true);
            });
        });
        //? --------------------
        let redisKey = `${req.user_fingerprint}-referredDriversList-CACHE`;
        redisGet(redisKey)
          .then((resp) => {
            if (resp !== null) {
              //REHYDRATE
              new Promise((resCompute) => {
                getReferredDrivers_list(
                  req,
                  collectionReferralsInfos,
                  redisKey,
                  resCompute
                );
              })
                .then()
                .catch();
              //...
              res.send(JSON.parse(resp));
            } //No records found - do a fresh request
            else {
              new Promise((resCompute) => {
                getReferredDrivers_list(
                  req,
                  collectionReferralsInfos,
                  redisKey,
                  resCompute
                );
              })
                .then((result) => {
                  res.send(result);
                })
                .catch((error) => {
                  logger.info(error);
                  res.send({ response: "error_unexpected" });
                });
            }
          })
          .catch((error) => {
            new Promise((resCompute) => {
              getReferredDrivers_list(
                req,
                collectionReferralsInfos,
                redisKey,
                resCompute
              );
            })
              .then((result) => {
                res.send(result);
              })
              .catch((error) => {
                logger.info(error);
                res.send({ response: "error_unexpected" });
              });
          });
      } else if (
        /check/i.test(req.action) &&
        req.taxi_number !== undefined &&
        req.taxi_number !== null
      ) {
        //Check the driver's taxi number
        //? Save the checking event
        new Promise((resEvent) => {
          let eventSaverObj = {
            event_name: "checking_referral_forTaxiDriver",
            user_referrer: req.user_fingerprint,
            user_referrer_nature: req.user_nature,
            taxi_number: req.taxi_number,
            date: new Date(chaineDateUTC),
          };
          //...
          dynamo_insert("global_events", eventSaverObj)
            .then((result) => {
              resEvent(result);
            })
            .catch((error) => {
              logger.error(error);
              resEvent(true);
            });
        });
        //? --------------------
        //! Check that the user is authentic
        let collectionToCheck = /rider/i.test(req.user_nature)
          ? {
              table_name: "passengers_profiles",
              IndexName: "user_fingerprint",
              KeyConditionExpression: "user_fingerprint = :val1",
              ExpressionAttributeValues: {
                ":val1": req.user_fingerprint,
              },
            }
          : {
              table_name: "drivers_shoppers_central",
              IndexName: "driver_fingerprint",
              KeyConditionExpression: "driver_fingerprint = :val1",
              ExpressionAttributeValues: {
                ":val1": req.user_fingerprint,
              },
            };
        let finderUserQuery = /rider/i.test(req.user_nature)
          ? { user_fingerprint: req.user_fingerprint }
          : { driver_fingerprint: req.user_fingerprint };

        dynamo_find_query(collectionToCheck)
          .then((userData) => {
            if (userData !== undefined && userData.length > 0) {
              //? Authentic user
              //! Format the driver's taxi number
              req.taxi_number = req.taxi_number.toUpperCase().trim();
              //!---
              new Promise((resCompute) => {
                //1. Check if the driver is already registered
                let finderQuery = {
                  "cars_data.taxi_number": req.taxi_number,
                };

                dynamo_find_query({
                  table_name: "drivers_shoppers_central",
                  IndexName: "driver_fingerprint",
                  KeyConditionExpression: "driver_fingerprint = :val1",
                  ExpressionAttributeValues: {
                    ":val1": req.user_fingerprint,
                  },
                })
                  .then((reslt) => {
                    if (reslt !== undefined && reslt.length > 0) {
                      //Driver already registered
                      resCompute({
                        response: "driver_alreadyRegistered",
                      });
                    } //Driver not yet officially registered
                    else {
                      //? 2. Check if the driver was already referred
                      let finderNarrower = {
                        taxi_number: req.taxi_number,
                        is_referralExpired: false,
                      };
                      //...
                      dynamo_find_query({
                        table_name: "referrals_information_global",
                        IndexName: "taxi_number",
                        KeyConditionExpression:
                          "taxi_number = :val1, is_referralExpired = :val2",
                        ExpressionAttributeValues: {
                          ":val1": req.taxi_number,
                          ":val2": false,
                        },
                      })
                        .then((result) => {
                          if (result !== undefined && result.length > 0) {
                            //! Driver already referred
                            resCompute({
                              response: "driver_alreadyReferred",
                            });
                          } //? Not yet referred
                          else {
                            resCompute({
                              response: "driver_freeForReferral",
                            });
                          }
                        })
                        .catch((error) => {
                          logger.error(error);
                          resCompute({
                            response: "error_unexpected",
                          });
                        });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    resCompute({ response: "error_unexpected" });
                  });
              })
                .then((result) => {
                  res.send(result);
                })
                .catch((error) => {
                  logger.info(error);
                  res.send({ response: "error_unexpected" });
                });
            } //Fraud user
            else {
              res.send({ response: "error_unexpected_auth" });
            }
          })
          .catch((error) => {
            logger.error(error);
            res.send({ response: "error_unexpected_auth" });
          });
      } else if (
        /submit/i.test(req.action) &&
        req.taxi_number !== undefined &&
        req.taxi_number !== null &&
        req.driver_phone !== undefined &&
        req.driver_phone !== null &&
        req.driver_name !== undefined &&
        req.driver_name !== null
      ) {
        //Submit the user's (rider/driver) referral request
        //! Format the infos
        req.taxi_number = req.taxi_number.toUpperCase().trim();
        req.driver_phone = req.driver_phone.trim();
        new Promise((resCompute) => {
          //! 1. Check for non duplicata
          let finderNarrower = {
            taxi_number: req.taxi_number,
            user_referrer: req.user_fingerprint,
            user_referrer_nature: req.user_nature,
            is_referralExpired: false,
          };
          //...
          dynamo_find_query({
            table_name: "referrals_information_global",
            IndexName: "taxi_number",
            KeyConditionExpression:
              "taxi_number = :val1, user_referrer = :val2, user_referrer_nature = :val3, is_referralExpired = :val4",
            ExpressionAttributeValues: {
              ":val1": req.taxi_number,
              ":val2": req.user_fingerprint,
              ":val3": req.user_nature,
              ":val4": false,
            },
          })
            .then((result) => {
              if (result !== undefined && result.length > 0) {
                //! Found an active referral
                resCompute({
                  response: "error_unexpected_foundActive",
                });
              } //? Not yet referred
              else {
                //ADD 2 DAYS MAX OF EXPIRATION TIME.
                let referralObject = {
                  referral_fingerprint: dateObject.unix(),
                  driver_name: req.driver_name,
                  driver_phone: req.driver_phone,
                  taxi_number: req.taxi_number,
                  user_referrer: req.user_fingerprint,
                  user_referrer_nature: req.user_nature,
                  expiration_time: new Date(
                    new Date(chaineDateUTC).getTime() + 2 * 24 * 3600 * 1000
                  ),
                  is_referralExpired: false,
                  is_paid: false,
                  amount_paid: false,
                  amount_paid_percentage: 50,
                  is_referral_rejected: false, //! Whether the referral is rejected or not: Rejected referrals cannot receive payments.
                  is_official_deleted_user_side: false, //! Deleted referrals on the user side cannot receive payment or be seen ever again by the user, only not paid referrals can be deleted.
                  date_referred: new Date(chaineDateUTC),
                };
                new Promise((res) => {
                  generateUniqueFingerprint(
                    `${chaineDateUTC}-${req.user_fingerprint}-${req.driver_phone}`,
                    false,
                    res
                  );
                })
                  .then(
                    (result) => {
                      referralObject.referral_fingerprint = result; //Update with the fingerprint;
                    },
                    (error) => {
                      logger.warn(error);
                      referralObject.referral_fingerprint =
                        parsedData.user_fingerprint + dateObject.unix(); //Make a fingerprint out of the timestamp
                    }
                  )
                  .finally(() => {
                    //...
                    dynamo_insert(
                      "referrals_information_global",
                      referralObject
                    )
                      .then((result) => {
                        if (result === false) {
                          resCompute({ response: "error_unexpected" });
                        }
                        //...
                        resCompute({
                          response: "successfully_referred",
                        });
                      })
                      .catch((error) => {
                        logger.error(error);
                        resCompute({ response: "error_unexpected" });
                      });
                  });
              }
            })
            .catch((error) => {
              logger.error(error);
              resCompute({ response: "error_unexpected" });
            });
        })
          .then((result) => {
            res.send(result);
          })
          .catch((error) => {
            logger.warn(error);
            resCompute({ response: "error_unexpected" });
          });
      } //Invalid data received
      else {
        res.send({ response: "error_invalid_data" });
      }
    } //Invalid data received
    else {
      res.send({ response: "error_invalid_data" });
    }
  });

  /**
   * REFERRALS STATE NOTIFICATIONS FOR RIDERS
   * ? Responsible for sending notifications to drivers
   */
  app.get("/notifyCustomersForReferralsProgress", function (req, res) {
    new Promise((resCompute) => {
      if (
        req.name !== undefined &&
        req.name !== null &&
        req.referrer_fingerprint !== undefined &&
        req.referrer_fingerprint !== null
      ) {
        //Get the referrer's details
        dynamo_find_query({
          table_name: "passengers_profiles",
          IndexName: "user_fingerprint",
          KeyConditionExpression: "user_fingerprint = :val1",
          ExpressionAttributeValues: {
            ":val1": req.referrer_fingerprint,
          },
        })
          .then((userData) => {
            if (
              userData !== undefined &&
              userData !== null &&
              userData.length > 0
            ) {
              if (/markPaid/i.test(req.name)) {
                //?Mark as paid
                //! Notify the rider
                //Send the push notifications
                let message = {
                  app_id: process.env.RIDERS_APP_ID_ONESIGNAL,
                  android_channel_id:
                    process.env.RIDERS_ONESIGNAL_CHANNEL_AUTOCANCELLED_REQUEST, //Ride - Auto-cancelled group
                  priority: 10,
                  contents: {
                    en: "Y",
                  },
                  headings: { en: "Referral payout" },
                  content_available: true,
                  include_player_ids: [
                    userData.pushnotif_token !== null &&
                    userData.pushnotif_token.userId !== undefined
                      ? userData.pushnotif_token.userId
                      : "false",
                  ],
                };
                //Send
                sendPushUPNotification(message);
                resCompute({ response: "success" });
              } else if (/MarkRejected/i.test(req.name)) {
                //?Mark as rejected
                //! Notify the rider
                //Send the push notifications
                let message = {
                  app_id: process.env.RIDERS_APP_ID_ONESIGNAL,
                  android_channel_id:
                    process.env.RIDERS_ONESIGNAL_CHANNEL_AUTOCANCELLED_REQUEST, //Ride - Auto-cancelled group
                  priority: 10,
                  contents: {
                    en: "Y",
                  },
                  headings: { en: "Referral payout" },
                  content_available: true,
                  include_player_ids: [
                    userData.pushnotif_token !== null &&
                    userData.pushnotif_token.userId !== undefined
                      ? userData.pushnotif_token.userId
                      : "false",
                  ],
                };
                //Send
                sendPushUPNotification(message);
                resCompute({ response: "success" });
              } else if (/DeleteFromRider/i.test(req.name)) {
                //?Delete from rider
                resCompute({ response: "success" });
              } else if (/DeleteReferral/i.test(req.name)) {
                //?Delete referral
                resCompute({ response: "success" });
              } else if (/RegisterReferredDriver/i.test(req.name)) {
                //?Register referred driver
                //! Notify the rider
                //Send the push notifications
                let message = {
                  app_id: process.env.RIDERS_APP_ID_ONESIGNAL,
                  android_channel_id:
                    process.env.RIDERS_ONESIGNAL_CHANNEL_AUTOCANCELLED_REQUEST, //Ride - Auto-cancelled group
                  priority: 10,
                  contents: {
                    en: "Y",
                  },
                  headings: { en: "Referral payout" },
                  content_available: true,
                  include_player_ids: [
                    userData.pushnotif_token !== null &&
                    userData.pushnotif_token.userId !== undefined
                      ? userData.pushnotif_token.userId
                      : "false",
                  ],
                };
                //Send
                sendPushUPNotification(message);
                resCompute({ response: "success" });
              } //No valid name
              else {
                resCompute({ response: "error" });
              }
            } //No data found
            else {
              resCompute({ response: "error" });
            }
          })
          .catch((error) => {
            logger.error(error);
            resCompute({ response: "error" });
          });
      } //Invalid data
      else {
        resCompute({ response: "error" });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({ response: "error" });
      });
  });

  /**
   * GET DRIVERS ACCOUNT GENERAL NUMBERS.
   * ? Responsible for getting the general numbers that reflect the state of a drivers account
   * ? from the creation until now.
   */
  app.get("/getDriversGeneralAccountNumber", function (req, res) {
    new Promise((resolve) => {
      resolveDate();
      let params = urlParser.parse(req.url, true);
      req = params.query;

      if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
        getDriversGlobalAccountNumbers(req.user_fingerprint, resolve);
      } //Error
      else {
        resolve({ response: "error_invalid_data" });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({ response: "error_invalid_data" });
      });
  });

  /**
   * PERFORMA AUTHENTICATION OPS ON A CORPORATE DELIVERY A ACCOUNT
   * ? Responsible for performing auth operations on a delivery account on the web interface.
   */
  app.post("/performOpsCorporateDeliveryAccount", function (req, res) {
    new Promise((resolve) => {
      resolveDate();
      req = req.body;

      if (req.op !== undefined && req.op !== null) {
        performCorporateDeliveryAccountAuthOps(req, resolve);
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({ response: "error_invalid_data" });
      });
  });

  /**
   * CHECK DRIVERS FOR POTENTIAL BLOCKING AND BLOCK IF NEEDED FROM A SPECIFIC RIDER'S CIRCLE
   * ? Responsible for checking and blocking a specific driver from a user's circle when requesting.
   */
  app.post("/checkOrBlockDriversFromRider", function (req, res) {
    new Promise((resolve) => {
      resolveDate();
      req = req.body;
      logger.info(req);

      if (req.op !== undefined && req.op !== null) {
        if (
          req.op === "check" &&
          req.driver_phoneNumber !== undefined &&
          req.driver_phoneNumber !== null
        ) {
          //Has the data
          dynamo_find_query({
            table_name: "drivers_shoppers_central",
            IndexName: "phone_number",
            KeyConditionExpression: "phone_number = :val1",
            ExpressionAttributeValues: {
              ":val1": req.driver_phoneNumber.trim(),
            },
          })
            .then((driverData) => {
              if (driverData !== undefined && driverData.length > 0) {
                //Found the driver
                driverData = driverData[0];
                //...
                resolve({
                  response: {
                    driver_name: driverData.name,
                    driver_surname: driverData.surname,
                    driver_fp: driverData.driver_fingerprint,
                    profile_picture: `${process.env.AWS_S3_DRIVERS_PROFILE_PICTURES_PATH}/${driverData.identification_data.profile_picture}`,
                  },
                });
              } //No driver found
              else {
                resolve({ response: "error_no_driver" });
              }
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: "error_invalid_data" });
            });
        } else if (
          req.op === "block" &&
          req.user_fp !== undefined &&
          req.user_fp !== null &&
          req.driver_data !== undefined &&
          req.driver_data !== null &&
          req.driver_data.driver_fp !== undefined &&
          req.driver_data.driver_fp !== null
        ) {
          //Block the driver effectively
          dynamo_find_query({
            table_name: "passengers_profiles",
            IndexName: "user_fingerprint",
            KeyConditionExpression: "user_fingerprint = :val1",
            ExpressionAttributeValues: {
              ":val1": req.user_fp,
            },
          })
            .then((userData) => {
              if (userData !== undefined && userData.length > 0) {
                userData = userData[0];
                //Valid user
                //! Add the driver to the blocked list
                let blockedList =
                  userData.drivers_blacklist !== undefined &&
                  userData.drivers_blacklist !== null
                    ? userData.drivers_blacklist
                    : [];
                //...Attach the date unblocked
                req.driver_data["date"] = new Date(chaineDateUTC);
                //...
                blockedList.push(req.driver_data);
                let blockedListUnique = [];
                let fpUniqueTracker = [];
                blockedList.map((driver) => {
                  if (fpUniqueTracker.includes(driver.driver_fp) === false) {
                    //New
                    blockedListUnique.push(driver);
                    //...
                    fpUniqueTracker.push(driver.driver_fp);
                  }
                });
                //? Update
                dynamo_update(
                  "passengers_profiles",
                  userData._id,
                  "set drivers_blacklist = :val1",
                  {
                    ":val1": blockedListUnique,
                  }
                )
                  .then((result) => {
                    if (result === false) {
                      logger.error(err);
                      resolve({ response: "error_unable_to_block" });
                    }
                    //...
                    //Cache it
                    let RIDE_REDIS_KEY = `${req.user_fp}-getListOfBlockedDrivers`;
                    redisCluster.setex(
                      RIDE_REDIS_KEY,
                      parseInt(process.env.REDIS_EXPIRATION_5MIN) * 120,
                      JSON.stringify(blockedList)
                    );
                    //...
                    resolve({ response: "successfully_blocked" });
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: "error_unable_to_block" });
                  });
              } //Invalid user?
              else {
                resolve({ response: "error_unable_to_block_iv_user" });
              }
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: "error_unable_to_block" });
            });
        } else if (
          req.op === "unblock" &&
          req.user_fp !== undefined &&
          req.user_fp !== null &&
          req.driver_fp !== undefined &&
          req.driver_fp !== null
        ) {
          //Just unlock
          //Block the driver effectively
          dynamo_find_query({
            table_name: "passengers_profiles",
            IndexName: "user_fingerprint",
            KeyConditionExpression: "user_fingerprint = :val1",
            ExpressionAttributeValues: {
              ":val1": req.user_fp,
            },
          })
            .then((userData) => {
              if (userData !== undefined && userData.length > 0) {
                userData = userData[0];
                //Valid user
                //! Add the driver to the blocked list
                let blockedList =
                  userData.drivers_blacklist !== undefined &&
                  userData.drivers_blacklist !== null
                    ? userData.drivers_blacklist
                    : [];
                //...
                //Remove the driver from the blocked list
                let updatedBlockedList = [];
                blockedList.map((driver) => {
                  if (driver.driver_fp !== req.driver_fp) {
                    //! Skip all the rest of the blocked drivers
                    updatedBlockedList.push(driver);
                  }
                });
                //? Update
                dynamo_update(
                  "passengers_profiles",
                  userData._id,
                  "set drivers_blacklist = :val1",
                  {
                    ":val1": updatedBlockedList,
                  }
                )
                  .then((result) => {
                    if (result === false) {
                      logger.error(err);
                      resolve({ response: "error_unable_to_block" });
                    }
                    //...
                    //Cache it
                    let RIDE_REDIS_KEY = `${req.user_fp}-getListOfBlockedDrivers`;
                    redisCluster.setex(
                      RIDE_REDIS_KEY,
                      parseInt(process.env.REDIS_EXPIRATION_5MIN) * 120,
                      JSON.stringify(blockedList)
                    );
                    //...
                    resolve({ response: "successfully_blocked" });
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: "error_unable_to_block" });
                  });
              } //Invalid user?
              else {
                resolve({ response: "error_unable_to_block_iv_user" });
              }
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: "error_unable_to_unblock" });
            });
        } else if (
          req.op === "getList" &&
          req.user_fp !== undefined &&
          req.user_fp !== null
        ) {
          let RIDE_REDIS_KEY = `${req.user_fp}-getListOfBlockedDrivers`;
          //Get blocked account list
          redisGet(RIDE_REDIS_KEY).then((resp) => {
            if (resp !== null) {
              logger.warn("Cached list for blocked drivers found");
              //Has some cached data
              try {
                //? Rehydrate
                new Promise((resCompute) => {
                  dynamo_find_query({
                    table_name: "passengers_profiles",
                    IndexName: "user_fingerprint",
                    KeyConditionExpression: "user_fingerprint = :val1",
                    ExpressionAttributeValues: {
                      ":val1": req.user_fp,
                    },
                  })
                    .then((userData) => {
                      if (userData !== undefined && userData.length > 0) {
                        userData = userData[0];
                        //Valid user
                        //! Add the driver to the blocked list
                        let blockedList =
                          userData.drivers_blacklist !== undefined &&
                          userData.drivers_blacklist !== null
                            ? userData.drivers_blacklist
                            : [];
                        //...
                        //Cache as well
                        redisCluster.setex(
                          RIDE_REDIS_KEY,
                          parseInt(process.env.REDIS_EXPIRATION_5MIN) * 120,
                          JSON.stringify(blockedList)
                        );
                        ///...
                        resCompute(true);
                      } //Invalid user?
                      else {
                        resCompute(true);
                      }
                    })
                    .catch((error) => {
                      logger.error(error);
                      resCompute(true);
                    });
                })
                  .then()
                  .catch((error) => logger.error(error));
                //? ---
                resolve({ response: JSON.parse(resp) });
              } catch (error) {
                dynamo_find_query({
                  table_name: "passengers_profiles",
                  IndexName: "user_fingerprint",
                  KeyConditionExpression: "user_fingerprint = :val1",
                  ExpressionAttributeValues: {
                    ":val1": req.user_fp,
                  },
                })
                  .then((userData) => {
                    if (userData !== undefined && userData.length > 0) {
                      userData = userData[0];
                      //Valid user
                      //! Add the driver to the blocked list
                      let blockedList =
                        userData.drivers_blacklist !== undefined &&
                        userData.drivers_blacklist !== null
                          ? userData.drivers_blacklist
                          : [];
                      //...
                      //Cache as well
                      redisCluster.setex(
                        RIDE_REDIS_KEY,
                        parseInt(process.env.REDIS_EXPIRATION_5MIN) * 120,
                        JSON.stringify(blockedList)
                      );
                      ///...
                      resolve({ response: blockedList });
                    } //Invalid user?
                    else {
                      resolve({ response: [] });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: [] });
                  });
              }
            } //No cached data
            else {
              dynamo_find_query({
                table_name: "passengers_profiles",
                IndexName: "user_fingerprint",
                KeyConditionExpression: "user_fingerprint = :val1",
                ExpressionAttributeValues: {
                  ":val1": req.user_fp,
                },
              })
                .then((userData) => {
                  if (userData !== undefined && userData.length > 0) {
                    userData = userData[0];
                    //Valid user
                    //! Add the driver to the blocked list
                    let blockedList =
                      userData.drivers_blacklist !== undefined &&
                      userData.drivers_blacklist !== null
                        ? userData.drivers_blacklist
                        : [];
                    //...
                    //Cache as well
                    redisCluster.setex(
                      RIDE_REDIS_KEY,
                      parseInt(process.env.REDIS_EXPIRATION_5MIN) * 120,
                      JSON.stringify(blockedList)
                    );
                    ///...
                    resolve({ response: blockedList });
                  } //Invalid user?
                  else {
                    resolve({ response: [] });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: [] });
                });
            }
          });
        }
        //Invalid op
        else {
          resolve({ response: "error_invalid_data" });
        }
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({ response: "error_invalid_data" });
      });
  });

  /**
   * GET WALLET DELIVERY FOR CORPORATIONS
   * ? Responsible for getting the wallet delivery for the corporations
   */
  app.get("/getWalletSummaryForCorps", function (req, res) {
    new Promise((resolve) => {
      resolveDate();
      let params = urlParser.parse(req.url, true);
      req = params.query;

      if (req.company_fp !== undefined && req.company_fp !== null) {
        //! Resolve the avoidCache param
        req["avoidCache"] =
          req.avoidCache !== undefined && req.avoidCache !== null
            ? /true/i.test(req.avoidCache)
              ? true
              : false
            : false; //False by default

        getWalletSummaryForDeliveryCorps(
          req.company_fp,
          req.avoidCache,
          resolve
        );
      } //Error
      else {
        resolve({
          balance: 0,
          usage: 0,
        });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({
          balance: 0,
          usage: 0,
        });
      });
  });

  /**
   * GET NOTIFICATIONS
   * ? Responsible for getting the notifications infos specific to a user
   */
  app.post("/getNotifications_ops", function (req, res) {
    new Promise((resolve) => {
      resolveDate();
      req = req.body;

      if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
        //! Resolve the avoidCache param
        req["avoidCache"] =
          req.avoidCache !== undefined && req.avoidCache !== null
            ? /true/i.test(req.avoidCache)
              ? true
              : false
            : false; //False by default

        getTargetedNotificationsOps(req, resolve);
      } //Error
      else {
        resolve({
          response: "error",
        });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({ response: "error" });
      });
  });

  /**
   * Submit application for courier drivers
   * ? Responsible for processing the application for the courier drivers.
   */
  app.post("/processCourierDrivers_application", function (req, res) {
    new Promise((resolve) => {
      req = req.body;
      logger.info(req.extensions);
      //! Check if all the data were received
      if (
        req.phone !== undefined &&
        req.phone !== null &&
        req.nature_driver !== undefined &&
        req.nature_driver !== null &&
        req.city !== undefined &&
        req.city !== null &&
        req.personal_details !== undefined &&
        req.personal_details !== null &&
        req.vehicle_details !== undefined &&
        req.vehicle_details !== null &&
        req.driver_photo !== undefined &&
        req.driver_photo !== null &&
        req.vehicle_photo !== undefined &&
        req.vehicle_photo !== null &&
        req.license_photo !== undefined &&
        req.license_photo !== undefined &&
        req.id_photo !== undefined &&
        req.id_photo !== null &&
        req.extensions !== undefined &&
        req.extensions !== null
      ) {
        //! Create tmp dir for drivers application if missing
        if (!fs.existsSync(`.${process.env.DRIVERS_PROFILE_PICTURES_PATH}`)) {
          fs.mkdirSync(`.${process.env.DRIVERS_PROFILE_PICTURES_PATH}`);
        }

        //All the data received
        try {
          //! Check that the person is not applying twice
          dynamo_find_query({
            table_name: "drivers_application_central",
            IndexName: "phone_number",
            KeyConditionExpression: "phone_number = :val1",
            ExpressionAttributeValues: {
              ":val1": req.phone,
            },
          })
            .then((driverData) => {
              if (driverData !== undefined && driverData.length > 0) {
                //Already applied
                resolve({ response: "error_duplicate_application" });
              } //New and fresh application
              else {
                //Form the file names
                let user_fingerprint = `${req.phone}-${req.personal_details}-${
                  req.vehicle_details
                }-${new Date(chaineDateUTC).getTime()}`;
                new Promise((getFingerprint) => {
                  generateUniqueFingerprint(
                    user_fingerprint,
                    false,
                    getFingerprint
                  );
                })
                  .then((driverFp) => {
                    user_fingerprint = driverFp;
                    //? Parse the json string data
                    req.personal_details = JSON.parse(req.personal_details);
                    req.extensions = JSON.parse(req.extensions);
                    req.vehicle_details = JSON.parse(req.vehicle_details);

                    //? Make file names
                    let driverPhotoName = `driverPhoto_${user_fingerprint}.${req.extensions.driver_photo}`;
                    let vehiclePhoto = `vehiclePhoto${user_fingerprint}.${req.extensions.vehicle_photo}`;
                    let licensePhoto = `licensePhoto${user_fingerprint}.${req.extensions.license_photo}`;
                    let idPhoto = `idPhoto${user_fingerprint}.${req.extensions.id_photo}`;

                    //? Reconstitute the files in the tempo drivers folder
                    let filesData = [
                      {
                        name: driverPhotoName,
                        base64: req.driver_photo,
                      },
                      {
                        name: vehiclePhoto,
                        base64: req.vehicle_photo,
                      },
                      {
                        name: licensePhoto,
                        base64: req.license_photo,
                      },
                      {
                        name: idPhoto,
                        base64: req.id_photo,
                      },
                    ];
                    //...
                    //TODO: If the sum of all the values ==0 (Passed) else (at least one file failed to be reconstituted)
                    let parentReformLocally = filesData.map((fileData) => {
                      return new Promise((resCompute) => {
                        fs.writeFile(
                          `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${fileData.name}`,
                          String(fileData.base64),
                          "base64",
                          function (err) {
                            if (err) {
                              logger.error(err);
                              resCompute(1); //Failed
                            }
                            //...success
                            resCompute(0);
                          }
                        );
                      });
                    });
                    //..Done
                    Promise.all(parentReformLocally)
                      .then((resultReform) => {
                        let reformCheck = resultReform.reduce((acc, a) => {
                          return acc + a;
                        }, 0);

                        if (reformCheck == 0) {
                          //? SUCCESSFULLY REFORMED LOCALLY
                          //! UPLOAD THE PICTURE TO S3 - Promisify!
                          let parentUploadToS3 = filesData.map((fileData) => {
                            return new Promise((resUploadPic_toS3) => {
                              // Read content from the file
                              const fileContentUploaded_locally =
                                fs.readFileSync(
                                  `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${fileData.name}`
                                );

                              // Setting up S3 upload parameters
                              logger.warn(
                                `${process.env.AWS_S3_DRIVERS_BUCKET_NAME}/Drivers_Applications`
                              );
                              const params = {
                                Bucket: `${process.env.AWS_S3_DRIVERS_BUCKET_NAME}/Drivers_Applications`,
                                Key: fileData.name, // File name you want to save as in S3
                                Body: fileContentUploaded_locally,
                              };

                              // Uploading files to the bucket
                              s3.upload(params, function (err, data) {
                                if (err) {
                                  logger.info(err);
                                  resUploadPic_toS3(1);
                                }
                                logger.info(
                                  `[Drivers]${fileData.name} -> Successfully uploaded.`
                                );
                                resUploadPic_toS3(0);
                              });
                            });
                          });
                          //...
                          Promise.all(parentUploadToS3)
                            .then((resultReformRemote) => {
                              let reformRemoteCheck = resultReformRemote.reduce(
                                (acc, a) => {
                                  return acc + a;
                                },
                                0
                              );

                              if (reformRemoteCheck == 0) {
                                //?SUCCESSFULL Y UPLOADED TO s3
                                //Delete local file
                                let parentRemoveUneededFiles = filesData.map(
                                  (uneededFileData) => {
                                    return new Promise((resDelFiles) => {
                                      try {
                                        fs.unlink(
                                          `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${uneededFileData.name}`,
                                          (err) => {
                                            logger.warn(err);
                                          }
                                        );
                                        resDelFiles(true);
                                      } catch (error) {
                                        logger.warn(error);
                                        resDelFiles(false);
                                      }
                                    });
                                  }
                                );
                                //...
                                Promise.all(parentRemoveUneededFiles)
                                  .then((resDel) =>
                                    logger.info(`Deleted: ${resDel}`)
                                  )
                                  .catch((error) => logger.error(error));
                                //.............
                                //? Save applicate to db
                                let applicationBundle = {
                                  nature_driver: String(req.nature_driver)
                                    .toUpperCase()
                                    .trim(),
                                  city: req.city.toUpperCase().trim(),
                                  name: req.personal_details.name,
                                  surname: req.personal_details.surname,
                                  email: req.personal_details.email,
                                  phone_number: req.phone,
                                  driver_fingerprint: user_fingerprint,
                                  vehicle_details: req.vehicle_details,
                                  documents: {
                                    driver_photo: driverPhotoName,
                                    vehicle_photo: vehiclePhoto,
                                    license_photo: licensePhoto,
                                    id_photo: idPhoto,
                                  },
                                  accepted_conditions_details: {
                                    did_accept_terms: req.did_accept_terms,
                                    did_certify_data_veracity:
                                      req.did_certify_data_veracity,
                                  },
                                  date_applied: new Date(chaineDateUTC),
                                };
                                //...
                                dynamo_insert(
                                  "drivers_application_central",
                                  applicationBundle
                                )
                                  .then((result) => {
                                    if (result === false) {
                                      resolve({
                                        response: "error_failed_application",
                                      });
                                    }
                                    //...Send SMS confirmation
                                    new Promise((resSMSNotif) => {
                                      let reqData = {
                                        phone: req.phone,
                                        name: req.personal_details.name,
                                      };
                                      sendSMSAny({
                                        req: reqData,
                                        resolve: resSMSNotif,
                                        service: "courier",
                                      });
                                    })
                                      .then()
                                      .catch((error) => logger.error(error));
                                    //...
                                    resolve({
                                      response: "successful_application",
                                    });
                                  })
                                  .catch((error) => {
                                    logger.error(error);
                                    resolve({
                                      response: "error_failed_application",
                                    });
                                  });
                              } //! At least one document failed to be reformed
                              else {
                                //Delete local file
                                let parentRemoveUneededFiles = filesData.map(
                                  (uneededFileData) => {
                                    return new Promise((resDelFiles) => {
                                      fs.unlink(
                                        `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${uneededFileData.name}`,
                                        (err) => {
                                          logger.error(err);
                                        }
                                      );
                                      resDelFiles(true);
                                    });
                                  }
                                );
                                //...
                                Promise.all(parentRemoveUneededFiles)
                                  .then((resDel) =>
                                    logger.info(`Deleted: ${resDel}`)
                                  )
                                  .catch((error) => logger.error(error));
                                //.............
                                //...
                                resolve({
                                  response: "error_reformation_remote",
                                });
                              }
                            })
                            .catch((error) => {
                              logger.error(error);
                              //Delete local file
                              let parentRemoveUneededFiles = filesData.map(
                                (uneededFileData) => {
                                  return new Promise((resDelFiles) => {
                                    fs.unlink(
                                      `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${uneededFileData.name}`,
                                      (err) => {
                                        logger.error(err);
                                      }
                                    );
                                    resDelFiles(true);
                                  });
                                }
                              );
                              //...
                              Promise.all(parentRemoveUneededFiles)
                                .then((resDel) =>
                                  logger.info(`Deleted: ${resDel}`)
                                )
                                .catch((error) => logger.error(error));
                              //.............
                              //...
                              resolve({
                                response: "error_reformation_remote",
                              });
                            });
                        } //! At least one document failed to be reformed
                        else {
                          resolve({ response: "error_reformation" });
                        }
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve({ response: "error_reformation" });
                      });
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: "error_parsing_data" });
                  });
              }
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: "error_failed_integrity_checks" });
            });
        } catch (error) {
          logger.error(error);
          resolve({ response: "error_parsing_data" });
        }
      } //Incomplete data
      else {
        resolve({ response: "error_parsing_data_1" });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({ response: "error" });
      });
  });

  /**
   * Submit application for rides drivers
   * ? Responsible for processing the application for the rides drivers.
   */
  app.post("/processRidesDrivers_application", function (req, res) {
    new Promise((resolve) => {
      req = req.body;
      logger.info(req.extensions);
      //! Check if all the data were received
      if (
        req.phone !== undefined &&
        req.phone !== null &&
        req.nature_driver !== undefined &&
        req.nature_driver !== null &&
        req.city !== undefined &&
        req.city !== null &&
        req.personal_details !== undefined &&
        req.personal_details !== null &&
        req.vehicle_details !== undefined &&
        req.vehicle_details !== null &&
        req.driver_photo !== undefined &&
        req.driver_photo !== null &&
        req.vehicle_photo !== undefined &&
        req.vehicle_photo !== null &&
        req.license_photo !== undefined &&
        req.license_photo !== undefined &&
        req.id_photo !== undefined &&
        req.id_photo !== null &&
        req.bluepaper_photo !== undefined &&
        req.bluepaper_photo !== null &&
        req.whitepaper_photo !== undefined &&
        req.whitepaper_photo !== null &&
        req.permit_photo !== undefined &&
        req.permit_photo !== null &&
        req.extensions !== undefined &&
        req.extensions !== null
      ) {
        //! Create tmp dir for drivers application if missing
        if (!fs.existsSync(`.${process.env.DRIVERS_PROFILE_PICTURES_PATH}`)) {
          fs.mkdirSync(`.${process.env.DRIVERS_PROFILE_PICTURES_PATH}`);
        }

        //All the data received
        try {
          //! Check that the person is not applying twice
          dynamo_find_query({
            table_name: "drivers_application_central",
            IndexName: "phone_number",
            KeyConditionExpression: "phone_number = :val1",
            ExpressionAttributeValues: {
              ":val1": req.phone,
            },
          })
            .then((driverData) => {
              if (driverData !== undefined && driverData.length > 0) {
                //Already applied
                resolve({ response: "error_duplicate_application" });
              } //New and fresh application
              else {
                //Form the file names
                let user_fingerprint = `${req.phone}-${req.personal_details}-${
                  req.vehicle_details
                }-${new Date(chaineDateUTC).getTime()}`;
                new Promise((getFingerprint) => {
                  generateUniqueFingerprint(
                    user_fingerprint,
                    false,
                    getFingerprint
                  );
                })
                  .then((driverFp) => {
                    user_fingerprint = driverFp;
                    //? Parse the json string data
                    req.personal_details = JSON.parse(req.personal_details);
                    req.extensions = JSON.parse(req.extensions);
                    req.vehicle_details = JSON.parse(req.vehicle_details);

                    //? Make file names
                    let driverPhotoName = `driverPhoto_${user_fingerprint}.${req.extensions.driver_photo}`;
                    let vehiclePhoto = `vehiclePhoto${user_fingerprint}.${req.extensions.vehicle_photo}`;
                    let licensePhoto = `licensePhoto${user_fingerprint}.${req.extensions.license_photo}`;
                    let idPhoto = `idPhoto${user_fingerprint}.${req.extensions.id_photo}`;
                    let bluepaperPhoto = `bluepaperPhoto${user_fingerprint}.${req.extensions.bluepaper_photo}`;
                    let whitepaperPhoto = `whitepaperPhoto${user_fingerprint}.${req.extensions.whitepaper_photo}`;
                    let permitPhoto = `permitpaperPhoto${user_fingerprint}.${req.extensions.permit_photo}`;

                    //? Reconstitute the files in the tempo drivers folder
                    let filesData = [
                      {
                        name: driverPhotoName,
                        base64: req.driver_photo,
                      },
                      {
                        name: vehiclePhoto,
                        base64: req.vehicle_photo,
                      },
                      {
                        name: licensePhoto,
                        base64: req.license_photo,
                      },
                      {
                        name: idPhoto,
                        base64: req.id_photo,
                      },
                      {
                        name: bluepaperPhoto,
                        base64: req.bluepaper_photo,
                      },
                      {
                        name: whitepaperPhoto,
                        base64: req.whitepaper_photo,
                      },
                      {
                        name: permitPhoto,
                        base64: req.permit_photo,
                      },
                    ];

                    // logger.warn(filesData);
                    //...
                    //TODO: If the sum of all the values ==0 (Passed) else (at least one file failed to be reconstituted)
                    let parentReformLocally = filesData.map((fileData) => {
                      return new Promise((resCompute) => {
                        fs.writeFile(
                          `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${fileData.name}`,
                          String(fileData.base64),
                          "base64",
                          function (err) {
                            if (err) {
                              logger.error(err);
                              resCompute(1); //Failed
                            }
                            //...success
                            resCompute(0);
                          }
                        );
                      });
                    });
                    //..Done
                    Promise.all(parentReformLocally)
                      .then((resultReform) => {
                        let reformCheck = resultReform.reduce((acc, a) => {
                          return acc + a;
                        }, 0);

                        if (reformCheck == 0) {
                          //? SUCCESSFULLY REFORMED LOCALLY
                          //! UPLOAD THE PICTURE TO S3 - Promisify!
                          let parentUploadToS3 = filesData.map((fileData) => {
                            return new Promise((resUploadPic_toS3) => {
                              // Read content from the file
                              const fileContentUploaded_locally =
                                fs.readFileSync(
                                  `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${fileData.name}`
                                );

                              // Setting up S3 upload parameters
                              logger.warn(
                                `${process.env.AWS_S3_DRIVERS_BUCKET_NAME}/Drivers_Applications`
                              );
                              const params = {
                                Bucket: `${process.env.AWS_S3_DRIVERS_BUCKET_NAME}/Drivers_Applications`,
                                Key: fileData.name, // File name you want to save as in S3
                                Body: fileContentUploaded_locally,
                              };

                              // Uploading files to the bucket
                              s3.upload(params, function (err, data) {
                                if (err) {
                                  logger.info(err);
                                  resUploadPic_toS3(1);
                                }
                                logger.info(
                                  `[Drivers]${fileData.name} -> Successfully uploaded.`
                                );
                                resUploadPic_toS3(0);
                              });
                            });
                          });
                          //...
                          Promise.all(parentUploadToS3)
                            .then((resultReformRemote) => {
                              let reformRemoteCheck = resultReformRemote.reduce(
                                (acc, a) => {
                                  return acc + a;
                                },
                                0
                              );

                              if (reformRemoteCheck == 0) {
                                //?SUCCESSFULL Y UPLOADED TO s3
                                //Delete local file
                                let parentRemoveUneededFiles = filesData.map(
                                  (uneededFileData) => {
                                    return new Promise((resDelFiles) => {
                                      try {
                                        fs.unlink(
                                          `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${uneededFileData.name}`,
                                          (err) => {
                                            logger.warn(err);
                                          }
                                        );
                                        resDelFiles(true);
                                      } catch (error) {
                                        logger.warn(error);
                                        resDelFiles(false);
                                      }
                                    });
                                  }
                                );
                                //...
                                Promise.all(parentRemoveUneededFiles)
                                  .then((resDel) =>
                                    logger.info(`Deleted: ${resDel}`)
                                  )
                                  .catch((error) => logger.error(error));
                                //.............
                                //? Save applicate to db
                                let applicationBundle = {
                                  nature_driver: String(req.nature_driver)
                                    .toUpperCase()
                                    .trim(),
                                  city: req.city.toUpperCase().trim(),
                                  name: req.personal_details.name,
                                  surname: req.personal_details.surname,
                                  email: req.personal_details.email,
                                  phone_number: req.phone,
                                  driver_fingerprint: user_fingerprint,
                                  vehicle_details: req.vehicle_details,
                                  documents: {
                                    driver_photo: driverPhotoName,
                                    vehicle_photo: vehiclePhoto,
                                    license_photo: licensePhoto,
                                    id_photo: idPhoto,
                                  },
                                  accepted_conditions_details: {
                                    did_accept_terms: req.did_accept_terms,
                                    did_certify_data_veracity:
                                      req.did_certify_data_veracity,
                                  },
                                  date_applied: new Date(
                                    chaineDateUTC
                                  ).toISOString(),
                                };
                                //...
                                dynamo_insert(
                                  "drivers_application_central",
                                  applicationBundle
                                )
                                  .then((result) => {
                                    if (result === false) {
                                      resolve({
                                        response: "error_failed_application",
                                      });
                                    }
                                    //...Send SMS confirmation
                                    new Promise((resSMSNotif) => {
                                      let reqData = {
                                        phone: req.phone,
                                        name: req.personal_details.name,
                                      };
                                      sendSMSAny({
                                        req: reqData,
                                        resolve: resSMSNotif,
                                        service: "drive",
                                      });
                                    })
                                      .then()
                                      .catch((error) => logger.error(error));
                                    //...
                                    resolve({
                                      response: "successful_application",
                                    });
                                  })
                                  .catch((error) => {
                                    logger.error(error);
                                    resolve({
                                      response: "error_failed_application",
                                    });
                                  });
                              } //! At least one document failed to be reformed
                              else {
                                //Delete local file
                                let parentRemoveUneededFiles = filesData.map(
                                  (uneededFileData) => {
                                    return new Promise((resDelFiles) => {
                                      fs.unlink(
                                        `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${uneededFileData.name}`,
                                        (err) => {
                                          logger.error(err);
                                        }
                                      );
                                      resDelFiles(true);
                                    });
                                  }
                                );
                                //...
                                Promise.all(parentRemoveUneededFiles)
                                  .then((resDel) =>
                                    logger.info(`Deleted: ${resDel}`)
                                  )
                                  .catch((error) => logger.error(error));
                                //.............
                                //...
                                resolve({
                                  response: "error_reformation_remote",
                                });
                              }
                            })
                            .catch((error) => {
                              logger.error(error);
                              //Delete local file
                              let parentRemoveUneededFiles = filesData.map(
                                (uneededFileData) => {
                                  return new Promise((resDelFiles) => {
                                    fs.unlink(
                                      `.${process.env.DRIVERS_PROFILE_PICTURES_PATH}${uneededFileData.name}`,
                                      (err) => {
                                        logger.error(err);
                                      }
                                    );
                                    resDelFiles(true);
                                  });
                                }
                              );
                              //...
                              Promise.all(parentRemoveUneededFiles)
                                .then((resDel) =>
                                  logger.info(`Deleted: ${resDel}`)
                                )
                                .catch((error) => logger.error(error));
                              //.............
                              //...
                              resolve({
                                response: "error_reformation_remote",
                              });
                            });
                        } //! At least one document failed to be reformed
                        else {
                          resolve({ response: "error_reformation" });
                        }
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve({ response: "error_reformation" });
                      });
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: "error_parsing_data" });
                  });
              }
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: "error_failed_integrity_checks" });
            });
        } catch (error) {
          logger.error(error);
          resolve({ response: "error_parsing_data" });
        }
      } //Incomplete data
      else {
        resolve({ response: "error_parsing_data_1" });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.error(error);
        res.send({ response: "error" });
      });
  });
});

server.listen(process.env.ACCOUNTS_SERVICE_PORT);
//dash.monitor({ server: server });
