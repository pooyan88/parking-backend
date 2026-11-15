const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { runMigrations } = require('../Database/migrationRunner');

const connectionString = process.env.PARKING_TEST_DATABASE_URL;
const quiet = { log() {} };

test('ownership migration with real PostgreSQL', { skip: !connectionString }, async t => {
    const maintenanceUrl = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(maintenanceUrl.protocol),
        'Use a PostgreSQL URL.');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(maintenanceUrl.hostname),
        'Integration tests are restricted to a local PostgreSQL instance.');
    assert.equal(maintenanceUrl.search, '',
        'Use a URL without query parameters so host and database cannot be overridden.');

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parking-legacy-integration-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const filename of await fs.readdir(path.join(__dirname, '..', 'migrations'))) {
        if (/^00[1-4]_.*\.js$/.test(filename)) {
            await fs.copyFile(path.join(__dirname, '..', 'migrations', filename), path.join(directory, filename));
        }
    }

    async function fixture(context) {
        const admin = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
        const name = `parking_ownership_test_${randomUUID().replaceAll('-', '')}`;
        let pool;
        let created = false;
        context.after(async () => {
            try {
                if (pool) await pool.end();
                if (created) await admin.query(`DROP DATABASE "${name}"`);
            } finally {
                await admin.end();
            }
        });
        // The identifier is generated locally from a fixed prefix and UUID,
        // never from a client value or database input.
        await admin.query(`CREATE DATABASE "${name}"`);
        created = true;
        const databaseUrl = new URL(maintenanceUrl);
        databaseUrl.pathname = `/${name}`;
        pool = new Pool({ connectionString: databaseUrl.href, connectionTimeoutMillis: 3000 });
        await runMigrations(pool, 'up', { directory, ...quiet });
        return pool;
    }

    async function addUser(pool, id) {
        await pool.query(`INSERT INTO public.users (id, username, phone_number, password_hash)
            VALUES ($1, $2, $3, $4)`, [id, `owner_${id}`, `test_phone_${id}`, 'integration-test-only-hash']);
    }

    await t.test('empty parking table with no users enforces ownership constraints', async context => {
        const pool = await fixture(context);
        await runMigrations(pool, 'up', quiet);
        await assert.rejects(pool.query("INSERT INTO public.parkings (name) VALUES ('No owner')"), { code: '23502' });
        await assert.rejects(pool.query("INSERT INTO public.parkings (name, owner_id) VALUES ('Missing user', 999)"), { code: '23503' });
        await addUser(pool, 42);
        await pool.query("INSERT INTO public.parkings (name, owner_id) VALUES ('Owned lot', 42)");
        await assert.rejects(pool.query('DELETE FROM public.users WHERE id = 42'), { code: '23503' });
        const index = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'parkings_owner_id_idx'");
        assert.equal(index.rowCount, 1);
        await runMigrations(pool, 'up', quiet);
        assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM public.schema_migrations')).rows[0].count, 5);
    });

    await t.test('empty parking table with multiple users needs no assignment', async context => {
        const pool = await fixture(context);
        await addUser(pool, 42);
        await addUser(pool, 99);
        await runMigrations(pool, 'up', quiet);
        assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM public.parkings')).rows[0].count, 0);
        assert.equal((await pool.query('SELECT MAX(version) AS version FROM public.schema_migrations')).rows[0].version, 5);
    });

    await t.test('one user receives existing lots without changing users or sessions', async context => {
        const pool = await fixture(context);
        await addUser(pool, 42);
        await pool.query("INSERT INTO public.parkings (name, location) VALUES ('North lot', 'North'), ('South lot', 'South')");
        await pool.query("INSERT INTO public.refresh_tokens (user_id, token_hash, expires_at) VALUES (42, 'test-token-hash', NOW() + INTERVAL '1 day')");
        const usersBefore = (await pool.query('SELECT * FROM public.users ORDER BY id')).rows;
        const tokensBefore = (await pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows;
        const parkingsBefore = (await pool.query('SELECT id, name, location FROM public.parkings ORDER BY id')).rows;
        await runMigrations(pool, 'up', quiet);
        assert.deepEqual((await pool.query('SELECT * FROM public.users ORDER BY id')).rows, usersBefore);
        assert.deepEqual((await pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows, tokensBefore);
        assert.deepEqual((await pool.query('SELECT id, name, location FROM public.parkings ORDER BY id')).rows, parkingsBefore);
        assert.deepEqual((await pool.query('SELECT owner_id FROM public.parkings ORDER BY id')).rows, [{ owner_id: 42 }, { owner_id: 42 }]);

        await addUser(pool, 99);
        await pool.query("INSERT INTO public.parkings (name, owner_id) VALUES ('Other owner lot', 99)");
        const appPool = require('../Database/db');
        const controller = require('../Controller/parkingController');
        context.mock.method(appPool, 'query', (sql, values) => pool.query(sql, values));
        const res = { json(rows) { this.body = rows; } };
        await controller.getAllParkings({ user: { id: '42' }, query: { owner_id: '99' } }, res);
        assert.deepEqual(res.body, parkingsBefore);
    });

    for (const ids of [[], [42, 99]]) {
        await t.test(`existing lots with ${ids.length} users roll back without assigning ownership`, async context => {
            const pool = await fixture(context);
            for (const id of ids) await addUser(pool, id);
            await pool.query("INSERT INTO public.parkings (name, location) VALUES ('Legacy lot', 'Original location')");
            const before = (await pool.query('SELECT * FROM public.parkings')).rows;
            await assert.rejects(runMigrations(pool, 'up', quiet), /Cannot assign existing parking lots/);
            assert.deepEqual((await pool.query('SELECT * FROM public.parkings')).rows, before);
            assert.equal((await pool.query('SELECT MAX(version) AS version FROM public.schema_migrations')).rows[0].version, 4);
        });
    }
});
