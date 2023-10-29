const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

// Extract hours and minutes
function extractTime(timeStr) {
  const parts = timeStr.match(/(\d+):(\d+)(AM|PM)/);
  if (!parts) {
    console.error("Invalid time format:", timeStr);
    return null;
  }

  let [_, hour, minute, meridiem] = parts;
  hour = parseInt(hour, 10);
  minute = parseInt(minute, 10);

  // Adjust hour for 12-hour AM/PM format
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  return { hour, minute };
}

exports.storeTimeStatus = (opening_time, closing_time) => {
  // Ensure Day.js has the required plugin
  const now = dayjs().tz("Africa/Windhoek");

  const open = extractTime(opening_time);
  const close = extractTime(closing_time);

  if (!open || !close) return;

  let openingDateTime = now.hour(open.hour).minute(open.minute);
  let closingDateTime = now.hour(close.hour).minute(close.minute);

  if (closingDateTime.isBefore(openingDateTime)) {
    closingDateTime = closingDateTime.add(1, "day");
  }

  const nowMinusTwoHours = now.subtract(2, "hour");

  if (now.isAfter(openingDateTime) && now.isBefore(closingDateTime)) {
    if (now.isAfter(closingDateTime.subtract(2, "hour"))) {
      return `Closing in ${Math.ceil(
        closingDateTime.diff(now, "hour", true)
      )}h`;
    }
    return "Open";
  } else if (now.isBefore(openingDateTime)) {
    return `Opening in ${Math.ceil(openingDateTime.diff(now, "hour", true))}h`;
  } else {
    openingDateTime = openingDateTime.add(1, "day");
    return `Opening in ${Math.ceil(openingDateTime.diff(now, "hour", true))}h`;
  }
};
