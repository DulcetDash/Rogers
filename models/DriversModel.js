const dynamoose = require('dynamoose');

const driverSchema = new dynamoose.Schema(
    {
        id: {
            type: String,
            hashKey: true,
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
            enum: ['valid', 'suspended', 'blocked', 'deactivated', 'expelled'],
            default: 'valid',
        },
        profile_picture: String,
        rating: {
            type: Number,
            default: 0,
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
            type: Date,
            required: true,
        },
        car_picture: String,
        car_brand: String,
        plate_number: String,
        car_vin: String,
        pushnotif_token: dynamoose.type.ANY,
        suspension_message: dynamoose.type.ANY,
        otp: {
            type: Number,
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
