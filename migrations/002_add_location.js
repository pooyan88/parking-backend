const pool = require('../Database/db');

async function migrate() {
    try {
        await pool.query(`ALTER TABLE parkings ADD COLUMN location VARCHAR(255)`);
        console.log('Migration completed successfully!');
    } catch (error) {
        console.error('Migration failed:', error.message);
    } finally {
        await pool.end();
    }
}

migrate();