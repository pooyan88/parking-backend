const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcrypt');
const pool = require('../Database/db');
const app = require('../app');
const { inject } = require('./helpers/http');

test.after(() => pool.end());
const credentials = { username: 'new-user', phone_number: '09120000000', password: 'test-password' };

test('signup trims names, stores them as parameters, and returns them without the password hash', async t => {
    t.mock.method(bcrypt, 'hash', async () => 'test-hash');
    const name = "علی'); DROP TABLE users; --";
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.ok(!sql.includes(name));
        assert.deepEqual(values, ['new-user', '09120000000', 'test-hash', name, 'محمدی']);
        return { rows: [{ id: 1, username: values[0], phone_number: values[1], name: values[3], family_name: values[4] }] };
    });
    const res = await inject(app, { method: 'POST', url: '/auth/signup',
        body: { ...credentials, name: ` ${name} `, family_name: ' محمدی ' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.name, name);
    assert.equal(res.body.user.family_name, 'محمدی');
    assert.equal(res.body.user.password_hash, undefined);
});

test('omitted, null, blank, and partially supplied names remain optional at signup', async t => {
    t.mock.method(bcrypt, 'hash', async () => 'test-hash');
    for (const [names, expected] of [
        [{}, [null, null]],
        [{ name: null, family_name: null }, [null, null]],
        [{ name: ' \t ', family_name: '\n' }, [null, null]],
        [{ name: ' علی ' }, ['علی', null]],
        [{ family_name: ' محمدی ' }, [null, 'محمدی']]
    ]) {
        const query = t.mock.method(pool, 'query', async (sql, values) => {
            assert.deepEqual(values.slice(3), expected);
            return { rows: [{ id: 1 }] };
        });
        const res = await inject(app, { method: 'POST', url: '/auth/signup', body: { ...credentials, ...names } });
        assert.equal(res.status, 201);
        assert.equal(query.mock.callCount(), 1);
        query.mock.restore();
    }
});

test('invalid names return 400 before hashing or querying', async t => {
    t.mock.method(bcrypt, 'hash', () => assert.fail('invalid names must not be hashed'));
    t.mock.method(pool, 'query', () => assert.fail('invalid names must not reach the database'));
    for (const field of ['name', 'family_name']) {
        for (const value of [false, 123, {}, [], 'a'.repeat(256), 'علی\0محمدی']) {
            const res = await inject(app, { method: 'POST', url: '/auth/signup', body: { ...credentials, [field]: value } });
            assert.equal(res.status, 400);
        }
    }
});

test('name limits count Unicode characters rather than UTF-16 code units', async t => {
    t.mock.method(bcrypt, 'hash', async () => 'test-hash');
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.equal([...values[3]].length, 255);
        assert.equal([...values[4]].length, 255);
        return { rows: [{ id: 1 }] };
    });
    const res = await inject(app, { method: 'POST', url: '/auth/signup',
        body: { ...credentials, name: '🚗'.repeat(255), family_name: 'ی'.repeat(255) } });
    assert.equal(res.status, 201);
});

test('signup still requires credentials and reports duplicates as conflicts', async t => {
    t.mock.method(bcrypt, 'hash', async () => 'test-hash');
    const query = t.mock.method(pool, 'query', async () => {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    t.mock.method(console, 'error', () => {});
    const missing = await inject(app, { method: 'POST', url: '/auth/signup', body: { name: 'علی' } });
    assert.equal(missing.status, 400);
    assert.equal(query.mock.callCount(), 0);
    const duplicate = await inject(app, { method: 'POST', url: '/auth/signup', body: credentials });
    assert.equal(duplicate.status, 409);
});
