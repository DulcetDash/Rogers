const dynamoose = require('dynamoose');

const paymentsSchema = new dynamoose.Schema(
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
        stripe_payment_id: String,
        subscription_id: String,
        amount: {
            type: Number,
            required: true,
        },
        currency: String,
        transaction_description: {
            type: String,
            enum: [
                'GROCERY_PAYMENT',
                'PACKAGE_DELIVERY_PAYMENT',
                'WALLET_TOPUP',
                'CORPORATE_SUBSCRIPTION',
                'SIGNUP_CREDITS',
            ],
        },
        success: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
        saveUnknown: false,
    }
);

module.exports = dynamoose.model('Payments', paymentsSchema, {
    throughput: 'ON_DEMAND',
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
});
