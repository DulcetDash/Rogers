const lightcheck = async (req, res, next) => {
    try {
        const { browser, version, os, source } = req.useragent;

        const check = `${browser}-${version}-${os}-${source}`;
        if (check !== process.env.AUTH_MOBILE_STRING)
            return res.status(401).send('Unauthorized');

        next();
    } catch (error) {
        console.error('Internal server error:', error);
        res.status(500).send('Internal Server Error');
    }
};

module.exports = lightcheck;
