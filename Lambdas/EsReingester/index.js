/* eslint-disable import/no-absolute-path */
/* eslint-disable node/no-unpublished-require */
/* eslint-disable node/no-missing-require */
/* eslint-disable import/no-unresolved */
const AWS = require('aws-sdk');
const dynamoose = require('dynamoose');
// eslint-disable-next-line import/no-absolute-path
const CatalogueModel = require('/opt/models/CatalogueModel');
const Redis = require('/opt/Redis');
const ESClient = require('/opt/ES');

const ddb = new dynamoose.aws.ddb.DynamoDB({
    credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
    },
    region: process.env.REGION,
});

// Set DynamoDB instance to the Dynamoose DDB instance
dynamoose.aws.ddb.set(ddb);

const bulkIndex = async (records) => {
    const batchSize = 100; // Adjust the batch size as needed
    for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const body = batch.flatMap((doc) => [
            {
                index: {
                    _index: process.env.ELASTIC_SEARCH_INDEX,
                    _id: doc.id,
                },
            },
            doc,
        ]);

        console.log(`Indexing batch ${i / batchSize + 1}`);
        // eslint-disable-next-line no-await-in-loop
        const bulkResponse = await ESClient.bulk({
            refresh: true,
            body,
        });

        console.log(bulkResponse);

        if (bulkResponse.errors) {
            const erroredDocuments = [];
            bulkResponse.items.forEach((action, i) => {
                const operation = Object.keys(action)[0];
                if (action[operation].error) {
                    erroredDocuments.push({
                        status: action[operation].status,
                        error: action[operation].error,
                        operation: body[i * 2],
                        document: body[i * 2 + 1],
                    });
                }
            });
            console.log('Errors occurred:', erroredDocuments);
        }

        const indexedDocumentsCount = bulkResponse.items.length;
        console.log(`Indexed ${indexedDocumentsCount} documents`);
    }
};

exports.handler = async (event) => {
    try {
        //1. Reingest all data in elastic
        console.log('Getting all products from DynamoDB');
        const products = await CatalogueModel.scan().all().exec();
        console.log('Products count:', products.length);

        //2. Delete all data in elastic
        console.log('Deleting all products from ElasticSearch');
        await ESClient.deleteByQuery({
            index: process.env.ELASTIC_SEARCH_INDEX,
            body: {
                query: {
                    match_all: {},
                },
            },
            refresh: true,
        });

        //3. Reindex all data in elastic
        console.log('Reindexing all products in ElasticSearch');
        await bulkIndex(products);

        return await Redis.flushall();
    } catch (error) {
        console.log(error);
        return null;
    }
};
