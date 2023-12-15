const dynamoose = require('dynamoose');
const { Schema } = require('dynamoose/dist/Schema');

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
            default: 's3://dulcetdash-storage/users_profiles/male.png',
        },
        account_state: {
            type: String,
            default: 'half',
        }, //half (default), full, none
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
        selected_industry: String,
        company_name: String,
        account: {
            type: Object,
            schema: {
                registration_state: {
                    type: String,
                    default: 'notFull',
                }, //'notFull'
                confirmations: {
                    type: Object,
                    schema: {
                        isPhoneConfirmed: {
                            type: Boolean,
                            default: false,
                        },
                        isEmailConfirmed: {
                            type: Boolean,
                            default: false,
                        },
                        isIDConfirmed: {
                            type: Boolean,
                            default: false,
                        },
                    },
                },
            },
        },
        plans: {
            type: Object,
            schema: {
                isSubscribed_plan: {
                    type: Boolean,
                    default: false,
                },
                isPlan_active: {
                    type: Boolean,
                    default: false,
                },
            },
        },
        gender: {
            type: String,
            default: 'unknown',
        }, //unknown, male, female
        name: String,
        surname: String,
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
        password: String,
        stripe_customerId: {
            type: String,
            default: null,
            index: {
                global: true,
                name: 'stripecustomerid-index',
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

module.exports = dynamoose.model('Users', userSchema, {
    throughput: 'ON_DEMAND',
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
});
