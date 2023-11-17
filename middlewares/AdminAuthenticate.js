// eslint-disable-next-line import/no-extraneous-dependencies
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const AdminsModel = require('../models/AdminsModel');

const AdminAuthentication = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) return res.status(401).send('Unauthorized');

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (error) {
            return res.status(401).send('Unauthorized');
        }

        if (!decoded.user_id) return res.status(401).send('Unauthorized');

        const user = await AdminsModel.get(decoded.user_id);
        if (!user) return res.status(401).send('Unauthorized');

        const validSession = await bcrypt.compare(token, user.sessionToken);

        if (!validSession) return res.status(401).send('Unauthorized');

        const currentTimestamp = Math.floor(
            (user?.lastTokenUpdate ?? Date.now()) / 1000
        );
        const timeLeft = decoded.exp - currentTimestamp;

        if (timeLeft <= 600) {
            // 600 seconds = 10 minutes
            const newToken = jwt.sign(
                { user_id: decoded.user_id },
                process.env.JWT_SECRET,
                { expiresIn: `3h` }
            );

            const salt = await bcrypt.genSalt(10);
            const hashedToken = await bcrypt.hash(newToken, salt);

            await AdminsModel.update(
                { id: decoded.user_id },
                { sessionToken: hashedToken, lastTokenUpdate: Date.now() }
            );

            res.locals.sessionToken = newToken;
            res.setHeader('x-session-token', newToken);
        }

        req.user = user;

        next();
    } catch (error) {
        console.error('Internal server error:', error);
        res.status(500).send('Internal Server Error');
    }
};

module.exports = AdminAuthentication;
