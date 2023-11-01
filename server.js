require('newrelic');
require('dotenv').config();

var express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
var otpGenerator = require('otp-generator');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const Redis = require('./Utility/redisConnector');

const { logger } = require('./LogService');
const { sendSMS, uploadBase64ToS3 } = require('./Utility/Utils');
const AWS = require('aws-sdk');
const _ = require('lodash');

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_S3_ID,
    secretAccessKey: process.env.AWS_S3_SECRET,
});

const dynamoose = require('dynamoose');

var app = express();
var server = http.createServer(app);
var cors = require('cors');
var helmet = require('helmet');
const requestAPI = require('request');

var jwt = require('jsonwebtoken');

const nodemailer = require('nodemailer');

let transporterChecks = nodemailer.createTransport({
    host: process.env.INOUT_GOING_SERVER,
    port: process.env.LOGIN_EMAIL_SMTP,
    secure: true, // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_CHECK, // generated ethereal user
        pass: process.env.EMAIL_CHECK_PASSWORD, // generated ethereal password
    },
});

const ddb = new dynamoose.aws.ddb.DynamoDB({
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    region: process.env.AWS_REGION,
});

// Set DynamoDB instance to the Dynamoose DDB instance
dynamoose.aws.ddb.set(ddb);

//! Attach DynamoDB helper
const {
    dynamo_insert,
    dynamo_update,
    dynamo_find_query,
    dynamo_delete,
    dynamo_get_all,
} = require('./DynamoServiceManager');
//....

const redis = require('redis');
let dateObject;
var chaineDateUTC = null;
const moment = require('moment');

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

var AWS_SMS = require('aws-sdk');
const UserModel = require('./models/UserModel');
const OTPModel = require('./models/OTPModel');
const { default: axios } = require('axios');
const {
    getUserLocationInfos,
    getSearchedLocations,
} = require('./searchService');
const RequestsModel = require('./models/RequestsModel');
const DriversModel = require('./models/DriversModel');
const StoreModel = require('./models/StoreModel');
const { presignS3URL } = require('./Utility/PresignDocs');
const {
    storeTimeStatus,
    searchProducts,
    uploadToS3,
} = require('./Utility/Utils');
const CatalogueModel = require('./models/CatalogueModel');
const { processCourierDrivers_application } = require('./serverAccounts');

function SendSMSTo(phone_number, message) {
    // Load the AWS SDK for Node.js
    AWS_SMS.config.update({ region: 'us-east-1' });

    // Create publish parameters
    var params = {
        Message: 'TEXT_MESSAGE' /* required */,
        PhoneNumber: '264856997167',
        // attributes: {
        //   SMSType: "Transactional",
        // },
    };

    // Create promise and SNS service object
    return new AWS_SMS.SNS({
        apiVersion: '2010-03-31',
        // sslEnabled: false,
        // maxRetries: 10,
    })
        .publish(params)
        .promise();
}

/**
 * Responsible for sending push notification to devices
 */
var sendPushUPNotification = function (data) {
    //logger.info("Notify data");
    //logger.info(data);
    var headers = {
        'Content-Type': 'application/json; charset=utf-8',
    };

    var options = {
        host: 'onesignal.com',
        port: 443,
        path: '/api/v1/notifications',
        method: 'POST',
        headers: headers,
    };

    var https = require('https');
    var req = https.request(options, function (res) {
        res.on('data', function (data) {
            ////logger.info("Response:");
        });
    });

    req.on('error', function (e) {});

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
                'sha512WithRSAEncryption',
                'NEJBASICKEYFINGERPRINTS-RIDES-DELIVERY'
            )
            .update(str)
            .digest('hex');
        resolve(fingerprint);
    } else if (/md5/i.test(encryption)) {
        fingerprint = crypto
            .createHmac(
                'md5WithRSAEncryption',
                'NEJBASICKEYFINGERPRINTS-RIDES-DELIVERY'
            )
            .update(str)
            .digest('hex');
        resolve(fingerprint);
    } //Other - default
    else {
        fingerprint = crypto
            .createHmac('sha256', 'NEJBASICKEYFINGERPRINTS-RIDES-DELIVERY')
            .update(str)
            .digest('hex');
        resolve(fingerprint);
    }
}

//EVENT GATEWAY PORT

/**
 * @func getStores
 * Will get all the stores available and their closing times relative to now.
 * @param resolve
 */
const getStores = async () => {
    try {
        let redisKey = 'get-stores';

        const stores = await StoreModel.scan().all().exec();

        if (stores.length > 0) {
            const STORES_MODEL = (
                await Promise.all(
                    stores.map(async (store) => {
                        if (store.publish) {
                            logger.info(store);
                            let logo;
                            try {
                                logo = await presignS3URL(store.shop_logo);
                            } catch (error) {
                                logger.error(error);
                                logo = 'logo.png';
                            }
                            let tmpStore = {
                                name: store.name,
                                fd_name: store.friendly_name,
                                type: store.shop_type,
                                description: store.description,
                                background: store.shop_background_color,
                                border: store.border_color,
                                logo,
                                fp: store.id,
                                structured: store.structured_shopping,
                                times: {
                                    target_state: null, //two values: opening or closing
                                    string: null, //something like: opening in ...min or closing in ...h
                                },
                                date_added: new Date(store.createdAt).getTime(),
                            };
                            //...
                            tmpStore.times.string = storeTimeStatus(
                                store.opening_time,
                                store.closing_time
                            );
                            //? DONE - SAVE
                            return tmpStore;
                        } else {
                            return null;
                        }
                    })
                )
            ).filter((el) => el);
            //...
            //! Cache
            Redis.set(
                redisKey,
                JSON.stringify(STORES_MODEL),
                'EX',
                parseInt(process.env.REDIS_EXPIRATION_5MIN) * 5
            );

            return { response: STORES_MODEL };
        } else {
            return { response: [] };
        }
    } catch (error) {
        logger.error(error);
        return { response: [] };
    }
};

/**
 * @func getCatalogueFor
 * Get all the products for a specific store
 * @param req: store infos
 * @param resolve
 */
const getCatalogueFor = async (body) => {
    let redisKey = `${JSON.stringify(body)}-catalogue`;

    let cachedData = await Redis.get(redisKey);

    if (cachedData) {
        cachedData = JSON.parse(cachedData);
    } else {
        cachedData = [];
    }

    const { store: storeFp, category, subcategory, structured } = body;

    const shop = await StoreModel.get(storeFp);

    if (!shop) return { response: {}, store: null };

    const storeData = shop;

    let reformulateQuery;

    //Level 1
    if (category) {
        reformulateQuery = CatalogueModel.query('shop_fp')
            .eq(storeFp)
            .filter('category')
            .eq(category.toUpperCase().trim());
    } else {
        reformulateQuery = CatalogueModel.query('shop_fp').eq(storeFp);
    }

    //Level 2 - Add subcategory
    if (subcategory) {
        reformulateQuery = reformulateQuery
            .filter('subcategory')
            .eq(subcategory.toUpperCase().trim());
    }

    const catalogue =
        cachedData.length > 0 ? cachedData : await reformulateQuery.exec();
    const productsData = catalogue;

    if (cachedData.length <= 0) {
        Redis.set(redisKey, JSON.stringify(productsData), 'EX', 3600);
    }

    if (productsData?.count > 0 || productsData?.length > 0) {
        //Has data
        //Reformat the data
        let reformatted_data = productsData.map((product, index) => {
            let tmpData = {
                index: index,
                name: product.product_name,
                price: product.product_price.replace('R', 'N$'),
                pictures: [product.product_picture],
                sku: product.sku,
                meta: {
                    category: product.category,
                    subcategory: product.subcategory,
                    store: product.shop_name,
                    store_fp: storeFp,
                    structured: storeData.structured_shopping,
                },
            };
            //...
            return tmpData;
        });
        //...
        //! Reorganize based on if the data is structured
        if (structured) {
            let structured = {};
            reformatted_data.map((p) => {
                if (
                    structured[p.meta.category] !== undefined &&
                    structured[p.meta.category] !== null
                ) {
                    //Already set
                    structured[p.meta.category].push(p);
                    //! Shuffle
                    structured[p.meta.category] = shuffle(
                        structured[p.meta.category]
                    );
                    //! Always limit to 3
                    structured[p.meta.category] = structured[
                        p.meta.category
                    ].slice(0, 3);
                } //Not yet set
                else {
                    structured[p.meta.category] = [];
                    structured[p.meta.category].push(p);
                }
            });
            //....
            return { response: structured, store: storeFp };
        } //Unstructured data
        else {
            return { response: reformatted_data, store: storeFp };
        }
    } //No products
    else {
        return { response: {}, store: storeFp };
    }
};

//? ARRAY SHUFFLER
function shuffle(array) {
    let currentIndex = array.length,
        randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex != 0) {
        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex],
            array[currentIndex],
        ];
    }

    return array;
}

/**
 * @func getRequestDataClient
 * responsible for getting the realtime shopping requests for clients.
 * @param requestData: user_identifier mainly
 * @param resolve
 */
const getRequestDataClient = async (requestData) => {
    const { user_identifier } = requestData;

    const requests = await RequestsModel.query('client_id')
        .eq(user_identifier)
        .filter('date_completedDropoff')
        .not()
        .exists()
        .filter('date_cancelled')
        .not()
        .exists()
        .exec();

    if (requests.count > 0) {
        const shoppingData = requests[0];

        //!1. SHOPPING DATA or DELIVERY DATA
        if (
            shoppingData['ride_mode'].toUpperCase() === 'SHOPPING' ||
            shoppingData['ride_mode'].toUpperCase() === 'DELIVERY'
        ) {
            //Has a pending shopping
            let RETURN_DATA_TEMPLATE = {
                ride_mode: shoppingData['ride_mode'].toUpperCase(),
                request_fp: shoppingData.id,
                client_id: requestData.user_identifier, //the user identifier - requester
                driver_details: {}, //Will hold the details of the shopper
                shopping_list: shoppingData.shopping_list, //The list of items to shop for
                payment_method: shoppingData.payment_method, //mobile_money or cash
                trip_locations: shoppingData.locations, //Has the pickup and delivery locations
                totals_request: shoppingData.totals_request, //Has the cart details in terms of fees
                request_type: shoppingData.request_type, //scheduled or immediate
                state_vars: shoppingData.request_state_vars,
                ewallet_details: {
                    phone: '+264856997167',
                    security: shoppingData?.security
                        ? shoppingData.security
                        : 'None',
                },
                date_requested: shoppingData.createdAt, //The time of the request
            };
            //..Get the shopper's infos
            if (shoppingData?.shopper_id !== 'false') {
                const shopper = await DriversModel.query('id')
                    .eq(shoppingData.shopper_id)
                    .exec();
                if (shopper.count > 0) {
                    //Has a shopper
                    let driverData = shopper[0];

                    RETURN_DATA_TEMPLATE.driver_details = {
                        name: driverData.name,
                        picture: driverData.identification_data.profile_picture,
                        rating: driverData.identification_data.rating,
                        phone: driverData.phone_number,
                        vehicle: {
                            picture: driverData.taxi_picture,
                            brand: driverData.car_brand,
                            plate_no: driverData.plate_number,
                            taxi_number: driverData.taxi_number,
                        },
                    };
                } //No shoppers yet
                else {
                    RETURN_DATA_TEMPLATE.driver_details = {
                        name: null,
                        phone: null,
                        picture: null,
                    };
                }
            } else {
                RETURN_DATA_TEMPLATE.driver_details = {
                    name: null,
                    phone: null,
                    picture: null,
                };
            }

            return [RETURN_DATA_TEMPLATE];
        } else {
            return false;
        }
    }
    //No pending shoppings
    else {
        return false;
    }
};

//Get output standardazed user data format
//@param userData in JSON
function getOutputStandardizedUserDataFormat(userData) {
    let RETURN_DATA_TEMPLATE = {
        name: userData.name,
        surname: userData.surname,
        gender: userData.gender,
        account_state: userData.account_state,
        profile_picture: `${process.env.AWS_S3_CLIENTS_PROFILES_PATH}/clients_profiles/${userData.media.profile_picture}`,
        account_verifications: {
            is_verified: userData.account_verifications.is_accountVerified,
        },
        phone: userData.phone_number,
        email: userData.email,
        user_identifier: userData.user_identifier,
    };
    //...
    return RETURN_DATA_TEMPLATE;
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
 * @func shouldSendNewSMS
 * Responsible for figuring out if the system is allowed to send new SMS to a specific number
 * based on the daily limit that the number has ~ 10SMS per day.
 * @param req: the request data containing the user's phone number : ATTACH THE _id if HAS AN ACCOUNT
 * @param hasAccount: true (is an existing user) or false (do not have an account yet)
 * @param resolve
 */
const shouldSendNewSMS = async (user, phone_number, isDriver = false) => {
    const DAILY_THRESHOLD = parseInt(process.env.DAILY_SMS_THRESHOLD_PER_USER);

    let onlyDigitsPhone = phone_number.replace('+', '').trim();
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
    let message = `Your DulcetDash code is ${otp}. Never share this code.`;

    if (!user) {
        logger.warn(message);
        const didSentSMS = true;
        // const didSentSMS = await sendSMS(message, phone_number);

        if (!didSentSMS) return false;

        //New user
        await OTPModel.create({
            id: uuidv4(),
            phone_number: phone_number,
            otp: parseInt(otp),
        });
        return true;
    } //Existing user
    else {
        logger.error(message);
        const startOfDay = moment().startOf('day').valueOf(); // Start of today
        const endOfDay = moment().endOf('day').valueOf(); // End of today

        const otpData = await OTPModel.query('phone_number')
            .eq(user.phone_number)
            .filter('createdAt')
            .between(startOfDay, endOfDay)
            .exec();

        if (otpData.count <= DAILY_THRESHOLD) {
            //Can still send the SMS
            const didSentSMS = true;
            // const didSentSMS = await sendSMS(message, phone_number);

            if (!didSentSMS) return false;

            await OTPModel.create({
                id: uuidv4(),
                phone_number: user.phone_number,
                otp: parseInt(otp),
            });

            if (!isDriver) {
                await UserModel.update(
                    { id: user.id },
                    {
                        otp: parseInt(otp),
                    }
                );
            } //Driver
            else {
                await DriversModel.update(
                    { id: user.id },
                    {
                        otp: parseInt(otp),
                    }
                );
            }

            return true;
        } else {
            //!Exceeded the daily SMS request
            return false;
        }
    }
};

/**
 * @func getRecentlyVisitedShops
 * Responsible to get the 3 latest visited shops by the user
 * @param user_identifier: the request data including the user_identifier
 * @param redisKey: the redis key to which the results will be cached.
 * @param resolve
 */
const getRecentlyVisitedShops = async (user_identifier, redisKey) => {
    let cachedData = await Redis.get(redisKey);

    if (cachedData) {
        return JSON.parse(cachedData);
    }

    //1. Get all the requests made by the user
    const requests = await RequestsModel.query('client_id')
        .eq(user_identifier)
        .exec();
    let requestData = requests;

    if (requests.count > 0) {
        //Has some requests
        //?1. Reformat the dates
        requestData = requestData.map((request) => {
            request.date_requested = new Date(request.date_requested);
            return request;
        });
        //?2. Sort in descending order
        requestData.sort((a, b) =>
            a.date_requested > b.date_requested
                ? -1
                : b.date_requested > a.date_requested
                ? 1
                : 0
        );
        //?3. Only take the shopping requests
        requestData = requestData.filter(
            (el) => el.ride_mode.toLowerCase().trim() === 'shopping'
        );
        //?4. Only take the 2 first
        requestData = requestData.slice(0, 1);

        //! Get the stores
        const storesFP = [
            ...new Set(
                requestData
                    .map((request) => {
                        const tmp = request.shopping_list.map((shop) => ({
                            store_id: shop.meta.store_fp,
                            createdAt: request.createdAt,
                        }));
                        return tmp;
                    })
                    .flat()
            ),
        ];

        const stores = (
            await Promise.all(
                storesFP.map(async (request) => {
                    const store = await StoreModel.get(request.store_id);

                    if (!store) return false;

                    const logo = await presignS3URL(store.shop_logo);

                    let tmpStore = {
                        name: store.name,
                        fd_name: store.friendly_name,
                        type: store.shop_type,
                        description: store.description,
                        background: store.shop_background_color,
                        border: store.border_color,
                        logo,
                        fp: store.id,
                        structured: store.structured_shopping,
                        times: {
                            target_state: null, //two values: opening or closing
                            string: null, //something like: opening in ...min or closing in ...h
                        },
                        date_added: new Date(request.createdAt).getTime(),
                        date_requested_from_here: request.createdAt,
                    };

                    tmpStore.times.string = storeTimeStatus(
                        store.opening_time,
                        store.closing_time
                    );

                    return tmpStore;
                })
            )
        ).filter((el) => el);

        //?6. Sort based on when the user requested from here
        stores.sort((a, b) =>
            a.date_requested_from_here > b.date_requested_from_here
                ? -1
                : b.date_requested_from_here > a.date_requested_from_here
                ? 1
                : 0
        );
        //?7. Cache
        let response = { response: stores };

        Redis.set(redisKey, JSON.stringify(response), 'EX', 5 * 60);

        return response;
    } //No requests
    else {
        let response = { response: [] };
        Redis.set(redisKey, JSON.stringify(response), 'EX', 5 * 60);
        return response;
    }
};

/**
 * @func getRequestListDataUsers
 * Responsible for getting the request list for the users
 */
const getRequestListDataUsers = async (user_identifier) => {
    const requests = await RequestsModel.query('client_id')
        .eq(user_identifier)
        .exec();

    if (requests.count > 0) {
        //Has some requests

        const RETURN_DATA_TEMPLATE = requests.map((request) => {
            let tmpRequest = {
                request_type: request.ride_mode,
                date_requested: request.date_requested,
                locations: request.locations,
                shopping_list:
                    request.ride_mode.toLowerCase() === 'shopping'
                        ? request.shopping_list
                        : null,
                cancelled: !!request.date_cancelled,
                createdAt: request.createdAt,
            };
            return tmpRequest;
        });
        //...

        return { response: RETURN_DATA_TEMPLATE };
    } else {
        return { response: [] };
    }
};

/**
 * @func updateRidersPushNotifToken
 * Responsible for updating the push notification token for the riders or drivers
 * @param req: request data
 * @param redisKey: the key to cache the  data  to
 * @param resolve
 */
function updateRidersPushNotifToken(req, redisKey, resolve) {
    resolveDate();
    //Assemble the get expression based on the user nature
    let getExpression =
        req.user_nature === 'rider'
            ? {
                  table_name: 'users_central',
                  IndexName: 'user_identifier',
                  KeyConditionExpression: 'user_identifier = :val1',
                  ExpressionAttributeValues: {
                      ':val1': req.user_identifier,
                  },
              }
            : {
                  table_name: 'drivers_shoppers_central',
                  IndexName: 'driver_fingerprint',
                  KeyConditionExpression: 'driver_fingerprint = :val1',
                  ExpressionAttributeValues: {
                      ':val1': req.user_identifier,
                  },
              };

    //Get the user data first
    dynamo_find_query(getExpression)
        .then((userData) => {
            if (userData !== undefined && userData.length > 0) {
                //Valid user
                userData = userData[0];

                //Assemble the update expression
                let updateExpressionRequest =
                    req.user_nature === 'rider'
                        ? {
                              table_name: 'users_central',
                              _idKey: userData.id,
                              UpdateExpression:
                                  'set pushnotif_token = :val1, last_updated = :val2',
                              ExpressionAttributeValues: {
                                  ':val1': req.pushnotif_token,
                                  ':val2': new Date(
                                      chaineDateUTC
                                  ).toISOString(),
                              },
                          }
                        : {
                              table_name: 'drivers_shoppers_central',
                              _idKey: userData.id,
                              UpdateExpression:
                                  'set operational_state.pushnotif_token = :val1, date_updated = :val2',
                              ExpressionAttributeValues: {
                                  ':val1': req.pushnotif_token,
                                  ':val2': new Date(
                                      chaineDateUTC
                                  ).toISOString(),
                              },
                          };
            } //Not a user?
            else {
                resolve({ response: 'error' });
            }
        })
        .catch((error) => {
            logger.error(error);
            resolve({ response: 'error' });
        });
}

//S3 COPY files
function copyFile(s3Params) {
    return s3.copyObject(s3Params).promise();
}

//Check if it's today
const isToday = (someDate) => {
    const today = new Date(chaineDateUTC);
    return (
        someDate.getDate() == today.getDate() &&
        someDate.getMonth() == today.getMonth() &&
        someDate.getFullYear() == today.getFullYear()
    );
};

//Get the sum of today for the requests
const getAmountsSums = ({ arrayRequests = [], dataType = 'sales' }) => {
    switch (dataType) {
        case 'sales':
            return arrayRequests
                .filter((el) => isToday(new Date(el.date_requested)))
                .map((el) =>
                    el.totals_request.fare !== undefined
                        ? parseFloat(el.totals_request.fare)
                        : parseFloat(el.totals_request.total.replace('N$', ''))
                )
                .reduce((partialSum, a) => partialSum + a, 0);

        case 'revenue':
            return arrayRequests
                .filter(
                    (el) =>
                        isToday(new Date(el.date_requested)) &&
                        el.ride_mode !== 'RIDE'
                )
                .map((el) => {
                    let tmpSum = 0;
                    tmpSum +=
                        el.totals_request.service_fee !== undefined
                            ? parseFloat(
                                  el.totals_request.service_fee.replace(
                                      'N$',
                                      ''
                                  )
                              )
                            : 0;

                    tmpSum +=
                        el.totals_request.cart !== undefined
                            ? parseFloat(
                                  el.totals_request.cart.replace('N$', '')
                              )
                            : 0;

                    tmpSum +=
                        el.totals_request.delivery_fee !== undefined
                            ? parseFloat(
                                  el.totals_request.delivery_fee.replace(
                                      'N$',
                                      ''
                                  )
                              )
                            : 0;

                    tmpSum +=
                        el.totals_request.cash_pickup_fee !== undefined
                            ? parseFloat(
                                  el.totals_request.cash_pickup_fee.replace(
                                      'N$',
                                      ''
                                  )
                              )
                            : 0;

                    //...
                    tmpSum +=
                        el.totals_request.service_fee === undefined
                            ? parseFloat(
                                  el.totals_request.total.replace('N$', '')
                              )
                            : 0;

                    return tmpSum;
                })
                .reduce((partialSum, a) => partialSum + a, 0);

        case 'requests':
            return arrayRequests.filter((el) =>
                isToday(new Date(el.date_requested))
            ).length;

        case 'todayOnly':
            return arrayRequests.filter((el) =>
                isToday(new Date(el.date_requested))
            );

        case 'gross_sum':
            return arrayRequests
                .map((el) =>
                    el.totals_request.fare !== undefined
                        ? parseFloat(
                              String(el.totals_request.fare).replace('N$', '')
                          )
                        : parseFloat(el.totals_request.total.replace('N$', ''))
                )
                .reduce((partialSum, a) => partialSum + a, 0);

        case 'net_sum':
            return arrayRequests
                .filter((el) => el.ride_mode !== 'RIDE')
                .map((el) => {
                    let tmpSum = 0;
                    tmpSum +=
                        el.totals_request.service_fee !== undefined
                            ? parseFloat(
                                  el.totals_request.service_fee.replace(
                                      'N$',
                                      ''
                                  )
                              )
                            : 0;

                    tmpSum +=
                        el.totals_request.cart !== undefined
                            ? parseFloat(
                                  el.totals_request.cart.replace('N$', '')
                              )
                            : 0;

                    tmpSum +=
                        el.totals_request.delivery_fee !== undefined
                            ? parseFloat(
                                  el.totals_request.delivery_fee.replace(
                                      'N$',
                                      ''
                                  )
                              )
                            : 0;

                    tmpSum +=
                        el.totals_request.cash_pickup_fee !== undefined
                            ? parseFloat(
                                  el.totals_request.cash_pickup_fee.replace(
                                      'N$',
                                      ''
                                  )
                              )
                            : 0;

                    //...
                    tmpSum +=
                        el.totals_request.service_fee === undefined
                            ? parseFloat(
                                  el.totals_request.total.replace('N$', '')
                              )
                            : 0;

                    return tmpSum;
                })
                .reduce((partialSum, a) => partialSum + a, 0);

        default:
            return 0;
    }
};

//CHeck if the date is within the last x days
function isDateWithinTheLastXDays({ dateString, dayLimit = 3 }) {
    //Get the date value of next week.
    let today = new Date(chaineDateUTC);
    let prevWeek = Date.parse(
        new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate() - dayLimit
        )
    );

    return {
        check: prevWeek > new Date(dateString) <= today,
        start: prevWeek,
        end: today,
    };
}

//Generate graph data from the requests data
function generateGraphDataFromRequestsData({ requestData }) {
    let mapDatesString = {};
    let limitDays = 7;

    //?Sort based on the cancelled date
    requestData.sort((a, b) =>
        new Date(a.date_requested) < new Date(b.date_requested)
            ? -1
            : new Date(a.date_requested) < new Date(a.date_requested)
            ? 1
            : 0
    );

    requestData
        .filter(
            (el) =>
                isDateWithinTheLastXDays({
                    dateString: el.date_requested,
                    dayLimit: limitDays,
                }).check
        )
        .map((el) => {
            //Compute the maps
            let refDate = new Date(el.date_requested);

            if (isNaN(refDate.getDate()) === false) {
                let mapKey = `${
                    refDate.getDate() > 9
                        ? refDate.getDate()
                        : `0${refDate.getDate()}`
                }-${
                    refDate.getMonth() + 1 > 9
                        ? refDate.getMonth() + 1
                        : `0${refDate.getMonth() + 1}`
                }-${refDate.getFullYear()}`;

                if (mapDatesString[mapKey] !== undefined) {
                    //Already created
                    mapDatesString[mapKey].y += 1;
                } //Not yet created
                else {
                    mapDatesString[mapKey] = {
                        y: 1,
                        x: mapKey,
                    };
                }
            }
        });
    //....
    //Augment the data between the dates limits
    let datesLimit = isDateWithinTheLastXDays({
        dateString: chaineDateUTC,
        dayLimit: limitDays,
    });
    let completeDaysArray_ref = getDates(
        new Date(datesLimit.start),
        new Date(datesLimit.end)
    );

    //! Augment the data
    //! AND Transform map to array
    let cleanArrayData = [];
    completeDaysArray_ref.map((refElement) => {
        let refKey = refElement.replace('T22:00:00.000Z', '').trim();

        if (mapDatesString[refKey] !== undefined) {
            // logger.warn(refKey);
            // logger.error(mapDatesString);
            //Exists
            let tmpElement = { y: mapDatesString[refKey].y, x: refKey };
            cleanArrayData.push(tmpElement);
        } //Does not exist
        else {
            let tmpElement = { y: 0, x: refKey };
            cleanArrayData.push(tmpElement);
        }
    });

    //...
    // for (const key in mapDatesString) {
    //   cleanArrayData.push(mapDatesString[key]);
    // }
    //...
    // logger.info(cleanArrayData);
    return cleanArrayData;
}

function addDaysToDate(date, days) {
    date.setDate(date.getDate() + days);
    return date;
}

function getDates(startDate, stopDate) {
    let dateArray = new Array();
    let currentDate = startDate;
    while (currentDate <= stopDate) {
        let refDate = new Date(currentDate);
        dateArray.push(
            `${
                refDate.getDate() > 9
                    ? refDate.getDate()
                    : `0${refDate.getDate()}`
            }-${
                refDate.getMonth() + 1 > 9
                    ? refDate.getMonth() + 1
                    : `0${refDate.getMonth() + 1}`
            }-${refDate.getFullYear()}`
        );
        //...
        currentDate = addDaysToDate(currentDate, 1);
    }
    return dateArray;
}

//! Admininstrators background check before delivering any data
const AdminsBackgroundCheck = function (req, res, next) {
    //Isolate only the admins requests requiring data
    let urlSource = req.url.replace('/', '').trim();

    if (req.body.admin_fp !== undefined && req.body.admin_fp !== null) {
        //Requests for data
        let dataSource = req.body;

        //Check if there is any token_j
        if (dataSource.token_j !== undefined && req.token_j !== null) {
            // logger.warn(req.body);
            //Has a token
            //`${passwordHashed}-SALTFORJWTORNISS`,
            //?Check for the token's validity
            dynamo_get_all({
                table_name: 'administration_central',
                FilterExpression: 'token_j = :val1',
                ExpressionAttributeValues: {
                    ':val1': dataSource.token_j,
                },
            })
                .then((adminData) => {
                    // logger.info(adminData);
                    if (
                        adminData !== undefined &&
                        adminData !== null &&
                        adminData.length > 0
                    ) {
                        adminData = adminData[0];

                        //!Check the token's validity
                        let secString = `${adminData.password}-SALTFORJWTORNISS`;

                        jwt.verify(
                            dataSource.token_j,
                            secString,
                            function (err, decoded) {
                                if (err) {
                                    res.send({ response: 'error_Logout' });
                                }
                                //...
                                if (
                                    decoded.data === adminData.corporate_email
                                ) {
                                    //Verified
                                    logger.info('Verified admin');
                                    next();
                                } //Suspicious
                                else {
                                    res.send({ response: 'error_Logout' });
                                }
                            }
                        );
                    } //No admin found - log out
                    else {
                        res.send({ response: 'error_Logout' });
                    }
                })
                .catch((error) => {
                    logger.error(error);
                    res.send({ response: 'error_Logout' });
                });
        } //! No token - log out
        else {
            res.send({ response: 'error_Logout' });
        }
    } //Skip
    else {
        next();
    }
};

/**
 * @func sendTargetedPushNotifications
 * Responsible for sending push notifications for new requests (rides, deliveries of shopping)
 * @param request_type: RIDE, DELIVERY or SHOPPING
 * @param fare: the fare of the request
 * @param resolve
 */
function sendTargetedPushNotifications({ request_type, fare, resolve }) {
    //1. Get all the drivers for this request type
    dynamo_find_query({
        table_name: 'drivers_shoppers_central',
        IndexName: 'operation_clearances',
        KeyConditionExpression: 'operation_clearances = :val1',
        ExpressionAttributeValues: {
            ':val1': request_type.toUpperCase().trim(),
        },
    })
        .then((driversData) => {
            if (
                driversData !== undefined &&
                driversData !== null &&
                driversData.length > 0
            ) {
                //Found some drivers
                //2. Isolate the drivers notifications token
                let driversNotifTokens = driversData.map((data) => {
                    return data.operational_state.pushnotif_token !== null &&
                        data.operational_state.pushnotif_token !== undefined
                        ? data.operational_state.pushnotif_token.userId
                        : null;
                });

                logger.info(driversNotifTokens);

                //? 3. Send
                let message = {
                    app_id: process.env.DRIVERS_APP_ID_ONESIGNAL,
                    android_channel_id:
                        process.env.DRIVERS_ONESIGNAL_CHANNEL_NEW_NOTIFICATION, //Ride or delivery channel
                    priority: 10,
                    contents: /RIDE/i.test(request_type)
                        ? {
                              en: 'You have a new ride request, click here for more details.',
                          }
                        : /DELIVERY/i.test(request_type)
                        ? {
                              en: 'You have a new delivery request, click here for more details.',
                          }
                        : {
                              en: 'You have a new shopping request, click here for more details.',
                          },
                    headings: /RIDE/i.test(request_type)
                        ? { en: 'New ride request, N$' + fare }
                        : /DELIVERY/i.test(request_type)
                        ? { en: 'New delivery request, N$' + fare }
                        : { en: 'New shopping request, N$' + fare },
                    content_available: true,
                    include_player_ids: driversNotifTokens,
                };
                //Send
                sendPushUPNotification(message);
            } //No drivers yet
            else {
                resolve(false);
            }
        })
        .catch((error) => {
            logger.error(error);
            resolve(false);
        });
}

//? Check elasticsearch
logger.info('[*] Elasticsearch connected');
logger.info('[+] DulcetDash service active');

app.use(morgan('dev'));
app.get('/', function (req, res) {
    res.send('[+] DulcetDash server running.');
}).use(express.static(path.join(__dirname, 'assets')));
app.use(
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
    .use(AdminsBackgroundCheck)
    .use(cors())
    .use(helmet());

//?1. Get all the available stores in the app.
//Get the main ones (4) and the new ones (X)
app.post('/getStores', async (req, res) => {
    try {
        const stores = await getStores();

        res.json(stores);
    } catch (error) {
        logger.error(error);
        res.send({ response: [] });
    }
});

app.post('/api/v1/store', async (req, res) => {
    try {
        const {
            fp,
            publish,
            name,
            friendly_name,
            shop_type,
            description,
            shop_background_color,
            border_color,
            shop_logo,
            structured_shopping,
            opening_time,
            closing_time,
        } = req.body;

        const checkStore = await StoreModel.get({ id: fp });

        if (checkStore)
            return res.status(500).json({
                status: 'fail',
                error: 'Store already exist',
            });

        const newStore = await StoreModel.create({
            id: fp,
            publish,
            name,
            friendly_name,
            shop_type,
            description,
            shop_background_color,
            border_color,
            shop_logo,
            structured_shopping,
            opening_time,
            closing_time,
        });

        res.json({
            status: 'created',
            id: newStore.id,
        });
    } catch (error) {
        res.status(500).json({
            status: 'fail',
        });
    }
});

//?2. Get all the products based on a store
app.post('/getCatalogueFor', async (req, res) => {
    try {
        const { body } = req;

        const products = await getCatalogueFor(body);
        res.json(products);
    } catch (error) {
        logger.error(error);
        res.send({ response: 'no_products' });
    }
});

//?3. Search in  the catalogue of a  specific shop
app.post('/getResultsForKeywords', async (req, res) => {
    try {
        const {
            category,
            subcategory,
            store_fp: shop_fp,
            store: shop_name,
            key,
        } = req.body;

        if (key && shop_fp) {
            const products = await searchProducts(process.env.CATALOGUE_INDEX, {
                shop_fp,
                shop_name,
                product_name: key,
                category,
                subcategory,
            });

            const privateKeys = [
                'website_link',
                'used_link',
                'local_images_registry',
                'createdAt',
            ];

            const safeProducts = _.map(products, (obj) =>
                _.omit(obj, privateKeys)
            );

            res.send({ count: products.length, response: safeProducts });
        } //No valid data
        else {
            res.send({ response: [] });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: [] });
    }
});

//?4. Move all the pictures from external remote servers to our local server
app.post('/getImageRessourcesFromExternal', function (req, res) {
    //Get all the images that where not moved yet into the internal ressources
    //? In an image ressource was moved, it will be in the meta.moved_ressources_manifest, else proceed with the getting
    // collection_catalogue_central
    //   .find({})
    //   .toArray(function (err, productsData) {
    //     if (err) {
    //       logger.error(err);
    //       res.send({ response: "error", flag: err });
    //     }
    //     //...
    //     if (productsData !== undefined && productsData.length > 0) {
    //       //Has some products
    //       let parentPromises = productsData.map((product, index) => {
    //         return new Promise((resolve) => {
    //           //Get the array of images
    //           let arrayImages = product.product_picture;
    //           //Get the transition manifest
    //           //? Looks like {'old_image_name_external_url': new_image_name_url}
    //           console.log(arrayImages);
    //           let transition_manifest =
    //             product.meta.moved_ressources_manifest !==
    //               undefined &&
    //             product.meta.moved_ressources_manifest !== null
    //               ? product.meta.moved_ressources_manifest
    //               : {};
    //           let parentPromises2 = arrayImages.map((picture) => {
    //             return new Promise((resCompute) => {
    //               if (
    //                 transition_manifest[picture] !== undefined &&
    //                 transition_manifest[picture] !== null
    //               ) {
    //                 //!Was moved
    //                 //Already processed
    //                 resCompute({
    //                   message: "Already processed",
    //                   index: index,
    //                 });
    //               } //!Not moved yet - move
    //               else {
    //                 let options = {
    //                   uri: picture,
    //                   encoding: null,
    //                 };
    //                 requestAPI(
    //                   options,
    //                   function (error, response, body) {
    //                     if (error || response.statusCode !== 200) {
    //                       console.log("failed to get image");
    //                       console.log(error);
    //                       resCompute({
    //                         message: "Processed - failed",
    //                         index: index,
    //                       });
    //                     } else {
    //                       logger.info("Got the image");
    //                       s3.putObject(
    //                         {
    //                           Body: body,
    //                           Key: path,
    //                           Bucket: "bucket_name",
    //                         },
    //                         function (error, data) {
    //                           if (error) {
    //                             console.log(
    //                               "error downloading image to s3"
    //                             );
    //                             resCompute({
    //                               message: "Processed - failed",
    //                               index: index,
    //                             });
    //                           } else {
    //                             console.log(
    //                               "success uploading to s3"
    //                             );
    //                             resCompute({
    //                               message: "Processed",
    //                               index: index,
    //                             });
    //                           }
    //                         }
    //                       );
    //                     }
    //                   }
    //                 );
    //               }
    //             });
    //           });
    //           //? Done with this
    //           Promise.all(parentPromises2)
    //             .then((result) => {
    //               resolve(result);
    //             })
    //             .catch((error) => {
    //               logger.error(error);
    //               resolve({ response: "error_processing" });
    //             });
    //         });
    //       });
    //       //! DONE
    //       Promise.all(parentPromises)
    //         .then((result) => {
    //           res.send({ response: result });
    //         })
    //         .catch((error) => {
    //           logger.error(error);
    //           res.send({ response: "unable_to_work", flag: error });
    //         });
    //     } //No products
    //     else {
    //       res.send({ response: "no_products_found" });
    //     }
    //   });
});

//?5. Get location search suggestions
app.post('/getSearchedLocations', async (req, res) => {
    try {
        const results = await getSearchedLocations(req.body);
        res.send(results);
    } catch (error) {
        console.error(error);
        res.send(false);
    }
});

//?6. Request for shopping
app.post('/requestForShopping', async (req, res) => {
    try {
        const {
            user_identifier,
            shopping_list,
            totals,
            locations,
            ride_mode,
            note,
            payment_method,
        } = req.body;
        //! Check for the user identifier, shopping_list and totals
        if (
            user_identifier &&
            shopping_list &&
            totals &&
            locations &&
            ride_mode
        ) {
            let security_pin = otpGenerator.generate(6, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false,
            });
            //! --------------
            security_pin =
                String(security_pin).length < 6
                    ? parseInt(security_pin) * 10
                    : security_pin;

            //! Check if the user has no unconfirmed shoppings
            const previousRequest = await RequestsModel.query('client_id')
                .eq(user_identifier)
                .filter('date_clientRatedShopping')
                .not()
                .exists()
                .filter('date_cancelled')
                .not()
                .exists()
                .exec();

            if (previousRequest.count <= 0) {
                let parsedTotals = JSON.parse(totals);

                parsedTotals.cart = parseFloat(
                    parsedTotals.cart.replace('N$', '')
                );
                parsedTotals.service_fee = parseFloat(
                    parsedTotals.service_fee.replace('N$', '')
                );
                parsedTotals.total = parseFloat(
                    parsedTotals.total.replace('N$', '')
                );
                parsedTotals.cash_pickup_fee = parseFloat(
                    parsedTotals.cash_pickup_fee.replace('N$', '')
                );

                const newRequest = await RequestsModel.create({
                    id: uuidv4(),
                    client_id: user_identifier, //the user identifier - requester
                    payment_method: payment_method, //mobile_money or cash
                    locations: JSON.parse(locations), //Has the pickup and delivery locations
                    totals_request: parsedTotals, //Has the cart details in terms of fees
                    request_documentation: note,
                    shopping_list: JSON.parse(shopping_list), //! The list of items to shop for
                    ride_mode: ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                    security: security_pin, //Will be used to check the request,
                });

                console.log(newRequest);

                res.json({ response: 'successful' });
            } else {
                res.json({ response: 'has_a_pending_shopping' });
            }
        } else {
            resolve({ response: 'unable_to_request' });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'unable_to_request' });
    }
});

//?6. Request for delivery or ride
app.post('/requestForRideOrDelivery', async (req, res) => {
    try {
        req = req.body;
        //! Check for the user identifier, shopping_list and totals
        //Check basic ride or delivery conditions
        let checkerCondition =
            req?.ride_mode == 'delivery'
                ? req?.user_identifier &&
                  req?.dropOff_data &&
                  req?.totals &&
                  req?.pickup_location
                : req?.user_identifier &&
                  req?.dropOff_data &&
                  req?.passengers_number &&
                  req?.pickup_location;

        if (checkerCondition) {
            let security_pin = otpGenerator.generate(6, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false,
            });
            //! --------------
            security_pin =
                String(security_pin).length < 6
                    ? parseInt(security_pin) * 10
                    : security_pin;

            //! Check if the user has no unconfirmed shoppings
            const previousRequest = await RequestsModel.query('client_id')
                .eq(req.user_identifier)
                .filter('date_clientRatedRide')
                .not()
                .exists()
                .filter('date_cancelled')
                .not()
                .exists()
                .exec();

            if (previousRequest.count <= 0) {
                //No unconfirmed requests
                //! Perform the conversions
                req.totals = req?.totals ? JSON.parse(req.totals) : null;
                if (req?.totals?.delivery_fee) {
                    req.totals.delivery_fee = parseFloat(
                        req.totals?.delivery_fee?.replace('N$', '')
                    );
                    req.totals.service_fee = parseFloat(
                        req.totals?.service_fee?.replace('N$', '')
                    );
                    req.totals.total = parseFloat(
                        req.totals?.total?.replace('N$', '')
                    );
                }
                //...

                const newRequest = await RequestsModel.create({
                    id: uuidv4(),
                    client_id: req.user_identifier, //the user identifier - requester
                    payment_method: req.payment_method, //mobile_money or cash
                    locations: {
                        pickup: JSON.parse(req.pickup_location), //Has the pickup locations
                        dropoff: JSON.parse(req.dropOff_data), //The list of recipient/riders and their locations
                    },
                    totals_request: req.totals, //Has the cart details in terms of fees
                    request_documentation: req.note,
                    ride_mode: req.ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                    security: security_pin,
                });

                console.log(newRequest);

                res.json({ response: 'successful' });
            } //Has a pending request
            else {
                res.json({ response: 'has_a_pending_shopping' });
            }
        } else {
            res.json({ response: 'unable_to_request' });
        }
    } catch (error) {
        logger.error(error);
        res.json({ response: 'unable_to_request' });
    }
});

//?7. Get the current shopping data - client
app.post('/getShoppingData', async (req, res) => {
    try {
        req = req.body;

        if (req.user_identifier !== undefined && req.user_identifier !== null) {
            //! Check if the user id exists
            const request = await getRequestDataClient(req);

            res.json(request);
        } //Missing data
        else {
            res.send(false);
        }
    } catch (error) {
        logger.error(error);
        res.send(false);
    }
});

//?6. Get the route snapshot for the ride
//? EFFIENCY A
app.post('/getRouteToDestinationSnapshot', function (req, res) {
    let urlRequest = `http://localhost:${process.env.SEARCH_SERVICE_PORT}/getRouteToDestinationSnapshot`;

    requestAPI.post(
        { url: urlRequest, form: req.body },
        function (err, response, body) {
            if (err) {
                logger.error(err);
            }
            //...
            res.send(body);
        }
    );
});

//?7. Get the fares
app.post('/computeFares', function (req, res) {
    let urlRequest = `http://localhost:${process.env.PRICING_SERVICE_PORT}/computeFares`;

    requestAPI.post(
        { url: urlRequest, form: req.body },
        function (err, response, body) {
            if (err) {
                logger.error(err);
            }
            //...
            res.send(body);
        }
    );
});

//?8. Submit the rider rating
//? EFFIENCY A
app.post('/submitRiderOrClientRating', function (req, res) {
    new Promise((resolve) => {
        resolveDate();

        req = req.body;

        logger.info(req);

        if (
            req.request_fp !== undefined &&
            req.request_fp !== null &&
            req.rating !== undefined &&
            req.rating !== null &&
            req.badges !== undefined &&
            req.badges !== null &&
            req.note !== undefined &&
            req.note !== null &&
            req.user_fingerprint !== undefined &&
            req.user_fingerprint !== null
        ) {
            req.badges = JSON.parse(req.badges);

            let RATING_DATA = {
                rating: parseFloat(req.rating),
                comments: req.note,
                compliments: req.badges,
                date_rated: new Date(chaineDateUTC),
            };

            //...Check the request
            //! Can only rate once
            let requestChecker = {
                request_fp: req.request_fp,
                'request_state_vars.completedRatingClient': false,
            };

            dynamo_find_query({
                table_name: 'requests_central',
                IndexName: 'request_fp',
                KeyConditionExpression: 'request_fp = :val1',
                FilterExpression: '#r.#c = :val2',
                ExpressionAttributeValues: {
                    ':val1': req.request_fp,
                    ':val2': false,
                },
                ExpressionAttributeNames: {
                    '#r': 'request_state_vars',
                    '#c': 'completedRatingClient',
                },
            })
                .then((requestData) => {
                    if (requestData !== undefined && requestData.length > 0) {
                        //Valid
                        requestData = requestData[0];

                        let updatedRequestState =
                            requestData.request_state_vars;
                        updatedRequestState['rating_data'] = RATING_DATA;
                        updatedRequestState['completedRatingClient'] = true;

                        dynamo_update({
                            table_name: 'requests_central',
                            _idKey: requestData.id,
                            UpdateExpression:
                                'set request_state_vars = :val1, date_clientRatedRide = :val2',
                            ExpressionAttributeValues: {
                                ':val1': updatedRequestState,
                                ':val2': new Date(chaineDateUTC).toISOString(),
                            },
                        })
                            .then((result) => {
                                // //! Delete previous cache
                                // let redisKey = `${req.user_fingerprint}-shoppings`;
                                // redisCluster.del(redisKey);
                                // //! Delete previous request list cache
                                // let redisKey2 = `${req.user_identifier}-requestListCached`;
                                // redisCluster.del(redisKey2);
                                // //...

                                if (result === false) {
                                    //Error
                                    resolve([{ response: 'error' }]);
                                }
                                //...
                                resolve([{ response: 'success' }]);
                            })
                            .catch((error) => {
                                logger.error(error);
                                resolve([{ response: 'error' }]);
                            });
                    } //No request?
                    else {
                        resolve([{ response: 'error' }]);
                    }
                })
                .catch((error) => {
                    logger.error(error);
                    resolve([{ response: 'error' }]);
                });
        } //Invalid data
        else {
            resolve([{ response: 'error' }]);
        }
    })
        .then((result) => {
            logger.info(result);
            res.send(result);
        })
        .catch((error) => {
            logger.error(error);
            res.send([{ response: 'error' }]);
        });
});

//?9. Cancel request - user
app.post('/cancel_request_user', async (req, res) => {
    try {
        const { request_fp, user_identifier } = req.body;

        if (request_fp && user_identifier) {
            //Check if there is such request
            const request = await RequestsModel.query('id')
                .eq(request_fp)
                .filter('client_id')
                .eq(user_identifier)
                .exec();

            if (request.count > 0) {
                const requestData = request[0];

                //Cancel the request
                await RequestsModel.update(
                    { id: requestData.id },
                    {
                        date_cancelled: Date.now(),
                    }
                );

                res.send([{ response: 'success' }]);
            } //No request?
            else {
                res.send([{ response: 'error' }]);
            }
        } //Invalid data
        else {
            res.send([{ response: 'error' }]);
        }
    } catch (error) {
        logger.error(error);
        res.send([{ response: 'error' }]);
    }
});

//?10. Search for stores
// app.post("/searchForStores", function(req, res) {
//   new Promise((resolve) => {
//     new promises((resIndices) => {
//       let index_name = 'stores';
//       checkIndices(index_name, resIndices);
//     })
//     .then((result) => {
//       if(result)  //All good
//       {

//       }
//       else  //There was a problem
//       {
//         resolve({ response: [] });
//       }
//     }).catch((error) => {
//       logger.error(error);
//       resolve({ response: [] });
//     })
//   })
//   .then((result) => {
//     logger.info(result);
//     res.send(result);
//   })
//   .catch((error) => {
//     logger.error(error);
//     res.send({ response: [] });
//   });
// })

//?11. get the list of requests for riders
app.post('/getRequestListRiders', async (req, res) => {
    try {
        const { user_identifier } = req.body;

        const requestHistory = await getRequestListDataUsers(user_identifier);

        res.send(requestHistory);
    } catch (error) {
        logger.error(error);
        res.send({ response: [] });
    }
});

//?12. Update the users information
app.post('/updateUsersInformation', async (req, res) => {
    try {
        const { user_identifier, data_type, data_value, extension } = req.body;

        if (user_identifier && data_type && data_value) {
            const user = await UserModel.get(user_identifier);

            if (!user) res.send({ response: 'error' });

            const userData = user;

            let updateObject = {};

            if (data_type === 'name') updateObject['name'] = data_value;
            if (data_type === 'surname') updateObject['surname'] = data_value;
            if (data_type === 'email') updateObject['email'] = data_value;
            if (data_type === 'gender') updateObject['gender'] = data_value;
            if (data_type === 'phone')
                updateObject['phone_number'] = data_value;
            if (data_type === 'profile_picture') {
                let fileUploadName = `profile_${uuidv4()}.${extension}`;
                const uploadProfile = await uploadBase64ToS3(
                    data_value,
                    process.env.AWS_S3_CLIENTS_PROFILES_BUCKET_NAME,
                    fileUploadName
                );

                if (uploadProfile) {
                    updateObject['profile_picture'] = uploadProfile;
                } else {
                    return res.send({ response: 'error' });
                }
            }

            //...
            const updatedUser = await UserModel.update(
                { id: userData.id },
                updateObject
            );

            res.send({ response: 'success' });
        } //Invalid data
        else {
            resolve({ response: 'error' });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

//?13. Get the user data
app.post('/getGenericUserData', async (req, res) => {
    try {
        const { user_identifier } = req.body;

        if (!user_identifier)
            res.status(500).json({ status: 'fail', response: [] });

        const user = await UserModel.get(user_identifier);

        if (!user) {
            return res.send({ status: 'success', response: [] });
        }

        const profilePicKey = `userprofile-image-${user.id}`;
        let cachedProfilePicture = await Redis.get(profilePicKey);

        let userProfilePicture = 'user.png';

        if (cachedProfilePicture) {
            cachedProfilePicture = JSON.parse(cachedProfilePicture);

            if (
                user?.updatedAt.toISOString() ===
                `${cachedProfilePicture?.updatedAt}`
            ) {
                userProfilePicture = cachedProfilePicture.presigned;
            } else {
                cachedProfilePicture = null;
            }
        }

        if (!cachedProfilePicture && user?.profile_picture !== 'user.png') {
            const freshPresigning = await presignS3URL(user?.profile_picture);
            userProfilePicture = freshPresigning;
            //...
            Redis.set(
                profilePicKey,
                JSON.stringify({
                    bare: user?.profile_picture,
                    presigned: freshPresigning,
                    updatedAt: user.updatedAt,
                }),
                'EX',
                30 * 60
            );
        }

        const userProfile = {
            name: user.name,
            surname: user.surname,
            gender: user.gender,
            account_state: user.account_state,
            profile_picture: userProfilePicture,
            is_accountVerified: user?.is_accountVerified,
            phone: user.phone_number,
            email: user.email,
            user_identifier: user.id,
        };

        res.json({
            status: 'success',
            response: userProfile,
        });
    } catch (error) {
        logger.error(error);
        res.json({ status: 'fail', response: [] });
    }
});

//?14. Check the user's phone number and send the code and the account status back
app.post('/checkPhoneAndSendOTP_status', async (req, res) => {
    try {
        const { phone } = req.body;

        const user = await UserModel.query('phone_number').eq(phone).exec();

        const sendSMS = await shouldSendNewSMS(user[0], phone);

        res.json({
            status: 'success',
            response: {
                didSendOTP: sendSMS,
                hasAccount: user.count > 0, //!Has account
                user_identifier: user[0]?.id,
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            response: {},
            error: { message: error.message },
        });
    }
});

//?15. Validate user OTP
app.post('/validateUserOTP', async (req, res) => {
    try {
        const { phone, otp } = req.body;

        const user = await UserModel.query('phone_number').eq(phone).exec();

        if (user.count > 0) {
            const checkOtp = await UserModel.query('phone_number')
                .eq(phone)
                .filter('otp')
                .eq(parseInt(otp))
                .exec();

            if (checkOtp.count > 0) {
                //Valid
                //registered user
                const userData = user[0];
                const userProfile = {
                    name: userData.name,
                    surname: userData.surname,
                    gender: userData.gender,
                    account_state: userData.account_state,
                    profile_picture: userData?.profile_picture
                        ? await presignS3URL(userData?.profile_picture)
                        : 'user.png',
                    is_accountVerified: userData?.is_accountVerified,
                    phone: userData.phone_number,
                    email: userData.email,
                    user_identifier: userData.id,
                };

                res.json({
                    response: 'success',
                    account_state: userProfile.account_state, //!Very important for state restoration
                    userData: userProfile,
                });
            } //Wrong otp
            else {
                res.json({ status: 'fail', response: 'wrong_otp' });
            }
        } //New user
        else {
            const checkOTP = await OTPModel.query('phone_number')
                .eq(phone)
                .filter('otp')
                .eq(parseInt(otp))
                .exec();

            if (checkOTP.count > 0) {
                //Valid
                res.json({ response: 'success', userData: 'new_user' });
            } //Invalid
            else {
                res.json({ status: 'fail', response: 'wrong_otp' });
            }
        }
    } catch (error) {
        console.error(error);
        res.status(500).send({
            response: {},
            error: { message: error.message },
        });
    }
});

//?16. Create a basic account quickly
app.post('/createBasicUserAccount', async (req, res) => {
    try {
        const { phone } = req.body;

        const user = await UserModel.query('phone_number').eq(phone).exec();

        if (user.count <= 0) {
            //New account
            const newAccount = await UserModel.create({
                id: uuidv4(),
                is_accountVerified: true,
                is_policies_accepted: true,
                phone_number: phone,
            });

            res.json({
                status: 'success',
                response: 'success',
                userData: { user_identifier: newAccount.id },
            });
        } //Existing account
        else {
            res.json({ status: 'fail', response: 'phone_already_in_use' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).send({
            response: 'error',
            error: { message: error.message },
        });
    }
});

//?17. Add additional user account details
app.post('/addAdditionalUserAccDetails', async (req, res) => {
    try {
        const { user_identifier, additional_data } = req.body;

        if (!user_identifier || !additional_data) {
            return res.json({ response: 'error' });
        }

        const { name, surname, gender, email, profile_picture_generic } =
            JSON.parse(additional_data);

        const userData = await UserModel.update(
            {
                id: user_identifier,
            },
            {
                name,
                surname,
                gender,
                email,
                profile_picture: profile_picture_generic,
                account_state: 'full',
            }
        );

        const userProfile = {
            name: userData.name,
            surname: userData.surname,
            gender: userData.gender,
            account_state: userData.account_state,
            profile_picture: `${process.env.AWS_S3_CLIENTS_PROFILES_PATH}/clients_profiles/${userData?.profile_picture}`,
            is_accountVerified: userData?.is_accountVerified,
            phone: userData.phone_number,
            email: userData.email,
            user_identifier: userData.id,
        };

        res.json({
            response: 'success',
            user_identifier,
            userData: userProfile,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            response: 'error',
            error: { message: error.message },
        });
    }
});

//?18. Get the go again list of the 3 recently visited shops - only for users
app.post('/getRecentlyVisitedShops', async (req, res) => {
    let redisKey = `${req.user_identifier}-cachedRecentlyVisited_shops`;

    try {
        const { user_identifier } = req.body;

        if (user_identifier) {
            const recentShops = await getRecentlyVisitedShops(
                user_identifier,
                redisKey
            );

            res.send(recentShops);
        } else {
            res.send({ response: [] });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: [] });
    }
});

//?19. Check the user's phone number and send the code and the account status back
//! * FOR CHANGING USERS PHONE NUMBERS
app.post('/checkPhoneAndSendOTP_changeNumber_status', async (req, res) => {
    try {
        const { phone, user_identifier } = req.body;

        if (phone && user_identifier) {
            //1. Check if the here another user having that same number
            const userWithSamePhone = await UserModel.query('phone_number')
                .eq(phone)
                .exec();

            if (userWithSamePhone.count <= 0) {
                //Free number
                const user = await UserModel.get(user_identifier);

                if (!user) res.send({ response: 'error' });

                const sentSMS = await shouldSendNewSMS(user, phone);

                if (sentSMS) {
                    return res.json({
                        response: {
                            status: 'success',
                            didSendOTP: sentSMS,
                            hasAccount: true,
                            user_identifier: user_identifier,
                        },
                    });
                }

                res.send({ response: { status: 'error' } });
            } //Number already in use
            else {
                res.send({
                    response: { status: 'already_linked_toAnother' },
                });
            }
        } //Invalid data
        else {
            res.send({ response: { status: 'error' } });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: { status: 'error' } });
    }
});

//?20. Validate user OTP
//! * FOR CHANGING USERS PHONE NUMBERS
app.post('/validateUserOTP_changeNumber', async (req, res) => {
    try {
        const { phone, user_identifier } = req.body;

        let { otp } = req.body;

        if (phone && otp && user_identifier) {
            otp = parseInt(otp);

            const user = await UserModel.get(user_identifier);

            if (!user) res.send({ response: { status: 'error' } });

            if (user.otp !== otp)
                res.send({ response: { status: 'wrong_otp' } });

            await UserModel.update(
                {
                    id: user_identifier,
                },
                {
                    phone_number: phone,
                }
            );

            res.send({ response: { status: 'success' } });
        } //Invalid data
        else {
            res.send({ response: { status: 'error' } });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: { status: 'error' } });
    }
});

//?21. Upload the riders' or drivers pushnotif_token
app.post('/receivePushNotification_token', function (req, res) {
    new Promise((resolve) => {
        req = req.body;

        if (
            req.user_identifier !== undefined &&
            req.user_identifier !== null &&
            req.pushnotif_token !== undefined &&
            req.pushnotif_token !== null
        ) {
            //Attach the user nature: rider/driver
            req['user_nature'] =
                req.user_nature !== undefined && req.user_nature !== null
                    ? req.user_nature
                    : 'rider';

            let redisKey = `${req.user_identifier}-pushnotif_tokenDataCached`;
            req.pushnotif_token = JSON.parse(req.pushnotif_token);
            //! Get the cached and compare, only update the database if not the same as the cached
            //Update
            new Promise((resCompute) => {
                updateRidersPushNotifToken(req, redisKey, resCompute);
            })
                .then((result) => {
                    resolve(result);
                })
                .catch((error) => {
                    logger.error(error);
                    resolve({ response: 'error' });
                });
        } //invalid data
        else {
            resolve({ response: 'error' });
        }
    })
        .then((result) => {
            // logger.info(result);
            res.send(result);
        })
        .catch((error) => {
            logger.error(error);
            res.send({ response: 'error' });
        });
});

//? REST equivalent for common websockets.
/**
 * For the courier driver resgistration
 */
app.post('/registerCourier_ppline', async (req, res) => {
    logger.info(String(req.body).length);

    try {
        const application = await processCourierDrivers_application(req);

        res.send(application);
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

/**
 * For the rides driver registration
 */

app.post('/registerDriver_ppline', function (req, res) {
    logger.info(String(req.body).length);
    let url =
        `${
            /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
        }` +
        ':' +
        process.env.ACCOUNTS_SERVICE_PORT +
        '/processRidesDrivers_application';

    requestAPI.post({ url, form: req.body }, function (error, response, body) {
        logger.info(url);
        logger.info(body, error);
        if (error === null) {
            try {
                body = JSON.parse(body);
                res.send(body);
            } catch (error) {
                res.send({ response: 'error' });
            }
        } else {
            res.send({ response: 'error' });
        }
    });
});

app.post('/update_requestsGraph', function (req, res) {
    logger.info(req);
    req = req.body;

    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/getRequests_graphNumbers?driver_fingerprint=' +
            req.driver_fingerprint;

        requestAPI(url, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        rides: 0,
                        deliveries: 0,
                        scheduled: 0,
                    });
                }
            } else {
                res.send({
                    rides: 0,
                    deliveries: 0,
                    scheduled: 0,
                });
            }
        });
    } else {
        res.send({
            rides: 0,
            deliveries: 0,
            scheduled: 0,
        });
    }
});

//?2
/**
 * MAP SERVICE
 * Get user location (reverse geocoding)
 */
app.post('/geocode_this_point', async (req, res) => {
    try {
        const { latitude, longitude, user_fingerprint: userId } = req.body;

        if (latitude && longitude && userId) {
            const location = await getUserLocationInfos(
                latitude,
                longitude,
                userId
            );

            res.json(location);
        }
    } catch (error) {
        console.error(error);
        res.json(false);
    }
});

/**
 * MAP SERVICE, port 9090
 * Route: updatePassengerLocation
 * Event: update-passenger-location
 * Update the passenger's location in the system and prefetch the navigation data if any.
 */
app.post('/update_passenger_location', function (req, res) {
    req = req.body;

    if (
        req !== undefined &&
        req.latitude !== undefined &&
        req.latitude !== null &&
        req.longitude !== undefined &&
        req.longitude !== null &&
        req.user_fingerprint !== null &&
        req.user_fingerprint !== undefined
    ) {
        //Supplement or not the request string based on if the user is a driver or rider
        req['user_nature'] =
            req.user_nature !== undefined && req.user_nature !== null
                ? req.user_nature
                : 'rider';
        req['requestType'] =
            req.requestType !== undefined && req.requestType !== null
                ? req.requestType
                : 'rides';
        //...

        //? Dynamically generate the correct route link based on the requestType
        let url = `${
            /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
        }:${
            /RIDE/i.test(req.requestType)
                ? process.env.MAP_SERVICE_PORT
                : /DELIVERY/i.test(req.requestType)
                ? process.env.MAP_SERVICE_DELIVERY
                : process.env.MAP_SERVICE_SHOPPING
        }/${
            /RIDE/i.test(req.requestType)
                ? 'updatePassengerLocation'
                : /DELIVERY/i.test(req.requestType)
                ? 'updatePassengerLocation_delivery'
                : 'updatePassengerLocation_shopping'
        }`;

        requestAPI.post({ url, form: req }, function (error, response, body) {
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    //logger.info(body);
                    res.send(body);
                } catch (error) {
                    res.send(false);
                }
            } else {
                res.send(false);
            }
        });
    } //Invalid params
    else {
        res.send(false);
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: accept_request
 * event: accept_request_io
 * Accept any request from the driver's side.
 */
app.post('/accept_request_io', function (req, res) {
    //logger.info(req);
    req = req.body;
    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/accept_request';

        requestAPI.post({ url, form: req }, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'unable_to_accept_request_error',
                    });
                }
            } else {
                res.send({
                    response: 'unable_to_accept_request_error',
                });
            }
        });
    } else {
        res.send({
            response: 'unable_to_accept_request_error',
        });
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: cancel_request_driver
 * event: cancel_request_driver_io
 * Cancel any request from the driver's side.
 */
app.post('/cancel_request_driver_io', function (req, res) {
    req = req.body;
    //logger.info(req);
    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/cancel_request_driver';

        requestAPI.post({ url, form: req }, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'unable_to_cancel_request_error',
                    });
                }
            } else {
                res.send({
                    response: 'unable_to_cancel_request_error',
                });
            }
        });
    } else {
        res.send({
            response: 'unable_to_cancel_request_error',
        });
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: confirm_pickup_request_driver
 * event: confirm_pickup_request_driver_io
 * Confirm pickup for any request from the driver's side.
 */
app.post('/confirm_pickup_request_driver_io', function (req, res) {
    //logger.info(req);
    req = req.body;

    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/confirm_pickup_request_driver';

        requestAPI.post({ url, form: req }, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'unable_to_confirm_pickup_request_error',
                    });
                }
            } else {
                res.send({
                    response: 'unable_to_confirm_pickup_request_error',
                });
            }
        });
    } else {
        res.send({
            response: 'unable_to_confirm_pickup_request_error',
        });
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: confirm_pickup_request_driver
 * Confirm that the shopping is done for any request from the driver's side.
 */
app.post('/confirm_doneShopping_request_driver_io', function (req, res) {
    req = req.body;
    //logger.info(req);

    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/confirm_doneShopping_request_driver';

        requestAPI.post({ url, form: req }, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response:
                            'unable_to_confirm_doneShopping_request_error',
                    });
                }
            } else {
                res.send({
                    response: 'unable_to_confirm_doneShopping_request_error',
                });
            }
        });
    } else {
        res.send({
            response: 'unable_to_confirm_doneShopping_request_error',
        });
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: decline_request
 * event: declineRequest_driver
 * Decline any request from the driver's side.
 */
app.post('/declineRequest_driver', function (req, res) {
    //logger.info(req);
    req = req.body;
    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/decline_request';

        requestAPI.post({ url, form: req }, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'unable_to_decline_request_error',
                    });
                }
            } else {
                res.send({
                    response: 'unable_to_decline_request_error',
                });
            }
        });
    } else {
        res.send({
            response: 'unable_to_decline_request_error',
        });
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: confirm_dropoff_request_driver
 * event: confirm_dropoff_request_driver_io
 * Confirm dropoff for any request from the driver's side.
 */
app.post('/confirm_dropoff_request_driver_io', function (req, res) {
    //logger.info(req);
    req = req.body;
    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.request_fp !== undefined &&
        req.request_fp !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/confirm_dropoff_request_driver';

        requestAPI.post({ url, form: req }, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'unable_to_confirm_dropoff_request_error',
                    });
                }
            } else {
                res.send({
                    response: 'unable_to_confirm_dropoff_request_error',
                });
            }
        });
    } else {
        res.send({
            response: 'unable_to_confirm_dropoff_request_error',
        });
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: getRequests_graphNumbers
 * event: update_requestsGraph
 * Update the general requests numbers for ease of access
 */
app.post('/update_requestsGraph', function (req, res) {
    //logger.info(req);
    req = req.body;
    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.DISPATCH_SERVICE_PORT +
            '/getRequests_graphNumbers?driver_fingerprint=' +
            req.driver_fingerprint;

        requestAPI(url, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        rides: 0,
                        deliveries: 0,
                        scheduled: 0,
                        accepted: 0,
                    });
                }
            } else {
                res.send({
                    rides: 0,
                    deliveries: 0,
                    scheduled: 0,
                    accepted: 0,
                });
            }
        });
    } else {
        res.send({
            rides: 0,
            deliveries: 0,
            scheduled: 0,
            accepted: 0,
        });
    }
});

/**
 * ACCOUNTS SERVICE, port 9696
 * Route: getDrivers_walletInfosDeep
 * event: getDrivers_walletInfosDeep_io
 * Responsible for computing the wallet deep summary for the drivers
 */
app.post('/getDrivers_walletInfosDeep_io', function (req, res) {
    //logger.info(req);
    req = req.body;

    if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.ACCOUNTS_SERVICE_PORT +
            '/getDrivers_walletInfosDeep?user_fingerprint=' +
            req.user_fingerprint;

        requestAPI(url, function (error, response, body) {
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        header: null,
                        weeks_view: null,
                        response: 'error',
                    });
                }
            } else {
                res.send({
                    header: null,
                    weeks_view: null,
                    response: 'error',
                });
            }
        });
    } else {
        res.send({
            header: null,
            weeks_view: null,
            response: 'error',
        });
    }
});

/**
 * ACCOUNTS SERVICE, port 9696
 * Route: getRiders_walletInfos
 * event: getRiders_walletInfos_io
 * Responsible for computing the wallet summary (total and details) for the riders.
 * ! TO BE RESTORED WITH THE WALLET AND OPTIMAL APP UPDATE.
 */
app.post('/getRiders_walletInfos_io', function (req, res) {
    //logger.info(req);
    req = req.body;
    if (
        req.user_fingerprint !== undefined &&
        req.user_fingerprint !== null &&
        req.mode !== undefined &&
        req.mode !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.ACCOUNTS_SERVICE_PORT +
            '/getRiders_walletInfos?user_fingerprint=' +
            req.user_fingerprint +
            '&mode=' +
            req.mode +
            '&avoidCached_data=true';

        requestAPI(url, function (error, response, body) {
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        total: 0,
                        response: 'error',
                        tag: 'invalid_parameters',
                    });
                }
            } else {
                res.send({
                    total: 0,
                    response: 'error',
                    tag: 'invalid_parameters',
                });
            }
        });
    } else {
        res.send({
            total: 0,
            response: 'error',
            tag: 'invalid_parameters',
        });
    }
});

/**
 * ACCOUNTS SERVICE, port 9696
 * Route: computeDaily_amountMadeSoFar
 * event: computeDaily_amountMadeSoFar_io
 * Responsible for getting the daily amount made so far by the driver for exactly all the completed requests.
 */
app.post('/computeDaily_amountMadeSoFar_io', function (req, res) {
    //logger.info(req);
    req = req.body;

    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.ACCOUNTS_SERVICE_PORT +
            '/computeDaily_amountMadeSoFar?driver_fingerprint=' +
            req.driver_fingerprint;

        requestAPI(url, function (error, response, body) {
            //logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        amount: 0,
                        currency: 'NAD',
                        currency_symbol: 'N$',
                        response: 'error',
                    });
                }
            } else {
                res.send({
                    amount: 0,
                    currency: 'NAD',
                    currency_symbol: 'N$',
                    response: 'error',
                });
            }
        });
    } else {
        res.send({
            amount: 0,
            currency: 'NAD',
            currency_symbol: 'N$',
            response: 'error',
        });
    }
});

//Drivers checking - Phone number
app.post('/sendOtpAndCheckerUserStatusTc', async (req, res) => {
    try {
        const { phone_number } = req.body;

        if (!phone_number)
            return res.send({ response: 'error_phone_number_not_received' });

        const driver = await DriversModel.query('phone_number')
            .eq(phone_number)
            .exec();

        if (driver.count > 0) {
            const driverData = driver[0];

            const didSendOTP = await shouldSendNewSMS(
                driverData,
                phone_number,
                true
            );

            if (didSendOTP) {
                return res.send({
                    _id: driverData.id,
                    response: 'registered',
                    user_fp: driverData.id,
                    name: driverData.name,
                    surname: driverData.surname,
                    gender: driverData.gender,
                    phone_number: driverData.phone_number,
                    email: driverData.email,
                    profile_picture: `${process.env.AWS_S3_DRIVERS_PROFILE_PICTURES_PATH}/${driverData.identification_data.profile_picture}`,
                    account_state: driverData?.account_state ?? 'valid', //? By default - Valid
                    pushnotif_token: driverData.pushnotif_token,
                    suspension_message: driverData.suspension_message,
                });
            }

            return res.send({ response: 'error_checking_user' });
        } //Unregistered user
        else {
            //Get the last
            const didSendOTP = await shouldSendNewSMS(null, phone_number, true);

            if (didSendOTP) return res.send({ response: 'not_yet_registered' });

            return res.send({ response: 'error_checking_user' });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error_checking_user' });
    }
});

//For drivers only
app.post('/checkThisOTP_SMS', async (req, res) => {
    try {
        const { phone_number, otp, user_nature } = req.body;

        if (!phone_number || !otp)
            return res.send({ response: 'error_checking_otp' });

        const driver = await DriversModel.query('phone_number')
            .eq(phone_number)
            .exec();

        if (!driver) {
            //Unregistered users
            const otpCheck = await OTPModel.query('phone_number')
                .eq(phone_number)
                .filter('otp')
                .eq(otp)
                .exec();

            if (otpCheck.count > 0) return res.send({ response: true });

            return res.send({ response: false });
        } //Checking for registered user - check the OTP secrets binded to the profile
        else {
            const driver = await DriversModel.query('phone_number')
                .eq(phone_number)
                .filter('otp')
                .eq(otp)
                .exec();

            if (driver.count > 0) return res.send({ response: true });

            res.send({ response: false });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error_checking_otp' });
    }
});

app.post('/goOnline_offlineDrivers_io', function (req, res) {
    req = req.body;
    //logger.info(req);
    if (
        req.driver_fingerprint !== undefined &&
        req.driver_fingerprint !== null &&
        req.action !== undefined &&
        req.action !== null
    ) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.ACCOUNTS_SERVICE_PORT +
            '/goOnline_offlineDrivers?driver_fingerprint=' +
            req.driver_fingerprint +
            '&action=' +
            req.action;

        //Add the state if found
        if (req.state !== undefined && req.state !== null) {
            url += '&state=' + req.state;
        } else {
            url += '&state=false';
        }

        requestAPI(url, function (error, response, body) {
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'error_invalid_request',
                    });
                }
            } else {
                res.send({
                    response: 'error_invalid_request',
                });
            }
        });
    } else {
        res.send({
            response: 'error_invalid_request',
        });
    }
});

app.post('/driversOverallNumbers', function (req, res) {
    logger.info(req);
    req = req.body;
    if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.ACCOUNTS_SERVICE_PORT +
            '/getDriversGeneralAccountNumber?user_fingerprint=' +
            req.user_fingerprint;

        requestAPI(url, function (error, response, body) {
            // logger.info(body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'error',
                    });
                }
            } else {
                res.send({
                    response: 'error',
                });
            }
        });
    } else {
        res.send({
            response: 'error',
        });
    }
});

app.post('/getRides_historyRiders_batchOrNot', function (req, res) {
    req = req.body;
    //logger.info(req);
    if (req.user_fingerprint !== undefined && req.user_fingerprint !== null) {
        let url =
            `${
                /production/i.test(process.env.EVIRONMENT)
                    ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                    : process.env.LOCAL_URL
            }` +
            ':' +
            process.env.ACCOUNTS_SERVICE_PORT +
            '/getRides_historyRiders?user_fingerprint=' +
            req.user_fingerprint;
        //Add a ride_type if any
        if (req.ride_type !== undefined && req.ride_type !== null) {
            url += '&ride_type=' + req.ride_type;
        }
        //Add a request fp and targeted flag or any
        if (
            req.target !== undefined &&
            req.target !== null &&
            req.request_fp !== undefined &&
            req.request_fp !== null
        ) {
            //Targeted request (target flags: single, multiple)
            url += '&target=' + req.target + '&request_fp=' + req.request_fp;
        }
        //? Add the user nature for drivers if any
        if (req.user_nature !== undefined && req.user_nature !== null) {
            url += `&user_nature=${req.user_nature}`;
        }
        //...
        requestAPI(url, function (error, response, body) {
            //logger.info(error, body);
            if (error === null) {
                try {
                    body = JSON.parse(body);
                    res.send(body);
                } catch (error) {
                    res.send({
                        response: 'error_authentication_failed',
                    });
                }
            } else {
                res.send({
                    response: 'error_authentication_failed',
                });
            }
        });
    } else {
        res.send({
            response: 'error_authentication_failed',
        });
    }
});

/**
 * ADMINISTRATIONS APIS
 */
//1. Get the list of all the users
app.post('/getUsersList', function (req, res) {
    req = req.body;

    if (req.admin_fp !== undefined && req.admin_fp !== null) {
        dynamo_get_all({
            table_name: 'users_central',
        })
            .then((usersData) => {
                if (
                    usersData !== undefined &&
                    usersData !== null &&
                    usersData.length > 0
                ) {
                    //Found some data
                    // logger.info(usersData);
                    //Sort based on the registration date
                    usersData.sort((a, b) =>
                        new Date(a.date_registered) >
                        new Date(b.date_registered)
                            ? -1
                            : new Date(a.date_registered) >
                              new Date(a.date_registered)
                            ? 1
                            : 0
                    );
                    //DONE
                    res.send({ response: usersData });
                } //No users
                else {
                    res.send({ response: [] });
                }
            })
            .catch((error) => {
                logger.error(error);
                res.send({ response: [] });
            });
    } //Invalid data
    else {
        res.send({ response: [] });
    }
});

//2. Get the list of all the drivers
app.post('/getDriversList', function (req, res) {
    req = req.body;

    if (req.admin_fp !== undefined && req.admin_fp !== null) {
        //1. Get alll the applications
        dynamo_get_all({
            table_name: 'drivers_application_central',
        })
            .then((applicationData) => {
                //Sort based on the registration date
                applicationData.sort((a, b) =>
                    new Date(a.date_applied) > new Date(b.date_applied)
                        ? -1
                        : new Date(a.date_applied) > new Date(a.date_applied)
                        ? 1
                        : 0
                );

                dynamo_get_all({
                    table_name: 'drivers_shoppers_central',
                })
                    .then((usersData) => {
                        if (
                            usersData !== undefined &&
                            usersData !== null &&
                            usersData.length > 0
                        ) {
                            //Found some data
                            // logger.info(usersData);
                            //Sort based on the registration date
                            usersData.sort((a, b) =>
                                new Date(a.date_registered) >
                                new Date(b.date_registered)
                                    ? -1
                                    : new Date(a.date_registered) >
                                      new Date(a.date_registered)
                                    ? 1
                                    : 0
                            );
                            //DONE
                            res.send({
                                response: {
                                    registered: usersData,
                                    awaiting: applicationData,
                                },
                            });
                        } //No users
                        else {
                            res.send({
                                response: {
                                    registered: [],
                                    awaiting: applicationData,
                                },
                            });
                        }
                    })
                    .catch((error) => {
                        logger.error(error);
                        res.send({
                            response: {
                                registered: [],
                                awaiting: applicationData,
                            },
                        });
                    });
            })
            .catch((error) => {
                logger.error(error);
                res.send({ response: { registered: [], awaiting: [] } });
            });
    } //Invalid data
    else {
        res.send({ response: { registered: [], awaiting: [] } });
    }
});

//3. suspended or unsuspend a driver
app.post('/suspendUnsuspendDriver', function (req, res) {
    resolveDate();

    req = req.body;

    //? Get the _id
    if (
        req.admin_fp !== undefined &&
        req.admin_fp !== null &&
        req.operation !== undefined &&
        req.operation !== null &&
        req.driver_id !== undefined &&
        req.driver_id !== null
    ) {
        dynamo_update({
            table_name: 'drivers_shoppers_central',
            _idKey: req.driver_id,
            UpdateExpression:
                'set isDriverSuspended = :val1, #idData.#dateUp = :val2, #opState.#st = :val3',
            ExpressionAttributeValues: {
                ':val1': req.operation === 'suspend',
                ':val2': new Date(chaineDateUTC).toISOString(),
                ':val3': req.operation === 'suspend' ? 'offline' : 'online',
            },
            ExpressionAttributeNames: {
                '#idData': 'identification_data',
                '#dateUp': 'date_updated',
                '#opState': 'operational_state',
                '#st': 'status',
            },
        }).then((result) => {
            if (result === false) {
                //Error
                res.send({ response: 'error' });
            }
            //....
            res.send({ response: 'success' });
        });
    } //Invalid data
    else {
        res.send({ response: 'error' });
    }
});

//4. Approve driver account
app.post('/approveDriverAccount', function (req, res) {
    resolveDate();
    req = req.body;

    if (
        req.admin_fp !== undefined &&
        req.admin_fp !== null &&
        req.driverData !== undefined &&
        req.driverData !== null
    ) {
        let driverData = req.driverData;
        //1. Create a fresh driver object
        let templateDRIVER = {
            identification_data: {
                date_updated: new Date(chaineDateUTC).toISOString(), //Done
                rating: 5, //Done
                copy_id_paper: driverData.documents.id_photo, //Done
                profile_picture: driverData.documents.driver_photo, //Done
                banking_details: {}, //Done
                driver_licence_doc: driverData.documents.license_photo, //Done
                title: 'Mr', //Done
                copy_blue_paper:
                    driverData.documents.blue_paper_photo !== undefined
                        ? driverData.documents.blue_paper_photo
                        : null, //Done
                copy_public_permit:
                    driverData.documents.permit_photo !== undefined
                        ? driverData.documents.permit_photo
                        : null, //Done
                isAccount_verified: true,
                copy_white_paper:
                    driverData.documents.white_paper_photo !== undefined
                        ? driverData.documents.white_paper_photo
                        : null, //Done
                paymentNumber: otpGenerator.generate(6, {
                    lowerCaseAlphabets: false,
                    upperCaseAlphabets: false,
                    specialChars: false,
                }), //Done
                personal_id_number: 'Not set', //Done
            },
            date_updated: new Date(chaineDateUTC).toISOString(), //DOne
            gender: 'Not set', //Done
            account_verifications: {},
            payments_information: {},
            date_registered: new Date(chaineDateUTC).toISOString(), //Done
            operation_clearances:
                driverData.nature_driver === 'COURIER' ? 'DELIVERY' : 'RIDE', //Done
            passwod: `${otpGenerator.generate(7, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false,
            })}`, //Done
            owners_information: false, //DOne
            surname: driverData.surname, //Done
            driver_fingerprint: driverData.driver_fingerprint, //Done
            suspension_infos: [], //Done
            suspension_message: 'false', //Done
            name: driverData.name, //Done
            phone_number: /\+/i.test(driverData.phone_number)
                ? driverData.phone_number
                : `+${driverData.phone_number}`, //Done
            cars_data: [
                {
                    date_updated: new Date(chaineDateUTC).toISOString(), //Done
                    permit_number: driverData.vehicle_details.permit_number, //Done
                    taxi_number: driverData.vehicle_details.taxi_number, //DOne
                    max_passengers: 4, //Done
                    taxi_picture: driverData.documents.vehicle_photo, //DOne
                    car_brand: driverData.vehicle_details.brand_name, //DOne
                    vehicle_type: 'normalTaxiEconomy', //Done
                    plate_number: driverData.vehicle_details.plate_number, //Done
                    car_fingerprint: driverData.id, //Done
                    model_name: driverData.vehicle_details.model_name, //DOne
                    color: driverData.vehicle_details.color, //Done
                    date_registered: new Date(chaineDateUTC).toISOString(), //Done
                },
            ],
            isDriverSuspended: false, //Done
            operational_state: {
                last_location: new Date(chaineDateUTC).toISOString(), //Done
                push_notification_token: 'abc', //Done
                default_selected_car: {
                    vehicle_type: 'normalTaxiEconomy', //Done
                    date_Selected: new Date(chaineDateUTC).toISOString(), //Done
                    car_fingerprint: driverData.id, //Done
                    max_passengers: 4, //Done
                },
                status: 'online', //Done
            },
            regional_clearances: [ucFirst(driverData['city'])], //Done
            email: driverData['email'], //Done
        };

        //2. Move all the documents from the application folder to the approved one on S3
        // logger.warn(templateDRIVER);
        let filesMap = [
            {
                filename: templateDRIVER.identification_data.copy_id_paper,
                dest_folder: 'Drivers_documents',
            },
            {
                filename: templateDRIVER.identification_data.profile_picture,
                dest_folder: 'Profiles_pictures',
            },
            {
                filename: templateDRIVER.identification_data.driver_licence_doc,
                dest_folder: 'Drivers_documents',
            },
            {
                filename: templateDRIVER.identification_data.copy_blue_paper,
                dest_folder: 'Drivers_documents',
            },
            {
                filename: templateDRIVER.identification_data.copy_public_permit,
                dest_folder: 'Drivers_documents',
            },
            {
                filename: templateDRIVER.identification_data.copy_white_paper,
                dest_folder: 'Drivers_documents',
            },
            {
                filename: templateDRIVER.cars_data[0].taxi_picture,
                dest_folder: 'Drivers_documents',
            },
        ];

        //! remove all invalid file names
        filesMap = filesMap.filter(
            (file) =>
                file.filename !== undefined &&
                file.filename !== null &&
                file.filename.length > 0
        );

        logger.warn(filesMap);
        //...
        let parentPromises = filesMap.map((document) => {
            return new Promise(async (resMove) => {
                let s3Params = {
                    Bucket: process.env.AWS_S3_DRIVERS_BUCKET_NAME,
                    CopySource: `${process.env.AWS_S3_DRIVERS_BUCKET_NAME}/Drivers_Applications/${document.filename}`,
                    Key: `${document.dest_folder}/${document.filename}`,
                };

                try {
                    await copyFile(s3Params).then((r) => console.log(r));
                    console.log('All good');
                    resMove(true);
                } catch (ex) {
                    console.log(`Failed with the following exception : ${ex}`);
                    resMove(false);
                }
            });
        });
        //DONE
        Promise.all(parentPromises)
            .then((resultMoving) => {
                logger.info(resultMoving);
                //! Check if there are any error
                let areThereErrors = resultMoving.filter((el) => el === false);

                if (areThereErrors.length === 0) {
                    //? No errors - all good
                    //Migrate the driver record in the database of registered drivers and delete the application record
                    //1. Move to official table
                    dynamo_insert('drivers_shoppers_central', templateDRIVER)
                        .then((result) => {
                            if (result === false) {
                                res.send({
                                    response: 'error',
                                    message:
                                        'Could not register the driver officially.',
                                });
                            }
                            //....
                            //4. Delete the record
                            dynamo_delete(
                                'drivers_application_central',
                                req.driverData.id
                            )
                                .then((resultDel) => {
                                    //3. Register the event
                                    let approveEvent = {
                                        date: new Date(
                                            chaineDateUTC
                                        ).toISOString(),
                                        event_name:
                                            'driver_approval_registration',
                                        registration_id: `${otpGenerator.generate(
                                            128,
                                            {
                                                lowerCaseAlphabets: true,
                                                upperCaseAlphabets: true,
                                                specialChars: false,
                                            }
                                        )}`,
                                        driver_fingerprint:
                                            templateDRIVER.driver_fingerprint,
                                        recordData: req.driverData,
                                    };
                                    //...
                                    dynamo_insert(
                                        'global_events',
                                        approveEvent
                                    ).then((resultApprove) => {
                                        res.send({ response: 'success' });
                                    });
                                })
                                .catch((error) => {
                                    logger.error(error);
                                    res.send({ response: 'success' });
                                });
                        })
                        .catch((error) => {
                            logger.error(error);
                            res.send({
                                response: 'error',
                                message:
                                    'Could not register the driver officially.',
                            });
                        });
                } //Has some errors
                else {
                    res.send({
                        response: 'error',
                        message: "Could not migrate the driver's documents.",
                    });
                }
            })
            .catch((error) => {
                logger.error(error);
                res.send({ response: 'error' });
            });
    } //Invalid data
    else {
        res.send({ response: 'error' });
    }
});

//5. Get the requests list for the admin
//Needs to be well segmented.
app.post('/getGeneralRequestsList', function (req, res) {
    resolveDate();

    req = req.body;

    //? Get the _id
    if (req.admin_fp !== undefined && req.admin_fp !== null) {
        //Get all the requests
        dynamo_get_all({
            table_name: 'requests_central',
        })
            .then((allRequests) => {
                if (allRequests !== undefined && allRequests.length > 0) {
                    //Found some requests
                    //?Sort based on the requested date
                    allRequests.sort((a, b) =>
                        new Date(a.date_requested) > new Date(b.date_requested)
                            ? -1
                            : new Date(a.date_requested) >
                              new Date(a.date_requested)
                            ? 1
                            : 0
                    );

                    //! Attach the rider details
                    let parentPromises1 = allRequests.map((request, index) => {
                        return new Promise((resCompute) => {
                            dynamo_find_query({
                                table_name: 'users_central',
                                IndexName: 'user_identifier',
                                KeyConditionExpression:
                                    'user_identifier = :val1',
                                ExpressionAttributeValues: {
                                    ':val1': request.client_id,
                                },
                            })
                                .then((clientData) => {
                                    if (
                                        clientData !== undefined &&
                                        clientData.length > 0
                                    ) {
                                        //Has some client data
                                        //Save
                                        allRequests[index]['clientData'] =
                                            clientData[0];
                                        resCompute(true);
                                    } //No client?
                                    else {
                                        allRequests[index][
                                            'clientData'
                                        ] = false;
                                        resCompute(false);
                                    }
                                })
                                .catch((error) => {
                                    logger.error(error);
                                    allRequests[index]['clientData'] = false;
                                    resCompute(false);
                                });
                        });
                    });

                    //DONE
                    Promise.all(parentPromises1)
                        .then((result) => {
                            // logger.info(result);
                        })
                        .catch((error) => {
                            logger.error(error);
                        })
                        .finally(() => {
                            //! Attach the driver details
                            let parentPromises2 = allRequests.map(
                                (request, index) => {
                                    return new Promise((resCompute) => {
                                        dynamo_find_query({
                                            table_name:
                                                'drivers_shoppers_central',
                                            IndexName: 'driver_fingerprint',
                                            KeyConditionExpression:
                                                'driver_fingerprint = :val1',
                                            ExpressionAttributeValues: {
                                                ':val1': request.shopper_id,
                                            },
                                        })
                                            .then((driverData) => {
                                                if (
                                                    driverData !== undefined &&
                                                    driverData.length > 0
                                                ) {
                                                    //Has some driver data
                                                    //Save
                                                    allRequests[index][
                                                        'driverData'
                                                    ] = driverData[0];
                                                    resCompute(true);
                                                } //No client?
                                                else {
                                                    allRequests[index][
                                                        'driverData'
                                                    ] = false;
                                                    resCompute(false);
                                                }
                                            })
                                            .catch((error) => {
                                                logger.error(error);
                                                allRequests[index][
                                                    'driverData'
                                                ] = false;
                                                resCompute(false);
                                            });
                                    });
                                }
                            );

                            //DONE
                            Promise.all(parentPromises2)
                                .then((result) => {
                                    // logger.info(result);
                                })
                                .catch((error) => {
                                    logger.error(error);
                                })
                                .finally(() => {
                                    //! Get all the cancelled data
                                    dynamo_get_all({
                                        table_name:
                                            'cancelled_requests_central',
                                    })
                                        .then((allCancelledRequests) => {
                                            allCancelledRequests =
                                                allCancelledRequests !==
                                                    undefined &&
                                                allCancelledRequests !== null
                                                    ? allCancelledRequests
                                                    : []; //Check

                                            //?Sort based on the cancelled date
                                            allCancelledRequests.sort((a, b) =>
                                                new Date(a.date_cancelled) >
                                                new Date(b.date_cancelled)
                                                    ? -1
                                                    : new Date(
                                                          a.date_cancelled
                                                      ) >
                                                      new Date(a.date_cancelled)
                                                    ? 1
                                                    : 0
                                            );

                                            //! Attach the rider details
                                            let parentPromises3 =
                                                allCancelledRequests.map(
                                                    (request, index) => {
                                                        return new Promise(
                                                            (resCompute) => {
                                                                dynamo_find_query(
                                                                    {
                                                                        table_name:
                                                                            'users_central',
                                                                        IndexName:
                                                                            'user_identifier',
                                                                        KeyConditionExpression:
                                                                            'user_identifier = :val1',
                                                                        ExpressionAttributeValues:
                                                                            {
                                                                                ':val1':
                                                                                    request.client_id,
                                                                            },
                                                                    }
                                                                )
                                                                    .then(
                                                                        (
                                                                            clientData
                                                                        ) => {
                                                                            if (
                                                                                clientData !==
                                                                                    undefined &&
                                                                                clientData.length >
                                                                                    0
                                                                            ) {
                                                                                //Has some client data
                                                                                //Save
                                                                                allCancelledRequests[
                                                                                    index
                                                                                ][
                                                                                    'clientData'
                                                                                ] =
                                                                                    clientData[0];
                                                                                resCompute(
                                                                                    true
                                                                                );
                                                                            } //No client?
                                                                            else {
                                                                                allCancelledRequests[
                                                                                    index
                                                                                ][
                                                                                    'clientData'
                                                                                ] = false;
                                                                                resCompute(
                                                                                    false
                                                                                );
                                                                            }
                                                                        }
                                                                    )
                                                                    .catch(
                                                                        (
                                                                            error
                                                                        ) => {
                                                                            logger.error(
                                                                                error
                                                                            );
                                                                            allCancelledRequests[
                                                                                index
                                                                            ][
                                                                                'clientData'
                                                                            ] = false;
                                                                            resCompute(
                                                                                false
                                                                            );
                                                                        }
                                                                    );
                                                            }
                                                        );
                                                    }
                                                );

                                            Promise.all(parentPromises3)
                                                .then((result) => {
                                                    // logger.info(result);
                                                })
                                                .catch((error) => {
                                                    logger.error(error);
                                                })
                                                .finally(() => {
                                                    //! Attach the driver details
                                                    let parentPromises4 =
                                                        allCancelledRequests.map(
                                                            (
                                                                request,
                                                                index
                                                            ) => {
                                                                return new Promise(
                                                                    (
                                                                        resCompute
                                                                    ) => {
                                                                        dynamo_find_query(
                                                                            {
                                                                                table_name:
                                                                                    'drivers_shoppers_central',
                                                                                IndexName:
                                                                                    'driver_fingerprint',
                                                                                KeyConditionExpression:
                                                                                    'driver_fingerprint = :val1',
                                                                                ExpressionAttributeValues:
                                                                                    {
                                                                                        ':val1':
                                                                                            request.shopper_id,
                                                                                    },
                                                                            }
                                                                        )
                                                                            .then(
                                                                                (
                                                                                    driverData
                                                                                ) => {
                                                                                    if (
                                                                                        driverData !==
                                                                                            undefined &&
                                                                                        driverData.length >
                                                                                            0
                                                                                    ) {
                                                                                        //Has some driver data
                                                                                        //Save
                                                                                        allCancelledRequests[
                                                                                            index
                                                                                        ][
                                                                                            'driverData'
                                                                                        ] =
                                                                                            driverData[0];
                                                                                        resCompute(
                                                                                            true
                                                                                        );
                                                                                    } //No client?
                                                                                    else {
                                                                                        allCancelledRequests[
                                                                                            index
                                                                                        ][
                                                                                            'driverData'
                                                                                        ] = false;
                                                                                        resCompute(
                                                                                            false
                                                                                        );
                                                                                    }
                                                                                }
                                                                            )
                                                                            .catch(
                                                                                (
                                                                                    error
                                                                                ) => {
                                                                                    logger.error(
                                                                                        error
                                                                                    );
                                                                                    allCancelledRequests[
                                                                                        index
                                                                                    ][
                                                                                        'driverData'
                                                                                    ] = false;
                                                                                    resCompute(
                                                                                        false
                                                                                    );
                                                                                }
                                                                            );
                                                                    }
                                                                );
                                                            }
                                                        );

                                                    Promise.all(parentPromises4)
                                                        .then((result) => {
                                                            // logger.info(result);
                                                        })
                                                        .catch((error) => {
                                                            logger.error(error);
                                                        })
                                                        .finally(() => {
                                                            //? Assemble the response data
                                                            let RESPONSE_TEMPLATE_DATA =
                                                                {
                                                                    ride: {
                                                                        inprogress:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                        'RIDE' &&
                                                                                    el
                                                                                        .request_state_vars
                                                                                        .completedRatingClient ===
                                                                                        false
                                                                            ),
                                                                        completed:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                        'RIDE' &&
                                                                                    el
                                                                                        .request_state_vars
                                                                                        .completedRatingClient
                                                                            ),
                                                                        cancelled:
                                                                            allCancelledRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'RIDE'
                                                                            ),
                                                                    },
                                                                    delivery: {
                                                                        inprogress:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                        'DELIVERY' &&
                                                                                    el
                                                                                        .request_state_vars
                                                                                        .completedRatingClient ===
                                                                                        false
                                                                            ),
                                                                        completed:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                        'DELIVERY' &&
                                                                                    el
                                                                                        .request_state_vars
                                                                                        .completedRatingClient
                                                                            ),
                                                                        cancelled:
                                                                            allCancelledRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'DELIVERY'
                                                                            ),
                                                                    },
                                                                    shopping: {
                                                                        inprogress:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                        'SHOPPING' &&
                                                                                    el
                                                                                        .request_state_vars
                                                                                        .completedRatingClient ===
                                                                                        false
                                                                            ),
                                                                        completed:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                        'SHOPPING' &&
                                                                                    el
                                                                                        .request_state_vars
                                                                                        .completedRatingClient
                                                                            ),
                                                                        cancelled:
                                                                            allCancelledRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'SHOPPING'
                                                                            ),
                                                                    },
                                                                    stats: {
                                                                        total_sales_today:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests,
                                                                                    dataType:
                                                                                        'sales',
                                                                                }
                                                                            ),
                                                                        total_revenue_today:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests,
                                                                                    dataType:
                                                                                        'revenue',
                                                                                }
                                                                            ),
                                                                        total_requests_success:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests,
                                                                                    dataType:
                                                                                        'requests',
                                                                                }
                                                                            ),
                                                                    },
                                                                };

                                                            // logger.info(RESPONSE_TEMPLATE_DATA);
                                                            //...
                                                            res.send({
                                                                response:
                                                                    RESPONSE_TEMPLATE_DATA,
                                                            });
                                                        });
                                                });
                                        })
                                        .catch((error) => {
                                            logger.error(error);
                                            res.send({ response: 'error' });
                                        });
                                });
                        });
                } //No requests
                else {
                    res.send({ response: {} });
                }
            })
            .catch((error) => {
                logger.error(error);
                res.send({ response: 'error' });
            });
    } //Invalid data
    else {
        res.send({ response: 'error' });
    }
});

// 6. Get the summary data
app.post('/getSummaryData', function (req, res) {
    resolveDate();

    req = req.body;

    //Check the admin
    if (req.admin_fp !== undefined && req.admin_fp !== null) {
        //1. Get all the requests
        dynamo_get_all({
            table_name: 'requests_central',
        })
            .then((allRequests) => {
                //2. Get al the cancelled requests
                dynamo_get_all({
                    table_name: 'cancelled_requests_central',
                })
                    .then((allCancelledRequests) => {
                        //4. Get all the users
                        dynamo_get_all({
                            table_name: 'users_central',
                        })
                            .then((allUsers) => {
                                //5. Get all the drivers
                                dynamo_get_all({
                                    table_name: 'drivers_shoppers_central',
                                })
                                    .then((allDrivers) => {
                                        //6. Get all the stores
                                        dynamo_get_all({
                                            table_name: 'shops_central',
                                        })
                                            .then((allStores) => {
                                                //7. Get all the catalogue
                                                dynamo_get_all({
                                                    table_name:
                                                        'catalogue_central',
                                                })
                                                    .then((allCatalogue) => {
                                                        //? Got all ther required data
                                                        let TEMPLATE_SUMMARY_META =
                                                            {
                                                                today_graph_data:
                                                                    {
                                                                        successful_requests:
                                                                            generateGraphDataFromRequestsData(
                                                                                {
                                                                                    requestData:
                                                                                        allRequests,
                                                                                }
                                                                            ),
                                                                        cancelled_requests:
                                                                            generateGraphDataFromRequestsData(
                                                                                {
                                                                                    requestData:
                                                                                        allCancelledRequests,
                                                                                }
                                                                            ),
                                                                    },
                                                                today: {
                                                                    total_requests:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        )
                                                                            .length,
                                                                    total_rides:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        ).filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.ride_mode ===
                                                                                'RIDE'
                                                                        )
                                                                            .length,
                                                                    total_deliveries:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        ).filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.ride_mode ===
                                                                                'DELIVERY'
                                                                        )
                                                                            .length,
                                                                    total_shoppings:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        ).filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.ride_mode ===
                                                                                'SHOPPING'
                                                                        )
                                                                            .length,
                                                                    total_cancelled_requests:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allCancelledRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        )
                                                                            .length,
                                                                    total_cancelled_rides:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allCancelledRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        ).filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.ride_mode ===
                                                                                'RIDE'
                                                                        )
                                                                            .length,
                                                                    total_cancelled_deliveries:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allCancelledRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        ).filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.ride_mode ===
                                                                                'DELIVERY'
                                                                        )
                                                                            .length,
                                                                    total_cancelled_shoppings:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allCancelledRequests,
                                                                                dataType:
                                                                                    'todayOnly',
                                                                            }
                                                                        ).filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.ride_mode ===
                                                                                'SHOPPING'
                                                                        )
                                                                            .length,
                                                                    total_sales:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allRequests,
                                                                                dataType:
                                                                                    'sales',
                                                                            }
                                                                        ),
                                                                    total_revenues:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allRequests,
                                                                                dataType:
                                                                                    'revenue',
                                                                            }
                                                                        ),
                                                                    total_loss:
                                                                        getAmountsSums(
                                                                            {
                                                                                arrayRequests:
                                                                                    allCancelledRequests.filter(
                                                                                        (
                                                                                            el
                                                                                        ) =>
                                                                                            isToday(
                                                                                                new Date(
                                                                                                    el.date_requested
                                                                                                )
                                                                                            )
                                                                                    ),
                                                                                dataType:
                                                                                    'gross_sum',
                                                                            }
                                                                        ),
                                                                    percentage_handling: 0,
                                                                },
                                                                general_requests:
                                                                    {
                                                                        total_requests:
                                                                            allRequests.length,
                                                                        total_rides:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'RIDE'
                                                                            )
                                                                                .length,
                                                                        total_deliveries:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'DELIVERY'
                                                                            )
                                                                                .length,
                                                                        total_shoppings:
                                                                            allRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'SHOPPING'
                                                                            )
                                                                                .length,
                                                                        total_cancelled_requests:
                                                                            allCancelledRequests.length,
                                                                        total_cancelled_rides:
                                                                            allCancelledRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'RIDE'
                                                                            )
                                                                                .length,
                                                                        total_cancelled_deliveries:
                                                                            allCancelledRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'DELIVERY'
                                                                            )
                                                                                .length,
                                                                        total_cancelled_shoppings:
                                                                            allCancelledRequests.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.ride_mode ===
                                                                                    'SHOPPING'
                                                                            )
                                                                                .length,
                                                                        percentage_handling: 0,
                                                                    },
                                                                general_finances:
                                                                    {
                                                                        total_sales:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests,
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        total_revenues:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests,
                                                                                    dataType:
                                                                                        'net_sum',
                                                                                }
                                                                            ),
                                                                        total_rides_sales:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'RIDE'
                                                                                        ),
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        total_rides_revenues:
                                                                            'Not considered',
                                                                        total_deliveries_sales:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'DELIVERY'
                                                                                        ),
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        total_deliveries_revenues:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'DELIVERY'
                                                                                        ),
                                                                                    dataType:
                                                                                        'net_sum',
                                                                                }
                                                                            ),
                                                                        total_shoppings_sales:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'SHOPPING'
                                                                                        ),
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        total_shoppings_revenues:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'SHOPPING'
                                                                                        ),
                                                                                    dataType:
                                                                                        'net_sum',
                                                                                }
                                                                            ),
                                                                        total_loss:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allCancelledRequests,
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        total_net_loss:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allCancelledRequests,
                                                                                    dataType:
                                                                                        'net_sum',
                                                                                }
                                                                            ),
                                                                        total_rides_loss:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allCancelledRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'RIDE'
                                                                                        ),
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        total_deliveries_loss:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allCancelledRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'DELIVERY'
                                                                                        ),
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        total_shoppings_loss:
                                                                            getAmountsSums(
                                                                                {
                                                                                    arrayRequests:
                                                                                        allCancelledRequests.filter(
                                                                                            (
                                                                                                el
                                                                                            ) =>
                                                                                                el.ride_mode ===
                                                                                                'SHOPPING'
                                                                                        ),
                                                                                    dataType:
                                                                                        'gross_sum',
                                                                                }
                                                                            ),
                                                                        percentage_handling: 0,
                                                                    },
                                                                users: {
                                                                    total_users:
                                                                        allUsers.length,
                                                                    total_male_users:
                                                                        allUsers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^m/i.test(
                                                                                    el.gender
                                                                                )
                                                                        )
                                                                            .length,
                                                                    total_female_users:
                                                                        allUsers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^f/i.test(
                                                                                    el.gender
                                                                                )
                                                                        )
                                                                            .length,
                                                                    total_unknown_gender_users:
                                                                        allUsers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^m/i.test(
                                                                                    el.gender
                                                                                ) ===
                                                                                    false &&
                                                                                /^f/i.test(
                                                                                    el.gender
                                                                                ) ===
                                                                                    false
                                                                        )
                                                                            .length,
                                                                    total_mtc_users:
                                                                        allUsers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /26481/i.test(
                                                                                    el.phone_number
                                                                                )
                                                                        )
                                                                            .length,
                                                                    total_tnmobile_users:
                                                                        allUsers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /26485/i.test(
                                                                                    el.phone_number
                                                                                )
                                                                        )
                                                                            .length,
                                                                },
                                                                drivers: {
                                                                    total_drivers:
                                                                        allDrivers.length,
                                                                    total_ride_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.operation_clearances ===
                                                                                'RIDE'
                                                                        )
                                                                            .length,
                                                                    total_delivery_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.operation_clearances ===
                                                                                'DELIVERY'
                                                                        )
                                                                            .length,
                                                                    total_shoppers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                el.operation_clearances ===
                                                                                'SHOPPING'
                                                                        )
                                                                            .length,
                                                                    total_male_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^m/i.test(
                                                                                    el.gender
                                                                                )
                                                                        )
                                                                            .length,
                                                                    total_female_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^f/i.test(
                                                                                    el.gender
                                                                                )
                                                                        )
                                                                            .length,
                                                                    total_unknown_gender_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^m/i.test(
                                                                                    el.gender
                                                                                ) ===
                                                                                    false &&
                                                                                /^f/i.test(
                                                                                    el.gender
                                                                                ) ===
                                                                                    false
                                                                        )
                                                                            .length,
                                                                    total_male_ride_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^m/i.test(
                                                                                    el.gender
                                                                                ) &&
                                                                                el.operation_clearances ===
                                                                                    'RIDE'
                                                                        )
                                                                            .length,
                                                                    total_female_ride_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^f/i.test(
                                                                                    el.gender
                                                                                ) &&
                                                                                el.operation_clearances ===
                                                                                    'RIDE'
                                                                        )
                                                                            .length,
                                                                    total_male_delivery_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^m/i.test(
                                                                                    el.gender
                                                                                ) &&
                                                                                el.operation_clearances ===
                                                                                    'DELIVERY'
                                                                        )
                                                                            .length,
                                                                    total_female_delivery_drivers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^f/i.test(
                                                                                    el.gender
                                                                                ) &&
                                                                                el.operation_clearances ===
                                                                                    'DELIVERY'
                                                                        )
                                                                            .length,
                                                                    total_male_shoppers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^m/i.test(
                                                                                    el.gender
                                                                                ) &&
                                                                                el.operation_clearances ===
                                                                                    'SHOPPING'
                                                                        )
                                                                            .length,
                                                                    total_female_shoppers:
                                                                        allDrivers.filter(
                                                                            (
                                                                                el
                                                                            ) =>
                                                                                /^f/i.test(
                                                                                    el.gender
                                                                                ) &&
                                                                                el.operation_clearances ===
                                                                                    'SHOPPING'
                                                                        )
                                                                            .length,
                                                                },
                                                                shopping_details:
                                                                    {
                                                                        total_stores_registered:
                                                                            allStores.length,
                                                                        total_unpublished_stores:
                                                                            allStores.filter(
                                                                                (
                                                                                    el
                                                                                ) =>
                                                                                    el.publish ===
                                                                                        undefined ||
                                                                                    el.publish ===
                                                                                        null ||
                                                                                    el.publish
                                                                            )
                                                                                .length,
                                                                        total_products_in_catalogue:
                                                                            allCatalogue.length,
                                                                        interval_catalogue_update:
                                                                            'Every 3 days',
                                                                        last_updated:
                                                                            allCatalogue[
                                                                                allCatalogue.length -
                                                                                    1
                                                                            ]
                                                                                .date_added,
                                                                    },
                                                            };

                                                        //Start filling out
                                                        // logger.info(TEMPLATE_SUMMARY_META);
                                                        res.send({
                                                            response:
                                                                TEMPLATE_SUMMARY_META,
                                                        });
                                                    })
                                                    .catch((error) => {
                                                        logger.error(error);
                                                        res.send({
                                                            response: 'error',
                                                        });
                                                    });
                                            })
                                            .catch((error) => {
                                                logger.error(error);
                                                res.send({ response: 'error' });
                                            });
                                    })
                                    .catch((error) => {
                                        logger.error(error);
                                        res.send({ response: 'error' });
                                    });
                            })
                            .catch((error) => {
                                logger.error(error);
                                res.send({ response: 'error' });
                            });
                    })
                    .catch((error) => {
                        logger.error(error);
                        res.send({ response: 'error' });
                    });
            })
            .catch((error) => {
                logger.error(error);
                res.send({ response: 'error' });
            });
    } //Invalid data
    else {
        res.send({ response: 'error' });
    }
});

//! 7. Login checks for the admins
app.post('/loginOrChecksForAdmins', function (req, res) {
    resolveDate();

    req = req.body;

    if (
        req.email !== undefined &&
        req.email !== null &&
        req.password !== undefined &&
        req.password !== null
    ) {
        //Valid set of data
        if (req.otp === undefined) {
            //Check login credentials
            req.email = req.email.trim();
            req.password = req.password.trim();
            //...
            //Hash the password
            new Promise((resolve) =>
                generateUniqueFingerprint(
                    req.password,
                    'sha512WithRSAEncryption',
                    resolve
                )
            )
                .then((passwordHashed) => {
                    //?Check the credentials
                    dynamo_find_query({
                        table_name: 'administration_central',
                        IndexName: 'corporate_email',
                        KeyConditionExpression: 'corporate_email = :val1',
                        FilterExpression: 'password = :val2',
                        ExpressionAttributeValues: {
                            ':val1': req.email,
                            ':val2': passwordHashed,
                        },
                    })
                        .then((adminData) => {
                            if (
                                adminData !== undefined &&
                                adminData !== false &&
                                adminData.length > 0
                            ) {
                                //! Found the admin
                                //Generate the otp - 8-digits
                                let otp = otpGenerator.generate(8, {
                                    lowerCaseAlphabets: false,
                                    upperCaseAlphabets: false,
                                    specialChars: false,
                                });
                                //! --------------
                                otp =
                                    String(otp).length < 8
                                        ? parseInt(otp) * 10
                                        : otp;

                                //? Update the otp in the admin profile
                                dynamo_update({
                                    table_name: 'administration_central',
                                    _idKey: adminData[0].id,
                                    UpdateExpression:
                                        'set #sec.#spin = :val1, #sec.#date_word = :val2',
                                    ExpressionAttributeValues: {
                                        ':val1': parseInt(otp),
                                        ':val2': new Date(
                                            chaineDateUTC
                                        ).toISOString(),
                                    },
                                    ExpressionAttributeNames: {
                                        '#sec': 'security_details',
                                        '#spin': 'security_pin',
                                        '#date_word': 'date_created',
                                    },
                                })
                                    .then((result) => {
                                        if (result) {
                                            let emailTemplate = `<!doctype html>
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
                          
                          
                          
                          a[onclick] {
                            cursor: pointer;
                          }
                        </style>
          
          
                      </head>
          
                      <body style="background-color:#fff;padding:30px;">
          
                        <div style="display:flex;flex-direction:row;height:70px;">
                          <div style="border:1px solid transparent;height:70px;width:120px;"><img style="width:100%;height:100%;object-fit: contain;" alt="DulcetDash" src="https://orngeneralassets.s3.amazonaws.com/dulcetdash.png" /></div>
                        </div>
          
                        <!-- Message -->
                        <div style="font-family:'Consolas, Trebuchet MS', 'Lucida Sans Unicode', 'Consolas, Lucida Grande', 'Lucida Sans', Arial, sans-serif;font-size: 16px;margin-top: 40px;">
                          Hi ${adminData[0].name}, your 8-digits verification code is:
                        </div>
          
                        <!-- Confirm code -->
                        <div style="font-weight:bold;text-align:center;padding-top:20px;padding-left:45px;border:1px solid #11A05A;width:200px;height:50px;display: flex;flex-direction: row; align-items: center;justify-content: center;letter-spacing: 4px;font-size: 25px;background-color: #11A05A;color:#fff;border-radius: 3px;margin-top: 30px;">
                          ${otp}
                        </div>
          
                         <!-- Notice -->
                         <div style="font-family:'Consolas, Trebuchet MS', 'Lucida Sans Unicode', 'Consolas, Lucida Grande', 'Lucida Sans', Arial, sans-serif;font-size: 13px;margin-top: 25px;">
                          Please make sure to keep it private to you, if you did not request it contact Dominique.
                        </div>
          
                        <!-- Copyright -->
                        <div style="border-top:1px solid #d0d0d0;padding-top:20px;font-family:'Consolas, Trebuchet MS', 'Lucida Sans Unicode', 'Consolas, Lucida Grande', 'Lucida Sans', Arial, sans-serif;font-size: 13px;margin-top: 75px;">
                          © 2022 DulcetDash Technologies CC.
                        </div>
          
                      </body>
          
                      </html>`;

                                            //Send the OTP email
                                            //? Send email
                                            let info =
                                                transporterChecks.sendMail({
                                                    from: process.env
                                                        .EMAIL_CHECK, // sender address
                                                    to: adminData[0]
                                                        .corporate_email, // list of receivers
                                                    subject: `Verification - Cesar`, // Subject line
                                                    html: emailTemplate,
                                                });

                                            //?DONE
                                            // logger.info(
                                            //   `Sending receipt email...to ${adminData[0].corporate_email}`
                                            // );
                                            logger.info(info.messageId);

                                            res.send({
                                                response: 'valid_credentials',
                                                id: adminData[0].id,
                                            });
                                        } //Error
                                        else {
                                            res.send({ response: 'error' });
                                        }
                                    })
                                    .catch((error) => {
                                        logger.error(error);
                                        res.send({ response: 'error' });
                                    });
                            } //Incorrect credentials
                            else {
                                res.send({ response: 'incorrect_credentials' });
                            }
                        })
                        .catch((error) => {
                            logger.error(error);
                            res.send({ response: 'error' });
                        });
                })
                .catch((error) => {
                    logger.error(error);
                    res.send({ response: 'error' });
                });
        } //Check logins with OTP for login
        else {
            //Hash the password
            //Check login credentials
            req.email = req.email.trim();
            req.password = req.password.trim();
            req.id = req.id.trim();

            logger.error(req);
            //...
            //Hash the password
            new Promise((resolve) =>
                generateUniqueFingerprint(
                    req.password,
                    'sha512WithRSAEncryption',
                    resolve
                )
            )
                .then((passwordHashed) => {
                    //!CHECK
                    dynamo_find_query({
                        table_name: 'administration_central',
                        IndexName: 'corporate_email',
                        KeyConditionExpression: 'corporate_email = :val1',
                        FilterExpression:
                            'password = :val2 AND #sec.#spin = :val3',
                        ExpressionAttributeValues: {
                            ':val1': req.email,
                            ':val2': passwordHashed,
                            ':val3': parseInt(req.otp),
                        },
                        ExpressionAttributeNames: {
                            '#sec': 'security_details',
                            '#spin': 'security_pin',
                        },
                    })
                        .then((result) => {
                            if (
                                result !== undefined &&
                                result !== null &&
                                result.length > 0
                            ) {
                                //Found the admin
                                //! Remove the password hash
                                let adminData = result[0];
                                adminData.password = null;
                                //...

                                //! Generate a fresh jwt for 5 days -> 120h
                                jwt.sign(
                                    {
                                        data: req.email,
                                    },
                                    `${passwordHashed}-SALTFORJWTORNISS`,
                                    { expiresIn: '120h' },
                                    function (err, token) {
                                        if (err) {
                                            res.send({ response: 'error' });
                                        }
                                        //...
                                        //! Update the token to the profile
                                        dynamo_update({
                                            table_name:
                                                'administration_central',
                                            _idKey: req.id,
                                            UpdateExpression:
                                                'set token_j = :val1',
                                            ExpressionAttributeValues: {
                                                ':val1': token,
                                            },
                                        })
                                            .then((result) => {
                                                if (result) {
                                                    //!Get the latest data
                                                    dynamo_find_query({
                                                        table_name:
                                                            'administration_central',
                                                        IndexName:
                                                            'corporate_email',
                                                        KeyConditionExpression:
                                                            'corporate_email = :val1',
                                                        FilterExpression:
                                                            'password = :val2 AND #sec.#spin = :val3',
                                                        ExpressionAttributeValues:
                                                            {
                                                                ':val1':
                                                                    req.email,
                                                                ':val2':
                                                                    passwordHashed,
                                                                ':val3':
                                                                    parseInt(
                                                                        req.otp
                                                                    ),
                                                            },
                                                        ExpressionAttributeNames:
                                                            {
                                                                '#sec': 'security_details',
                                                                '#spin':
                                                                    'security_pin',
                                                            },
                                                    })
                                                        .then((updatedData) => {
                                                            if (
                                                                updatedData !==
                                                                    undefined &&
                                                                updatedData !==
                                                                    null &&
                                                                updatedData.length >
                                                                    0
                                                            ) {
                                                                //Yea
                                                                res.send({
                                                                    response:
                                                                        'success',
                                                                    data: updatedData[0],
                                                                });
                                                            } //Error
                                                            else {
                                                                res.send({
                                                                    response:
                                                                        'error',
                                                                });
                                                            }
                                                        })
                                                        .catch((error) => {
                                                            logger.error(error);
                                                            res.send({
                                                                response:
                                                                    'error',
                                                            });
                                                        });
                                                } //error
                                                else {
                                                    res.send({
                                                        response: 'error',
                                                    });
                                                }
                                            })
                                            .catch((error) => {
                                                logger.error(error);
                                                res.send({ response: 'error' });
                                            });
                                    }
                                );
                            } //error
                            else {
                                res.send({ response: 'error' });
                            }
                        })
                        .catch((error) => {
                            logger.error(error);
                            res.send({ response: 'error' });
                        });
                })
                .catch((error) => {
                    logger.error(error);
                    res.send({ response: 'error' });
                });
        }
    } //Invalid data
    else {
        res.send({ response: 'error' });
    }
});

server.listen(process.env.SERVER_MOTHER_PORT);
