const dynamoose = require("dynamoose");

const requestSchema = new dynamoose.Schema(
  {
    id: {
      type: String,
      hashKey: true,
    },
    client_id: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "clientid-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    shopper_id: {
      type: String,
      default: "false",
      index: {
        global: true,
        rangeKey: "id",
        name: "shopperid-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    shopping_list: {
      type: Array,
      default: [],
    },
    payment_method: {
      type: String,
      enum: ["mobile_money", "cash"],
      required: true,
    },
    locations: {
      type: Object,
      schema: {
        pickup: dynamoose.type.ANY,
        dropoff: dynamoose.type.ANY,
      },
    },
    totals_request: {
      type: Object,
      required: true,
      schema: {
        delivery_fee: { type: Number, default: 0 },
        shopping_fee: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
      },
    },
    request_type: {
      type: String,
      enum: ["scheduled", "immediate"],
      default: "immediate",
      index: {
        global: true,
        rangeKey: "id",
        name: "requesttype-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    request_documentation: String,
    ride_mode: {
      type: String,
      enum: ["RIDE", "DELIVERY", "SHOPPING"],
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "ridemode-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    request_state_vars: {
      type: Object,
      default: {
        isAccepted: false,
        inRouteToPickupCash: false,
        didPickupCash: false,
        inRouteToDropoff: false,
        completedDropoff: false,
        completedRatingClient: false,
        //Shopping
        inRouteToShop: false,
        inRouteToDelivery: false,
        completedShopping: false,
        //...
        rating_data: {
          rating: null,
          comments: null,
          compliments: [],
        },
      },
      schema: {
        isAccepted: { type: Boolean, default: false },
        inRouteToPickupCash: { type: Boolean, default: false },
        didPickupCash: { type: Boolean, default: false },

        //For delivery
        inRouteToDropoff: { type: Boolean, default: false },
        completedDropoff: { type: Boolean, default: false },

        //For Shopping
        inRouteToShop: { type: Boolean, default: false }, //If the shopper is in route to the shop(s)
        inRouteToDelivery: { type: Boolean, default: false }, //If the shopper is on his(her) way to delivery the shopped items
        completedShopping: { type: Boolean, default: false }, //If the shopper is done shopping

        //Generic
        completedRatingClient: { type: Boolean, default: false },
        rating_data: {
          type: Object,
          default: {},
          schema: {
            rating: { type: Number, default: null },
            comments: { type: String, default: null },
            compliments: {
              type: Array,
              schema: [String],
            },
          },
        },
      },
    },
    security: String,
    date_pickedup: { type: Date, default: null },
    date_routeToDropoff: { type: Date, default: null },
    date_completedDropoff: { type: Date, default: null },
    date_clientRatedRide: { type: Date, default: null },
    date_cancelled: { type: Date, default: null },
    //....Shopping
    date_routeToShop: { type: Date, default: null }, //The time when the shopper started going to the shops
    date_completedShopping: { type: Date, default: null }, //The time when the shopper was done shopping
    date_routeToDelivery: { type: Date, default: null }, //The time when the shopper started going to delivery the shopped items
    date_clientRatedShopping: { type: Date, default: null }, //The time when the client rated the shopper
  },
  {
    timestamps: true,
    saveUnknown: true,
  }
);

module.exports = dynamoose.model("Requests", requestSchema, {
  throughput: "ON_DEMAND",
  update: false,
  waitForActive: true,
  initialize: true,
  create: true,
});
