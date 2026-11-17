const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const app = require('../app');
const { inject } = require('./helpers/http');

test.after(() => pool.end());
const secret = 'profile-unit-test-secret';
function headers(id = '7') {
    return { authorization: 'Bearer ' + jwt.sign({ sub: id }, secret, { algorithm: 'HS256', expiresIn: '1m' }) };
}
test.before(() => { process.env.JWT_ACCESS_SECRET = secret; });
const profile = { user_id: 7, username: 'owner', phone_number: '09120000000', name: 'علی', family_name: 'محمدی' };

function connection(t, { missing = false, error, rollbackError } = {}) {
    const calls = [];
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            if (sql.startsWith('UPDATE')) {
                if (error) throw error;
                return { rows: missing ? [] : [{ id: 7 }] };
            }
            if (sql.startsWith('SELECT')) return { rows: [profile] };
            if (sql === 'ROLLBACK' && rollbackError) throw rollbackError;
            return { rows: [] };
        },
        release(error) { calls.push({ release: true, error }); }
    };
    t.mock.method(pool, 'connect', async () => client);
    return calls;
}

test('profile routes require a valid access token before accessing the database', async t => {
    t.mock.method(pool, 'query', () => assert.fail('must not query'));
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const method of ['GET', 'PATCH']) {
        for (const authorization of [undefined, 'Bearer invalid']) {
            const res = await inject(app, { method, url: '/profile', headers: { authorization }, body: { name: 'علی' } });
            assert.equal(res.status, 401);
        }
    }
});

test('GET profile uses the JWT subject, ignoring user IDs in the query', async t => {
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /FROM public\.user_profiles WHERE user_id = \$1/);
        assert.match(sql, /COALESCE\(family_name, 'کاربر جدید'\)/);
        assert.deepEqual(values, ['7']);
        return { rows: [profile] };
    });
    const res = await inject(app, { url: '/profile?user_id=99', headers: headers() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, profile);
});

test('missing profiles return 404', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = await inject(app, { url: '/profile', headers: headers() });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { message: 'Profile not found' });
});

test('PATCH rejects immutable identity fields and invalid values before connecting', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const body of [undefined, null, [], 'text', {},
        { username: 'other' }, { user_id: 99 }, { id: 99 }, { password: 'new-password' },
        { last_name: 'unsupported' }, { name: 1 }, { family_name: false },
        { phone_number: null }, { phone_number: '' }, { phone_number: '  ' }, { phone_number: [] },
        { name: 'a'.repeat(256) }, { family_name: 'a'.repeat(256) }, { phone_number: '1'.repeat(256) },
        { name: 'bad\0text' }, { family_name: 'bad\0text' }, { phone_number: 'bad\0phone' }]) {
        const res = await inject(app, { method: 'PATCH', url: '/profile', headers: headers(), body });
        assert.equal(res.status, 400);
    }
});

test('PATCH trims editable fields and scopes both writes and reads to the authenticated user', async t => {
    const calls = connection(t);
    const res = await inject(app, { method: 'PATCH', url: '/profile?user_id=99', headers: headers(),
        body: { phone_number: ' 09121111111 ', name: ' علی ', family_name: ' محمدی ' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.profile, profile);
    assert.equal(calls[0].sql, 'BEGIN');
    const update = calls.find(call => call.sql?.startsWith('UPDATE'));
    assert.match(update.sql, /WHERE id = \$1 RETURNING id/);
    assert.deepEqual(update.values, ['7', true, '09121111111', true, 'علی', true, 'محمدی']);
    assert.deepEqual(calls.find(call => call.sql?.startsWith('SELECT')).values, ['7']);
    assert.equal(calls.at(-2).sql, 'COMMIT');
    assert.equal(calls.at(-1).release, true);
});

test('PATCH preserves omitted fields and supports null or blank names', async t => {
    for (const [body, expected] of [
        [{ name: null }, ['7', false, null, true, null, false, null]],
        [{ family_name: ' \t ' }, ['7', false, null, false, null, true, null]],
        [{ phone_number: '09121111111' }, ['7', true, '09121111111', false, null, false, null]],
        [{ name: '🚗'.repeat(255) }, ['7', false, null, true, '🚗'.repeat(255), false, null]],
        [{ name: "Ali'); DROP TABLE users; --" }, ['7', false, null, true, "Ali'); DROP TABLE users; --", false, null]]
    ]) {
        const calls = connection(t);
        const res = await inject(app, { method: 'PATCH', url: '/profile', headers: headers(), body });
        assert.equal(res.status, 200);
        const update = calls.find(call => call.sql?.startsWith('UPDATE'));
        assert.deepEqual(update.values, expected);
        assert.ok(!update.sql.includes(expected[4] || 'never-in-sql'));
    }
});

test('phone conflicts roll back all profile edits and return 409', async t => {
    const calls = connection(t, { error: Object.assign(new Error('duplicate phone'),
        { code: '23505', constraint: 'users_phone_number_key' }) });
    const res = await inject(app, { method: 'PATCH', url: '/profile', headers: headers(),
        body: { phone_number: 'taken', name: 'Changed' } });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { message: 'Phone number already exists' });
    assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(!calls.some(call => call.sql === 'COMMIT'));
});

test('an absent account rolls back and returns 404', async t => {
    const calls = connection(t, { missing: true });
    const res = await inject(app, { method: 'PATCH', url: '/profile', headers: headers(), body: { name: 'Changed' } });
    assert.equal(res.status, 404);
    assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
});

test('rollback failures return 500 and discard the broken connection', async t => {
    t.mock.method(console, 'error', () => {});
    const rollbackError = new Error('private connection error');
    const calls = connection(t, { error: Object.assign(new Error('private duplicate'),
        { code: '23505', constraint: 'users_phone_number_key' }), rollbackError });
    const res = await inject(app, { method: 'PATCH', url: '/profile', headers: headers(), body: { phone_number: 'taken' } });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
    assert.equal(calls.at(-1).error, rollbackError);
});
