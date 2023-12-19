const Queue = require('bull');

//Params
//A. Redis connector
const redisOptions = {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    // password: process.env.REDIS_PASSWORD,
};

const queueOptions = {
    redis: redisOptions,
};

// Email queue
exports.sendMailQueue = new Queue('emailQueue', queueOptions);
exports.sendMailQueueSNS = new Queue('emailQueueSNS', queueOptions);
