const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config({ quiet: true });
const { runMigrations } = require('../Database/migrationRunner');
const { inject } = require('./helpers/http');

test('user names migrate existing accounts and round-trip through signup and login',
    { skip: !process.env.PARKING_TEST_DATABASE_URL }, async t => {
        const url = new URL(process.env.PARKING_TEST_DATABASE_URL);
        assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
        assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only local test databases are allowed');
        assert.equal(url.search, '', 'Query parameters must not override the generated database');
        const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 3000 });
        const databaseName = `parking_auth_test_${randomUUID().replaceAll('-', '')}`;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parking-auth-migrations-'));
        let pool; let created = false;
        t.after(async () => {
            try {
                if (pool) await pool.end();
                if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
            } finally {
                await admin.end();
                await fs.rm(directory, { recursive: true, force: true });
            }
        });
        await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
        url.pathname = `/${databaseName}`;
        pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 3000 });
        const source = path.join(__dirname, '..', 'migrations');
        for (const filename of await fs.readdir(source)) {
            if (/^(00[1-9]|01[0-2])_/.test(filename)) {
                await fs.copyFile(path.join(source, filename), path.join(directory, filename));
            }
        }
        await runMigrations(pool, 'up', { directory, log() {} });
        const passwordHash = await bcrypt.hash('test-password', 4);
        const before = (await pool.query(`INSERT INTO public.users (username, phone_number, password_hash)
            VALUES ('legacy', 'legacy-phone', $1) RETURNING *`, [passwordHash])).rows[0];
        await pool.query(`INSERT INTO public.refresh_tokens (user_id, token_hash, expires_at)
            VALUES ($1, 'legacy-token-hash', NOW() + INTERVAL '1 day')`, [before.id]);
        const sessionsBefore = (await pool.query('SELECT * FROM public.refresh_tokens')).rows;
        await runMigrations(pool, 'up', { log() {} });
        await runMigrations(pool, 'up', { log() {} }); // Re-running must be a no-op.
        const after = (await pool.query('SELECT * FROM public.users WHERE id = $1', [before.id])).rows[0];
        assert.deepEqual(after, { ...before, name: null, family_name: null });
        assert.deepEqual((await pool.query('SELECT * FROM public.refresh_tokens')).rows, sessionsBefore);

        const applicationPool = require('../Database/db');
        t.mock.method(applicationPool, 'query', (sql, values) => pool.query(sql, values));
        const originalSecret = process.env.JWT_ACCESS_SECRET;
        process.env.JWT_ACCESS_SECRET = 'auth-integration-test-secret';
        t.after(async () => {
            if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
            else process.env.JWT_ACCESS_SECRET = originalSecret;
            await applicationPool.end();
        });
        const app = require('../app');
        const login = username => inject(app, { method: 'POST', url: '/auth/login',
            body: { username, password: 'test-password' } });
        const legacy = await login('legacy');
        assert.equal(legacy.status, 200);
        assert.equal(legacy.body.user.name, 'کاربر جدید');
        assert.equal(legacy.body.user.family_name, 'کاربر جدید');
        assert.ok(legacy.body.access_token);
        assert.ok(legacy.body.refresh_token);

        const cases = [
            [{}, [null, null]],
            [{ name: null, family_name: null }, [null, null]],
            [{ name: ' \t ', family_name: '\n' }, [null, null]],
            [{ name: ' علی ' }, ['علی', null]],
            [{ family_name: ' محمدی ' }, [null, 'محمدی']],
            [{ name: "علی'); DROP TABLE users; --", family_name: ' محمدی ' },
                ["علی'); DROP TABLE users; --", 'محمدی']]
        ];
        for (const [index, [names, stored]] of cases.entries()) {
            const username = `signup-${index}`;
            const signup = await inject(app, { method: 'POST', url: '/auth/signup', body: {
                username, phone_number: `phone-${index}`, password: 'test-password', ...names
            } });
            assert.equal(signup.status, 201);
            const expected = { name: stored[0] ?? 'کاربر جدید', family_name: stored[1] ?? 'کاربر جدید' };
            assert.equal(signup.body.user.name, expected.name);
            assert.equal(signup.body.user.family_name, expected.family_name);
            const saved = (await pool.query('SELECT name, family_name FROM public.users WHERE id = $1',
                [signup.body.user.id])).rows[0];
            assert.deepEqual(saved, { name: stored[0], family_name: stored[1] });
            const loggedIn = await login(username);
            assert.equal(loggedIn.status, 200);
            assert.deepEqual(loggedIn.body.user, { id: signup.body.user.id, username, ...expected });
            assert.equal(signup.body.user.password_hash, undefined);
            assert.equal(loggedIn.body.user.password_hash, undefined);
        }
        await pool.query("UPDATE public.users SET name = NULL, family_name = NULL WHERE username = 'signup-5'");
        const cleared = await login('signup-5');
        assert.equal(cleared.status, 200);
        assert.equal(cleared.body.user.name, 'کاربر جدید');
        assert.equal(cleared.body.user.family_name, 'کاربر جدید');
    });
