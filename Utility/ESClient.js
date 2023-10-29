const { Client } = require("@elastic/elasticsearch");

const ESClient = new Client({
  node: `http://${process.env.ELASTICSEARCH_ENDPOINT}`,
  auth: {
    username: process.env.ELASTIC_USERNAME,
    password: process.env.ELASTIC_PASSWORD,
  },
});

exports.ESClient = ESClient;
