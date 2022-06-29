/**
 * Responsible for performing the following DynamoDB operations:
 * ! The primary key for every tables is the _id
 * 1. Insert
 * 2. Delete
 * 3. Update
 * 4. Find
 */

const { logger } = require("./LogService");

var AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const { Console } = require("winston/lib/winston/transports");
// Set the region
AWS.config.update(
  process.env.EVIRONMENT === "development"
    ? {
        region: process.env.AWS_REGION,
        endpoint: process.env.DYNAMODB_ENDPOINT,
      }
    : {
        region: process.env.AWS_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
);

// Create DynamoDB document client
var dynamoClient = new AWS.DynamoDB.DocumentClient({
  apiVersion: "2012-08-10",
});

/**
 * ? Insert: PUT
 * Add a new record in a desired table
 * @param table_name: the name of the table that the record needs to be inserted in
 * @param data: the data to be inserted
 */
async function insert(table_name, data) {
  return new Promise((resolve) => {
    //! Attach a new _id if unexistant
    data["_id"] =
      data["_id"] !== undefined && data["_id"] !== null
        ? String(data["_id"])
        : uuidv4();
    //...
    let params = {
      TableName: table_name,
      Item: data,
    };

    // logger.error(params);
    //...
    dynamoClient.put(params, function (err, resultPut) {
      if (err) {
        logger.error(err);
        resolve(false);
      }
      //...
      logger.info(resultPut);
      resolve(true);
    });
  });
}

/**
 * ? Insert: PUT MANY
 * Add many new records in a desired table
 * @param table_name: the name of the table that the record needs to be inserted in
 * @param array_data: the array data to be inserted
 */
async function insert_many({ table_name, array_data }) {
  //! Attach a new _id if unexistant and reformat
  let reformatted_data = [];

  array_data.map((el) => {
    el["_id"] =
      el["_id"] !== undefined && el["_id"] !== null
        ? String(el["_id"])
        : uuidv4();

    console.log(el);
    // console.error(el["date_added"]);
    //? TO USE ONLY FOR DATA MIGRATION FROM MONGODB -> DYNAMODB
    // if (el["date_requested"] !== undefined && el["date_requested"] !== null)
    //   el["date_requested"] = el["date_requested"].toISOString();

    // if (el["date_cancelled"] !== undefined && el["date_cancelled"] !== null)
    //   el["date_cancelled"] = el["date_cancelled"].toISOString();

    // if (
    //   el["date_added"] !== undefined &&
    //   el["date_added"] !== null &&
    //   el["date_added"] !== "date"
    // )
    //   el["date_added"] = el["date_added"].toISOString();

    // if (el["date_registered"] !== undefined && el["date_registered"] !== null)
    //   el["date_registered"] = el["date_registered"].toISOString();

    // if (el["date_updated"] !== undefined && el["date_updated"] !== null)
    //   el["date_updated"] = el["date_updated"].toISOString();

    // if (
    //   el["date_clientRatedRide"] !== undefined &&
    //   el["date_clientRatedRide"] !== null
    // )
    //   el["date_clientRatedRide"] = el["date_clientRatedRide"].toISOString();

    // if (el["last_updated"] !== undefined && el["last_updated"] !== null)
    //   el["last_updated"] = el["last_updated"].toISOString();

    //...
    reformatted_data.push({
      PutRequest: {
        Item: el,
      },
    });
    //...
    // console.log(el);
  });

  //...
  //! Insert in chunks of size 25
  const chunkSize = 25;
  for (let i = 0; i < reformatted_data.length; i += chunkSize) {
    const chunk = reformatted_data.slice(i, i + chunkSize);
    // console.log(chunk);
    // SAve
    let params = {
      RequestItems: {},
    };
    params.RequestItems[table_name] = chunk;
    //...
    dynamoClient.batchWrite(params, function (err, resultPut) {
      if (err) {
        logger.error(err);
      }
      //...
      logger.info(resultPut);
      // logger.info(
      //   `[${Math.round((100 * i) / reformatted_data.length)}] - Completed`
      // );
    });
  }
  return true;
}

/**
 * ? Delete
 * Delete a record from a desired table
 * @param table_name: the name of the table from which the record will be deleted.
 * @param _idKey: the filtering data to be deleted
 */
async function delete_r(table_name, _idKey) {
  return new Promise((resolve) => {
    let params = {
      TableName: table_name,
      Key: {
        _id: _idKey,
      },
    };

    // logger.warn(params);
    //...
    dynamoClient.delete(params, function (err, resultDel) {
      if (err) {
        logger.error(err);
        resolve(false);
      }
      //...
      logger.info(resultDel);
      resolve(true);
    });
  });
}

/**
 * ? Update
 * Update a record from a desired table
 * @param table_name: the name of the table from which the record will be updated.
 * @param _idKey: the filtering data to be updated
 * @param UpdateExpression: the expression schema to be updated.
 * @param ExpressionAttributeValues: the attributes to complete the update expression
 * @param ExpressionAttributeNames: the names of the attributes, very useful for nested attributes.
 */
async function update({
  table_name,
  _idKey,
  UpdateExpression,
  ExpressionAttributeValues = {},
  ExpressionAttributeNames = {},
}) {
  return new Promise((resolve) => {
    let params = {
      TableName: table_name,
      Key:
        typeof _idKey === "object"
          ? _idKey
          : {
              _id: _idKey,
            },
      UpdateExpression: UpdateExpression,
      ExpressionAttributeValues: ExpressionAttributeValues,
      ExpressionAttributeNames: ExpressionAttributeNames,
    };

    //! Remove ExpressionAttributeNames or FilterExpression if not set
    if (Object.keys(ExpressionAttributeNames).length === 0)
      delete params["ExpressionAttributeNames"];

    //...
    dynamoClient.update(params, function (err, resultUpdate) {
      if (err) {
        logger.warn(params);
        logger.error(err);
        resolve(false);
      }
      //...
      logger.info(resultUpdate);
      resolve(true);
    });
  });
}

/**
 * ? Find - QUERY
 * Find a record(s) from a desired table
 * @param table_name: the name of the table from which the record(s) will be retrived
 * @param _idKey: the filtering data to be updated
 * @param FilterExpression: the filter expression schema to be found.
 * @param KeyConditionExpression: the conditional expression to be found
 * @param ExpressionAttributeValues: the attributes to complete the filter expression
 * @param ExpressionAttributeNames: the names of the attributes, very useful for nested attributes.
 * @param IndexName: the index name to search to results against
 */
async function find_query({
  table_name,
  _idKey,
  KeyConditionExpression,
  FilterExpression = {},
  ExpressionAttributeValues = {},
  ExpressionAttributeNames = {},
  IndexName = null,
  Limit = null,
  ScanIndexForward = null,
}) {
  return new Promise((resolve) => {
    let params =
      IndexName !== undefined && IndexName !== null
        ? {
            KeyConditionExpression: KeyConditionExpression,
            ExpressionAttributeValues: ExpressionAttributeValues,
            ExpressionAttributeNames: ExpressionAttributeNames,
            FilterExpression: FilterExpression,
            Limit: Limit,
            ScanIndexForward: ScanIndexForward,
            TableName: table_name,
            IndexName: IndexName,
          }
        : {
            KeyConditionExpression: KeyConditionExpression,
            ExpressionAttributeValues: ExpressionAttributeValues,
            ExpressionAttributeNames: ExpressionAttributeNames,
            FilterExpression: FilterExpression,
            Limit: Limit,
            ScanIndexForward: ScanIndexForward,
            TableName: table_name,
            Key: {
              _id: _idKey,
            },
          };

    //! Remove ExpressionAttributeNames or FilterExpression if not set
    if (Object.keys(ExpressionAttributeNames).length === 0)
      delete params["ExpressionAttributeNames"];

    if (Object.keys(FilterExpression).length === 0)
      delete params["FilterExpression"];

    if (Limit === null) delete params["Limit"];

    if (ScanIndexForward === null) delete params["ScanIndexForward"];

    logger.warn(params);
    //...
    dynamoClient.query(params, function (err, resultFindget) {
      if (err) {
        logger.warn("ERROR HERE");
        logger.error(err);
        resolve([]);
      }
      //...
      // logger.info(resultFindget.Items.length);
      resolve(resultFindget.Items);
    });
  });
}

/**
 * ? Find - GET
 * Find a record(s) from a desired table with an ASH key
 * @param table_name: the name of the table from which the record(s) will be retrived
 * @param _idKey: the filtering data to be updated
 */
async function find_get(table_name, _idKey) {
  return new Promise((resolve) => {
    let params = {
      TableName: table_name,
      Key: _idKey,
    };
    //...
    dynamoClient.get(params, function (err, resultFindget) {
      if (err) {
        logger.error(err);
        resolve([]);
      }
      //...
      logger.info(resultFindget);
      resolve([resultFindget.Item]);
    });
  });
}

/**
 * ? Get ALL
 * Get all the items from a desired table
 * @param table_name: the name of the table from which the record(s) will be retrived
 */

async function get_all({
  table_name,
  FilterExpression = {},
  ExpressionAttributeValues = {},
  ExpressionAttributeNames = {},
}) {
  return new Promise((resolve) => {
    let params = {
      TableName: table_name,
      FilterExpression: FilterExpression,
      ExpressionAttributeValues: ExpressionAttributeValues,
      ExpressionAttributeNames: ExpressionAttributeNames,
    };

    //! Remove ExpressionAttributeNames or FilterExpression if not set
    if (Object.keys(ExpressionAttributeNames).length === 0)
      delete params["ExpressionAttributeNames"];

    if (Object.keys(ExpressionAttributeValues).length === 0)
      delete params["ExpressionAttributeValues"];

    if (Object.keys(FilterExpression).length === 0)
      delete params["FilterExpression"];
    //...
    dynamoClient.scan(params, function (err, resultFindget) {
      if (err) {
        logger.error(err);
        resolve([]);
      }
      //...
      logger.warn(params);
      resolve(resultFindget.Items);
    });
  });
}

//? Exports
module.exports = {
  dynamo_insert: insert,
  dynamo_insert_many: insert_many,
  dynamo_delete: delete_r,
  dynamo_update: update,
  dynamo_find_get: find_get,
  dynamo_find_query: find_query,
  dynamo_get_all: get_all,
  get_newID: () => {
    return uuidv4();
  },
};
