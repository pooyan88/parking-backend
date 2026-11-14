const pool = require('../Database/db');

async function migrate() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            phone_number VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        console.log('Migration completed successfully!');
    } catch (error) {
        console.error('Migration failed:', error.message);
    }
}

migrate();