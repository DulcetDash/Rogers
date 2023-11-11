const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const UserModel = require('../../models/UserModel');

exports.generateNewSecurityToken = async (user) => {
    const userId = user.id;

    const newToken = jwt.sign({ user_id: userId }, process.env.JWT_SECRET, {
        expiresIn: `${process.env.DEFAULT_SESSION_DURATION_H}h`,
    });

    const salt = await bcrypt.genSalt(10);
    const hashedToken = await bcrypt.hash(newToken, salt);

    await UserModel.update(
        { id: userId },
        {
            sessionToken: hashedToken,
            lastTokenUpdate: Date.now(),
        }
    );

    return newToken;
};
