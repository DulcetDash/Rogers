require("dotenv").config();
//require("newrelic");
var express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const MongoClient = require("mongodb").MongoClient;
var fastFilter = require("fast-filter");
const FuzzySet = require("fuzzyset");
const crypto = require("crypto");
var otpGenerator = require("otp-generator");
var elasticsearch = require("elasticsearch");

const { logger } = require("./LogService");
const { sendSMS } = require("./SendSMS");
const AWS = require("aws-sdk");
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_S3_ID,
  secretAccessKey: process.env.AWS_S3_SECRET,
});

var app = express();
var server = http.createServer(app);
var cors = require("cors");
var helmet = require("helmet");
const requestAPI = require("request");

//! Attach DynamoDB helper
const {
  dynamo_insert,
  dynamo_update,
  dynamo_find_query,
  dynamo_delete,
  dynamo_get_all,
} = require("./DynamoServiceManager");
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
  hosts: [process.env.ELASTICSEARCH_ENDPOINT],
});

var chaineDateUTC = null;
var dateObject = null;
const moment = require("moment");
const { equal } = require("assert");
const { Logger } = require("mongodb/lib/core");

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

var AWS_SMS = require("aws-sdk");

function SendSMSTo(phone_number, message) {
  // Load the AWS SDK for Node.js
  AWS_SMS.config.update({ region: "us-east-1" });

  // Create publish parameters
  var params = {
    Message: "TEXT_MESSAGE" /* required */,
    PhoneNumber: "264856997167",
    // attributes: {
    //   SMSType: "Transactional",
    // },
  };

  // Create promise and SNS service object
  return new AWS_SMS.SNS({
    apiVersion: "2010-03-31",
    // sslEnabled: false,
    // maxRetries: 10,
  })
    .publish(params)
    .promise();

  // Handle promise's fulfilled/rejected states
  // publishTextPromise
  //   .then(function (data) {
  //     console.log("MessageID is " + data.MessageId);
  //   })
  //   .catch(function (err) {
  //     console.error(err, err.stack);
  //   });

  // Set region
  // AWS_SMS.config.update({ region: "us-east-1" });

  // // Create publish parameters
  // var params = {
  //   Message: message /* required */,
  //   PhoneNumber: phone_number,
  // };

  // // Create promise and SNS service object
  // var publishTextPromise = new AWS_SMS.SNS({ apiVersion: "2010-03-31" })
  //   .publish(params)
  //   .promise();

  // // Handle promise's fulfilled/rejected states
  // publishTextPromise
  //   .then(function (data) {
  //     logger.info("MessageID is " + data.MessageId);
  //   })
  //   .catch(function (err) {
  //     console.error(err);
  //   });
}

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
  dynamo_get_all("shops_central")
    .then((storesData) => {
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
              parseInt(
                store.opening_time.split(":")[1].replace(/^0/, "").trim()
              ); //All in minutes
            let store_closing_ref =
              parseInt(
                store.closing_time.split(":")[0].replace(/^0/, "").trim()
              ) *
                60 +
              parseInt(
                store.closing_time.split(":")[1].replace(/^0/, "").trim()
              ); //All in minutes
            //...
            let ref_time =
              new Date(chaineDateUTC).getHours() * 60 +
              new Date(chaineDateUTC).getMinutes();

            if (
              ref_time >= store_opening_ref &&
              ref_time <= store_closing_ref
            ) {
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
        redisCluster.setex(
          redisKey,
          parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
          JSON.stringify(STORES_MODEL)
        );
        resolve({ response: STORES_MODEL });
      } //No stores
      else {
        resolve({ response: [] });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: [] });
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
  dynamo_find_query({
    table_name: "shops_central",
    IndexName: "shop_fp",
    KeyConditionExpression: "shop_fp = :val1",
    ExpressionAttributeValues: {
      ":val1": req.store,
    },
  })
    .then((storeData) => {
      if (storeData !== undefined && storeData.length > 0) {
        logger.info(storeData);
        //Found
        storeData = storeData[0];

        let reformulateQuery =
          req.category !== undefined
            ? {
                table_name: "catalogue_central",
                IndexName: "shop_fp",
                KeyConditionExpression: "shop_fp = :val1",
                FilterExpression: "#m.#s = :val2 and #m.#c = :val3",
                ExpressionAttributeValues: {
                  ":val1": req.store,
                  ":val2": storeData.name.toUpperCase().trim(),
                  ":val3": req.category.toUpperCase().trim(),
                },
                ExpressionAttributeNames: {
                  "#m": "meta",
                  "#s": "shop_name",
                  "#c": "category",
                },
              }
            : {
                table_name: "catalogue_central",
                IndexName: "shop_fp",
                KeyConditionExpression: "shop_fp = :val1",
                FilterExpression: "#m.#s = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.store,
                  ":val2": storeData.name.toUpperCase().trim(),
                },
                ExpressionAttributeNames: {
                  "#m": "meta",
                  "#s": "shop_name",
                },
              };
        //! Add subcategory
        reformulateQuery =
          req.subcategory !== undefined
            ? {
                table_name: "catalogue_central",
                IndexName: "shop_fp",
                KeyConditionExpression: "shop_fp = :val1",
                FilterExpression:
                  "#m.#s = :val2 and #m.#c = :val3 and #m.#sub = :val4",
                ExpressionAttributeValues: {
                  ":val1": req.store,
                  ":val2": storeData.name.toUpperCase().trim(),
                  ":val3": req.category.toUpperCase().trim(),
                  ":val4": req.subcategory.toUpperCase().trim(),
                },
                ExpressionAttributeNames: {
                  "#m": "meta",
                  "#s": "shop_name",
                  "#c": "category",
                  "#sub": "subcategory",
                },
              }
            : reformulateQuery;
        //! Cancel all the filtering - if a structured argument is set
        reformulateQuery =
          req.structured !== undefined && req.structured === "true"
            ? {
                table_name: "catalogue_central",
                IndexName: "shop_fp",
                KeyConditionExpression: "shop_fp = :val1",
                FilterExpression: "#m.#s = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.store,
                  ":val2": storeData.name.toUpperCase().trim(),
                },
                ExpressionAttributeNames: {
                  "#m": "meta",
                  "#s": "shop_name",
                },
              }
            : reformulateQuery;

        logger.warn(reformulateQuery);

        dynamo_find_query(reformulateQuery)
          .then((productsData) => {
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
                  redisCluster.setex(
                    redisKey,
                    parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
                    JSON.stringify(final)
                  );
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
          })
          .catch((error) => {
            logger.warn("Here");
            logger.error(error);
            resolve({ response: {}, store: req.store });
          });
      } //Invalid store
      else {
        resolve({ response: {}, store: req.store });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: {}, store: req.store });
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
 * ! do not forget the store_fp
 * @param req: request meta (store, key)
 * @param resolve
 */
function searchProductsFor(req, resolve) {
  let redisKey = `${req.store}-${req.key}-productFiltered`;

  // new Promise((resCompute) => {
  //   execSearchProductsFor(req, redisKey, resCompute);
  // })
  //   .then((result) => {
  //     resolve(result);
  //   })
  //   .catch((error) => {
  //     logger.error(error);
  //     resolve({ response: [] });
  //   });

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
  resolveDate();
  logger.info(req);
  //1. Get all the  product from the store
  let checkQuery =
    req.category !== null && req.category !== undefined
      ? {
          table_name: "catalogue_central",
          IndexName: "shop_fp",
          KeyConditionExpression: "shop_fp = :val1",
          FilterExpression: "#m.#s = :val2 and #m.#c = :val3",
          ExpressionAttributeValues: {
            ":val1": req.store_fp,
            ":val2": req.store,
            ":val3": req.category,
          },
          ExpressionAttributeNames: {
            "#m": "meta",
            "#s": "shop_name",
            "#c": "category",
          },
        }
      : req.subcategory !== null && req.subcategory !== undefined
      ? {
          table_name: "catalogue_central",
          IndexName: "shop_fp",
          KeyConditionExpression: "shop_fp = :val1",
          FilterExpression: "#m.#sub = :val2",
          ExpressionAttributeValues: {
            ":val1": req.store_fp,
            ":val2": req.subcategory,
          },
          ExpressionAttributeNames: {
            "#m": "meta",
            "#sub": "subcategory",
          },
        }
      : req.category !== null &&
        req.category !== undefined &&
        req.subcategory !== null &&
        req.subcategory !== undefined
      ? {
          table_name: "catalogue_central",
          IndexName: "shop_fp",
          KeyConditionExpression: "shop_fp = :val1",
          FilterExpression:
            "#m.#s = :val2 AND #m.#c = :val3 AND #m.#sub = :val4",
          ExpressionAttributeValues: {
            ":val1": req.store_fp,
            ":val2": req.store,
            ":val3": req.category,
            ":val4": req.subcategory,
          },
          ExpressionAttributeNames: {
            "#m": "meta",
            "#s": "shop_name",
            "#c": "category",
            "#sub": "subcategory",
          },
        }
      : {
          table_name: "catalogue_central",
          IndexName: "shop_fp",
          KeyConditionExpression: "shop_fp = :val1",
          FilterExpression: "#m.#s = :val2",
          ExpressionAttributeValues: {
            ":val1": req.store_fp,
            ":val2": req.store,
          },
          ExpressionAttributeNames: {
            "#m": "meta",
            "#s": "shop_name",
          },
        };

  dynamo_find_query(checkQuery)
    .then((productsAll) => {
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
                            // console.log(ordered);
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
            redisCluster.setex(
              redisKey,
              parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
              JSON.stringify(final)
            );
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
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: [] });
    });
}

/**
 * @func getRequestDataClient
 * responsible for getting the realtime shopping requests for clients.
 * @param requestData: user_identifier mainly
 * @param resolve
 */
function getRequestDataClient(requestData, resolve) {
  dynamo_find_query({
    table_name: "requests_central",
    IndexName: "client_id",
    KeyConditionExpression: "client_id = :val1",
    FilterExpression: "#r.#c = :val2",
    ExpressionAttributeValues: {
      ":val1": requestData.user_identifier,
      ":val2": false,
    },
    ExpressionAttributeNames: {
      "#r": "request_state_vars",
      "#c": "completedRatingClient",
    },
  })
    .then((shoppingData) => {
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
              security:
                shoppingData.security !== undefined &&
                shoppingData.security !== null
                  ? shoppingData.security.pin
                  : "None",
            },
            date_requested: shoppingData.date_requested, //The time of the request
          };
          //..Get the shopper's infos
          dynamo_find_query({
            table_name: "drivers_shoppers_central",
            IndexName: "driver_fingerprint",
            KeyConditionExpression: "driver_fingerprint = :val1",
            ExpressionAttributeValues: {
              ":val1": shoppingData.shopper_id,
            },
          })
            .then((shopperData) => {
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
            })
            .catch((error) => {
              logger.error(error);
              resolve(false);
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
            dynamo_find_query({
              table_name: "drivers_shoppers_central",
              IndexName: "driver_fingerprint",
              KeyConditionExpression: "driver_fingerprint = :val1",
              ExpressionAttributeValues: {
                ":val1": shoppingData.shopper_id,
              },
            })
              .then((driverData) => {
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
              })
              .catch((error) => {
                logger.error(error);
                resolve(false);
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
            dynamo_find_query({
              table_name: "drivers_shoppers_central",
              IndexName: "driver_fingerprint",
              KeyConditionExpression: "driver_fingerprint = :val1",
              ExpressionAttributeValues: {
                ":val1": shoppingData.shopper_id,
              },
            })
              .then((driverData) => {
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
              })
              .catch((error) => {
                logger.error(error);
                resolve(false);
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
          dynamo_find_query({
            table_name: "drivers_shoppers_central",
            IndexName: "driver_fingerprint",
            KeyConditionExpression: "driver_fingerprint = :val1",
            ExpressionAttributeValues: {
              ":val1": shoppingData.shopper_id,
            },
          })
            .then((shopperData) => {
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
            })
            .catch((error) => {
              logger.error(error);
              resolve(false);
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
    })
    .catch((error) => {
      logger.error(error);
      resolve(false);
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
  dynamo_find_query({
    table_name: "users_central",
    IndexName: "user_identifier",
    KeyConditionExpression: "user_identifier = :val1",
    ExpressionAttributeValues: {
      ":val1": req.user_identifier,
    },
  })
    .then((userData) => {
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
    })
    .catch((error) => {
      logger.error(error);
      resolve([{ response: [] }]);
    });
}

//Get output standardazed user data format
//@param userData in JSON
function getOutputStandardizedUserDataFormat(userData) {
  let RETURN_DATA_TEMPLATE = {
    name: userData.name,
    surname: userData.surname,
    gender: userData.gender,
    account_state: userData.account_state,
    profile_picture: `${process.env.AWS_S3_CLIENTS_PROFILES_PATH}/clients_profiles/${userData.media.profile_picture}`,
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

/**
 * @func shouldSendNewSMS
 * Responsible for figuring out if the system is allowed to send new SMS to a specific number
 * based on the daily limit that the number has ~ 10SMS per day.
 * @param req: the request data containing the user's phone number : ATTACH THE _id if HAS AN ACCOUNT
 * @param hasAccount: true (is an existing user) or false (do not have an account yet)
 * @param resolve
 */
function shouldSendNewSMS({ req, hasAccount, resolve }) {
  const DAILY_THRESHOLD = parseInt(process.env.DAILY_SMS_THRESHOLD_PER_USER);

  resolveDate();
  let refDate = new Date(chaineDateUTC);
  let today_beginning = `${refDate.getFullYear()}-${
    refDate.getMonth() + 1 > 10
      ? refDate.getMonth() + 1
      : `0${refDate.getMonth() + 1}`
  }-${refDate.getDate()}T00:00:00.000Z`;
  let today_end = `${refDate.getFullYear()}-${
    refDate.getMonth() + 1 > 10
      ? refDate.getMonth() + 1
      : `0${refDate.getMonth() + 1}`
  }-${refDate.getDate()}T21:59:59.000Z`;
  //Check how many SMS were sent to this specific number today
  dynamo_find_query({
    table_name: "otp_dispatch_map",
    IndexName: "phone_number",
    KeyConditionExpression:
      "phone_number = :val1 AND date_sent BETWEEN :start_date AND :end_date",
    ScanIndexForward: false,
    ExpressionAttributeValues: {
      ":val1": req.phone,
      ":start_date": today_beginning,
      ":end_date": today_end,
    },
  })
    .then((otpData) => {
      logger.error(otpData);
      if (otpData !== undefined && otpData.length < DAILY_THRESHOLD) {
        //Can still send the SMS
        //? SEND OTP AND UPDATE THE RECORDS
        let onlyDigitsPhone = req.phone.replace("+", "").trim();
        let otp = otpGenerator.generate(5, {
          lowerCaseAlphabets: false,
          upperCaseAlphabets: false,
          specialChars: false,
        });
        //! --------------
        //let otp = 55576;
        otp = String(otp).length < 5 ? parseInt(otp) * 10 : otp;
        new Promise((res0) => {
          let message = otp + ` is your NEJ Verification Code.`;

          let urlSMS = `http://localhost:9393/?message=${message}&number=${onlyDigitsPhone}&subject=TEST`;
          requestAPI(urlSMS, function (error, response, body) {
            if (error === null) {
              //Success
              console.log(body);
              res0(true);
            } //Unable to send SMS
            else {
              res0(true);
            }
          });
          // res0(true);
        }).then(
          () => {
            //1. Update the records for the OTP MAP for registered or non registered users
            new Promise((resUpdateOTPMAP) => {
              let basicOTPMAP_data = {
                phone_number: req.phone,
                otp: parseInt(otp),
                date_sent: new Date(chaineDateUTC).toISOString(),
              };
              //...
              dynamo_insert("otp_dispatch_map", basicOTPMAP_data)
                .then((reslt) => {
                  logger.info(reslt);
                  resUpdateOTPMAP(true);
                })
                .catch((error) => {
                  logger.error(error);
                  resUpdateOTPMAP(false);
                });
            })
              .then()
              .catch((error) => logger.error(error));

            //? Update the user's profile if has an account
            if (hasAccount) {
              logger.warn("USER HAS AN ACCOUNT.");
              dynamo_update({
                table_name: "users_central",
                _idKey: req._id,
                UpdateExpression: "set #a.#p = :val1",
                ExpressionAttributeValues: {
                  ":val1": {
                    otp: parseInt(otp),
                    date_sent: new Date(chaineDateUTC).toISOString(),
                  },
                },
                ExpressionAttributeNames: {
                  "#a": "account_verifications",
                  "#p": "phone_verification_secrets",
                },
              })
                .then((result) => {
                  logger.info(result);
                  resolve(result);
                })
                .catch((error) => {
                  logger.error(error);
                  resolve(false);
                });
            } //No accounts
            else {
              logger.warn("USER HAS NOT AN ACCOUNT.");
              //Done
              resolve(true);
            }
          },
          (error) => {
            logger.info(error);
            resolve(false);
          }
        );
      } //!Exceeded the daily SMS request
      else {
        resolve(false);
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve(false);
    });
}

/**
 * @func isUserValid
 * Responsible for checking if a user account is valid or not based on the Primary key
 * which is in this case the user_identifier.
 * @param user_identifier
 * @param resolve
 */
function isUserValid(user_identifier, resolve) {
  dynamo_find_query({
    table_name: "users_central",
    IndexName: "user_identifier",
    KeyConditionExpression: "user_identifier = :val1",
    ExpressionAttributeValues: {
      ":val1": user_identifier,
    },
  })
    .then((result) => {
      resolve({
        status: result !== undefined && result.length > 0,
        _id: result !== undefined && result.length > 0 ? result[0]._id : null,
      });
    })
    .catch((error) => {
      logger.error(error);
      resolve({ status: false, _id: null });
    });
}

/**
 * @func getRecentlyVisitedShops
 * Responsible to get the 3 latest visited shops by the user
 * @param req: the request data including the user_identifier
 * @param redisKey: the redis key to which the results will be cached.
 * @param resolve
 */
function getRecentlyVisitedShops(req, redisKey, resolve) {
  //1. Get all the requests made by the user
  dynamo_find_query({
    table_name: "requests_central",
    IndexName: "client_id",
    KeyConditionExpression: "client_id = :val1",
    ExpressionAttributeValues: {
      ":val1": req.user_identifier,
    },
  })
    .then((requestData) => {
      // logger.warn(requestData);
      if (requestData !== undefined && requestData.length > 0) {
        //Has some requests
        //?1. Reformat the dates
        requestData = requestData.map((request) => {
          request.date_requested = new Date(request.date_requested);
          return request;
        });
        //?2. Sort in descending order
        requestData.sort((a, b) =>
          a.date_requested > b.date_requested
            ? -1
            : b.date_requested > a.date_requested
            ? 1
            : 0
        );
        //?3. Only take the shopping requests
        requestData = requestData.filter(
          (el) => el.ride_mode.toLowerCase().trim() === "shopping"
        );
        //?4. Only take the 2 first
        requestData = requestData.slice(0, 1);

        //! Get the stores
        let parentPromises = requestData.map((request) => {
          return new Promise((resGetStores) => {
            dynamo_find_query({
              table_name: "shops_central",
              IndexName: "shop_fp",
              KeyConditionExpression: "shop_fp = :val1",
              ExpressionAttributeValues: {
                ":val1": request.shopping_list[0].meta.store_fp,
              },
            })
              .then((storeData) => {
                if (storeData !== undefined && storeData !== null) {
                  //Found the store
                  store = storeData[0];
                  //...
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
                    date_requested_from_here: request.date_requested,
                  };
                  //...
                  resGetStores(tmpStore);
                } //Did not finf the store? - deleted, suspended or?
                else {
                  resGetStores(false);
                }
              })
              .catch((error) => {
                logger.error(error);
                resGetStores(false);
              });
          });
        });

        Promise.all(parentPromises)
          .then((resultStores) => {
            //!5. Remove the false values
            resultStores = resultStores.filter((el) => el !== false);
            //?6. Sort based on when the user requested from here
            resultStores.sort((a, b) =>
              a.date_requested_from_here > b.date_requested_from_here
                ? -1
                : b.date_requested_from_here > a.date_requested_from_here
                ? 1
                : 0
            );
            //?7. Cache
            let response = { response: resultStores };
            redisCluster.setex(
              redisKey,
              parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
              JSON.stringify(response)
            );
            //?3. DONE
            resolve(response);
          })
          .catch((error) => {
            logger.error(error);
            let response = { response: [] };
            //Cache
            redisCluster.setex(
              redisKey,
              parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
              JSON.stringify(response)
            );
            resolve(response);
          });
      } //No requests
      else {
        let response = { response: [] };
        //Cache
        redisCluster.setex(
          redisKey,
          parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
          JSON.stringify(response)
        );
        resolve(response);
      }
    })
    .catch((error) => {
      logger.error(error);
      let response = { response: [] };
      //Cache
      redisCluster.setex(
        redisKey,
        parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
        JSON.stringify(response)
      );
      resolve(response);
    });
}

/**
 * @func getRequestListDataUsers
 * Responsible for getting the request list for the users
 * @param req: the request data including the user_identifier
 * @param redisKey: the redis key to which the valid results will be cached
 * @param resolve
 */
function getRequestListDataUsers(req, redisKey, resolve) {
  dynamo_find_query({
    table_name: "requests_central",
    IndexName: "client_id",
    KeyConditionExpression: "client_id = :val1",
    ExpressionAttributeValues: {
      ":val1": req.user_identifier,
    },
  })
    .then((requestData) => {
      logger.error(requestData);
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
        let response = { response: RETURN_DATA_TEMPLATE };
        //Cache
        redisCluster.setex(
          redisKey,
          parseInt(process.env.REDIS_EXPIRATION_5MIN) * 400,
          JSON.stringify(response)
        );
        resolve(response);
      } //No requests
      else {
        resolve({ response: [] });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: [] });
    });
}

/**
 * @func updateRidersPushNotifToken
 * Responsible for updating the push notification token for the riders only
 * @param req: request data
 * @param redisKey: the key to cache the  data  to
 * @param resolve
 */
function updateRidersPushNotifToken(req, redisKey, resolve) {
  resolveDate();
  //Get the user data first
  dynamo_find_query({
    table_name: "users_central",
    IndexName: "user_identifier",
    KeyConditionExpression: "user_identifier = :val1",
    ExpressionAttributeValues: {
      ":val1": req.user_identifier,
    },
  })
    .then((userData) => {
      if (userData !== undefined && userData.length > 0) {
        //Valid user
        userData = userData[0];

        //?Update the records
        dynamo_update({
          table_name: "users_central",
          _idKey: userData._id,
          UpdateExpression: "set pushnotif_token = :val1, last_updated = :val2",
          ExpressionAttributeValues: {
            ":val1": req.pushnotif_token,
            ":val2": new Date(chaineDateUTC).toISOString(),
          },
        }).then((result) => {
          if (result) {
            //Success
            //! Cache
            redisCluster.setex(
              redisKey,
              parseInt(process.env.REDIS_EXPIRATION_5MIN) * 405,
              JSON.stringify(req.pushnotif_token)
            );
            //...
            resolve({ response: "success" });
          } //failed
          else {
            resolve({ response: "error" });
          }
        });
      } //Not a user?
      else {
        resolve({ response: "error" });
      }
    })
    .catch((error) => {
      logger.error(error);
      resolve({ response: "error" });
    });
}

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
        logger.info("[+] Nej service active");
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
        //?1. Get all the available stores in the app.
        //? EFFIENCY A
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
        //? EFFIENCY A
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
        //? EFFIENCY A
        app.post("/getResultsForKeywords", function (req, res) {
          req = req.body;
          if (
            req.key !== undefined &&
            req.key !== null &&
            req.store !== undefined &&
            req.store !== null &&
            req.store_fp !== undefined &&
            req.store_fp !== null
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
          // collection_catalogue_central
          //   .find({})
          //   .toArray(function (err, productsData) {
          //     if (err) {
          //       logger.error(err);
          //       res.send({ response: "error", flag: err });
          //     }
          //     //...
          //     if (productsData !== undefined && productsData.length > 0) {
          //       //Has some products
          //       let parentPromises = productsData.map((product, index) => {
          //         return new Promise((resolve) => {
          //           //Get the array of images
          //           let arrayImages = product.product_picture;
          //           //Get the transition manifest
          //           //? Looks like {'old_image_name_external_url': new_image_name_url}
          //           console.log(arrayImages);
          //           let transition_manifest =
          //             product.meta.moved_ressources_manifest !==
          //               undefined &&
          //             product.meta.moved_ressources_manifest !== null
          //               ? product.meta.moved_ressources_manifest
          //               : {};
          //           let parentPromises2 = arrayImages.map((picture) => {
          //             return new Promise((resCompute) => {
          //               if (
          //                 transition_manifest[picture] !== undefined &&
          //                 transition_manifest[picture] !== null
          //               ) {
          //                 //!Was moved
          //                 //Already processed
          //                 resCompute({
          //                   message: "Already processed",
          //                   index: index,
          //                 });
          //               } //!Not moved yet - move
          //               else {
          //                 let options = {
          //                   uri: picture,
          //                   encoding: null,
          //                 };
          //                 requestAPI(
          //                   options,
          //                   function (error, response, body) {
          //                     if (error || response.statusCode !== 200) {
          //                       console.log("failed to get image");
          //                       console.log(error);
          //                       resCompute({
          //                         message: "Processed - failed",
          //                         index: index,
          //                       });
          //                     } else {
          //                       logger.info("Got the image");
          //                       s3.putObject(
          //                         {
          //                           Body: body,
          //                           Key: path,
          //                           Bucket: "bucket_name",
          //                         },
          //                         function (error, data) {
          //                           if (error) {
          //                             console.log(
          //                               "error downloading image to s3"
          //                             );
          //                             resCompute({
          //                               message: "Processed - failed",
          //                               index: index,
          //                             });
          //                           } else {
          //                             console.log(
          //                               "success uploading to s3"
          //                             );
          //                             resCompute({
          //                               message: "Processed",
          //                               index: index,
          //                             });
          //                           }
          //                         }
          //                       );
          //                     }
          //                   }
          //                 );
          //               }
          //             });
          //           });
          //           //? Done with this
          //           Promise.all(parentPromises2)
          //             .then((result) => {
          //               resolve(result);
          //             })
          //             .catch((error) => {
          //               logger.error(error);
          //               resolve({ response: "error_processing" });
          //             });
          //         });
          //       });
          //       //! DONE
          //       Promise.all(parentPromises)
          //         .then((result) => {
          //           res.send({ response: result });
          //         })
          //         .catch((error) => {
          //           logger.error(error);
          //           res.send({ response: "unable_to_work", flag: error });
          //         });
          //     } //No products
          //     else {
          //       res.send({ response: "no_products_found" });
          //     }
          //   });
        });

        //?5. Get the user location geocoded
        //? EFFIENCY A
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
        //? EFFIENCY A
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
        //? EFFIENCY A
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

                dynamo_find_query({
                  table_name: "requests_central",
                  IndexName: "client_id",
                  KeyConditionExpression: "client_id = :val1",
                  FilterExpression: "#r.#c = :val2",
                  ExpressionAttributeValues: {
                    ":val1": req.user_identifier,
                    ":val2": false,
                  },
                  ExpressionAttributeNames: {
                    "#r": "request_state_vars",
                    "#c": "completedRatingClient",
                  },
                })
                  .then((prevShopping) => {
                    //! Delete previous cache
                    let redisKey = `${req.user_identifier}-shoppings`;
                    redisCluster.del(redisKey);
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
                        shopper_id: "false", //The id of the shopper
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
                        date_requested: new Date(chaineDateUTC).toISOString(), //The time of the request
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
                          dynamo_insert("requests_central", REQUEST_TEMPLATE)
                            .then((result) => {
                              //....DONE
                              resolve({ response: "successful" });
                            })
                            .catch((error) => {
                              logger.error(error);
                              resolve({ response: "unable_to_request" });
                            });
                        });
                    } //Has an unconfirmed shopping - block
                    else {
                      resolve({ response: "has_a_pending_shopping" });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: "unable_to_request" });
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
        //? EFFIENCY A
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
                  req.user_identifier !== "empty_fingerprint" &&
                  req.dropOff_data !== undefined &&
                  req.dropOff_data !== null &&
                  req.totals !== undefined &&
                  req.totals !== null &&
                  req.pickup_location !== undefined &&
                  req.pickup_location !== null
                : req.user_identifier !== undefined &&
                  req.user_identifier !== null &&
                  req.user_identifier !== "empty_fingerprint" &&
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

                dynamo_find_query({
                  table_name: "requests_central",
                  IndexName: "client_id",
                  KeyConditionExpression: "client_id = :val1",
                  FilterExpression: "#r.#c = :val2",
                  ExpressionAttributeValues: {
                    ":val1": req.user_identifier,
                    ":val2": false,
                  },
                  ExpressionAttributeNames: {
                    "#r": "request_state_vars",
                    "#c": "completedRatingClient",
                  },
                })
                  .then((prevDelivery) => {
                    //! Delete previous cache
                    let redisKey = `${req.user_identifier}-shoppings`;
                    redisCluster.del(redisKey);
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
                              shopper_id: "false", //The id of the shopper
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
                              shopper_id: "false", //The id of the shopper
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
                              date_requested: new Date(
                                chaineDateUTC
                              ).toISOString(), //The time of the request
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
                          )}${Math.round(new Date(chaineDateUTC).getTime())}`;
                        })
                        .finally(() => {
                          //?Continue here
                          dynamo_insert("requests_central", REQUEST_TEMPLATE)
                            .then((result) => {
                              if (result) {
                                //....DONE
                                resolve({ response: "successful" });
                              } //Failed
                              else {
                                resolve({ response: "unable_to_request" });
                              }
                            })
                            .catch((error) => {
                              logger.error(error);
                              resolve({ response: "unable_to_request" });
                            });
                        });
                    } //Has an unconfirmed shopping - block
                    else {
                      resolve({ response: "has_a_pending_shopping" });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: "unable_to_request" });
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
              logger.info(result);
              res.send(result);
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "unable_to_request" });
            });
        });

        //?7. Get the current shopping data - client
        //? EFFIENCY A
        app.post("/getShoppingData", function (req, res) {
          new Promise((resolve) => {
            req = req.body;

            if (
              req.user_identifier !== undefined &&
              req.user_identifier !== null
            ) {
              //! Check if the user id exists
              let redisKey = `${req.user_identifier}-shoppings`;

              redisGet(redisKey)
                .then((resp) => {
                  if (resp !== null) {
                    //Has some data
                    try {
                      //Rehydrate
                      // new Promise((resCompute) => {
                      //   getRequestDataClient(req, resCompute);
                      // })
                      //   .then((result) => {
                      //     //!Cache
                      //     redisCluster.setex(
                      //       redisKey,
                      //       parseInt(process.env.REDIS_EXPIRATION_5MIN) * 100,
                      //       JSON.stringify(result)
                      //     );
                      //     //...
                      //     // resolve(result);
                      //   })
                      //   .catch((error) => {
                      //     logger.error(error);
                      //     // resolve(false);
                      //   });

                      // console.log(resp);

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
                      getRequestDataClient(req, resCompute);
                    })
                      .then((result) => {
                        //!Cache
                        redisCluster.setex(
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
                    getRequestDataClient(req, resCompute);
                  })
                    .then((result) => {
                      //!Cache
                      redisCluster.setex(
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
        //? EFFIENCY A
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
        //? EFFIENCY A
        app.post("/submitRiderOrClientRating", function (req, res) {
          new Promise((resolve) => {
            resolveDate();

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

              dynamo_find_query({
                table_name: "requests_central",
                IndexName: "request_fp",
                KeyConditionExpression: "request_fp = :val1",
                FilterExpression: "#r.#c = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.request_fp,
                  ":val2": false,
                },
                ExpressionAttributeNames: {
                  "#r": "request_state_vars",
                  "#c": "completedRatingClient",
                },
              })
                .then((requestData) => {
                  if (requestData !== undefined && requestData.length > 0) {
                    //Valid
                    requestData = requestData[0];

                    let updatedRequestState = requestData.request_state_vars;
                    updatedRequestState["rating_data"] = RATING_DATA;
                    updatedRequestState["completedRatingClient"] = true;

                    dynamo_update({
                      table_name: "requests_central",
                      _idKey: requestData._id,
                      UpdateExpression:
                        "set request_state_vars = :val1, date_clientRatedRide = :val2",
                      ExpressionAttributeValues: {
                        ":val1": updatedRequestState,
                        ":val2": new Date(chaineDateUTC).toISOString(),
                      },
                    })
                      .then((result) => {
                        //! Delete previous cache
                        let redisKey = `${req.user_fingerprint}-shoppings`;
                        redisCluster.del(redisKey);
                        //! Delete previous request list cache
                        let redisKey2 = `${req.user_identifier}-requestListCached`;
                        redisCluster.del(redisKey2);
                        //...

                        if (result === false) {
                          //Error
                          resolve([{ response: "error" }]);
                        }
                        //...
                        resolve([{ response: "success" }]);
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve([{ response: "error" }]);
                      });
                  } //No request?
                  else {
                    resolve([{ response: "error" }]);
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve([{ response: "error" }]);
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
        //? EFFIENCY A
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
              dynamo_find_query({
                table_name: "requests_central",
                IndexName: "request_fp",
                KeyConditionExpression: "request_fp = :val1",
                FilterExpression: "client_id = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.request_fp,
                  ":val2": req.user_identifier,
                },
              })
                .then((requestData) => {
                  if (requestData !== undefined && requestData.length > 0) {
                    requestData = requestData[0];
                    // logger.error(requestData);
                    //!...Delete and save in the cancelled
                    dynamo_delete("requests_central", requestData._id)
                      .then((result) => {
                        //! Delete previous cache
                        let redisKey = `${req.user_identifier}-shoppings`;
                        redisCluster.del(redisKey);
                        //...

                        if (result) {
                          //Success
                          //!add the date cancelled
                          requestData["date_cancelled"] = new Date(
                            chaineDateUTC
                          ).toISOString();

                          dynamo_insert(
                            "cancelled_requests_central",
                            requestData
                          )
                            .then((result) => {
                              if (result) {
                                //Success
                                //...
                                resolve([{ response: "success" }]);
                              } //Failure
                              else {
                                resolve([{ response: "error" }]);
                              }
                            })
                            .catch((error) => {
                              logger.error(error);
                              resolve([{ response: "error" }]);
                            });
                        } //Failure
                        else {
                          resolve([{ response: "error" }]);
                        }
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve([{ response: "error" }]);
                      });
                  } //No request?
                  else {
                    resolve([{ response: "error" }]);
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve([{ response: "error" }]);
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
        //? EFFIENCY A
        app.post("/getRequestListRiders", function (req, res) {
          new Promise((resolve) => {
            req = req.body;

            if (
              req.user_identifier !== undefined &&
              req.user_identifier !== null
            ) {
              let redisKey = `${req.user_identifier}-requestListCached`;

              //TODO: .sort({ date_requested: -1 })
              redisGet(redisKey).then((resp) => {
                if (resp !== null) {
                  //Has some data
                  try {
                    resp = JSON.parse(resp);
                    resolve(resp);
                  } catch (error) {
                    //Make a fresh request
                    logger.error(error);
                    new Promise((resCompute) => {
                      getRequestListDataUsers(req, redisKey, resCompute);
                    })
                      .then((result) => {
                        resolve(result);
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve({ response: [] });
                      });
                  }
                } //No data - fresh request
                else {
                  new Promise((resCompute) => {
                    getRequestListDataUsers(req, redisKey, resCompute);
                  })
                    .then((result) => {
                      resolve(result);
                    })
                    .catch((error) => {
                      logger.error(error);
                      resolve({ response: [] });
                    });
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
        //? EFFIENCY A
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
              dynamo_find_query({
                table_name: "users_central",
                IndexName: "user_identifier",
                KeyConditionExpression: "user_identifier = :val1",
                ExpressionAttributeValues: {
                  ":val1": req.user_identifier,
                },
              })
                .then((userData) => {
                  if (userData !== undefined && userData.length > 0) {
                    //!Check the user
                    switch (req.data_type) {
                      case "name":
                        //Update the name
                        dynamo_update({
                          table_name: "users_central",
                          _idKey: userData[0]._id,
                          UpdateExpression: "set #name_word = :val1",
                          ExpressionAttributeValues: {
                            ":val1": req.data_value,
                          },
                          ExpressionAttributeNames: {
                            "#name_word": "name",
                          },
                        })
                          .then((result) => {
                            if (result === false) {
                              resolve({ response: "error" });
                            }
                            //...Success
                            resolve({ response: "success" });
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve({ response: "error" });
                          });
                        break;
                      case "surname":
                        //Update the surname
                        dynamo_update({
                          table_name: "users_central",
                          _idKey: userData[0]._id,
                          UpdateExpression: "set surname = :val1",
                          ExpressionAttributeValues: {
                            ":val1": req.data_value,
                          },
                        })
                          .then((result) => {
                            if (result === false) {
                              resolve({ response: "error" });
                            }
                            //...Success
                            resolve({ response: "success" });
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve({ response: "error" });
                          });
                        break;
                      case "email":
                        //Update the email
                        dynamo_update({
                          table_name: "users_central",
                          _idKey: userData[0]._id,
                          UpdateExpression: "set email = :val1",
                          ExpressionAttributeValues: {
                            ":val1": req.data_value,
                          },
                        })
                          .then((result) => {
                            if (result === false) {
                              resolve({ response: "error" });
                            }
                            //...Success
                            resolve({ response: "success" });
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve({ response: "error" });
                          });
                      case "gender":
                        //Update the gender
                        dynamo_update({
                          table_name: "users_central",
                          _idKey: userData[0]._id,
                          UpdateExpression: "set gender = :val1",
                          ExpressionAttributeValues: {
                            ":val1": req.data_value,
                          },
                        })
                          .then((result) => {
                            if (result === false) {
                              resolve({ response: "error" });
                            }
                            //...Success
                            resolve({ response: "success" });
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve({ response: "error" });
                          });
                        break;
                      case "phone":
                        //Update the phone
                        dynamo_update({
                          table_name: "users_central",
                          _idKey: userData[0]._id,
                          UpdateExpression: "set phone_number = :val1",
                          ExpressionAttributeValues: {
                            ":val1": req.data_value,
                          },
                        })
                          .then((result) => {
                            if (result === false) {
                              resolve({ response: "error" });
                            }
                            //...Success
                            resolve({ response: "success" });
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve({ response: "error" });
                          });
                        break;

                      case "profile_picture":
                        let localFileName = `.profile_photo${req.user_identifier}.${req.extension}`;
                        //? Write the file locally
                        fs.writeFile(
                          localFileName,
                          String(req.data_value),
                          "base64",
                          function (err) {
                            if (err) {
                              logger.error(err);
                              resolve({ response: "error" });
                            }
                            //...success
                            // Read content from the file
                            const fileContentUploaded_locally =
                              fs.readFileSync(localFileName);

                            // Setting up S3 upload parameters
                            let fileUploadName = `profile_${req.user_identifier}.${req.extension}`;
                            const params = {
                              Bucket: `${process.env.AWS_S3_CLIENTS_PROFILES_BUCKET_NAME}/clients_profiles`,
                              Key: fileUploadName, // File name you want to save as in S3
                              Body: fileContentUploaded_locally,
                            };

                            // Uploading files to the bucket
                            s3.upload(params, function (err, data) {
                              if (err) {
                                logger.info(err);
                                resolve({ response: "error" });
                              }
                              logger.info(
                                `[USER]${localFileName} -> Successfully uploaded.`
                              );
                              //! Update the database
                              dynamo_update({
                                table_name: "users_central",
                                _idKey: userData[0]._id,
                                UpdateExpression: "set #m.#p = :val1",
                                ExpressionAttributeValues: {
                                  ":val1": fileUploadName,
                                },
                                ExpressionAttributeNames: {
                                  "#m": "media",
                                  "#p": "profile_picture",
                                },
                              })
                                .then((result) => {
                                  if (result === false) {
                                    logger.error(err);
                                    resolve({ response: "error" });
                                  }
                                  //...Success
                                  resolve({ response: "success" });
                                })
                                .catch((error) => {
                                  logger.error(error);
                                  resolve({ response: "error" });
                                });
                            });
                          }
                        );
                        break;
                      default:
                        resolve({ response: "error" });
                        break;
                    }
                  } //No valid user
                  else {
                    res.send({ response: "error" });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  res.send({ response: "error" });
                });
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
                //! Delete previous cache
                // redisCluster.del(redisKey);
                //...
                dynamo_find_query({
                  table_name: "users_central",
                  IndexName: "user_identifier",
                  KeyConditionExpression: "user_identifier = :val1",
                  ExpressionAttributeValues: {
                    ":val1": req.user_identifier,
                  },
                })
                  .then((userData) => {
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
                  })
                  .catch((error) => {
                    logger.error(error);
                    res.send({ response: "error" });
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
        //? EFFIENCY A
        app.post("/getGenericUserData", function (req, res) {
          new Promise((resolve) => {
            req = req.body;

            logger.info(req);

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

        //?14. Check the user's phone number and send the code and the account status back
        //? EFFIENCY A
        app.post("/checkPhoneAndSendOTP_status", function (req, res) {
          new Promise((resolve) => {
            req = req.body;
            logger.info(req);

            //1. Check if the account exists
            dynamo_find_query({
              table_name: "users_central",
              IndexName: "phone_number",
              KeyConditionExpression: "phone_number = :val1",
              ExpressionAttributeValues: {
                ":val1": req.phone,
              },
            })
              .then((userData) => {
                if (userData !== undefined && userData.length > 0) {
                  //!Existing user - attach the _id
                  req["_id"] = userData[0]._id;

                  new Promise((resCompute) => {
                    shouldSendNewSMS({
                      req: req,
                      hasAccount: true,
                      user_identifier: userData[0].user_identifier,
                      resolve: resCompute,
                    });
                  })
                    .then((didSendOTP) => {
                      resolve({
                        response: {
                          didSendOTP: didSendOTP,
                          hasAccount: true, //!Has account
                          user_identifier: userData[0].user_identifier,
                        },
                      });
                    })
                    .catch((error) => {
                      logger.error(error);
                      resolve({ response: {} });
                    });
                } //Unregistered user
                else {
                  //Get the last
                  new Promise((resCompute) => {
                    shouldSendNewSMS({
                      req: req,
                      hasAccount: false,
                      resolve: resCompute,
                    });
                  })
                    .then((didSendOTP) => {
                      resolve({
                        response: {
                          didSendOTP: didSendOTP,
                          hasAccount: false, //!No account
                        },
                      });
                    })
                    .catch((error) => {
                      logger.error(error);
                      resolve({ response: {} });
                    });
                }
              })
              .catch((error) => {
                logger.error(error);
                resolve({ response: {} });
              });
          })
            .then((result) => {
              // logger.info(result);
              res.send(result);
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: {} });
            });
        });

        //?15. Validate user OTP
        //? EFFIENCY A
        app.post("/validateUserOTP", function (req, res) {
          new Promise((resolve) => {
            req = req.body;

            if (
              req.phone !== undefined &&
              req.phone !== null &&
              req.hasAccount !== undefined &&
              req.hasAccount !== null &&
              req.otp !== undefined &&
              req.otp !== null
            ) {
              req.hasAccount =
                req.hasAccount === true || req.hasAccount === "true"
                  ? true
                  : false;
              req.otp = parseInt(req.otp);
              //...
              if (
                req.hasAccount &&
                req.user_identifier !== undefined &&
                req.user_identifier !== null &&
                req.user_fingerprint !== "false"
              ) {
                //Registered user
                dynamo_find_query({
                  table_name: "users_central",
                  IndexName: "user_identifier",
                  KeyConditionExpression: "user_identifier = :val1",
                  FilterExpression: "phone_number = :val2 and #a.#p.#o = :val3",
                  ExpressionAttributeValues: {
                    ":val1": req.user_identifier,
                    ":val2": req.phone,
                    ":val3": parseInt(req.otp),
                  },
                  ExpressionAttributeNames: {
                    "#a": "account_verifications",
                    "#p": "phone_verification_secrets",
                    "#o": "otp",
                  },
                })
                  .then((userData) => {
                    if (userData !== undefined && userData.length > 0) {
                      //?Found the account
                      let url = `http://localhost:${process.env.SERVER_MOTHER_PORT}/getGenericUserData`;
                      requestAPI.post(
                        {
                          url,
                          form: req,
                        },
                        function (error, response, body) {
                          // console.log(error, body);
                          if (error === null) {
                            //Success
                            try {
                              body = JSON.parse(body);
                              resolve({
                                response: "success",
                                account_state: userData[0].account_state, //!Very important for state restoration
                                userData: body,
                              });
                            } catch (error) {
                              logger.error(error);
                              resolve({ response: {} });
                            }
                          } //Failed
                          else {
                            resolve({ response: {} });
                          }
                        }
                      );
                    } //No account found?
                    else {
                      resolve({ response: "wrong_otp" });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: {} });
                  });
              } //Non registered user
              else {
                dynamo_find_query({
                  table_name: "otp_dispatch_map",
                  IndexName: "phone_number",
                  KeyConditionExpression: "phone_number = :val1",
                  FilterExpression: "otp = :val2",
                  ExpressionAttributeValues: {
                    ":val1": req.phone,
                    ":val2": parseInt(req.otp),
                  },
                })
                  .then((anonymousUserData) => {
                    if (
                      anonymousUserData !== undefined &&
                      anonymousUserData.length > 0
                    ) {
                      //Found evidence!
                      resolve({ response: "success", userData: "new_user" });
                    } //No evidence?
                    else {
                      resolve({ response: "wrong_otp" });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: {} });
                  });
              }
            } //Invalid data
            else {
              resolve({ response: {} });
            }
          })
            .then((result) => {
              // logger.info(result);
              res.send(result);
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: {} });
            });
        });

        //?16. Create a basic account quickly
        //? EFFIENCY A
        app.post("/createBasicUserAccount", function (req, res) {
          new Promise((resolve) => {
            resolveDate();

            req = req.body;

            if (req.phone !== undefined && req.phone !== null) {
              //!Check if there is an account with this phone number
              dynamo_find_query({
                table_name: "users_central",
                IndexName: "phone_number",
                KeyConditionExpression: "phone_number = :val1",
                ExpressionAttributeValues: {
                  ":val1": req.phone,
                },
              })
                .then((userData) => {
                  if (userData !== undefined && userData.length == 0) {
                    //!No account yet - create one
                    let TEMPLATE_BASIC_ACCOUNT = {
                      user_identifier: null,
                      last_updated: new Date(chaineDateUTC).toISOString(),
                      gender: "unknown",
                      account_verifications: {
                        is_accountVerified: true,
                        is_policies_accepted: true,
                        phone_verification_secrets: {},
                      },
                      media: {
                        profile_picture: "user.png",
                      },
                      date_registered: new Date(chaineDateUTC).toISOString(),
                      password: false,
                      surname: "",
                      name: "",
                      phone_number: req.phone,
                      account_state: "half",
                      pushnotif_token: {},
                      email: "",
                    };
                    //Compute the user fingerprint
                    new Promise((resUserFp) => {
                      generateUniqueFingerprint(
                        `${req.phone}${new Date(chaineDateUTC).getTime()}`,
                        false,
                        resUserFp
                      );
                    })
                      .then((userFp) => {
                        TEMPLATE_BASIC_ACCOUNT.user_identifier = userFp;

                        //? Save the account
                        dynamo_insert("users_central", TEMPLATE_BASIC_ACCOUNT)
                          .then((result) => {
                            if (result) {
                              //Success
                              logger.info(TEMPLATE_BASIC_ACCOUNT);
                              //?Get the user indetifier
                              resolve({
                                response: "success",
                                userData: { user_identifier: userFp },
                              });
                            } //Failed
                            else {
                              resolve({ response: "error" });
                            }
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve({ response: "error" });
                          });
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve({ response: "error" });
                      });
                  } //!Existing account already there
                  else {
                    resolve({ response: "phone_already_in_use" });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error" });
                });
            } //Invalid data
            else {
              resolve({ response: "error" });
            }
          })
            .then((result) => {
              // logger.info(result);
              res.send(result);
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "error" });
            });
        });

        //?17. Add additional user account details
        //? EFFIENCY A
        app.post("/addAdditionalUserAccDetails", function (req, res) {
          new Promise((resolve) => {
            req = req.body;

            if (
              req.user_identifier !== undefined &&
              req.user_identifier !== null &&
              req.additional_data !== undefined &&
              req.additional_data !== null
            ) {
              req.additional_data = JSON.parse(req.additional_data);

              new Promise((resCheck) => {
                isUserValid(req.user_identifier, resCheck);
              })
                .then((isValid) => {
                  if (isValid.status) {
                    //?Valid user
                    //Update the user's profile
                    dynamo_update({
                      table_name: "users_central",
                      _idKey: isValid._id,
                      UpdateExpression:
                        "set #name_word = :val1, surname = :val2, gender = :val3, email = :val4, #m.#p = :val5, account_state = :val6",
                      ExpressionAttributeValues: {
                        ":val1": req.additional_data.name,
                        ":val2": req.additional_data.surname,
                        ":val3": req.additional_data.gender,
                        ":val4": req.additional_data.email,
                        ":val5": req.additional_data.profile_picture_generic,
                        ":val6": "full", //!Very important
                      },
                      ExpressionAttributeNames: {
                        "#m": "media",
                        "#p": "profile_picture",
                        "#name_word": "name",
                      },
                    })
                      .then((result) => {
                        if (result) {
                          //Success
                          //!Delete the user's profile cache
                          let redisKey = `${req.user_identifier}-cachedProfile-data`;
                          redisCluster.del(redisKey);
                          //....

                          resolve({ response: "success" });
                        } //Failed
                        else {
                          resolve({ response: "error" });
                        }
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve({ response: "error" });
                      });
                  } //! Invalid user
                  else {
                    resolve({ response: "error" });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error" });
                });
            } //Invalid data
            else {
              resolve({ response: "error" });
            }
          })
            .then((result) => {
              // logger.info(result);
              res.send(result);
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "error" });
            });
        });

        //?18. Get the go again list of the 3 recently visited shops - only for users
        //? EFFIENCY A
        app.post("/getRecentlyVisitedShops", function (req, res) {
          new Promise((resolve) => {
            resolveDate();

            req = req.body;
            logger.info(req);

            if (
              req.user_identifier !== undefined &&
              req.user_identifier !== null
            ) {
              let redisKey = `${req.user_identifier}-cachedRecentlyVisited_shops`;

              redisGet(redisKey)
                .then((resp) => {
                  if (resp !== null) {
                    //Has some cached data
                    try {
                      resp = JSON.parse(resp);
                      resolve(resp);
                    } catch (error) {
                      //Make a fresh request
                      new Promise((resCompute) => {
                        getRecentlyVisitedShops(req, redisKey, resCompute);
                      })
                        .then((result) => {
                          resolve(result);
                        })
                        .catch((error) => {
                          logger.error(error);
                          resolve({ response: [] });
                        });
                    }
                  } //No cached data - fresh request
                  else {
                    new Promise((resCompute) => {
                      getRecentlyVisitedShops(req, redisKey, resCompute);
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
                  resolve({ response: [] });
                });
            } //Invalid data
            else {
              resolve({ response: [] });
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

        //?19. Check the user's phone number and send the code and the account status back
        //? * FOR CHANGING USERS PHONE NUMBERS
        //? EFFIENCY A
        app.post(
          "/checkPhoneAndSendOTP_changeNumber_status",
          function (req, res) {
            new Promise((resolve) => {
              req = req.body;
              logger.info(req);
              if (
                req.phone !== undefined &&
                req.phone !== null &&
                req.user_identifier !== undefined &&
                req.user_identifier !== null
              ) {
                //1. Check if the here another user having that same number
                dynamo_find_query({
                  table_name: "users_central",
                  IndexName: "phone_number",
                  KeyConditionExpression: "phone_number = :val1",
                  ExpressionAttributeValues: {
                    ":val1": req.phone,
                  },
                })
                  .then((userData) => {
                    if (userData !== undefined && userData.length > 0) {
                      //!Another user has the same number
                      resolve({
                        response: { status: "already_linked_toAnother" },
                      });
                    } //Unregistered user
                    else {
                      //Get the user details
                      dynamo_find_query({
                        table_name: "users_central",
                        IndexName: "user_identifier",
                        KeyConditionExpression: "user_identifier = :val1",
                        ExpressionAttributeValues: {
                          ":val1": req.user_identifier,
                        },
                      })
                        .then((ownerUserData) => {
                          if (
                            ownerUserData !== undefined &&
                            ownerUserData.length > 0
                          ) {
                            //valid user
                            req["_id"] = ownerUserData[0]._id;

                            new Promise((resCompute) => {
                              shouldSendNewSMS({
                                req: req,
                                hasAccount: true,
                                user_identifier: req.user_identifier,
                                resolve: resCompute,
                              });
                            })
                              .then((didSendOTP) => {
                                resolve({
                                  response: {
                                    status: "success",
                                    didSendOTP: didSendOTP,
                                    hasAccount: true, //!Has account
                                    user_identifier: req.user_identifier,
                                  },
                                });
                              })
                              .catch((error) => {
                                logger.error(error);
                                resolve({ response: { status: "error" } });
                              });
                          } //Invalid user
                          else {
                            resolve({ response: { status: "error" } });
                          }
                        })
                        .catch((error) => {
                          logger.error(error);
                          resolve({ response: { status: "error" } });
                        });
                    }
                  })
                  .catch((error) => {
                    logger.error(error);
                    resolve({ response: { status: "error" } });
                  });
              } //Invalid data
              else {
                resolve({ response: { status: "error" } });
              }
            })
              .then((result) => {
                // logger.info(result);
                res.send(result);
              })
              .catch((error) => {
                logger.error(error);
                res.send({ response: { status: "error" } });
              });
          }
        );

        //?20. Validate user OTP
        //? * FOR CHANGING USERS PHONE NUMBERS
        //? EFFIENCY A
        app.post("/validateUserOTP_changeNumber", function (req, res) {
          new Promise((resolve) => {
            resolveDate();
            req = req.body;

            logger.info(req);

            if (
              req.phone !== undefined &&
              req.phone !== null &&
              req.hasAccount !== undefined &&
              req.hasAccount !== null &&
              req.otp !== undefined &&
              req.otp !== null &&
              req.user_identifier !== undefined &&
              req.user_identifier !== null &&
              req.user_identifier !== "false"
            ) {
              req.hasAccount =
                req.hasAccount === true || req.hasAccount === "true"
                  ? true
                  : false;
              req.otp = parseInt(req.otp);
              //...
              dynamo_find_query({
                table_name: "users_central",
                IndexName: "user_identifier",
                KeyConditionExpression: "user_identifier = :val1",
                FilterExpression: "#a.#p.#o = :val2",
                ExpressionAttributeValues: {
                  ":val1": req.user_identifier,
                  ":val2": parseInt(req.otp),
                },
                ExpressionAttributeNames: {
                  "#a": "account_verifications",
                  "#p": "phone_verification_secrets",
                  "#o": "otp",
                },
              })
                .then((userData) => {
                  if (userData !== undefined && userData.length > 0) {
                    //?Found the account
                    let url = `http://localhost:${process.env.SERVER_MOTHER_PORT}/getGenericUserData`;
                    requestAPI.post(
                      {
                        url,
                        form: req,
                      },
                      function (error, response, body) {
                        // console.log(error, body);
                        if (error === null) {
                          //Success
                          try {
                            body = JSON.parse(body);
                            //? Change the phone details
                            dynamo_update({
                              table_name: "users_central",
                              _idKey: userData[0]._id,
                              UpdateExpression:
                                "set phone_number = :val1, last_updated = :val2",
                              ExpressionAttributeValues: {
                                ":val1": req.phone,
                                ":val2": new Date(chaineDateUTC).toISOString(),
                              },
                            })
                              .then((result) => {
                                if (result) {
                                  //Success
                                  //! Delete the user profile cache
                                  let redisKey = `${req.user_identifier}-cachedProfile-data`;
                                  redisCluster.del(redisKey);
                                  //DONE
                                  resolve({
                                    response: { status: "success" },
                                  });
                                } //failed
                                else {
                                  resolve({ response: { status: "error" } });
                                }
                              })
                              .catch((error) => {
                                logger.error(error);
                                resolve({ response: { status: "error" } });
                              });
                          } catch (error) {
                            logger.error(error);
                            resolve({ response: { status: "error" } });
                          }
                        } //Failed
                        else {
                          resolve({ response: { status: "error" } });
                        }
                      }
                    );
                  } //No account found?
                  else {
                    resolve({ response: { status: "wrong_otp" } });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: { status: "error" } });
                });
            } //Invalid data
            else {
              resolve({ response: { status: "error" } });
            }
          })
            .then((result) => {
              // logger.info(result);
              res.send(result);
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: { status: "error" } });
            });
        });

        //?21. Upload the riders' pushnotif_token
        app.post("/receivePushNotification_token", function (req, res) {
          new Promise((resolve) => {
            req = req.body;

            if (
              req.user_identifier !== undefined &&
              req.user_identifier !== null &&
              req.pushnotif_token !== undefined &&
              req.pushnotif_token !== null
            ) {
              let redisKey = `${req.user_identifier}-pushnotif_tokenDataCached`;
              req.pushnotif_token = JSON.parse(req.pushnotif_token);
              //! Get the cached and compare, only update the database if not the same as the cached
              redisGet(redisKey)
                .then((resp) => {
                  console.log(resp);
                  if (resp !== null) {
                    //Has data
                    try {
                      resp = JSON.parse(resp);

                      if (`${req.pushnotif_token}` !== `${resp}`) {
                        //Update
                        new Promise((resCompute) => {
                          updateRidersPushNotifToken(req, redisKey, resCompute);
                        })
                          .then((result) => {
                            resolve(result);
                          })
                          .catch((error) => {
                            logger.error(error);
                            resolve({ response: "error" });
                          });
                      }
                    } catch (error) {
                      logger.error(error);
                      new Promise((resCompute) => {
                        updateRidersPushNotifToken(req, redisKey, resCompute);
                      })
                        .then((result) => {
                          resolve(result);
                        })
                        .catch((error) => {
                          logger.error(error);
                          resolve({ response: "error" });
                        });
                    }
                  } //No data - update  the db and cache
                  else {
                    new Promise((resCompute) => {
                      updateRidersPushNotifToken(req, redisKey, resCompute);
                    })
                      .then((result) => {
                        resolve(result);
                      })
                      .catch((error) => {
                        logger.error(error);
                        resolve({ response: "error" });
                      });
                  }
                })
                .catch((error) => {
                  logger.error(error);
                  resolve({ response: "error" });
                });
            } //invalid data
            else {
              resolve({ response: "error" });
            }
          })
            .then((result) => {
              // logger.info(result);
              res.send(result);
            })
            .catch((error) => {
              logger.error(error);
              res.send({ response: "error" });
            });
        });

        //? REST equivalent for common websockets.
        /**
         * For the courier driver resgistration
         */
        app.post("/registerCourier_ppline", function (req, res) {
          logger.info(String(req.body).length);
          let url =
            `${
              /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
            }` +
            ":" +
            process.env.ACCOUNTS_SERVICE_PORT +
            "/processCourierDrivers_application";

          requestAPI.post(
            { url, form: req.body },
            function (error, response, body) {
              logger.info(url);
              logger.info(body, error);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({ response: "error" });
                }
              } else {
                res.send({ response: "error" });
              }
            }
          );
        });

        /**
         * For the rides driver registration
         */

        app.post("/registerDriver_ppline", function (req, res) {
          logger.info(String(req.body).length);
          let url =
            `${
              /production/i.test(process.env.EVIRONMENT)
                ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                : process.env.LOCAL_URL
            }` +
            ":" +
            process.env.ACCOUNTS_SERVICE_PORT +
            "/processRidesDrivers_application";

          requestAPI.post(
            { url, form: req.body },
            function (error, response, body) {
              logger.info(url);
              logger.info(body, error);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({ response: "error" });
                }
              } else {
                res.send({ response: "error" });
              }
            }
          );
        });

        app.post("/update_requestsGraph", function (req, res) {
          logger.info(req);
          req = req.body;

          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.DISPATCH_SERVICE_PORT +
              "/getRequests_graphNumbers?driver_fingerprint=" +
              req.driver_fingerprint;

            requestAPI(url, function (error, response, body) {
              //logger.info(body);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    rides: 0,
                    deliveries: 0,
                    scheduled: 0,
                  });
                }
              } else {
                res.send({
                  rides: 0,
                  deliveries: 0,
                  scheduled: 0,
                });
              }
            });
          } else {
            res.send({
              rides: 0,
              deliveries: 0,
              scheduled: 0,
            });
          }
        });

        //?2
        /**
         * MAP SERVICE
         * Get user location (reverse geocoding)
         */
        app.post("/geocode_this_point", function (req, res) {
          req = req.body;

          if (
            req.latitude !== undefined &&
            req.latitude !== null &&
            req.longitude !== undefined &&
            req.longitude !== null &&
            req.user_fingerprint !== null &&
            req.user_fingerprint !== undefined
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.SEARCH_SERVICE_PORT +
              "/getUserLocationInfos";

            requestAPI.post(
              { url, form: req },
              function (error, response, body) {
                logger.info(url);
                logger.info(body, error);
                if (error === null) {
                  try {
                    body = JSON.parse(body);
                    res.send(body);
                  } catch (error) {
                    res.send(false);
                  }
                } else {
                  res.send(false);
                }
              }
            );
          } //Invalid params
          else {
            res.send(false);
          }
        });

        /**
         * MAP SERVICE, port 9090
         * Route: updatePassengerLocation
         * Event: update-passenger-location
         * Update the passenger's location in the system and prefetch the navigation data if any.
         */
        app.post("/update_passenger_location", function (req, res) {
          req = req.body;

          if (
            req !== undefined &&
            req.latitude !== undefined &&
            req.latitude !== null &&
            req.longitude !== undefined &&
            req.longitude !== null &&
            req.user_fingerprint !== null &&
            req.user_fingerprint !== undefined
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.MAP_SERVICE_PORT +
              "/updatePassengerLocation";
            //Supplement or not the request string based on if the user is a driver or rider
            if (req.user_nature !== undefined && req.user_nature !== null) {
              req.user_nature =
                req.user_nature !== undefined && req.user_nature !== null
                  ? req.user_nature
                  : "rider";
              req.requestType =
                req.requestType !== undefined && req.requestType !== null
                  ? req.requestType
                  : "rides";
            }
            //...

            requestAPI.post(
              { url, form: req },
              function (error, response, body) {
                if (error === null) {
                  try {
                    body = JSON.parse(body);
                    //logger.info(body);
                    res.send(body);
                  } catch (error) {
                    res.send(false);
                  }
                } else {
                  res.send(false);
                }
              }
            );
          } //Invalid params
          else {
            res.send(false);
          }
        });

        /**
         * DISPATCH SERVICE, port 9094
         * Route: accept_request
         * event: accept_request_io
         * Accept any request from the driver's side.
         */
        app.post("/accept_request_io", function (req, res) {
          //logger.info(req);
          req = req.body;
          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null &&
            req.request_fp !== undefined &&
            req.request_fp !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.DISPATCH_SERVICE_PORT +
              "/accept_request";

            requestAPI.post(
              { url, form: req },
              function (error, response, body) {
                //logger.info(body);
                if (error === null) {
                  try {
                    body = JSON.parse(body);
                    res.send(body);
                  } catch (error) {
                    res.send({
                      response: "unable_to_accept_request_error",
                    });
                  }
                } else {
                  res.send({
                    response: "unable_to_accept_request_error",
                  });
                }
              }
            );
          } else {
            res.send({
              response: "unable_to_accept_request_error",
            });
          }
        });

        /**
         * DISPATCH SERVICE, port 9094
         * Route: cancel_request_driver
         * event: cancel_request_driver_io
         * Cancel any request from the driver's side.
         */
        app.post("/cancel_request_driver_io", function (req, res) {
          req = req.body;
          //logger.info(req);
          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null &&
            req.request_fp !== undefined &&
            req.request_fp !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.DISPATCH_SERVICE_PORT +
              "/cancel_request_driver";

            requestAPI.post(
              { url, form: req },
              function (error, response, body) {
                //logger.info(body);
                if (error === null) {
                  try {
                    body = JSON.parse(body);
                    res.send(body);
                  } catch (error) {
                    res.send({
                      response: "unable_to_cancel_request_error",
                    });
                  }
                } else {
                  res.send({
                    response: "unable_to_cancel_request_error",
                  });
                }
              }
            );
          } else {
            res.send({
              response: "unable_to_cancel_request_error",
            });
          }
        });

        /**
         * DISPATCH SERVICE, port 9094
         * Route: confirm_pickup_request_driver
         * event: confirm_pickup_request_driver_io
         * Confirm pickup for any request from the driver's side.
         */
        app.post("/confirm_pickup_request_driver_io", function (req, res) {
          //logger.info(req);
          req = req.body;

          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null &&
            req.request_fp !== undefined &&
            req.request_fp !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.DISPATCH_SERVICE_PORT +
              "/confirm_pickup_request_driver";

            requestAPI.post(
              { url, form: req },
              function (error, response, body) {
                //logger.info(body);
                if (error === null) {
                  try {
                    body = JSON.parse(body);
                    res.send(body);
                  } catch (error) {
                    res.send({
                      response: "unable_to_confirm_pickup_request_error",
                    });
                  }
                } else {
                  res.send({
                    response: "unable_to_confirm_pickup_request_error",
                  });
                }
              }
            );
          } else {
            res.send({
              response: "unable_to_confirm_pickup_request_error",
            });
          }
        });

        /**
         * DISPATCH SERVICE, port 9094
         * Route: decline_request
         * event: declineRequest_driver
         * Decline any request from the driver's side.
         */
        app.post("/declineRequest_driver", function (req, res) {
          //logger.info(req);
          req = req.body;
          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null &&
            req.request_fp !== undefined &&
            req.request_fp !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.DISPATCH_SERVICE_PORT +
              "/decline_request";

            requestAPI.post(
              { url, form: req },
              function (error, response, body) {
                //logger.info(body);
                if (error === null) {
                  try {
                    body = JSON.parse(body);
                    res.send(body);
                  } catch (error) {
                    res.send({
                      response: "unable_to_decline_request_error",
                    });
                  }
                } else {
                  res.send({
                    response: "unable_to_decline_request_error",
                  });
                }
              }
            );
          } else {
            res.send({
              response: "unable_to_decline_request_error",
            });
          }
        });

        /**
         * DISPATCH SERVICE, port 9094
         * Route: confirm_dropoff_request_driver
         * event: confirm_dropoff_request_driver_io
         * Confirm dropoff for any request from the driver's side.
         */
        app.post("/confirm_dropoff_request_driver_io", function (req, res) {
          //logger.info(req);
          req = req.body;
          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null &&
            req.request_fp !== undefined &&
            req.request_fp !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.DISPATCH_SERVICE_PORT +
              "/confirm_dropoff_request_driver";

            requestAPI.post(
              { url, form: req },
              function (error, response, body) {
                //logger.info(body);
                if (error === null) {
                  try {
                    body = JSON.parse(body);
                    res.send(body);
                  } catch (error) {
                    res.send({
                      response: "unable_to_confirm_dropoff_request_error",
                    });
                  }
                } else {
                  res.send({
                    response: "unable_to_confirm_dropoff_request_error",
                  });
                }
              }
            );
          } else {
            res.send({
              response: "unable_to_confirm_dropoff_request_error",
            });
          }
        });

        /**
         * DISPATCH SERVICE, port 9094
         * Route: getRequests_graphNumbers
         * event: update_requestsGraph
         * Update the general requests numbers for ease of access
         */
        app.post("/update_requestsGraph", function (req, res) {
          //logger.info(req);
          req = req.body;
          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.DISPATCH_SERVICE_PORT +
              "/getRequests_graphNumbers?driver_fingerprint=" +
              req.driver_fingerprint;

            requestAPI(url, function (error, response, body) {
              //logger.info(body);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    rides: 0,
                    deliveries: 0,
                    scheduled: 0,
                    accepted: 0,
                  });
                }
              } else {
                res.send({
                  rides: 0,
                  deliveries: 0,
                  scheduled: 0,
                  accepted: 0,
                });
              }
            });
          } else {
            res.send({
              rides: 0,
              deliveries: 0,
              scheduled: 0,
              accepted: 0,
            });
          }
        });

        /**
         * ACCOUNTS SERVICE, port 9696
         * Route: getDrivers_walletInfosDeep
         * event: getDrivers_walletInfosDeep_io
         * Responsible for computing the wallet deep summary for the drivers
         */
        app.post("/getDrivers_walletInfosDeep_io", function (req, res) {
          //logger.info(req);
          req = req.body;

          if (
            req.user_fingerprint !== undefined &&
            req.user_fingerprint !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/getDrivers_walletInfosDeep?user_fingerprint=" +
              req.user_fingerprint;

            requestAPI(url, function (error, response, body) {
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    header: null,
                    weeks_view: null,
                    response: "error",
                  });
                }
              } else {
                res.send({
                  header: null,
                  weeks_view: null,
                  response: "error",
                });
              }
            });
          } else {
            res.send({
              header: null,
              weeks_view: null,
              response: "error",
            });
          }
        });

        /**
         * ACCOUNTS SERVICE, port 9696
         * Route: getRiders_walletInfos
         * event: getRiders_walletInfos_io
         * Responsible for computing the wallet summary (total and details) for the riders.
         * ! TO BE RESTORED WITH THE WALLET AND OPTIMAL APP UPDATE.
         */
        app.post("/getRiders_walletInfos_io", function (req, res) {
          //logger.info(req);
          req = req.body;
          if (
            req.user_fingerprint !== undefined &&
            req.user_fingerprint !== null &&
            req.mode !== undefined &&
            req.mode !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/getRiders_walletInfos?user_fingerprint=" +
              req.user_fingerprint +
              "&mode=" +
              req.mode +
              "&avoidCached_data=true";

            requestAPI(url, function (error, response, body) {
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    total: 0,
                    response: "error",
                    tag: "invalid_parameters",
                  });
                }
              } else {
                res.send({
                  total: 0,
                  response: "error",
                  tag: "invalid_parameters",
                });
              }
            });
          } else {
            res.send({
              total: 0,
              response: "error",
              tag: "invalid_parameters",
            });
          }
        });

        /**
         * ACCOUNTS SERVICE, port 9696
         * Route: computeDaily_amountMadeSoFar
         * event: computeDaily_amountMadeSoFar_io
         * Responsible for getting the daily amount made so far by the driver for exactly all the completed requests.
         */
        app.post("/computeDaily_amountMadeSoFar_io", function (req, res) {
          //logger.info(req);
          req = req.body;

          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/computeDaily_amountMadeSoFar?driver_fingerprint=" +
              req.driver_fingerprint;

            requestAPI(url, function (error, response, body) {
              //logger.info(body);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    amount: 0,
                    currency: "NAD",
                    currency_symbol: "N$",
                    response: "error",
                  });
                }
              } else {
                res.send({
                  amount: 0,
                  currency: "NAD",
                  currency_symbol: "N$",
                  response: "error",
                });
              }
            });
          } else {
            res.send({
              amount: 0,
              currency: "NAD",
              currency_symbol: "N$",
              response: "error",
            });
          }
        });

        app.post("/sendOtpAndCheckerUserStatusTc", function (req, res) {
          logger.info(req);
          req = req.body;
          //...
          if (req.phone_number !== undefined && req.phone_number !== null) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/sendOTPAndCheckUserStatus?phone_number=" +
              req.phone_number;

            if (req.smsHashLinker !== undefined && req.smsHashLinker !== null) {
              //Attach an hash linker for auto verification
              url += `&smsHashLinker=${encodeURIComponent(req.smsHashLinker)}`;
            }
            //Attach user nature
            if (req.user_nature !== undefined && req.user_nature !== null) {
              url += `&user_nature=${req.user_nature}`;
            }

            requestAPI(url, function (error, response, body) {
              //logger.info(body, error);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  //logger.info("HERE");
                  res.send(body);
                } catch (error) {
                  res.send({
                    response: "error_checking_user",
                  });
                }
              } else {
                res.send({
                  response: "error_checking_user",
                });
              }
            });
          } else {
            res.send({
              response: "error_checking_user",
            });
          }
        });

        app.post("/checkThisOTP_SMS", function (req, res) {
          req = req.body;
          logger.info(req);
          if (
            req.phone_number !== undefined &&
            req.phone_number !== null &&
            req.otp !== undefined &&
            req.otp !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/checkSMSOTPTruly?phone_number=" +
              req.phone_number +
              "&otp=" +
              req.otp;

            //Add the user nature : passengers (undefined) or drivers
            if (req.user_nature !== undefined && req.user_nature !== null) {
              url += `&user_nature=${req.user_nature}`;
            }

            requestAPI(url, function (error, response, body) {
              //logger.info(body);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    response: "error_checking_otp",
                  });
                }
              } else {
                res.send({
                  response: "error_checking_otp",
                });
              }
            });
          } else {
            res.send({
              response: "error_checking_otp",
            });
          }
        });

        app.post("/goOnline_offlineDrivers_io", function (req, res) {
          req = req.body;
          //logger.info(req);
          if (
            req.driver_fingerprint !== undefined &&
            req.driver_fingerprint !== null &&
            req.action !== undefined &&
            req.action !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/goOnline_offlineDrivers?driver_fingerprint=" +
              req.driver_fingerprint +
              "&action=" +
              req.action;

            //Add the state if found
            if (req.state !== undefined && req.state !== null) {
              url += "&state=" + req.state;
            } else {
              url += "&state=false";
            }

            requestAPI(url, function (error, response, body) {
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    response: "error_invalid_request",
                  });
                }
              } else {
                res.send({
                  response: "error_invalid_request",
                });
              }
            });
          } else {
            res.send({
              response: "error_invalid_request",
            });
          }
        });

        app.post("/driversOverallNumbers", function (req, res) {
          logger.info(req);
          req = req.body;
          if (
            req.user_fingerprint !== undefined &&
            req.user_fingerprint !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/getDriversGeneralAccountNumber?user_fingerprint=" +
              req.user_fingerprint;

            requestAPI(url, function (error, response, body) {
              // logger.info(body);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    response: "error",
                  });
                }
              } else {
                res.send({
                  response: "error",
                });
              }
            });
          } else {
            res.send({
              response: "error",
            });
          }
        });

        app.post("/getRides_historyRiders_batchOrNot", function (req, res) {
          req = req.body;
          //logger.info(req);
          if (
            req.user_fingerprint !== undefined &&
            req.user_fingerprint !== null
          ) {
            let url =
              `${
                /production/i.test(process.env.EVIRONMENT)
                  ? `http://${process.env.INSTANCE_PRIVATE_IP}`
                  : process.env.LOCAL_URL
              }` +
              ":" +
              process.env.ACCOUNTS_SERVICE_PORT +
              "/getRides_historyRiders?user_fingerprint=" +
              req.user_fingerprint;
            //Add a ride_type if any
            if (req.ride_type !== undefined && req.ride_type !== null) {
              url += "&ride_type=" + req.ride_type;
            }
            //Add a request fp and targeted flag or any
            if (
              req.target !== undefined &&
              req.target !== null &&
              req.request_fp !== undefined &&
              req.request_fp !== null
            ) {
              //Targeted request (target flags: single, multiple)
              url += "&target=" + req.target + "&request_fp=" + req.request_fp;
            }
            //? Add the user nature for drivers if any
            if (req.user_nature !== undefined && req.user_nature !== null) {
              url += `&user_nature=${req.user_nature}`;
            }
            //...
            requestAPI(url, function (error, response, body) {
              //logger.info(error, body);
              if (error === null) {
                try {
                  body = JSON.parse(body);
                  res.send(body);
                } catch (error) {
                  res.send({
                    response: "error_authentication_failed",
                  });
                }
              } else {
                res.send({
                  response: "error_authentication_failed",
                });
              }
            });
          } else {
            res.send({
              response: "error_authentication_failed",
            });
          }
        });
      }
    }
  );
});

server.listen(process.env.SERVER_MOTHER_PORT);
