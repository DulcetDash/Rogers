// eslint-disable-next-line import/no-extraneous-dependencies
const { getSignedUrl } = require('@aws-sdk/cloudfront-signer');

const AWS = require('aws-sdk');
const moment = require('moment');

const s3 = new AWS.S3({
    region: 'us-west-1',
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
});

/**
 * Extracts the bucket and key from an S3 URI.
 *
 * @param {string} uri The S3 URI, e.g., "s3://my-bucket/path/to/my-object.jpg".
 * @returns {Object} An object with the extracted bucket and key.
 */
function parseS3URI(uri) {
    const match = uri.match(/^s3:\/\/([^\/]+)\/(.+)$/);
    if (!match) {
        return null;
    }
    return {
        bucket: match[1],
        key: match[2],
    };
}

/**
 * Presigns an S3 URI to generate a publicly accessible URL.
 *
 * @param {string} uri The S3 URI.
 * @param {number} [expires=86400] The time in seconds until the signed URL expires. Defaults to 24 hours.
 * @returns {Promise<string>} The presigned URL.
 */
exports.presignS3URL = async (uri, expires = 86400) => {
    try {
        return new Promise((resolve, reject) => {
            const parsedURI = parseS3URI(uri);

            if (!parsedURI) resolve('null');

            const { bucket, key } = parsedURI;

            const params = {
                Bucket: bucket,
                Key: key,
                Expires: expires,
            };

            s3.getSignedUrl('getObject', params, (error, url) => {
                if (error) {
                    resolve('null');
                } else {
                    resolve(url);
                }
            });
        });
    } catch (error) {
        return 'null';
    }
};

exports.generateCloudfrontSignedUrl = async (imageUrl, forStore = false) => {
    try {
        //For catalogue images
        let keyPairId = process.env.DD_PRODUCTS_IMAGES_CLOUDFRONT_KEY_PAIR_ID;
        let privateKey = String(
            process.env.DD_CLOUDFRONT_CATALOGUE_IMAGE_PRIVATE_KEY
        )
            .replace('"', '')
            .replace('"', '')
            .replace(/\\n/g, '\n');
        let cloudfrontLink = process.env.DD_PRODUCTS_IMAGES_CLOUDFRONT_LINK;

        //For store front images
        if (forStore) {
            keyPairId = process.env.DD_STORES_IMAGES_CLOUDFRONT_KEY_PAIR_ID;
            privateKey = process.env.DD_STORES_IMAGES_PRIVATE_KEY.replace(
                /\\n/g,
                '\n'
            );
            cloudfrontLink = process.env.DD_STORES_IMAGES_CLOUDFRONT_LINK;
        }

        // Get the current time
        const now = moment.utc();
        const expiration = 24; // 24 hours

        // Calculate the expiration time (1 hour from now)
        const expirationTime = now.add(expiration, 'hours').unix(); // UNIX timestamp

        const policy = {
            Statement: [
                {
                    Resource: `${cloudfrontLink}/*`,
                    Condition: {
                        DateLessThan: {
                            'AWS:EpochTime': expirationTime,
                        },
                    },
                },
            ],
        };

        const options = {
            url: imageUrl,
            expires:
                Math.floor(new Date().getTime() / 1000) + 60 * 60 * expiration, // 1 hour validity
            privateKey,
            keyPairId,
            policy: JSON.stringify(policy),
        };

        // Generate the signed URL
        return getSignedUrl(options);
    } catch (error) {
        console.log(process.env.DD_CLOUDFRONT_CATALOGUE_IMAGE_PRIVATE_KEY);
        console.error('Error generating signed URL:', error);
        console.error(imageUrl);
        return imageUrl;
    }
};

exports.extractS3ImagePath = (s3Url) => {
    // Split the URL on '://'
    const parts = s3Url.split('://');

    // Check if the URL is in the expected format
    if (parts.length !== 2) {
        return s3Url;
    }

    // The image path is everything after 's3://'
    // This will remove the bucket name and return only the path
    const imagePath = parts[1].split('/').slice(1).join('/');

    return imagePath;
};
