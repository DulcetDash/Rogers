const dynamoose = require("dynamoose");

const catalogueSchema = new dynamoose.Schema(
  {
    id: {
      type: String,
      hashKey: true,
    },
    shop_fp: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "shopfp-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    brand: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "brand-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    product_name: String,
    product_price: String,
    product_picture: dynamoose.type.ANY,
    sku: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "sku-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    used_link: String,
    category: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "category-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    subcategory: String,
    shop_name: {
      type: String,
      required: true,
      index: {
        global: true,
        rangeKey: "id",
        name: "shopname-index",
        project: true,
        throughput: "ON_DEMAND",
      },
    },
    website_link: String,
    description: String,
  },
  {
    // timestamps: true,
    saveUnknown: true,
  }
);

module.exports = dynamoose.model("Catalogues", catalogueSchema, {
  throughput: "ON_DEMAND",
  update: false,
  waitForActive: true,
  initialize: true,
  create: true,
});
