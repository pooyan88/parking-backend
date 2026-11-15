const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const controller = require('../Controller/parkingController');
const router = require('../Router/parkingRouter');

test.after(() => pool.end());

function response(onJson = () => {}) {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; onJson(); return this; }
    };
}

async function postParking(headers, body) {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method: 'POST', url: '/parkings', headers, body }, res, error => {
            reject(error || new Error('POST /parkings did not return a response'));
        });
    });
    return res;
}

test('creation trims fields and takes ownership only from the authenticated user', async t => {
    const parking = { id: 12, name: 'Main lot', location: 'Tehran', created_at: new Date('2026-11-15T10:00:00Z') };
    const query = t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /INSERT INTO public\.parkings \(name, location, owner_id\)/);
        assert.match(sql, /VALUES \(\$1, \$2, \$3\)/);
        assert.match(sql, /RETURNING id, name, location, created_at/);
        assert.deepEqual(values, ['Main lot', 'Tehran', '7']);
        return { rows: [parking] };
    });
    const res = response();
    await controller.createParking({ user: { id: '7' }, body: {
        name: '  Main lot  ', location: ' Tehran ', owner_id: 99, user_id: 99,
        id: 999, created_at: '1900-01-01T00:00:00Z'
    } }, res);
    assert.equal(query.mock.callCount(), 1);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, { message: 'Parking lot created successfully', parking });
});

test('missing, blank, and non-string fields are rejected before querying', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('invalid input must not reach the database'));
    for (const body of [undefined, null, [], 'text', {},
        { name: 'Main lot' }, { location: 'Tehran' },
        { name: '', location: 'Tehran' }, { name: '  ', location: 'Tehran' },
        { name: 'Main lot', location: '\t\n' }, { name: 1, location: 'Tehran' },
        { name: 'Main lot', location: {} }, { name: ['Main lot'], location: 'Tehran' }]) {
        const res = response();
        await controller.createParking({ user: { id: '7' }, body }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('oversized strings and null characters are rejected before querying', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('invalid input must not reach the database'));
    for (const body of [
        { name: 'a'.repeat(256), location: 'Tehran' },
        { name: 'Main lot', location: 'a'.repeat(256) },
        { name: 'Main\0lot', location: 'Tehran' },
        { name: 'Main lot', location: 'Teh\0ran' }
    ]) {
        const res = response();
        await controller.createParking({ user: { id: '7' }, body }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('the 255-character limit counts Unicode characters like PostgreSQL', async t => {
    const name = '🚗'.repeat(255);
    const location = 'ت'.repeat(255);
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.deepEqual(values, [name, location, '7']);
        return { rows: [{ id: 12, name, location, created_at: new Date() }] };
    });
    const res = response();
    await controller.createParking({ user: { id: '7' }, body: { name, location } }, res);
    assert.equal(res.statusCode, 201);
});

test('SQL-looking input stays in query parameters', async t => {
    const name = "Lot'); DROP TABLE users; --";
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.ok(!sql.includes(name));
        assert.deepEqual(values, [name, 'Tehran', '7']);
        return { rows: [{ id: 12, name, location: 'Tehran', created_at: new Date() }] };
    });
    const res = response();
    await controller.createParking({ user: { id: '7' }, body: { name, location: 'Tehran' } }, res);
    assert.equal(res.statusCode, 201);
});

test('a token for a deleted owner returns 401 rather than a database error', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'query', async () => {
        throw Object.assign(new Error('private database error'), { code: '23503', constraint: 'parkings_owner_id_fkey' });
    });
    const res = response();
    await controller.createParking({ user: { id: '7' }, body: { name: 'Main lot', location: 'Tehran' } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: 'Authenticated user no longer exists' });
});

test('other database errors return a generic 500 response', async t => {
    t.mock.method(console, 'error', () => {});
    for (const error of [new Error('private database error'),
        Object.assign(new Error('unrelated foreign key'), { code: '23503', constraint: 'another_constraint' })]) {
        const query = t.mock.method(pool, 'query', async () => { throw error; });
        const res = response();
        await controller.createParking({ user: { id: '7' }, body: { name: 'Main lot', location: 'Tehran' } }, res);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { message: 'Internal server error' });
        query.mock.restore();
    }
});

test('the POST route rejects unauthenticated requests without inserting', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not insert'));
    for (const authorization of [undefined, 'Bearer invalid']) {
        const res = await postParking({ authorization }, { name: 'Main lot', location: 'Tehran' });
        assert.equal(res.statusCode, 401);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('the POST route uses the verified JWT subject for the new owner', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'parking-creation-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const parking = { id: 12, name: 'Main lot', location: 'Tehran', created_at: new Date() };
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.deepEqual(values, ['Main lot', 'Tehran', '7']);
        return { rows: [parking] };
    });
    const res = await postParking({ authorization: `Bearer ${token}` },
        { name: 'Main lot', location: 'Tehran', owner_id: 99 });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body.parking, parking);
});
