const dynamoose = require("dynamoose");

const locationPersistSchema = new dynamoose.Schema(
  {
    id: {
      type: String,
      hashKey: true,
    },
    indexSearch: Number,
    location_id: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "locationid-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    location_name: String,
    coordinates: {
      type: Array,
      schema: [Number],
    },
    averageGeo: {
      type: Number,
      default: 0,
    },
    city: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "city-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    street: String,
    suburb: String,
    state: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "state-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    country: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "country-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    query: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "query-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
  },
  {
    timestamps: true,
    saveUnknown: false,
  }
);

module.exports = dynamoose.model("LocationPersist", locationPersistSchema, {
  throughput: "ON_DEMAND",
  update: false,
  waitForActive: true,
  initialize: true,
  create: true,
});
