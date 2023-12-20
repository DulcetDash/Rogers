/* eslint-disable no-lonely-if */
require('newrelic');
require('dotenv').config();

const express = require('express');
const http = require('http');
const otpGenerator = require('otp-generator');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const Redis = require('./Utility/redisConnector');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
// eslint-disable-next-line import/no-extraneous-dependencies
const useragent = require('express-useragent');

const { logger } = require('./LogService');
const {
    sendSMS,
    uploadBase64ToS3,
    parseRequestsForShopperAppView,
    getAllItemsByShopFp,
    shuffle,
    removeDuplicatesKeepRecent,
    getDailyAmountDriverRedisKey,
    batchPresignProductsLinks,
    batchStoresImageFront,
    addTwoHours,
    timeAgo,
    batchPresignProductsOptionsImageLinks,
    shouldSendNewSMS,
    getStripePriceName,
    getRequestLitteralStatus,
} = require('./Utility/Utils');
const _ = require('lodash');

const dynamoose = require('dynamoose');

const app = express();
const server = http.createServer(app);
const cors = require('cors');
const helmet = require('helmet');
const requestAPI = require('request');

const jwt = require('jsonwebtoken');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
const { dynamo_find_query } = require('./DynamoServiceManager');
//....
var chaineDateUTC = null;
const moment = require('moment');

const UserModel = require('./models/UserModel');
const OTPModel = require('./models/OTPModel');
const {
    getUserLocationInfos,
    getSearchedLocations,
} = require('./searchService');
const RequestsModel = require('./models/RequestsModel');
const DriversModel = require('./models/DriversModel');
const StoreModel = require('./models/StoreModel');
const { presignS3URL } = require('./Utility/PresignDocs');
const { storeTimeStatus, searchProducts } = require('./Utility/Utils');
const CatalogueModel = require('./models/CatalogueModel');
const {
    processCourierDrivers_application,
    computeDaily_amountMadeSoFar,
    goOnline_offlineDrivers,
} = require('./serverAccounts');
const AdminsModel = require('./models/AdminsModel');
const DriversApplicationsModel = require('./models/DriversApplicationsModel');
const authenticate = require('./middlewares/authenticate');
const lightcheck = require('./middlewares/lightcheck');
const { generateNewSecurityToken } = require('./Utility/authenticate/Utils');
const Payments = require('./models/Payments');
const { getBalance } = require('./Utility/Wallet/Utils');
const {
    performCorporateDeliveryAccountAuthOps,
} = require('./Utility/Account/Utils');
const Subscriptions = require('./models/Subscriptions');
const { sendEmail } = require('./Utility/sendEmail');

/**
 * Responsible for sending push notification to devices
 */
const sendPushUPNotification = (data) => {
    //logger.info("Notify data");
    //logger.info(data);
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
    };

    const options = {
        host: 'onesignal.com',
        port: 443,
        path: '/api/v1/notifications',
        method: 'POST',
        headers: headers,
    };

    const req = https.request(options, function (res) {
        res.on('data', function (response) {
            logger.info('Response:', response);
        });
    });

    req.on('error', function (e) {});

    req.write(JSON.stringify(data));
    req.end();
};

//EVENT GATEWAY PORT

/**
 * @func getStores
 * Will get all the stores available and their closing times relative to now.
 * @param resolve
 */
const getStores = async () => {
    try {
        const stores = await StoreModel.scan().all().exec();

        if (stores.length > 0) {
            let STORES_MODEL = await batchStoresImageFront(
                (
                    await Promise.all(
                        stores.map(async (store) => {
                            if (store.publish) {
                                const tmpStore = {
                                    name: store.name,
                                    fd_name: store.friendly_name,
                                    type: store.shop_type,
                                    description: store.description,
                                    background: store.shop_background_color,
                                    border: store.border_color,
                                    logo: store.shop_logo,
                                    fp: store.id,
                                    reputation: store?.reputation ?? 0,
                                    structured: store.structured_shopping,
                                    times: {
                                        target_state: null, //two values: opening or closing
                                        string: null, //something like: opening in ...min or closing in ...h
                                    },
                                    date_added: new Date(
                                        store.createdAt
                                    ).getTime(),
                                };
                                //...
                                tmpStore.times.string = storeTimeStatus(
                                    store?.operation_time
                                );
                                //? DONE - SAVE
                                return tmpStore;
                            }

                            return null;
                        })
                    )
                ).filter((el) => el)
            );

            STORES_MODEL = _.orderBy(STORES_MODEL, ['reputation'], ['desc']);

            return { response: STORES_MODEL };
        }

        return { response: [] };
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
    const { store: storeFp, category, subcategory, structured } = body;

    const shop = await StoreModel.get(storeFp);

    if (!shop) return { response: {}, store: null };

    const storeData = shop;

    //? Increment store's reputation points
    const storeReputationPoint = (shop?.reputation ?? 0) + 1;

    await StoreModel.update(
        {
            id: shop.id,
        },
        {
            reputation: storeReputationPoint,
        }
    );

    const pageNumber = body?.pageNumber ? parseInt(body?.pageNumber, 10) : 1;
    const pageSize = 200;

    const paginationStart = (pageNumber - 1) * pageSize;
    const paginationEnd = pageNumber * pageSize;

    const redisKey = `${storeFp}-catalogue`;

    let cachedData = await Redis.get(redisKey);

    if (cachedData) {
        cachedData = JSON.parse(cachedData);
    } else {
        cachedData = [];
    }

    let productsData =
        cachedData.length > 0
            ? cachedData
            : await getAllItemsByShopFp(
                  process.env.CATALOGUE_INDEX,
                  body.store
              );

    if (cachedData.length <= 0) {
        Redis.set(redisKey, JSON.stringify(productsData), 'EX', 3600 * 24 * 2);
    }

    if (productsData?.count > 0 || productsData?.length > 0) {
        productsData = shuffle(
            paginationStart > productsData.length ? [] : productsData
        );

        //?Limit all the results to 200 products
        productsData = productsData.slice(paginationStart, paginationEnd);

        //Create presigned product links for the ones we host (s3://)
        productsData = await batchPresignProductsLinks(productsData);

        //Reformat the data
        const reformattedData = await Promise.all(
            productsData.map(async (product, index) => {
                const tmpData = {
                    id: product.id,
                    index: index,
                    name: product.product_name,
                    price: String(product.priceAdjusted),
                    currency: product.currency,
                    pictures: product.product_picture,
                    sku: product.sku,
                    meta: {
                        category: product.category,
                        subcategory: product.subcategory,
                        store: product.shop_name,
                        store_fp: storeFp,
                        structured: storeData.structured_shopping,
                    },
                    description: product?.description,
                    options: await batchPresignProductsOptionsImageLinks(
                        product?.options
                    ),
                };

                return tmpData;
            })
        );

        return { response: reformattedData, store: storeFp };
    }

    //No products
    return { response: {}, store: storeFp };
};

/**
 * @func getRequestDataClient
 * responsible for getting the realtime shopping requests for clients.
 * @param requestData: user_identifier mainly
 * @param resolve
 */
const getRequestDataClient = async (requestData, isCompany = false) => {
    const { user_identifier } = requestData;

    const requests = await RequestsModel.query('client_id')
        .eq(user_identifier)
        .filter('date_clientRating')
        .not()
        .exists()
        .filter('date_cancelled')
        .not()
        .exists()
        .exec();

    if (requests.count > 0) {
        //!1. SHOPPING DATA or DELIVERY DATA
        const parsedRequests = await Promise.all(
            requests.map(async (request) => {
                //Has a pending shopping
                const RETURN_DATA_TEMPLATE = {
                    ride_mode: request?.ride_mode.toUpperCase(),
                    request_fp: request.id,
                    client_id: requestData.user_identifier, //the user identifier - requester
                    driver_details: {}, //Will hold the details of the shopper
                    shopping_list: request.shopping_list, //The list of items to shop for
                    payment_method: request.payment_method, //mobile_money or cash
                    trip_locations: request.locations, //Has the pickup and delivery locations
                    totals_request: request.totals_request, //Has the cart details in terms of fees
                    request_type: request.request_type, //scheduled or immediate
                    state_vars: request.request_state_vars,
                    ewallet_details: {
                        phone: '+264856997167',
                        security: request?.security ? request.security : 'None',
                    },
                    date_requested: request.createdAt, //The time of the request
                    status: getRequestLitteralStatus(request), //The status of the request
                };
                //..Get the shopper's infos
                if (request?.shopper_id !== 'false') {
                    const shopper = await DriversModel.query('id')
                        .eq(request.shopper_id)
                        .exec();
                    if (shopper.count > 0) {
                        //Has a shopper
                        const driverData = shopper[0];
                        const driverDocs = await DriversApplicationsModel.get(
                            driverData.id
                        );

                        let driverProfile = await Redis.get(
                            driverDocs.documents.driver_photo
                        );

                        if (!driverProfile) {
                            driverProfile = await presignS3URL(
                                driverDocs.documents.driver_photo
                            );
                            await Redis.set(
                                driverDocs.documents.driver_photo,
                                driverProfile,
                                'EX',
                                35 * 60
                            );
                        }

                        RETURN_DATA_TEMPLATE.driver_details = {
                            name: driverData.name,
                            picture: driverProfile,
                            rating: driverData?.rating ?? 5,
                            phone: driverData.phone_number,
                            vehicle: {
                                picture: await presignS3URL(
                                    driverDocs?.documents?.vehicle_photo
                                ),
                                brand: driverDocs?.vehicle_details?.brand_name,
                                plate_no:
                                    driverDocs?.vehicle_details?.plate_number,
                                color: driverDocs?.vehicle_details?.color,
                                taxi_number: null,
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

                return RETURN_DATA_TEMPLATE;
            })
        );

        return isCompany ? parsedRequests : parsedRequests[0];
    }
    //No pending shoppings

    return false;
};

/**
 * @func getRecentlyVisitedShops
 * Responsible to get the 3 latest visited shops by the user
 * @param user_identifier: the request data including the user_identifier
 * @param redisKey: the redis key to which the results will be cached.
 * @param resolve
 */
const getRecentlyVisitedShops = async (user_identifier, redisKey) => {
    const cachedData = await Redis.get(redisKey);

    if (cachedData) {
        const recentStores = JSON.parse(cachedData).map((store) => {
            store.timeString = timeAgo(store.createdAt);
            return store;
        });

        return { response: recentStores.slice(0, 2) };
    }

    //1. Get all the requests made by the user
    const requests = await RequestsModel.query('client_id')
        .eq(user_identifier)
        .all()
        .filter('ride_mode')
        .eq('SHOPPING')
        .exec();
    let requestData = requests;

    if (requests.count > 0) {
        //Has some requests
        //?1. Reformat the dates
        requestData = requestData.map((request) => {
            request.createdAt = addTwoHours(request.createdAt);
            return request;
        });

        const storesMeta = requestData
            .map((request) => {
                const tmp = request.shopping_list.map((shop) => ({
                    store_id: shop.meta.store_fp,
                    timeString: timeAgo(request.createdAt),
                    createdAt: request.createdAt,
                }));
                return tmp;
            })
            .flat();

        let recentUserStores = removeDuplicatesKeepRecent(
            storesMeta,
            'store_id',
            'createdAt'
        );

        //?4. Only take the 2 first
        recentUserStores = recentUserStores.slice(0, 2);

        const stores = await batchStoresImageFront(
            (
                await Promise.all(
                    recentUserStores.map(async (request) => {
                        const store = await StoreModel.get(request.store_id);

                        if (!store) return false;

                        const tmpStore = {
                            name: store.name,
                            fd_name: store.friendly_name,
                            type: store.shop_type,
                            description: store.description,
                            background: store.shop_background_color,
                            border: store.border_color,
                            logo: store.shop_logo,
                            fp: store.id,
                            structured: store.structured_shopping,
                            times: {
                                target_state: null, //two values: opening or closing
                                string: null, //something like: opening in ...min or closing in ...h
                            },
                            timeString: request.timeString,
                            date_added: new Date(request.createdAt).getTime(),
                            createdAt: request.createdAt,
                        };

                        tmpStore.times.string = storeTimeStatus(
                            store.opening_time,
                            store.closing_time
                        );

                        return tmpStore;
                    })
                )
            ).filter((el) => el)
        );

        //?7. Cache
        Redis.set(redisKey, JSON.stringify(stores), 'EX', 10 * 60);

        const response = { response: stores.slice(0, 2) };

        return response;
    }

    //No requests
    return { response: [] };
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
                totals: request.totals_request,
                shopping_list:
                    request.ride_mode.toLowerCase() === 'shopping'
                        ? request.shopping_list
                        : null,
                cancelled: !!request.date_cancelled,
                completed: !!request.date_completedJob,
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
                    let { total } = el.totals_request;

                    return total ?? 0;
                })
                .reduce((partialSum, a) => partialSum + a, 0);

        case 'revenue':
            return arrayRequests
                .filter((el) => isToday(new Date(el.createdAt)) === today)
                .map((el) => {
                    let { delivery_fee, shopping_fee } = el.totals_request;

                    delivery_fee = delivery_fee ?? 0;
                    shopping_fee = shopping_fee ?? 0;

                    return delivery_fee + shopping_fee;
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
                    let { total } = el.totals_request;

                    return total ?? 0;
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

            if (Number.isNaN(refDate.getDate()) === false) {
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

// const corsOptions = {
//     // origin: [
//     //     'http://localhost:3000',
//     //     /\.dulcetdash\.com/,
//     //     'https://business.dulcetdash.com/',
//     //     'business.dulcetdash.com/',
//     //     'business.dulcetdash.com/*',
//     //     'www.business.dulcetdash.com/',
//     //     'www.business.dulcetdash.com',
//     //     'https://83g3kkzu8r.us-east-1.awsapprunner.com/',
//     // ],
//     origin: '*',
//     credentials: false,
// };

const whitelist = [
    'http://localhost:3000',
    // /\.dulcetdash\.com/,
    'https://business.dulcetdash.com/',
    'business.dulcetdash.com/',
    'business.dulcetdash.com/*',
    'www.business.dulcetdash.com/',
    'www.business.dulcetdash.com',
    'https://83g3kkzu8r.us-east-1.awsapprunner.com/',
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || whitelist.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
};

app.use(cors(corsOptions));

app.use(useragent.express());
app.use(morgan('dev'));

app.post('/webhook', bodyParser.raw({ type: '*/*' }), async (req, res) => {
    let event;

    try {
        const stripeSigniture = req.headers['stripe-signature'];

        event = stripe.webhooks.constructEvent(
            req.body,
            stripeSigniture,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        // console.error(err);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }

    let eventObject;

    try {
        const {
            object,
            captured,
            amount_captured,
            customer: customerId,
            id: stripePaymentId,
            status,
            refunded,
            currency,
        } = event.data.object;

        let metaData = event.data;

        switch (event.type) {
            case 'charge.succeeded':
                if (
                    object === 'charge' &&
                    status === 'succeeded' &&
                    !refunded
                ) {
                    //Truly received the money
                    let user = await UserModel.query('stripe_customerId')
                        .eq(customerId)
                        .exec();

                    if (user.count <= 0) break;

                    user = user[0];

                    //If the user is a company get the corresponding subscription for the payment
                    let subscriptionId = event.data?.object?.subscription;
                    if (user?.company_name) {
                        const subscription = await Subscriptions.query(
                            'user_id'
                        )
                            .eq(user.id)
                            .filter('active')
                            .eq(true)
                            .exec();

                        if (subscription.count > 0) {
                            subscriptionId = subscription[0].id;
                        }
                    }

                    //Update the payment
                    await Payments.create({
                        id: uuidv4(),
                        user_id: user.id,
                        stripe_payment_id: stripePaymentId,
                        subscription_id: subscriptionId,
                        amount: amount_captured / 100,
                        transaction_description: 'WALLET_TOPUP',
                        currency,
                    });
                }

                break;

            case 'invoice.payment_succeeded':
                metaData = metaData?.object;
                if (metaData?.object === 'invoice' && metaData.paid) {
                    // logger.warn(event.type);
                    // console.log(metaData.lines.data[0]);
                    let user = await UserModel.query('stripe_customerId')
                        .eq(metaData?.customer)
                        .exec();

                    if (user.count <= 0) break;

                    user = user[0];

                    const subscriptionId = uuidv4();
                    const stripeSubscriptionId = metaData.subscription;
                    const amount = metaData.amount_paid / 100;
                    const { currency: transactionCurrency, period_end } =
                        metaData;
                    const priceName = metaData.lines.data[0].plan?.nickname;

                    //Check if this subscription already exists
                    const subscription = await Subscriptions.query(
                        'stripe_subscription_id'
                    )
                        .eq(stripeSubscriptionId)
                        .exec();

                    if (subscription.count > 0) {
                        //Update the subscription
                        await Subscriptions.update(
                            {
                                id: subscription[0].id,
                            },
                            {
                                amount,
                                currency: transactionCurrency,
                                transaction_description: priceName,
                                expiration_date: new Date(period_end * 1000),
                                active: true,
                            }
                        );
                    } else {
                        //Set all the subscriptions for this user to active -> false
                        const oldSubscriptions = await Subscriptions.query(
                            'user_id'
                        )
                            .eq(user.id)
                            .exec();

                        await Promise.all(
                            oldSubscriptions.map(async (sub) => {
                                await Subscriptions.update(
                                    {
                                        id: sub.id,
                                    },
                                    {
                                        active: false,
                                    }
                                );
                            })
                        );

                        await Subscriptions.create({
                            id: subscriptionId,
                            user_id: user?.id,
                            amount,
                            currency: transactionCurrency,
                            stripe_subscription_id: stripeSubscriptionId,
                            transaction_description: priceName,
                            expiration_date: new Date(period_end * 1000),
                            active: true,
                        });
                    }
                }

                break;

            default:
                // Handle other types of events or ignore them
                break;
        }
    } catch (error) {
        console.error('Error handling webhook event:', error);
        return res.status(500).send('Internal Server Error');
    }

    // Return a 200 response to acknowledge receipt of the event
    res.send();
});

app.use(
    express.json({
        limit: '1000mb',
        extended: true,
    })
)
    .use(
        express.urlencoded({
            limit: '1000mb',
            extended: true,
        })
    )
    .use(helmet());

app.post('/topup', authenticate, async (req, res) => {
    try {
        const { amount, userId } = req.body;

        if (!amount || !userId)
            return res.status(400).json({ error: 'An error occured' });

        const normalAmount = parseInt(amount, 10) / 100;

        if (normalAmount > 5000)
            return res.status(400).json({
                error: 'An error occured',
                message: 'Amount greater than 5000',
            });

        const user = await UserModel.get(userId);

        if (!user)
            return res.status(400).json({ error: 'User does not exist' });

        let amountWithoutPFee = parseInt(amount, 10);
        const processingFee = amountWithoutPFee * 0.05;

        amountWithoutPFee = Math.floor(amountWithoutPFee - processingFee);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountWithoutPFee, // amount in cents
            currency: 'nad',
            description: `Wallet Top-up for user ${user.email}`,
            customer: user?.stripe_customerId,
        });

        res.send({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        logger.error(error);
        res.status(400).send({ error: error.message });
    }
});

app.get('/wallet/balance', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;

        const balance = await getBalance(userId);

        res.status(200).json({
            status: 'success',
            data: balance,
        });
    } catch (error) {
        logger.error(error);
        res.status(400).send({ error: 'Unable to get balance' });
    }
});

//?1. Get all the available stores in the app.
//Get the main ones (4) and the new ones (X)
app.post('/getStores', authenticate, async (req, res) => {
    try {
        const stores = await getStores();

        res.json(stores);
    } catch (error) {
        logger.error(error);
        res.send({ response: [] });
    }
});

//Register new store
app.post(
    '/api/v1/store',
    // authenticate,
    async (req, res) => {
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
    }
);

//?2. Get all the products based on a store
app.post('/getCatalogueFor', authenticate, async (req, res) => {
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
app.post(
    '/getResultsForKeywords',
    // , authenticate
    async (req, res) => {
        try {
            const {
                category,
                subcategory,
                store_fp: shop_fp,
                store: product_name,
                key,
            } = req.body;

            if (key && shop_fp) {
                const redisKey = `${shop_fp}-${key}-searchedProduct`;

                const cachedData = await Redis.get(redisKey);

                let products = cachedData
                    ? JSON.parse(cachedData)
                    : await searchProducts(process.env.CATALOGUE_INDEX, {
                          shop_fp,
                          product_name,
                          product_name: key,
                          category,
                          subcategory,
                      });

                if (!cachedData && products.length > 0) {
                    await Redis.set(
                        redisKey,
                        JSON.stringify(products),
                        'EX',
                        1 * 24 * 3600
                    );
                }

                products = await batchPresignProductsLinks(products);

                const reformattedData = products.map((product, index) => {
                    const tmpData = {
                        ...product,
                        ...{
                            product_price: String(product.priceAdjusted),
                        },
                        ...{
                            meta: {
                                category: product.category,
                                subcategory: product.subcategory,
                                store: product.shop_name,
                                store_fp: shop_fp,
                                structured: false,
                            },
                        },
                    };
                    //...
                    return tmpData;
                });

                const privateKeys = [
                    'website_link',
                    'used_link',
                    'local_images_registry',
                    'createdAt',
                    'priceAdjusted',
                ];

                const safeProducts = _.map(reformattedData, (obj) =>
                    _.omit(obj, privateKeys)
                );

                res.send({
                    count: reformattedData.length,
                    response: safeProducts,
                });
            } //No valid data
            else {
                res.send({ response: [] });
            }
        } catch (error) {
            logger.error(error);
            res.send({ response: [] });
        }
    }
);

//?5. Get location search suggestions
app.post('/getSearchedLocations', authenticate, async (req, res) => {
    try {
        const results = await getSearchedLocations(req.body);
        res.send(results);
    } catch (error) {
        console.error(error);
        res.send(false);
    }
});

//?6. Request for shopping
app.post('/requestForShopping', authenticate, async (req, res) => {
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
                .filter('date_clientRating')
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

                const requestId = uuidv4();
                const paymentId = uuidv4();
                const clientId = user_identifier;
                const requestTotals = parsedTotals;

                if (req.payment_method === 'wallet') {
                    //? Check the balance
                    const { balance } = await getBalance(clientId);
                    const requestRequiredTotal = requestTotals;

                    if (balance < requestRequiredTotal)
                        return res.json({
                            response: 'unable_to_request_insufficient_balance',
                        });

                    await dynamoose.transaction([
                        RequestsModel.transaction.create({
                            id: requestId,
                            transaction_payment_id: paymentId,
                            client_id: clientId, //the user identifier - requester
                            payment_method: payment_method, //mobile_money or cash
                            locations: JSON.parse(locations), //Has the pickup and delivery locations
                            totals_request: requestTotals, //Has the cart details in terms of fees
                            request_documentation: note,
                            shopping_list: JSON.parse(shopping_list), //! The list of items to shop for
                            ride_mode: ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                            security: security_pin, //Will be used to check the request,
                        }),
                        Payments.transaction.create({
                            id: paymentId,
                            user_id: clientId,
                            amount: requestTotals.total,
                            currency: 'nad',
                            transaction_description: 'GROCERY_PAYMENT',
                        }),
                    ]);
                } else {
                    const newRequest = await RequestsModel.create({
                        id: requestId,
                        client_id: clientId, //the user identifier - requester
                        payment_method: payment_method, //mobile_money or cash
                        locations: JSON.parse(locations), //Has the pickup and delivery locations
                        totals_request: requestTotals, //Has the cart details in terms of fees
                        request_documentation: note,
                        shopping_list: JSON.parse(shopping_list), //! The list of items to shop for
                        ride_mode: ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                        security: security_pin, //Will be used to check the request,
                    });

                    console.log(newRequest);
                }

                await sendEmail({
                    email: [
                        'dominique@kedokagroup.com',
                        'silas@kedokagroup.com',
                    ],
                    fromEmail: 'support@dulcetdash.com',
                    fromName: 'requests@dulcetdash.com',
                    message: `A new ${ride_mode} request was made by ${clientId.slice(
                        0,
                        15
                    )}`,
                    subject: `New ${ride_mode} for N$${
                        requestTotals?.service_fee ??
                        requestTotals?.shopping_fee ??
                        'Unknown'
                    } request made`,
                });

                res.json({ response: 'successful' });
            } else {
                res.json({ response: 'has_a_pending_shopping' });
            }
        } else {
            res.send({ response: 'unable_to_request' });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'unable_to_request' });
    }
});

//?6. Request for delivery or ride
app.post('/requestForRideOrDelivery', authenticate, async (req, res) => {
    try {
        const { user } = req;
        req = req.body;
        //! Check for the user identifier, shopping_list and totals
        //Check basic ride or delivery conditions
        const checkerCondition =
            req?.ride_mode === 'delivery'
                ? !!req?.user_identifier &&
                  !!req?.dropOff_data &&
                  !!req?.totals &&
                  !!req?.pickup_location
                : !!req?.user_identifier &&
                  !!req?.dropOff_data &&
                  !!req?.passengers_number &&
                  !!req?.pickup_location;

        if (checkerCondition) {
            let securityPin = otpGenerator.generate(6, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false,
            });
            //! --------------
            securityPin =
                String(securityPin).length < 6
                    ? parseInt(securityPin, 10) * 10
                    : securityPin;

            //! Check if the user has no unconfirmed shoppings
            const previousRequest = await RequestsModel.query('client_id')
                .eq(req.user_identifier)
                .filter('date_clientRating')
                .not()
                .exists()
                .filter('date_cancelled')
                .not()
                .exists()
                .exec();

            if (previousRequest.count <= 0 || user?.company_name) {
                //No unconfirmed requests
                //! Perform the conversions
                req.totals =
                    req?.totals && typeof req?.totals === 'string'
                        ? JSON.parse(req.totals)
                        : req.totals;

                if (req?.totals?.delivery_fee) {
                    req.totals.delivery_fee = parseFloat(
                        String(req.totals?.delivery_fee)?.replace('N$', '')
                    );
                    req.totals.service_fee = parseFloat(
                        String(req.totals?.service_fee)?.replace('N$', '')
                    );
                    req.totals.total = parseFloat(
                        String(req.totals?.total)?.replace('N$', '')
                    );
                }
                //...

                const requestId = uuidv4();
                const paymentId = uuidv4();
                const clientId = req.user_identifier;
                const requestTotals = req.totals;

                if (req.payment_method === 'wallet') {
                    //? Check the balance
                    const { balance } = await getBalance(clientId);
                    const requestRequiredTotal = requestTotals;

                    if (
                        balance < requestRequiredTotal.total ||
                        !requestRequiredTotal?.total
                    )
                        return res.json({
                            response: 'unable_to_request_insufficient_balance',
                        });

                    await dynamoose.transaction([
                        RequestsModel.transaction.create({
                            id: requestId,
                            transaction_payment_id: paymentId,
                            client_id: clientId, //the user identifier - requester
                            payment_method: req.payment_method, //mobile_money or cash or wallet
                            locations: {
                                pickup:
                                    typeof req.pickup_location === 'string'
                                        ? JSON.parse(req.pickup_location)
                                        : req.pickup_location, //Has the pickup locations
                                dropoff:
                                    typeof req.dropOff_data === 'string'
                                        ? JSON.parse(req.dropOff_data)
                                        : req.dropOff_data, //The list of recipient/riders and their locations
                            },
                            totals_request: requestTotals, //Has the cart details in terms of fees
                            request_documentation: req.note,
                            ride_mode: req.ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                            security: securityPin,
                        }),
                        Payments.transaction.create({
                            id: paymentId,
                            user_id: clientId,
                            amount: requestTotals.total,
                            currency: 'nad',
                            transaction_description: 'PACKAGE_DELIVERY_PAYMENT',
                        }),
                    ]);
                } else {
                    const newRequest = await RequestsModel.create({
                        id: requestId,
                        client_id: clientId, //the user identifier - requester
                        payment_method: req.payment_method, //mobile_money or cash
                        locations: {
                            pickup: JSON.parse(req.pickup_location), //Has the pickup locations
                            dropoff: JSON.parse(req.dropOff_data), //The list of recipient/riders and their locations
                        },
                        totals_request: requestTotals, //Has the cart details in terms of fees
                        request_documentation: req.note,
                        ride_mode: req.ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                        security: securityPin,
                    });

                    console.log(newRequest);
                }

                await sendEmail({
                    email: [
                        'dominique@kedokagroup.com',
                        'silas@kedokagroup.com',
                    ],
                    fromEmail: 'support@dulcetdash.com',
                    fromName: 'requests@dulcetdash.com',
                    message: `A new ${
                        req.ride_mode
                    } request was made by ${clientId.slice(0, 15)}`,
                    subject: `New ${req.ride_mode} for N$${
                        requestTotals?.delivery_fee ??
                        requestTotals?.shopping_fee ??
                        'Unknown'
                    } request made`,
                });

                //Notify all the shoppers
                const driversOneSignalUserIds = (
                    await DriversModel.scan().all().exec()
                )
                    .toJSON()
                    .map((driver) => driver?.oneSignalUserId)
                    .filter((el) => el);

                const message = {
                    title: `New ${req.ride_mode} request`,
                    body: `N$${
                        requestTotals?.delivery_fee ??
                        requestTotals?.shopping_fee ??
                        'Unknown'
                    } request made`,
                };

                await sendPushUPNotification(
                    'shopper',
                    driversOneSignalUserIds,
                    message
                );

                return res.json({ response: 'successful' });
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
app.post('/getShoppingData', authenticate, async (req, res) => {
    try {
        const { user, body } = req;

        if (user?.id) {
            //! Check if the user id exists
            const request = await getRequestDataClient(
                body,
                !!user?.company_name
            );

            if (user?.company_name) {
                const accountData =
                    await performCorporateDeliveryAccountAuthOps({
                        company_fp: user.id,
                        op: 'getAccountData',
                    });

                return res.json({
                    accountData: accountData?.metadata,
                    requests: !request ? [] : request,
                });
            }

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
app.post('/getRouteToDestinationSnapshot', authenticate, function (req, res) {
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
app.post('/computeFares', authenticate, function (req, res) {
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
app.post('/submitRiderOrClientRating', authenticate, async (req, res) => {
    try {
        const {
            request_fp: requestId,
            rating,
            badges,
            note,
            user_fingerprint: userId,
        } = req.body;

        if (!requestId || !rating || !badges || !userId)
            return res.send({ response: 'error' });

        const parsedBadges =
            typeof badges === 'string' ? JSON.parse(badges) : badges;

        const RATING_DATA = {
            rating: parseFloat(rating),
            comments: note,
            compliments: parsedBadges,
            date_clientRating: Date.now(),
        };

        const request = await RequestsModel.query('id')
            .eq(requestId)
            .filter('date_clientRating')
            .not()
            .exists()
            .exec();

        if (request.count <= 0) return res.send({ response: 'error' });

        await RequestsModel.update(
            { id: request[0].id },
            {
                request_state_vars: {
                    ...request[0].request_state_vars,
                    rating_data: RATING_DATA,
                },
                date_clientRating: Date.now(),
            }
        );

        res.send({ response: 'success' });
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

//?9. Cancel request - user
app.post('/cancel_request_user', authenticate, async (req, res) => {
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

                //Cancel the payment transaction if any
                if (requestData?.transaction_payment_id) {
                    await Payments.update(
                        {
                            id: requestData?.transaction_payment_id,
                        },
                        {
                            success: false,
                        }
                    );
                }

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

//?11. get the list of requests for riders
app.post('/getRequestListRiders', authenticate, async (req, res) => {
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
app.post('/updateUsersInformation', authenticate, async (req, res) => {
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
            res.send({ response: 'error' });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error' });
    }
});

//?13. Get the user data
app.post('/getGenericUserData', authenticate, async (req, res) => {
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

            if (cachedProfilePicture?.bare === user?.profile_picture) {
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
                }),
                'EX',
                72 * 3600
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
            stripeCustomerId: user?.stripe_customerId,
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
app.post('/checkPhoneAndSendOTP_status', lightcheck, async (req, res) => {
    try {
        const { phone } = req.body;

        const user = await UserModel.query('phone_number').eq(phone).exec();

        const sentSMS = await shouldSendNewSMS(user[0], phone);

        res.json({
            status: 'success',
            response: {
                didSendOTP: sentSMS,
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
app.post('/validateUserOTP', lightcheck, async (req, res) => {
    try {
        const { phone, otp } = req.body;

        const user = await UserModel.query('phone_number').eq(phone).exec();

        if (user.count > 0) {
            const checkOtp = await UserModel.query('phone_number')
                .eq(phone)
                .filter('otp')
                .eq(parseInt(otp, 10))
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

                const { sessionToken, permaToken } =
                    await generateNewSecurityToken(userData);
                res.setHeader('x-session-token', sessionToken);
                res.setHeader('x-perma-token', permaToken);

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
                .eq(parseInt(otp, 10))
                .exec();

            console.log(phone, parseInt(otp, 10));
            console.log(checkOTP);

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
app.post('/createBasicUserAccount', lightcheck, async (req, res) => {
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

            const { sessionToken, permaToken } = await generateNewSecurityToken(
                newAccount
            );
            res.setHeader('x-session-token', sessionToken);
            res.setHeader('x-perma-token', permaToken);

            await sendEmail({
                email: ['dominique@kedokagroup.com', 'silas@kedokagroup.com'],
                fromEmail: 'support@dulcetdash.com',
                fromName: 'requests@dulcetdash.com',
                message: `A new user has just registered with the phone number ${phone}`,
                subject: `A new user just registered!`,
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
app.post('/addAdditionalUserAccDetails', authenticate, async (req, res) => {
    const { user_identifier, additional_data } = req.body;

    if (!user_identifier || !additional_data) {
        return res.json({ response: 'error' });
    }

    const { name, surname, gender, email, profile_picture_generic } =
        JSON.parse(additional_data);

    //? Create stripe user
    const stripeCustomer = await stripe.customers.create({
        email,
    });

    try {
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
                stripe_customerId: stripeCustomer.id,
            }
        );

        const userProfile = {
            name: userData.name,
            surname: userData.surname,
            gender: userData.gender,
            account_state: userData.account_state,
            profile_picture: userData?.profile_picture,
            is_accountVerified: userData?.is_accountVerified,
            phone: userData.phone_number,
            email: userData.email,
            user_identifier: userData.id,
        };

        const { sessionToken, permaToken } = await generateNewSecurityToken(
            userData
        );
        res.setHeader('x-session-token', sessionToken);
        res.setHeader('x-perma-token', permaToken);

        res.json({
            response: 'success',
            user_identifier,
            userData: userProfile,
        });
    } catch (error) {
        console.error(error);
        await stripe.customers.del(stripeCustomer.id);
        res.status(500).send({
            response: 'error',
            error: { message: error.message },
        });
    }
});

//?18. Get the go again list of the 3 recently visited shops - only for users
app.post('/getRecentlyVisitedShops', authenticate, async (req, res) => {
    try {
        const { user_identifier: userId } = req.body;

        const redisKey = `${userId}-cachedRecentlyVisited_shops`;

        if (userId) {
            const recentShops = await getRecentlyVisitedShops(userId, redisKey);

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
app.post(
    '/checkPhoneAndSendOTP_changeNumber_status',
    authenticate,
    async (req, res) => {
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
    }
);

//?20. Validate user OTP
//! * FOR CHANGING USERS PHONE NUMBERS
app.post('/validateUserOTP_changeNumber', authenticate, async (req, res) => {
    try {
        const { phone, user_identifier } = req.body;

        let { otp } = req.body;

        if (phone && otp && user_identifier) {
            otp = parseInt(otp, 10);

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
app.post('/receivePushNotification_token', authenticate, async (req, res) => {
    try {
        const { pushnotif_token } = req.body;

        if (!pushnotif_token) return res.send({ response: 'error' });

        const { userId } = JSON.parse(pushnotif_token);

        if (!userId) return res.send({ response: 'no userId found' });

        const mainModel = req.user?.isDriver ? DriversModel : UserModel;

        await mainModel.update(
            {
                id: req.user?.id,
            },
            {
                oneSignalUserId: userId,
            }
        );

        res.send({ response: 'success' });
    } catch (error) {
        res.send({ response: 'error' });
    }
});

//? REST equivalent for common websockets.
/**
 * For the courier driver resgistration
 */
app.post('/registerCourier_ppline', lightcheck, async (req, res) => {
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

app.post('/registerDriver_ppline', lightcheck, function (req, res) {
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

app.post('/update_requestsGraph', authenticate, function (req, res) {
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
app.post('/geocode_this_point', authenticate, async (req, res) => {
    try {
        const { latitude, longitude, user_fingerprint: userId } = req.body;

        if (latitude && longitude && userId) {
            const location = await getUserLocationInfos(
                latitude,
                longitude,
                userId
            );

            return res.json(location);
        }
        res.json(false);
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
app.post('/update_passenger_location', authenticate, async (req, res) => {
    try {
        const { latitude, longitude, user_fingerprint: driverId } = req.body;

        const driver = await DriversModel.get(driverId);

        if (!driver) return false;

        //Update the last location
        if (
            latitude &&
            longitude &&
            !Number.isNaN(parseFloat(latitude)) &&
            !Number.isNaN(parseFloat(longitude))
        ) {
            await DriversModel.update(
                {
                    id: driverId,
                },
                {
                    last_location: {
                        latitude: parseFloat(latitude),
                        longitude: parseFloat(longitude),
                    },
                }
            );
        }

        const availableRequests = (
            await RequestsModel.query('shopper_id')
                .eq('false')
                .filter('date_cancelled')
                .not()
                .exists()
                .filter('date_completedJob')
                .not()
                .exists()
                .exec()
        ).toJSON();

        const takenRequests = (
            await RequestsModel.query('shopper_id')
                .eq(driverId)
                .filter('date_cancelled')
                .not()
                .exists()
                .filter('date_completedJob')
                .not()
                .exists()
                .exec()
        ).toJSON();

        const parsedAvailableRequests = await Promise.all(
            availableRequests.map(async (request) =>
                parseRequestsForShopperAppView(request, driver)
            )
        );

        const parsedTakenRequests = await Promise.all(
            takenRequests.map(async (request) =>
                parseRequestsForShopperAppView(request, driver)
            )
        );

        res.json({
            status: 'success',
            data: {
                availableRequests: parsedAvailableRequests,
                takenRequests: parsedTakenRequests,
            },
        });
    } catch (error) {
        logger.error(error);
        res.send(false);
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: accept_request
 * event: accept_request_io
 * Accept any request from the driver's side.
 */
app.post('/accept_request_io', authenticate, async (req, res) => {
    try {
        const { driver_fingerprint: driverId, request_fp: requestId } =
            req.body;

        const driver = await DriversModel.get(driverId);
        const request = await RequestsModel.query('id')
            .eq(requestId)
            .filter('date_cancelled')
            .not()
            .exists()
            .filter('date_completedJob')
            .not()
            .exists()
            .filter('date_completedDropoff')
            .not()
            .exists()
            .exec();

        if (!driver || request.count <= 0)
            return res.send({
                response: 'unable_to_accept_request_error',
            });

        if (request[0].shopper_id !== 'false')
            return res.send({
                response: 'request_already_taken',
            });

        let acceptObject = {
            shopper_id: driverId,
            date_accepted: Date.now(),
            request_state_vars: {
                ...request[0].request_state_vars,
                isAccepted: true,
                inRouteToPickupCash: true,
            },
        };

        if (request[0].ride_mode === 'SHOPPING') {
            if (request[0].payment_method !== 'cash') {
                acceptObject = {
                    ...acceptObject,
                    ...{
                        date_routeToShop: Date.now(),
                    },
                };
            }
        }

        const acceptedRequest = await RequestsModel.update(
            { id: requestId },
            acceptObject
        );

        await sendEmail({
            email: ['dominique@kedokagroup.com', 'silas@kedokagroup.com'],
            fromEmail: 'support@dulcetdash.com',
            fromName: 'requests@dulcetdash.com',
            message: `Driver ${driver.name} ${driver.surname} (${driver.id}) accepted request ${requestId}`,
            subject: `${acceptedRequest.ride_mode} accepted`,
        });

        const client = await UserModel.get(acceptedRequest.client_id);

        if (client?.oneSignalUserId) {
            await sendPushUPNotification('shopper', client?.oneSignalUserId, {
                title: 'Your request was accepted',
                message: `We've found a ${
                    acceptedRequest.ride_mode === 'SHOPPING'
                        ? 'shopper'
                        : 'Courier'
                } for you!}`,
            });
        }

        res.json({
            status: 'success',
            response: 'successfully_accepted',
            rider_fp: acceptedRequest.client_id,
        });
    } catch (error) {
        logger.error(error);
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
app.post('/cancel_request_driver_io', authenticate, async (req, res) => {
    try {
        const { request_fp } = req.body;

        if (!request_fp)
            return res.send({
                response: 'unable_to_cancel_request_error',
            });

        const cancelledRequest = await RequestsModel.update(
            { id: request_fp },
            {
                shopper_id: 'false',
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
app.post(
    '/confirm_pickup_request_driver_io',
    authenticate,
    async (req, res) => {
        try {
            const { driver_fingerprint: driverId, request_fp: requestId } =
                req.body;

            const driver = await DriversModel.get(driverId);

            if (!driver)
                return res.send({
                    response: 'unable_to_confirm_pickup_request_error',
                });

            const request = await RequestsModel.query('id')
                .eq(requestId)
                .filter('date_cancelled')
                .not()
                .exists()
                .filter('date_completedJob')
                .not()
                .exists()
                .filter('date_completedDropoff')
                .not()
                .exists()
                .exec();

            if (request.count <= 0)
                return res.send({
                    response: 'unable_to_confirm_pickup_request_error',
                });

            const updatedRequest = await RequestsModel.update(
                {
                    id: requestId,
                },
                {
                    request_state_vars: {
                        ...request[0].request_state_vars,
                        ...{
                            inRouteToDropoff: true,
                            inRouteToShop: true,
                            didPickupCash: true,
                            inRouteToPickupCash: true,
                        },
                    },
                    date_routeToShop: Date.now(),
                    date_pickedupCash: Date.now(),
                }
            );

            const client = await UserModel.get(updatedRequest.client_id);

            if (client?.oneSignalUserId) {
                await sendPushUPNotification(
                    'shopper',
                    client?.oneSignalUserId,
                    {
                        title:
                            updatedRequest.ride_mode === 'SHOPPING'
                                ? 'Money picked up'
                                : 'Package picked up',
                        message: `Your ${
                            updatedRequest.ride_mode === 'SHOPPING'
                                ? 'shopper'
                                : 'Courier'
                        } has just picked up the ${
                            updatedRequest.ride_mode === 'SHOPPING'
                                ? 'money'
                                : 'package'
                        }`,
                    }
                );
            }

            res.json({
                status: 'success',
                response: 'successfully_confirmed_pickup',
                rider_fp: updatedRequest.client_id,
            });
        } catch (error) {
            logger.error(error);
            res.send({
                response: 'unable_to_confirm_pickup_request_error',
            });
        }
    }
);

/**
 * DISPATCH SERVICE, port 9094
 * Route: confirm_pickup_request_driver
 * Confirm that the shopping is done for any request from the driver's side.
 */
app.post(
    '/confirm_doneShopping_request_driver_io',
    authenticate,
    async (req, res) => {
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

            requestAPI.post(
                { url, form: req },
                function (error, response, body) {
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
                            response:
                                'unable_to_confirm_doneShopping_request_error',
                        });
                    }
                }
            );
        } else {
            res.send({
                response: 'unable_to_confirm_doneShopping_request_error',
            });
        }
    }
);

/**
 * DISPATCH SERVICE, port 9094
 * Route: decline_request
 * event: declineRequest_driver
 * Decline any request from the driver's side.
 */
app.post('/declineRequest_driver', authenticate, function (req, res) {
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

app.post('/confirm_item_dropoff', authenticate, async (req, res) => {
    try {
        const {
            driver_fingerprint: driverId,
            request_fp: requestId,
            selectedPackageIndex,
            isItemNotFound: isFound,
        } = req.body;

        const isItemNotFound = isFound === 'true';

        if (!driverId || !requestId)
            return res.send({
                response: 'unable_to_confirm_dropoff_request_error',
            });

        const driver = await DriversModel.get(driverId);

        if (!driver)
            return res.send({
                response: 'unable_to_confirm_dropoff_request_error',
            });

        const request = await RequestsModel.query('id')
            .eq(requestId)
            .filter('date_cancelled')
            .not()
            .exists()
            .filter('date_completedJob')
            .not()
            .exists()
            .filter('date_completedDropoff')
            .not()
            .exists()
            .exec();

        if (request.count <= 0)
            return res.send({
                response: 'unable_to_confirm_dropoff_request_error',
            });

        const packageIndex =
            selectedPackageIndex &&
            !Number.isNaN(parseInt(selectedPackageIndex, 10))
                ? parseInt(selectedPackageIndex, 10)
                : 0;
        let updatedDeliveryList = {};

        if (request[0]?.ride_mode === 'DELIVERY') {
            updatedDeliveryList = {
                locations: {
                    pickup: request[0].locations.pickup,
                    dropoff: request[0]?.locations?.dropoff?.map(
                        (delivery, index) => {
                            if (index === packageIndex) {
                                delivery.isCompleted = true;
                            }
                            return delivery;
                        }
                    ),
                },
            };
        } //SHOPPING
        else {
            updatedDeliveryList = {
                shopping_list: request[0]?.shopping_list?.map(
                    (shopping, index) => {
                        if (index === packageIndex) {
                            if (isItemNotFound) {
                                shopping.isCompleted = false;
                                shopping.isNotFound = true;
                            } //Item found
                            else {
                                shopping.isCompleted = true;
                                shopping.isNotFound = false;
                            }
                        }
                        return shopping;
                    }
                ),
            };
        }

        const updatedRequest = await RequestsModel.update(
            {
                id: requestId,
            },
            updatedDeliveryList
        );

        res.json({
            status: 'success',
            response: 'successfully_confirmed_dropoff',
            rider_fp: updatedRequest.client_id,
        });
    } catch (error) {
        logger.error(error);
        res.send({
            response: 'unable_to_confirm_dropoff_request_error',
        });
    }
});

/**
 * DISPATCH SERVICE, port 9094
 * Route: confirm_dropoff_request_driver
 * event: confirm_dropoff_request_driver_io
 * Confirm dropoff for any request from the driver's side.
 */
app.post(
    '/confirm_dropoff_request_driver_io',
    authenticate,
    async (req, res) => {
        try {
            const { driver_fingerprint: driverId, request_fp: requestId } =
                req.body;

            if (!driverId || !requestId)
                return res.send({
                    response: 'unable_to_confirm_dropoff_request_error',
                });

            const driver = await DriversModel.get(driverId);

            if (!driver)
                return res.send({
                    response: 'unable_to_confirm_dropoff_request_error',
                });

            const request = await RequestsModel.query('id')
                .eq(requestId)
                .filter('date_cancelled')
                .not()
                .exists()
                .filter('date_completedJob')
                .not()
                .exists()
                .filter('date_completedDropoff')
                .not()
                .exists()
                .exec();

            if (request.count <= 0)
                return res.send({
                    response: 'unable_to_confirm_dropoff_request_error',
                });

            const updatedRequest = await RequestsModel.update(
                {
                    id: requestId,
                },
                {
                    request_state_vars: {
                        ...request[0].request_state_vars,
                        ...{
                            inRouteToDropoff: true,
                            inRouteToShop: true,
                            didPickupCash: true,
                            inRouteToPickupCash: true,
                            completedDropoff: true,
                            completedJob: true,
                        },
                    },
                    date_completedJob: Date.now(),
                }
            );

            const client = await UserModel.get(updatedRequest.client_id);

            if (client?.oneSignalUserId) {
                await sendPushUPNotification(
                    'shopper',
                    client?.oneSignalUserId,
                    {
                        title:
                            updatedRequest.ride_mode === 'SHOPPING'
                                ? 'Rate your shopper!'
                                : 'Rate your courier!',
                        message: `Your ${
                            updatedRequest.ride_mode === 'SHOPPING'
                                ? 'Shopping'
                                : 'Delivery'
                        } has been successfully completed.`,
                    }
                );
            }

            //Clear the driver's daily cache
            const redisKey = getDailyAmountDriverRedisKey(driverId);

            await Redis.del(redisKey);

            res.json({
                status: 'success',
                response: 'successfully_confirmed_dropoff',
                rider_fp: updatedRequest.client_id,
            });
        } catch (error) {
            logger.error(error);
            res.send({
                response: 'unable_to_confirm_dropoff_request_error',
            });
        }
    }
);

/**
 * DISPATCH SERVICE, port 9094
 * Route: getRequests_graphNumbers
 * event: update_requestsGraph
 * Update the general requests numbers for ease of access
 */
app.post('/update_requestsGraph', authenticate, async (req, res) => {
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
 * Route: computeDaily_amountMadeSoFar
 * event: computeDaily_amountMadeSoFar_io
 * Responsible for getting the daily amount made so far by the driver for exactly all the completed requests.
 */
app.post('/computeDaily_amountMadeSoFar_io', authenticate, async (req, res) => {
    try {
        const { driver_fingerprint } = req.body;

        if (!driver_fingerprint)
            return res.send({
                amount: 0,
                currency: 'NAD',
                currency_symbol: 'N$',
                response: 'error',
            });

        const daily = await computeDaily_amountMadeSoFar(driver_fingerprint);

        res.send(daily);
    } catch (error) {
        logger.error(error);
        res.send({
            amount: 0,
            currency: 'NAD',
            currency_symbol: 'N$',
            response: 'error',
        });
    }
});

//Drivers checking - Phone number
app.post('/sendOtpAndCheckerUserStatusTc', lightcheck, async (req, res) => {
    try {
        const { phone_number } = req.body;

        if (!phone_number)
            return res.send({ response: 'error_phone_number_not_received' });

        const driver = await DriversModel.query('phone_number')
            .eq(phone_number)
            .exec();

        if (driver.count > 0) {
            const driverData = driver[0];

            await shouldSendNewSMS(driverData, phone_number, true);

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
                isDriverSuspended: driverData?.isDriverSuspended ?? false,
                pushnotif_token: driverData.pushnotif_token,
                suspension_message: driverData.suspension_message,
            });
        } //Unregistered user
        else {
            //Get the last
            await shouldSendNewSMS(null, phone_number, true);

            return res.send({ response: 'not_yet_registered' });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error_checking_user' });
    }
});

//For drivers only
app.post('/checkThisOTP_SMS', lightcheck, async (req, res) => {
    try {
        let { phone_number, otp, user_nature } = req.body;

        logger.warn(req.body);

        if (!phone_number || !otp)
            return res.send({ response: 'error_checking_otp' });

        otp = parseInt(otp, 10);

        const driver = await DriversModel.query('phone_number')
            .eq(phone_number)
            .exec();

        if (driver.count <= 0) {
            //Unregistered users
            const otpCheck = await OTPModel.query('phone_number')
                .eq(phone_number)
                .filter('otp')
                .eq(otp)
                .exec();

            if (otpCheck.count > 0) return res.send({ response: true });

            return res.send({ response: false });
        } //Checking for registered user - check the OTP secrets binded to the profile
        // eslint-disable-next-line no-else-return
        else {
            const checkedDriver = await DriversModel.query('phone_number')
                .eq(phone_number)
                .filter('otp')
                .eq(otp)
                .exec();

            if (checkedDriver.count > 0) {
                const { sessionToken, permaToken } =
                    await generateNewSecurityToken(
                        checkedDriver.toJSON()[0],
                        DriversModel
                    );
                res.setHeader('x-session-token', sessionToken);
                res.setHeader('x-perma-token', permaToken);

                return res.send({ response: true });
            }

            res.send({ response: false });
        }
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error_checking_otp' });
    }
});

app.post('/goOnline_offlineDrivers_io', authenticate, async (req, res) => {
    try {
        const { driver_fingerprint, action, state } = req.body;

        const driverStatus = await goOnline_offlineDrivers(
            driver_fingerprint,
            action,
            state
        );

        res.json(driverStatus);
    } catch (error) {
        logger.error(error);
        res.send({ response: 'error_invalid_request' });
    }
});

app.post('/driversOverallNumbers', authenticate, async (req, res) => {
    try {
        const { user_fingerprint: driverId } = req.body;

        if (!driverId)
            return res.send({
                response: 'error',
            });

        const driver = await DriversModel.get(driverId);

        if (!driver)
            return res.send({
                response: 'error',
            });

        const requests = await RequestsModel.query('shopper_id')
            .eq(driverId)
            .filter('date_completedJob')
            .exists()
            .exec();

        res.send({
            response: {
                requests: requests.count,
                revenue: 0,
                rating: 0,
            },
        });
    } catch (error) {
        logger.error(error);
        res.send({
            response: {
                rides: 0,
                requests: 0,
                revenue: 0,
                rating: 0,
            },
        });
    }
});

app.post(
    '/getRides_historyRiders_batchOrNot',
    authenticate,
    function (req, res) {
        req = req.body;
        //logger.info(req);
        if (
            req.user_fingerprint !== undefined &&
            req.user_fingerprint !== null
        ) {
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
                url +=
                    '&target=' + req.target + '&request_fp=' + req.request_fp;
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
    }
);

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

        //Attach the user and/or driver detailsx
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
                        !el?.date_clientRating &&
                        !el?.date_cancelled
                ),
                completed: requests.filter(
                    (el) => el.ride_mode === 'DELIVERY' && el?.date_clientRating
                ),
                cancelled: requests.filter(
                    (el) => el.ride_mode === 'DELIVERY' && el?.date_cancelled
                ),
            },
            shopping: {
                inprogress: requests.filter(
                    (el) =>
                        el.ride_mode === 'SHOPPING' &&
                        !el?.date_clientRating &&
                        !el?.date_cancelled
                ),
                completed: requests.filter(
                    (el) => el.ride_mode === 'SHOPPING' && el?.date_clientRating
                ),
                cancelled: requests.filter(
                    (el) => el.ride_mode === 'SHOPPING' && el?.date_cancelled
                ),
            },
            stats: {
                total_sales_today: getAmountsSums({
                    arrayRequests: requests.filter((el) => !el.date_cancelled),
                    dataType: 'sales',
                }),
                total_revenue_today: getAmountsSums({
                    arrayRequests: requests.filter(
                        (el) => !el.date_cancelled && el?.date_clientRating
                    ),
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

        //Change to windhoek time
        requests = requests.map((request) => {
            request.createdAt = addTwoHours(request.createdAt);
            return request;
        });

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
            1 * 60 * 60
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
            // console.log(hashedPassword);

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
            otp =
                String(otp).length < 8
                    ? parseInt(otp, 10) * 10
                    : parseInt(otp, 10);

            //Update security PIN
            await AdminsModel.update(
                { id: adminData.id },
                {
                    security_pin: otp,
                }
            );

            //Send the OTP email
            //? Send email
            await sendEmail({
                email,
                fromEmail: 'support@dulcetdash.com',
                fromName: 'DulcetDash - Cesar',
                subject: 'Admin Verification Code',
                message: `Hi Admin\n\n Verification code: ${otp}`,
            });

            //?DONE
            logger.info(
                `Sending receipt email...to ${adminData.corporate_email}`
            );

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

/**
 * PERFORMA AUTHENTICATION OPS ON A CORPORATE DELIVERY A ACCOUNT
 * ? Responsible for performing auth operations on a delivery account on the web interface.
 */
app.post('/performOpsCorporateDeliveryAccount', async (req, res) => {
    try {
        const response = await performCorporateDeliveryAccountAuthOps(req.body);

        res.json(response);
    } catch (error) {
        res.status(400).json({
            response: 'error',
        });
    }
});

//PAYMENT
app.get('/prices', authenticate, async (req, res) => {
    try {
        const prices = await stripe.prices.list({ limit: 5 });

        const filteredPrices = prices.data.map((price) => ({
            id: price?.id,
            lookupKey: price?.lookup_key,
            price: price.unit_amount / 100,
        }));

        res.send({
            status: 'success',
            data: filteredPrices,
        });
    } catch (err) {
        res.status(500).send({ error: { message: err.message } });
    }
});

app.post('/subscription', authenticate, async (req, res) => {
    const { customerId, priceId, paymentMethodId } = req.body;

    let user = await UserModel.query('stripe_customerId').eq(customerId).exec();

    if (user.count <= 0)
        res.status(500).send({ error: { message: 'User not found' } });

    user = user[0];

    try {
        // Retrieve the existing subscriptions for the customer
        const subscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: 'active',
        });

        let subscription;

        if (paymentMethodId) {
            subscription = subscriptions.data[0];

            if (subscription?.id) {
                await stripe.subscriptions.update(subscription.id, {
                    items: [
                        {
                            id: subscription.items.data[0].id,
                            price: priceId,
                        },
                    ],
                    default_payment_method: paymentMethodId,
                    payment_behavior: 'default_incomplete',
                    proration_behavior: 'none',
                });
            } else {
                //Create new one
                await stripe.subscriptions.create({
                    customer: customerId,
                    items: [
                        {
                            price: priceId,
                        },
                    ],
                    expand: ['latest_invoice.payment_intent'],
                    cancel_at_period_end: false,
                    default_payment_method: paymentMethodId,
                    metadata: { userId: user.id },
                });
            }

            return res.json({
                status: 'success',
                state: 'paidWithPaymentId',
            });
        }

        // If an active subscription exists, update it
        if (subscriptions.data.length > 0) {
            subscription = subscriptions.data[0];

            subscription = await stripe.subscriptions.retrieve(
                subscription.id,
                {
                    expand: ['default_payment_method'],
                }
            );
            const paymentMethod = subscription.default_payment_method;

            if (!paymentMethod) {
                subscription = await stripe.subscriptions.create({
                    customer: customerId,
                    items: [
                        {
                            price: priceId,
                        },
                    ],
                    payment_behavior: 'default_incomplete',
                    expand: ['latest_invoice.payment_intent'],
                    cancel_at_period_end: false,
                    payment_settings: {
                        save_default_payment_method: 'on_subscription',
                    },
                    metadata: { userId: user.id },
                });
            } else {
                subscription = await stripe.subscriptions.create({
                    customer: customerId,
                    items: [
                        {
                            price: priceId,
                        },
                    ],
                    payment_behavior: 'default_incomplete',
                    expand: ['latest_invoice.payment_intent'],
                    cancel_at_period_end: false,
                    payment_settings: {
                        save_default_payment_method: 'on_subscription',
                    },
                    metadata: { userId: user.id },
                });

                return res.json({
                    status: 'success',
                    state: 'alreadyHaveSubscriptionGivePaymentChoice',
                    clientSecret:
                        subscription.latest_invoice.payment_intent
                            .client_secret,
                });
            }
        }
        // If no active subscription exists, create a new one
        else {
            subscription = await stripe.subscriptions.create({
                customer: customerId,
                items: [
                    {
                        price: priceId,
                    },
                ],
                payment_behavior: 'default_incomplete',
                expand: ['latest_invoice.payment_intent'],
                cancel_at_period_end: false,
                payment_settings: {
                    save_default_payment_method: 'on_subscription',
                },
                metadata: { userId: user.id },
            });
        }

        // Response structure similar to the provided one
        if (subscription.status === 'active') {
            // Fetching the new price
            const newPrice = await stripe.prices.retrieve(priceId);
            const newPriceLookupKey = newPrice.lookup_key;
            let upgradedOrDowngraded = null;

            // Determine if it's an upgrade or downgrade by comparing amounts
            const currentAmount = subscription.items.data[0].price.unit_amount;
            const newAmount = newPrice.unit_amount;

            if (newAmount > currentAmount) {
                upgradedOrDowngraded = 'upgraded';
            } else if (newAmount < currentAmount) {
                upgradedOrDowngraded = 'downgraded';
            } else {
                upgradedOrDowngraded = 'same';
            }

            // Responding to the client
            res.status(200).json({
                status: 'success',
                subscription,
                upgradedOrDowngraded,
                newPriceLookupKey,
            });
        } else {
            // Check if there's a pending setup intent
            if (subscription.pending_setup_intent) {
                const setupIntent = await stripe.setupIntents.retrieve(
                    subscription.pending_setup_intent
                );
                res.status(200).json({
                    status: 'success',
                    setupIntentClientSecret: setupIntent.client_secret,
                });
            } else {
                res.status(200).json({
                    status: 'success',
                    subscriptionId: subscription.id,
                    clientSecret:
                        subscription.latest_invoice.payment_intent
                            .client_secret,
                });
            }
        }
    } catch (err) {
        console.log(err);
        res.status(500).send({ error: { message: err.message } });
    }
});

app.post('/oneoff_payment', authenticate, async (req, res) => {
    try {
        const { price } = req.body;
        const { user } = req;

        const paymentIntent = await stripe.paymentIntents.create({
            amount: price * 100, // amount in cents
            currency: 'nad',
            customer: user?.stripe_customerId,
        });

        res.json({
            status: 'success',
            clientSecret: paymentIntent.client_secret,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

server.listen(process.env.SERVER_MOTHER_PORT);
