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
var otpGenerator = require("otp-generator");
var elasticsearch = require("elasticsearch");

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

var ElasticSearch_client = new elasticsearch.Client({
  hosts: ["http://localhost:9205"],
});

var chaineDateUTC = null;
var dateObject = null;
const moment = require("moment");
const { equal } = require("assert");

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

//! Create search indexes
function checkIndices(index_name, resolve) {
  ElasticSearch_client.indices.exists(
    { index: index_name },
    (err, res, status) => {
      if (res) {
        console.log("index already exists");
        resolve(true);
      } else {
        ElasticSearch_client.indices.create(
          {
            index: index_name,
            body: {
              mappings: {
                properties: {
                  product_name: {
                    type: "text",
                  },
                },
              },
            },
          },
          (err, res, status) => {
            if (err) {
              logger.error(err);
              resolve(false);
            }
            console.log(err, res, status);
            resolve(true);
          }
        );
      }
    }
  );
}

/**
 * @func searchProductsFor
 * Search the product based on a key word in a specific store
 * @param req: request meta (store, key)
 * @param resolve
 */
function searchProductsFor(req, resolve) {
  let redisKey = `${req.store}-${req.key}-productFiltered`;

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

  // redisGet(redisKey)
  //   .then((resp) => {
  //     if (resp !== null) {
  //       //Has data
  //       try {
  //         resp = JSON.parse(resp);
  //         resolve(resp);
  //       } catch (error) {
  //         logger.error(error);
  //         new Promise((resCompute) => {
  //           execSearchProductsFor(req, redisKey, resCompute);
  //         })
  //           .then((result) => {
  //             resolve(result);
  //           })
  //           .catch((error) => {
  //             logger.error(error);
  //             resolve({ response: [] });
  //           });
  //       }
  //     } //No  data
  //     else {
  //       new Promise((resCompute) => {
  //         execSearchProductsFor(req, redisKey, resCompute);
  //       })
  //         .then((result) => {
  //           resolve(result);
  //         })
  //         .catch((error) => {
  //           logger.error(error);
  //           resolve({ response: [] });
  //         });
  //     }
  //   })
  //   .catch((error) => {
  //     logger.error(error);
  //     new Promise((resCompute) => {
  //       execSearchProductsFor(req, redisKey, resCompute);
  //     })
  //       .then((result) => {
  //         resolve(result);
  //       })
  //       .catch((error) => {
  //         logger.error(error);
  //         resolve({ response: [] });
  //       });
  //   });
}

function execSearchProductsFor(req, redisKey, resolve) {
  resolveDate();
  logger.info(req);
  //1. Get all the  product from the store
  let checkQuery =
    req.category !== null && req.category !== undefined
      ? {
          "meta.shop_name": req.store,
          "meta.category": req.category,
        }
      : req.subcategory !== null && req.subcategory !== undefined
      ? {
          "meta.shop_name": req.store,
          "meta.subcategory": req.subcategory,
        }
      : req.category !== null &&
        req.category !== undefined &&
        req.subcategory !== null &&
        req.subcategory !== undefined
      ? {
          "meta.shop_name": req.store,
          "meta.category": req.category,
          "meta.subcategory": req.subcategory,
        }
      : {
          "meta.shop_name": req.store,
        };

  collection_catalogue_central
    .find(checkQuery)
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
          //? Create the search index if not yet set
          //? Create mapping if not yet created
          let index_name = `${req.store}_${req.key}`
            .toLowerCase()
            .trim()
            .replace(/ /g, "_");
          let index_type = "products";

          new Promise((resCheckIndices) => {
            checkIndices(index_name, resCheckIndices);

            //Isolate the names
            // let productNames = productsAll.map((el) => el.product_name);
            // let setProducts = FuzzySet(productNames, false);
            // let filterProducts = setProducts.get(req.key);
            // filterProducts = filterProducts.map((el, index) => el[1]);
            // //! Only get the strings
            // //! Get back the original objects for the found keywords
            // let x = productsAll.filter((el) =>
            //   filterProducts.includes(el.product_name)
            // );
            // //Order the arrays
            // let ordered = [];
            // filterProducts.map((l1) => {
            //   x.map((l2) => {
            //     if (l1 === l2.product_name) {
            //       ordered.push(l2);
            //     }
            //   });
            // });
            // //...
            // resCompute(ordered);
          })
            .then((resultIndices) => {
              if (resultIndices) {
                let dataToIngest = [];
                //Isolate the names
                productsAll.map((el) => {
                  let header = {
                    index: {
                      _index: index_name,
                      _id: el._id,
                    },
                  };

                  let dataTmp = { product_name: el.product_name };
                  //...Save
                  dataToIngest.push(header);
                  dataToIngest.push(dataTmp);
                });

                console.log(dataToIngest.length);
                //! INGEST INTO ELASTIC SEARCH
                ElasticSearch_client.bulk({ body: dataToIngest })
                  .then((result) => {
                    ElasticSearch_client.indices
                      .refresh({ index: index_name })
                      .then((r) => {
                        // console.log(r);
                        // logger.warn(result);
                        //? All in order for indices
                        // ElasticSearch_client.ref;
                        //? Search
                        ElasticSearch_client.search({
                          size: 500,
                          index: index_name,
                          body: {
                            query: {
                              match_phrase_prefix: {
                                product_name: {
                                  query: req.key,
                                  // fuzziness: "auto",
                                  // zero_terms_query: "all",
                                  // fuzziness: "AUTO",
                                  // max_expansions: 200,
                                  // prefix_length: 0,
                                  // transpositions: true,
                                  // rewrite: "constant_score",
                                },
                              },
                            },
                          },
                        }).then(
                          function (resp) {
                            let filterProducts = resp.hits.hits.map(
                              (el, index) => el._source.product_name
                            );
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
                                  l2.product_price = l2.product_price.replace(
                                    "R",
                                    "N$"
                                  );
                                  ordered.push(l2);
                                }
                              });
                            });

                            //?DONE
                            // console.log(resp.hits.hits);
                            console.log(ordered);
                            resCompute(ordered);
                          },
                          function (err) {
                            logger.error(err.message);
                            resCompute(false);
                          }
                        );
                      })
                      .catch((error) => {
                        logger.error(error);
                        resCompute(false);
                      });
                  })
                  .catch((error) => {
                    logger.error(error);
                    resCompute(false);
                  });
              } //!Problem resolving indices
              else {
                resCompute(false);
              }
            })
            .catch((error) => {
              logger.error(error);
              resCompute(false);
            });
        }).then((result) => {
          if (result !== false && result.length > 0) {
            //Removee all the false
            result = result.filter(
              (el) => el !== false && el !== null && el !== undefined
            );
            let final = { response: result };
            //! Cache
            redisCluster.setex(redisKey, 432000, JSON.stringify(final));
            //...
            resolve(final);
          } //No results
          else {
            resolve({ response: [] });
          }
        });
      } //No data
      else {
        resolve({ response: [] });
      }
    });
}

/**
 * @func getRequestDataClient
 * responsible for getting the realtime shopping requests for clients.
 * @param requestData: user_identifier mainly
 * @param resolve
 */
function getRequestDataClient(requestData, resolve) {
  collection_requests_central
    .find({
      client_id: requestData.user_identifier,
      "request_state_vars.completedRatingClient": false,
    })
    .toArray(function (err, shoppingData) {
      if (err) {
        logger.error(err);
        resolve(false);
      }

      //...
      if (shoppingData !== undefined && shoppingData.length > 0) {
        shoppingData = shoppingData[0];

        //!1. SHOPPING DATA
        if (shoppingData["ride_mode"].toUpperCase() === "SHOPPING") {
          //Has a pending shopping
          let RETURN_DATA_TEMPLATE = {
            ride_mode: shoppingData["ride_mode"].toUpperCase(),
            request_fp: shoppingData.request_fp,
            client_id: requestData.user_identifier, //the user identifier - requester
            driver_details: {}, //Will hold the details of the shopper
            shopping_list: shoppingData.shopping_list, //The list of items to shop for
            payment_method: shoppingData.payment_method, //mobile_money or cash
            trip_locations: shoppingData.locations, //Has the pickup and delivery locations
            totals_request: shoppingData.totals_request, //Has the cart details in terms of fees
            request_type: shoppingData.request_type, //scheduled or immediate
            state_vars: shoppingData.request_state_vars,
            ewallet_details: {
              phone: "+264856997167",
              security: shoppingData.security.pin,
            },
            date_requested: shoppingData.date_requested, //The time of the request
          };
          //..Get the shopper's infos
          collection_drivers_shoppers_central
            .find({ driver_fingerprint: shoppingData.shopper_id })
            .toArray(function (err, shopperData) {
              if (err) {
                logger.error(false);
                resolve(false);
              }
              //...
              if (shopperData !== undefined && shopperData.length > 0) {
                //Has a shopper
                let driverData = shopperData[0];

                RETURN_DATA_TEMPLATE.driver_details = {
                  name: driverData.name,
                  picture: driverData.identification_data.profile_picture,
                  rating: driverData.identification_data.rating,
                  phone: driverData["phone_number"],
                  vehicle: {
                    picture: driverData.cars_data[0].taxi_picture,
                    brand: driverData.cars_data[0].car_brand,
                    plate_no: driverData.cars_data[0].plate_number,
                    taxi_number: driverData.cars_data[0].taxi_number,
                  },
                };
                //...
                resolve([RETURN_DATA_TEMPLATE]);
              } //No shoppers yet
              else {
                RETURN_DATA_TEMPLATE.driver_details = {
                  name: null,
                  phone: null,
                  picture: null,
                };
                //...
                resolve([RETURN_DATA_TEMPLATE]);
              }
            });
        }
        //!2. RIDE DATA
        else if (shoppingData["ride_mode"].toUpperCase() === "RIDE") {
          //Check the state of the ride request
          //?1. NOT YET ACCEPTED
          if (shoppingData.request_state_vars.isAccepted === false) {
            let RETURN_DATA_TEMPLATE = {
              step_name: "pending",
              ride_mode: shoppingData["ride_mode"].toUpperCase(),
              request_fp: shoppingData.request_fp,
              payment_method: shoppingData.payment_method,
              trip_locations: shoppingData.locations,
              passengers: shoppingData.passengers_number,
              ride_style: shoppingData.ride_style,
              fare: shoppingData.totals_request.fare,
              note: shoppingData.request_documentation.note,
              state_vars: shoppingData.request_state_vars,
              driver_details: false,
              route_details: {
                //Will have eta and so on.
              },
              date_requested: shoppingData.date_requested,
            };
            //Get the route details
            let urlRequest = `http://localhost:${process.env.SEARCH_SERVICE_PORT}/getRouteToDestinationSnapshot`;

            requestAPI.post(
              {
                url: urlRequest,
                form: {
                  user_fingerprint: shoppingData.client_id,
                  org_latitude: parseFloat(
                    shoppingData.locations.pickup.coordinates.latitude
                  ),
                  org_longitude: parseFloat(
                    shoppingData.locations.pickup.coordinates.longitude
                  ),
                  dest_latitude: parseFloat(
                    shoppingData.locations.dropoff[0].coordinates[0]
                  ),
                  dest_longitude: parseFloat(
                    shoppingData.locations.dropoff[0].coordinates[1]
                  ),
                },
              },
              function (err, response, body) {
                if (err) {
                  logger.error(err);
                  resolve(false);
                }
                //...
                try {
                  body = JSON.parse(body);
                  //Complete the route details
                  RETURN_DATA_TEMPLATE.route_details["eta"] = body["eta"];
                  RETURN_DATA_TEMPLATE.route_details["distance"] =
                    body["distance"];
                  RETURN_DATA_TEMPLATE.route_details["origin"] = body["origin"];
                  //DONE
                  resolve([RETURN_DATA_TEMPLATE]);
                } catch (error) {
                  logger.error(error);
                  resolve(false);
                }
              }
            );
          }
          //?2. ACCEPTED - IN ROUTE TO PICKUP  AND IN ROUTE TO DROP OFF
          else if (
            shoppingData.request_state_vars.isAccepted &&
            // shoppingData.request_state_vars.inRouteToDropoff &&
            shoppingData.request_state_vars.completedDropoff === false
          ) {
            let RETURN_DATA_TEMPLATE = {
              step_name: shoppingData.request_state_vars.inRouteToDropoff
                ? "in_route_to_dropoff"
                : "in_route_to_pickup",
              ride_mode: shoppingData["ride_mode"].toUpperCase(),
              request_fp: shoppingData.request_fp,
              payment_method: shoppingData.payment_method,
              trip_locations: shoppingData.locations,
              passengers: shoppingData.passengers_number,
              ride_style: shoppingData.ride_style,
              fare: shoppingData.totals_request.fare,
              note: shoppingData.request_documentation.note,
              state_vars: shoppingData.request_state_vars,
              driver_details: false,
              route_details: {
                //Will have eta and so on.
              },
              date_requested: shoppingData.date_requested,
            };

            //Get the drivers details
            collection_drivers_shoppers_central
              .find({ driver_fingerprint: shoppingData.shopper_id })
              .toArray(function (err, driverData) {
                if (err) {
                  logger.error(false);
                  resolve(false);
                }
                //...
                if (driverData !== undefined && driverData.length > 0) {
                  //Has a driver
                  driverData = driverData[0];
                  //Complete the drivers details
                  RETURN_DATA_TEMPLATE.driver_details = {
                    name: driverData.name,
                    picture: driverData.identification_data.profile_picture,
                    rating: driverData.identification_data.rating,
                    phone: driverData["phone_number"],
                    vehicle: {
                      picture: driverData.cars_data[0].taxi_picture,
                      brand: driverData.cars_data[0].car_brand,
                      plate_no: driverData.cars_data[0].plate_number,
                      taxi_number: driverData.cars_data[0].taxi_number,
                    },
                  };

                  //! Get the current driver location
                  let driver_details_cached_key = `${driverData.driver_fingerprint}-cached_useful_data`;

                  new Promise((resCompute) => {
                    redisGet(driver_details_cached_key).then((resp) => {
                      if (resp !== null) {
                        //Has some cached data
                        try {
                          resp = JSON.parse(resp);
                          resCompute(
                            resp.operational_state.last_location !== null &&
                              resp.operational_state.last_location !== undefined
                              ? resp.operational_state.last_location.coordinates
                              : false
                          );
                        } catch (error) {
                          logger.error(error);
                          redisCluster.setex(
                            driver_details_cached_key,
                            parseFloat(process.env.REDIS_EXPIRATION_5MIN) * 65,
                            JSON.stringify(driverData)
                          );
                          //...
                          resCompute(
                            driverData.operational_state.last_location !==
                              null &&
                              driverData.operational_state.last_location !==
                                undefined
                              ? driverData.operational_state.last_location
                                  .coordinates
                              : false
                          );
                        }
                      } //Get from mongo and cache
                      else {
                        redisCluster.setex(
                          driver_details_cached_key,
                          parseFloat(process.env.REDIS_EXPIRATION_5MIN) * 65,
                          JSON.stringify(driverData)
                        );
                        //...
                        resCompute(
                          driverData.operational_state.last_location !== null &&
                            driverData.operational_state.last_location !==
                              undefined
                            ? driverData.operational_state.last_location
                                .coordinates
                            : false
                        );
                      }
                    });
                  })
                    .then((driverDataCached) => {
                      //Get the route details
                      let urlRequest = `http://localhost:${process.env.SEARCH_SERVICE_PORT}/getRouteToDestinationSnapshot`;

                      requestAPI.post(
                        {
                          url: urlRequest,
                          form: shoppingData.request_state_vars.inRouteToDropoff
                            ? {
                                user_fingerprint: shoppingData.client_id,
                                org_latitude: parseFloat(
                                  driverDataCached.latitude
                                ),
                                org_longitude: parseFloat(
                                  driverDataCached.longitude
                                ),
                                dest_latitude: parseFloat(
                                  shoppingData.locations.dropoff[0]
                                    .coordinates[0]
                                ),
                                dest_longitude: parseFloat(
                                  shoppingData.locations.dropoff[0]
                                    .coordinates[1]
                                ),
                              }
                            : {
                                user_fingerprint: shoppingData.client_id,
                                org_latitude: parseFloat(
                                  shoppingData.locations.pickup.coordinates
                                    .latitude
                                ),
                                org_longitude: parseFloat(
                                  shoppingData.locations.pickup.coordinates
                                    .longitude
                                ),
                                dest_latitude: parseFloat(
                                  driverDataCached.latitude
                                ),
                                dest_longitude: parseFloat(
                                  driverDataCached.longitude
                                ),
                              },
                        },
                        function (err, response, body) {
                          if (err) {
                            logger.error(err);
                            resolve(false);
                          }
                          //...
                          try {
                            body = JSON.parse(body);
                            //Complete the route details
                            RETURN_DATA_TEMPLATE.route_details = body;
                            //DONE
                            resolve([RETURN_DATA_TEMPLATE]);
                          } catch (error) {
                            logger.error(error);
                            resolve(false);
                          }
                        }
                      );
                    })
                    .catch((error) => {
                      logger.error(error);
                      resolve(false);
                    });
                } //No drivers yet?
                else {
                  resolve(false);
                }
              });
          }
          //?4. RIDE COMPLETED
          else if (
            shoppingData.request_state_vars.completedDropoff &&
            shoppingData.request_state_vars.completedRatingClient == false
          ) {
            let RETURN_DATA_TEMPLATE = {
              step_name: "completed",
              ride_mode: shoppingData["ride_mode"].toUpperCase(),
              request_fp: shoppingData.request_fp,
              payment_method: shoppingData.payment_method,
              trip_locations: shoppingData.locations,
              passengers: shoppingData.passengers_number,
              ride_style: shoppingData.ride_style,
              fare: shoppingData.totals_request.fare,
              note: shoppingData.request_documentation.note,
              state_vars: shoppingData.request_state_vars,
              driver_details: false,
              route_details: {
                //Will have eta and so on.
              },
              date_requested: shoppingData.date_requested,
            };

            //Get the drivers details
            collection_drivers_shoppers_central
              .find({ driver_fingerprint: shoppingData.shopper_id })
              .toArray(function (err, driverData) {
                if (err) {
                  logger.error(false);
                  resolve(false);
                }
                //...
                if (driverData !== undefined && driverData.length > 0) {
                  //Has a driver
                  driverData = driverData[0];
                  //Complete the drivers details
                  RETURN_DATA_TEMPLATE.driver_details = {
                    name: driverData.name,
                    picture: driverData.identification_data.profile_picture,
                    rating: driverData.identification_data.rating,
                    vehicle: {
                      picture: driverData.cars_data[0].taxi_picture,
                      brand: driverData.cars_data[0].car_brand,
                      plate_no: driverData.cars_data[0].plate_number,
                      taxi_number: driverData.cars_data[0].taxi_number,
                    },
                  };

                  //Get the route details
                  let urlRequest = `http://localhost:${process.env.SEARCH_SERVICE_PORT}/getRouteToDestinationSnapshot`;

                  requestAPI.post(
                    {
                      url: urlRequest,
                      form: {
                        user_fingerprint: shoppingData.client_id,
                        org_latitude: parseFloat(
                          shoppingData.locations.pickup.coordinates.latitude
                        ),
                        org_longitude: parseFloat(
                          shoppingData.locations.pickup.coordinates.longitude
                        ),
                        dest_latitude: parseFloat(
                          shoppingData.locations.dropoff[0].coordinates[0]
                        ),
                        dest_longitude: parseFloat(
                          shoppingData.locations.dropoff[0].coordinates[1]
                        ),
                      },
                    },
                    function (err, response, body) {
                      if (err) {
                        logger.error(err);
                        resolve(false);
                      }
                      //...
                      try {
                        body = JSON.parse(body);
                        //Complete the route details
                        RETURN_DATA_TEMPLATE.route_details["eta"] = body["eta"];
                        RETURN_DATA_TEMPLATE.route_details["distance"] =
                          body["distance"];
                        RETURN_DATA_TEMPLATE.route_details["origin"] =
                          body["origin"];
                        //DONE
                        resolve([RETURN_DATA_TEMPLATE]);
                      } catch (error) {
                        logger.error(error);
                        resolve(false);
                      }
                    }
                  );
                } //No drivers yet?
                else {
                  resolve(false);
                }
              });
          } //No request
          else {
            resolve(false);
          }
        }
        //!3. DELIVERY DATA
        else if (shoppingData["ride_mode"].toUpperCase() === "DELIVERY") {
          //Has a pending shopping
          let RETURN_DATA_TEMPLATE = {
            ride_mode: shoppingData["ride_mode"].toUpperCase(),
            request_fp: shoppingData.request_fp,
            client_id: requestData.user_identifier, //the user identifier - requester
            driver_details: {}, //Will hold the details of the shopper
            shopping_list: shoppingData.shopping_list, //The list of items to shop for
            payment_method: shoppingData.payment_method, //mobile_money or cash
            trip_locations: shoppingData.locations, //Has the pickup and delivery locations
            totals_request: shoppingData.totals_request, //Has the cart details in terms of fees
            request_type: shoppingData.request_type, //scheduled or immediate
            state_vars: shoppingData.request_state_vars,
            ewallet_details: {
              phone: "+264856997167",
              security: shoppingData.security.pin,
            },
            date_requested: shoppingData.date_requested, //The time of the request
          };
          //..Get the shopper's infos
          collection_drivers_shoppers_central
            .find({ driver_fingerprint: shoppingData.shopper_id })
            .toArray(function (err, shopperData) {
              if (err) {
                logger.error(false);
                resolve(false);
              }
              //...
              if (shopperData !== undefined && shopperData.length > 0) {
                //Has a shopper
                let driverData = shopperData[0];

                RETURN_DATA_TEMPLATE.driver_details = {
                  name: driverData.name,
                  picture: driverData.identification_data.profile_picture,
                  rating: driverData.identification_data.rating,
                  phone: driverData["phone_number"],
                  vehicle: {
                    picture: driverData.cars_data[0].taxi_picture,
                    brand: driverData.cars_data[0].car_brand,
                    plate_no: driverData.cars_data[0].plate_number,
                    taxi_number: driverData.cars_data[0].taxi_number,
                  },
                };
                //...
                resolve([RETURN_DATA_TEMPLATE]);
              } //No shoppers yet
              else {
                RETURN_DATA_TEMPLATE.driver_details = {
                  name: null,
                  phone: null,
                  picture: null,
                };
                //...
                resolve([RETURN_DATA_TEMPLATE]);
              }
            });
        } //Invalid data
        else {
          resolve(false);
        }
      }

      //No pending shoppings
      else {
        resolve(false);
      }
    });
}

/**
 * @func getFreshUserDataClients
 * Responsible for getting users data and caching it straight from the db
 * @param req: the request data
 * @param redisKey
 * @param resolve
 */
function getFreshUserDataClients(req, redisKey, resolve) {
  //Check that the user is valid
  collection_users_central
    .find({ user_identifier: req.user_identifier })
    .toArray(function (err, userData) {
      if (err) {
        logger.error(err);
        resolve([{ response: [] }]);
      }
      logger.warn(userData);
      //...
      if (userData !== undefined && userData.length > 0) {
        //Valid user
        //?Cache the info
        redisCluster.setex(
          redisKey,
          parseInt(process.env.REDIS_EXPIRATION_5MIN) * 404,
          JSON.stringify(userData)
        );
        //? Standardize
        resolve([
          { response: getOutputStandardizedUserDataFormat(userData[0]) },
        ]);
      } //Invalid user?
      else {
        resolve([{ response: [] }]);
      }
    });
}

//Get output standardazed user data format
//@param userData in JSON
function getOutputStandardizedUserDataFormat(userData) {
  let RETURN_DATA_TEMPLATE = {
    name: userData.name,
    surname: userData.surname,
    gender: userData.gender,
    profile_picture: userData.media.profile_picture,
    account_verifications: {
      is_verified: userData.account_verifications.is_accountVerified,
    },
    phone: userData.phone_number,
    email: userData.email,
    user_identifier: userData.user_identifier,
  };
  //...
  return RETURN_DATA_TEMPLATE;
}

var collection_catalogue_central = null;
var collection_shops_central = null;
var collection_requests_central = null;
var collection_users_central = null;
var collection_drivers_shoppers_central = null;
var collection_cancelled_requests_central = null;

redisCluster.on("connect", function () {
  logger.info("[*] Redis connected");

  //? Check elasticsearch
  ElasticSearch_client.ping(
    {
      requestTimeout: 30000,
    },
    function (error) {
      if (error) {
        logger.error("Error Encountered! Elasticsearch cluster is down");
        logger.warn("Error:", error);
      } else {
        logger.info("[*] Elasticsearch connected");

        MongoClient.connect(
          process.env.DB_URL_MONGODB,
          function (err, clientMongo) {
            if (err) throw err;
            logger.info("[+] Nej service active");
            const dbMongo = clientMongo.db(process.env.DB_NAME_MONGODDB);
            collection_catalogue_central =
              dbMongo.collection("catalogue_central"); //Hold all the product from the catalogue
            collection_shops_central = dbMongo.collection("shops_central"); //Hold all the shops subscribed
            collection_requests_central =
              dbMongo.collection("requests_central"); //Hold all the shopping, ride and delivery requests
            collection_cancelled_requests_central = dbMongo.collection(
              "cancelled_requests_central"
            ); //Hold all the shopping, ride and delivery requests
            collection_users_central = dbMongo.collection("users_central"); //Hold all the users data
            collection_drivers_shoppers_central = dbMongo.collection(
              "drivers_shoppers_central"
            ); //Hold all the shoppers and drivers data

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
                          product.meta.moved_ressources_manifest !==
                            undefined &&
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
                              requestAPI(
                                options,
                                function (error, response, body) {
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
                                          console.log(
                                            "error downloading image to s3"
                                          );
                                          resCompute({
                                            message: "Processed - failed",
                                            index: index,
                                          });
                                        } else {
                                          console.log(
                                            "success uploading to s3"
                                          );
                                          resCompute({
                                            message: "Processed",
                                            index: index,
                                          });
                                        }
                                      }
                                    );
                                  }
                                }
                              );
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
                  req.locations !== null &&
                  req.ride_mode !== undefined &&
                  req.ride_mode !== null
                ) {
                  logger.info(req);
                  let security_pin = otpGenerator.generate(6, {
                    lowerCaseAlphabets: false,
                    upperCaseAlphabets: false,
                    specialChars: false,
                  });
                  //! --------------
                  security_pin =
                    String(security_pin).length < 6
                      ? parseInt(security_pin) * 10
                      : security_pin;

                  try {
                    //! Check if the user has no unconfirmed shoppings
                    let checkUnconfirmed = {
                      client_id: req.user_identifier,
                      "request_state_vars.completedRatingClient": false,
                    };

                    collection_requests_central
                      .find(checkUnconfirmed)
                      .toArray(function (err, prevShopping) {
                        if (err) {
                          logger.error(err);
                          resolve({ response: "unable_to_request" });
                        }
                        //...
                        if (
                          prevShopping !== undefined &&
                          prevShopping.length <= 0
                        ) {
                          //No unconfirmed shopping - okay
                          //! Perform the conversions
                          req.shopping_list =
                            req.shopping_list !== undefined
                              ? JSON.parse(req.shopping_list)
                              : null;
                          req.totals =
                            req.totals !== undefined
                              ? JSON.parse(req.totals)
                              : null;
                          req.locations =
                            req.locations !== undefined
                              ? JSON.parse(req.locations)
                              : null;

                          //...
                          let REQUEST_TEMPLATE = {
                            request_fp: null,
                            client_id: req.user_identifier, //the user identifier - requester
                            shopper_id: false, //The id of the shopper
                            payment_method: req.payment_method, //mobile_money or cash
                            locations: req.locations, //Has the pickup and delivery locations
                            totals_request: req.totals, //Has the cart details in terms of fees
                            request_type: "immediate", //scheduled or immediate
                            request_documentation: {
                              note: req.note,
                            },
                            shopping_list: req.shopping_list, //! The list of items to shop for
                            ride_mode: req.ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                            request_state_vars: {
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
                            security: {
                              pin: security_pin, //Will be used to check the request
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
                              )}${Math.round(
                                new Date(chaineDateUTC).getTime()
                              )}`;
                            })
                            .finally(() => {
                              //?Continue here
                              collection_requests_central.insertOne(
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

            //?6. Request for delivery or ride
            app.post("/requestForRideOrDelivery", function (req, res) {
              new Promise((resolve) => {
                req = req.body;
                //! Check for the user identifier, shopping_list and totals
                //Check basic ride or delivery conditions
                let checkerCondition =
                  req.ride_mode !== undefined &&
                  req.ride_mode !== null &&
                  req.ride_mode == "delivery"
                    ? req.user_identifier !== undefined &&
                      req.user_identifier !== null &&
                      req.dropOff_data !== undefined &&
                      req.dropOff_data !== null &&
                      req.totals !== undefined &&
                      req.totals !== null &&
                      req.pickup_location !== undefined &&
                      req.pickup_location !== null
                    : req.user_identifier !== undefined &&
                      req.user_identifier !== null &&
                      req.dropOff_data !== undefined &&
                      req.dropOff_data !== null &&
                      req.passengers_number !== undefined &&
                      req.passengers_number !== null &&
                      req.pickup_location !== undefined &&
                      req.pickup_location !== null;

                if (checkerCondition) {
                  logger.info(req);
                  let security_pin = otpGenerator.generate(6, {
                    lowerCaseAlphabets: false,
                    upperCaseAlphabets: false,
                    specialChars: false,
                  });
                  //! --------------
                  security_pin =
                    String(security_pin).length < 6
                      ? parseInt(security_pin) * 10
                      : security_pin;

                  try {
                    //! Check if the user has no unconfirmed shoppings
                    let checkUnconfirmed = {
                      client_id: req.user_identifier,
                      "request_state_vars.completedRatingClient": false,
                    };

                    collection_requests_central
                      .find(checkUnconfirmed)
                      .toArray(function (err, prevDelivery) {
                        if (err) {
                          logger.error(err);
                          resolve({ response: "unable_to_request" });
                        }
                        //...
                        if (
                          prevDelivery !== undefined &&
                          prevDelivery.length <= 0
                        ) {
                          //No unconfirmed shopping - okay
                          //! Perform the conversions
                          req.dropOff_data =
                            req.dropOff_data !== undefined
                              ? JSON.parse(req.dropOff_data)
                              : null;
                          req.totals =
                            req.totals !== undefined
                              ? JSON.parse(req.totals)
                              : null;
                          req.pickup_location =
                            req.pickup_location !== undefined
                              ? JSON.parse(req.pickup_location)
                              : null;
                          req.passengers_number =
                            req.passengers_number !== undefined
                              ? parseInt(req.passengers_number)
                              : null;
                          req.areGoingTheSameWay =
                            req.areGoingTheSameWay !== undefined
                              ? req.areGoingTheSameWay === "true"
                              : null;
                          req.ride_selected =
                            req.ride_selected !== undefined
                              ? JSON.parse(req.ride_selected)
                              : null;
                          req.custom_fare =
                            req.custom_fare !== undefined &&
                            req.custom_fare !== "false"
                              ? parseFloat(req.custom_fare)
                              : false;
                          //...
                          let REQUEST_TEMPLATE =
                            req.ride_mode === "delivery"
                              ? {
                                  request_fp: null,
                                  client_id: req.user_identifier, //the user identifier - requester
                                  shopper_id: false, //The id of the shopper
                                  payment_method: req.payment_method, //mobile_money or cash
                                  locations: {
                                    pickup: req.pickup_location, //Has the pickup locations
                                    dropoff: req.dropOff_data, //The list of recipient/riders and their locations
                                  },
                                  totals_request: req.totals, //Has the cart details in terms of fees
                                  request_type: "immediate", //scheduled or immediate
                                  request_documentation: {
                                    note: req.note,
                                  },
                                  ride_mode: req.ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                                  request_state_vars: {
                                    isAccepted: false, //If the shopping request is accepted
                                    inRouteToPickupCash: false, //If the shopper is in route to pickup the cash
                                    didPickupCash: false, //If the shopper picked up the cash
                                    inRouteToDropoff: false, //If the driver is in route to drop the client/package
                                    completedDropoff: false, //If the driver is done trip
                                    completedRatingClient: false, //If the client has completed the rating of the shopped items
                                    rating_data: {
                                      rating: false, //Out of 5
                                      comments: false, //The clients comments
                                      compliments: [], //The service badges
                                    }, //The rating infos
                                  },
                                  security: {
                                    pin: security_pin, //Will be used to check the request
                                  },
                                  date_requested: new Date(chaineDateUTC), //The time of the request
                                  date_pickedup: null, //The time when the driver picked up the  client/package
                                  date_routeToDropoff: null, //The time when the driver started going to drop off the client/package
                                  date_completedDropoff: null, //The time when the driver was done with the ride
                                  date_routeToDropoff: null, //The time when the driver started going to dropoff the client/package
                                  date_clientRatedRide: null, //The time when the client rated the driver
                                }
                              : {
                                  request_fp: null,
                                  client_id: req.user_identifier, //the user identifier - requester
                                  shopper_id: false, //The id of the shopper
                                  payment_method: req.payment_method, //mobile_money or cash
                                  locations: {
                                    pickup: req.pickup_location, //Has the pickup locations
                                    dropoff: req.dropOff_data, //The list of recipient/riders and their locations
                                  },
                                  totals_request: {
                                    fare:
                                      req.custom_fare !== undefined &&
                                      req.custom_fare !== false
                                        ? req.custom_fare
                                        : req.ride_selected.base_fare,
                                  }, //Has the cart details in terms of fees
                                  ride_selected: req.ride_selected, //The type of vehicle selected
                                  request_type: "immediate", //scheduled or immediate
                                  request_documentation: {
                                    note: req.note,
                                  },
                                  passengers_number: req.passengers_number, //the number of passengers
                                  areGoingTheSameWay: req.areGoingTheSameWay, //If all the passengers are going to the same destination or not
                                  ride_style: req.ride_style, //Private or Shared rides
                                  ride_mode: req.ride_mode.toUpperCase().trim(), //ride, delivery or shopping
                                  request_state_vars: {
                                    isAccepted: false, //If the shopping request is accepted
                                    inRouteToPickup: false, //If the driver is in route to pickup the package/client
                                    inRouteToDropoff: false, //If the driver is in route to drop the client/package
                                    completedDropoff: false, //If the driver is done trip
                                    completedRatingClient: false, //If the client has completed the rating of the shopped items
                                    rating_data: {
                                      rating: false, //Out of 5
                                      comments: false, //The clients comments
                                      compliments: [], //The service badges
                                    }, //The rating infos
                                  },
                                  security: {
                                    pin: security_pin, //Will be used to check the request
                                  },
                                  date_requested: new Date(chaineDateUTC), //The time of the request
                                  date_pickedup: null, //The time when the driver picked up the  client/package
                                  date_routeToDropoff: null, //The time when the driver started going to drop off the client/package
                                  date_completedDropoff: null, //The time when the driver was done with the ride
                                  date_routeToDropoff: null, //The time when the driver started going to dropoff the client/package
                                  date_clientRatedRide: null, //The time when the client rated the driver
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
                              )}${Math.round(
                                new Date(chaineDateUTC).getTime()
                              )}`;
                            })
                            .finally(() => {
                              //?Continue here
                              collection_requests_central.insertOne(
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

                if (
                  req.user_identifier !== undefined &&
                  req.user_identifier !== null
                ) {
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
                                  getRequestDataClient(req, resCompute);
                                })
                                  .then((result) => {
                                    //!Cache
                                    redisCluster.setex(
                                      redisKey,
                                      parseInt(
                                        process.env.REDIS_EXPIRATION_5MIN
                                      ) * 100,
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
                                  getRequestDataClient(req, resCompute);
                                })
                                  .then((result) => {
                                    //!Cache
                                    redisCluster.setex(
                                      redisKey,
                                      parseInt(
                                        process.env.REDIS_EXPIRATION_5MIN
                                      ) * 100,
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
                                getRequestDataClient(req, resCompute);
                              })
                                .then((result) => {
                                  //!Cache
                                  redisCluster.setex(
                                    redisKey,
                                    parseInt(
                                      process.env.REDIS_EXPIRATION_5MIN
                                    ) * 100,
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
                              getRequestDataClient(req, resCompute);
                            })
                              .then((result) => {
                                //!Cache
                                redisCluster.setex(
                                  redisKey,
                                  parseInt(process.env.REDIS_EXPIRATION_5MIN) *
                                    100,
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

            //?6. Get the route snapshot for the ride
            app.post("/getRouteToDestinationSnapshot", function (req, res) {
              let urlRequest = `http://localhost:${process.env.SEARCH_SERVICE_PORT}/getRouteToDestinationSnapshot`;

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

            //?7. Get the fares
            app.post("/computeFares", function (req, res) {
              let urlRequest = `http://localhost:${process.env.PRICING_SERVICE_PORT}/computeFares`;

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

            //?8. Submit the rider rating
            app.post("/submitRiderOrClientRating", function (req, res) {
              new Promise((resolve) => {
                req = req.body;

                logger.info(req);

                if (
                  req.request_fp !== undefined &&
                  req.request_fp !== null &&
                  req.rating !== undefined &&
                  req.rating !== null &&
                  req.badges !== undefined &&
                  req.badges !== null &&
                  req.note !== undefined &&
                  req.note !== null &&
                  req.user_fingerprint !== undefined &&
                  req.user_fingerprint !== null
                ) {
                  req.badges = JSON.parse(req.badges);

                  let RATING_DATA = {
                    rating: parseFloat(req.rating),
                    comments: req.note,
                    compliments: req.badges,
                    date_rated: new Date(chaineDateUTC),
                  };

                  //...Check the request
                  //! Can only rate once
                  let requestChecker = {
                    request_fp: req.request_fp,
                    "request_state_vars.completedRatingClient": false,
                  };

                  collection_requests_central
                    .find(requestChecker)
                    .toArray(function (error, requestData) {
                      if (error) {
                        logger.error(error);
                        resolve([{ response: "error" }]);
                      }

                      //...
                      if (requestData !== undefined && requestData.length > 0) {
                        //Valid
                        requestData = requestData[0];

                        let updatedRequestState =
                          requestData.request_state_vars;
                        updatedRequestState["rating_data"] = RATING_DATA;
                        updatedRequestState["completedRatingClient"] = true;

                        collection_requests_central.updateOne(
                          requestChecker,
                          {
                            $set: {
                              request_state_vars: updatedRequestState,
                              date_clientRatedRide: new Date(chaineDateUTC),
                            },
                          },
                          function (err, result) {
                            if (err) {
                              logger.error(err);
                              resolve([{ response: "error" }]);
                            }

                            //...
                            resolve([{ response: "success" }]);
                          }
                        );
                      } //No request?
                      else {
                        resolve([{ response: "error" }]);
                      }
                    });
                } //Invalid data
                else {
                  resolve([{ response: "error" }]);
                }
              })
                .then((result) => {
                  logger.info(result);
                  res.send(result);
                })
                .catch((error) => {
                  logger.error(error);
                  res.send([{ response: "error" }]);
                });
            });

            //?9. Cancel request - user
            app.post("/cancel_request_user", function (req, res) {
              new Promise((resolve) => {
                req = req.body;
                logger.info(req);

                if (
                  req.request_fp !== undefined &&
                  req.request_fp !== null &&
                  req.user_identifier !== undefined &&
                  req.user_identifier !== null
                ) {
                  //Check if there is such request
                  let checkRequest = {
                    request_fp: req.request_fp,
                    client_id: req.user_identifier,
                  };
                  //...
                  collection_requests_central
                    .find(checkRequest)
                    .toArray(function (error, requestData) {
                      if (error) {
                        logger.error(error);
                        resolve([{ response: "error" }]);
                      }
                      //...
                      if (requestData !== undefined && requestData.length > 0) {
                        requestData = requestData[0];
                        //!...Delete and save in the cancelled
                        collection_requests_central.deleteOne(
                          checkRequest,
                          function (err, result) {
                            if (err) {
                              logger.error(err);
                              resolve([{ response: "error" }]);
                            }
                            //....
                            //!add the date cancelled
                            requestData["date_cancelled"] = new Date(
                              chaineDateUTC
                            );
                            collection_cancelled_requests_central.insertOne(
                              requestData,
                              function (err, result) {
                                if (err) {
                                  logger.error(err);
                                  resolve([{ response: "error" }]);
                                }
                                //...
                                resolve([{ response: "success" }]);
                              }
                            );
                          }
                        );
                      } //No request?
                      else {
                        resolve([{ response: "error" }]);
                      }
                    });
                } //Invalid data
                else {
                  resolve([{ response: "error" }]);
                }
              })
                .then((result) => {
                  logger.info(result);
                  res.send(result);
                })
                .catch((error) => {
                  logger.error(error);
                  res.send([{ response: "error" }]);
                });
            });

            //?10. Search for stores
            // app.post("/searchForStores", function(req, res) {
            //   new Promise((resolve) => {
            //     new promises((resIndices) => {
            //       let index_name = 'stores';
            //       checkIndices(index_name, resIndices);
            //     })
            //     .then((result) => {
            //       if(result)  //All good
            //       {

            //       }
            //       else  //There was a problem
            //       {
            //         resolve({ response: [] });
            //       }
            //     }).catch((error) => {
            //       logger.error(error);
            //       resolve({ response: [] });
            //     })
            //   })
            //   .then((result) => {
            //     logger.info(result);
            //     res.send(result);
            //   })
            //   .catch((error) => {
            //     logger.error(error);
            //     res.send({ response: [] });
            //   });
            // })

            //?11. get the list of requests for riders
            app.post("/getRequestListRiders", function (req, res) {
              new Promise((resolve) => {
                req = req.body;

                if (
                  req.user_identifier !== undefined &&
                  req.user_identifier !== null
                ) {
                  let redisKey = `${req.user_identifier}-requestListCached`;

                  collection_requests_central
                    .find({ client_id: req.user_identifier })
                    .sort({ date_requested: -1 })
                    .toArray(function (err, requestData) {
                      if (err) {
                        logger.error(err);
                        resolve({ response: [] });
                      }
                      logger.info(requestData);
                      //...
                      if (requestData !== undefined && requestData.length > 0) {
                        //Has some requests
                        let RETURN_DATA_TEMPLATE = [];

                        requestData.map((request) => {
                          let tmpRequest = {
                            request_type: request.ride_mode,
                            date_requested: request.date_requested,
                            locations: request.locations,
                            shopping_list:
                              request.ride_mode.toLowerCase() === "shopping"
                                ? request.shopping_list
                                : null,
                          };
                          //...Save
                          RETURN_DATA_TEMPLATE.push(tmpRequest);
                        });
                        //...
                        resolve({ response: RETURN_DATA_TEMPLATE });
                      } //No requests
                      else {
                        resolve({ response: [] });
                      }
                    });
                } //Invalid data
                else {
                  resolve({ response: [] });
                }
              })
                .then((result) => {
                  logger.info(result);
                  res.send(result);
                })
                .catch((error) => {
                  logger.error(error);
                  res.send({ response: [] });
                });
            });

            //?12. Update the users information
            app.post("/updateUsersInformation", function (req, res) {
              new Promise((resolve) => {
                req = req.body;
                logger.info(req);

                if (
                  req.user_identifier !== undefined &&
                  req.user_identifier !== null &&
                  req.data_type !== undefined &&
                  req.data_type !== null &&
                  req.data_value !== undefined &&
                  req.data_value !== null
                ) {
                  //!Check the user
                  switch (req.data_type) {
                    case "name":
                      //Update the name
                      collection_users_central.updateOne(
                        { user_identifier: req.user_identifier },
                        { $set: { name: req.data_value } },
                        function (err, result) {
                          if (err) {
                            logger.error(err);
                            resolve({ response: "error" });
                          }
                          //...Success
                          resolve({ response: "success" });
                        }
                      );
                      break;
                    case "surname":
                      //Update the surname
                      collection_users_central.updateOne(
                        { user_identifier: req.user_identifier },
                        { $set: { surname: req.data_value } },
                        function (err, result) {
                          if (err) {
                            logger.error(err);
                            resolve({ response: "error" });
                          }
                          //...Success
                          resolve({ response: "success" });
                        }
                      );
                      break;
                    case "email":
                      //Update the email
                      collection_users_central.updateOne(
                        { user_identifier: req.user_identifier },
                        { $set: { email: req.data_value } },
                        function (err, result) {
                          if (err) {
                            logger.error(err);
                            resolve({ response: "error" });
                          }
                          //...Success
                          resolve({ response: "success" });
                        }
                      );
                    case "gender":
                      //Update the gender
                      collection_users_central.updateOne(
                        { user_identifier: req.user_identifier },
                        { $set: { gender: req.data_value } },
                        function (err, result) {
                          if (err) {
                            logger.error(err);
                            resolve({ response: "error" });
                          }
                          //...Success
                          resolve({ response: "success" });
                        }
                      );
                      break;
                    case "phone":
                      //Update the phone
                      collection_users_central.updateOne(
                        { user_identifier: req.user_identifier },
                        { $set: { phone_number: req.data_value } },
                        function (err, result) {
                          if (err) {
                            logger.error(err);
                            resolve({ response: "error" });
                          }
                          //...Success
                          resolve({ response: "success" });
                        }
                      );
                      break;
                    default:
                      resolve({ response: "error" });
                      break;
                  }
                } //Invalid data
                else {
                  resolve({ response: "error" });
                }
              })
                .then((result) => {
                  logger.info(result);
                  if (result.response == "success") {
                    //- update the cached data
                    let redisKey = `${req.user_identifier}-cachedProfile-data`;
                    collection_users_central
                      .find({ user_identifier: req.user_identifier })
                      .toArray(function (err, userData) {
                        if (err) {
                          logger.error(err);
                          res.send({ response: "error" });
                        }
                        //...
                        if (userData !== undefined && userData.length > 0) {
                          //Valid info
                          redisCluster.setex(
                            redisKey,
                            parseInt(process.env.REDIS_EXPIRATION_5MIN) * 404,
                            JSON.stringify(userData)
                          );
                          //...
                          res.send({ response: "success" });
                        } //No valid user
                        else {
                          res.send({ response: "error" });
                        }
                      });
                  } //!error
                  else {
                    res.send({ response: "error" });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  res.send({ response: "error" });
                });
            });

            //?13. Get the user data
            app.post("/getGenericUserData", function (req, res) {
              new Promise((resolve) => {
                req = req.body;

                if (
                  req.user_identifier !== undefined &&
                  req.user_identifier !== null
                ) {
                  let redisKey = `${req.user_identifier}-cachedProfile-data`;

                  redisGet(redisKey)
                    .then((resp) => {
                      if (resp !== null) {
                        try {
                          resp = JSON.parse(resp);
                          resolve([
                            {
                              response: getOutputStandardizedUserDataFormat(
                                resp[0]
                              ),
                            },
                          ]);
                        } catch (error) {
                          //?Get fresh data and cache
                          logger.error(error);
                          new Promise((resCompute) => {
                            getFreshUserDataClients(req, redisKey, resCompute);
                          })
                            .then((result) => {
                              resolve(result);
                            })
                            .catch((error) => {
                              logger.error(error);
                              resolve([{ response: [] }]);
                            });
                        }
                      } //No cached data
                      else {
                        new Promise((resCompute) => {
                          getFreshUserDataClients(req, redisKey, resCompute);
                        })
                          .then((result) => {
                            resolve(result);
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve([{ response: [] }]);
                          });
                      }
                    })
                    .catch((error) => {
                      //?Get fresh data and cache
                      logger.error(error);
                      new Promise((resCompute) => {
                        getFreshUserDataClients(req, redisKey, resCompute);
                      })
                        .then((result) => {
                          resolve(result);
                        })
                        .catch((error) => {
                          logger.error(error);
                          resolve([{ response: [] }]);
                        });
                    });
                } //Invalid data
                else {
                  resolve([{ response: [] }]);
                }
              })
                .then((result) => {
                  // logger.info(result);
                  res.send(result);
                })
                .catch((error) => {
                  logger.error(error);
                  res.send({ response: [] });
                });
            });
          }
        );
      }
    }
  );
});

server.listen(process.env.SERVER_MOTHER_PORT);
