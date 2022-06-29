require("dotenv").config();
//require("newrelic");
var express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const { logger } = require("./LogService");
const nodemailer = require("nodemailer");

var app = express();
var server = http.createServer(app);
const requestAPI = require("request");
const crypto = require("crypto");
//....
const urlParser = require("url");

var chaineDateUTC = null;
var dateObject = null;
const moment = require("moment");
const { stringify, parse } = require("flatted");
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
  dynamo_find_get,
  dynamo_find_query,
  dynamo_get_all,
} = require("./DynamoServiceManager");

let transporterSecurity = nodemailer.createTransport({
  host: process.env.INOUT_GOING_SERVER,
  port: process.env.LOGIN_EMAIL_SMTP,
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.LOGIN_EMAIL_USER, // generated ethereal user
    pass: process.env.LOGIN_EMAIL_PASSWORD, // generated ethereal password
  },
});

let transporterNoReplay = nodemailer.createTransport({
  host: process.env.INOUT_GOING_SERVER,
  port: process.env.LOGIN_EMAIL_SMTP,
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.NOREPLY_EMAIL, // generated ethereal user
    pass: process.env.NOREPLY_EMAIL_PASSWORD, // generated ethereal password
  },
});

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

var AWS_SMS = require("aws-sdk");
function SendSMSTo(phone_number, message) {
  if (phone_number !== false && phone_number !== "false") {
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
  }
  // let username = "taxiconnect";
  // let password = "Taxiconnect*1";

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

/**
 * Responsible for sending push notification to devices
 */
var sendPushUPNotification = function (data) {
  //logger.info("Notify data");
  //logger.info(data);
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
      ////logger.info("Response:");
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
        "TAXICONNECTBASICKEYFINGERPRINTS-RIDES-DELIVERY"
      )
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  } else if (/md5/i.test(encryption)) {
    fingerprint = crypto
      .createHmac(
        "md5WithRSAEncryption",
        "TAXICONNECTBASICKEYFINGERPRINTS-RIDES-DELIVERY"
      )
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  } //Other - default
  else {
    fingerprint = crypto
      .createHmac("sha256", "TAXICONNECTBASICKEYFINGERPRINTS-RIDES-DELIVERY")
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  }
}

/**
 * @func isIntercityRide
 * Responsible for finding out if the ride is intercity or innercity.
 * @param inputData: received trip input data.
 */
function isIntercityRide(inputData) {
  // let testData = {
  //   actualRider: "someonelese",
  //   actualRiderPhone_number: "0817563369",
  //   carTypeSelected: "normalTaxiEconomy",
  //   connectType: "ConnectUs",
  //   country: "Namibia",
  //   destinationData: {
  //     passenger1Destination: {
  //       _id: "5f7e16126661813ab09e417f",
  //       averageGeo: -10.989369499999999,
  //       city: "Windhoek",
  //       coordinates: [-22.548558, 17.0504368],
  //       country: "Namibia",
  //       location_id: 242368923,
  //       location_name: "Grove Khomasdal Funky Town - Pequena Angola",
  //       query: "Grovr",
  //       state: "Khomas",
  //       street: false,
  //     },
  //     passenger2Destination: {
  //       _id: "5fc8dde588e09715d0df05ca",
  //       averageGeo: -5.491276299999999,
  //       city: "Windhoek",
  //       coordinates: [-22.5818168, 17.0878857],
  //       country: "Namibia",
  //       location_id: 1768699533,
  //       location_name: "Showground Parking Area",
  //       query: "Showg",
  //       state: "Khomas",
  //       street: "Jan Jonker Weg",
  //     },
  //     passenger3Destination: {
  //       _id: "5f7de487c6811253c83529b3",
  //       averageGeo: -10.975441900000003,
  //       city: "Windhoek",
  //       coordinates: [-22.56578, 17.0751551],
  //       country: "Namibia",
  //       location_id: 244132971,
  //       location_name: "NUST Main St",
  //       query: "Nust",
  //       state: "Khomas",
  //       street: false,
  //     },
  //     passenger4Destination: {
  //       _id: "5f7de491c6811253c83529f6",
  //       averageGeo: -11.1064516,
  //       city: "Windhoek",
  //       coordinates: [-22.6121691, 17.0233537],
  //       country: "Namibia",
  //       location_id: 6520901,
  //       location_name: "University of Namibia (UNAM)",
  //       query: "Unam",
  //       state: "Khomas",
  //       street: "Mandume Ndemufayo Avenue",
  //     },
  //   },
  //   fareAmount: 80,
  //   isAllGoingToSameDestination: false,
  //   naturePickup: "PrivateLocation",
  //   passengersNo: 4,
  //   pickupData: {
  //     city: "Windhoek",
  //     coordinates: [-22.5705005, 17.0809437],
  //     location_name: "Embassy of Brazil in Windhoek",
  //     street_name: "Simeon Shixungileni Steet",
  //   },
  //   pickupNote: "Hello world",
  //   receiverName_delivery: false,
  //   receiverPhone_delivery: false,
  //   rideType: "RIDE",
  //   timeScheduled: "immediate",
  //   paymentMethod: "CASH",
  //   user_fingerprint:
  //     "5b29bb1b9ac69d884f13fd4be2badcd22b72b98a69189bfab806dcf7c5f5541b6cbe8087cf60c791",
  // };
  // req = testData;
  //...
  let isIntercity = false;
  let isDone = false;
  for (var i = 0; i < Object.keys(inputData.destinationData).length; i++) {
    let key = `passenger${i + 1}Destination`;
    //...
    if (
      inputData.destinationData[key] !== false &&
      inputData.destinationData[key] !== undefined &&
      inputData.destinationData[key] !== null &&
      inputData.destinationData[key] !== "false"
    ) {
      let pickupCity = inputData.pickupData.city.trim().toUpperCase();
      let tmpDestinationCity = inputData.destinationData[key].city
        .trim()
        .toUpperCase();
      //...
      if (pickupCity !== tmpDestinationCity) {
        isIntercity = true;
      }
    }
    //...
    if (i + 1 === Object.keys(inputData.destinationData).length) {
      isDone = true;
    }
  }
  //...
  if (isDone) {
    return isIntercity;
  }
}

/**
 * @func parseRequestData
 * @param resolve
 * @param inputData: received request data straight from the rider's device.
 * Responsible for transforming the ride or delivery received data into a more refined
 * supported internal one.
 */
function parseRequestData(inputData, resolve) {
  resolveDate();
  //logger.info("INITIAL RECEIVED REQUEST");
  // logger.info("REQUEST DATA -> ", inputData);
  //! CHECK FOR A POTENTIAL CACHED VALUE FOR recoveredd data (from mysql)
  redisGet(
    `${
      inputData.request_fp !== undefined
        ? inputData.request_fp
        : inputData.user_fingerprint
    }-recoveredData`
  ).then((resp) => {
    if (resp !== null) {
      logger.info("Found some cached data");
      //Has a cached value
      resolve(parse(resp));
    } //GO FRESH
    else {
      //Check data consistency
      if (
        inputData.destinationData !== undefined &&
        inputData.destinationData.passenger1Destination !== undefined &&
        inputData.fareAmount !== undefined &&
        inputData.pickupData !== undefined &&
        inputData.pickupData.coordinates !== undefined &&
        inputData.user_fingerprint !== undefined &&
        inputData.rideType !== undefined
      ) {
        //Valid input
        let parsedData = {};
        //Complete unnested data
        //? Add the dispatch strategy used
        parsedData.dispatch_strategy = process.env.RIDES_DISPATCH_STRATEGY;
        //? Add the request globality - normal (default) or corporate
        parsedData.request_globality =
          inputData.request_globality !== undefined &&
          inputData.request_globality !== null
            ? inputData.request_globality
            : "normal";
        //? Add the subscribed plan
        parsedData.subscribed_plan =
          inputData.subscribed_plan !== undefined &&
          inputData.subscribed_plan !== null
            ? inputData.subscribed_plan
            : false;
        //! Detect the Intercity ride
        parsedData.isIntercity_trip = isIntercityRide(inputData);
        //! Attach the rider app version - if not found defaults to 2000
        parsedData.rider_app_version =
          inputData.rider_app_version !== undefined &&
          inputData.rider_app_version !== null
            ? parseFloat(inputData.rider_app_version)
            : 2000;
        //...
        parsedData.client_id = inputData.user_fingerprint;
        parsedData.request_fp = dateObject.unix();
        //Compute the request fp
        let uniqueString =
          inputData.user_fingerprint +
          "-" +
          inputData.passengersNo +
          "-" +
          chaineDateUTC;
        new Promise((res) => {
          generateUniqueFingerprint(uniqueString, false, res);
        })
          .then(
            (result) => {
              parsedData.request_fp =
                inputData.request_fp !== undefined &&
                inputData.request_fp !== null
                  ? inputData.request_fp
                  : result; //Update with the fingerprint;
            },
            (error) => {
              logger.warn(error);
              parsedData.request_fp =
                parsedData.user_fingerprint + dateObject.unix(); //Make a fingerprint out of the timestamp
            }
          )
          .finally(() => {
            //Continue
            parsedData.taxi_id =
              inputData.taxi_id !== undefined && inputData.taxi_id !== null
                ? inputData.taxi_id
                : false;
            parsedData.payment_method = inputData.paymentMethod
              .trim()
              .toUpperCase();
            parsedData.connect_type = inputData.connectType;
            parsedData.ride_mode = inputData.rideType;
            parsedData.fare = inputData.fareAmount;
            parsedData.isGoingUntilHome =
              inputData.isGoingUntilHome !== undefined &&
              inputData.isGoingUntilHome !== null
                ? /false/i.test(inputData.isGoingUntilHome)
                  ? false
                  : /true/i.test(inputData.isGoingUntilHome)
                  ? true
                  : inputData.isGoingUntilHome
                : false; //! Careful: Doubled the fares for the Economy type
            parsedData.passengers_number = inputData.passengersNo;
            parsedData.request_type = /now/i.test(inputData.timeScheduled)
              ? "immediate"
              : "scheduled";
            parsedData.allowed_drivers_see =
              inputData.taxi_id !== undefined && inputData.taxi_id !== null
                ? [inputData.taxi_id]
                : []; //LIST OF THE DRIVERS WHO CAN SEE THE REQUEST IN THEIR APP.
            //? Add the ccar fingerprint if any
            parsedData.car_fingerprint =
              inputData.car_fingerprint !== undefined &&
              inputData.car_fingerprint !== null
                ? inputData.car_fingerprint
                : false;
            //? Add the delete date if any
            if (
              inputData.date_deleted !== undefined &&
              inputData.date_deleted !== null
            ) {
              parsedData.date_deleted = inputData.date_deleted;
            }
            //Resolve the pickup time
            new Promise((res1) => {
              if (/immediate/i.test(parsedData.request_type)) {
                //Now request - now date
                parsedData.wished_pickup_time = new Date(chaineDateUTC);
                res1(true);
              } //Scheduled
              else {
                if (/today/i.test(inputData.timeScheduled)) {
                  //For today
                  //Generate a date mockup for today
                  //Timestring format of eg. Today at 14:30 - EXTREMELY IMPORTANT
                  let specifiedTIme = inputData.timeScheduled
                    .split(" ")[2]
                    .split(":");
                  let tmpDateString =
                    dateObject.year() +
                    "-" +
                    (dateObject.month() + 1) +
                    "-" +
                    dateObject.date() +
                    " " +
                    specifiedTIme[0] +
                    ":" +
                    specifiedTIme[1] +
                    ":00";
                  //...
                  parsedData.wished_pickup_time = new Date(tmpDateString);
                  res1(true);
                } //TOmorrow
                else {
                  //Generate a date mockup for tomorrow
                  //Timestring format of eg. Today at 14:30 - EXTREMELY IMPORTANT
                  let specifiedTIme = inputData.timeScheduled
                    .split(" ")[2]
                    .split(":");
                  let tmpDateString = new Date(
                    dateObject.year() +
                      "-" +
                      (dateObject.month() + 1) +
                      "-" +
                      dateObject.date() +
                      " " +
                      specifiedTIme[0] +
                      ":" +
                      specifiedTIme[1] +
                      ":00"
                  );
                  tmpDateString = tmpDateString.getTime();
                  tmpDateString += 86400000; //Add a day in ms
                  tmpDateString = moment(tmpDateString);
                  tmpDateString =
                    tmpDateString.year() +
                    "-" +
                    (tmpDateString.month() + 1) +
                    "-" +
                    tmpDateString.date() +
                    " " +
                    tmpDateString.hour() +
                    ":" +
                    tmpDateString.minute() +
                    ":" +
                    tmpDateString.second();
                  //...
                  parsedData.wished_pickup_time = new Date(tmpDateString);
                  res1(true);
                }
              }
            })
              .then(
                () => {},
                () => {}
              )
              .finally(() => {
                //COntinue
                //! Clean the country of invalid values
                inputData.country =
                  inputData.country !== "false" &&
                  inputData.country !== false &&
                  inputData.country !== null &&
                  inputData.country !== undefined
                    ? inputData.country
                    : "Namibia";
                //...
                parsedData.country =
                  inputData.country !== "false" &&
                  inputData.country !== false &&
                  inputData.country !== null &&
                  inputData.country !== undefined
                    ? inputData.country
                    : "Namibia";
                //Compute the simplified fingerprint
                new Promise((res2) => {
                  generateUniqueFingerprint(uniqueString, "md5", res2);
                })
                  .then(
                    (result) => {
                      parsedData.trip_simplified_id =
                        inputData.trip_simplified_id !== undefined &&
                        inputData.trip_simplified_id !== null
                          ? inputData.trip_simplified_id
                          : result;
                    },
                    (erro) => {
                      parsedData.trip_simplified_id =
                        parsedData.client_id.substring(0, 15) +
                        dateObject.milliseconds();
                    }
                  )
                  .finally(() => {
                    //continue
                    parsedData.carTypeSelected = inputData.carTypeSelected;
                    parsedData.isAllGoingToSameDestination =
                      inputData.isAllGoingToSameDestination;
                    parsedData.isArrivedToDestination =
                      inputData.isArrivedToDestination !== undefined &&
                      inputData.isArrivedToDestination !== null
                        ? inputData.isArrivedToDestination
                        : false;
                    parsedData.date_dropoff =
                      inputData.date_dropoff !== undefined &&
                      inputData.date_dropoff !== null
                        ? inputData.date_dropoff
                        : false;
                    parsedData.date_pickup =
                      inputData.date_pickup !== undefined &&
                      inputData.date_pickup !== null
                        ? inputData.date_pickup
                        : false;
                    parsedData.date_requested =
                      inputData.date_requested !== undefined &&
                      inputData.date_requested !== null
                        ? inputData.date_requested
                        : new Date(chaineDateUTC);
                    parsedData.date_accepted =
                      inputData.date_accepted !== undefined &&
                      inputData.date_accepted !== null
                        ? inputData.date_accepted
                        : false;
                    //Parse nested data
                    //1. Ride state vars
                    parsedData.ride_state_vars =
                      inputData.ride_state_vars !== undefined &&
                      inputData.ride_state_vars !== null
                        ? inputData.ride_state_vars
                        : {
                            isAccepted: false,
                            inRideToDestination: false,
                            isRideCompleted_driverSide: false,
                            isRideCompleted_riderSide: false,
                            rider_driverRating: "notYet",
                          };
                    //2.Pickup location infos
                    //! Clean the city of invalid values
                    inputData.pickupData.city =
                      inputData.pickupData.city !== "false" &&
                      inputData.pickupData.city !== false &&
                      inputData.pickupData.city !== null &&
                      inputData.pickupData.city !== undefined
                        ? inputData.pickupData.city
                        : "Windhoek";
                    //...
                    parsedData.pickup_location_infos = {
                      pickup_type: inputData.naturePickup,
                      coordinates: {
                        latitude: inputData.pickupData.coordinates[0],
                        longitude: inputData.pickupData.coordinates[1],
                      },
                      location_name: inputData.pickupData.location_name,
                      street_name: inputData.pickupData.street_name,
                      suburb: false,
                      pickup_note: inputData.pickupNote,
                      city:
                        inputData.pickupData.city !== "false" &&
                        inputData.pickupData.city !== false &&
                        inputData.pickupData.city !== null &&
                        inputData.pickupData.city !== undefined
                          ? inputData.pickupData.city
                          : "Windhoek",
                      state: null,
                    };
                    //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
                    //? Get temporary vars
                    let pickLatitude = parseFloat(
                      parsedData.pickup_location_infos.coordinates.latitude
                    );
                    let pickLongitude = parseFloat(
                      parsedData.pickup_location_infos.coordinates.longitude
                    );
                    //! Coordinates order fix - major bug fix for ocean bug
                    if (
                      pickLatitude !== undefined &&
                      pickLatitude !== null &&
                      pickLatitude !== 0 &&
                      pickLongitude !== undefined &&
                      pickLongitude !== null &&
                      pickLongitude !== 0
                    ) {
                      //? Switch latitude and longitude - check the negative sign
                      if (parseFloat(pickLongitude) < 0) {
                        //Negative - switch
                        parsedData.pickup_location_infos.coordinates.latitude =
                          pickLongitude;
                        parsedData.pickup_location_infos.coordinates.longitude =
                          pickLatitude;
                      }
                    }
                    //!!!
                    //Auto complete the suburb
                    new Promise((res3) => {
                      let url =
                        `${
                          /production/i.test(process.env.EVIRONMENT)
                            ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                            : process.env.LOCAL_URL
                        }` +
                        ":" +
                        process.env.PRICING_SERVICE_PORT +
                        "/getCorrespondingSuburbInfos?location_name=" +
                        inputData.pickupData.location_name +
                        "&street_name=" +
                        inputData.pickupData.street_name +
                        "&city=" +
                        inputData.pickupData.city +
                        "&country=" +
                        inputData.country +
                        "&latitude=" +
                        parsedData.pickup_location_infos.coordinates.latitude +
                        "&longitude=" +
                        parsedData.pickup_location_infos.coordinates.longitude +
                        "&user_fingerprint=" +
                        inputData.user_fingerprint +
                        "&make_new=false";
                      requestAPI(url, function (error, response, body) {
                        if (error === null) {
                          try {
                            logger.error(body);
                            body = JSON.parse(body);
                            parsedData.pickup_location_infos.suburb =
                              /Samora Machel Constituency/i.test(body.suburb)
                                ? "Wanaheda"
                                : body.suburb; //! Suburb
                            parsedData.pickup_location_infos.state = body.state
                              .replace(/ Region/i, "")
                              .trim(); //! State
                            parsedData.pickup_location_infos.location_name =
                              body.location_name !== undefined &&
                              body.location_name !== null &&
                              body.location_name !== false &&
                              body.location_name !== "false"
                                ? body.location_name
                                : parsedData.pickup_location_infos
                                    .location_name; //! Location name
                            parsedData.pickup_location_infos.street_name =
                              body.street_name !== undefined &&
                              body.street_name !== null &&
                              body.street_name !== false &&
                              body.street_name !== "false"
                                ? body.street_name
                                : parsedData.pickup_location_infos.street_name; //! Street name

                            parsedData.pickup_location_infos.city =
                              body.city !== undefined &&
                              body.city !== null &&
                              body.city !== false &&
                              body.city !== "false"
                                ? body.city
                                : parsedData.pickup_location_infos.city; //! City

                            res3(true);
                          } catch (error) {
                            res3(false);
                          }
                        } else {
                          res3(false);
                        }
                      });
                    })
                      .then(
                        () => {},
                        () => {}
                      )
                      .finally(() => {
                        //Continue
                        //3. Delivery infos
                        parsedData.delivery_infos = {
                          receiverName_delivery:
                            inputData.receiverName_delivery,
                          receiverPhone_delivery:
                            inputData.receiverPhone_delivery,
                          packageSize: inputData.packageSizeDelivery,
                        };
                        //4. Rider infos
                        parsedData.rider_infos = {
                          actualRider: /^someonelese$/i.test(
                            inputData.actualRider
                          )
                            ? "someoneelse"
                            : "me",
                          actualRiderPhone_number:
                            inputData.actualRiderPhone_number,
                        };

                        //5. DESTINATION DATA
                        let cleanInputData = { destinationData: null };
                        //Resolve destination infos
                        new Promise((res5) => {
                          cleanInputData.destinationData = [];
                          let tmpSchemaArray = new Array(
                            parseInt(inputData.passengersNo)
                          ).fill(1); //! Just for iterations, nothing more, instead of using for loop, but make it the right size - critical bug fix (Mandatory 4 passengers going to the same direction bug).
                          if (inputData.passengersNo > 1) {
                            //Many passengers
                            //Check if all going to the same destination
                            //? Clean the boolean
                            inputData.isAllGoingToSameDestination =
                              /string/i.test(
                                typeof inputData.isAllGoingToSameDestination
                              )
                                ? inputData.isAllGoingToSameDestination ===
                                  "true"
                                  ? true
                                  : false
                                : inputData.isAllGoingToSameDestination;
                            //? -----------
                            if (
                              inputData.isAllGoingToSameDestination &&
                              inputData.isAllGoingToSameDestination !== false &&
                              inputData.isAllGoingToSameDestination !== "false"
                            ) {
                              //yes
                              tmpSchemaArray.map((element, index) => {
                                cleanInputData.destinationData.push({
                                  passenger_number_id: index + 1,
                                  dropoff_type: "PrivateLocation",
                                  coordinates: {
                                    latitude:
                                      inputData.destinationData
                                        .passenger1Destination.coordinates[1],
                                    longitude:
                                      inputData.destinationData
                                        .passenger1Destination.coordinates[0],
                                  },
                                  location_name:
                                    inputData.destinationData
                                      .passenger1Destination.location_name !==
                                      undefined &&
                                    inputData.destinationData
                                      .passenger1Destination.location_name !==
                                      false
                                      ? inputData.destinationData
                                          .passenger1Destination.location_name
                                      : false,
                                  street_name:
                                    inputData.destinationData
                                      .passenger1Destination.street !==
                                      undefined &&
                                    inputData.destinationData
                                      .passenger1Destination.street !== false
                                      ? inputData.destinationData
                                          .passenger1Destination.street
                                      : false,
                                  receiver_infos:
                                    /normal/i.test(
                                      inputData.request_globality
                                    ) ||
                                    inputData.request_globality === undefined
                                      ? null
                                      : inputData.destinationData
                                          .passenger1Destination.receiver_infos,
                                  suburb:
                                    inputData.destinationData
                                      .passenger1Destination.suburb,
                                  state:
                                    inputData.destinationData.passenger1Destination.state
                                      .replace(/ Region/i, "")
                                      .trim(),
                                  city: inputData.destinationData
                                    .passenger1Destination.city,
                                });
                              });
                              //Done
                              res5(cleanInputData);
                            } //Independent destinations,.....:(
                            else {
                              let index = 0;
                              for (var passengerKey in inputData.destinationData) {
                                index += 1;
                                logger.warn(passengerKey);
                                let passengerData =
                                  inputData.destinationData[passengerKey];
                                logger.warn(passengerData);
                                if (
                                  passengerData !== false &&
                                  passengerData !== "false"
                                ) {
                                  //Passenger model
                                  cleanInputData.destinationData.push({
                                    passenger_number_id: index,
                                    dropoff_type: "PrivateLocation",
                                    coordinates: {
                                      latitude: passengerData.coordinates[1],
                                      longitude: passengerData.coordinates[0],
                                    },
                                    location_name:
                                      passengerData.location_name !==
                                        undefined &&
                                      passengerData.location_name !== false
                                        ? passengerData.location_name
                                        : false,
                                    street_name:
                                      passengerData.street !== undefined &&
                                      passengerData.street !== false
                                        ? passengerData.street
                                        : false,
                                    receiver_infos:
                                      /normal/i.test(
                                        inputData.request_globality
                                      ) ||
                                      inputData.request_globality === undefined
                                        ? null
                                        : passengerData.receiver_infos,
                                    suburb: passengerData.suburb,
                                    state: passengerData.state
                                      .replace(/ Region/i, "")
                                      .trim(),
                                    city: passengerData.city,
                                  });
                                }
                              }

                              res5(cleanInputData);
                            }
                          } //Single passenger
                          else {
                            cleanInputData.destinationData.push({
                              passenger_number_id: 1,
                              dropoff_type: "PrivateLocation",
                              coordinates: {
                                latitude:
                                  inputData.destinationData
                                    .passenger1Destination.coordinates[1],
                                longitude:
                                  inputData.destinationData
                                    .passenger1Destination.coordinates[0],
                              },
                              location_name:
                                inputData.destinationData.passenger1Destination
                                  .location_name !== undefined &&
                                inputData.destinationData.passenger1Destination
                                  .location_name !== false
                                  ? inputData.destinationData
                                      .passenger1Destination.location_name
                                  : false,
                              street_name:
                                inputData.destinationData.passenger1Destination
                                  .street !== undefined &&
                                inputData.destinationData.passenger1Destination
                                  .street !== false
                                  ? inputData.destinationData
                                      .passenger1Destination.street
                                  : false,
                              receiver_infos:
                                /normal/i.test(inputData.request_globality) ||
                                inputData.request_globality === undefined
                                  ? null
                                  : inputData.destinationData
                                      .passenger1Destination.receiver_infos,
                              suburb:
                                inputData.destinationData.passenger1Destination
                                  .suburb,
                              state:
                                inputData.destinationData.passenger1Destination.state
                                  .replace(/ Region/i, "")
                                  .trim(),
                              city: inputData.destinationData
                                .passenger1Destination.city,
                            });
                            res5(cleanInputData);
                          }
                        }).then(
                          (reslt) => {
                            //? Autocomplete the destination data if any of them are incomplete
                            let parentPromises = reslt.destinationData.map(
                              (destination) => {
                                return new Promise((resCompute) => {
                                  if (
                                    destination.suburb === undefined ||
                                    destination.suburb === null ||
                                    destination.suburb === false ||
                                    destination.suburb === "false" ||
                                    destination.state === undefined ||
                                    destination.state === null ||
                                    destination.state === false ||
                                    destination.state === "false"
                                  ) {
                                    //Found some invalid input data
                                    logger.warn(
                                      "Found some invalid input data, resolving them..."
                                    );
                                    let url =
                                      `${
                                        /production/i.test(
                                          process.env.EVIRONMENT
                                        )
                                          ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                                          : process.env.LOCAL_URL
                                      }` +
                                      ":" +
                                      process.env.SEARCH_SERVICE_PORT +
                                      `/brieflyCompleteSuburbAndState?latitude=${destination.coordinates.latitude}&longitude=${destination.coordinates.longitude}&city=${destination.city}&location_name=${destination.location_name}`;

                                    requestAPI(
                                      url,
                                      function (error, response, body) {
                                        try {
                                          body = JSON.parse(body);
                                          logger.warn(body);
                                          //? Update the old record
                                          destination.suburb = body.suburb;
                                          destination.state = body.state
                                            .replace(/ Region/i, "")
                                            .trim();
                                          //DONE
                                          resCompute(destination);
                                        } catch (error) {
                                          logger.error(error);
                                          resCompute(destination);
                                        }
                                      }
                                    );
                                  } //Clean data
                                  else {
                                    if (/ Region/i.test(destination.state)) {
                                      destination.state =
                                        destination.state.replace(
                                          / Region/,
                                          ""
                                        );
                                      resCompute(destination);
                                    } //No problem
                                    else {
                                      resCompute(destination);
                                    }
                                  }
                                });
                              }
                            );
                            //DONE
                            Promise.all(parentPromises)
                              .then((result) => {
                                //Update the destination data based on the order
                                result.map((updatedDestination) => {
                                  reslt.destinationData.map(
                                    (oldDestination, index) => {
                                      if (
                                        parseInt(
                                          updatedDestination.passenger_number_id
                                        ) ===
                                        parseInt(
                                          oldDestination.passenger_number_id
                                        )
                                      ) {
                                        //Matched record
                                        reslt.destinationData[index] =
                                          updatedDestination; //? Updated source record
                                      }
                                    }
                                  );
                                });
                                //DONE
                                //Update the destination data
                                parsedData.destinationData =
                                  reslt.destinationData;
                                //? DONE
                                resolve(parsedData);
                              })
                              .catch((error) => {
                                logger.error(error);
                                //Update the destination data
                                parsedData.destinationData =
                                  reslt.destinationData;
                                //? DONE
                                resolve(parsedData);
                              });
                          },
                          (error) => {
                            logger.error(error);
                            resolve(false);
                          }
                        );
                      });
                  });
              });
          });
      } //Invalid data
      else {
        logger.warn("Invalid data detected!");
        resolve(false);
      }
    }
  });
}

/**
 * @func intitiateStagedDispatch
 * @param resolve
 * @param snapshotTripInfos: this will contain basic review of the trip, specifically the fare, passengers number, ride type (ride/delivery),
 * @param collectionRidesDeliveries_data: rides and delivery collection
 * @param collectionDrivers_profiles: drivers profiles collection
 * @param distilledUnwantedDrivers: the drivers that were intentionally blocked by the clients
 * connect type (connectMe/connectUS).
 * Responsible for sending notifications to drivers in a staged manner:
 * ? Closest first (1 driver)
 * after 1min30'' of not accepting
 * ? increase the radius (3 drivers)
 * after 1 min of not accepting
 * ? increase the radius (5 drivers)
 * after 1 min of not accepting
 * ? increase the radius (all the rest)
 * ? after 20 min of not accepting - AUTO cancel request
 */
function intitiateStagedDispatch(
  snapshotTripInfos,
  collectionDrivers_profiles,
  collectionRidesDeliveries_data,
  distilledUnwantedDrivers,
  resolve
) {
  //Get the list of all the closest drivers
  /**
   * Can use @param includeOfflineDrivers to also subscribe offline drivers to a request.
   */
  /*new Promise((res) => {
    sendStagedNotificationsDrivers(
      false,
      snapshotTripInfos,
      collectionDrivers_profiles,
      collectionRidesDeliveries_data,
      res
    );
  }).then(
    (result) => {
      //logger.info(result);
      resolve(result);
    },
    (error) => {
      //logger.info(error);
      resolve(false);
    }
  );*/
  if (process.env.RIDES_DISPATCH_STRATEGY === "targeted") {
    let url =
      `${
        /production/i.test(process.env.EVIRONMENT)
          ? `http://${process.env.INSTANCE_PRIVATE_IP}`
          : process.env.LOCAL_URL
      }` +
      ":" +
      process.env.MAP_SERVICE_PORT +
      "/getVitalsETAOrRouteInfos2points?user_fingerprint=" +
      snapshotTripInfos.user_fingerprint +
      "&org_latitude=" +
      snapshotTripInfos.org_latitude +
      "&org_longitude=" +
      snapshotTripInfos.org_longitude +
      "&ride_type=" +
      snapshotTripInfos.ride_type +
      "&vehicle_type=" +
      snapshotTripInfos.vehicle_type +
      "&city=" +
      snapshotTripInfos.city +
      "&country=" +
      snapshotTripInfos.country +
      "&list_limit=all";
    //? "&list_limit=all&make_new=true";
    requestAPI(url, function (error, response, body) {
      logger.info(body);
      try {
        body = JSON.parse(body);
        if (body.response !== undefined) {
          //Error getting the list - send to all drivers
          new Promise((res) => {
            sendStagedNotificationsDrivers(
              false,
              snapshotTripInfos,
              collectionDrivers_profiles,
              collectionRidesDeliveries_data,
              distilledUnwantedDrivers,
              res
            );
          }).then(
            (result) => {
              //logger.info(result);
              resolve(result);
            },
            (error) => {
              //logger.info(error);
              resolve(false);
            }
          );
        } //Successfully got the list
        else {
          new Promise((res) => {
            sendStagedNotificationsDrivers(
              body,
              snapshotTripInfos,
              collectionDrivers_profiles,
              collectionRidesDeliveries_data,
              distilledUnwantedDrivers,
              res
            );
          }).then(
            (result) => {
              //logger.info(result);
              resolve(result);
            },
            (error) => {
              //logger.info(error);
              resolve(false);
            }
          );
        }
      } catch (error) {
        //logger.info(error);
        //Error getting the list of closest drivers - send to all the drivers
        new Promise((res) => {
          sendStagedNotificationsDrivers(
            false,
            snapshotTripInfos,
            collectionDrivers_profiles,
            collectionRidesDeliveries_data,
            distilledUnwantedDrivers,
            res
          );
        }).then(
          (result) => {
            //logger.info(result);
            resolve(result);
          },
          (error) => {
            //logger.info(error);
            resolve(false);
          }
        );
      }
    });
  } //General dispatch
  else {
    new Promise((res) => {
      sendStagedNotificationsDrivers(
        false,
        snapshotTripInfos,
        collectionDrivers_profiles,
        collectionRidesDeliveries_data,
        distilledUnwantedDrivers,
        res
      );
    }).then(
      (result) => {
        //logger.info(result);
        resolve(result);
      },
      (error) => {
        //logger.info(error);
        resolve(false);
      }
    );
  }
}

/**
 * @func sendStagedNotificationsDrivers
 * @param resolve
 * @param collectionRidesDeliveries_data: rides and delivery collection
 * @param collectionDrivers_profiles: drivers profiles collection
 * @param snapshotTripInfos: brief trip infos
 * @param closestDriversList: the list of all the closest drivers OR false if failed to get the list,
 * @param distilledUnwantedDrivers: the drivers that were intentionally blocked by the clients
 * in the last scenario, dispatch to all the online drivers.
 * Responsible for EXECUTING the staged sending of notifications and adding correspoding drivers to
 * the allowed_drivers_see list of the request so that they can access the trip from their app if not
 * yet accepted.
 * ? Closest first (1 driver)
 * after 35sec of not accepting
 * ? increase the radius (5 drivers)
 * after 30sec of not accepting
 * ? increase the radius (10 drivers)
 * after 30sec of not accepting
 * ? increase the radius (all the rest)
 * ! after 20 min of not accepting - AUTO cancel request
 * * 2 DISPATCH STRATEGIES:
 * * 1. Targeted: sends rides serially to the closest drivers first with a reasonable time delay to increase
 * * ************ the chances of the request to be accepted by the optimal driver.
 * * 2. General: sends rides to all the drivers in the city, giving the same probability to everyone of accepting
 * * ************ the request, decreasing the probability of the optimal driver to accept.
 */
function sendStagedNotificationsDrivers(
  closestDriversList,
  snapshotTripInfos,
  collectionDrivers_profiles,
  collectionRidesDeliveries_data,
  distilledUnwantedDrivers,
  resolve
) {
  logger.error(
    `DISPATCH STRATEGY TEST: ${/general/i.test(
      process.env.RIDES_DISPATCH_STRATEGY
    )}`
  );
  if (/general/i.test(process.env.RIDES_DISPATCH_STRATEGY)) {
    //Send to all the drivers
    //1. Filter the drivers based on trip requirements
    //2. Register their fp in the allowed_drivers_see on the requests
    //3. Send the notifications to each selected one.
    let driverFilter = {
      "operational_state.status": { $in: ["online"] },
      //! "operational_state.last_location.city": snapshotTripInfos.city,
      /*"operational_state.last_location.country": snapshotTripInfos.country,
      operation_clearances: snapshotTripInfos.ride_type,*/
      //Filter the drivers based on the vehicle type if provided
      "operational_state.default_selected_car.vehicle_type":
        snapshotTripInfos.vehicle_type,
    };
    //..
    collectionDrivers_profiles
      .find(driverFilter)
      .toArray(function (err, driversProfiles) {
        //Filter the drivers based on their car's maximum capacity (the amount of passengers it can handle)
        //They can receive 3 additional requests on top of the limit of sits in their selected cars.
        //! DISBALE PASSENGERS CHECK
        /*driversProfiles = driversProfiles.filter(
          (dData) =>
            dData.operational_state.accepted_requests_infos === null ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number <=
              dData.operational_state.default_selected_car.max_passengers + 3 ||
            dData.operational_state.accepted_requests_infos === undefined ||
            dData.operational_state.accepted_requests_infos === null ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number === undefined ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number === null
        );*/

        //...Register the drivers fp so that thei can see tne requests
        //TODO: Filter the driver's fingerprint based on the regional clearances as well.
        let driversFp = driversProfiles.map((data) => {
          if (
            distilledUnwantedDrivers.includes(data.driver_fingerprint) === false
          ) {
            data.driver_fingerprint;
          }
        }); //Drivers fingerprints
        let driversPushNotif_token = driversProfiles.map((data) => {
          if (
            /online/i.test(data.operational_state.status) &&
            distilledUnwantedDrivers.includes(data.driver_fingerprint) === false
          ) {
            let driverData = data;
            if (
              snapshotTripInfos.isIntercity_trip === true ||
              snapshotTripInfos.isIntercity_trip === "true"
            ) {
              //? Intercity trip
              //? Check that the region and the city is within the driver's regional clearances.
              logger.info("Intercity trip detected");
              let driverRegionalClearances =
                driverData.regional_clearances !== undefined &&
                driverData.regional_clearances !== null
                  ? driverData.regional_clearances
                  : false;
              //...
              let driverCity =
                driverData.operational_state.last_location !== null &&
                driverData.operational_state.last_location !== undefined &&
                driverData.operational_state.last_location.city !== undefined &&
                driverData.operational_state.last_location.city != null
                  ? driverData.operational_state.last_location.city
                  : false;
              //...
              if (driverRegionalClearances !== false && driverCity !== false) {
                //Has a regional clearance
                // logger.info(trip.origin_destination_infos.destination_infos);
                if (
                  driverRegionalClearances[snapshotTripInfos.region] !==
                    undefined &&
                  driverRegionalClearances[snapshotTripInfos.region] !== null
                ) {
                  //! Sort the clearances array
                  driverRegionalClearances[snapshotTripInfos.region].sort();

                  //? Found a valid clearance rule
                  //? 1. Check if the pickup AND destination towns is included in the clearances
                  let tripTowns_summary = [
                    snapshotTripInfos.city,
                    ...snapshotTripInfos.destination_infos.map(
                      (dest) => dest.city
                    ),
                  ];
                  // Normalize
                  tripTowns_summary = tripTowns_summary.map((el) =>
                    el.trim().toUpperCase()
                  );
                  // Sort
                  tripTowns_summary.sort();
                  if (
                    arrayEquals(
                      tripTowns_summary,
                      driverRegionalClearances[snapshotTripInfos.region]
                    )
                  ) {
                    //TOWNS WITHIN THE CLEARANCES
                    //? 2. Check that the driver's current location (city) as equal to one of the towns allowed by his regional credentials.
                    driverCity = driverCity.trim().toUpperCase();
                    //...
                    if (
                      driverRegionalClearances[
                        snapshotTripInfos.region
                      ].includes(driverCity)
                    ) {
                      //? Driver's current location is within the regional clearances
                      logger.info(
                        `Intercity trip allowed for driver's interaction -> ${driverData.driver_fingerprint.substring(
                          0,
                          15
                        )}`
                      );
                      return data.operational_state.push_notification_token !==
                        null &&
                        data.operational_state.push_notification_token !==
                          undefined
                        ? data.operational_state.push_notification_token.userId
                        : null;
                    } //! The driver's current location is not within the regional clearances
                    else {
                      logger.warn(
                        `The driver's current location is not within the regional clearances`
                      );
                      return null;
                    }
                  } //Towns for the trip not fitting in the driver's regional clearances
                  else {
                    logger.warn(
                      `Towns for the trip not fitting in the driver's regional clearances`
                    );
                    return null;
                  }
                } //No valid rule found
                else {
                  logger.warn("No valid regional clearance rule found.");
                  return null;
                }
              } //?No regional clearances
              else {
                logger.warn("No regional clearances found for this driver.");
                return null;
              }
            } //? Not intercity trip - filter based on the drivers location
            else {
              logger.info("Normal innercity trip detected");
              let driverCity =
                driverData.operational_state.last_location !== null &&
                driverData.operational_state.last_location !== undefined &&
                driverData.operational_state.last_location.city !== undefined &&
                driverData.operational_state.last_location.city != null
                  ? driverData.operational_state.last_location.city
                  : "MISSING";
              //...
              logger.error(snapshotTripInfos.city.trim().toUpperCase());
              logger.error(driverCity.trim().toUpperCase());
              if (
                snapshotTripInfos.city.trim().toUpperCase() ===
                driverCity.trim().toUpperCase()
              ) {
                return data.operational_state.push_notification_token !==
                  null &&
                  data.operational_state.push_notification_token !== undefined
                  ? data.operational_state.push_notification_token.userId
                  : null;
              } //not elligible driver
              else {
                return null;
              }
            }
          } else {
            return null; //Only notify the drivers that are online.
          }
        }); //Push notification token
        logger.error(driversPushNotif_token);
        dynamo_update(
          "rides_deliveries_requests",
          { request_fp: snapshotTripInfos.request_fp },
          "set allowed_drivers_see = :val1",
          {
            ":val1": driversFp,
          }
        )
          .then((result) => {
            //Send the push notifications - FOR DRIVERS
            //! Safety net against undefined suburbs
            snapshotTripInfos.pickup_suburb =
              snapshotTripInfos.pickup_suburb === undefined
                ? false
                : snapshotTripInfos.pickup_suburb;
            //!
            // new Promise((resNotify) => {
            //   let message = {
            //     app_id: process.env.DRIVERS_APP_ID_ONESIGNAL,
            //     android_channel_id: /RIDE/i.test(snapshotTripInfos.ride_type)
            //       ? process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION
            //       : process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION, //Ride or delivery channel
            //     priority: 10,
            //     contents: /RIDE/i.test(snapshotTripInfos.ride_type)
            //       ? {
            //           en:
            //             "You have a new ride request " +
            //             (snapshotTripInfos.pickup_suburb !== false
            //               ? "from " + snapshotTripInfos.pickup_suburb !==
            //                   undefined &&
            //                 snapshotTripInfos.pickup_suburb !== false &&
            //                 snapshotTripInfos.pickup_suburb !== null
            //                 ? snapshotTripInfos.pickup_suburb.toUpperCase()
            //                 : "near your location" +
            //                     " to " +
            //                     snapshotTripInfos.destination_suburb !==
            //                     undefined &&
            //                   snapshotTripInfos.destination_suburb !== false &&
            //                   snapshotTripInfos.destination_suburb !== null
            //                 ? snapshotTripInfos.destination_suburb.toUpperCase()
            //                 : "near your location" +
            //                   ". Click here for more details."
            //               : "near your location, click here for more details."),
            //         }
            //       : {
            //           en:
            //             "You have a new delivery request " +
            //             (snapshotTripInfos.pickup_suburb !== false
            //               ? "from " + snapshotTripInfos.pickup_suburb !==
            //                   undefined &&
            //                 snapshotTripInfos.pickup_suburb !== false &&
            //                 snapshotTripInfos.pickup_suburb !== null
            //                 ? snapshotTripInfos.pickup_suburb.toUpperCase()
            //                 : "near your location" +
            //                     " to " +
            //                     snapshotTripInfos.destination_suburb !==
            //                     undefined &&
            //                   snapshotTripInfos.destination_suburb !== false &&
            //                   snapshotTripInfos.destination_suburb !== null
            //                 ? snapshotTripInfos.destination_suburb.toUpperCase()
            //                 : "near your location" +
            //                   ". Click here for more details."
            //               : "near your location, click here for more details."),
            //         },
            //     headings: /RIDE/i.test(snapshotTripInfos.ride_type)
            //       ? { en: "New ride request, N$" + snapshotTripInfos.fare }
            //       : { en: "New delivery request, N$" + snapshotTripInfos.fare },
            //     content_available: true,
            //     include_player_ids: driversPushNotif_token,
            //   };
            //   //Send
            //   sendPushUPNotification(message);
            //   resNotify(true);
            // })
            //   .then()
            //   .catch();

            new Promise((resNotify) => {
              let message = {
                app_id: process.env.DRIVERS_APP_ID_ONESIGNAL,
                android_channel_id: /RIDE/i.test(snapshotTripInfos.ride_type)
                  ? process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION
                  : process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION, //Ride or delivery channel
                priority: 10,
                contents: /RIDE/i.test(snapshotTripInfos.ride_type)
                  ? {
                      en:
                        "You have a new ride request " +
                        (snapshotTripInfos.pickup_suburb !== false
                          ? "from " + snapshotTripInfos.pickup_suburb !==
                              undefined &&
                            snapshotTripInfos.pickup_suburb !== false &&
                            snapshotTripInfos.pickup_suburb !== null
                            ? snapshotTripInfos.pickup_suburb.toUpperCase()
                            : "near your location" +
                                " to " +
                                snapshotTripInfos.destination_suburb !==
                                undefined &&
                              snapshotTripInfos.destination_suburb !== false &&
                              snapshotTripInfos.destination_suburb !== null
                            ? snapshotTripInfos.destination_suburb.toUpperCase()
                            : "near your location" +
                              ". Click here for more details."
                          : "near your location, click here for more details."),
                    }
                  : {
                      en:
                        "You have a new delivery request " +
                        (snapshotTripInfos.pickup_suburb !== false
                          ? "from " + snapshotTripInfos.pickup_suburb !==
                              undefined &&
                            snapshotTripInfos.pickup_suburb !== false &&
                            snapshotTripInfos.pickup_suburb !== null
                            ? snapshotTripInfos.pickup_suburb.toUpperCase()
                            : "near your location" +
                                " to " +
                                snapshotTripInfos.destination_suburb !==
                                undefined &&
                              snapshotTripInfos.destination_suburb !== false &&
                              snapshotTripInfos.destination_suburb !== null
                            ? snapshotTripInfos.destination_suburb.toUpperCase()
                            : "near your location" +
                              ". Click here for more details."
                          : "near your location, click here for more details."),
                    },
                headings: /RIDE/i.test(snapshotTripInfos.ride_type)
                  ? { en: "New ride request, N$" + snapshotTripInfos.fare }
                  : { en: "New delivery request, N$" + snapshotTripInfos.fare },
                content_available: true,
                include_player_ids: driversPushNotif_token,
              };
              //Send
              sendPushUPNotification(message);
              resNotify(true);
            })
              .then()
              .catch();

            //?---Done
            resolve({ response: "successfully_dispatched" });
          })
          .catch((error) => {
            logger.error(error);
            resolve(false);
          });
      });
  } //? TARGETED DISPATCH
  else {
    if (
      closestDriversList === false ||
      closestDriversList[0] === undefined ||
      closestDriversList.response !== undefined ||
      /no_close_drivers_found/i.test(closestDriversList.response)
    ) {
      //Send to all the drivers
      //1. Filter the drivers based on trip requirements
      //2. Register their fp in the allowed_drivers_see on the requests
      //3. Send the notifications to each selected one.
      let driverFilter = {
        "operational_state.status": { $in: ["online"] },
        "operational_state.last_location.city": snapshotTripInfos.city,
        /*"operational_state.last_location.country": snapshotTripInfos.country,
        operation_clearances: snapshotTripInfos.ride_type,*/
        //Filter the drivers based on the vehicle type if provided
        "operational_state.default_selected_car.vehicle_type":
          snapshotTripInfos.vehicle_type,
      };
      //..
      collectionDrivers_profiles
        .find(driverFilter)
        .toArray(function (err, driversProfiles) {
          //Filter the drivers based on their car's maximum capacity (the amount of passengers it can handle)
          //They can receive 3 additional requests on top of the limit of sits in their selected cars.
          //! DISBALE PASSENGERS CHECK
          /*driversProfiles = driversProfiles.filter(
          (dData) =>
            dData.operational_state.accepted_requests_infos === null ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number <=
              dData.operational_state.default_selected_car.max_passengers + 3 ||
            dData.operational_state.accepted_requests_infos === undefined ||
            dData.operational_state.accepted_requests_infos === null ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number === undefined ||
            dData.operational_state.accepted_requests_infos
              .total_passengers_number === null
        );*/

          //...Register the drivers fp so that thei can see tne requests
          let driversFp = driversProfiles.map((data) => {
            if (
              distilledUnwantedDrivers.includes(data.driver_fingerprint) ===
              false
            ) {
              data.driver_fingerprint;
            }
          }); //Drivers fingerprints
          let driversPushNotif_token = driversProfiles.map((data) => {
            if (
              /online/i.test(data.operational_state.status) &&
              distilledUnwantedDrivers.includes(data.driver_fingerprint) ===
                false
            ) {
              return data.operational_state.push_notification_token !== null &&
                data.operational_state.push_notification_token !== undefined
                ? data.operational_state.push_notification_token.userId
                : null;
            } else {
              return null; //Only notify the drivers that are online.
            }
          }); //Push notification token

          dynamo_update(
            "rides_deliveries_requests",
            { request_fp: snapshotTripInfos.request_fp },
            "set allowed_drivers_see = :val1",
            {
              ":val1": driversFp,
            }
          )
            .then((result) => {
              //Send the push notifications - FOR DRIVERS
              let message = {
                app_id: process.env.DRIVERS_APP_ID_ONESIGNAL,
                android_channel_id: /RIDE/i.test(snapshotTripInfos.ride_type)
                  ? process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION
                  : process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION, //Ride or delivery channel
                priority: 10,
                contents: /RIDE/i.test(snapshotTripInfos.ride_type)
                  ? {
                      en:
                        "You have a new ride request " +
                        (snapshotTripInfos.pickup_suburb !== false
                          ? "from " + snapshotTripInfos.pickup_suburb !==
                              undefined &&
                            snapshotTripInfos.pickup_suburb !== false &&
                            snapshotTripInfos.pickup_suburb !== null
                            ? snapshotTripInfos.pickup_suburb.toUpperCase()
                            : "near your location" +
                                " to " +
                                snapshotTripInfos.destination_suburb !==
                                undefined &&
                              snapshotTripInfos.destination_suburb !== false &&
                              snapshotTripInfos.destination_suburb !== null
                            ? snapshotTripInfos.destination_suburb.toUpperCase()
                            : "near your location" +
                              ". Click here for more details."
                          : "near your location, click here for more details."),
                    }
                  : {
                      en:
                        "You have a new delivery request " +
                        (snapshotTripInfos.pickup_suburb !== false
                          ? "from " + snapshotTripInfos.pickup_suburb !==
                              undefined &&
                            snapshotTripInfos.pickup_suburb !== false &&
                            snapshotTripInfos.pickup_suburb !== null
                            ? snapshotTripInfos.pickup_suburb.toUpperCase()
                            : "near your location" +
                                " to " +
                                snapshotTripInfos.destination_suburb !==
                                undefined &&
                              snapshotTripInfos.destination_suburb !== false &&
                              snapshotTripInfos.destination_suburb !== null
                            ? snapshotTripInfos.destination_suburb.toUpperCase()
                            : "near your location" +
                              ". Click here for more details."
                          : "near your location, click here for more details."),
                    },
                headings: /RIDE/i.test(snapshotTripInfos.ride_type)
                  ? { en: "New ride request, N$" + snapshotTripInfos.fare }
                  : { en: "New delivery request, N$" + snapshotTripInfos.fare },
                content_available: true,
                include_player_ids: driversPushNotif_token,
              };
              //Send
              sendPushUPNotification(message);
              resolve({ response: "successfully_dispatched" });
            })
            .catch((error) => {
              logger.error(error);
              resolve(false);
            });
        });
    } //Staged send
    else {
      logger.info("Staged send");
      //...Register the drivers fp so that they can see tne requests
      let driversFp = closestDriversList.map((data) => data.driver_fingerprint); //Drivers fingerprints
      let driversPushNotif_token = closestDriversList.map(
        (data) => data.push_notification_token
      ); //Push notification token

      new Promise((res) => {
        //Answer
        logger.info(
          "[1] Closest drivers ---ticket: " + snapshotTripInfos.request_fp
        );
        new Promise((res5) => {
          registerAllowedDriversForRidesAndNotify(
            snapshotTripInfos.request_fp,
            snapshotTripInfos,
            { drivers_fp: driversFp, pushNotif_tokens: driversPushNotif_token },
            collectionRidesDeliveries_data,
            1,
            res5
          );
        }).then(
          (reslt) => {
            if (/staged_dispatch_successfull/i.test(reslt.response)) {
              //CONCLUDE THE REQUEST - Nope
              //resolve({ response: "successfully_dispatched" });
              //Proceed with the staged dispatch
              //1. Wait for 1 min 00'' - in ms
              logger.info(
                "Waiting for 35sec. ---ticket: " + snapshotTripInfos.request_fp
              );
              setTimeout(() => {
                new Promise((res2) => {
                  logger.info(
                    "[2] Less closest after 30sec. ---ticket: " +
                      snapshotTripInfos.request_fp
                  );
                  new Promise((res6) => {
                    registerAllowedDriversForRidesAndNotify(
                      snapshotTripInfos.request_fp,
                      snapshotTripInfos,
                      {
                        drivers_fp: driversFp,
                        pushNotif_tokens: driversPushNotif_token,
                      },
                      collectionRidesDeliveries_data,
                      2,
                      res6
                    );
                  }).then(
                    (reslt) => {
                      if (/staged_dispatch_successfull/i.test(reslt.response)) {
                        //Proceed with the staged dispatch
                        //Allow these drivers to see the requests athen resolve 2
                        res2(true); //Conclude promise 2
                      } //End the staged dispatch - done
                      else {
                        logger.info(
                          "DONE STAGED DISPATCH  ---ticket: " +
                            snapshotTripInfos.request_fp
                        );
                        res2({ response: "successfully_dispatched" });
                      }
                    },
                    (error) => {
                      logger.info(
                        "DONE STAGED DISPATCH  ---ticket: " +
                          snapshotTripInfos.request_fp
                      );
                      //Error - but notify dispatch as successfull
                      res2(true);
                    }
                  );
                }).then((result) => {
                  if (
                    result.response !== undefined &&
                    result.response !== null
                  ) {
                    //?Successfully dispatched
                    res(true);
                    resolve({ response: "successfully_dispatched" });
                  } //? Not yet done, continue with the dispatch
                  else {
                    //2. Wait for 30 sec
                    logger.info(
                      "Waiting for 30sec ---ticket: " +
                        snapshotTripInfos.request_fp
                    );
                    setTimeout(() => {
                      new Promise((res3) => {
                        logger.info(
                          "[3] Less*2 closest after 30sec. ---ticket: " +
                            snapshotTripInfos.request_fp
                        );
                        new Promise((res7) => {
                          registerAllowedDriversForRidesAndNotify(
                            snapshotTripInfos.request_fp,
                            snapshotTripInfos,
                            {
                              drivers_fp: driversFp,
                              pushNotif_tokens: driversPushNotif_token,
                            },
                            collectionRidesDeliveries_data,
                            3,
                            res7
                          );
                        }).then(
                          (reslt) => {
                            if (
                              /staged_dispatch_successfull/i.test(
                                reslt.response
                              )
                            ) {
                              //Proceed with the staged dispatch
                              //Allow these drivers to see the requests athen resolve 3
                              res3(true); //Conclude promise 3
                            } //End the staged dispatch - done
                            else {
                              logger.info(
                                "DONE STAGED DISPATCH  ---ticket: " +
                                  snapshotTripInfos.request_fp
                              );
                              res3({ response: "successfully_dispatched" });
                            }
                          },
                          (error) => {
                            logger.info(
                              "DONE STAGED DISPATCH  ---ticket: " +
                                snapshotTripInfos.request_fp
                            );
                            //Error - but notify dispatch as successfull
                            res3(false);
                          }
                        );
                      }).then((result) => {
                        if (
                          result.response !== undefined &&
                          result.response !== null
                        ) {
                          //?Successfully dispatched
                          res(true);
                          resolve({ response: "successfully_dispatched" });
                        } //Continue with the staged process
                        else {
                          //3. Wait for 1 min
                          logger.info(
                            "Waiting for 30sec ---ticket: " +
                              snapshotTripInfos.request_fp
                          );
                          setTimeout(() => {
                            new Promise((res4) => {
                              logger.info(
                                "[4] Less*3 closest after 30sec. ---ticket: " +
                                  snapshotTripInfos.request_fp
                              );
                              new Promise((res8) => {
                                registerAllowedDriversForRidesAndNotify(
                                  snapshotTripInfos.request_fp,
                                  snapshotTripInfos,
                                  {
                                    drivers_fp: driversFp,
                                    pushNotif_tokens: driversPushNotif_token,
                                  },
                                  collectionRidesDeliveries_data,
                                  4,
                                  res8
                                );
                              }).then(
                                (reslt) => {
                                  if (
                                    /staged_dispatch_successfull/i.test(
                                      reslt.response
                                    )
                                  ) {
                                    //Proceed with the staged dispatch
                                    //Allow these drivers to see the requests athen resolve 4
                                    res4(true); //Conclude promise 4
                                  } //End the staged dispatch - done
                                  else {
                                    logger.info(
                                      "DONE STAGED DISPATCH  ---ticket: " +
                                        snapshotTripInfos.request_fp
                                    );
                                    res4({
                                      response: "successfully_dispatched",
                                    });
                                  }
                                },
                                (error) => {
                                  logger.info(
                                    "DONE STAGED DISPATCH  ---ticket: " +
                                      snapshotTripInfos.request_fp
                                  );
                                  //Error - but notify dispatch as successfull
                                  res4(false);
                                }
                              );
                            })
                              .then()
                              .finally(() => {
                                logger.info(
                                  "DONE STAGED DISPATCH  ---ticket: " +
                                    snapshotTripInfos.request_fp
                                );
                                //Done FULL STAGED DISPATCH!
                                resolve({
                                  response: "successfully_dispatched",
                                });
                              });
                          }, 1 * 30 * 1000);
                        }
                      });
                    }, 1 * 30 * 1000);
                  }
                });
              }, 35 * 1000);
            } //End the staged dispatch - done
            else {
              resolve({ response: "successfully_dispatched" });
            }
          },
          (error) => {
            //Error - but notify dispatch as successfull
            resolve({ response: "successfully_dispatched" });
          }
        );
      });
    }
  }
}

/**
 * @func registerAllowedDriversForRidesAndNotify
 * @param resolve
 * @param collectionRidesDeliveries_data: rides and deliveries collection
 * @param driversSnap: 2 lists, one of drivers fingerprints(drivers_fp), the other for their push notification tokens(pushNotif_tokens).
 * @param request_fp: request's fingerprint
 * @param snapshotTripInfos: brief trip infos
 * @param incrementalStage: number indicating which driver circle to dispatch to (from 1->4) - default:1 (closest drivers)
 * Responsible for adding drivers to the list of those who can see the requests
 * and send out push notification after.
 * Also CHECK IF THE REQUEST WAS ALREADY ACCEPTED, if so end the staged dispatch process.
 * Also CHECK IF THE NUMBER OF CLOSEST DRIVERS ALLOW the incremental stage numer.
 */
function registerAllowedDriversForRidesAndNotify(
  request_fp,
  snapshotTripInfos,
  driversSnap,
  collectionRidesDeliveries_data,
  incrementalStage = 1,
  resolve
) {
  //? Fit back to boundary.limit max
  if (incrementalStage > 4) {
    incrementalStage = 4;
  }
  //Staged boundaries
  let stagedBoundaries = {
    1: { start: 0, end: 1 },
    2: { start: 1, end: 6 },
    3: { start: 4, end: 11 },
    4: { start: 9, end: false },
  };
  let originalAllDrivers_fp = driversSnap.drivers_fp;
  //Slice the drivers fp and push notif tokens to be within the boundaries
  driversSnap.drivers_fp = driversSnap.drivers_fp.slice(
    stagedBoundaries[incrementalStage].start,
    stagedBoundaries[incrementalStage].end === false
      ? driversSnap.drivers_fp.length
      : stagedBoundaries[incrementalStage].end
  );
  driversSnap.pushNotif_tokens = driversSnap.pushNotif_tokens.slice(
    stagedBoundaries[incrementalStage].start,
    stagedBoundaries[incrementalStage].end === false
      ? driversSnap.pushNotif_tokens.length
      : stagedBoundaries[incrementalStage].end
  );

  logger.warn(stagedBoundaries[incrementalStage]);
  logger.warn(
    "List of drivers cherry picked for the staged dispatch in progress"
  );
  logger.warn(driversSnap.drivers_fp);

  //Check whether the request was accepted or not.
  let checkAcceptance = {
    "ride_state_vars.isAccepted": false,
    request_fp: request_fp,
  }; //?Indexed

  dynamo_find_query({
    table_name: "rides_deliveries_requests",
    IndexName: "request_fp",
    KeyConditionExpression: "request_fp = :val1, #r.#i = :val2",
    ExpressionAttributeValues: {
      ":val1": checkAcceptance.request_fp,
      ":val2": false,
    },
    ExpressionAttributeNames: {
      "#r": "ride_state_vars",
      "#i": "isAccepted",
    },
  })
    .then((requestInfos) => {
      if (
        requestInfos !== null &&
        requestInfos !== undefined &&
        requestInfos.length > 0 &&
        driversSnap.drivers_fp.length > 0
      ) {
        //Not yet accepted
        requestInfos = requestInfos[0];
        //...
        new Promise((resComputeNotif) => {
          //Send notifications to the newly registered drivers to the allowed_drivers_see
          //Send the push notifications
          let message = {
            app_id: process.env.DRIVERS_APP_ID_ONESIGNAL,
            android_channel_id: /RIDE/i.test(snapshotTripInfos.ride_type)
              ? process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION
              : process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION, //Ride or delivery channel
            priority: 10,
            contents: /RIDE/i.test(snapshotTripInfos.ride_type)
              ? {
                  en:
                    "You have a new ride request " +
                    (snapshotTripInfos.pickup_suburb !== false
                      ? "from " + snapshotTripInfos.pickup_suburb !== undefined
                        ? snapshotTripInfos.pickup_suburb !== undefined &&
                          snapshotTripInfos.pickup_suburb !== false &&
                          snapshotTripInfos.pickup_suburb !== null
                          ? snapshotTripInfos.pickup_suburb.toUpperCase()
                          : "near your location"
                        : "near your location" +
                            " to " +
                            snapshotTripInfos.pickup_suburb !==
                          undefined
                        ? snapshotTripInfos.pickup_suburb !== undefined &&
                          snapshotTripInfos.pickup_suburb !== false &&
                          snapshotTripInfos.pickup_suburb !== null
                          ? snapshotTripInfos.pickup_suburb.toUpperCase()
                          : "near your location"
                        : "near your location" +
                          ". Click here for more details."
                      : "near your location, click here for more details."),
                }
              : {
                  en:
                    "You have a new delivery request " +
                    (snapshotTripInfos.pickup_suburb !== false
                      ? "from " + snapshotTripInfos.pickup_suburb !== undefined
                        ? snapshotTripInfos.pickup_suburb !== undefined &&
                          snapshotTripInfos.pickup_suburb !== false &&
                          snapshotTripInfos.pickup_suburb !== null
                          ? snapshotTripInfos.pickup_suburb.toUpperCase()
                          : "near your location"
                        : "near your location" +
                            " to " +
                            snapshotTripInfos.pickup_suburb !==
                          undefined
                        ? snapshotTripInfos.pickup_suburb !== undefined &&
                          snapshotTripInfos.pickup_suburb !== false &&
                          snapshotTripInfos.pickup_suburb !== null
                          ? snapshotTripInfos.pickup_suburb.toUpperCase()
                          : "near your location"
                        : "near your location" +
                          ". Click here for more details."
                      : "near your location, click here for more details."),
                },
            headings: /RIDE/i.test(snapshotTripInfos.ride_type)
              ? { en: "New ride request, N$" + snapshotTripInfos.fare }
              : { en: "New delivery request, N$" + snapshotTripInfos.fare },
            content_available: true,
            include_player_ids: driversSnap.pushNotif_tokens,
          };
          //logger.info(message);
          //Send
          sendPushUPNotification(message);
          //...
          resComputeNotif(true);
        })
          .then(() => {})
          .catch(() => {});
        //Add the drivers' fingerprints to the allowed_drivers_see
        let updatedAllowedSee = {
          $set: {
            allowed_drivers_see: [
              ...new Set([
                ...requestInfos.allowed_drivers_see,
                ...driversSnap.drivers_fp,
              ]),
            ],
          },
        };

        dynamo_update(
          "rides_deliveries_requests",
          {
            request_fp: request_fp,
            "ride_state_vars.isAccepted": false,
          },
          "set allowed_drivers_see = :val1",
          {
            ":val1": updatedAllowedSee,
          }
        )
          .then((result) => {
            if (result === false) {
              resolve({ response: "staged_dispatch_successfull" });
            }
            //logger.info(err);
            resolve({ response: "staged_dispatch_successfull" });
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "staged_dispatch_successfull" });
          });
      } //Request already accepted
      else {
        //! Give access to all the qualified drivers
        let checkAcceptance = {
          "ride_state_vars.isRideCompleted_driverSide": false,
          request_fp: request_fp,
        }; //?Indexed
        dynamo_find_query({
          table_name: "rides_deliveries_requests",
          IndexName: "request_fp",
          KeyConditionExpression: "request_fp = :val1, #r.#i = :val2",
          ExpressionAttributeValues: {
            ":val1": checkAcceptance.request_fp,
            ":val2": false,
          },
          ExpressionAttributeNames: {
            "#r": "ride_state_vars",
            "#i": "isRideCompleted_driverSide",
          },
        })
          .then((requestInfos) => {
            if (requestInfos.length > 0 && driversSnap.drivers_fp.length > 0) {
              //Not yet accepted
              requestInfos = requestInfos[0];
              //...
              //Add the drivers' fingerprints to the allowed_drivers_see
              let updatedAllowedSee = {
                $set: {
                  allowed_drivers_see: [
                    ...new Set([
                      ...requestInfos.allowed_drivers_see,
                      ...originalAllDrivers_fp,
                    ]),
                  ],
                },
              };

              //      "ride_state_vars.isRideCompleted_driverSide": false,
              // request_fp: request_fp,
              dynamo_update(
                "rides_deliveries_requests",
                requestInfos._id,
                "set allowed_drivers_see = :val1",
                {
                  ":val1": [
                    ...new Set([
                      ...requestInfos.allowed_drivers_see,
                      ...originalAllDrivers_fp,
                    ]),
                  ],
                }
              )
                .then((result) => {
                  resolve({ response: "request_already_accepted" });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "request_already_accepted" });
                });
            } //Already completed
            else {
              resolve({ response: "request_already_accepted" });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "staged_dispatch_successfull" });
          });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: "staged_dispatch_successfull" });
    });
}

/**
 * @func confirmDropoff_fromRider_side
 * @param resolve
 * @param dropOffMeta_bundle: contains all the necessary information about the rating (rating_score, compliments array, personal note AND REQUEST FINGERPRINT)
 * @param collectionRidesDeliveries_data: rides and deliveries collection
 * @param collectionDrivers_profiles: the list of all the drivers.
 * Responsible for confirming the drop off of a ride EXCLUSIVELY for the riders.
 * Tasks:
 * 1. Mark as arrived to destination.
 * 2. Mark as confirmed from the rider side
 * 3. Assign the rating
 * 4. Assign compliments (if any)
 * 5. Assign custom note (if any)
 * ! Reinforce all drop off vars in case
 */
function confirmDropoff_fromRider_side(
  dropOffMeta_bundle,
  collectionRidesDeliveries_data,
  collectionDrivers_profiles,
  resolve
) {
  resolveDate();

  let retrieveTrip = {
    client_id: dropOffMeta_bundle.user_fingerprint,
    request_fp: dropOffMeta_bundle.request_fp,
  };
  //Updatedd data
  let dropOffDataUpdate = {
    $set: {
      isArrivedToDestination: true,
      date_dropoff: new Date(chaineDateUTC),
      ride_state_vars: {
        isAccepted: true,
        inRideToDestination: true,
        isRideCompleted_driverSide: true,
        isRideCompleted_riderSide: true,
        rider_driverRating: dropOffMeta_bundle.rating_score,
        rating_compliment: dropOffMeta_bundle.dropoff_compliments,
        rating_personal_note: dropOffMeta_bundle.dropoff_personal_note,
      },
    },
  };
  //..
  dynamo_update(
    "rides_deliveries_requests",
    {
      request_fp: dropOffMeta_bundle.request_fp,
    },
    "set isArrivedToDestination = :val1, date_dropoff = :val2, ride_state_vars = :val3",
    {
      ":val1": true,
      ":val2": new Date(chaineDateUTC).toISOString(),
      ":val3": {
        isAccepted: true,
        inRideToDestination: true,
        isRideCompleted_driverSide: true,
        isRideCompleted_riderSide: true,
        rider_driverRating: dropOffMeta_bundle.rating_score,
        rating_compliment: dropOffMeta_bundle.dropoff_compliments,
        rating_personal_note: dropOffMeta_bundle.dropoff_personal_note,
      },
    }
  )
    .then((result) => {
      if (result === false) {
        resolve({ response: "error" });
      }
      //...
      collectionRidesDeliveries_data
        .find(retrieveTrip)
        .toArray(function (err, result) {
          if (err) {
            resolve({ response: "successfully_confirmed" });
          }
          //...
          if (result !== undefined && result.length > 0) {
            result = result[0];
            //? Send the drop off receipt for corporate deliveries
            new Promise((resSendReceipt) => {
              let dataBundle = {
                amount: result.fare,
                user_fp: result.client_id,
                tripHistory: result,
              };
              sendReceipt(dataBundle, "dropoffReceipt", resSendReceipt);
            })
              .then()
              .catch((error) => logger.error(error));
            //?...

            resolve({
              response: "successfully_confirmed",
              driver_fp: result.taxi_id,
            });
          } else {
            resolve({ response: "successfully_confirmed" });
          }
        });
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: "error" });
    });
}

/**
 * @func sendReceipt
 * Responsible for sending receipts for delivery web requests.
 * @param metaDataBundle: the drop off meta data
 * @param scenarioType: dropoffReceipt or packagePurchaseReceipt
 * @param resolve
 */
function sendReceipt(metaDataBundle, scenarioType, resolve) {
  if (/dropoffReceipt/i.test(scenarioType)) {
    //Drop off receipt confirmation
    let dpo_gateway_deduction_fees =
      (parseFloat(metaDataBundle.amount) *
        process.env.DPO_GATEWAY_CHARGES_PERCENTAGE) /
      100;
    let taxiconnect_service_fees =
      (parseFloat(metaDataBundle.amount) *
        process.env.TAXICONNECT_WALLET_TOPUP_SERVICE_FEES) /
      100;
    let amountRecomputed =
      parseFloat(metaDataBundle.amount) -
      dpo_gateway_deduction_fees -
      taxiconnect_service_fees; //! VERY IMPORTANT - REMOVE DPO AND TAXICONNECT DEDUCTIONS
    //...
    //Get the company data
    collectionDedicatedServices_accounts
      .find({
        company_fp: metaDataBundle.user_fp,
      })
      .toArray(function (err, companyData) {
        if (err) {
          logger.error(err);
          resolve(false);
        }
        logger.info(companyData);
        //...
        if (companyData !== undefined && companyData.length > 0) {
          companyData = companyData[0];
          /// Get the general pickup data
          let pickup_location_name =
            metaDataBundle.tripHistory.pickup_location_infos.location_name !==
              undefined &&
            metaDataBundle.tripHistory.pickup_location_infos.location_name !==
              false
              ? metaDataBundle.tripHistory.pickup_location_infos.location_name
              : metaDataBundle.tripHistory.pickup_location_infos.street_name;

          let pickup_street_name =
            metaDataBundle.tripHistory.pickup_location_infos.street_name;
          //...
          let pickup_suburb =
            metaDataBundle.tripHistory.pickup_location_infos.suburb;
          //....

          let receiptFp = Math.round(new Date(chaineDateUTC).getTime())
            .toString()
            .substring(0, 7);
          //Found the company
          //? Generate a receipt fingerprint
          new Promise((resGenerateFp) => {
            generateUniqueFingerprint(
              `${metaDataBundle.user_fp}-${new Date(chaineDateUTC).getTime()}`,
              "md5",
              resGenerateFp
            );
          })
            .then((result) => {
              receiptFp = result.toString().toUpperCase().substring(0, 7);
            })
            .catch((error) => {
              logger.error(error);
              //...
            })
            .finally(() => {
              let emailTemplate = `
                <!doctype html>
                <html>

                <head>
                  <meta charset="utf-8">
                  <meta http-equiv="x-ua-compatible" content="ie=edge">
                  <title></title>
                  <meta name="description" content="">
                  <meta name="viewport" content="width=device-width, initial-scale=1">


                  <style type="text/css">
                    a {
                      color: #0000ee;
                      text-decoration: underline;
                    }
                    
                    a:hover {
                      color: #0000ee;
                      text-decoration: underline;
                    }
                    
                    .u-row {
                      display: flex;
                      flex-wrap: nowrap;
                      margin-left: 0;
                      margin-right: 0;
                    }
                    
                    .u-row .u-col {
                      position: relative;
                      width: 100%;
                      padding-right: 0;
                      padding-left: 0;
                    }
                    
                    .u-row .u-col.u-col-100 {
                      flex: 0 0 100%;
                      max-width: 100%;
                    }
                    
                    @media (max-width: 767px) {
                      .u-row:not(.no-stack) {
                        flex-wrap: wrap;
                      }
                      .u-row:not(.no-stack) .u-col {
                        flex: 0 0 100% !important;
                        max-width: 100% !important;
                      }
                    }
                    
                    body,
                    html {
                      padding: 0;
                      margin: 0;background-color:#fff;
                    }
                    
                    html {
                      box-sizing: border-box
                    }
                    
                    *,
                    :after,
                    :before {
                      box-sizing: inherit
                    }
                    
                    html {
                      font-size: 14px;
                      -ms-overflow-style: scrollbar;
                      -webkit-tap-highlight-color: rgba(0, 0, 0, 0)
                    }
                    
                    body {
                      font-family: Arial, Helvetica, sans-serif;
                      font-size: 1rem;
                      line-height: 1.5;
                      color: #373a3c;
                      background-color: #fff
                    }
                    
                    p {
                      margin: 0
                    }
                    
                    .error-field {
                      -webkit-animation-name: shake;
                      animation-name: shake;
                      -webkit-animation-duration: 1s;
                      animation-duration: 1s;
                      -webkit-animation-fill-mode: both;
                      animation-fill-mode: both
                    }
                    
                    .error-field input,
                    .error-field textarea {
                      border-color: #a94442!important;
                      color: #a94442!important
                    }
                    
                    .field-error {
                      padding: 5px 10px;
                      font-size: 14px;
                      font-weight: 700;
                      position: absolute;
                      top: -20px;
                      right: 10px
                    }
                    
                    .field-error:after {
                      top: 100%;
                      left: 50%;
                      border: solid transparent;
                      content: " ";
                      height: 0;
                      width: 0;
                      position: absolute;
                      pointer-events: none;
                      border-color: rgba(136, 183, 213, 0);
                      border-top-color: #ebcccc;
                      border-width: 5px;
                      margin-left: -5px
                    }
                    
                    .spinner {
                      margin: 0 auto;
                      width: 70px;
                      text-align: center
                    }
                    
                    .spinner>div {
                      width: 12px;
                      height: 12px;
                      background-color: hsla(0, 0%, 100%, .5);
                      margin: 0 2px;
                      border-radius: 100%;
                      display: inline-block;
                      -webkit-animation: sk-bouncedelay 1.4s infinite ease-in-out both;
                      animation: sk-bouncedelay 1.4s infinite ease-in-out both
                    }
                    
                    .spinner .bounce1 {
                      -webkit-animation-delay: -.32s;
                      animation-delay: -.32s
                    }
                    
                    .spinner .bounce2 {
                      -webkit-animation-delay: -.16s;
                      animation-delay: -.16s
                    }
                    
                    @-webkit-keyframes sk-bouncedelay {
                      0%,
                      80%,
                      to {
                        -webkit-transform: scale(0)
                      }
                      40% {
                        -webkit-transform: scale(1)
                      }
                    }
                    
                    @keyframes sk-bouncedelay {
                      0%,
                      80%,
                      to {
                        -webkit-transform: scale(0);
                        transform: scale(0)
                      }
                      40% {
                        -webkit-transform: scale(1);
                        transform: scale(1)
                      }
                    }
                    
                    @-webkit-keyframes shake {
                      0%,
                      to {
                        -webkit-transform: translateZ(0);
                        transform: translateZ(0)
                      }
                      10%,
                      30%,
                      50%,
                      70%,
                      90% {
                        -webkit-transform: translate3d(-10px, 0, 0);
                        transform: translate3d(-10px, 0, 0)
                      }
                      20%,
                      40%,
                      60%,
                      80% {
                        -webkit-transform: translate3d(10px, 0, 0);
                        transform: translate3d(10px, 0, 0)
                      }
                    }
                    
                    @keyframes shake {
                      0%,
                      to {
                        -webkit-transform: translateZ(0);
                        transform: translateZ(0)
                      }
                      10%,
                      30%,
                      50%,
                      70%,
                      90% {
                        -webkit-transform: translate3d(-10px, 0, 0);
                        transform: translate3d(-10px, 0, 0)
                      }
                      20%,
                      40%,
                      60%,
                      80% {
                        -webkit-transform: translate3d(10px, 0, 0);
                        transform: translate3d(10px, 0, 0)
                      }
                    }
                    
                    @media only screen and (max-width:480px) {
                      .container {
                        max-width: 100%!important
                      }
                    }
                    
                    .container {
                      width: 100%;
                      padding-right: 0;
                      padding-left: 0;
                      margin-right: auto;
                      margin-left: auto
                    }
                    
                    @media (min-width:576px) {
                      .container {
                        max-width: 540px
                      }
                    }
                    
                    @media (min-width:768px) {
                      .container {
                        max-width: 720px
                      }
                    }
                    
                    @media (min-width:992px) {
                      .container {
                        max-width: 960px
                      }
                    }
                    
                    @media (min-width:1200px) {
                      .container {
                        max-width: 1140px
                      }
                    }
                    
                    a[onclick] {
                      cursor: pointer;
                    }
                  </style>


                </head>

                <body style="background-color:#fff;">

                  <div id="u_body" class="u_body" style="min-height: 100vh; color: #000000; background-color: #fff; font-family: arial,helvetica,sans-serif;">

                    <div id="u_row_1" class="u_row" style="padding: 0px;">
                      <div class="container" style="max-width: 700px;margin: 0 auto;">
                        <div class="u-row">

                          <div id="u_column_1" class="u-col u-col-100 u_column">
                            <div style="padding: 0px;border-top: 0px solid transparent;border-left: 0px solid transparent;border-right: 0px solid transparent;border-bottom: 0px solid transparent;">

                              <div id="u_content_html_1" class="u_content_html" style="overflow-wrap: break-word;padding: 10px;">
                              <div class="u-col u_column style="display: flex;flex-direction: column;align-items: flex-start;justify-content: center;padding:20px;padding-left:5%;padding-right:5%;font-family:Arial, Helvetica, sans-serif;font-size: 15px;flex:1">
                              <div style="width: 100px;height:100px;bottom:20px;position: relative;margin:auto">
                                  <img alt="TaxiConnect" src="https://ads-central-tc.s3.us-west-1.amazonaws.com/logo_ios.png" style="width: 100%;height: 100%;object-fit: contain;" />
                              </div>
                              <div style="border-bottom:1px solid #d0d0d0;display: flex;flex-direction: row;justify-content: space-between;margin-bottom: 15px;width: 100%;">
                                  <div style="display: flex;flex-direction: row;">
                                      <div style="margin-left: 2%;">
                                          <div style="font-weight: bold;font-size: 17px;">Posterity TaxiConnect Technologies CC</div>
                                          <div style="font-size: 14px;margin-top: 5px;color:#272626bb">
                                          <div>17 Schinz street</div>
                                          <div>Windhoek</div>
                                          <div>+264814400089</div>
                                          <div>support@taxiconnectna.com</div>
                                          </div>
                                      </div>
                                  </div>
                                  <div style="text-align: right;width:100%">
                                      <div style="margin-bottom: 13px;">
                                          <div style="font-weight: bold;font-size: 11px;">RECEIPT</div>
                                          <div style="font-size: 14px;color:#272626bb;margin-top: 4px;">${receiptFp}</div>
                                      </div>
                                      <div style="margin-bottom: 13px;">
                                          <div style="font-weight: bold;font-size: 11px;">DATE</div>
                                          <div style="font-size: 14px;color:#272626bb;margin-top: 4px;">${
                                            new Date(chaineDateUTC)
                                              .toDateString()
                                              .split(" ")[1]
                                          } ${new Date(
                chaineDateUTC
              ).getDate()}, ${new Date(chaineDateUTC).getFullYear()}</div>
                                      </div>
                                      <div style="margin-bottom: 25px;min-width: 100px;">
                                          <div style="font-weight: bold;font-size: 11px;">BALANCE DUE</div>
                                          <div style="font-size: 14px;color:#272626bb;margin-top: 4px;">NAD $${parseFloat(
                                            metaDataBundle.amount
                                          ).toFixed(2)}</div>
                                      </div>
                                  </div>
                              </div>
                          
                              <div style="border:1px solid #fff;margin-top: 10px;width:100%">
                                  <div  style="font-size: 11px;margin-top: 5px;color:#272626bb">BILL TO</div>
                                  <div  style="font-weight: bold;font-size: 17px;margin-top: 10px;margin-bottom: 20px;">${companyData.company_name.toUpperCase()}</div>
                                  <div style="font-size: 14px;margin-top: 5px;color:#272626bb;line-height: 20px;">
                                      <div>Windhoek</div>
                                      <div>${companyData.phone}</div>
                                      </div>
                              </div>
                          
                              <div style="border-top:1px solid #272626bb;border-bottom:1px solid #272626bb; display: flex;flex-direction: row;color:#000;padding-bottom: 10px;padding-top:10px;margin-top: 40px;width:100%">
                                  <div style="flex:1;align-items: flex-end;font-weight: bold;font-size: 12px;width:50%;">DESCRIPTION</div>
                                  <div style="display: flex;flex-direction: row;text-align: right;font-size: 12px;font-weight: bold;flex:1;justify-content: space-between;width:50%">
                                      <div style="flex:1;width:33%;">RATE</div>
                                      <div style="flex:1;width:33%">QTY</div>
                                      <div style="flex:1;width:33%">AMOUNT</div>
                                  </div>
                              </div>


                              ${metaDataBundle.tripHistory.destinationData
                                .map((destination, index) => {
                                  let dest_location_name =
                                    destination.location_name !== undefined &&
                                    destination.location_name !== false
                                      ? destination.location_name
                                      : destination.street_name;

                                  let dest_street_name =
                                    destination.street_name;
                                  //...
                                  let dest_suburb = destination.suburb;
                                  let singlePrice =
                                    /Elisenheim/i.test(pickup_suburb) ||
                                    /Elisenheim/i.test(dest_suburb)
                                      ? 70
                                      : 50;

                                  return `<div style="border-bottom:1px dashed #272626bb; display: flex;flex-direction: row;color:#000;padding-bottom: 10px;padding-top:10px;margin-top: 10px;width:100%">
                                      <div style="flex:1;width:50%;">
                                      <div style="align-items: flex-end;font-weight: bold;font-size: 15px;margin-bottom: 5px;">Delivery</div>
                                      <div style="color: #272626bb;font-size: 13px;">
                                        Pickup: ${pickup_location_name}, ${pickup_suburb}<br />
                                        Drop off: ${dest_location_name}, ${dest_suburb}
                                      </div>
                                      </div>
                                      <div style="display: flex;flex-direction: row;text-align: right;font-size: 14px;color:#272626bb;flex:1;justify-content: space-between;width:50%">
                                          <div style="flex:1;width:33%;">$${parseFloat(
                                            singlePrice
                                          ).toFixed(2)}</div>
                                          <div style="flex:1;width:33%;">1</div>
                                          <div style="flex:1;width:33%;">$${parseFloat(
                                            singlePrice
                                          ).toFixed(2)}</div>
                                      </div>
                                    </div>`;
                                })
                                .toString()
                                .replace(/,/g, "")}
                          
                              <div style="display: flex;flex-direction: row;justify-content: space-between;margin-top: 30px;align-items: center;width:100%">
                                  <div style="flex:1;color:#272626bb;font-size: 12px;padding-right: 30px;min-width:150px;">Thank you for choosing TaxiConnect for all your business delivery needs.</div>
                                  
                                  <di class="u-col u_column" style="flex:2;display:flex;flex-direction:column;width:70%;">
                                    <table style="width:100%;">
                                        <tr>
                                            <div style="display:flex;flex-direction:row;justify-content: space-between;align-items: center;margin-bottom: 5px;width:100%;">
                                                <div style="font-weight: bold;font-size:11px;width:50%;position:relative;top:5px;text-align:left;">SUBTOTAL</div>
                                                <div style="font-size: 14px;color:#272626bb;width:50%;text-align:right;position:relative;bottom:3px">$${parseFloat(
                                                  metaDataBundle.amount
                                                ).toFixed(2)}</div>
                                            </div>
                                        </tr>
                                        <tr>
                                            <div style="border-bottom:1px solid #d0d0d0;padding-bottom:10px;display:flex;flex-direction:row;justify-content: space-between;align-items: center;margin-bottom: 10px;">
                                                <div style="font-weight: bold;font-size:11px;width:50%;position:relative;top:5px">SERVICE FEE (4%)</div>
                                                <div style="font-size: 14px;color:#272626bb;width:50%;text-align:right;position:relative;bottom:3px">$${(
                                                  parseFloat(
                                                    metaDataBundle.amount
                                                  ) * 0.04
                                                ).toFixed(2)}</div>
                                            </div>
                                        </tr>
                                        <tr>
                                            <div style="border-bottom:1px solid #d0d0d0;padding-bottom:10px;display:flex;flex-direction:row;justify-content: space-between;align-items: center;margin-bottom: 15px;">
                                                <div style="font-weight: bold;font-size:11px;width:50%;position:relative;top:5px">TOTAL</div>
                                                <div style="font-size: 14px;color:#272626bb;width:50%;text-align:right;position:relative;bottom:3px">$${parseFloat(
                                                  metaDataBundle.amount
                                                ).toFixed(2)}</div>
                                            </div>
                                        </tr>
                                        <tr>
                                            <div style="border-bottom:1px solid #d0d0d0;padding-bottom:10px;display:flex;flex-direction:row;justify-content: space-between;align-items: center;margin-bottom: 5px;">
                                                <div style="font-weight: bold;font-size:12px;flex:1;width:50%;position:relative;top:5px">BALANCE PAID</div>
                                                <div style="font-size: 15px;color:#272626bb;font-weight: bold;width:50%;text-align:right;position:relative;bottom:3px">NAD $${parseFloat(
                                                  metaDataBundle.amount
                                                ).toFixed(2)}</div>
                                            </div>
                                        </tr>
                                    </table>
                                  </div>
                              </div>
                          </div>
                              </div>

                            </div>
                          </div>

                        </div>
                      </div>
                    </div>

                  </div>

                </body>

                </html>
              `;

              //? Save the email dispatch event
              new Promise((saveEvent) => {
                let eventBundle = {
                  event_name: "Delivery_trip_email_receipt_dipstach",
                  user_fingerprint: metaDataBundle.user_fp,
                  user_nature: "rider",
                  city: "Windhoek",
                  receipt_fp: receiptFp,
                  email_data: emailTemplate,
                  date: new Date(chaineDateUTC),
                };
                //...
                dynamo_insert("global_events", eventBundle)
                  .then((result) => {
                    saveEvent(result);
                  })
                  .catch((error) => {
                    logger.error(error);
                    saveEvent(false);
                  });
              })
                .then()
                .catch((error) => logger.error(error));

              //? Send email
              let info = transporterNoReplay.sendMail({
                from: process.env.NOREPLY_EMAIL, // sender address
                to: companyData.email, // list of receivers
                subject: `Delivery receipt (${receiptFp})`, // Subject line
                html: emailTemplate,
              });

              //?DONE
              logger.info(`Sending receipt email...to ${companyData.email}`);
              logger.info(info.messageId);
              resolve(true);
            });
        } //Unknown company
        else {
          resolve(false);
        }
      });
  } else {
    resolve(false);
  }
}

/**
 * @func cancelRider_request
 * @param resolve
 * @param collectionRidesDeliveries_data: list of all the rides/delivery requests
 * @param collection_cancelledRidesDeliveryData: list of all the cancelledd rides/delivery requests.
 * @param collectionDrivers_profiles: list of all the drivers
 * @param requestBundle_data: object containing the request fp and the rider's fp
 * @param additionalData: contains additional data like the flag and so on.
 * Responsible for cancelling requests for riders and all the related processes.
 */
function cancelRider_request(
  requestBundle_data,
  collectionRidesDeliveries_data,
  collection_cancelledRidesDeliveryData,
  collectionDrivers_profiles,
  resolve,
  additionalData
) {
  resolveDate();
  //Get the request first, if empty - error (very strange), if got something - migrate to the cancelled collection
  //AND delete from the active requests collection.
  let checkRequest = {
    client_id: requestBundle_data.user_fingerprint,
    request_fp: requestBundle_data.request_fp,
  };
  //Get data
  collectionRidesDeliveries_data
    .find(checkRequest)
    .toArray(function (err, requestData) {
      if (err) {
        resolve({ response: "error_cancelling" });
      }
      //...
      if (requestData.length > 0) {
        let driver_fp = requestData[0].taxi_id; //If any
        let pickup_suburb = requestData[0].pickup_location_infos.suburb;
        let destination_suburb = requestData[0].destinationData[0].suburb;
        //Found something
        //Add the cancelling reason
        requestData[0]["rider_cancellation_reason"] = requestBundle_data.reason;
        //Add the deleted date
        requestData[0].date_deleted = new Date(chaineDateUTC);
        //Add any additional data
        requestData[0].additionalData = additionalData;
        //Save in the cancelled collection
        dynamo_insert("cancelled_rides_deliveries_requests", requestData[0])
          .then((result) => {
            if (result === false) {
              resolve({ response: "error_cancelling" });
            }
            //...
            //Remove from the active collection!!!!
            dynamo_delete("rides_deliveries_requests", requestData[0]._id)
              .then((result) => {
                if (result === false) {
                  resolve({ response: "error_cancelling" });
                }
                //? Notify the driver if any is linked to this request
                //Send the push notifications - FOR drivers
                new Promise((resSendNotif) => {
                  if (
                    driver_fp !== false &&
                    driver_fp !== "false" &&
                    driver_fp !== undefined &&
                    driver_fp !== null
                  ) {
                    //Has a linked driver
                    //? Get the driver's notification ID
                    //? Get the rider's details
                    collectionDrivers_profiles
                      .find({
                        driver_fingerprint: driver_fp,
                      })
                      .toArray(function (err, driverDetails) {
                        if (err) {
                          resSendNotif(false);
                        }
                        //...push_notification_token
                        if (
                          driverDetails.length > 0 &&
                          driverDetails[0].driver_fingerprint !== undefined &&
                          driverDetails[0].operational_state.pushnotif_token !==
                            null &&
                          driverDetails[0].operational_state.pushnotif_token !==
                            undefined &&
                          driverDetails[0].operational_state.pushnotif_token
                            .userId !== undefined
                        ) {
                          let message = {
                            app_id: process.env.DRIVERS_APP_ID_ONESIGNAL,
                            android_channel_id:
                              process.env
                                .DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION, //Ride or delivery channel
                            priority: 10,
                            contents: {
                              en: `Your request from ${pickup_suburb} to ${destination_suburb} has been cancelled.`,
                            },
                            headings: { en: "Request cancelled" },
                            content_available: true,
                            include_player_ids: [
                              String(
                                driverDetails[0].operational_state
                                  .pushnotif_token.userId
                              ),
                            ],
                          };
                          logger.info(message);
                          //Send
                          sendPushUPNotification(message);
                          resSendNotif(false);
                        } else {
                          resSendNotif(false);
                        }
                      });
                  }
                }).then(
                  () => {},
                  () => {}
                );
                //...DONE
                resolve({ response: "successully_cancelled" });
              })
              .catch((error) => {
                logger.error(error);
                resolve({ response: "error_cancelling" });
              });
          })
          .catch((err2) => {
            logger.error(err2);
            resolve({ response: "error_cancelling" });
          });
      } //No records found of the request - very strange -error
      else {
        resolve({ response: "error_cancelling" });
      }
    });
}

/**
 * @func declineRequest_driver
 * Responsible for declining any requests from the driver side, thus placing the corresponding driver's fingerprint
 * on the "intentional_request_decline" array making him/her unable to ever see the request again.
 * @param bundleWorkingData: contains the driver_fp and the request_fp.
 * @param resolve
 */
function declineRequest_driver(bundleWorkingData, resolve) {
  resolveDate();
  //Only decline if not yet accepted by the driver
  dynamo_find_query({
    table_name: "requests_central",
    IndexName: "shopper_id",
    KeyConditionExpression: "shopper_id = :val1",
    FilterExpression: "request_fp = :val2",
    ExpressionAttributeValues: {
      ":val1": bundleWorkingData.driver_fingerprint,
      ":val2": bundleWorkingData.request_fp,
    },
  })
    .then((result) => {
      if (result !== undefined && result.length <= 0) {
        //Wasn't accepted by this driver - proceed to the declining
        //Save the declining event
        new Promise((res) => {
          dynamo_insert("global_events", {
            event_name: "driver_declining_request",
            request_fp: bundleWorkingData.request_fp,
            driver_fingerprint: bundleWorkingData.driver_fingerprint,
            date: new Date(chaineDateUTC).toISOString(),
          })
            .then()
            .catch((error) => logger.error(error));
          //...
          res(true);
        }).then(
          () => {},
          () => {}
        );
        //...Get the request
        dynamo_find_query({
          table_name: "requests_central",
          IndexName: "request_fp",
          KeyConditionExpression: "request_fp = :val1",
          ExpressionAttributeValues: {
            ":val1": bundleWorkingData.request_fp,
          },
        })
          .then((trueRequest) => {
            if (trueRequest !== undefined && trueRequest.length > 0) {
              trueRequest = trueRequest[0];
              //Request still exists - proceed
              let oldItDeclineList =
                trueRequest.intentional_request_decline !== undefined &&
                trueRequest.intentional_request_decline !== null
                  ? trueRequest.intentional_request_decline
                  : [];
              //Update the old list
              oldItDeclineList.push(bundleWorkingData.driver_fingerprint);
              //..
              dynamo_update({
                table_name: "requests_central",
                _idKey: trueRequest._id,
                UpdateExpression: "set intentional_request_decline = :val1",
                ExpressionAttributeValues: {
                  ":val1": oldItDeclineList,
                },
              })
                .then((result) => {
                  if (result === false) {
                    resolve({ response: "unable_to_decline_request_error" });
                  }

                  //! Clear the request cached list for all the drivers in the same city
                  new Promise((resClearRedis) => {
                    clearCityDriversCacheLists({
                      city: trueRequest.locations.pickup.city,
                      requestType: trueRequest.ride_mode,
                      resolve: resClearRedis,
                    });
                  })
                    .then()
                    .catch((error) => logger.error(error));
                  //DONE
                  resolve({ response: "successfully_declined" });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "unable_to_decline_request_error" });
                });
            } //Request not existing anymore - error
            else {
              resolve({ response: "unable_to_decline_request_error_notExist" });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "unable_to_decline_request_error" });
          });
      } //Ride accepted by this driver previously - abort the declining
      else {
        resolve({ response: "unable_to_decline_request_prev_accepted" });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: "unable_to_decline_request_error" });
    });
}

/**
 * @func acceptRequest_driver
 * Responsible for accepting any request from the driver app, If and only if the request was not declined by the driver and if it's
 * not already accepted by another driver.
 * @param bundleWorkingData: contains the driver_fp and the request_fp.
 * @param resolve
 */
function acceptRequest_driver(bundleWorkingData, resolve) {
  resolveDate();
  //Only decline if not yet accepted by the driver
  dynamo_find_query({
    table_name: "requests_central",
    IndexName: "shopper_id",
    KeyConditionExpression: "shopper_id = :val1",
    FilterExpression: "request_fp = :val2",
    ExpressionAttributeValues: {
      ":val1": "false",
      ":val2": bundleWorkingData.request_fp,
    },
  })
    .then((result) => {
      //...
      if (result !== undefined && result !== null && result.length > 0) {
        let requestData = result[0];
        //Wasn't accepted by a driver yet - proceed to the accepting
        //Save the accepting event
        new Promise((res) => {
          dynamo_insert("global_events", {
            event_name: "driver_accepting_request",
            request_fp: bundleWorkingData.request_fp,
            driver_fingerprint: bundleWorkingData.driver_fingerprint,
            date: new Date(chaineDateUTC).toISOString(),
          })
            .then()
            .catch((error) => logger.error(error));
          //...
          res(true);
        }).then(
          () => {},
          () => {}
        );
        //! Get the driver's details - to fetch the car's fingerprint
        dynamo_find_query({
          table_name: "drivers_shoppers_central",
          IndexName: "driver_fingerprint",
          KeyConditionExpression: "driver_fingerprint = :val1",
          ExpressionAttributeValues: {
            ":val1": bundleWorkingData.driver_fingerprint,
          },
        })
          .then((driverData) => {
            if (
              driverData !== undefined &&
              driverData !== null &&
              driverData.length > 0
            ) {
              //Found driver's data
              //Update the true request
              // {
              //   request_fp: bundleWorkingData.request_fp,
              //   taxi_id: false,
              //   /*intentional_request_decline: {
              //     $not: bundleWorkingData.driver_fingerprint,
              //   },*/
              // }

              dynamo_update({
                table_name: "requests_central",
                _idKey: requestData._id,
                UpdateExpression:
                  "set shopper_id = :val1, #r.#i = :val2, date_accepted = :val3, car_fingerprint = :val4, #r.#inRoute = :val5",
                ExpressionAttributeValues: {
                  ":val1": bundleWorkingData.driver_fingerprint,
                  ":val2": true,
                  ":val3": new Date(chaineDateUTC).toISOString(),
                  ":val4":
                    driverData[0].operational_state.default_selected_car
                      .car_fingerprint,
                  ":val5": true,
                },
                ExpressionAttributeNames: {
                  "#r": "request_state_vars",
                  "#i": "isAccepted",
                  "#inRoute": "inRouteToPickup",
                },
              })
                .then((result) => {
                  if (result === false) {
                    //logger.info(err);
                    resolve({ response: "unable_to_accept_request_error" });
                  }
                  //Get the regional list of all the drivers online/offline
                  //?Notify the cllient
                  //Send the push notifications - FOR Passengers
                  new Promise((resSendNotif) => {
                    //? Get the rider's details
                    dynamo_find_query({
                      table_name: "users_central",
                      IndexName: "user_identifier",
                      KeyConditionExpression: "user_identifier = :val1",
                      ExpressionAttributeValues: {
                        ":val1": requestData.client_id,
                      },
                    })
                      .then((ridersDetails) => {
                        if (
                          ridersDetails.length > 0 &&
                          ridersDetails[0].user_fingerprint !== undefined &&
                          ridersDetails[0].pushnotif_token !== null &&
                          ridersDetails[0].pushnotif_token !== undefined &&
                          ridersDetails[0].pushnotif_token.userId !== undefined
                        ) {
                          let message = {
                            app_id: process.env.ONESIGNAL_RIDERS_APP_ID,
                            // android_channel_id:
                            //   process.env
                            //     .RIDERS_ONESIGNAL_CHANNEL_ACCEPTTEDD_REQUEST, //Ride or delivery channel
                            priority: 10,
                            contents: {
                              en: "We've found a driver for you. click here for more.",
                            },
                            headings: { en: "Request accepted" },
                            content_available: true,
                            include_player_ids: [
                              String(ridersDetails[0].pushnotif_token.userId),
                            ],
                          };
                          //Send
                          sendPushUPNotification(message);
                          resSendNotif(false);
                        } else {
                          resSendNotif(false);
                        }
                      })
                      .catch((error) => {
                        logger.error(error);
                        resSendNotif(false);
                      });
                  }).then(
                    () => {},
                    () => {}
                  );

                  //! Clear the request cached list for all the drivers in the same city
                  new Promise((resClearRedis) => {
                    clearCityDriversCacheLists({
                      city: requestData.locations.pickup.city,
                      requestType: requestData.ride_mode,
                      resolve: resClearRedis,
                    });
                  })
                    .then()
                    .catch((error) => logger.error(error));

                  //DONE
                  resolve({
                    response: "successfully_accepted",
                    rider_fp: requestData.client_id,
                  });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "unable_to_accept_request_error" });
                });
            } //?Very strange, could not find the driver's information
            else {
              resolve({ response: "unable_to_accept_request_error" });
            }
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "unable_to_accept_request_error" });
          });
      } //abort the accepting
      else {
        resolve({ response: "unable_to_accept_request_already_taken" });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: "unable_to_accept_request_error" });
    });
}

/**
 * @func clearCityDriversCacheLists
 * Responsible for clearing the requests list for all the drivers in the city to update it
 * to the current state based on a driver performing alterations to a specific request.
 * @param city: the city in which the operation should me performed.
 * @param requestType: RIDE, DELIVERY or SHOPPING
 * @param resolve
 */
function clearCityDriversCacheLists({ city = false, requestType, resolve }) {
  if (city !== false) {
    //? 1 . Get all the drivers from the city
    dynamo_get_all({
      table_name: "drivers_shoppers_central",
      FilterExpression: "contains(regional_clearances, :val1)",
      ExpressionAttributeValues: {
        ":val1": city,
      },
    }).then((driversListData) => {
      if (driversListData !== undefined && driversListData.length > 0) {
        //Found some drivers in the city
        //? 2. Assemble each redis keys for their request list
        let parentPromises = driversListData.map((driver) => {
          return new Promise((resCompute) => {
            let redisKeyReformed = `${driver.driver_fingerprint}-rideDeliveryMade-holder-${requestType}`;
            logger.info(redisKeyReformed);

            //! CLEAR
            redisCluster.del(redisKeyReformed, function (err, resp) {
              console.log(err, resp);
              //DONE
              resCompute(true);
            });
          });
        });
        //...
        Promise.all(parentPromises)
          .then((result) => {
            logger.warn(result);
            resolve(true);
          })
          .catch((error) => {
            logger.error(error);
            resolve(false);
          });
      } //No no drivers found in this city
      else {
        resolve(false);
      }
    });
  } //No city specified
  else {
    logger.warn("No cities specified for the clearing operation.");
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
 * @func cancelRequest_driver
 * Responsible for cancelling any request from the driver app, If and only if the request was accepted by the driver who's requesting for the cancellation.
 * @param bundleWorkingData: contains the driver_fp and the request_fp.
 * @param resolve
 */
function cancelRequest_driver(bundleWorkingData, resolve) {
  resolveDate();

  dynamo_find_query({
    table_name: "requests_central",
    IndexName: "shopper_id",
    KeyConditionExpression: "shopper_id = :val1",
    FilterExpression: "request_fp = :val2",
    ExpressionAttributeValues: {
      ":val1": bundleWorkingData.driver_fingerprint,
      ":val2": bundleWorkingData.request_fp,
    },
  }).then((result) => {
    if (result !== undefined && result.length > 0) {
      let tripData = result[0];
      //...
      //! Check if the driver did not cancel more than MAXIMUM_CANCELLATION_DRIVER_REQUESTS_LIMIT requests today
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
      //....
      dynamo_find_query({
        table_name: "global_events",
        IndexName: "event_name",
        KeyConditionExpression:
          "event_name = :val1 AND #date_word BETWEEN :start_date AND :end_date",
        FilterExpression: "driver_fingerprint = :val2",
        ScanIndexForward: false,
        ExpressionAttributeValues: {
          ":val1": "driver_cancelling_request",
          ":val2": bundleWorkingData.driver_fingerprint,
          ":start_date": today_beginning,
          ":end_date": today_end,
        },
        ExpressionAttributeNames: {
          "#date_word": "date",
        },
      })
        .then((resultCancelledRequests) => {
          if (
            resultCancelledRequests !== undefined &&
            resultCancelledRequests.length <=
              parseInt(process.env.MAXIMUM_CANCELLATION_DRIVER_REQUESTS_LIMIT)
          ) {
            //! Check if the driver held the request for more than 15min.
            let requestDateMade = new Date(tripData.date_requested);

            // if (diff >= 15) {
            //!The driver held the request for at least 15min - can cancel
            //Can cancel
            //The driver requesting for the cancellation is the one who's currently associated to the request - proceed to the cancellation
            //Save the cancellation event
            new Promise((res) => {
              dynamo_insert("global_events", {
                event_name: "driver_cancelling_request",
                request_fp: bundleWorkingData.request_fp,
                driver_fingerprint: bundleWorkingData.driver_fingerprint,
                date: new Date(chaineDateUTC).toISOString(),
              })
                .then((result) => res(result))
                .catch((error) => logger.error(error));
            }).then(
              () => {},
              () => {}
            );
            //Update the true request
            dynamo_update({
              table_name: "requests_central",
              _idKey: tripData._id,
              UpdateExpression:
                "set shopper_id = :val1, #r.#i = :val2, car_fingerprint = :val3, #r.#inRoute = :val4",
              ExpressionAttributeValues: {
                ":val1": "false",
                ":val2": false,
                ":val3": "false",
                ":val4": false,
              },
              ExpressionAttributeNames: {
                "#r": "request_state_vars",
                "#i": "isAccepted",
                "#inRoute": "inRouteToPickup",
              },
            })
              .then((result) => {
                if (result === false) {
                  resolve({ response: "unable_to_cancel_request_error" });
                }

                //Send the push notifications - FOR ALL DRIVERS except the canceller
                // new Promise((resNotify) => {
                //   //! Get all the drivers
                //   let driverFilter = {
                //     "operational_state.status": { $in: ["online"] },
                //     "operational_state.default_selected_car.vehicle_type":
                //       result[0].carTypeSelected,
                //   };
                //   //..
                //   collectionDrivers_profiles
                //     .find(driverFilter)
                //     .toArray(function (err, driversProfiles) {
                //       //...Register the drivers fp so that thei can see tne requests
                //       let driversPushNotif_token = driversProfiles.map(
                //         (data) => {
                //           logger.error(data.operational_state.status);
                //           logger.error(
                //             data.driver_fingerprint.trim() !==
                //               bundleWorkingData.driver_fingerprint.trim()
                //           );
                //           if (
                //             /online/i.test(data.operational_state.status) &&
                //             data.driver_fingerprint.trim() !==
                //               bundleWorkingData.driver_fingerprint.trim()
                //           ) {
                //             let driverData = data;
                //             let snapshotTripInfos = {
                //               isIntercity_trip:
                //                 tripData.isIntercity_trip !== undefined &&
                //                 tripData.isIntercity_trip !== null
                //                   ? tripData.isIntercity_trip
                //                   : false,
                //               region: tripData.pickup_location_infos.state
                //                 .replace(/ Region/i, "")
                //                 .trim()
                //                 .toUpperCase(),
                //               city: tripData.pickup_location_infos.city
                //                 .trim()
                //                 .toUpperCase(),
                //               destination_infos: tripData.destinationData,
                //             };
                //             logger.info(snapshotTripInfos);
                //             //....
                //             if (
                //               snapshotTripInfos.isIntercity_trip === true ||
                //               snapshotTripInfos.isIntercity_trip === "true"
                //             ) {
                //               //? Intercity trip
                //               //? Check that the region and the city is within the driver's regional clearances.
                //               logger.info("Intercity trip detected");
                //               let driverRegionalClearances =
                //                 driverData.regional_clearances !== undefined &&
                //                 driverData.regional_clearances !== null
                //                   ? driverData.regional_clearances
                //                   : false;
                //               //...
                //               let driverCity =
                //                 driverData.operational_state.last_location !==
                //                   null &&
                //                 driverData.operational_state.last_location !==
                //                   undefined &&
                //                 driverData.operational_state.last_location
                //                   .city !== undefined &&
                //                 driverData.operational_state.last_location
                //                   .city != null
                //                   ? driverData.operational_state.last_location
                //                       .city
                //                   : false;
                //               //...
                //               if (
                //                 driverRegionalClearances !== false &&
                //                 driverCity !== false
                //               ) {
                //                 //Has a regional clearance
                //                 // logger.info(trip.origin_destination_infos.destination_infos);
                //                 if (
                //                   driverRegionalClearances[
                //                     snapshotTripInfos.region
                //                   ] !== undefined &&
                //                   driverRegionalClearances[
                //                     snapshotTripInfos.region
                //                   ] !== null
                //                 ) {
                //                   //! Sort the clearances array
                //                   driverRegionalClearances[
                //                     snapshotTripInfos.region
                //                   ].sort();

                //                   //? Found a valid clearance rule
                //                   //? 1. Check if the pickup AND destination towns is included in the clearances
                //                   let tripTowns_summary = [
                //                     snapshotTripInfos.city,
                //                     ...snapshotTripInfos.destination_infos.map(
                //                       (dest) => dest.city
                //                     ),
                //                   ];
                //                   // Normalize
                //                   tripTowns_summary = tripTowns_summary.map(
                //                     (el) => el.trim().toUpperCase()
                //                   );
                //                   // Sort
                //                   tripTowns_summary.sort();
                //                   if (
                //                     arrayEquals(
                //                       tripTowns_summary,
                //                       driverRegionalClearances[
                //                         snapshotTripInfos.region
                //                       ]
                //                     )
                //                   ) {
                //                     //TOWNS WITHIN THE CLEARANCES
                //                     //? 2. Check that the driver's current location (city) as equal to one of the towns allowed by his regional credentials.
                //                     driverCity = driverCity
                //                       .trim()
                //                       .toUpperCase();
                //                     //...
                //                     if (
                //                       driverRegionalClearances[
                //                         snapshotTripInfos.region
                //                       ].includes(driverCity)
                //                     ) {
                //                       //? Driver's current location is within the regional clearances
                //                       logger.info(
                //                         `Intercity trip allowed for driver's interaction -> ${driverData.driver_fingerprint.substring(
                //                           0,
                //                           15
                //                         )}`
                //                       );
                //                       return data.operational_state
                //                         .push_notification_token !== null &&
                //                         data.operational_state
                //                           .push_notification_token !== undefined
                //                         ? data.operational_state
                //                             .push_notification_token.userId
                //                         : null;
                //                     } //! The driver's current location is not within the regional clearances
                //                     else {
                //                       logger.warn(
                //                         `The driver's current location is not within the regional clearances`
                //                       );
                //                       return null;
                //                     }
                //                   } //Towns for the trip not fitting in the driver's regional clearances
                //                   else {
                //                     logger.warn(
                //                       `Towns for the trip not fitting in the driver's regional clearances`
                //                     );
                //                     return null;
                //                   }
                //                 } //No valid rule found
                //                 else {
                //                   logger.warn(
                //                     "No valid regional clearance rule found."
                //                   );
                //                   return null;
                //                 }
                //               } //?No regional clearances
                //               else {
                //                 logger.warn(
                //                   "No regional clearances found for this driver."
                //                 );
                //                 return null;
                //               }
                //             } //? Not intercity trip - filter based on the drivers location
                //             else {
                //               logger.info("Normal innercity trip detected");
                //               let driverCity =
                //                 driverData.operational_state.last_location !==
                //                   null &&
                //                 driverData.operational_state.last_location !==
                //                   undefined &&
                //                 driverData.operational_state.last_location
                //                   .city !== undefined &&
                //                 driverData.operational_state.last_location
                //                   .city != null
                //                   ? driverData.operational_state.last_location
                //                       .city
                //                   : "MISSING";
                //               //...
                //               if (
                //                 snapshotTripInfos.city.trim().toUpperCase() ===
                //                 driverCity.trim().toUpperCase()
                //               ) {
                //                 return data.operational_state
                //                   .push_notification_token !== null &&
                //                   data.operational_state
                //                     .push_notification_token !== undefined
                //                   ? data.operational_state
                //                       .push_notification_token.userId
                //                   : null;
                //               } //not elligible driver
                //               else {
                //                 return null;
                //               }
                //             }
                //           } else {
                //             return null; //Only notify the drivers that are online.
                //           }
                //         }
                //       ); //Push notification token
                //       //....
                //       let message = {
                //         app_id: process.env.DRIVERS_APP_ID_ONESIGNAL,
                //         android_channel_id: /RIDE/i.test(result[0].ride_mode)
                //           ? process.env
                //               .DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION
                //           : process.env
                //               .DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION, //Ride or delivery channel
                //         priority: 10,
                //         contents: /RIDE/i.test(result[0].ride_mode)
                //           ? {
                //               en:
                //                 "You have a new ride request " +
                //                 (result[0].pickup_location_infos.suburb !==
                //                 false
                //                   ? "from " +
                //                       result[0].pickup_location_infos.suburb !==
                //                       undefined &&
                //                     result[0].pickup_location_infos.suburb !==
                //                       false &&
                //                     result[0].pickup_location_infos.suburb !==
                //                       null
                //                     ? result[0].pickup_location_infos.suburb.toUpperCase()
                //                     : "near your location" +
                //                         " to " +
                //                         result[0].pickup_location_infos
                //                           .suburb !==
                //                         undefined &&
                //                       result[0].pickup_location_infos.suburb !==
                //                         false &&
                //                       result[0].pickup_location_infos.suburb !==
                //                         null
                //                     ? result[0].pickup_location_infos.suburb.toUpperCase()
                //                     : "near your location" +
                //                       ". Click here for more details."
                //                   : "near your location, click here for more details."),
                //             }
                //           : {
                //               en:
                //                 "You have a new delivery request " +
                //                 (result[0].pickup_location_infos.suburb !==
                //                 false
                //                   ? "from " +
                //                       result[0].pickup_location_infos.suburb !==
                //                       undefined &&
                //                     result[0].pickup_location_infos.suburb !==
                //                       false &&
                //                     result[0].pickup_location_infos.suburb !==
                //                       null
                //                     ? result[0].pickup_location_infos.suburb.toUpperCase()
                //                     : "near your location" +
                //                         " to " +
                //                         result[0].pickup_location_infos
                //                           .suburb !==
                //                         undefined &&
                //                       result[0].pickup_location_infos.suburb !==
                //                         false &&
                //                       result[0].pickup_location_infos.suburb !==
                //                         null
                //                     ? result[0].pickup_location_infos.suburb.toUpperCase()
                //                     : "near your location" +
                //                       ". Click here for more details."
                //                   : "near your location, click here for more details."),
                //             },
                //         headings: /RIDE/i.test(result[0].ride_mode)
                //           ? { en: "New ride request, N$" + result[0].fare }
                //           : {
                //               en: "New delivery request, N$" + result[0].fare,
                //             },
                //         content_available: true,
                //         include_player_ids: driversPushNotif_token,
                //       };
                //       //Send
                //       sendPushUPNotification(message);
                //       resNotify(true);
                //     });
                // })
                //   .then()
                //   .catch();

                //! Clear the request cached list for all the drivers in the same city
                new Promise((resClearRedis) => {
                  clearCityDriversCacheLists({
                    city: tripData.locations.pickup.city,
                    requestType: tripData.ride_mode,
                    resolve: resClearRedis,
                  });
                })
                  .then()
                  .catch((error) => logger.error(error));

                //DONE
                resolve({
                  response: "successfully_cancelled",
                  rider_fp: tripData.client_id,
                });
              })
              .catch((error) => {
                logger.error(error);
                resolve({ response: "unable_to_cancel_request_error" });
              });
            // } //The driver did not held the request for at least 15min - put cancellation lock
            // else {
            //   resolve({ response: "unable_to_cancel_request_error" });
            // }
          } //!Has exceeded the daily cancellation limit
          else {
            resolve({
              response:
                "unable_to_cancel_request_error_daily_cancellation_limit_exceeded",
              limit: process.env.MAXIMUM_CANCELLATION_DRIVER_REQUESTS_LIMIT,
            });
          }
        })
        .catch((error) => {
          logger.error(error);
          resolve({ response: "unable_to_cancel_request_error" });
        });
    } //abort the cancelling
    else {
      resolve({ response: "unable_to_cancel_request_not_owned" });
    }
  });
}

/**
 * @func confirmPickupRequest_driver
 * Responsible for confirming pickup for any request from the driver app, If and only if the request was accepted by the driver who's requesting for the the pickup confirmation.
 * @param collectionRidesDeliveries_data: list of all the requests made.
 * @param collectionGlobalEvents: hold all the random events that happened somewhere.
 * @param bundleWorkingData: contains the driver_fp and the request_fp.
 * @param resolve
 */
function confirmPickupRequest_driver(
  bundleWorkingData,
  collectionRidesDeliveries_data,
  collectionGlobalEvents,
  collectionDrivers_profiles,
  resolve
) {
  resolveDate();

  let dynRequestFetcher =
    bundleWorkingData.driver_fingerprint !== undefined &&
    bundleWorkingData.driver_fingerprint !== null
      ? {
          request_fp: bundleWorkingData.request_fp,
          taxi_id: bundleWorkingData.driver_fingerprint,
        }
      : {
          request_fp: bundleWorkingData.request_fp,
          client_id: bundleWorkingData.rider_fingerprint,
        };
  //Only confirm pickup if not yet accepted by the driver
  collectionRidesDeliveries_data
    .find(dynRequestFetcher)
    .toArray(function (err, requestGlobalData) {
      if (err) {
        resolve({ response: "unable_to_confirm_pickup_request_error" });
      }
      //...
      if (requestGlobalData.length > 0) {
        requestGlobalData = requestGlobalData[0];
        //The driver requesting for the confirm pickup is the one who's currently associated to the request - proceed to the pickup confirmation.
        //Save the pickup confirmation event
        new Promise((res) => {
          dynamo_insert("global_events", {
            event_name: "driver_confirm_pickup_request",
            request_fp: requestGlobalData.request_fp,
            driver_fingerprint: requestGlobalData.taxi_id,
            rider_fingerprint: requestGlobalData.client_id,
            date: new Date(chaineDateUTC).toISOString(),
          })
            .then()
            .catch((error) => logger.error(error));
          //...
          res(true);
        }).then(
          () => {},
          () => {}
        );
        //Update the true request
        dynamo_update(
          "rides_deliveries_requests",
          {
            request_fp: requestGlobalData.request_fp,
          },
          "set taxi_id = :val1, date_pickup = :val2, #r.#i = :val3, #r.#in = :val4",
          {
            ":val1": requestGlobalData.taxi_id,
            ":val2": new Date(chaineDateUTC).toISOString(),
            ":val3": true,
            ":val4": true,
          },
          {
            "#r": "ride_state_vars",
            "#i": "isAccepted",
            "#in": "inRideToDestination",
          }
        )
          .then((result) => {
            if (result === false) {
              resolve({ response: "unable_to_confirm_pickup_request_error" });
            }

            //? If corporate delivery, notify the receiver by SMS
            //! Send SMS just for corporate globality
            let parsedRequest = requestGlobalData;
            if (
              parsedRequest.request_globality !== undefined &&
              /corporate/i.test(parsedRequest.request_globality) &&
              /DELIVERY/i.test(parsedRequest.ride_mode)
            ) {
              logger.warn("CORPORATE DELIVERY");
              new Promise((resSub) => {
                collectionDedicatedServices_accounts
                  .find({
                    company_fp: parsedRequest.client_id,
                  })
                  .toArray(function (err, companyData) {
                    if (err) {
                      logger.error(err);
                      resSub(false);
                    }
                    //...
                    if (companyData !== undefined && companyData.length > 0) {
                      parsedRequest = parsedRequest.destinationData.map(
                        (el) => {
                          return {
                            receiver_infos: el.receiver_infos,
                          };
                        }
                      );
                      parsedRequest = [
                        ...new Set(parsedRequest.map(JSON.stringify)),
                      ].map(JSON.parse);
                      logger.info(parsedRequest);
                      //Valid company
                      parsedRequest.map((destination) => {
                        if (
                          destination.receiver_infos.receiver_name !== false &&
                          destination.receiver_infos.receiver_name !==
                            undefined &&
                          destination.receiver_infos.receiver_phone !== false &&
                          destination.receiver_infos.receiver_phone !==
                            undefined &&
                          destination.receiver_infos.receiver_phone !== null &&
                          destination.receiver_infos.receiver_phone.length > 0
                        ) {
                          logger.error(destination);
                          SendSMSTo(
                            destination.receiver_infos.receiver_phone.replace(
                              "+",
                              ""
                            ),
                            `Hi ${
                              destination.receiver_infos.receiver_name
                            }, you have an incoming delivery from ${companyData[0].company_name.toUpperCase()}. You can track it using the TaxiConnect app. Thanks.`
                          );
                        }
                      });
                      //...
                      resSub(true);
                    } //Unknown company?
                    else {
                      resSub(false);
                    }
                  });
              })
                .then()
                .catch();
            }

            //DONE
            resolve({
              response: "successfully_confirmed_pickup",
              rider_fp: requestGlobalData.client_id,
            });
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "unable_to_confirm_pickup_request_error" });
          });
      } //abort the pickup confirmation
      else {
        resolve({ response: "unable_to_confirm_pickup_request_not_owned" });
      }
    });
}

/**
 * @func confirmDropoffRequest_driver
 * Responsible for confirming dropoff for any request from the driver app, If and only if the request was accepted by the driver who's requesting for the the dropoff confirmation.
 * @param collectionRidesDeliveries_data: list of all the requests made.
 * @param collectionGlobalEvents: hold all the random events that happened somewhere.
 * @param bundleWorkingData: contains the driver_fp and the request_fp.
 * @param collectionPassengers_profiles: list of all the passengers.
 * @param collectionDrivers_profiles: the list of all the drivers.
 * @param resolve
 */
function confirmDropoffRequest_driver(
  bundleWorkingData,
  collectionRidesDeliveries_data,
  collectionGlobalEvents,
  collectionPassengers_profiles,
  collectionDrivers_profiles,
  resolve
) {
  resolveDate();
  //Only confirm pickup if not yet accepted by the driver
  collectionRidesDeliveries_data
    .find({
      request_fp: bundleWorkingData.request_fp,
      taxi_id: bundleWorkingData.driver_fingerprint,
    })
    .toArray(function (err, result) {
      if (err) {
        resolve({ response: "unable_to_confirm_dropoff_request_error" });
      }
      //...
      if (result.length > 0) {
        //The driver requesting for the confirm dropoff is the one who's currently associated to the request - proceed to the dropoff confirmation.
        //Save the dropoff confirmation event
        new Promise((res) => {
          dynamo_insert("global_events", {
            event_name: "driver_confirm_dropoff_request",
            request_fp: bundleWorkingData.request_fp,
            driver_fingerprint: bundleWorkingData.driver_fingerprint,
            date: new Date(chaineDateUTC).toISOString(),
          })
            .then()
            .catch((error) => logger.error(error));
          //...
          res(true);
        })
          .then(() => {})
          .catch();
        //Update the true request
        dynamo_update(
          "rides_deliveries_requests",
          {
            request_fp: bundleWorkingData.request_fp,
          },
          "set taxi_id = :val1, date_dropoff = :val2, #r.#i = :val3, #r.#in = :val4, #r.#is = :val5",
          {
            ":val1": bundleWorkingData.driver_fingerprint,
            ":val2": new Date(chaineDateUTC).toISOString(),
            ":val3": true,
            ":val4": true,
            ":val5": true,
          },
          {
            "#r": "ride_state_vars",
            "#i": "isAccepted",
            "#in": "inRideToDestination",
            "#is": "isRideCompleted_driverSide",
          }
        )
          .then((result) => {
            if (result === false) {
              resolve({ response: "unable_to_confirm_dropoff_request_error" });
            }

            //? Update the accepted rides brief list in the driver's profile
            new Promise((resUpdateDriverProfile) => {
              //! Get the driver's details - to fetch the car's fingerprint
              collectionDrivers_profiles
                .find({
                  driver_fingerprint: bundleWorkingData.driver_fingerprint,
                })
                .toArray(function (err, driverData) {
                  if (err) {
                    resUpdateDriverProfile(false);
                  }
                  //...
                  if (driverData.length > 0) {
                    //Get request infos
                    collectionRidesDeliveries_data
                      .find({ request_fp: bundleWorkingData.request_fp })
                      .toArray(function (err, requestPrevData) {
                        if (err) {
                          resUpdateDriverProfile(false);
                        }
                        //...
                        if (
                          requestPrevData !== undefined &&
                          requestPrevData.length > 0 &&
                          requestPrevData[0].request_fp !== undefined &&
                          requestPrevData[0].request_fp !== null
                        ) {
                          //?Get the previous data or initialize it if empty
                          let prevAcceptedData =
                            driverData.accepted_requests_infos !== undefined &&
                            driverData.accepted_requests_infos
                              .total_passengers_number !== undefined &&
                            driverData.accepted_requests_infos
                              .total_passengers_number !== null &&
                            driverData.accepted_requests_infos
                              .total_passengers_number !== undefined &&
                            driverData.accepted_requests_infos
                              .total_passengers_number !== null
                              ? driverData.accepted_requests_infos
                              : {
                                  total_passengers_number: 0,
                                  requests_fingerprints: [],
                                };
                          //...
                          //? Update with new request - remove current request data
                          prevAcceptedData.total_passengers_number -= parseInt(
                            driverData.accepted_requests_infos !== undefined &&
                              driverData.accepted_requests_infos !== null &&
                              driverData.accepted_requests_infos
                                .total_passengers_number !== undefined &&
                              driverData.accepted_requests_infos
                                .total_passengers_number > 0
                              ? requestPrevData[0].passengers_number
                              : 0
                          ); //! DO not remove if the total number of passengers was zero already.
                          prevAcceptedData.requests_fingerprints =
                            prevAcceptedData.requests_fingerprints.length > 0
                              ? prevAcceptedData.requests_fingerprints.filter(
                                  (fps) => fps !== bundleWorkingData.request_fp
                                )
                              : {}; //! Do not filter out the current request_fp if it was already empty.
                          //...
                          dynamo_update(
                            "drivers_profiles",
                            {
                              driver_fingerprint:
                                bundleWorkingData.driver_fingerprint,
                            },
                            "set #o.#a = :val1, date_updated = :val2",
                            {
                              ":val1": prevAcceptedData,
                              ":val2": new Date(chaineDateUTC).toISOString(),
                            },
                            {
                              "#o": "operational_state",
                              "#a": "accepted_requests_infos",
                            }
                          )
                            .then((result) => {
                              if (result === false) {
                                resUpdateDriverProfile(false);
                              }
                              //...
                              resUpdateDriverProfile(true);
                            })
                            .catch((error) => {
                              logger.error(error);
                              resUpdateDriverProfile(false);
                            });

                          //?Notify the cllient
                          //Send the push notifications - FOR Passengers
                          new Promise((resSendNotif) => {
                            //? Get the rider's details
                            collectionPassengers_profiles
                              .find({
                                user_fingerprint: requestPrevData[0].client_id,
                              })
                              .toArray(function (err, ridersDetails) {
                                if (err) {
                                  resSendNotif(false);
                                }
                                //...
                                if (
                                  ridersDetails.length > 0 &&
                                  ridersDetails[0].user_fingerprint !==
                                    undefined &&
                                  ridersDetails[0].pushnotif_token !== null &&
                                  ridersDetails[0].pushnotif_token !==
                                    undefined &&
                                  ridersDetails[0].pushnotif_token.userId !==
                                    undefined
                                ) {
                                  let message = {
                                    app_id: process.env.RIDERS_APP_ID_ONESIGNAL,
                                    android_channel_id:
                                      process.env
                                        .RIDERS_ONESIGNAL_CHANNEL_ACCEPTTEDD_REQUEST, //Ride or delivery channel
                                    priority: 10,
                                    contents: {
                                      en: "Don't forget to confirm your drop off and rate your driver. Click here to do so.",
                                    },
                                    headings: { en: "Your trip is completed" },
                                    content_available: true,
                                    include_player_ids: [
                                      String(
                                        ridersDetails[0].pushnotif_token.userId
                                      ),
                                    ],
                                  };
                                  //Send
                                  sendPushUPNotification(message);
                                  resSendNotif(false);
                                } else {
                                  resSendNotif(false);
                                }
                              });
                          }).then(
                            () => {},
                            () => {}
                          );
                        } //Strange - no request found
                        else {
                          resUpdateDriverProfile(true);
                        }
                      });
                  } //No driver
                  else {
                    resUpdateDriverProfile(false);
                  }
                });
            })
              .then(
                () => {},
                () => {}
              )
              .catch((error) => {
                //logger.info(error);
              });
            //DONE
            resolve({
              response: "successfully_confirmed_dropoff",
              rider_fp: result[0].client_id,
            });
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "unable_to_confirm_dropoff_request_error" });
          });
      } //abort the pickup confirmation
      else {
        resolve({ response: "unable_to_confirm_dropoff_request_not_owned" });
      }
    });
}

/**
 * @func INIT_RIDE_DELIVERY_DISPATCH_ENTRY
 * Responsible for launching the ride/delivery dispath after all preliminary checks have passed.
 * ? Some checks can be: making sure that the rider has enough funds in his/her wallet.
 * @param parsedReqest_data: clean parsed request data.
 * @param collectionDrivers_profiles: driver's collection.
 * @param collectionRidesDeliveries_data: collection of all rides/deliveries
 * @param resolve
 */
function INIT_RIDE_DELIVERY_DISPATCH_ENTRY(
  parsedReqest_data,
  collectionDrivers_profiles,
  collectionRidesDeliveries_data,
  resolve
) {
  //? Save the request in mongodb - EXTREMELY IMPORTANT
  let checkPrevRequest = {
    client_id: parsedReqest_data.client_id,
    "ride_state_vars.isRideCompleted_riderSide": false,
    isArrivedToDestination: false,
  };

  //! PLANS QUOTAS
  //! Batches
  let QUOTAS_BATCHES = {
    STR: 1,
    ITMD: 15,
    PR: 50,
    PRSNLD: 100,
  };

  //! Set a dynamic limit to the number of simulataneaous requests - BATCH
  //? normal :0
  //? corporate: 5
  let simulataneaousRequestsLimit = /normal/i.test(
    parsedReqest_data.request_globality
  )
    ? 0
    : QUOTAS_BATCHES[parsedReqest_data.subscribed_plan];
  //! ----

  //! Get the list of blocked drivers set by the rider
  collectionPassengers_profiles
    .find({
      user_fingerprint: parsedReqest_data.client_id,
    })
    .toArray(function (err, riderData) {
      if (err) {
        //logger.info(err);
        resolve({ response: "Unable_to_make_the_request" });
      }
      //...
      if (riderData !== undefined && riderData.length > 0) {
        //Found the profile
        riderData = riderData[0];
        //...
        collectionRidesDeliveries_data
          .find(checkPrevRequest)
          .toArray(function (err, prevRequest) {
            if (err) {
              logger.error(err);
              resolve({ response: "Unable_to_make_the_request" });
            }
            //....
            if (
              prevRequest === undefined ||
              prevRequest === null ||
              prevRequest.length <= simulataneaousRequestsLimit - 1 ||
              prevRequest[0] === undefined
            ) {
              let blockedDriversByRider =
                riderData.drivers_blacklist !== undefined &&
                riderData.drivers_blacklist !== null
                  ? riderData.drivers_blacklist
                  : [];
              ///...
              let distilledUnwantedDrivers = [];
              blockedDriversByRider.map((d) => {
                distilledUnwantedDrivers.push(d.driver_fp);
              });
              //! Exclude all the blocked drivers from seeing the requests - intentional_request_decline
              parsedReqest_data["intentional_request_decline"] =
                distilledUnwantedDrivers;
              //! ----
              dynamo_insert("rides_deliveries_requests", parsedReqest_data)
                .then((requestDt) => {
                  if (requestDt === false) {
                    //logger.info(err);
                    resolve({ response: "Unable_to_make_the_request" });
                  }

                  //2. INITIATE STAGED toDrivers DISPATCH
                  new Promise((resStaged) => {
                    //FORM THE REQUEST SNAPSHOT
                    let snapshotTripInfos = {
                      user_fingerprint: parsedReqest_data.client_id,
                      isIntercity_trip: parsedReqest_data.isIntercity_trip,
                      city: parsedReqest_data.pickup_location_infos.city,
                      region: parsedReqest_data.pickup_location_infos.state
                        .replace(/ Region/i, "")
                        .trim()
                        .toUpperCase(),
                      country: parsedReqest_data.country,
                      ride_type: parsedReqest_data.ride_mode,
                      request_type: parsedReqest_data.request_type,
                      vehicle_type: parsedReqest_data.carTypeSelected,
                      org_latitude:
                        parsedReqest_data.pickup_location_infos.coordinates
                          .latitude,
                      org_longitude:
                        parsedReqest_data.pickup_location_infos.coordinates
                          .longitude,
                      request_fp: parsedReqest_data.request_fp,
                      pickup_suburb:
                        parsedReqest_data.pickup_location_infos.suburb,
                      destination_suburb:
                        parsedReqest_data.destinationData[0].suburb,
                      fare: parsedReqest_data.fare,
                      passengers_number: parsedReqest_data.passengers_number,
                      destination_infos: parsedReqest_data.destinationData, //? Full destination data
                    };

                    intitiateStagedDispatch(
                      snapshotTripInfos,
                      collectionDrivers_profiles,
                      collectionRidesDeliveries_data,
                      distilledUnwantedDrivers,
                      resStaged
                    );
                  }).then(
                    (result) => {
                      logger.info(result);
                    },
                    (error) => {
                      logger.info(error);
                    }
                  );
                  //..Success - respond to the user
                  resolve({ response: "successfully_requested" });
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "Unable_to_make_the_request" });
                });
            } //Already have a request
            else {
              //logger.info("ALEADY HAS A REQUEST");
              resolve({ response: "already_have_a_pending_request" });
            }
          });
      } //No profile found
      else {
        resolve({ response: "Unable_to_make_the_request" });
      }
    });
}

/**
 * @func getRequests_graphPreview_forDrivers
 * Responsible for getting the graph of available requests to display notification badges on the
 * driver's app to make the request finding much more simple and efficient.
 * ? Only consider the free requests.
 * ? Filter based on the car type selected (normal taxo, ebikes, etc).
 * ? Filter based on the country and city.
 * ! Do not limit based on the driver's maximum capacity.
 * ! Do not count the declined trips
 * ? Filter based on the operation clearances of the driver.
 * ------
 * @param driver_fingerprint: the driver's fingerprint.
 * @param collectionRidesDeliveries_data: the list of all the requests.
 * @param collectionDrivers_profiles: the list of all the drivers.
 * @param resolve
 */
function getRequests_graphPreview_forDrivers(
  driver_fingerprint,
  collectionRidesDeliveries_data,
  collectionDrivers_profiles,
  resolve
) {
  //? Form requests graph template
  let requestsGraph = {
    rides: 0,
    deliveries: 0,
    scheduled: 0,
    accepted: 0,
  };
  //...
  //1. Get the driver's data
  collectionDrivers_profiles
    .find({ driver_fingerprint: driver_fingerprint })
    .toArray(function (err, driverData) {
      if (err) {
        resolve({
          rides: 0,
          deliveries: 0,
          scheduled: 0,
          accepted: 0,
        });
      }
      //...
      if (
        driverData !== undefined &&
        driverData !== null &&
        driverData.length > 0 &&
        driverData[0].driver_fingerprint !== undefined &&
        driverData[0].driver_fingerprint !== null
      ) {
        //Found the ddriver's data
        try {
          //2. Isolate correct requests
          collectionRidesDeliveries_data
            .find(
              /88889d088e03653169b9c18193a0b8dd329ea1e43eb0626ef9f16b5b979694a429710561a3cb3ddae/i.test(
                driver_fingerprint
              )
                ? {
                    taxi_id: false,
                    "pickup_location_infos.city":
                      driverData[0].operational_state.last_location !== null &&
                      driverData[0].operational_state.last_location.city &&
                      driverData[0].operational_state.last_location.city !==
                        undefined
                        ? driverData[0].operational_state.last_location.city
                        : "Windhoek",
                    country:
                      driverData[0].operational_state.last_location !== null &&
                      driverData[0].operational_state.last_location.country &&
                      driverData[0].operational_state.last_location.country !==
                        undefined
                        ? driverData[0].operational_state.last_location.country
                        : "Namibia",
                    intentional_request_decline: {
                      $not: { $in: [driver_fingerprint] },
                    },
                  }
                : {
                    taxi_id: false,
                    "pickup_location_infos.city":
                      driverData[0].operational_state.last_location !== null &&
                      driverData[0].operational_state.last_location.city &&
                      driverData[0].operational_state.last_location.city !==
                        undefined
                        ? driverData[0].operational_state.last_location.city
                        : "Windhoek",
                    country:
                      driverData[0].operational_state.last_location !== null &&
                      driverData[0].operational_state.last_location.country &&
                      driverData[0].operational_state.last_location.country !==
                        undefined
                        ? driverData[0].operational_state.last_location.country
                        : "Namibia",
                    carTypeSelected:
                      driverData[0].operational_state.default_selected_car
                        .vehicle_type,
                    ride_mode: {
                      $in: driverData[0].operation_clearances.map(
                        (clearance) => [
                          `${clearance[0].toUpperCase().trim()}${clearance
                            .substr(1)
                            .toLowerCase()
                            .trim()}`,
                          clearance.toUpperCase().trim(),
                          clearance[0],
                        ]
                      )[0],
                    },
                    // allowed_drivers_see: driver_fingerprint,
                    intentional_request_decline: {
                      $not: { $in: [driver_fingerprint] },
                    },
                  }
            )
            .toArray(function (err, filteredRequests) {
              if (err) {
                resolve({
                  rides: 0,
                  deliveries: 0,
                  scheduled: 0,
                  accepted: 0,
                });
              }
              //...
              if (
                filteredRequests !== undefined &&
                filteredRequests !== null &&
                filteredRequests.length > 0
              ) {
                //? Auto segregate rides, deliveries and scheduled rides
                let parentPromises = filteredRequests.map((requestInfo) => {
                  return new Promise((resSegregate) => {
                    if (/scheduled/i.test(requestInfo.request_type)) {
                      //Scheduled request
                      requestsGraph.scheduled += 1;
                      resSegregate(true);
                    } else if (/ride/i.test(requestInfo.ride_mode)) {
                      //Ride only - now
                      requestsGraph.rides += 1;
                      resSegregate(true);
                    } else if (/delivery/i.test(requestInfo.ride_mode)) {
                      //Delivery only -now
                      requestsGraph.deliveries += 1;
                      resSegregate(true);
                    } //Unknown request mode? -Weiird
                    else {
                      resSegregate(true);
                    }
                  });
                });
                //Done
                Promise.all(parentPromises)
                  .then(
                    (resultSegregatedRequests) => {
                      //? Check if there are any scheduled requests that are not completed yet and add them to the count
                      collectionRidesDeliveries_data
                        .find({
                          taxi_id: driver_fingerprint,
                          // request_type: "scheduled",
                          "ride_state_vars.isAccepted": true,
                          "ride_state_vars.isRideCompleted_driverSide": false,
                          isArrivedToDestination: false,
                          intentional_request_decline: {
                            $not: { $in: [driver_fingerprint] },
                          },
                        })
                        .toArray(function (err, scheduledAcceptedTripData) {
                          if (err) {
                            resolve(requestsGraph);
                          }
                          //...
                          if (
                            scheduledAcceptedTripData !== undefined &&
                            scheduledAcceptedTripData !== null &&
                            scheduledAcceptedTripData.length > 0
                          ) {
                            //Found some scheduled rides
                            //Add the number to the graph
                            scheduledAcceptedTripData.map((trip) => {
                              if (/scheduled/i.test(trip.request_type)) {
                                //SCHEDULED
                                // requestsGraph.scheduled += 1;
                                //...
                                requestsGraph.accepted += 1;
                              } //Normal accepted
                              else {
                                requestsGraph.accepted += 1;
                              }
                            });
                            //? DONE
                            resolve(requestsGraph);
                          } //No not yet completed scheduled rides
                          else {
                            resolve(requestsGraph);
                          }
                        });
                    },
                    (error) => {
                      //logger.info(error);
                      resolve({
                        rides: 0,
                        deliveries: 0,
                        scheduled: 0,
                        accepted: 0,
                      });
                    }
                  )
                  .catch((error) => {
                    //logger.info(error);
                    resolve({
                      rides: 0,
                      deliveries: 0,
                      scheduled: 0,
                      accepted: 0,
                    });
                  });
              } //No requests
              else {
                //? Check if there are any scheduled requests that are not completed yet and add them to the count
                collectionRidesDeliveries_data
                  .find({
                    taxi_id: driver_fingerprint,
                    // request_type: "scheduled",
                    "ride_state_vars.isAccepted": true,
                    "ride_state_vars.isRideCompleted_driverSide": false,
                    isArrivedToDestination: false,
                    intentional_request_decline: {
                      $not: { $in: [driver_fingerprint] },
                    },
                  })
                  .toArray(function (err, scheduledAcceptedTripData) {
                    if (err) {
                      resolve(requestsGraph);
                    }
                    //...
                    if (
                      scheduledAcceptedTripData !== undefined &&
                      scheduledAcceptedTripData !== null &&
                      scheduledAcceptedTripData.length > 0
                    ) {
                      //Found some scheduled rides
                      //Add the number to the graph
                      scheduledAcceptedTripData.map((trip) => {
                        if (/scheduled/i.test(trip.request_type)) {
                          //SCHEDULED
                          requestsGraph.scheduled += 1;
                        } //Normal accepted
                        else {
                          requestsGraph.accepted += 1;
                        }
                      });
                      //? DONE
                      resolve(requestsGraph);
                    } //No not yet completed scheduled rides
                    else {
                      resolve(requestsGraph);
                    }
                  });
              }
            });
        } catch (error) {
          //logger.info(error);
          resolve({
            rides: 0,
            deliveries: 0,
            scheduled: 0,
            accepted: 0,
          });
        }
      } //Strange - no driver's record found
      else {
        resolve({
          rides: 0,
          deliveries: 0,
          scheduled: 0,
          accepted: 0,
        });
      }
    });
}

function diff_hours(dt1, dt2) {
  if (dt2 > dt1) {
    return { difference: Math.abs(dt2 - dt1) / 3600000, state: "onTime" };
  } else {
    return { difference: Math.abs(dt2 - dt1) / 3600000, state: "late" };
  }
}

/**
 * MAIN
 */
redisCluster.on("connect", function () {
  logger.info("[*] Redis connected");

  logger.info("[+] Dispatch services active.");
  app
    .get("/", function (req, res) {
      res.send("Dispatch services up");
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
    );

  /**
   * PARSE DATA WITHOUT DISPATCH
   * Responsible for parsing the raw data without any dispatch
   */
  app.post("/parseRequestData_withoutDispatch", function (req, res) {
    req = req.body;
    /*req = {
        actualRider: "me",
        actualRiderPhone_number: false,
        carTypeSelected: "normalTaxiEconomy",
        connectType: "ConnectMe",
        country: "Namibia",
        destinationData: {
          passenger1Destination: {
            averageGeo: 10,
            city: "Windhoek",
            coordinates: [-22.62009828325774, 17.093509613071824],
            country: "Namibia",
            location_id: 5428529857,
            location_name: "The Grove Mall",
            state: "Khomas Region",
            street: "Chasie Street",
            id: 1,
            details: "Empty",
          },
          passenger2Destination: false,
          passenger3Destination: false,
          passenger4Destination: false,
        },
        fareAmount: 45,
        isAllGoingToSameDestination: false,
        naturePickup: "PrivateLocation",
        passengersNo: 1,
        pickupData: {
          city: "Windhoek",
          coordinates: [-22.563358987828945, 17.06632928612283],
          location_name: "Best St Best Street, Windhoek West",
          street_name: null,
        },
        pickupNote: "Best Street, Windhoek West",
        receiverName_delivery: false,
        receiverPhone_delivery: false,
        rideType: "RIDE",
        timeScheduled: "now",
        paymentMethod: "CASH",
        user_fingerprint:
          "caf19f4180e98600e8e362d015c1bac8a2ac99aa086bcd8047284a7e06334b0a787a80248efe580b",
        recovered_request: true,
        request_fp:
          "6e4a228382b7d6d6b9f8361f7adf16b388fbff1f265cccb6dd464ef75d9219decfe339e19af6a3c8",
        taxi_id:
          "a5a596c422195f5012076ce530b1e5144f39f800785de85293a91505be9b68b90e5ffe84ea7d7fc0",
        date_requested: "2020-10-11T12:59:14.000Z",
        trip_simplified_id: "TAMI0q3l_oXg2",
        ride_state_vars: {
          isAccepted: true,
          inRideToDestination: true,
          isRideCompleted_driverSide: true,
          isRideCompleted_riderSide: true,
          rider_driverRating: "5",
        },
        isArrivedToDestination: true,
        date_dropoff: "2020-10-11T12:59:27.000Z",
        date_pickup: "2020-10-11T12:59:27.000Z",
        date_accepted: "2020-10-11T12:59:27.000Z",
        flag: "here5",
        car_fingerprint:
          "7df7fdfd528c258a1a6da994941d1d5ca1e8a0c3452f3198d0725d8cf432e3ab2c325232df92f2af",
      };*/
    //...
    if (req.request_fp !== undefined) {
      //is present
      new Promise((resParse) => {
        parseRequestData(req, resParse);
      })
        .then(
          (result) => {
            res.send(result);
          },
          (error) => {
            //logger.info(error);
            res.send({ message: "Error parsing data", flag: error });
          }
        )
        .catch((error) => {
          //logger.info(error);
          res.send({ message: "Error parsing data", flag: error });
        });
    } //No valid data received
    else {
      res.send({ message: "No valid data received" });
    }
  });

  /**
   * REQUESTS GRAPH ASSEMBLER
   * Responsible for getting the requests graphs to help the drivers selectedd the correct tab easily.
   */
  app.get("/getRequests_graphNumbers", function (req, res) {
    new Promise((resMAIN) => {
      resolveDate();
      let params = urlParser.parse(req.url, true);
      req = params.query;

      if (req.driver_fingerprint !== undefined) {
        let redisKey = `requestsGraph-${req.driver_fingerprint}`;
        //OK
        redisGet(redisKey).then(
          (resp) => {
            if (resp !== null) {
              try {
                //logger.info("cached resullts found!");
                //? Rehyddrate the cached results
                new Promise((res0) => {
                  getRequests_graphPreview_forDrivers(
                    req.driver_fingerprint,
                    collectionRidesDeliveries_data,
                    collectionDrivers_profiles,
                    res0
                  );
                })
                  .then(
                    (result) => {
                      redisCluster.setex(
                        redisKey,
                        process.env.REDIS_EXPIRATION_5MIN * 6,
                        JSON.stringify(result)
                      );
                    },
                    (error) => {
                      //logger.info(error);
                      redisCluster.setex(
                        redisKey,
                        process.env.REDIS_EXPIRATION_5MIN * 6,
                        JSON.stringify(result)
                      );
                    }
                  )
                  .catch((error) => {
                    //logger.info(error);
                    redisCluster.setex(
                      redisKey,
                      process.env.REDIS_EXPIRATION_5MIN * 6,
                      JSON.stringify(result)
                    );
                  });
                //...
                resp = JSON.parse(resp);
                //...Return the cached results quickly
                resMAIN(resp);
              } catch (error) {
                //logger.info(error);
                new Promise((res0) => {
                  getRequests_graphPreview_forDrivers(
                    req.driver_fingerprint,
                    collectionRidesDeliveries_data,
                    collectionDrivers_profiles,
                    res0
                  );
                })
                  .then(
                    (result) => {
                      redisCluster.setex(
                        redisKey,
                        process.env.REDIS_EXPIRATION_5MIN * 6,
                        JSON.stringify(result)
                      );
                      resMAIN(result);
                    },
                    (error) => {
                      //logger.info(error);
                      redisCluster.setex(
                        redisKey,
                        process.env.REDIS_EXPIRATION_5MIN * 6,
                        JSON.stringify(result)
                      );
                      resMAIN({
                        rides: 0,
                        deliveries: 0,
                        scheduled: 0,
                        accepted: 0,
                      });
                    }
                  )
                  .catch((error) => {
                    //logger.info(error);
                    redisCluster.setex(
                      redisKey,
                      process.env.REDIS_EXPIRATION_5MIN * 6,
                      JSON.stringify(result)
                    );
                    resMAIN({
                      rides: 0,
                      deliveries: 0,
                      scheduled: 0,
                      accepted: 0,
                    });
                  });
              }
            } //No cached data yet
            else {
              new Promise((res0) => {
                getRequests_graphPreview_forDrivers(
                  req.driver_fingerprint,
                  collectionRidesDeliveries_data,
                  collectionDrivers_profiles,
                  res0
                );
              })
                .then(
                  (result) => {
                    redisCluster.setex(
                      redisKey,
                      process.env.REDIS_EXPIRATION_5MIN * 6,
                      JSON.stringify(result)
                    );
                    resMAIN(result);
                  },
                  (error) => {
                    //logger.info(error);
                    redisCluster.setex(
                      redisKey,
                      process.env.REDIS_EXPIRATION_5MIN * 6,
                      JSON.stringify(result)
                    );
                    resMAIN({
                      rides: 0,
                      deliveries: 0,
                      scheduled: 0,
                      accepted: 0,
                    });
                  }
                )
                .catch((error) => {
                  //logger.info(error);
                  redisCluster.setex(
                    redisKey,
                    process.env.REDIS_EXPIRATION_5MIN * 6,
                    JSON.stringify(result)
                  );
                  resMAIN({
                    rides: 0,
                    deliveries: 0,
                    scheduled: 0,
                    accepted: 0,
                  });
                });
            }
          },
          (error) => {
            //logger.info(error);
            new Promise((res0) => {
              getRequests_graphPreview_forDrivers(
                req.driver_fingerprint,
                collectionRidesDeliveries_data,
                collectionDrivers_profiles,
                res0
              );
            })
              .then(
                (result) => {
                  redisCluster.setex(
                    redisKey,
                    process.env.REDIS_EXPIRATION_5MIN * 6,
                    JSON.stringify(result)
                  );
                  resMAIN(result);
                },
                (error) => {
                  //logger.info(error);
                  redisCluster.setex(
                    redisKey,
                    process.env.REDIS_EXPIRATION_5MIN * 6,
                    JSON.stringify(result)
                  );
                  resMAIN({
                    rides: 0,
                    deliveries: 0,
                    scheduled: 0,
                    accepted: 0,
                  });
                }
              )
              .catch((error) => {
                //logger.info(error);
                redisCluster.setex(
                  redisKey,
                  process.env.REDIS_EXPIRATION_5MIN * 6,
                  JSON.stringify(result)
                );
                resMAIN({
                  rides: 0,
                  deliveries: 0,
                  scheduled: 0,
                  accepted: 0,
                });
              });
          }
        );
      } //Invalid params
      else {
        resMAIN({ rides: 0, deliveries: 0, scheduled: 0, accepted: 0 });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        //logger.info(error);
        resMAIN({ rides: 0, deliveries: 0, scheduled: 0, accepted: 0 });
      });
  });

  /**
   * RIDES OR DELIVERY DECOUPLED DISPATCHER
   * Responsible for redispatching already parsed requests.
   * @param requestStructured: already parsed request coming straight from Mongo
   */
  app.post("/redispatcherAlreadyParsedRequests", function (req, res) {
    req = req.body;
    new Promise((resInit) => {
      INIT_RIDE_DELIVERY_DISPATCH_ENTRY(
        req,
        collectionDrivers_profiles,
        collectionRidesDeliveries_data,
        resInit
      );
    }).then(
      (resultDispatch) => {
        //...
        res.send(resultDispatch);
      },
      (error) => {
        //logger.info(error);
        res.send({
          response: "Unable_to_redispatch_the_request",
        });
      }
    );
  });

  /**
   * @func ucFirst
   * Responsible to uppercase only the first character and lowercase the rest.
   * @param stringData: the string to be processed.
   */
  function ucFirst(stringData) {
    try {
      return `${stringData[0].toUpperCase()}${stringData.substr(1).toLowerCase()}`;
    } catch (error) {
      //logger.info(error);
      return stringData;
    }
  }

  /**
   * RIDES OR DELIVERY DISPATCHER
   * Responsible for sending staged ride or delivery requests to the drivers in the best position
   * of accepting it.
   * @param requestRawData: ride or delivery data coming from the rider's device for booking (MUST contain the city and country)
   */
  app.post("/dispatchRidesOrDeliveryRequests", function (req, res) {
    req = req.body;
    //TEST DATA
    // let testData = {
    //   actualRider: "someonelese",
    //   actualRiderPhone_number: "0817563369",
    //   carTypeSelected: "normalTaxiEconomy",
    //   connectType: "ConnectUs",
    //   country: "Namibia",
    //   destinationData: {
    //     passenger1Destination: {
    //       _id: "5f7e16126661813ab09e417f",
    //       averageGeo: -10.989369499999999,
    //       city: "Windhoek",
    //       coordinates: [-22.548558, 17.0504368],
    //       country: "Namibia",
    //       location_id: 242368923,
    //       location_name: "Grove Khomasdal Funky Town - Pequena Angola",
    //       query: "Grovr",
    //       state: "Khomas",
    //       street: false,
    //     },
    //     passenger2Destination: {
    //       _id: "5fc8dde588e09715d0df05ca",
    //       averageGeo: -5.491276299999999,
    //       city: "Windhoek",
    //       coordinates: [-22.5818168, 17.0878857],
    //       country: "Namibia",
    //       location_id: 1768699533,
    //       location_name: "Showground Parking Area",
    //       query: "Showg",
    //       state: "Khomas",
    //       street: "Jan Jonker Weg",
    //     },
    //     passenger3Destination: {
    //       _id: "5f7de487c6811253c83529b3",
    //       averageGeo: -10.975441900000003,
    //       city: "Windhoek",
    //       coordinates: [-22.56578, 17.0751551],
    //       country: "Namibia",
    //       location_id: 244132971,
    //       location_name: "NUST Main St",
    //       query: "Nust",
    //       state: "Khomas",
    //       street: false,
    //     },
    //     passenger4Destination: {
    //       _id: "5f7de491c6811253c83529f6",
    //       averageGeo: -11.1064516,
    //       city: "Windhoek",
    //       coordinates: [-22.6121691, 17.0233537],
    //       country: "Namibia",
    //       location_id: 6520901,
    //       location_name: "University of Namibia (UNAM)",
    //       query: "Unam",
    //       state: "Khomas",
    //       street: "Mandume Ndemufayo Avenue",
    //     },
    //   },
    //   fareAmount: 80,
    //   isAllGoingToSameDestination: false,
    //   naturePickup: "PrivateLocation",
    //   passengersNo: 4,
    //   pickupData: {
    //     city: "Windhoek",
    //     coordinates: [-22.5705005, 17.0809437],
    //     location_name: "Embassy of Brazil in Windhoek",
    //     street_name: "Simeon Shixungileni Steet",
    //   },
    //   pickupNote: "Hello world",
    //   receiverName_delivery: false,
    //   receiverPhone_delivery: false,
    //   rideType: "RIDE",
    //   timeScheduled: "immediate",
    //   paymentMethod: "CASH",
    //   user_fingerprint:
    //     "5b29bb1b9ac69d884f13fd4be2badcd22b72b98a69189bfab806dcf7c5f5541b6cbe8087cf60c791",
    // };
    // req = testData;
    //...
    if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
      //1. CHECK THAT THIS RIDER DOESN'T ALREADY HAVE AN ACTIVE RIDE/DELIVERY
      //Request is considered as completed when the rider has submited a rating.
      let checkPrevRequest = {
        client_id: req.user_fingerprint,
        isArrivedToDestination: false,
      }; //?Indexed
      collectionRidesDeliveries_data
        .find(checkPrevRequest)
        .toArray(function (err, prevRequest) {
          //! PLANS QUOTAS
          //! Batches
          let QUOTAS_BATCHES = {
            STR: 1,
            ITMD: 15,
            PR: 50,
            PRSNLD: 100,
          };

          //! Set a dynamic limit to the number of simulataneaous requests - BATCH
          //? normal :0
          //? corporate: 5
          let simulataneaousRequestsLimit = /normal/i.test(
            req.request_globality
          )
            ? 0
            : QUOTAS_BATCHES[req.subscribed_plan];
          //! ----
          if (
            prevRequest === undefined ||
            prevRequest === null ||
            prevRequest.length <= simulataneaousRequestsLimit - 1 ||
            prevRequest[0] === undefined
          ) {
            //No previous pending request - MAKE REQUEST VALID
            //Parse the data
            new Promise((res) => {
              parseRequestData(req, res);
            }).then(
              (result) => {
                logger.warn(result);
                let parsedRequest = result;
                if (result !== false) {
                  //! IF WALLET SELECTED - CHECK THE BALANCE, it should be >= to the trip fare, else ERROR_UNSIFFICIENT_FUNDS
                  if (/wallet/i.test(result.payment_method)) {
                    //? WALLET PAYMENT METHOD
                    let url = /normal/i.test(parsedRequest.request_globality)
                      ? `
                      ${
                        /production/i.test(process.env.EVIRONMENT)
                          ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                          : process.env.LOCAL_URL
                      }:${
                          process.env.ACCOUNTS_SERVICE_PORT
                        }/getRiders_walletInfos?user_fingerprint=${
                          req.user_fingerprint
                        }&mode=total&avoidCached_data=true
                      `
                      : `
                      ${
                        /production/i.test(process.env.EVIRONMENT)
                          ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                          : process.env.LOCAL_URL
                      }:${
                          process.env.ACCOUNTS_SERVICE_PORT
                        }/getWalletSummaryForCorps?company_fp=${
                          req.user_fingerprint
                        }&avoidCache=true
                      `;
                    //!----
                    requestAPI(url, function (error, response, body) {
                      logger.info(body);
                      logger.error(error);
                      if (error === null) {
                        try {
                          body = JSON.parse(body);
                          body["total"] =
                            body.total !== undefined && body.total !== null
                              ? body.total
                              : body.balance; //Balance for the corporate accounts and total for the normal accounts.
                          //...
                          if (body.total !== undefined) {
                            logger.info(body);

                            if (
                              parseFloat(result.fare) <= parseFloat(body.total)
                            ) {
                              //? HAS ENOUGH MONEY IN THE WALLET
                              /*logger.info(
                                      "Has enough funds in the wallet"
                                    );*/
                              new Promise((resInit) => {
                                INIT_RIDE_DELIVERY_DISPATCH_ENTRY(
                                  result,
                                  collectionDrivers_profiles,
                                  collectionRidesDeliveries_data,
                                  resInit
                                );
                              }).then(
                                (resultDispatch) => {
                                  if (
                                    /successfully_requested/i.test(
                                      resultDispatch.response
                                    )
                                  ) {
                                    //? CHECK IF IT'S A DELIVERY REQUEST TO NOTIFY THE RECEIVER
                                    if (
                                      /delivery/i.test(parsedRequest.ride_mode)
                                    ) {
                                      //Delivery
                                      new Promise((resNotifyReceiver) => {
                                        let receiversPhone =
                                          parsedRequest.delivery_infos.receiverPhone_delivery.replace(
                                            "+",
                                            ""
                                          );
                                        let receiverName = ucFirst(
                                          parsedRequest.delivery_infos.receiverName_delivery.trim()
                                        );
                                        let message = `Hello ${receiverName}, a package is being delivered to you via TaxiConnect, you can track it by creating a TaxiConnect account with your current number.\n\nThe TaxiConnect teams.`;
                                        //!Check if the receiver is a current user
                                        collectionPassengers_profiles
                                          .find({
                                            phone_number:
                                              parsedRequest.delivery_infos.receiverPhone_delivery.trim(),
                                          })
                                          .toArray(function (
                                            err,
                                            userReceiverData
                                          ) {
                                            if (err) {
                                              resNotifyReceiver(false);
                                            }
                                            //...
                                            if (
                                              userReceiverData !== undefined &&
                                              userReceiverData.length > 0
                                            ) {
                                              //Is a TaxiConnect user, check for how long the app has not been used.
                                              resolveDate();
                                              if (
                                                userReceiverData.last_updated !==
                                                  undefined &&
                                                userReceiverData.last_updated !==
                                                  null
                                              ) {
                                                //Check the time
                                                let lastUserUpdated = new Date(
                                                  userReceiverData.last_updated
                                                );
                                                let refNowDate = new Date(
                                                  chaineDateUTC
                                                );
                                                //...
                                                if (
                                                  diff_hours(
                                                    refNowDate,
                                                    lastUserUpdated
                                                  ).difference >
                                                  7 * 24
                                                ) {
                                                  //If greater than 7 days - send SMS
                                                  SendSMSTo(
                                                    receiversPhone,
                                                    message
                                                  );
                                                  resNotifyReceiver(true);
                                                } //Send push notification
                                                else {
                                                  let messageNotify = {
                                                    app_id:
                                                      process.env
                                                        .RIDERS_APP_ID_ONESIGNAL,
                                                    android_channel_id:
                                                      process.env
                                                        .RIDERS_ONESIGNAL_CHANNEL_ACCEPTTEDD_REQUEST, //Ride - Accepted request
                                                    priority: 10,
                                                    contents: {
                                                      en: message,
                                                    },
                                                    headings: {
                                                      en: "Delivery in progress",
                                                    },
                                                    content_available: true,
                                                    include_player_ids: [
                                                      userReceiverData.pushnotif_token !==
                                                        false &&
                                                      userReceiverData.pushnotif_token !==
                                                        null &&
                                                      userReceiverData.pushnotif_token !==
                                                        "false"
                                                        ? userReceiverData
                                                            .pushnotif_token
                                                            .userId
                                                        : null,
                                                    ],
                                                  };
                                                  //Send
                                                  sendPushUPNotification(
                                                    messageNotify
                                                  );
                                                  resNotifyReceiver(true);
                                                }
                                              } //Send an SMS, not logged in yet
                                              else {
                                                SendSMSTo(
                                                  receiversPhone,
                                                  message
                                                );
                                                resNotifyReceiver(true);
                                              }
                                            } //Not a TaxiConnect user, Send an SMS
                                            else {
                                              SendSMSTo(
                                                receiversPhone,
                                                message
                                              );
                                              resNotifyReceiver(true);
                                            }
                                          });
                                      })
                                        .then()
                                        .catch(() => {});
                                    }
                                  }
                                  //...
                                  res.send(resultDispatch);
                                },
                                (error) => {
                                  //logger.info(error);
                                  res.send({
                                    response: "Unable_to_make_the_request",
                                  });
                                }
                              );
                            } //Not enough money in the wallet
                            else {
                              /*logger.info(
                                      "Has NOT enough funds in the wallet"
                                    );*/
                              res.send({
                                response:
                                  "Unable_to_make_the_request_unsufficient_funds",
                              });
                            }
                          } //Error getting wallet amount
                          else {
                            res.send({
                              response:
                                "Unable_to_make_the_request_error_wallet_check",
                            });
                          }
                        } catch (error) {
                          //logger.info(error);
                          res.send({
                            response:
                              "Unable_to_make_the_request_error_wallet_check",
                          });
                        }
                      } else {
                        res.send({
                          response:
                            "Unable_to_make_the_request_error_wallet_check",
                        });
                      }
                    });
                  } //? CASH PAYMENT METHOD
                  else {
                    //Do as usual without a wallet balance check
                    new Promise((resInit) => {
                      INIT_RIDE_DELIVERY_DISPATCH_ENTRY(
                        result,
                        collectionDrivers_profiles,
                        collectionRidesDeliveries_data,
                        resInit
                      );
                    }).then(
                      (resultDispatch) => {
                        res.send(resultDispatch);
                      },
                      (error) => {
                        //logger.info(error);
                        res.send({
                          response: "Unable_to_make_the_request",
                        });
                      }
                    );
                  }
                } //Error
                else {
                  res.send({ response: "Unable_to_make_the_request" });
                }
              },
              (error) => {
                //logger.info(error);
                res.send({ response: "Unable_to_make_the_request" });
              }
            );
          } //Has a previous uncompleted ride
          else {
            res.send({ response: "already_have_a_pending_request" });
          }
        });
    } //Invalid user fp
    else {
      res.send({ response: "Unable_to_make_the_request" });
    }
  });

  /**
   * CONFIRM RIDER DROP OFF
   * Responsible for handling all the processes related to the drop off confirmation of a rider.
   */
  app.post("/confirmRiderDropoff_requests", function (req, res) {
    req = req.body;
    //logger.info(req);
    //TEST data
    /*req = {
              user_fingerprint:
                "7c57cb6c9471fd33fd265d5441f253eced2a6307c0207dea57c987035b496e6e8dfa7105b86915da",
              dropoff_compliments: {
                neatAndTidy: false,
                excellentService: true,
                greatMusic: false,
                greatConversation: false,
                expertNavigator: true,
              },
              dropoff_personal_note: "Very good experience",
              rating_score: 5,
              request_fp:
                "87109d03cab8bc5032a71683e084551107f1c1bafb5136f6ee5a7c990550b81ef3ecf5c96b13f2afde2cc75e6c8187ce290c973dd1e8d137caf27fee334a68e8",
            };*/

    //Do basic checking
    if (
      req.user_fingerprint !== undefined &&
      req.user_fingerprint !== null &&
      req.request_fp !== undefined &&
      req.request_fp !== null
    ) {
      //Auto assign 5 stars if invalid score found
      req.rating_score =
        req.rating_score === undefined ||
        req.rating_score === null ||
        req.rating_score < 0
          ? 5
          : req.rating_score > 5
          ? 2
          : req.rating_score; //Driver's rating safety shield - give 2 stars for fraudulous dropoffs
      //...
      new Promise((res0) => {
        confirmDropoff_fromRider_side(
          req,
          collectionRidesDeliveries_data,
          collectionDrivers_profiles,
          res0
        );
      }).then(
        (result) => {
          res.send(result);
        },
        (error) => {
          //logger.info(error);
          res.send({ response: "error" });
        }
      );
    }
  });

  /**
   * CANCEL RIDER REQUESTS
   * Responsible for cancelling the rider's requests and all it's the related process
   */
  app.post("/cancelRiders_request", function (req, res) {
    new Promise((resCompute) => {
      req = req.body;
      //logger.info(req);
      //Do basic checking
      if (
        req.user_fingerprint !== undefined &&
        req.user_fingerprint !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
      ) {
        let RIDE_REDIS_KEY = `${req.user_fingerprint}-rideDeliveryMade-holder`;
        //? Add a flag if provided: the flag can be used to know who cancelled the request, if not provided, - it's the rider
        let additionalData = {
          flag: req.flag !== undefined && req.flag !== null ? req.flag : null,
        };
        //...
        new Promise((res0) => {
          cancelRider_request(
            req,
            collectionRidesDeliveries_data,
            collection_cancelledRidesDeliveryData,
            collectionDrivers_profiles,
            res0,
            additionalData
          );
        }).then(
          (result) => {
            //? Remove the redis key for the ride
            redisCluster.del(RIDE_REDIS_KEY);
            //...
            resCompute(result);
          },
          (error) => {
            logger.info(error);
            resCompute({ response: "error_cancelling" });
          }
        );
      } //Invalid parameters
      else {
        resCompute({ response: "error_cancelling" });
      }
    })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        logger.warn(error);
        res.send({ response: "error_cancelling" });
      });
  });

  /**
   * DECLINE REQUESTS - DRIVERS
   * Responsible for handling the declining of requests from the drivers side.
   */
  app.post("/decline_request", function (req, res) {
    req = req.body;
    //logger.info(req);

    //Do basic checking
    if (
      req.driver_fingerprint !== undefined &&
      req.driver_fingerprint !== null &&
      req.request_fp !== undefined &&
      req.request_fp !== null
    ) {
      //...
      new Promise((res0) => {
        declineRequest_driver(req, res0);
      }).then(
        (result) => {
          res.send(result);
        },
        (error) => {
          //logger.info(error);
          res.send({ response: "unable_to_decline_request_error" });
        }
      );
    }
  });

  /**
   * ACCEPT REQUESTS - DRIVERS
   * Responsible for handling the accepting of requests from the drivers side.
   */
  app.post("/accept_request", function (req, res) {
    //...
    req = req.body;
    //logger.info(req);

    //Do basic checking
    if (
      req.driver_fingerprint !== undefined &&
      req.driver_fingerprint !== null &&
      req.request_fp !== undefined &&
      req.request_fp !== null
    ) {
      //...
      new Promise((res0) => {
        acceptRequest_driver(req, res0);
      }).then(
        (result) => {
          //...
          res.send(result);
        },
        (error) => {
          //logger.info(error);
          res.send({ response: "unable_to_accept_request_error" });
        }
      );
    }
  });

  /**
   * CANCEL REQUESTS - DRIVERS
   * Responsible for handling the cancelling of requests from the drivers side.
   */
  app.post("/cancel_request_driver", function (req, res) {
    //...
    req = req.body;
    logger.info(req);

    //Do basic checking
    if (
      req.driver_fingerprint !== undefined &&
      req.driver_fingerprint !== null &&
      req.request_fp !== undefined &&
      req.request_fp !== null
    ) {
      //...
      // res.send({ response: "unable_to_cancel_request_error" });
      new Promise((res0) => {
        cancelRequest_driver(req, res0);
      }).then(
        (result) => {
          res.send(result);
        },
        (error) => {
          logger.info(error);
          res.send({ response: "unable_to_cancel_request_error" });
        }
      );
    }
  });

  /**
   * CONFIRM PICKUP REQUESTS - DRIVERS (CAN ALSO BE USED FOR RIDERS NEWER VERSION)
   * Responsible for handling the pickup confirmation of requests from the drivers side.
   */
  app.post("/confirm_pickup_request_driver", function (req, res) {
    //DEBUG
    /*req.body = {
              driver_fingerprint:
                "23c9d088e03653169b9c18193a0b8dd329ea1e43eb0626ef9f16b5b979694a429710561a3cb3ddae",
              request_fp:
                "999999f5c51c380ef9dee9680872a6538cc9708ef079a8e42de4d762bfa7d49efdcde41c6009cbdd9cdf6f0ae0544f74cb52caa84439cbcda40ce264f90825e8",
            };*/
    //...
    req = req.body;
    //logger.info(req);

    //Do basic checking
    if (
      // req.driver_fingerprint !== undefined &&
      // req.driver_fingerprint !== null &&
      req.request_fp !== undefined &&
      req.request_fp !== null
    ) {
      //...
      new Promise((res0) => {
        confirmPickupRequest_driver(
          req,
          collectionRidesDeliveries_data,
          collectionGlobalEvents,
          collectionDrivers_profiles,
          res0
        );
      }).then(
        (result) => {
          res.send(result);
        },
        (error) => {
          //logger.info(error);
          res.send({
            response: "unable_to_confirm_pickup_request_error",
          });
        }
      );
    }
  });

  /**
   * CONFIRM DROPOFF REQUESTS - DRIVERS
   * Responsible for handling the dropoff confirmation of requests from the drivers side.
   */
  app.post("/confirm_dropoff_request_driver", function (req, res) {
    //DEBUG
    /*req.body = {
        driver_fingerprint:
          "23c9d088e03653169b9c18193a0b8dd329ea1e43eb0626ef9f16b5b979694a429710561a3cb3ddae",
        request_fp:
          "999999f5c51c380ef9dee9680872a6538cc9708ef079a8e42de4d762bfa7d49efdcde41c6009cbdd9cdf6f0ae0544f74cb52caa84439cbcda40ce264f90825e8",
      };*/
    //...
    req = req.body;
    //logger.info(req);

    //Do basic checking
    if (
      req.driver_fingerprint !== undefined &&
      req.driver_fingerprint !== null &&
      req.request_fp !== undefined &&
      req.request_fp !== null
    ) {
      //...
      new Promise((res0) => {
        confirmDropoffRequest_driver(
          req,
          collectionRidesDeliveries_data,
          collectionGlobalEvents,
          collectionPassengers_profiles,
          collectionDrivers_profiles,
          res0
        );
      }).then(
        (result) => {
          res.send(result);
        },
        (error) => {
          //logger.info(error);
          res.send({
            response: "unable_to_confirm_dropoff_request_error",
          });
        }
      );
    }
  });
});

server.listen(process.env.DISPATCH_SERVICE_PORT);
