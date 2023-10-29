const { Client } = require('@elastic/elasticsearch');

const client = new Client({
    node: process.env.ES_HOST,
    auth: {
        username: process.env.ES_USERNAME,
        password: process.env.ES_PASSWORD,
    },
});

module.exports = client;
