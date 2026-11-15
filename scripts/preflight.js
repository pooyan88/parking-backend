require('dotenv').config({ quiet: true });
const { validateEnvironment } = require('../Utils/config');
const { loadMigrations, validateHistory } = require('../Database/migrationRunner');
async function main() {
    validateEnvironment();
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required');
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--allow-pending')) throw new Error('Only --allow-pending is supported');
    const migrations = await loadMigrations();
    const pool = require('../Database/db');
    pool.options.connectionTimeoutMillis = 3000;
    let client; let reading = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN READ ONLY');
        reading = true;
        const version = (await client.query("SELECT current_setting('server_version_num')::integer AS version")).rows[0].version;
        if (version < 140000) throw new Error('PostgreSQL 14 or later is required');
        const exists = (await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists")).rows[0].exists;
        if (!exists) throw new Error('Migration history is missing. Verify and baseline the existing database first.');
        const history = (await client.query('SELECT version, filename, checksum FROM public.schema_migrations ORDER BY version')).rows;
        validateHistory(migrations, history);
        const pending = migrations.slice(history.length).map(row => row.filename);
        const extension = (await client.query("SELECT installed_version FROM pg_available_extensions WHERE name = 'btree_gist'")).rows[0];
        if (!extension) throw new Error('btree_gist is unavailable on this PostgreSQL installation');
        const privilege = (await client.query("SELECT has_database_privilege(current_database(), 'CREATE') AS can_create")).rows[0].can_create;
        if (!extension.installed_version && !privilege) throw new Error('Installing btree_gist requires database CREATE privilege or prior installation');
        console.log(`PostgreSQL ${version}; tracked migrations: ${history.length}; pending: ${pending.length}`);
        if (pending.length) console.log(`Pending migrations: ${pending.join(', ')}`);
        if (pending.length && !args.includes('--allow-pending')) throw new Error('Apply pending migrations before accepting this release');
        if (!pending.length && !extension.installed_version) throw new Error('Required btree_gist extension is not installed');
        if (!pending.length) {
            for (const table of ['users','refresh_tokens','parkings','parking_floors','parking_slots','customers','rental_contracts','contract_events']) {
                const present = (await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`])).rows[0].present;
                if (!present) throw new Error(`Required table is missing: ${table}`);
            }
            const unsafe = (await client.query(`SELECT EXISTS(SELECT 1 FROM public.rental_contracts c
                JOIN public.parkings p ON p.id=c.parking_id JOIN public.parking_slots s ON s.id=c.slot_id
                JOIN public.parking_floors f ON f.id=s.floor_id JOIN public.customers cu ON cu.id=c.customer_id
                WHERE c.status='confirmed' AND c.ends_at>NOW() AND
                (p.archived_at IS NOT NULL OR f.archived_at IS NOT NULL OR s.archived_at IS NOT NULL
                 OR cu.archived_at IS NOT NULL OR s.operational_status <> 'usable')) AS unsafe`)).rows[0].unsafe;
            if (unsafe) throw new Error('Current/future rentals conflict with archived or maintenance resources');
            const constraint = (await client.query(`SELECT COUNT(*)::integer AS count FROM pg_constraint
                WHERE conrelid='public.rental_contracts'::regclass AND conname='rental_contracts_no_overlap'
                AND contype='x' AND convalidated`)).rows[0].count;
            if (constraint !== 1) throw new Error('Rental overlap exclusion constraint is missing or invalid');
            const invalid = (await client.query(`SELECT COUNT(*)::integer AS count FROM pg_constraint
                WHERE connamespace='public'::regnamespace AND NOT convalidated`)).rows[0].count;
            if (invalid) throw new Error('Unvalidated database constraints need review');
        }
        await client.query('ROLLBACK');
        reading = false;
        console.log('Read-only deployment preflight passed. No database changes made.');
    } finally {
        if (client) { if (reading) await client.query('ROLLBACK').catch(() => {}); client.release(); }
        await pool.end();
    }
}
main().catch(error => { console.error(`Preflight failed: ${error.message}`); process.exitCode = 1; });
