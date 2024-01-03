const dynamoose = require('dynamoose');

const ImageRepositorySchema = new dynamoose.Schema(
    {
        id: {
            type: String,
            hashKey: true,
        },
        originalImageUrl: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'originalImageurl-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        productId: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'productId-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        storeId: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'storeId-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        active: Boolean,
        s3Uri: {
            type: String,
            required: true,
        },
    },
    {
        timestamps: true,
        saveUnknown: false,
    }
);

module.exports = dynamoose.model('ImageRepository', ImageRepositorySchema, {
    throughput: 'ON_DEMAND',
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
});
