const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { legacyMigrations, verifyBaseline } = require('./migrationBaseline');

const migrationsDirectory = path.join(__dirname, '..', 'migrations');
const lockKey = [74219, 1];

async function loadMigrations(directory = migrationsDirectory) {
    const files = (await fs.readdir(directory)).filter(name => /\.(js|sql)$/.test(name)).sort();
    const migrations = [];
    for (const filename of files) {
        const match = /^(\d{3})_[a-z0-9_]+\.(js|sql)$/.exec(filename);
        if (!match || Number(match[1]) !== migrations.length + 1) {
            throw new Error(`Invalid migration order or name: ${filename}. Use consecutive numbers starting at 001.`);
        }
        const contents = await fs.readFile(path.join(directory, filename));
        const checksum = crypto.createHash('sha256').update(contents).digest('hex');
        const legacy = legacyMigrations[migrations.length];
        if (legacy && (filename !== legacy.filename || checksum !== legacy.checksum)) {
            throw new Error(`Original migration changed: ${filename}. Restore migrations 001–004; add a new migration instead.`);
        }
        if (!legacy && match[2] !== 'sql') {
            throw new Error(`New migrations must be SQL files: ${filename}.`);
        }
        if (!contents.toString('utf8').trim()) throw new Error(`Empty migration: ${filename}.`);
        migrations.push({ version: Number(match[1]), filename, checksum, sql: legacy?.sql ?? contents.toString('utf8') });
    }
    if (migrations.length < legacyMigrations.length) throw new Error('Original migrations 001–004 are required.');
    return migrations;
}

function validateHistory(migrations, history) {
    for (const [index, row] of history.entries()) {
        const migration = migrations[index];
        if (!migration || row.version !== migration.version || row.filename !== migration.filename) {
            throw new Error('Migration history differs from local files. Restore the correct files before continuing.');
        }
        if (row.checksum !== migration.checksum) {
            throw new Error(`Applied migration changed: ${row.filename}. Restore it and create a new migration.`);
        }
    }
}

async function readHistory(client) {
    const exists = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
    if (!exists.rows[0].exists) return null;
    const result = await client.query(`
        SELECT version, filename, checksum, source, recorded_at
        FROM public.schema_migrations ORDER BY version`);
    return result.rows;
}

async function transaction(client, work) {
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('SET LOCAL search_path TO pg_catalog, public');
        await work();
        await client.query('COMMIT');
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Migration failed and the transaction could not be rolled back.');
        }
        throw error;
    }
}

async function createHistory(client) {
    await client.query(`CREATE TABLE public.schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        filename TEXT UNIQUE NOT NULL,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        source TEXT NOT NULL CHECK (source IN ('baseline', 'applied')),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function recordMigration(client, migration, source) {
    await client.query(`
        INSERT INTO public.schema_migrations (version, filename, checksum, source)
        VALUES ($1, $2, $3, $4)`, [migration.version, migration.filename, migration.checksum, source]);
}

async function runMigrations(pool, command, { directory = migrationsDirectory, log = console.log } = {}) {
    if (!['status', 'baseline', 'up'].includes(command)) throw new Error('Usage: node scripts/migrate.js <status|baseline|up>');
    const migrations = await loadMigrations(directory);
    const client = await pool.connect();
    let locked = false;
    let cleanupError;
    try {
        if (command !== 'status') {
            const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', lockKey);
            locked = lock.rows[0].locked;
            if (!locked) throw new Error('Another migration command is running. Try again after it finishes.');
        }
        let history = await readHistory(client);
        validateHistory(migrations, history ?? []);

        if (command === 'status') {
            if (history === null) log('No migration history. Existing database: run db:baseline. Empty database: run db:migrate.');
            for (const migration of migrations) {
                const row = history?.find(item => item.version === migration.version);
                log(`${migration.filename}: ${row ? row.source : 'pending'}`);
            }
            return;
        }

        if (command === 'baseline') {
            if (history !== null) {
                if (history.length < legacyMigrations.length) throw new Error('Migration history already exists but is incomplete. Run db:migrate.');
                log('Baseline already recorded. No changes made.');
                return;
            }
            await transaction(client, async () => {
                await verifyBaseline(client);
                await createHistory(client);
                for (const migration of migrations.slice(0, legacyMigrations.length)) {
                    await recordMigration(client, migration, 'baseline');
                }
            });
            log('Verified and recorded migrations 001–004. Existing business data was not changed.');
            return;
        }

        if (history === null) {
            const tables = await client.query(`
                SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'`);
            if (tables.rows.length > 0) {
                throw new Error('Existing database has no migration history. Run npm run db:baseline first. No changes made.');
            }
            await transaction(client, () => createHistory(client));
            history = [];
        }
        const pending = migrations.slice(history.length);
        for (const migration of pending) {
            await transaction(client, async () => {
                await client.query(migration.sql);
                await recordMigration(client, migration, 'applied');
            });
            log(`Applied ${migration.filename}`);
        }
        if (pending.length === 0) log('Database is up to date. No changes made.');
    } finally {
        if (locked) {
            try {
                await client.query('SELECT pg_advisory_unlock($1, $2)', lockKey);
            } catch (error) {
                cleanupError = error;
            }
        }
        // A broken connection must not return to the pool holding a session lock.
        client.release(cleanupError);
        if (cleanupError) throw cleanupError;
    }
}

module.exports = { loadMigrations, validateHistory, runMigrations };
