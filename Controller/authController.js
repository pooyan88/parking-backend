
const bcrypt = require('bcrypt');
const pool = require('../Database/db');

const { generateAccessToken } = require('../Utils/tokenUtils');

const {
    generateRefreshToken,
    hashRefreshToken
} = require('../Utils/refreshTokenUtils');

const authController = {

    // =========================
    // SIGNUP
    // =========================

    signup: async (req, res) => {
        try {
            const { username, phone_number, password, name, family_name } = req.body ?? {};

            if (
                typeof username !== 'string' ||
                typeof phone_number !== 'string' ||
                typeof password !== 'string' ||
                !username.trim() ||
                !phone_number.trim() ||
                !password
            ) {
                return res.status(400).json({
                    message: 'All fields are required'
                });
            }

            for (const [field, value] of Object.entries({ name, family_name })) {
                if (value != null && (typeof value !== 'string' ||
                    [...value.trim()].length > 255 || value.includes('\0'))) {
                    return res.status(400).json({
                        message: `${field} must be text up to 255 characters or null`
                    });
                }
            }

            const passwordHash = await bcrypt.hash(password, 12);

            const result = await pool.query(
                `INSERT INTO users (
                    username,
                    phone_number,
                    password_hash,
                    name,
                    family_name
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, username, phone_number, created_at,
                    COALESCE(name, 'کاربر جدید') AS name,
                    COALESCE(family_name, 'کاربر جدید') AS family_name`,
                [username.trim(), phone_number.trim(), passwordHash,
                    name?.trim() || null, family_name?.trim() || null]
            );

            return res.status(201).json({
                message: 'User created successfully',
                user: result.rows[0]
            });

        } catch (error) {
            console.error('Signup error:', error.message);

            if (error.code === '23505') {
                return res.status(409).json({
                    message: 'Username or phone number already exists'
                });
            }

            return res.status(500).json({
                message: 'Internal server error'
            });
        }
    },

    // =========================
    // LOGIN
    // =========================

    login: async (req, res) => {
        try {
            const { username, password } = req.body ?? {};

            if (
                typeof username !== 'string' ||
                typeof password !== 'string' ||
                !username.trim() ||
                !password
            ) {
                return res.status(400).json({
                    message: 'Username and password are required'
                });
            }

            const result = await pool.query(
                `SELECT id, username, password_hash,
                    COALESCE(name, 'کاربر جدید') AS name,
                    COALESCE(family_name, 'کاربر جدید') AS family_name
                 FROM users
                 WHERE username = $1`,
                [username.trim()]
            );

            if (result.rows.length === 0) {
                return res.status(401).json({
                    message: 'Invalid username or password'
                });
            }

            const user = result.rows[0];

            const isValidPassword = await bcrypt.compare(
                password,
                user.password_hash
            );

            if (!isValidPassword) {
                return res.status(401).json({
                    message: 'Invalid username or password'
                });
            }

            const accessToken = generateAccessToken(user);
            const refreshToken = generateRefreshToken();
            const refreshTokenHash = hashRefreshToken(refreshToken);

            await pool.query(
                `INSERT INTO refresh_tokens (
                    user_id,
                    token_hash,
                    expires_at
                )
                VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
                [user.id, refreshTokenHash]
            );

            return res.status(200).json({
                message: 'Login successful',
                user: {
                    id: user.id,
                    username: user.username,
                    name: user.name,
                    family_name: user.family_name
                },
                access_token: accessToken,
                refresh_token: refreshToken,
                token_type: 'Bearer',
                expires_in: 900,
                refresh_expires_in: 604800
            });

        } catch (error) {
            console.error('Login error:', error.message);

            return res.status(500).json({
                message: 'Internal server error'
            });
        }
    },

    // =========================
    // REFRESH TOKEN
    // =========================

    refresh: async (req, res) => {
        const { refresh_token: refreshToken } = req.body ?? {};

        // 1. Validate Refresh Token
        if (
            typeof refreshToken !== 'string' ||
            !/^[a-f0-9]{64}$/.test(refreshToken)
        ) {
            return res.status(400).json({
                message: 'Valid refresh token is required'
            });
        }

        const tokenHash = hashRefreshToken(refreshToken);

        // Use one database connection for the transaction
        let client;

        try {
            client = await pool.connect();

            // 2. Start transaction
            await client.query('BEGIN');

            // 3. Find token and lock its database row
            const result = await client.query(
                `SELECT
                    rt.id,
                    rt.user_id,
                    rt.expires_at,
                    rt.revoked_at,
                    u.username
                 FROM refresh_tokens rt
                 JOIN users u ON u.id = rt.user_id
                 WHERE rt.token_hash = $1
                 FOR UPDATE OF rt`,
                [tokenHash]
            );

            if (result.rows.length === 0) {
                await client.query('ROLLBACK');

                return res.status(401).json({
                    message: 'Invalid refresh token'
                });
            }

            const storedToken = result.rows[0];

            // 4. Check if token is revoked or expired
            if (
                storedToken.revoked_at !== null ||
                new Date(storedToken.expires_at) <= new Date()
            ) {
                await client.query('ROLLBACK');

                return res.status(401).json({
                    message: 'Refresh token expired or revoked'
                });
            }

            // 5. Revoke old Refresh Token
            await client.query(
                `UPDATE refresh_tokens
                 SET revoked_at = NOW()
                 WHERE id = $1`,
                [storedToken.id]
            );

            // 6. Generate new tokens
            const user = {
                id: storedToken.user_id,
                username: storedToken.username
            };

            const newAccessToken = generateAccessToken(user);
            const newRefreshToken = generateRefreshToken();
            const newRefreshTokenHash = hashRefreshToken(newRefreshToken);

            // 7. Save new Refresh Token hash
            await client.query(
                `INSERT INTO refresh_tokens (
                    user_id,
                    token_hash,
                    expires_at
                )
                VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
                [user.id, newRefreshTokenHash]
            );

            // 8. Commit both database changes
            await client.query('COMMIT');

            // 9. Return new tokens
            return res.status(200).json({
                message: 'Token refreshed successfully',
                access_token: newAccessToken,
                refresh_token: newRefreshToken,
                token_type: 'Bearer',
                expires_in: 900,
                refresh_expires_in: 604800
            });

        } catch (error) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    console.error('Rollback error:', rollbackError.message);
                }
            }

            console.error('Refresh token error:', error.message);

            return res.status(500).json({
                message: 'Internal server error'
            });

        } finally {
            if (client) {
                client.release();
            }
        }
    }
};

module.exports = authController;
