const dynamoose = require('dynamoose');

const subscriptionsSchema = new dynamoose.Schema(
    {
        id: {
            type: String,
            hashKey: true,
        },
        user_id: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'user_id-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        amount: {
            type: Number,
            required: true,
        },
        currency: String,
        stripe_subscription_id: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'stripe_subscription_id-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        transaction_description: {
            type: String,
            // enum: ['STARTER', 'INTERMEDIATE', 'PRO', 'PERSONALIZED'],
        },
        expiration_date: {
            type: Date,
            required: true,
        },
        active: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
        saveUnknown: false,
    }
);

module.exports = dynamoose.model('Subscriptions', subscriptionsSchema, {
    throughput: 'ON_DEMAND',
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
});
