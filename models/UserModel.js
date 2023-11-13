const dynamoose = require('dynamoose');

const userSchema = new dynamoose.Schema(
    {
        id: {
            type: String,
            hashKey: true,
        },
        phone_number: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'phonenumber-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        otp: {
            type: Number,
        },
        profile_picture: {
            type: String,
            default: 'user.png',
        },
        account_state: {
            type: String,
            default: 'half',
        }, //half (default), full, none
        email: String,
        gender: {
            type: String,
            default: 'unknown',
        }, //unknown, male, female
        name: String,
        surname: String,
        password: String,
        is_policies_accepted: {
            type: Boolean,
            default: false,
        },
        is_accountVerified: {
            type: Boolean,
            default: false,
        },
        pushnotif_token: {
            type: Object,
            default: {},
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
        //Only updates on login/signup once
        permaToken: {
            type: String,
            default: null,
            index: {
                global: true,
                name: 'permatoken-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        oneSignalUserId: String,
    },
    {
        timestamps: true,
        saveUnknown: false,
    }
);

module.exports = dynamoose.model('Users', userSchema, {
    throughput: 'ON_DEMAND',
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
});
