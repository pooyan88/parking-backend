const bcrypt = require('bcrypt');
const pool = require('../Database/db');
const { generateAccessToken } = require('../Utils/tokenUtils');

const authController = {
    signup: async (req, res) => {
        try {
            const { username, phone_number, password } = req.body;

            if (!username || !phone_number || !password) {
                return res.status(400).json({
                    message: 'All fields are required'
                });
            }

            const passwordHash = await bcrypt.hash(password, 12);

            const result = await pool.query(
                `INSERT INTO users (username, phone_number, password_hash)
                 VALUES ($1, $2, $3)
                 RETURNING id, username, phone_number, created_at`,
                [username, phone_number, passwordHash]
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

    login: async (req, res) => {
        try {
            const { username, password } = req.body ?? {};

            // 1. Validate input
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

            // 2. Find user in PostgreSQL
            const result = await pool.query(
                `SELECT id, username, password_hash
                 FROM users
                 WHERE username = $1`,
                [username]
            );

            // 3. Check if user exists
            if (result.rows.length === 0) {
                return res.status(401).json({
                    message: 'Invalid username or password'
                });
            }

            const user = result.rows[0];

            // 4. Compare password with saved hash
            const isValidPassword = await bcrypt.compare(
                password,
                user.password_hash
            );

            if (!isValidPassword) {
                return res.status(401).json({
                    message: 'Invalid username or password'
                });
            }

            // 5. Generate JWT Access Token
            const accessToken = generateAccessToken(user);

            // 6. Return successful login response
            return res.status(200).json({
                message: 'Login successful',
                user: {
                    id: user.id,
                    username: user.username
                },
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: 900
            });

        } catch (error) {
            console.error('Login error:', error.message);

            return res.status(500).json({
                message: 'Internal server error'
            });
        }
    }
};

module.exports = authController;