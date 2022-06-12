require("dotenv").config();
//require("newrelic");
var express = require("express");
const http = require("http");
const fs = require("fs");
const MongoClient = require("mongodb").MongoClient;
// const certFile = fs.readFileSync("./rds-combined-ca-bundle.pem");

const { logger } = require("./LogService");

var app = express();
//---center
const { promisify, inspect } = require("util");
const redis = require("redis");
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

//! Attach DynamoDB helper
const {
  dynamo_insert,
  dynamo_update,
  dynamo_find_query,
  dynamo_delete,
  dynamo_get_all,
  dynamo_insert_many,
} = require("./DynamoServiceManager");
//....
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

MongoClient.connect(process.env.DB_URL_MONGODB, function (err, clientMongo) {
  if (err) throw err;
  logger.info("Connected to Mongodb");
  const dbMongo = clientMongo.db(process.env.DB_NAME_MONGODDB);

  var collection_or_table_name = "catalogue_central";

  var collectionToMigrate = dbMongo.collection(collection_or_table_name);
  var collectionRelay = dbMongo.collection("shops_central");

  //? 1. GET ALL THE VALUES FROM THE COLLECTION
  // collectionToMigrate.find({}).toArray(function (err, dataToMigrate) {
  //   if (err) {
  //     logger.error(err);
  //   }
  //   //...
  //   dynamo_insert_many({
  //     table_name: collection_or_table_name,
  //     array_data: dataToMigrate,
  //   })
  //     .then((result) => {
  //       logger.info(result);
  //       logger.warn("DONE");
  //     })
  //     .catch((error) => {
  //       logger.error(error);
  //       logger.warn("DONE");
  //     });
  // });

  collectionToMigrate.find({}).toArray(function (err, dataToMigrate) {
    if (err) {
      logger.error(err);
    }
    //! Get the shop_fp
    dataToMigrate.map((data) => {
      collectionRelay
        .find({
          name: data.meta.shop_name,
        })
        .toArray(function (err, shop_data) {
          data["shop_fp"] = shop_data[0].shop_fp; //Save the shop fp

          dynamo_insert_many({
            table_name: collection_or_table_name,
            array_data: [data],
          })
            .then((result) => {
              logger.info(result);
              logger.warn("DONE");
            })
            .catch((error) => {
              logger.error(error);
              logger.warn("DONE");
            });
        });
    });
    //...
  });
});
