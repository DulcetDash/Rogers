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
const bcrypt = require('bcrypt');

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
const AdminsModel = require('./models/AdminsModel');
const sendEmail = require('./Utility/sendEmail');
const DriversApplications = require('./models/DriversApplicationsModel');
const DriversApplicationsModel = require('./models/DriversApplicationsModel');

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
    const today = new Date();
    return (
        someDate.getDate() == today.getDate() &&
        someDate.getMonth() == today.getMonth() &&
        someDate.getFullYear() == today.getFullYear()
    );
};

//Get the sum of today for the requests
const getAmountsSums = ({
    arrayRequests = [],
    dataType = 'sales',
    today = true,
}) => {
    switch (dataType) {
        case 'sales':
            return arrayRequests
                .filter((el) => isToday(new Date(el.createdAt)) === today)
                .map((el) => {
                    logger.warn(el);
                    return el?.totals_request?.fare
                        ? parseFloat(String(el.totals_request.fare))
                        : parseFloat(
                              String(el.totals_request.total).replace('N$', '')
                          );
                })
                .reduce((partialSum, a) => partialSum + a, 0);

        case 'revenue':
            return arrayRequests
                .filter(
                    (el) =>
                        isToday(new Date(el.createdAt)) === today &&
                        el.ride_mode !== 'RIDE'
                )
                .map((el) => {
                    let tmpSum = 0;
                    tmpSum += el?.totals_request?.service_fee
                        ? parseFloat(
                              String(el.totals_request.service_fee).replace(
                                  'N$',
                                  ''
                              )
                          )
                        : 0;

                    tmpSum += el?.totals_request?.cart
                        ? parseFloat(
                              String(el.totals_request.cart).replace('N$', '')
                          )
                        : 0;

                    tmpSum += el?.totals_request?.delivery_fee
                        ? parseFloat(
                              String(el.totals_request.delivery_fee).replace(
                                  'N$',
                                  ''
                              )
                          )
                        : 0;

                    tmpSum += el?.totals_request?.cash_pickup_fee
                        ? parseFloat(
                              String(el.totals_request.cash_pickup_fee).replace(
                                  'N$',
                                  ''
                              )
                          )
                        : 0;

                    //...
                    tmpSum += el?.totals_request?.service_fee
                        ? parseFloat(
                              String(el.totals_request.total).replace('N$', '')
                          )
                        : 0;

                    return tmpSum;
                })
                .reduce((partialSum, a) => partialSum + a, 0);

        case 'requests':
            return arrayRequests.filter(
                (el) => isToday(new Date(el.createdAt)) === today
            ).length;

        case 'todayOnly':
            return arrayRequests.filter(
                (el) => isToday(new Date(el.createdAt)) === today
            );

        case 'gross_sum':
            return arrayRequests
                .map((el) => {
                    return el?.totals_request?.fare
                        ? parseFloat(
                              String(el.totals_request.fare).replace('N$', '')
                          )
                        : el?.totals_request?.total
                        ? parseFloat(
                              String(el.totals_request.total).replace('N$', '')
                          )
                        : 0;
                })
                .reduce((partialSum, a) => partialSum + a, 0);

        case 'net_sum':
            return arrayRequests
                .filter((el) => el.ride_mode !== 'RIDE')
                .map((el) => {
                    let tmpSum = 0;
                    tmpSum += el?.totals_request?.service_fee
                        ? parseFloat(
                              String(el.totals_request.service_fee).replace(
                                  'N$',
                                  ''
                              )
                          )
                        : 0;

                    tmpSum += el?.totals_request?.delivery_fee
                        ? parseFloat(
                              String(el.totals_request.delivery_fee).replace(
                                  'N$',
                                  ''
                              )
                          )
                        : 0;

                    tmpSum += el?.totals_request?.cash_pickup_fee
                        ? parseFloat(
                              String(el.totals_request.cash_pickup_fee).replace(
                                  'N$',
                                  ''
                              )
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
app.post('/cancel_request_driver_io', async (req, res) => {
    try {
        const { request_fp } = req.body;

        if (!request_fp)
            return res.send({
                response: 'unable_to_cancel_request_error',
            });

        const cancelledRequest = await RequestsModel.update(
            { id: request_fp },
            {
                date_cancelled: new Date(),
            }
        );

        res.json({
            status: 'success',
            response: 'successfully_cancelled',
            rider_fp: cancelledRequest.client_id,
        });
    } catch (error) {
        logger.error(error);
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
                    profile_picture: driverData?.profile_picture,
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

        logger.warn(req.body);

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
app.post('/getUsersList', async (req, res) => {
    try {
        const { admin_fp } = req.body;

        if (!admin_fp)
            return res.send({
                response: [],
                message: 'Error getting users list',
            });

        const users = await UserModel.scan().all().exec();

        //Sort based on the registration date
        users.sort((a, b) =>
            new Date(a.createdAt) > new Date(b.createdAt)
                ? -1
                : new Date(a.createdAt) > new Date(a.createdAt)
                ? 1
                : 0
        );

        res.send({ status: 'success', response: users });
    } catch (error) {
        logger.error(error);
        res.send({
            status: 'fail',
            response: [],
            message: 'Error getting users list',
        });
    }
});

//2. Get the list of all the drivers
app.post('/getDriversList', async (req, res) => {
    try {
        const { admin_fp } = req.body;

        if (!admin_fp)
            return res.send({ response: { registered: [], awaiting: [] } });

        //1. Get all the applications
        let applications = (
            await DriversApplicationsModel.scan()
                .all()
                .filter('is_approved')
                .eq(false)
                .exec()
        ).map((driver) => ({ driver_fingerprint: driver.id, ...driver }));

        //Presign images
        applications = await Promise.all(
            applications.map(async (driver) => {
                const driverKey = `${driver.id}-documents`;
                const cachedImages = await Redis.get(driverKey);

                if (cachedImages) {
                    driver.documents = JSON.parse(cachedImages);
                    return driver;
                }

                let documents = await Promise.all(
                    Object.keys(driver.documents).map(async (key) => {
                        const image = driver.documents[key];
                        const presignedUrl = await presignS3URL(image);
                        return { [key]: presignedUrl };
                    })
                );

                documents = documents.reduce((accumulator, current) => {
                    return { ...accumulator, ...current };
                }, {});

                driver.documents = documents;

                Redis.set(driverKey, JSON.stringify(documents), 'EX', 30 * 60);

                return driver;
            })
        );

        //Sort based on the registration date
        applications.sort((a, b) =>
            new Date(a.date_applied) > new Date(b.date_applied)
                ? -1
                : new Date(a.date_applied) > new Date(a.date_applied)
                ? 1
                : 0
        );

        let drivers = (await DriversModel.scan().all().exec()).map(
            (driver) => ({ driver_fingerprint: driver.id, ...driver })
        );

        //Add the documents and pictures
        drivers = await Promise.all(
            drivers.map(async (driver) => {
                let driverApplication = await DriversApplicationsModel.get(
                    driver.id
                );

                const driverKey = `${driver.id}-documents`;
                const cachedImages = await Redis.get(driverKey);

                driver.vehicle_details = driverApplication?.vehicle_details;

                if (cachedImages) {
                    driver.documents = JSON.parse(cachedImages);
                    return driver;
                }

                let documents = {};

                if (driverApplication?.documents) {
                    documents = await Promise.all(
                        Object.keys(driverApplication?.documents).map(
                            async (key) => {
                                const image = driverApplication.documents[key];
                                const presignedUrl = await presignS3URL(image);
                                return { [key]: presignedUrl };
                            }
                        )
                    );

                    documents = documents.reduce((accumulator, current) => {
                        return { ...accumulator, ...current };
                    }, {});
                }

                driver.documents = documents;

                Redis.set(driverKey, JSON.stringify(documents), 'EX', 30 * 60);

                return driver;
            })
        );

        //Sort based on the registration date
        drivers.sort((a, b) =>
            new Date(a.date_registered) > new Date(b.date_registered)
                ? -1
                : new Date(a.date_registered) > new Date(a.date_registered)
                ? 1
                : 0
        );
        //DONE
        res.send({
            response: {
                registered: drivers,
                awaiting: applications,
            },
        });
    } catch (error) {
        logger.error(error);
        res.send({ response: { registered: [], awaiting: [] } });
    }
});

//3. suspended or unsuspend a driver
app.post('/suspendUnsuspendDriver', async (req, res) => {
    try {
        const { admin_fp, operation, driver_id } = req.body;

        if (!admin_fp || !operation || !driver_id)
            return res.send({ response: 'error' });

        await DriversModel.update(
            {
                id: driver_id,
            },
            {
                isDriverSuspended: operation === 'suspend',
                account_state: operation === 'suspend' ? 'offline' : 'online',
            }
        );

        res.send({ response: 'success' });
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

//4. Approve driver account
app.post('/approveDriverAccount', async (req, res) => {
    try {
        const { admin_fp, driverData } = req.body;

        if (!admin_fp)
            return res.send({
                response: 'error',
                message: 'You are not logged in.',
            });

        const driver = await DriversApplicationsModel.get(
            driverData.driver_fingerprint
        );

        if (!driver)
            return res.send({
                response: 'error',
                message: 'Could not register the driver officially.',
            });

        //1. Create a fresh driver
        await DriversModel.create({
            id: driver.id,
            gender: driver.gender,
            operation_clearances: ['DELIVERY'],
            surname: driver.surname,
            name: driver.name,
            phone_number: driver.phone_number,
            regional_clearances: [driver.city],
            date_of_birth: '12-09-2020',
            identification_number: 'AAAA',
            driving_license_number: 'BBBB',
            email: driverData.email,
        });

        //2. Update the application to approved
        await DriversApplicationsModel.update(
            {
                id: driver.id,
            },
            {
                is_approved: true,
            }
        );

        // return res.send({ response: 'success' });
        res.send({ response: 'error' });
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

//5. Get the requests list for the admin
//Needs to be well segmented.
app.post('/getGeneralRequestsList', async (req, res) => {
    try {
        const { admin_fp } = req.body;

        if (!admin_fp) return res.send({ response: 'error' });

        let requests = await RequestsModel.scan().all().exec();

        if (requests.count <= 0) return res.send({ response: {} });

        requests = requests.toJSON();

        //?Sort based on the requested date
        requests.sort((a, b) =>
            new Date(a.createdAt) > new Date(b.createdAt)
                ? -1
                : new Date(a.createdAt) > new Date(a.createdAt)
                ? 1
                : 0
        );

        //Attach the user and/or driver details
        requests = await Promise.all(
            requests.map(async (request) => {
                const user = (await UserModel.get(request.client_id)) ?? false;

                request.clientData = user;

                const shopper =
                    (await DriversModel.get(request.shopper_id)) ?? false;

                request.shopperData = shopper;

                return request;
            })
        );

        //? Assemble the response data
        const requestsAssembledData = {
            delivery: {
                inprogress: requests.filter(
                    (el) =>
                        el.ride_mode === 'DELIVERY' &&
                        !el?.request_state_vars?.completedRatingClient &&
                        !el?.date_cancelled
                ),
                completed: requests.filter(
                    (el) =>
                        el.ride_mode === 'DELIVERY' &&
                        el?.request_state_vars?.completedRatingClient
                ),
                cancelled: requests.filter(
                    (el) => el.ride_mode === 'DELIVERY' && el?.date_cancelled
                ),
            },
            shopping: {
                inprogress: requests.filter(
                    (el) =>
                        el.ride_mode === 'SHOPPING' &&
                        !el?.request_state_vars?.completedRatingClient &&
                        !el?.date_cancelled
                ),
                completed: requests.filter(
                    (el) =>
                        el.ride_mode === 'SHOPPING' &&
                        el?.request_state_vars?.completedRatingClient
                ),
                cancelled: requests.filter(
                    (el) => el.ride_mode === 'SHOPPING' && el?.date_cancelled
                ),
            },
            stats: {
                total_sales_today: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'sales',
                }),
                total_revenue_today: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'revenue',
                }),
                total_requests_success: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'requests',
                }),
            },
        };

        //...
        res.send({
            status: 'success',
            response: requestsAssembledData,
        });
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

// 6. Get the summary data
app.post('/getSummaryData', async (req, res) => {
    try {
        const { admin_fp } = req.body;
        const summaryKey = 'admin-summary-data';

        const cachedData = await Redis.get(summaryKey);

        if (cachedData) {
            return res.send({
                status: 'success',
                response: JSON.parse(cachedData),
            });
        }

        if (!admin_fp) return res.send({ response: 'error' });

        let requests = (await RequestsModel.scan().all().exec()).toJSON();
        const cancelledRequests = requests.filter((el) => el?.date_cancelled);
        requests = requests.filter((el) => !el?.date_cancelled);
        const drivers = await DriversModel.scan().all().exec();
        const users = await UserModel.scan().all().exec();
        const stores = await StoreModel.scan().all().exec();
        const catalogue = await CatalogueModel.scan().all().exec();

        let TEMPLATE_SUMMARY_META = {
            today_graph_data: {
                successful_requests: generateGraphDataFromRequestsData({
                    requestData: requests,
                }),
                cancelled_requests: generateGraphDataFromRequestsData({
                    requestData: requests.map((el) => el?.date_cancelled),
                }),
            },
            today: {
                total_requests: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'todayOnly',
                }).length,
                total_rides: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'todayOnly',
                }).filter((el) => el.ride_mode === 'RIDE').length,
                total_deliveries: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'todayOnly',
                }).filter((el) => el.ride_mode === 'DELIVERY').length,
                total_shoppings: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'todayOnly',
                }).filter((el) => el.ride_mode === 'SHOPPING').length,
                total_cancelled_requests: getAmountsSums({
                    arrayRequests: cancelledRequests,
                    dataType: 'todayOnly',
                }).length,
                total_cancelled_rides: getAmountsSums({
                    arrayRequests: cancelledRequests,
                    dataType: 'todayOnly',
                }).filter((el) => el.ride_mode === 'RIDE').length,
                total_cancelled_deliveries: getAmountsSums({
                    arrayRequests: cancelledRequests,
                    dataType: 'todayOnly',
                }).filter((el) => el.ride_mode === 'DELIVERY').length,
                total_cancelled_shoppings: getAmountsSums({
                    arrayRequests: cancelledRequests,
                    dataType: 'todayOnly',
                }).filter((el) => el.ride_mode === 'SHOPPING').length,
                total_sales: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'sales',
                }),
                total_revenues: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'revenue',
                }),
                total_loss: getAmountsSums({
                    arrayRequests: cancelledRequests.filter((el) =>
                        isToday(new Date(el.date_requested))
                    ),
                    dataType: 'gross_sum',
                }),
                percentage_handling: 0,
            },
            general_requests: {
                total_requests: requests.length,
                total_rides: requests.filter((el) => el.ride_mode === 'RIDE')
                    .length,
                total_deliveries: requests.filter(
                    (el) => el.ride_mode === 'DELIVERY'
                ).length,
                total_shoppings: requests.filter(
                    (el) => el.ride_mode === 'SHOPPING'
                ).length,
                total_cancelled_requests: cancelledRequests.length,
                total_cancelled_rides: cancelledRequests.filter(
                    (el) => el.ride_mode === 'RIDE'
                ).length,
                total_cancelled_deliveries: cancelledRequests.filter(
                    (el) => el.ride_mode === 'DELIVERY'
                ).length,
                total_cancelled_shoppings: cancelledRequests.filter(
                    (el) => el.ride_mode === 'SHOPPING'
                ).length,
                percentage_handling: 0,
            },
            general_finances: {
                total_sales: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'gross_sum',
                    today: false,
                }),
                total_revenues: getAmountsSums({
                    arrayRequests: requests,
                    dataType: 'net_sum',
                    today: false,
                }),
                total_rides_sales: getAmountsSums({
                    arrayRequests: requests.filter(
                        (el) => el.ride_mode === 'RIDE'
                    ),
                    dataType: 'gross_sum',
                    today: false,
                }),
                total_rides_revenues: 0,
                total_deliveries_sales: getAmountsSums({
                    arrayRequests: requests.filter(
                        (el) => el.ride_mode === 'DELIVERY'
                    ),
                    dataType: 'gross_sum',
                    today: false,
                }),
                total_deliveries_revenues: getAmountsSums({
                    arrayRequests: requests.filter(
                        (el) => el.ride_mode === 'DELIVERY'
                    ),
                    dataType: 'net_sum',
                    today: false,
                }),
                total_shoppings_sales: getAmountsSums({
                    arrayRequests: requests.filter(
                        (el) => el.ride_mode === 'SHOPPING'
                    ),
                    dataType: 'gross_sum',
                    today: false,
                }),
                total_shoppings_revenues: getAmountsSums({
                    arrayRequests: requests.filter(
                        (el) => el.ride_mode === 'SHOPPING'
                    ),
                    dataType: 'net_sum',
                    today: false,
                }),
                total_loss: getAmountsSums({
                    arrayRequests: cancelledRequests,
                    dataType: 'sales',
                    today: false,
                }),
                total_net_loss: 0,
                total_rides_loss: 0,
                total_deliveries_loss: getAmountsSums({
                    arrayRequests: cancelledRequests.filter(
                        (el) => el.ride_mode === 'DELIVERY'
                    ),
                    dataType: 'sales',
                    today: false,
                }),
                total_shoppings_loss: getAmountsSums({
                    arrayRequests: cancelledRequests.filter(
                        (el) => el.ride_mode === 'SHOPPING'
                    ),
                    dataType: 'sales',
                    today: false,
                }),
                percentage_handling: 0,
            },
            users: {
                total_users: users.length,
                total_male_users: users.filter((el) => /^m/i.test(el.gender))
                    .length,
                total_female_users: users.filter((el) => /^f/i.test(el.gender))
                    .length,
                total_unknown_gender_users: users.filter(
                    (el) =>
                        /^m/i.test(el.gender) === false &&
                        /^f/i.test(el.gender) === false
                ).length,
                total_mtc_users: users.filter((el) =>
                    /26481/i.test(el.phone_number)
                ).length,
                total_tnmobile_users: users.filter((el) =>
                    /26485/i.test(el.phone_number)
                ).length,
            },
            drivers: {
                total_drivers: drivers.length,
                total_ride_drivers: 0,
                total_delivery_drivers: drivers.filter(
                    (el) => el.operation_clearances === 'DELIVERY'
                ).length,
                total_shoppers: drivers.filter(
                    (el) => el.operation_clearances === 'SHOPPING'
                ).length,
                total_male_drivers: drivers.filter((el) =>
                    /^m/i.test(el.gender)
                ).length,
                total_female_drivers: drivers.filter((el) =>
                    /^f/i.test(el.gender)
                ).length,
                total_unknown_gender_drivers: drivers.filter(
                    (el) =>
                        /^m/i.test(el.gender) === false &&
                        /^f/i.test(el.gender) === false
                ).length,
                total_male_ride_drivers: 0,
                total_female_ride_drivers: 0,
                total_male_delivery_drivers: drivers.filter(
                    (el) =>
                        /^m/i.test(el.gender) &&
                        el.operation_clearances === 'DELIVERY'
                ).length,
                total_female_delivery_drivers: drivers.filter(
                    (el) =>
                        /^f/i.test(el.gender) &&
                        el.operation_clearances === 'DELIVERY'
                ).length,
                total_male_shoppers: drivers.filter(
                    (el) =>
                        /^m/i.test(el.gender) &&
                        el.operation_clearances === 'SHOPPING'
                ).length,
                total_female_shoppers: drivers.filter(
                    (el) =>
                        /^f/i.test(el.gender) &&
                        el.operation_clearances === 'SHOPPING'
                ).length,
            },
            shopping_details: {
                total_stores_registered: stores.length,
                total_unpublished_stores: stores.filter((el) => !el?.publish)
                    .length,
                total_products_in_catalogue: catalogue.length,
                interval_catalogue_update: 'Every 3 days',
                last_updated: catalogue[catalogue.length - 1].createdAt,
            },
        };

        await Redis.set(
            summaryKey,
            JSON.stringify(TEMPLATE_SUMMARY_META),
            'EX',
            5 * 60
        );

        //Start filling out
        res.send({
            response: TEMPLATE_SUMMARY_META,
        });
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

//! 7. Login checks for the admins
app.post('/loginOrChecksForAdmins', async (req, res) => {
    try {
        let { email, password, otp, id: adminId } = req.body;

        if (!email || !password) return res.send({ response: 'error' });

        const admin = await AdminsModel.query('corporate_email')
            .eq(email)
            .exec();

        if (admin.count <= 0)
            return res.send({ response: 'incorrect_credentials' });

        const adminData = admin[0];

        //Valid set of data
        if (!otp) {
            //Check login credentials
            email = email.trim();
            password = password.trim();

            //TODO: DEBUG - cleanup
            // const salt = await bcrypt.genSalt(10);
            // const hashedPassword = await bcrypt.hash('12345678', salt);

            const validPassword = await bcrypt.compare(
                password,
                adminData.password
            );

            if (!validPassword)
                return res.send({ response: 'incorrect_credentials' });

            //Generate the otp - 8-digits
            let otp = otpGenerator.generate(8, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false,
            });
            otp = String(otp).length < 8 ? parseInt(otp) * 10 : parseInt(otp);

            //Update security PIN
            await AdminsModel.update(
                { id: adminData.id },
                {
                    security_pin: otp,
                }
            );

            //Send the OTP email
            //? Send email
            sendEmail({
                email,
                fromEmail: 'security@dulcetdash.com',
                fromName: 'DulcetDash - Cesar',
                subject: 'Admin Verification Code',
                message: `Hi Admin\n\n Verification code: ${otp}`,
            });

            //?DONE
            logger.info(`Sending receipt email...to ${adminData.email}`);

            res.send({
                response: 'valid_credentials',
                id: adminData.id,
            });
        } //Check logins with OTP for login
        else {
            otp = parseInt(otp.trim());
            email = email.trim();
            password = password.trim();
            adminId = adminId.trim();

            const validPassword = await bcrypt.compare(
                password,
                adminData.password
            );

            if (!validPassword)
                return res.send({ response: 'incorrect_credentials' });

            if (otp !== adminData.security_pin)
                return res.send({ response: 'error' });

            //! Generate a fresh jwt for 5 days -> 120h
            const jwtKey = await jwt.sign(
                {
                    data: email,
                    adminId,
                },
                process.env.ADMIN_PASSWORD_SECRET_KEY,
                { expiresIn: '120h' }
            );

            const updatedAdmin = await AdminsModel.update(
                {
                    id: adminData.id,
                },
                {
                    token_j: jwtKey,
                }
            );

            //Done
            res.send({
                response: 'success',
                data: {
                    admin_fp: updatedAdmin.id,
                    isSuspended: !!updatedAdmin.isSuspended,
                    ...updatedAdmin,
                },
            });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

server.listen(process.env.SERVER_MOTHER_PORT);
