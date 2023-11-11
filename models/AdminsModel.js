const dynamoose = require('dynamoose');

const adminsSchema = new dynamoose.Schema(
    {
        id: {
            type: String,
            hashKey: true,
        },
        corporate_email: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'corporateemail-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        name: String,
        surname: String,
        password: String,
        otp: Number,
        security_pin: Number,
        token_j: String,
        isSuspended: {
            type: Boolean,
            default: false,
        },
        sessionToken: {
            type: String,
            default: null,
            index: {
                global: true,
                name: 'session-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        lastTokenUpdate: {
            type: Date,
            default: Date.now(),
        },
    },
    {
        timestamps: true,
        saveUnknown: false,
    }
);

module.exports = dynamoose.model('Admins', adminsSchema, {
    throughput: 'ON_DEMAND',
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
});
