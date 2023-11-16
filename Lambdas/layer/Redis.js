// eslint-disable-next-line import/no-extraneous-dependencies
const Redis = require('ioredis');

const client = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    connectTimeout: 80000,
});

client.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.log(
        'Redis Client Error',
        err,
        `Redis host: ${process.env.REDIS_HOST} Redis port: 6379`
    );
});

module.exports = client;
