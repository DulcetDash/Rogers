exports.deleteKeysWithSuffix = async (redis, suffix) => {
    let cursor = '0';
    do {
        // Scan with each iteration (starting with cursor '0')
        const reply = await redis.scan(
            cursor,
            'MATCH',
            `*${suffix}`,
            'COUNT',
            100
        );
        cursor = reply[0]; // Update the cursor position for the next scan
        const keys = reply[1];

        // If keys are found, delete them
        if (keys.length > 0) {
            await redis.del(keys);
        }
    } while (cursor !== '0'); // When the cursor returns to '0', we've scanned all keys

    redis.disconnect();
    console.log('All keys with specified suffix deleted.');
};
