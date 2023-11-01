const dynamoose = require('dynamoose');

const driversApplicationsSchema = new dynamoose.Schema(
    {
        id: {
            type: String,
            hashKey: true,
        },
        nature_driver: String,
        city: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'city-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
        },
        name: String,
        surname: String,
        email: {
            type: String,
            required: true,
            index: {
                global: true,
                rangeKey: 'id',
                name: 'email-index',
                project: true,
                throughput: 'ON_DEMAND',
            },
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
        vehicle_details: dynamoose.type.ANY,
        documents: {
            type: Object,
            schema: {
                driver_photo: String,
                vehicle_photo: String,
                license_photo: String,
                id_photo: String,
            },
        },
        accepted_conditions_details: {
            type: Object,
            schema: {
                did_accept_terms: Boolean,
                did_certify_data_veracity: Boolean,
            },
        },
    },
    {
        timestamps: true,
        saveUnknown: false,
    }
);

module.exports = dynamoose.model(
    'DriversApplications',
    driversApplicationsSchema,
    {
        throughput: 'ON_DEMAND',
        update: false,
        waitForActive: true,
        initialize: true,
        create: true,
    }
);
