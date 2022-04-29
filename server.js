require("dotenv").config();
//require("newrelic");
var express = require("express");
const http = require("http");
const path = require("path");
var multer = require("multer");
const MongoClient = require("mongodb").MongoClient;
var fastFilter = require("fast-filter");
const FuzzySet = require("fuzzyset");

const { logger } = require("./LogService");

var app = express();
var server = http.createServer(app);
var cors = require("cors");
var helmet = require("helmet");
const io = require("socket.io")(server, {
  cors: {
    origin: /production/i.test(process.env.EVIRONMENT)
      ? process.env.LEAD_DOMAIN_URL
      : `http://${process.env.INSTANCE_PRIVATE_IP}`,
    methods: ["GET", "POST"],
    credentials: true,
  },
});
const requestAPI = require("request");
//....

const redis = require("redis");
const { promisify } = require("util");
//192.168.8.132
const client = /production/i.test(String(process.env.EVIRONMENT))
  ? null
  : redis.createClient({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    });
var RedisClustr = require("redis-clustr");
var redisCluster = /production/i.test(String(process.env.EVIRONMENT))
  ? new RedisClustr({
      servers: [
        {
          host: process.env.REDIS_HOST_ELASTICACHE,
          port: process.env.REDIS_PORT_ELASTICACHE,
        },
      ],
      createClient: function (port, host) {
        // this is the default behaviour
        return redis.createClient(port, host);
      },
    })
  : client;
const redisGet = promisify(redisCluster.get).bind(redisCluster);

var chaineDateUTC = null;
var dateObject = null;
const moment = require("moment");

function resolveDate() {
  //Resolve date
  var date = new Date();
  date = moment(date.getTime()).utcOffset(2);

  dateObject = date;
  date =
    date.year() +
    "-" +
    (date.month() + 1) +
    "-" +
    date.date() +
    " " +
    date.hour() +
    ":" +
    date.minute() +
    ":" +
    date.second();
  chaineDateUTC = new Date(date).toISOString();
}
resolveDate();

//EVENT GATEWAY PORT

app
  .get("/", function (req, res) {
    res.send("[+] Nej server running.");
  })
  .use(express.static(path.join(__dirname, "assets")));
app
  .use(
    express.json({
      limit: process.env.MAX_DATA_BANDWIDTH_EXPRESS,
      extended: true,
    })
  )
  .use(
    express.urlencoded({
      limit: process.env.MAX_DATA_BANDWIDTH_EXPRESS,
      extended: true,
    })
  )
  // .use(multer().none())
  .use(cors())
  .use(helmet());

/**
 * @func getStores
 * Will get all the stores available and their closing times relative to now.
 * @param resolve
 */
function getStores(resolve) {
  let redisKey = "get-stores";

  redisGet(redisKey)
    .then((resp) => {
      if (resp !== null) {
        //Has some data
        try {
          new Promise((resCompute) => {
            execGetStores(redisKey, resCompute);
          })
            .then((result) => {})
            .catch((error) => {
              logger.error(error);
            });
          //...
          resp = JSON.parse(resp);
          resolve(resp);
        } catch (error) {
          logger.error(error);
          new Promise((resCompute) => {
            execGetStores(redisKey, resCompute);
          })
            .then((result) => {
              resolve(result);
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: [] });
            });
        }
      } //No data
      else {
        new Promise((resCompute) => {
          execGetStores(redisKey, resCompute);
        })
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: [] });
          });
      }
    })
    .catch((error) => {
      logger.error(error);
      //No data
      new Promise((resCompute) => {
        execGetStores(redisKey, resCompute);
      })
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          logger.error(error);
          resolve({ response: [] });
        });
    });
}

function execGetStores(redisKey, resolve) {
  collection_shops_central.find({}).toArray(function (err, storesData) {
    if (err) {
      logger.error(err);
      resolve({ response: [] });
    }
    //...
    if (storesData !== undefined && storesData.length > 0) {
      let STORES_MODEL = [];
      storesData.map((store) => {
        logger.info(store);
        let tmpStore = {
          name: store.name,
          type: store.shop_type,
          description: store.description,
          background: store.shop_background_color,
          border: store.border_color,
          logo: `${process.env.AWS_S3_SHOPS_LOGO_PATH}/${store.shop_logo}`,
          fp: store.shop_fp,
          times: {
            target_state: null, //two values: opening or closing
            string: null, //something like: opening in ...min or closing in ...h
          },
          date_added: new Date(store.date_added).getTime(),
        };
        //...
        //? Determine the times
        let store_opening_ref =
          parseInt(store.opening_time.split(":")[0].replace(/^0/, "").trim()) *
            60 +
          parseInt(store.opening_time.split(":")[1].replace(/^0/, "").trim()); //All in minutes
        let store_closing_ref =
          parseInt(store.closing_time.split(":")[0].replace(/^0/, "").trim()) *
            60 +
          parseInt(store.closing_time.split(":")[1].replace(/^0/, "").trim()); //All in minutes
        //...
        let ref_time =
          new Date(chaineDateUTC).getHours() * 60 +
          new Date(chaineDateUTC).getMinutes();

        if (ref_time >= store_opening_ref && ref_time <= store_closing_ref) {
          //Target: closing
          let time_left = Math.abs(store_closing_ref - ref_time);
          time_left =
            time_left >= 60
              ? `Closing in ${Math.round(time_left / 60)}hours`
              : `Closing in ${time_left}min`;
          //...
          tmpStore.times.target_state = "Closing";
          tmpStore.times.string = time_left;
        } //Target: opening
        else {
          let time_left = Math.abs(store_opening_ref - ref_time);
          time_left =
            time_left >= 60
              ? `Opening in ${Math.round(time_left / 60)}hours`
              : `Opening in ${time_left}min`;
          //...
          tmpStore.times.target_state = "Opening";
          tmpStore.times.string = time_left;
        }
        //? DONE - SAVE
        STORES_MODEL.push(tmpStore);
      });
      //...
      //! Cache
      redisCluster.set(redisKey, JSON.stringify(STORES_MODEL));
      resolve({ response: STORES_MODEL });
    } //No stores
    else {
      resolve({ response: [] });
    }
  });
}

/**
 * @func getCatalogueFor
 * Get all the products for a specific store
 * @param req: store infos
 * @param resolve
 */
function getCatalogueFor(req, resolve) {
  let redisKey = `${req.store}-catalogue`;

  redisGet(redisKey)
    .then((resp) => {
      if (resp !== null) {
        //Has products
        try {
          resp = JSON.parse(resp);
          resolve(resp);
        } catch (error) {
          logger.error(error);
          new Promise((resCompute) => {
            execGetCatalogueFor(req, redisKey, resCompute);
          })
            .then((result) => {
              resolve(result);
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: "no_products", store: req.store });
            });
        }
      } //No data
      else {
        new Promise((resCompute) => {
          execGetCatalogueFor(req, redisKey, resCompute);
        })
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: "no_products", store: req.store });
          });
      }
    })
    .catch((error) => {
      //No data
      logger.error(error);
      new Promise((resCompute) => {
        execGetCatalogueFor(req, redisKey, resCompute);
      })
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          logger.error(error);
          resolve({ response: "no_products", store: req.store });
        });
    });
}

function execGetCatalogueFor(req, redisKey, resolve) {
  collection_catalogue_central
    .find({
      "meta.shop_name": req.store,
    })
    .toArray(function (err, productsData) {
      if (err) {
        logger.error(err);
        resolve({ response: "no_products", store: req.store });
      }
      //...
      if (productsData !== undefined && productsData.length > 0) {
        //Has data
        //Reformat the data
        let reformatted_data = [];
        productsData.map((product, index) => {
          let tmpData = {
            index: index,
            name: product.product_name,
            price: product.product_price.replace("R", "N$"),
            pictures: [product.product_picture],
            sku: product.sku,
            meta: {
              category: product.meta.category,
              subcategory: product.meta.subcategory,
              store: product.meta.shop_name,
            },
          };
          //...
          reformatted_data.push(tmpData);
        });
        //...
        //! Cache
        let final = { response: reformatted_data };
        redisCluster.set(redisKey, JSON.stringify(final));
        resolve(final);
      } //No products
      else {
        resolve({ response: "no_products", store: req.store });
      }
    });
}

//? SEARCH LOGIC

/**
 * @func searchProductsFor
 * Search the product based on a key word in a specific store
 * @param req: request meta (store, key)
 * @param resolve
 */
function searchProductsFor(req, resolve) {
  let redisKey = `${req.store}-${req.key}-productFiltered`;

  redisGet(redisKey)
    .then((resp) => {
      if (resp !== null) {
        //Has data
        try {
          resp = JSON.parse(resp);
          resolve(resp);
        } catch (error) {
          logger.error(error);
          new Promise((resCompute) => {
            execSearchProductsFor(req, redisKey, resCompute);
          })
            .then((result) => {
              resolve(result);
            })
            .catch((error) => {
              logger.error(error);
              resolve({ response: [] });
            });
        }
      } //No  data
      else {
        new Promise((resCompute) => {
          execSearchProductsFor(req, redisKey, resCompute);
        })
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            logger.error(error);
            resolve({ response: [] });
          });
      }
    })
    .catch((error) => {
      logger.error(error);
      new Promise((resCompute) => {
        execSearchProductsFor(req, redisKey, resCompute);
      })
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          logger.error(error);
          resolve({ response: [] });
        });
    });
}

function execSearchProductsFor(req, redisKey, resolve) {
  //1. Get all the  product from the store
  collection_catalogue_central
    .find({
      "meta.shop_name": req.store,
    })
    .toArray(function (err, productsAll) {
      if (err) {
        logger.error(err);
        resolve({ response: [] });
      }
      //...
      if (productsAll !== undefined && productsAll.length > 0) {
        //Has data
        //! Filter based on the key word
        new Promise((resCompute) => {
          // similarityCheck_products_search(productsAll, req.key, resCompute);
          //Isolate the names
          let productNames = productsAll.map((el) => el.product_name);
          let setProducts = FuzzySet(productNames, false);
          let filterProducts = setProducts.get(req.key);
          filterProducts = filterProducts.map((el, index) => el[1]);
          //! Only get the strings
          //! Get back the original objects for the found keywords
          let x = productsAll.filter((el) =>
            filterProducts.includes(el.product_name)
          );
          //Order the arrays
          let ordered = [];
          filterProducts.map((l1) => {
            x.map((l2) => {
              if (l1 === l2.product_name) {
                ordered.push(l2);
              }
            });
          });
          //...
          resCompute(ordered);
        }).then((result) => {
          //Removee all the false
          result = result.filter(
            (el) => el !== false && el !== null && el !== undefined
          );
          let final = { response: result };
          //! Cache
          redisCluster.setex(redisKey, 432000, JSON.stringify(final));
          //...
          resolve(final);
        });
      } //No data
      else {
        resolve({ response: [] });
      }
    });
}

var collection_catalogue_central = null;
var collection_shops_central = null;

redisCluster.on("connect", function () {
  logger.info("[*] Redis connected");
  MongoClient.connect(process.env.DB_URL_MONGODB, function (err, clientMongo) {
    if (err) throw err;
    logger.info("[+] Nej service active");
    const dbMongo = clientMongo.db(process.env.DB_NAME_MONGODDB);
    collection_catalogue_central = dbMongo.collection("catalogue_central"); //Hold all the product from the catalogue
    collection_shops_central = dbMongo.collection("shops_central"); //Hold all the shops subscribed

    //?1. Get all the available stores in the app.
    //Get the main ones (4) and the new ones (X)
    app.post("/getStores", function (req, res) {
      new Promise((resolve) => {
        getStores(resolve);
      })
        .then((result) => {
          res.send(result);
        })
        .catch((error) => {
          logger.error(error);
          res.send({ response: [] });
        });
    });

    //?2. Get all the products based on a store
    app.post("/getCatalogueFor", function (req, res) {
      req = req.body;
      if (req.store !== undefined && req.store !== null) {
        req.store = req.store.toUpperCase();
        //Ok
        new Promise((resolve) => {
          getCatalogueFor(req, resolve);
        })
          .then((result) => {
            res.send(result);
          })
          .catch((error) => {
            logger.error(error);
            res.send({ response: "no_products" });
          });
      } //No valid data
      else {
        res.send({ response: "no_products" });
      }
    });

    //?3. Search in  the catalogue of a  specific shop
    app.post("/getResultsForKeywords", function (req, res) {
      req = req.body;
      if (
        req.key !== undefined &&
        req.key !== null &&
        req.store !== undefined &&
        req.store !== null
      ) {
        new Promise((resolve) => {
          searchProductsFor(req, resolve);
        })
          .then((result) => {
            //! Limit to 5
            // result = result.response.splice(0, 5);
            res.send(result);
          })
          .catch((error) => {
            logger.error(error);
            res.send({ response: [] });
          });
      } //No valid data
      else {
        res.send({ response: [] });
      }
    });
  });
});

server.listen(process.env.SERVER_MOTHER_PORT);
