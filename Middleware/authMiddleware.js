const jwt = require('jsonwebtoken');
const { parseParkingId } = require('../Utils/parkingValidation');

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            message: 'Access token is required'
        });
    }

    const token = authHeader.slice(7);

    try {
        const decoded = jwt.verify(
            token,
            process.env.JWT_ACCESS_SECRET,
            { algorithms: ['HS256'] }
        );

        if (!decoded || typeof decoded !== 'object' || typeof decoded.sub !== 'string' || parseParkingId(decoded.sub) === null) {
            return res.status(401).json({ message: 'Invalid or expired access token' });
        }
        req.user = {
            id: decoded.sub,
            username: decoded.username
        };

        next();
    } catch (error) {
        return res.status(401).json({
            message: 'Invalid or expired access token'
        });
    }
}

module.exports = authMiddleware;
