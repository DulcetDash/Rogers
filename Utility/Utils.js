require('dotenv').config();

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { ESClient } = require('./ESClient');
const AWS = require('aws-sdk');
const { default: axios } = require('axios');
const UserModel = require('../models/UserModel');
const { getItinaryInformation } = require('./Maps/Utils');
const { logger } = require('../LogService');

// Configure AWS with your access and secret key.
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: 'us-east-1',
});

dayjs.extend(utc);
dayjs.extend(timezone);

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

exports.storeTimeStatus = (opening_time, closing_time) => {
    // Ensure Day.js has the required plugin
    const now = dayjs().tz('Africa/Windhoek');

    const open = extractTime(opening_time);
    const close = extractTime(closing_time);

    if (!open || !close) return;

    let openingDateTime = now.hour(open.hour).minute(open.minute);
    let closingDateTime = now.hour(close.hour).minute(close.minute);

    if (closingDateTime.isBefore(openingDateTime)) {
        closingDateTime = closingDateTime.add(1, 'day');
    }

    const nowMinusTwoHours = now.subtract(2, 'hour');

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

exports.searchProducts = async (index, criteria) => {
    const { category, subcategory, product_name, shop_fp } = criteria;

    let boolArray = [
        {
            fuzzy: {
                product_name: {
                    value: product_name,
                    fuzziness: '2', // This can be a number like 1, 2, or 'AUTO' to auto-determine fuzziness level
                    prefix_length: 0, // Optional: number of characters at the start of the term which will not be “fuzzified”
                    max_expansions: 50, // Optional: the maximum number of terms that the fuzzy query will expand to
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
            size: 2500,
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
        // throw error;
        return [];
    }
};

exports.getItemsByShop = async (index, shopFpValue) => {
    try {
        const response = await ESClient.search({
            size: 500,
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
    const s3 = new AWS.S3({
        region: 'us-west-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    });

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
