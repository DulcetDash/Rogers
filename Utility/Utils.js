const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { ESClient } = require('./ESClient');
const AWS = require('aws-sdk');
const { default: axios } = require('axios');

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
            match_phrase_prefix: {
                product_name: {
                    query: product_name,
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

    if (category) {
        boolArray.push({
            match_phrase_prefix: {
                category: {
                    query: category,
                },
            },
        });
    }

    if (subcategory) {
        boolArray.push({
            match_phrase_prefix: {
                subcategory: {
                    query: subcategory,
                },
            },
        });
    }

    try {
        const response = await ESClient.search({
            size: 10000,
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
        throw error;
    }
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

        console.log(response.data);

        if (response.status === 200) return true;
        return false;
    } catch (error) {
        logger.error(error);
        return false;
    }
};
