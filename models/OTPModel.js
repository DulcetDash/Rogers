const dynamoose = require("dynamoose");

const otpSchema = new dynamoose.Schema(
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
        rangeKey: "id",
        name: "phonenumber-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    otp: {
      type: Number,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "otp-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    is_verified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    saveUnknown: false,
  }
);

module.exports = dynamoose.model("OTP", otpSchema, {
  throughput: "ON_DEMAND",
  update: false,
  waitForActive: true,
  initialize: true,
  create: true,
});
