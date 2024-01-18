/* eslint-disable import/no-absolute-path */
/* eslint-disable node/no-unpublished-require */
/* eslint-disable node/no-missing-require */
/* eslint-disable import/no-unresolved */
const AWS = require('aws-sdk');
const dynamoose = require('dynamoose');
// eslint-disable-next-line import/no-absolute-path
const CatalogueModel = require('/opt/models/CatalogueModel');
const StoreModel = require('/opt/models/StoreModel');
const Redis = require('/opt/Redis');
const ESClient = require('/opt/ES');
const {
    getCatalogueFor,
    checkAllImages,
    checkAllImagesBluriness,
} = require('/opt/Utils');

const ddb = new dynamoose.aws.ddb.DynamoDB({
    credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
    },
    region: process.env.REGION,
});

// Set DynamoDB instance to the Dynamoose DDB instance
dynamoose.aws.ddb.set(ddb);

exports.handler = async (event) => {
    try {
        //1. Get all the stores
        const stores = await StoreModel.scan().all().exec();

        //2. Get all the products
        const products = (
            await Promise.all(
                stores.map(async (store) =>
                    getCatalogueFor({
                        store: store?.id,
                        customPageSize: 150000,
                    })
                )
            )
        )?.response;

        //3. Check pictureless images
        const pictureless = await checkAllImages(products);
        console.log(pictureless);

        const blurriness = await checkAllImagesBluriness(products);
        console.log(blurriness);

        return { status: 'ok' };
    } catch (error) {
        console.log(error);
        return null;
    }
};
