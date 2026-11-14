const pool = require('../Database/db');

async function migrate() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS parkings (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255)
        )`);
        console.log('Migration completed successfully!');
    } catch (error) {
        console.error('Migration failed:', error.message);
    } finally {
        await pool.end();
    }
}

migrate();