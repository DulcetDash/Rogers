const dynamoose = require("dynamoose");

const driverSchema = new dynamoose.Schema(
  {
    id: {
      type: String,
      hashKey: true,
    },
    profile_picture: String,
    rating: {
      type: Number,
      default: 0,
    },
    phone_number: String,
    car_picture: String,
    car_brand: String,
    plate_number: String,
    car_vin: String,
  },
  {
    timestamps: true,
    saveUnknown: false,
  }
);

module.exports = dynamoose.model("Drivers", driverSchema, {
  throughput: "ON_DEMAND",
  update: false,
  waitForActive: true,
  initialize: true,
  create: true,
});
