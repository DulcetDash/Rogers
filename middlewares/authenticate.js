// eslint-disable-next-line import/no-extraneous-dependencies
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const UserModel = require('../models/UserModel');
const { logger } = require('../LogService');
const DriversModel = require('../models/DriversModel');

const decodedPermaToken = (permaToken) => {
    let decoded;
    try {
        decoded = jwt.verify(permaToken, process.env.JWT_PERMATOKEN_SECRET);
        return decoded?.user_id;
    } catch (error) {
        return null;
    }
};

const authenticate = async (req, res, next) => {
    try {
        const { browser, version, os, source } = req.useragent;

        const check = `${browser}-${version}-${os}-${source}`;
        if (check !== process.env.AUTH_MOBILE_STRING)
            return res.status(401).send('Unauthorized');

        const permaToken = req.headers['x-perma-token'];
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];

        if (!permaToken || !token) return res.status(401).send('Unauthorized');

        const permaTokenData = decodedPermaToken(permaToken);

        if (!permaTokenData) return res.status(401).send('Unauthorized');

        let areBothTokensValid = false;

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
            areBothTokensValid = true;
        } catch (error) {
            if (error instanceof jwt.TokenExpiredError) {
                // Token is valid but expired
                areBothTokensValid = true;
            } else {
                // Token is invalid for other reasons
                return res.status(401).send('Unauthorized');
            }
        }

        //! If both tokens were decoded, the user must match
        if (decoded && decoded?.user_id !== permaTokenData)
            return res.status(401).send('Unauthorized');

        if (!decoded?.user_id && !areBothTokensValid)
            return res.status(401).send('Unauthorized');

        const resolvedUserId =
            areBothTokensValid && decoded?.user_id
                ? decoded?.user_id
                : permaTokenData;

        let mainUserModel = UserModel;
        let user = await UserModel.get(resolvedUserId);

        if (!user) {
            user = await DriversModel.get(resolvedUserId);
            mainUserModel = DriversModel;
        }

        //! Permatoken must exist
        const validPermaToken = await bcrypt.compare(
            permaToken,
            user.permaToken
        );

        if (!validPermaToken) return res.status(401).send('Unauthorized');

        if (!user) return res.status(401).send('Unauthorized');

        const validSession = await bcrypt.compare(token, user.sessionToken);

        if (!validSession) return res.status(401).send('Unauthorized');

        const currentTimestamp = Math.floor(
            (user?.lastTokenUpdate ?? Date.now()) / 1000
        );
        const timeLeft = (decoded?.exp ?? 0) - currentTimestamp;

        if (timeLeft <= 600 * 3 || !decoded?.user_id) {
            // 600 seconds = 10 minutes
            const newToken = jwt.sign(
                { user_id: user?.id },
                process.env.JWT_SECRET,
                { expiresIn: `${process.env.DEFAULT_SESSION_DURATION_H}h` }
            );

            const salt = await bcrypt.genSalt(10);
            const hashedToken = await bcrypt.hash(newToken, salt);

            await mainUserModel.update(
                { id: user?.id },
                { sessionToken: hashedToken, lastTokenUpdate: Date.now() }
            );

            res.setHeader('x-session-token', newToken);
        }

        req.user = user;

        next();
    } catch (error) {
        console.error('Internal server error:', error);
        res.status(500).send('Internal Server Error');
    }
};

module.exports = authenticate;
