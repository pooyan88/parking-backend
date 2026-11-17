const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ quiet: true });
const { database } = require('./helpers/postgres');
const { runMigrations } = require('../Database/migrationRunner');
const { inject } = require('./helpers/http');
const { generateAccessToken } = require('../Utils/tokenUtils');
const app = require('../app');

test('PostgreSQL user profiles: backfill, signup, self-service updates, uniqueness, and isolation',
    { skip: !process.env.PARKING_TEST_DATABASE_URL }, async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parking-profile-migrations-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const source = path.join(__dirname, '..', 'migrations');
        for (const filename of await fs.readdir(source)) {
            if (/^(00[1-9]|01[0-3])_/.test(filename)) {
                await fs.copyFile(path.join(source, filename), path.join(directory, filename));
            }
        }
        const d = await database(t, { directory });
        await d.pool.query('UPDATE public.users SET name=$1, family_name=$2 WHERE id=$3', ['علی', 'محمدی', d.owner]);
        await d.pool.query(`INSERT INTO public.refresh_tokens (user_id,token_hash,expires_at)
            VALUES ($1,'profile-existing-session',NOW()+INTERVAL '1 day')`, [d.owner]);
        const usersBefore = (await d.pool.query('SELECT * FROM public.users ORDER BY id')).rows;
        const sessionsBefore = (await d.pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows;
        await runMigrations(d.pool, 'up', { log() {} });
        await runMigrations(d.pool, 'up', { log() {} });
        assert.deepEqual((await d.pool.query('SELECT * FROM public.users ORDER BY id')).rows, usersBefore);
        assert.deepEqual((await d.pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows, sessionsBefore);
        assert.deepEqual((await d.pool.query(`SELECT user_id,username,phone_number,name,family_name
            FROM public.user_profiles ORDER BY user_id`)).rows,
        usersBefore.map(({ id, username, phone_number, name, family_name }) => ({ user_id: id, username, phone_number, name, family_name })));

        const originalSecret = process.env.JWT_ACCESS_SECRET;
        process.env.JWT_ACCESS_SECRET = 'profile-integration-test-secret';
        t.after(() => {
            if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
            else process.env.JWT_ACCESS_SECRET = originalSecret;
        });
        function headers(id) {
            return { authorization: 'Bearer ' + generateAccessToken({ id, username: 'untrusted-token-name' }) };
        }
        const get = (id, url = '/profile') => inject(app, { url, headers: headers(id) });
        const patch = (id, body) => inject(app, { method: 'PATCH', url: '/profile', headers: headers(id), body });

        await t.test('one profile per user and no profile without a user', async () => {
            await assert.rejects(d.pool.query(`INSERT INTO public.user_profiles (user_id,username,phone_number)
                VALUES ($1,'duplicate','duplicate')`, [d.owner]), { code: '23505' });
            await assert.rejects(d.pool.query(`INSERT INTO public.user_profiles (user_id,username,phone_number)
                VALUES (2147483647,'missing','missing')`), { code: '23503' });
        });

        await t.test('reads are private and use database identity with the previous null fallback', async () => {
            const own = await get(d.owner, '/profile?user_id=' + d.foreignOwner);
            assert.equal(own.status, 200);
            assert.equal(own.body.user_id, d.owner);
            assert.equal(own.body.username, 'owner_a');
            assert.equal(own.body.name, 'علی');
            assert.equal(own.body.family_name, 'محمدی');
            assert.equal(own.body.password_hash, undefined);
            const foreign = await get(d.foreignOwner);
            assert.equal(foreign.body.user_id, d.foreignOwner);
            assert.equal(foreign.body.name, 'کاربر جدید');
            assert.equal(foreign.body.family_name, 'کاربر جدید');
            assert.equal((await get(d.owner, '/profile/' + d.foreignOwner)).status, 404);
            assert.equal((await get(2147483647)).status, 404);
            assert.equal((await patch(2147483647, { name: 'Missing' })).status, 404);
            assert.equal((await inject(app, { url: '/profile' })).status, 401);
            assert.equal((await inject(app, { method: 'PATCH', url: '/profile', body: { name: 'No token' } })).status, 401);
        });

        await t.test('updates preserve other accounts, username, credentials, and sessions', async () => {
            const otherBefore = (await get(d.foreignOwner)).body;
            const updated = await patch(d.owner, { phone_number: ' 09121111111 ', name: ' رضا ', family_name: ' احمدی ' });
            assert.equal(updated.status, 200);
            assert.equal(updated.body.profile.username, 'owner_a');
            assert.equal(updated.body.profile.phone_number, '09121111111');
            assert.equal(updated.body.profile.name, 'رضا');
            assert.equal(updated.body.profile.family_name, 'احمدی');
            assert.deepEqual((await get(d.foreignOwner)).body, otherBefore);
            const account = (await d.pool.query('SELECT * FROM public.users WHERE id=$1', [d.owner])).rows[0];
            assert.deepEqual(account, { ...usersBefore[0], phone_number: '09121111111', name: 'رضا', family_name: 'احمدی' });
            assert.deepEqual((await d.pool.query('SELECT * FROM public.refresh_tokens ORDER BY id')).rows, sessionsBefore);
            for (const body of [{ username: 'Changed' }, { user_id: d.foreignOwner }, { id: d.foreignOwner }, { password_hash: 'Changed' }]) {
                assert.equal((await patch(d.owner, body)).status, 400);
            }
            const cleared = await patch(d.owner, { name: null, family_name: ' \t ' });
            assert.equal(cleared.status, 200);
            assert.equal(cleared.body.profile.name, 'کاربر جدید');
            assert.equal(cleared.body.profile.family_name, 'کاربر جدید');
            assert.equal(cleared.body.profile.phone_number, '09121111111');
            assert.deepEqual((await d.pool.query('SELECT name,family_name FROM public.users WHERE id=$1', [d.owner])).rows[0],
                { name: null, family_name: null });
        });

        await t.test('phone conflicts roll back all edits and concurrent claims have one winner', async () => {
            const before = (await get(d.owner)).body;
            const conflicting = await patch(d.owner, { phone_number: 'test-b', name: 'Must roll back' });
            assert.equal(conflicting.status, 409);
            assert.deepEqual((await get(d.owner)).body, before);
            const race = await Promise.all([
                patch(d.owner, { phone_number: 'shared-phone', name: 'First' }),
                patch(d.foreignOwner, { phone_number: 'shared-phone', name: 'Second' })
            ]);
            assert.deepEqual(race.map(res => res.status).sort(), [200, 409]);
            const mismatch = await d.pool.query(`SELECT u.id FROM public.users u JOIN public.user_profiles p ON p.user_id=u.id
                WHERE (u.username,u.phone_number,u.name,u.family_name) IS DISTINCT FROM (p.username,p.phone_number,p.name,p.family_name)`);
            assert.equal(mismatch.rowCount, 0);
        });

        await t.test('concurrent partial updates preserve both changes and Unicode text', async () => {
            const name = '🚗'.repeat(255);
            const family = "محمدی'); DROP TABLE users; --";
            const race = await Promise.all([patch(d.owner, { name }), patch(d.owner, { family_name: family })]);
            assert.deepEqual(race.map(res => res.status), [200, 200]);
            const result = await get(d.owner);
            assert.equal(result.body.name, name);
            assert.equal(result.body.family_name, family);
        });

        await t.test('signup creates profiles and profile edits appear in subsequent login', async () => {
            const username = 'profile-' + randomUUID();
            const password = 'integration-test-password';
            const signup = await inject(app, { method: 'POST', url: '/auth/signup', body: {
                username, phone_number: username, password, name: 'علی', family_name: 'محمدی'
            } });
            assert.equal(signup.status, 201);
            const id = signup.body.user.id;
            const initial = await get(id);
            assert.equal(initial.status, 200);
            assert.equal(initial.body.name, 'علی');
            const login = () => inject(app, { method: 'POST', url: '/auth/login', body: { username, password } });
            const loggedIn = await login();
            assert.equal(loggedIn.status, 200);
            assert.equal((await patch(id, { phone_number: 'signup-new-phone', name: 'رضا', family_name: null })).status, 200);
            const updated = await login();
            assert.equal(updated.status, 200);
            assert.equal(updated.body.user.name, 'رضا');
            assert.equal(updated.body.user.family_name, 'کاربر جدید');
            const oldAccess = await inject(app, { url: '/profile', headers: { authorization: 'Bearer ' + loggedIn.body.access_token } });
            assert.equal(oldAccess.status, 200);
            assert.equal(oldAccess.body.phone_number, 'signup-new-phone');
            const refreshed = await inject(app, { method: 'POST', url: '/auth/refresh', body: { refresh_token: loggedIn.body.refresh_token } });
            assert.equal(refreshed.status, 200);
            // Changes through older account-writing paths also update profiles.
            await d.pool.query('UPDATE public.users SET name=$1 WHERE id=$2', ['Updated directly', id]);
            assert.equal((await get(id)).body.name, 'Updated directly');
            await d.pool.query('DELETE FROM public.users WHERE id=$1', [id]);
            assert.equal((await d.pool.query('SELECT user_id FROM public.user_profiles WHERE user_id=$1', [id])).rowCount, 0);
        });
    });
