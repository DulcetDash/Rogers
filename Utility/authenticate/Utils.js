const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const UserModel = require('../../models/UserModel');

exports.generateNewSecurityToken = async (user) => {
    const userId = user.id;

    const sessionToken = jwt.sign({ user_id: userId }, process.env.JWT_SECRET, {
        expiresIn: `${process.env.DEFAULT_SESSION_DURATION_H}h`,
    });

    const permaToken = jwt.sign(
        { user_id: userId },
        process.env.JWT_PERMATOKEN_SECRET
    );

    const salt = await bcrypt.genSalt(10);
    const hashedSessionToken = await bcrypt.hash(sessionToken, salt);
    const hashedPermaToken = await bcrypt.hash(permaToken, salt);

    await UserModel.update(
        { id: userId },
        {
            sessionToken: hashedSessionToken,
            lastTokenUpdate: Date.now(),
            permaToken: hashedPermaToken,
        }
    );

    return {
        sessionToken, //expires in 24 hours
        permaToken, //expires in 1 year
    };
};
