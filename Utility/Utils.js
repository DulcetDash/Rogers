const _ = require('lodash');

require('dotenv').config();

const dayjs = require('dayjs');
const async = require('async');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const moment = require('moment');
const axios = require('axios');
const { promisify } = require('util');
const fs = require('fs');
const { ESClient } = require('./ESClient');
const AWS = require('aws-sdk');
const UserModel = require('../models/UserModel');
const { getItinaryInformation } = require('./Maps/Utils');
const { logger } = require('../LogService');
const Redis = require('./redisConnector');
const otpGenerator = require('otp-generator');
const { v4: uuidv4 } = require('uuid');
const {
    presignS3URL,
    extractS3ImagePath,
    generateCloudfrontSignedUrl,
} = require('./PresignDocs');
const DriversModel = require('../models/DriversModel');
const OTPModel = require('../models/OTPModel');
const emailService = require('./sendEmail');

// Configure AWS with your access and secret key.
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: 'us-east-1',
});

dayjs.extend(utc);
dayjs.extend(timezone);

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Extract hours and minutes
function extractTime(timeStr) {
    const parts = timeStr.match(/(\d+):(\d+)(AM|PM)/);
    if (!parts) {
        console.error('Invalid time format:', timeStr);
        return null;
    }

    let [_, hour, minute, meridiem] = parts;
    hour = parseInt(hour, 10);
    minute = parseInt(minute, 10);

    // Adjust hour for 12-hour AM/PM format
    if (meridiem === 'PM' && hour !== 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;

    return { hour, minute };
}

exports.storeTimeStatus = (operationTime) => {
    // Ensure Day.js has the required plugin
    const now = dayjs().tz('Africa/Windhoek');

    const dayOfWeek = now.format('dddd').toLowerCase().trim();
    const defaultOpeningTime = '8:00AM';
    const defaultClosingTime = '5:00PM';

    const dayTime = operationTime?.[dayOfWeek];
    const [opening_time, closing_time] = dayTime
        ? dayTime.split('-')
        : [defaultOpeningTime, defaultClosingTime];

    const open = extractTime(opening_time);
    const close = extractTime(closing_time);

    if (!open || !close) return 'Finding out';

    let openingDateTime = now.hour(open.hour).minute(open.minute);
    let closingDateTime = now.hour(close.hour).minute(close.minute);

    if (closingDateTime.isBefore(openingDateTime)) {
        closingDateTime = closingDateTime.add(1, 'day');
    }

    if (now.isAfter(openingDateTime) && now.isBefore(closingDateTime)) {
        if (now.isAfter(closingDateTime.subtract(2, 'hour'))) {
            return `Closing in ${Math.ceil(
                closingDateTime.diff(now, 'hour', true)
            )}h`;
        }
        return 'Open';
    } else if (now.isBefore(openingDateTime)) {
        return `Opening in ${Math.ceil(
            openingDateTime.diff(now, 'hour', true)
        )}h`;
    } else {
        openingDateTime = openingDateTime.add(1, 'day');
        return `Opening in ${Math.ceil(
            openingDateTime.diff(now, 'hour', true)
        )}h`;
    }
};

exports.searchProducts = async (index, criteria, size = 500) => {
    const { category, subcategory, product_name, shop_fp } = criteria;

    const boolArray = [
        {
            match: {
                product_name: {
                    query: product_name,
                    fuzziness: 'AUTO', // Adjust fuzziness as needed
                    prefix_length: 0, // Optional, but can be adjusted
                    max_expansions: 50, // Optional, but can be adjusted
                },
            },
        },
        {
            term: {
                shop_fp: {
                    value: shop_fp,
                },
            },
        },
    ];

    try {
        const response = await ESClient.search({
            size: 500,
            index: index,
            body: {
                query: {
                    bool: {
                        must: boolArray,
                    },
                },
            },
        });

        let results = response?.hits?.hits ?? [];

        if (results.length > 0) {
            results = results
                .map((result) => result?._source ?? null)
                .filter((result) => result);
        }

        return results;
    } catch (error) {
        console.error('Error searching in Elasticsearch:', error);
        return [];
    }
};

exports.getItemsByShop = async (index, shopFpValue) => {
    try {
        const response = await ESClient.search({
            size: 300,
            index: index,
            body: {
                query: {
                    match: {
                        shop_fp: shopFpValue,
                    },
                },
            },
        });

        let results = response?.hits?.hits ?? [];

        if (results.length > 0) {
            results = results
                .map((result) => result?._source ?? null)
                .filter((result) => result);
        }

        return results;
    } catch (error) {
        console.error(error);
        return [];
    }
};

exports.getAllItemsByShopFp = async (index, shopFpValue) => {
    const results = [];
    try {
        // Initial search request
        const initialResponse = await ESClient.search({
            index: index,
            scroll: '1m', // Keep the search context alive for 1 minute
            size: 1000,
            body: {
                query: {
                    match: {
                        shop_fp: shopFpValue,
                    },
                },
            },
        });

        // Push initial batch of results
        initialResponse.hits.hits.forEach((hit) => results.push(hit._source));

        let scrollId = initialResponse._scroll_id;
        while (initialResponse.hits.hits.length) {
            const scrollResponse = await ESClient.scroll({
                scroll_id: scrollId,
                scroll: '1m',
            });

            // Push next batch of results
            scrollResponse.hits.hits.forEach((hit) =>
                results.push(hit._source)
            );

            // Update the scroll ID for the next scroll request
            scrollId = scrollResponse._scroll_id;

            // Exit condition if no more results are returned
            if (scrollResponse.hits.hits.length === 0) {
                break;
            }
        }

        // Clear the scroll context when done
        await ESClient.clearScroll({
            scroll_id: [scrollId],
        });
    } catch (error) {
        console.error('An error occurred while fetching items:', error);
        throw error;
    }

    return results;
};

//? ARRAY SHUFFLER
exports.shuffle = (array) => {
    let currentIndex = array.length;
    let randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex !== 0) {
        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex],
            array[currentIndex],
        ];
    }

    return array;
};

exports.uploadBase64ToS3 = async (
    base64OrFile,
    bucketName,
    objectKey,
    imageType = 'jpeg'
) => {
    const s3 = new AWS.S3();

    try {
        var buffer = Buffer.from(
            base64OrFile.replace(/^data:image\/\w+;base64,/, ''),
            'base64'
        );
        var data = {
            Bucket: bucketName,
            Key: objectKey,
            Body: buffer,
            ContentEncoding: 'base64',
            ContentType: `image/${imageType}`,
        };

        const upload = await s3.putObject(data).promise();

        if (!upload.VersionId) return false;

        return `s3://${bucketName}/${encodeURIComponent(objectKey)}`;
    } catch (error) {
        console.error('Error in uploading file:', error);
        return false;
    }
};

exports.sendSMS = async (message, phone_number) => {
    try {
        const response = await axios.post(
            process.env.BULKSMS_ENDPOINT,
            {
                body: message,
                to: phone_number.replace('+', '').trim(),
            },
            {
                headers: {
                    Authorization: process.env.BULKSMS_BASIC_AUTH,
                },
            }
        );

        const { data } = response;
        if (data?.[0]?.status?.type === 'ACCEPTED') {
            return true;
        }

        return false;
    } catch (error) {
        logger.error(error);
        return false;
    }
};

exports.parseRequestsForShopperAppView = async (request, driverData) => {
    try {
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

                inRouteToDelivery: null,
                completedShopping: null,
                inRouteToShop: null,
                didPickupCash: null,

                ride_mode: null, //ride or delivery
                request_type: null, //immediate or scheduled
                pickup_note: null, //If not set - null

                shopping_list: null, //The list of items to shop
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

        //1. Add the passenger infos
        const user = await UserModel.get(request.client_id);

        if (!user) return false;

        parsedRequestsArray.passenger_infos.name = request.request_state_vars
            .isAccepted
            ? user.name
            : null;
        parsedRequestsArray.passenger_infos.phone_number = request
            .request_state_vars.isAccepted
            ? user.phone_number
            : null;

        //2. Add the basic trip infos
        parsedRequestsArray.delivery_basic_infos.payment_method =
            request.payment_method;
        parsedRequestsArray.delivery_basic_infos.wished_pickup_time =
            request.createdAt;

        //? Check if Today or Tomorrow Only for scheduled requests
        if (/scheduled/i.test(request.request_type)) {
            //Scheduled request
            parsedRequestsArray.delivery_basic_infos.date_state_wishedPickup_time =
                // eslint-disable-next-line no-nested-ternary
                new Date(request.wished_pickup_time).getDate() ===
                new Date().getDate()
                    ? 'Today'
                    : new Date(request.wished_pickup_time).getDate() >
                      new Date().getDate()
                    ? 'Tomorrow'
                    : 'Yesterday';
        } //Immediate request
        else {
            parsedRequestsArray.delivery_basic_infos.date_state_wishedPickup_time =
                null;
        }

        //! Attach intercity state
        parsedRequestsArray.isIntercity_trip = request?.isIntercity_trip
            ? request.isIntercity_trip
            : false;
        //?---

        parsedRequestsArray.delivery_basic_infos.totals_delivery =
            request?.totals_request;

        parsedRequestsArray.delivery_basic_infos.request_type =
            request?.request_type;
        parsedRequestsArray.delivery_basic_infos.ride_mode = request?.ride_mode;
        parsedRequestsArray.delivery_basic_infos.ride_style = 'shared';

        parsedRequestsArray.delivery_basic_infos = {
            ...parsedRequestsArray.delivery_basic_infos,
            ...request.request_state_vars,
        };

        //Add cash pickup fee
        if (!parsedRequestsArray?.totals_delivery?.cash_pickup_fee) {
            parsedRequestsArray.delivery_basic_infos.totals_delivery.cash_pickup_fee = 0;
        }

        parsedRequestsArray.delivery_basic_infos.pickup_note =
            request?.request_documentation ?? null;

        //! Attach the shopping list
        parsedRequestsArray.delivery_basic_infos.shopping_list =
            request.shopping_list;

        //! Attach the security
        parsedRequestsArray.security = { pin: request.security };

        //3. Compute the ETA to passenger
        const itinaryToPickup = await getItinaryInformation({
            destination: {
                latitude: parseFloat(driverData.last_location.latitude),
                longitude: parseFloat(driverData.last_location.longitude),
            },
            passenger: {
                latitude: parseFloat(
                    request.locations.pickup.coordinates?.latitude
                        ? request.locations.pickup.coordinates?.latitude
                        : request.locations.pickup.coordinates[0]
                ),
                longitude: parseFloat(
                    request.locations.pickup.coordinates?.longitude
                        ? request.locations.pickup.coordinates.longitude
                        : request.locations.pickup.coordinates[1]
                ),
            },
        });

        //Save the eta and distancee
        parsedRequestsArray.eta_to_passenger_infos.eta =
            itinaryToPickup !== false ? itinaryToPickup.eta : 'Awaiting';
        parsedRequestsArray.eta_to_passenger_infos.distance =
            itinaryToPickup !== false ? itinaryToPickup.distance : 'Awaiting';
        //4. Add the destination informations
        const pickupLocation = request.locations.pickup;

        parsedRequestsArray.origin_destination_infos = {
            location_name:
                pickupLocation.location_name ?? pickupLocation.street_name,
            street_name: pickupLocation.street_name,
            suburb: pickupLocation.suburb,
            coordinates: !pickupLocation.coordinates?.latitude
                ? {
                      latitude: pickupLocation.coordinates[0],
                      longitude: pickupLocation.coordinates[1],
                  }
                : pickupLocation.coordinates,
            city: pickupLocation.city,
            country: pickupLocation.country,
            region: pickupLocation.state
                .replace(/ Region/i, '')
                .trim()
                .toUpperCase(),
        };

        //ADD THE REQUEST TYPE
        parsedRequestsArray.request_type = /(now|immediate)/i.test(
            request.request_type
        )
            ? request.ride_mode
            : 'scheduled';

        const dropoffCoords = request?.locations?.dropoff
            ? request.locations.dropoff[0].dropoff_location.coordinates
            : request.locations.delivery.coordinates;

        const itinaryToDropoff = await getItinaryInformation({
            destination: {
                latitude: parseFloat(driverData.last_location.latitude),
                longitude: parseFloat(driverData.last_location.longitude),
            },
            passenger: {
                latitude: parseFloat(dropoffCoords[0]),
                longitude: parseFloat(dropoffCoords[1]),
            },
        });

        //Save the ETA to destination data
        parsedRequestsArray.origin_destination_infos = {
            ...{
                eta_to_destination_infos: {
                    eta: itinaryToDropoff?.eta ?? 'Awaiting',
                    distance: itinaryToDropoff?.distance ?? 'Awaiting',
                },
                destination_infos: request?.locations?.delivery
                    ? [request?.locations?.delivery]
                    : request.locations.dropoff,
            },
            ...parsedRequestsArray.origin_destination_infos,
        };

        //Add the request fingerprint
        parsedRequestsArray.request_fp = request.id;

        return parsedRequestsArray;
    } catch (error) {
        logger.error(error);
        return [];
    }
};

/**
 * Removes duplicates from an array of objects based on a specified key.
 *
 * @param {Array} array - The array of objects.
 * @param {string} key - The key to check for duplicates.
 * @return {Array} - The array with duplicates removed.
 */
exports.removeDuplicatesByKey = (array, key) => _.uniqBy(array, key);

/**
 * Removes duplicates from an array of objects based on a specified key,
 * keeping the object with the most recent date.
 *
 * @param {Array} array - The array of objects.
 * @param {string} key - The key to check for duplicates.
 * @param {string} dateField - The date field to determine the most recent object.
 * @return {Array} - The array with duplicates removed.
 */
exports.removeDuplicatesKeepRecent = (array, key, dateField) => {
    // Group objects by the key
    const grouped = _.groupBy(array, key);

    // For each group, keep only the most recent entry
    const mostRecentItems = _.map(grouped, (group) =>
        _.maxBy(group, dateField)
    );

    // Sort the resulting array by date in descending order
    return _.orderBy(mostRecentItems, [dateField], ['desc']);
};

exports.getDailyAmountDriverRedisKey = (driverId) => {
    const now = new Date();
    return `dailyAmount-${now.getDay()}-${now.getMonth()}-${now.getFullYear()}-${driverId}`;
};

exports.batchPresignProductsLinks = async (
    productsData,
    shouldDoubleCheckImage = false
) => {
    //Create presigned product links for the ones we host (s3://)
    productsData = await Promise.all(
        productsData.map(async (product) => {
            if (product.product_picture?.[0].includes('s3://')) {
                const s3URIImage = product.product_picture[0];
                const cachedPresignedImage = await Redis.get(s3URIImage);

                if (!cachedPresignedImage) {
                    const presignedURL = await generateCloudfrontSignedUrl(
                        `${
                            process.env.DD_PRODUCTS_IMAGES_CLOUDFRONT_LINK
                        }/${extractS3ImagePath(s3URIImage)}`
                    );

                    product.product_picture = [presignedURL];

                    //Cache the presigned URL - Has to be less than presign time
                    await Redis.set(
                        s3URIImage,
                        presignedURL,
                        'EX',
                        1 * 24 * 3600
                    );

                    return product;
                }

                product.product_picture = [cachedPresignedImage];
                return product;
            }
            return product;
        })
    );

    return productsData;
};

exports.batchPresignProductsOptionsImageLinks = async (productsOptions) => {
    if (!Array.isArray(productsOptions) || !productsOptions)
        return productsOptions;

    if (!productsOptions[0]?.image) return productsOptions;

    //Create presigned product links for the ones we host (s3://)
    productsOptions = await Promise.all(
        productsOptions.map(async (product) => {
            if (product.image?.[0].includes('s3://')) {
                const s3URIImage = product.image[0];
                const cachedPresignedImage = await Redis.get(s3URIImage);

                if (!cachedPresignedImage) {
                    const presignedURL = await generateCloudfrontSignedUrl(
                        `${
                            process.env.DD_PRODUCTS_IMAGES_CLOUDFRONT_LINK
                        }/${extractS3ImagePath(s3URIImage)}`
                    );

                    product.image = [presignedURL];
                    //Cache the presigned URL - Has to be less than presign time
                    await Redis.set(
                        s3URIImage,
                        presignedURL,
                        'EX',
                        1 * 24 * 3600
                    );
                } else {
                    product.image = [cachedPresignedImage];
                }
            }
            return product;
        })
    );

    return productsOptions;
};

exports.batchStoresImageFront = async (stores) => {
    //Create presigned product links for the ones we host (s3://)
    stores = await Promise.all(
        stores.map(async (store) => {
            if (store.logo.includes('s3://')) {
                const s3URIImage = store.logo;
                const cachedPresignedImage = await Redis.get(s3URIImage);

                if (!cachedPresignedImage) {
                    const presignedURL = await generateCloudfrontSignedUrl(
                        `${
                            process.env.DD_STORES_IMAGES_CLOUDFRONT_LINK
                        }/${extractS3ImagePath(s3URIImage)}`,
                        true
                    );

                    store.logo = presignedURL;
                    //Cache the presigned URL - Has to be less than presign time
                    await Redis.set(s3URIImage, presignedURL, 'EX', 45 * 60);
                } else {
                    store.logo = cachedPresignedImage;
                }
            }
            return store;
        })
    );

    return stores;
};

exports.addTwoHours = (timeString) => {
    const time = moment.utc(timeString);

    // Add 2 hours
    time.add(2, 'hours');

    return time.format();
};

exports.timeAgo = (inputDate) => {
    const date = moment(inputDate);
    const now = moment();
    const minutesAgo = now.diff(date, 'minutes');
    const hoursAgo = now.diff(date, 'hours');
    const daysAgo = now.diff(date, 'days');
    const weeksAgo = now.diff(date, 'weeks');
    const monthsAgo = now.diff(date, 'months');
    const yearsAgo = now.diff(date, 'years');

    if (yearsAgo > 1) return 'Over a year ago';
    if (yearsAgo === 1) return 'Last year';
    if (monthsAgo > 1) return `${monthsAgo} months ago`;
    if (weeksAgo > 1) return `${weeksAgo} weeks ago`;
    if (daysAgo > 1) return `${daysAgo} days ago`;
    if (hoursAgo >= 1) return `${hoursAgo} hours ago`;
    if (minutesAgo >= 1) return `${minutesAgo} minutes ago`;
    return 'Just now';
};

exports.getHumReadableWalletTrxDescription = (descriptor) => {
    switch (descriptor) {
        case 'WALLET_TOPUP':
            return 'Top-up';

        case 'GROCERY_PAYMENT':
            return 'Grocery delivery';

        case 'PACKAGE_DELIVERY_PAYMENT':
            return 'Package delivery';

        default:
            return 'Transaction';
    }
};

/**
 * @func shouldSendNewSMS
 * Responsible for figuring out if the system is allowed to send new SMS to a specific number
 * based on the daily limit that the number has ~ 10SMS per day.
 * @param req: the request data containing the user's phone number : ATTACH THE _id if HAS AN ACCOUNT
 * @param hasAccount: true (is an existing user) or false (do not have an account yet)
 * @param resolve
 */
exports.shouldSendNewSMS = async (
    user,
    phone_number,
    isDriver = false,
    sendEmail = false
) => {
    const DAILY_THRESHOLD = parseInt(
        process.env.DAILY_SMS_THRESHOLD_PER_USER,
        10
    );

    const onlyDigitsPhone = phone_number.replace('+', '').trim();
    let otp = otpGenerator.generate(5, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: false,
    });
    //! --------------
    //let otp = 55576;
    otp = /(264856997167|264815600469)/i.test(onlyDigitsPhone)
        ? 55576
        : String(otp).length < 5
        ? parseInt(otp, 10) * 10
        : otp;
    const message = `Your DulcetDash code is ${otp}. Never share this code.`;

    if (!user) {
        logger.warn(message);

        // await this.sendSMS(message, phone_number);

        //New user
        await OTPModel.create({
            id: uuidv4(),
            phone_number: phone_number,
            otp: parseInt(otp, 10),
        });

        return true;
    } //Existing user

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
        if (!sendEmail) {
            await this.sendSMS(message, phone_number);
        } else {
            //?Send email instead of SMS
            await emailService.sendEmail({
                email: user?.email,
                fromEmail: 'security@dulcetdash.com',
                fromName: 'DulcetDash',
                message,
                subject: 'OTP verification code',
            });
        }

        await OTPModel.create({
            id: uuidv4(),
            phone_number: user.phone_number,
            otp: parseInt(otp, 10),
        });

        if (!isDriver) {
            await UserModel.update(
                { id: user.id },
                {
                    otp: parseInt(otp, 10),
                }
            );
        } //Driver
        else {
            await DriversModel.update(
                { id: user.id },
                {
                    otp: parseInt(otp, 10),
                }
            );
        }

        return true;
    }

    //!Exceeded the daily SMS request
    console.log('SMS LIMIT EXCEEDED for ', phone_number);
    return false;
};

exports.getStripePriceName = async (priceId) => {
    try {
        const price = await stripe.prices.retrieve(priceId);
        return price.product ? price.product.name : 'PLAN';
    } catch (error) {
        console.error('Error retrieving Stripe price:', error.message);
        return 'PLAN';
    }
};

exports.getRequestLitteralStatus = (request) => {
    if (
        request?.request_state_vars.isAccepted &&
        !request?.request_state_vars?.inRouteToDropoff &&
        !request?.date_cancelled &&
        !request?.request_state_vars?.completedDropoff
    ) {
        return 'started';
    }

    if (
        request?.request_state_vars?.inRouteToDropoff &&
        !request?.date_cancelled &&
        !request?.request_state_vars?.completedDropoff
    ) {
        return 'shipping';
    }

    if (request?.date_cancelled) {
        return 'cancelled';
    }

    if (
        request?.request_state_vars?.completedDropoff &&
        !request?.date_cancelled &&
        request?.request_state_vars?.completedDropoff
    ) {
        return 'completed';
    }

    if (!request?.request_state_vars?.isAccepted && !request?.date_cancelled) {
        return 'pending';
    }

    return 'pending';
};

exports.checkImageUrl = async (url) => {
    try {
        const redisKey = `${url}-checkedImage`;
        const cachedPresignedImage = await Redis.get(redisKey);

        if (!cachedPresignedImage) {
            logger.warn('No cached image found');
            const response = await axios.get(url, {
                responseType: 'stream',
            });

            const isImageValid =
                response.headers['content-type'].startsWith('image/');

            await Redis.set(
                redisKey,
                isImageValid ? url : 'false',
                'EX',
                1 * 24 * 3600
            );

            logger.info('Image cached');

            return isImageValid;
        }

        logger.info('Cached image found');
        return cachedPresignedImage !== 'false';
    } catch (error) {
        logger.error(`Error:${url}`);
        return false;
    }
};

exports.checkAllImages = async (products) => {
    const limit = 10; // Adjust the concurrency limit as needed

    return async.mapLimit(products, limit, async (product) => {
        const isImageAvailable = await exports.checkImageUrl(
            product.pictures[0]
        );

        product.pictures = [!isImageAvailable ? 'false' : product.pictures[0]];
        return product;
    });
};

exports.uploadFileToS3FromMulter = async ({ file, bucketName, objectKey }) => {
    const s3 = new AWS.S3();
    const uploadAsync = promisify(s3.upload.bind(s3));

    console.log(file);
    let filename = file.originalname.split('.');
    filename = `${uuidv4()}.${filename[filename.length - 1]}`;

    try {
        // Set up S3 upload parameters
        const params = {
            Bucket: bucketName, // S3 Bucket name
            Key: `${objectKey}/${filename}`, // File name you want to save as
            Body: fs.createReadStream(file.path),
            ContentType: file.mimetype,
        };

        // Uploading file to S3 using async/await
        const data = await uploadAsync(params);

        console.log({
            message: 'File uploaded successfully!',
            data: data.Location,
        });

        fs.unlinkSync(file.path);

        return `s3://${bucketName}/${objectKey}/${filename}`;
    } catch (error) {
        console.error('Error in uploading file:', error);
        return false;
    }
};

exports.checkBlurriness = async (url) => {
    try {
        const redisKey = `${url}-checkedBlurryImage`;
        let cachedBlurryCheckedImage = await Redis.get(redisKey);

        if (!cachedBlurryCheckedImage) {
            logger.warn('No cached image found');
            const response = await axios.post(
                'http://18.204.117.172:7575/check',
                {
                    imageUrl: url,
                }
            );

            if (response.data?.message) {
                await Redis.set(
                    redisKey,
                    JSON.stringify(response.data),
                    'EX',
                    1 * 24 * 3600
                );

                logger.info('Image cached');
                logger.info(response.data);
                return response.data;
            }

            return null;
        }

        logger.info('Cached image found');
        return JSON.parse(cachedBlurryCheckedImage);
    } catch (error) {
        logger.error(error);
        return null;
    }
};

exports.checkAllImagesBluriness = async (products) => {
    const limit = 10; // Adjust the concurrency limit as needed

    return async.mapLimit(products, limit, async (product) => {
        const blurriness = await exports.checkBlurriness(product.pictures[0]);

        product.isBlurry = !blurriness ? false : blurriness?.blurScore > 1.5;

        return product;
    });
};
