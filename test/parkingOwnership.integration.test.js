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

test('parking migrations with real PostgreSQL', { skip: !connectionString }, async t => {
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

    // Keep ownership-only checks at version 005 as later features add migrations.
    const ownershipDirectory = path.join(directory, 'ownership');
    await fs.mkdir(ownershipDirectory);
    for (const filename of await fs.readdir(directory)) {
        if (filename.endsWith('.js')) {
            await fs.copyFile(path.join(directory, filename), path.join(ownershipDirectory, filename));
        }
    }
    await fs.copyFile(path.join(__dirname, '..', 'migrations', '005_add_parking_ownership.sql'),
        path.join(ownershipDirectory, '005_add_parking_ownership.sql'));

    function runOwnership(pool, command = 'up') {
        return runMigrations(pool, command, { directory: ownershipDirectory, ...quiet });
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
        await runOwnership(pool);
        await assert.rejects(pool.query("INSERT INTO public.parkings (name) VALUES ('No owner')"), { code: '23502' });
        await assert.rejects(pool.query("INSERT INTO public.parkings (name, owner_id) VALUES ('Missing user', 999)"), { code: '23503' });
        await addUser(pool, 42);
        await pool.query("INSERT INTO public.parkings (name, owner_id) VALUES ('Owned lot', 42)");
        await assert.rejects(pool.query('DELETE FROM public.users WHERE id = 42'), { code: '23503' });
        const index = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'parkings_owner_id_idx'");
        assert.equal(index.rowCount, 1);
        await runOwnership(pool);
        assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM public.schema_migrations')).rows[0].count, 5);
    });

    await t.test('empty parking table with multiple users needs no assignment', async context => {
        const pool = await fixture(context);
        await addUser(pool, 42);
        await addUser(pool, 99);
        await runOwnership(pool);
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

        // Reproduce an existing database that predates migration tracking.
        // This is the isolated, disposable test database created above.
        await pool.query('DROP TABLE public.schema_migrations');
        await runOwnership(pool, 'baseline');
        assert.deepEqual((await pool.query('SELECT version, source FROM public.schema_migrations ORDER BY version')).rows,
            [1, 2, 3, 4].map(version => ({ version, source: 'baseline' })));
        assert.deepEqual((await pool.query('SELECT * FROM public.users ORDER BY id')).rows, usersBefore);
        assert.deepEqual((await pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows, tokensBefore);
        assert.deepEqual((await pool.query('SELECT id, name, location FROM public.parkings ORDER BY id')).rows, parkingsBefore);

        await runOwnership(pool);
        assert.deepEqual((await pool.query('SELECT * FROM public.users ORDER BY id')).rows, usersBefore);
        assert.deepEqual((await pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows, tokensBefore);
        assert.deepEqual((await pool.query('SELECT id, name, location FROM public.parkings ORDER BY id')).rows, parkingsBefore);
        assert.deepEqual((await pool.query('SELECT owner_id FROM public.parkings ORDER BY id')).rows, [{ owner_id: 42 }, { owner_id: 42 }]);

    });

    await t.test('creation uses the current owner and database time while preserving unknown old dates', async context => {
        const pool = await fixture(context);
        await addUser(pool, 42);
        await pool.query("INSERT INTO public.parkings (name, location) VALUES ('Legacy lot', 'Original location')");
        await runMigrations(pool, 'up', quiet);
        const legacy = (await pool.query('SELECT id, name, location, created_at FROM public.parkings')).rows[0];
        assert.equal(legacy.created_at, null);
        assert.equal(legacy.name, 'Legacy lot');
        assert.equal(legacy.location, 'Original location');

        await addUser(pool, 99);
        const appPool = require('../Database/db');
        const controller = require('../Controller/parkingController');
        context.mock.method(appPool, 'query', (sql, values) => pool.query(sql, values));
        function response() {
            return { statusCode: 200, status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; } };
        }

        const before = (await pool.query('SELECT clock_timestamp() AS time')).rows[0].time;
        const created = response();
        await controller.createParking({ user: { id: '42' }, body: {
            name: '  New lot  ', location: ' Tehran ', owner_id: 99, created_at: '1900-01-01T00:00:00Z'
        } }, created);
        const after = (await pool.query('SELECT clock_timestamp() AS time')).rows[0].time;
        assert.equal(created.statusCode, 201);
        const parking = created.body.parking;
        assert.equal(parking.name, 'New lot');
        assert.equal(parking.location, 'Tehran');
        assert.ok(parking.created_at instanceof Date);
        assert.ok(parking.created_at >= before && parking.created_at <= after);
        assert.equal((await pool.query('SELECT owner_id FROM public.parkings WHERE id = $1', [parking.id])).rows[0].owner_id, 42);

        const other = response();
        await controller.createParking({ user: { id: '99' }, body: { name: 'Other lot', location: 'South' } }, other);
        assert.equal(other.statusCode, 201);
        const listed = response();
        await controller.getAllParkings({ user: { id: '42' }, query: { owner_id: '99' } }, listed);
        assert.deepEqual(listed.body, [legacy, parking]);
    });

    await t.test('updates preserve ownership, creation time, and fields outside the request', async context => {
        const pool = await fixture(context);
        await addUser(pool, 42);
        await pool.query("INSERT INTO public.parkings (name, location) VALUES ('Legacy lot', 'Original location')");
        await runMigrations(pool, 'up', quiet);
        const owned = (await pool.query('SELECT * FROM public.parkings')).rows[0];
        assert.equal(owned.created_at, null);
        await addUser(pool, 99);
        const other = (await pool.query(`INSERT INTO public.parkings (name, location, owner_id)
            VALUES ('Other owner lot', 'South', 99) RETURNING *`)).rows[0];
        const another = (await pool.query(`INSERT INTO public.parkings (name, location, owner_id)
            VALUES ('Another owned lot', 'North', 42) RETURNING *`)).rows[0];

        const appPool = require('../Database/db');
        const controller = require('../Controller/parkingController');
        context.mock.method(appPool, 'query', (sql, values) => pool.query(sql, values));
        function response() {
            return { statusCode: 200, status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; } };
        }

        const before = (await pool.query('SELECT * FROM public.parkings ORDER BY id')).rows;
        for (const id of [other.id, 2147483647]) {
            const denied = response();
            await controller.updateParking({ user: { id: '42' }, params: { id: String(id) },
                body: { name: 'Unauthorized change' } }, denied);
            assert.equal(denied.statusCode, 404);
            assert.deepEqual(denied.body, { message: 'Parking lot not found' });
        }
        assert.deepEqual((await pool.query('SELECT * FROM public.parkings ORDER BY id')).rows, before);

        const renamed = response();
        await controller.updateParking({ user: { id: '42' }, params: { id: String(owned.id) },
            body: { name: ' Renamed lot ' } }, renamed);
        assert.equal(renamed.statusCode, 200);
        assert.deepEqual(renamed.body.parking, { id: owned.id, name: 'Renamed lot', location: owned.location, created_at: null });

        const moved = response();
        await controller.updateParking({ user: { id: '42' }, params: { id: String(owned.id) },
            body: { location: ' New location ' } }, moved);
        assert.equal(moved.statusCode, 200);
        assert.deepEqual((await pool.query('SELECT * FROM public.parkings WHERE id = $1', [owned.id])).rows[0],
            { ...owned, name: 'Renamed lot', location: 'New location' });
        assert.deepEqual((await pool.query('SELECT * FROM public.parkings WHERE id = $1', [other.id])).rows[0], other);
        assert.deepEqual((await pool.query('SELECT * FROM public.parkings WHERE id = $1', [another.id])).rows[0], another);
    });

    await t.test('archiving preserves rows and hides them from active management', async context => {
        const pool = await fixture(context);
        await runMigrations(pool, 'up', quiet);
        await addUser(pool, 42);
        await addUser(pool, 99);
        const owned = (await pool.query(`INSERT INTO public.parkings (name, location, owner_id)
            VALUES ('Archived lot', 'North', 42) RETURNING *`)).rows[0];
        const active = (await pool.query(`INSERT INTO public.parkings (name, location, owner_id)
            VALUES ('Active lot', 'East', 42) RETURNING *`)).rows[0];
        const other = (await pool.query(`INSERT INTO public.parkings (name, location, owner_id)
            VALUES ('Other owner lot', 'South', 99) RETURNING *`)).rows[0];
        await pool.query("INSERT INTO public.refresh_tokens (user_id, token_hash, expires_at) VALUES (42, 'archive-test-token', NOW() + INTERVAL '1 day')");
        const usersBefore = (await pool.query('SELECT * FROM public.users ORDER BY id')).rows;
        const sessionsBefore = (await pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows;
        assert.equal(owned.archived_at, null);

        const appPool = require('../Database/db');
        const controller = require('../Controller/parkingController');
        context.mock.method(appPool, 'query', (sql, values) => pool.query(sql, values));
        function response() {
            return { statusCode: 200, status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; },
                send(body) { this.body = body; return this; } };
        }

        const denied = response();
        await controller.archiveParking({ user: { id: '42' }, params: { id: String(other.id) } }, denied);
        assert.equal(denied.statusCode, 404);
        assert.deepEqual((await pool.query('SELECT * FROM public.parkings WHERE id = $1', [other.id])).rows[0], other);

        const archived = response();
        await controller.archiveParking({ user: { id: '42' }, params: { id: String(owned.id) },
            body: { owner_id: 99 } }, archived);
        assert.equal(archived.statusCode, 204);
        assert.equal(archived.body, undefined);
        const stored = (await pool.query('SELECT * FROM public.parkings WHERE id = $1', [owned.id])).rows[0];
        assert.ok(stored.archived_at instanceof Date);
        assert.deepEqual({ ...stored, archived_at: null }, owned);

        const repeated = response();
        await controller.archiveParking({ user: { id: '42' }, params: { id: String(owned.id) } }, repeated);
        assert.equal(repeated.statusCode, 204);
        const edited = response();
        await controller.updateParking({ user: { id: '42' }, params: { id: String(owned.id) },
            body: { name: 'Must not change' } }, edited);
        assert.equal(edited.statusCode, 404);
        assert.deepEqual((await pool.query('SELECT * FROM public.parkings WHERE id = $1', [owned.id])).rows[0], stored);

        const listed = response();
        await controller.getAllParkings({ user: { id: '42' }, query: { owner_id: '99', include_archived: 'true' } }, listed);
        assert.deepEqual(listed.body, [{ id: active.id, name: active.name, location: active.location, created_at: active.created_at }]);
        assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM public.parkings')).rows[0].count, 3);
        assert.deepEqual((await pool.query('SELECT * FROM public.users ORDER BY id')).rows, usersBefore);
        assert.deepEqual((await pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows, sessionsBefore);
        assert.deepEqual((await pool.query('SELECT * FROM public.parkings WHERE id = $1', [active.id])).rows[0], active);
    });

    for (const ids of [[], [42, 99]]) {
        await t.test(`existing lots with ${ids.length} users roll back without assigning ownership`, async context => {
            const pool = await fixture(context);
            for (const id of ids) await addUser(pool, id);
            await pool.query("INSERT INTO public.parkings (name, location) VALUES ('Legacy lot', 'Original location')");
            const before = (await pool.query('SELECT * FROM public.parkings')).rows;
            await assert.rejects(runOwnership(pool), /Cannot assign existing parking lots/);
            assert.deepEqual((await pool.query('SELECT * FROM public.parkings')).rows, before);
            assert.equal((await pool.query('SELECT MAX(version) AS version FROM public.schema_migrations')).rows[0].version, 4);
        });
    }
});
