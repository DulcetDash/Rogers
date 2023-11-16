const AWS = require('aws-sdk');
const dynamoose = require('dynamoose');
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

exports.handler = async (event) => {
    try {
        console.log(event);

        let records = event.Records.map((record) => ({
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

                switch (record.eventName) {
                    case 'INSERT':
                        return ESClient.index({
                            index: process.env.ELASTIC_SEARCH_INDEX,
                            id: newRecord.id,
                            body: newRecord,
                        });
                    case 'MODIFY':
                        return ESClient.update({
                            index: process.env.ELASTIC_SEARCH_INDEX,
                            id: newRecord.id,
                            body: {
                                doc: newRecord,
                            },
                        });
                    case 'REMOVE':
                        return ESClient.delete({
                            index: process.env.ELASTIC_SEARCH_INDEX,
                            id: record.dynamodb.OldImage.id,
                        });
                    default:
                        return null;
                }
            })
        );
    } catch (error) {
        console.log(error);
    }
};
