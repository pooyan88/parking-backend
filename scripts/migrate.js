const { runMigrations } = require('../Database/migrationRunner');

async function main() {
    const command = process.argv[2];
    if (process.argv.length !== 3 || !['status', 'baseline', 'up'].includes(command)) {
        console.error('Usage: node scripts/migrate.js <status|baseline|up>');
        process.exitCode = 1;
        return;
    }
    const pool = require('../Database/db');
    // Finish with a clear error instead of waiting forever for a connection.
    pool.options.connectionTimeoutMillis = 5000;
    try {
        await runMigrations(pool, command);
    } catch (error) {
        console.error(`Migration command failed: ${error.message}`);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main().catch(() => {
    console.error('Migration command failed unexpectedly.');
    process.exitCode = 1;
});
