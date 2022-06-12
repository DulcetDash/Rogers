const OS = require("os");
process.env.UV_THREADPOOL_SIZE = OS.cpus().length;
//---
const winston = require("winston");
const exceptionToLog = new RegExp(
  /(AWS_S3_ID|AWS_S3_SECRET|URL_MONGODB_PROD)/,
  "i"
);

const customLevels = {
  levels: {
    emerg: 0,
    alert: 1,
    crit: 2,
    error: 3,
    warn: 4,
    notice: 5,
    info: 6,
    debug: 7,
  },
};

module.exports = {
  logger: winston.createLogger({
    levels: customLevels.levels,
    format: winston.format.combine(
      winston.format.colorize({
        message: true,
      }),
      winston.format.timestamp({
        format: "YY-MM-DD HH:MM:SS",
      }),
      winston.format.printf(
        (info) =>
          ` ${info.timestamp}  ${info.level} : ${
            exceptionToLog.test(info.message) ? "*" : info.message
          }`
      )
    ),
    addColors: winston.addColors({
      error: "red",
      alert: "red",
      warn: "yellow",
      info: "cyan",
      debug: "green",
    }),
    defaultMeta: { service: "user-service" },
    transports: [
      //
      // - Write all logs with level `error` and below to `error.log`
      // - Write all logs with level `info` and below to `combined.log`
      //
      new winston.transports.Console(),
      // new winston.transports.File({ filename: "error.log", level: "error" }),
      //new winston.transports.File({ filename: "combined.log" }),
    ],
  }),
};

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
/*if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}*/
