const axios = require('axios');

const sendNotification = async (userType, userIds, message) => {
    let appId;
    let channelId;
    let apiKey;

    if (userType === 'customer') {
        appId = process.env.ONESIGNAL_CUSTOMERS_APP_ID;
        channelId = process.env.NEW_REQUEST_CUSTOMERS_CHANNEL_ID;
        apiKey = process.env.ONESIGNAL_CUSTOMERS_API_KEY;
    } else if (userType === 'shopper') {
        appId = process.env.ONESIGNAL_DRIVERS_APP_ID;
        channelId = process.env.NEW_REQUEST_DRIVERS_CHANNEL_ID;
        apiKey = process.env.ONESIGNAL_DRIVERS_API_KEY;
    }

    if (!appId || !channelId || !apiKey) return;

    try {
        const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Basic ${apiKey}`,
        };

        const body = {
            app_id: appId,
            headings: { en: message.title },
            contents: { en: message.content },
            include_external_user_ids: userIds,
            channel_for_external_user_ids: channelId,
        };

        const response = await axios.post(
            'https://onesignal.com/api/v1/notifications',
            body,
            { headers }
        );
        console.log('Notification sent:', response.data);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
};

module.exports = sendNotification;
