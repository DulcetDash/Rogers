const dynamoose = require("dynamoose");

const storeSchema = new dynamoose.Schema(
  {
    id: {
      type: String,
      hashKey: true,
    },
    publish: {
      type: Boolean,
      default: false,
    },
    name: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "name-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    friendly_name: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "friendlyname-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    shop_type: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "shoptype-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    description: String,
    shop_background_color: String,
    border_color: String,
    shop_logo: String,
    structured_shopping: {
      type: Boolean,
      default: false,
    },
    opening_time: String,
    closing_time: String,
  },
  {
    timestamps: true,
    saveUnknown: false,
  }
);

module.exports = dynamoose.model("Stores", storeSchema, {
  throughput: "ON_DEMAND",
  update: false,
  waitForActive: true,
  initialize: true,
  create: true,
});
