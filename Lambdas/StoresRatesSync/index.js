/* eslint-disable import/no-absolute-path */
/* eslint-disable node/no-unpublished-require */
/* eslint-disable node/no-missing-require */
/* eslint-disable import/no-unresolved */
const AWS = require('aws-sdk');
const dynamoose = require('dynamoose');
// eslint-disable-next-line import/no-absolute-path
const CatalogueModel = require('/opt/models/CatalogueModel');
const Redis = require('/opt/Redis');
const { deleteKeysWithSuffix } = require('/opt/Utils');

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
        console.log(event);

        const records = event.Records.map((record) => ({
            ...record,
            dynamodb: {
                NewImage: AWS.DynamoDB.Converter.unmarshall(
                    record.dynamodb.NewImage
                ),
                OldImage: AWS.DynamoDB.Converter.unmarshall(
                    record.dynamodb.OldImage
                ),
            },
        }));

        await Promise.all(
            records.map(async (record) => {
                const newRecord = record.dynamodb.NewImage;

                if (
                    record.eventName === 'INSERT' ||
                    record.eventName === 'MODIFY'
                ) {
                    const storeFp = newRecord.id;
                    const storeRate = newRecord.percentage;

                    //Get all the catalogue for the store
                    const products = await CatalogueModel.query('shop_fp')
                        .eq(storeFp)
                        .all()
                        .exec();

                    await Promise.all(
                        products.map(async (product) => {
                            const productPrice = product.product_price;
                            const priceAdjusted = parseFloat(
                                (
                                    parseFloat(productPrice) +
                                    (parseFloat(productPrice) * storeRate) / 100
                                ).toFixed(2)
                            );

                            console.log(
                                `[${product.id}] Price adjusted from ${productPrice} to ${priceAdjusted}`
                            );

                            return CatalogueModel.update(
                                {
                                    id: product.id,
                                },
                                {
                                    priceAdjusted: priceAdjusted,
                                }
                            );
                        })
                    );

                    return true;
                } else {
                    return null;
                }
            })
        );

        await Promise(
            records.map(async (record) => {
                const newRecord = record.dynamodb.NewImage;
                //Clear the cache
                await Redis.del(`${newRecord.id}-catalogue`);
                await deleteKeysWithSuffix(Redis, `-searchedProduct`);
            })
        );

        return true;
    } catch (error) {
        console.log(error);
        return null;
    }
};
