const AWS = require("aws-sdk");

const s3 = new AWS.S3({
  region: "us-west-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
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
    throw new Error("Invalid S3 URI");
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
 * @param {number} [expires=7200] The time in seconds until the signed URL expires. Defaults to 2 hours.
 * @returns {Promise<string>} The presigned URL.
 */
exports.presignS3URL = async (uri, expires = 7200) => {
  return new Promise((resolve, reject) => {
    const { bucket, key } = parseS3URI(uri);

    const params = {
      Bucket: bucket,
      Key: key,
      Expires: expires,
    };

    s3.getSignedUrl("getObject", params, (error, url) => {
      if (error) {
        reject(error);
      } else {
        resolve(url);
      }
    });
  });
};
