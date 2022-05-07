require("dotenv").config();
//require("newrelic");
var express = require("express");
const http = require("http");
const path = require("path");
var multer = require("multer");
const MongoClient = require("mongodb").MongoClient;
var fastFilter = require("fast-filter");
const FuzzySet = require("fuzzyset");
const crypto = require("crypto");

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

/**
 * @func generateUniqueFingerprint()
 * Generate unique fingerprint for any string size.
 */
function generateUniqueFingerprint(str, encryption = false, resolve) {
  str = str.trim();
  let fingerprint = null;
  if (encryption === false) {
    fingerprint = crypto
      .createHmac(
        "sha512WithRSAEncryption",
        "NEJBASICKEYFINGERPRINTS-RIDES-DELIVERY"
      )
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  } else if (/md5/i.test(encryption)) {
    fingerprint = crypto
      .createHmac(
        "md5WithRSAEncryption",
        "NEJBASICKEYFINGERPRINTS-RIDES-DELIVERY"
      )
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  } //Other - default
  else {
    fingerprint = crypto
      .createHmac("sha256", "NEJBASICKEYFINGERPRINTS-RIDES-DELIVERY")
      .update(str)
      .digest("hex");
    resolve(fingerprint);
  }
}

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
        if (
          store.publish === undefined ||
          store.publish === null ||
          store.publish
        ) {
          logger.info(store);
          let tmpStore = {
            name: store.name,
            fd_name: store.friendly_name,
            type: store.shop_type,
            description: store.description,
            background: store.shop_background_color,
            border: store.border_color,
            logo: `${process.env.AWS_S3_SHOPS_LOGO_PATH}/${store.shop_logo}`,
            fp: store.shop_fp,
            structured: store.structured_shopping,
            times: {
              target_state: null, //two values: opening or closing
              string: null, //something like: opening in ...min or closing in ...h
            },
            date_added: new Date(store.date_added).getTime(),
          };
          //...
          //? Determine the times
          let store_opening_ref =
            parseInt(
              store.opening_time.split(":")[0].replace(/^0/, "").trim()
            ) *
              60 +
            parseInt(store.opening_time.split(":")[1].replace(/^0/, "").trim()); //All in minutes
          let store_closing_ref =
            parseInt(
              store.closing_time.split(":")[0].replace(/^0/, "").trim()
            ) *
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
        }
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
  let redisKey = `${JSON.stringify(req)}-catalogue`;

  redisGet(redisKey)
    .then((resp) => {
      if (resp !== null) {
        //Has products
        try {
          //Rehydrate
          new Promise((resCompute) => {
            execGetCatalogueFor(req, redisKey, resCompute);
          })
            .then((result) => {})
            .catch((error) => {
              logger.error(error);
            });

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
              resolve({ response: {}, store: req.store });
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
            resolve({ response: {}, store: req.store });
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
          resolve({ response: {}, store: req.store });
        });
    });
}

//? ARRAY SHUFFLER
function shuffle(array) {
  let currentIndex = array.length,
    randomIndex;

  // While there remain elements to shuffle.
  while (currentIndex != 0) {
    // Pick a remaining element.
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }

  return array;
}

function execGetCatalogueFor(req, redisKey, resolve) {
  //Get the store name first
  collection_shops_central
    .find({ shop_fp: req.store })
    .toArray(function (err, storeData) {
      if (err) {
        logger.error(err);
        resolve({ response: {}, store: req.store });
      }
      //...
      if (storeData !== undefined && storeData.length > 0) {
        //Found
        storeData = storeData[0];

        let reformulateQuery =
          req.category !== undefined
            ? {
                "meta.shop_name": storeData.name.toUpperCase().trim(),
                "meta.category": req.category.toUpperCase().trim(),
              }
            : {
                "meta.shop_name": storeData.name.toUpperCase().trim(),
              };
        //! Add subcategory
        reformulateQuery =
          req.subcategory !== undefined
            ? {
                ...reformulateQuery,
                ...{ "meta.subcategory": req.subcategory.toUpperCase().trim() },
              }
            : reformulateQuery;
        //! Cancel all the filtering - if a structured argument is set
        reformulateQuery =
          req.structured !== undefined && req.structured === "true"
            ? {
                "meta.shop_name": storeData.name.toUpperCase().trim(),
              }
            : reformulateQuery;

        logger.warn(reformulateQuery);

        collection_catalogue_central
          .find(reformulateQuery)
          .toArray(function (err, productsData) {
            if (err) {
              logger.error(err);
              resolve({ response: {}, store: req.store });
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
                    store_fp: req.store,
                    structured:
                      storeData.structured_shopping !== undefined &&
                      storeData.structured_shopping !== null
                        ? storeData.structured_shopping
                          ? "true"
                          : "false"
                        : "false",
                  },
                };
                //...
                reformatted_data.push(tmpData);
              });
              //...
              //! Reorganize based on if the data is structured
              new Promise((resOrganize) => {
                if (req.structured !== undefined && req.structured === "true") {
                  logger.info("Structured data");
                  let structured = {};
                  reformatted_data.map((p) => {
                    if (
                      structured[p.meta.category] !== undefined &&
                      structured[p.meta.category] !== null
                    ) {
                      //Already set
                      structured[p.meta.category].push(p);
                      //! Shuffle
                      structured[p.meta.category] = shuffle(
                        structured[p.meta.category]
                      );
                      //! Always limit to 3
                      structured[p.meta.category] = structured[
                        p.meta.category
                      ].slice(0, 3);
                    } //Not yet set
                    else {
                      structured[p.meta.category] = [];
                      structured[p.meta.category].push(p);
                    }
                  });
                  //....
                  resOrganize(structured);
                } //Unstructured data
                else {
                  logger.info("Unstructured data");
                  resOrganize(reformatted_data);
                }
              })
                .then((result) => {
                  //! Cache
                  let final = { response: result };
                  redisCluster.set(redisKey, JSON.stringify(final));
                  resolve(final);
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: {}, store: req.store });
                });
            } //No products
            else {
              resolve({ response: {}, store: req.store });
            }
          });
      } //Invalid store
      else {
        resolve({ response: {}, store: req.store });
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

/**
 * @func getShoppingDataClient
 * responsible for getting the realtime shopping requests for clients.
 * @param requestData: user_identifier mainly
 * @param resolve
 */
function getShoppingDataClient(requestData, resolve) {
  collection_shoppings_central
    .find({
      client_id: requestData.user_identifier,
      "shopping_state_vars.completedRatingClient": false,
    })
    .toArray(function (err, shoppingData) {
      if (err) {
        logger.error(err);
        resolve(false);
      }
      //...
      if (shoppingData !== undefined && shoppingData.length > 0) {
        shoppingData = shoppingData[0];
        //Has a pending shopping
        let RETURN_DATA_TEMPLATE = {
          request_fp: shoppingData.request_fp,
          client_id: requestData.user_identifier, //the user identifier - requester
          shopper_data: {
            shopper_id: shoppingData.shopper_id,
            details: null, //The name and profile picture
          },
          payment_method: shoppingData.totals.payment_method, //mobile_money or cash
          locations: shoppingData.locations, //Has the pickup and delivery locations
          totals_cart: shoppingData.totals, //Has the cart details in terms of fees
          request_type: shoppingData.request_type, //scheduled or immediate
          shopping_state_vars: shoppingData.shopping_state_vars,
          date_requested: shoppingData.date_requested, //The time of the request
        };
        //..Get the shopper's infos
        collection_shoppers_central
          .find({ user_identifier: shoppingData.shopper_id })
          .toArray(function (err, shopperData) {
            if (err) {
              logger.error(false);
              resolve(false);
            }
            //...
            if (shopperData !== undefined && shopperData.length > 0) {
              //Has a shopper
              shopperData = shopperData[0];
              RETURN_DATA_TEMPLATE.shopper_data.details = {
                name: shopperData["name"],
                phone: shopperData["phone_number"],
                picture: shopperData["media"]["profile_picture"],
              };
              //...
              resolve([RETURN_DATA_TEMPLATE]);
            } //No shoppers yet
            else {
              RETURN_DATA_TEMPLATE.shopper_data.details = {
                name: null,
                phone: null,
                picture: null,
              };
              //...
              resolve([RETURN_DATA_TEMPLATE]);
            }
          });
      } //No pending shoppings
      else {
        resolve(false);
      }
    });
}

var collection_catalogue_central = null;
var collection_shops_central = null;
var collection_shoppings_central = null;
var collection_users_central = null;
var collection_shoppers_central = null;

redisCluster.on("connect", function () {
  logger.info("[*] Redis connected");
  MongoClient.connect(process.env.DB_URL_MONGODB, function (err, clientMongo) {
    if (err) throw err;
    logger.info("[+] Nej service active");
    const dbMongo = clientMongo.db(process.env.DB_NAME_MONGODDB);
    collection_catalogue_central = dbMongo.collection("catalogue_central"); //Hold all the product from the catalogue
    collection_shops_central = dbMongo.collection("shops_central"); //Hold all the shops subscribed
    collection_shoppings_central = dbMongo.collection("shoppings_central"); //Hold all the shopping requests
    collection_users_central = dbMongo.collection("users_central"); //Hold all the users data
    collection_shoppers_central = dbMongo.collection("shoppers_central"); //Hold all the shoppers data

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
        req.store = req.store;
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

    //?4. Move all the pictures from external remote servers to our local server
    app.post("/getImageRessourcesFromExternal", function (req, res) {
      //Get all the images that where not moved yet into the internal ressources
      //? In an image ressource was moved, it will be in the meta.moved_ressources_manifest, else proceed with the getting
      collection_catalogue_central
        .find({})
        .toArray(function (err, productsData) {
          if (err) {
            logger.error(err);
            res.send({ response: "error", flag: err });
          }
          //...
          if (productsData !== undefined && productsData.length > 0) {
            //Has some products
            let parentPromises = productsData.map((product, index) => {
              return new Promise((resolve) => {
                //Get the array of images
                let arrayImages = product.product_picture;
                //Get the transition manifest
                //? Looks like {'old_image_name_external_url': new_image_name_url}
                console.log(arrayImages);
                let transition_manifest =
                  product.meta.moved_ressources_manifest !== undefined &&
                  product.meta.moved_ressources_manifest !== null
                    ? product.meta.moved_ressources_manifest
                    : {};

                let parentPromises2 = arrayImages.map((picture) => {
                  return new Promise((resCompute) => {
                    if (
                      transition_manifest[picture] !== undefined &&
                      transition_manifest[picture] !== null
                    ) {
                      //!Was moved
                      //Already processed
                      resCompute({
                        message: "Already processed",
                        index: index,
                      });
                    } //!Not moved yet - move
                    else {
                      let options = {
                        uri: picture,
                        encoding: null,
                      };
                      requestAPI(options, function (error, response, body) {
                        if (error || response.statusCode !== 200) {
                          console.log("failed to get image");
                          console.log(error);
                          resCompute({
                            message: "Processed - failed",
                            index: index,
                          });
                        } else {
                          logger.info("Got the image");
                          s3.putObject(
                            {
                              Body: body,
                              Key: path,
                              Bucket: "bucket_name",
                            },
                            function (error, data) {
                              if (error) {
                                console.log("error downloading image to s3");
                                resCompute({
                                  message: "Processed - failed",
                                  index: index,
                                });
                              } else {
                                console.log("success uploading to s3");
                                resCompute({
                                  message: "Processed",
                                  index: index,
                                });
                              }
                            }
                          );
                        }
                      });
                    }
                  });
                });

                //? Done with this
                Promise.all(parentPromises2)
                  .then((result) => {
                    resolve(result);
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: "error_processing" });
                  });
              });
            });

            //! DONE
            Promise.all(parentPromises)
              .then((result) => {
                res.send({ response: result });
              })
              .catch((error) => {
                logger.error(error);
                res.send({ response: "unable_to_work", flag: error });
              });
          } //No products
          else {
            res.send({ response: "no_products_found" });
          }
        });
    });

    //?5. Get the user location geocoded
    app.post("/geocode_this_point", function (req, res) {
      let urlRequest = `http://localhost:${process.env.SEARCH_SERVICE_PORT}/geocode_this_point`;

      requestAPI.post(
        { url: urlRequest, form: req.body },
        function (err, response, body) {
          if (err) {
            logger.error(err);
          }
          //...
          res.send(body);
        }
      );
    });

    //?5. Get location search suggestions
    app.post("/getSearchedLocations", function (req, res) {
      let urlRequest = `http://localhost:${process.env.SEARCH_SERVICE_PORT}/getSearchedLocations`;

      requestAPI.post(
        { url: urlRequest, form: req.body },
        function (err, response, body) {
          if (err) {
            logger.error(err);
          }
          //...
          res.send(body);
        }
      );
    });

    //?6. Request for shopping
    app.post("/requestForShopping", function (req, res) {
      new Promise((resolve) => {
        req = req.body;
        //! Check for the user identifier, shopping_list and totals
        if (
          req.user_identifier !== undefined &&
          req.user_identifier !== null &&
          req.shopping_list !== undefined &&
          req.shopping_list !== null &&
          req.totals !== undefined &&
          req.totals !== null &&
          req.locations !== undefined &&
          req.locations !== null
        ) {
          logger.info(req);
          try {
            //! Check if the user has no unconfirmed shoppings
            let checkUnconfirmed = {
              client_id: req.user_identifier,
              "shopping_state_vars.completedRatingClient": false,
            };

            collection_shoppings_central
              .find(checkUnconfirmed)
              .toArray(function (err, prevShopping) {
                if (err) {
                  logger.error(err);
                  resolve({ response: "unable_to_request" });
                }
                //...
                if (prevShopping !== undefined && prevShopping.length <= 0) {
                  //No unconfirmed shopping - okay
                  req.shopping_list = JSON.parse(req.shopping_list);
                  req.totals = JSON.parse(req.totals);
                  req.locations = JSON.parse(req.locations);
                  //...
                  let REQUEST_TEMPLATE = {
                    request_fp: null,
                    client_id: req.user_identifier, //the user identifier - requester
                    shopper_id: false, //The id of the shopper
                    payment_method: req.totals.payment_method, //mobile_money or cash
                    locations: req.locations, //Has the pickup and delivery locations
                    totals_cart: req.totals, //Has the cart details in terms of fees
                    request_type: "immediate", //scheduled or immediate
                    shopping_state_vars: {
                      isAccepted: false, //If the shopping request is accepted
                      inRouteToPickupCash: false, //If the shopper is in route to pickup the cash
                      didPickupCash: false, //If the shopper picked up the cash
                      inRouteToShop: false, //If the shopper is in route to the shop(s)
                      inRouteToDelivery: false, //If the shopper is on his(her) way to delivery the shopped items
                      completedShopping: false, //If the shopper is done shopping
                      completedRatingClient: false, //If the client has completed the rating of the shopped items
                      rating_data: {
                        rating: false, //Out of 5
                        comments: false, //The clients comments
                        compliments: [], //The service badges
                      }, //The rating infos
                    },
                    date_requested: new Date(chaineDateUTC), //The time of the request
                    date_pickedupCash: null, //The time when the shopper picked up the cash from the client
                    date_routeToShop: null, //The time when the shopper started going to the shops
                    date_completedShopping: null, //The time when the shopper was done shopping
                    date_routeToDelivery: null, //The time when the shopper started going to delivery the shopped items
                    date_clientRatedShopping: null, //The time when the client rated the shopper
                  };
                  //...
                  //?1. Get the request_fp
                  new Promise((resCompute) => {
                    generateUniqueFingerprint(
                      `${JSON.stringify(req)}`,
                      "basic",
                      resCompute
                    );
                  })
                    .then((result) => {
                      REQUEST_TEMPLATE.request_fp = result;
                    })
                    .catch((error) => {
                      logger.error(error);
                      REQUEST_TEMPLATE.request_fp = `${req.user_identifier.subtr(
                        0,
                        10
                      )}${Math.round(new Date(chaineDateUTC).getTime())}`;
                    })
                    .finally(() => {
                      //?Continue here
                      collection_shoppings_central.insertOne(
                        REQUEST_TEMPLATE,
                        function (err, reslt) {
                          if (err) {
                            logger.error(err);
                            resolve({ response: "unable_to_request" });
                          }
                          //....DONE
                          resolve({ response: "successful" });
                        }
                      );
                    });
                } //Has an unconfirmed shopping - block
                else {
                  resolve({ response: "has_a_pending_shopping" });
                }
              });
          } catch (error) {
            logger.error(error);
            resolve({ response: "unable_to_request" });
          }
        } else {
          resolve({ response: "unable_to_request" });
        }
      })
        .then((result) => {
          res.send(result);
        })
        .catch((error) => {
          logger.error(error);
          res.send({ response: "unable_to_request" });
        });
    });

    //?7. Get the current shopping data - client
    app.post("/getShoppingData", function (req, res) {
      new Promise((resolve) => {
        req = req.body;

        if (req.user_identifier !== undefined && req.user_identifier !== null) {
          //! Check if the user id exists
          collection_users_central
            .find({ user_identifier: req.user_identifier })
            .toArray(function (err, userData) {
              if (err) {
                logger.error(err);
                resolve(false);
              }
              //...
              if (userData !== undefined && userData.length > 0) {
                //Known user
                let redisKey = `${req.user_identifier}-shoppings`;

                redisGet(redisKey)
                  .then((resp) => {
                    if (resp !== null) {
                      //Has some data
                      try {
                        //Rehydrate
                        new Promise((resCompute) => {
                          getShoppingDataClient(req, resCompute);
                        })
                          .then((result) => {
                            //!Cache
                            redisCluster(
                              redisKey,
                              parseInt(process.env.REDIS_EXPIRATION_5MIN) * 100,
                              JSON.stringify(result)
                            );
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve(false);
                          });
                        //....
                        resp = JSON.parse(resp);
                        resolve(resp);
                      } catch (error) {
                        logger.error(error);
                        //Make a new request
                        new Promise((resCompute) => {
                          getShoppingDataClient(req, resCompute);
                        })
                          .then((result) => {
                            //!Cache
                            redisCluster(
                              redisKey,
                              parseInt(process.env.REDIS_EXPIRATION_5MIN) * 100,
                              JSON.stringify(result)
                            );
                            //...
                            resolve(result);
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve(false);
                          });
                      }
                    } //Make a new request
                    else {
                      new Promise((resCompute) => {
                        getShoppingDataClient(req, resCompute);
                      })
                        .then((result) => {
                          //!Cache
                          redisCluster(
                            redisKey,
                            parseInt(process.env.REDIS_EXPIRATION_5MIN) * 100,
                            JSON.stringify(result)
                          );
                          //...
                          resolve(result);
                        })
                        .catch((error) => {
                          logger.error(error);
                          resolve(false);
                        });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    //Make a new request
                    new Promise((resCompute) => {
                      getShoppingDataClient(req, resCompute);
                    })
                      .then((result) => {
                        //!Cache
                        redisCluster(
                          redisKey,
                          parseInt(process.env.REDIS_EXPIRATION_5MIN) * 100,
                          JSON.stringify(result)
                        );
                        //...
                        resolve(result);
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve(false);
                      });
                  });
              } //! Unknown user
              else {
                resolve(false);
              }
            });
        } //Missing data
        else {
          resolve(false);
        }
      })
        .then((result) => {
          res.send(result);
        })
        .catch((error) => {
          logger.error(error);
          res.send(false);
        });
    });
  });
});

server.listen(process.env.SERVER_MOTHER_PORT);
