const jwt = require('jsonwebtoken');

function generateAccessToken(user) {
    return jwt.sign(
        {
            sub: String(user.id),
            username: user.username
        },
        process.env.JWT_ACCESS_SECRET,
        {
            algorithm: 'HS256',
            expiresIn: '15m'
        }
    );
}

module.exports = { generateAccessToken };