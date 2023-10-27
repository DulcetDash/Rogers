const dynamoose = require("dynamoose");

const enrichedLocationPersistSchema = new dynamoose.Schema(
  {
    id: {
      type: String,
      hashKey: true,
    },
    place_id: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "placeid-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    indexSearch: Number,
    location_id: String,
    location_name: String,
    coordinates: {
      type: Array,
      schema: [Number],
    },
    averageGeo: {
      type: Number,
      default: 0,
    },
    city: String,
    street: String,
    suburb: String,
    state: String,
    country: String,
    query: String,
  },
  {
    timestamps: true,
    saveUnknown: true,
  }
);

module.exports = dynamoose.model(
  "EnrichedLocationPersist",
  enrichedLocationPersistSchema,
  {
    throughput: "ON_DEMAND",
    update: false,
    waitForActive: true,
    initialize: true,
    create: true,
  }
);
