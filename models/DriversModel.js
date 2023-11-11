const dynamoose = require('dynamoose');

const driverSchema = new dynamoose.Schema(
    {
        id: {
            type: String,
            hashKey: true,
        },
        status: {
            type: String,
            enum: ['online', 'offline'],
            default: 'offline',
        },
        operation_clearances: {
            type: Array,
            schema: [String],
            validate: (array) =>
                array.every((item) => ['DELIVERY'].includes(item)),
        },
        regional_clearances: {
            type: Array,
            schema: [String],
            validate: (array) =>
                array.every((item) => ['WINDHOEK'].includes(item)),
        },
        name: String,
        surname: String,
        gender: {
            type: String,
            enum: ['male', 'female', 'unknown'],
            default: 'unknown',
        },
        account_state: {
            type: String,
            enum: [
                'valid',
                'suspended',
                'blocked',
                'deactivated',
                'expelled',
                'online',
                'offline',
            ],
            default: 'valid',
        },
        profile_picture: String,
        rating: {
            type: Number,
            default: 5,
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
        email: String,
        identification_number: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'identificationno-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        driving_license_number: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'licensenumber-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        date_of_birth: {
            type: String,
            required: true,
        },
        car_picture: String,
        car_brand: String,
        plate_number: String,
        car_vin: String,
        pushnotif_token: Object,
        suspension_message: String,
        isDriverSuspended: {
            type: Boolean,
            default: false,
        },
        otp: {
            type: Number,
        },
        last_location: {
            type: Object,
            schema: {
                latitude: Number,
                longitude: Number,
            },
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
    },
    {
        timestamps: true,
        saveUnknown: false,
    }
);

module.exports = dynamoose.model('Drivers', driverSchema, {
    throughput: 'ON_DEMAND',
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
});
