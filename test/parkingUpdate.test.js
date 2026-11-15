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

async function patchParking(headers, body, id = '12') {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method: 'PATCH', url: `/parkings/${id}`, headers, body }, res, error => {
            reject(error || new Error('PATCH /parkings/:id did not return a response'));
        });
    });
    return res;
}

test('updates both fields with one query scoped to the parking ID and authenticated owner', async t => {
    const parking = { id: 12, name: 'Renamed lot', location: 'North', created_at: null };
    const query = t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /UPDATE public\.parkings/);
        assert.match(sql, /WHERE id = \$3 AND owner_id = \$4/);
        assert.match(sql, /RETURNING id, name, location, created_at/);
        assert.deepEqual(values, ['Renamed lot', 'North', 12, '7']);
        return { rows: [parking] };
    });
    const res = response();
    await controller.updateParking({ user: { id: '7' }, params: { id: '12' },
        query: { owner_id: '99' }, body: { name: ' Renamed lot ', location: ' North ' } }, res);
    assert.equal(query.mock.callCount(), 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { message: 'Parking lot updated successfully', parking });
});

test('a partial update preserves the omitted field in the database expression', async t => {
    const query = t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /name = COALESCE\(\$1, name\), location = COALESCE\(\$2, location\)/);
        return { rows: [{ id: 12, name: values[0] ?? 'Old name', location: values[1] ?? 'Old location', created_at: null }] };
    });
    for (const [body, expectedValues, expectedName, expectedLocation] of [
        [{ name: 'New name' }, ['New name', null, 12, '7'], 'New name', 'Old location'],
        [{ location: 'New location' }, [null, 'New location', 12, '7'], 'Old name', 'New location']
    ]) {
        const res = response();
        await controller.updateParking({ user: { id: '7' }, params: { id: '12' }, body }, res);
        assert.deepEqual(query.mock.calls.at(-1).arguments[1], expectedValues);
        assert.equal(res.body.parking.name, expectedName);
        assert.equal(res.body.parking.location, expectedLocation);
    }
});

test('missing or another owner\'s parking returns the same 404 response', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = response();
    await controller.updateParking({ user: { id: '7' }, params: { id: '12' }, body: { name: 'Changed' } }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Parking lot not found' });
});

test('invalid IDs never reach the database', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const id of [undefined, '', '0', '-1', '01', '1.5', '1e2', ' 12', '12x', '2147483648', '9'.repeat(100), '12 OR 1=1']) {
        const res = response();
        await controller.updateParking({ user: { id: '7' }, params: { id }, body: { name: 'Changed' } }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('the largest PostgreSQL integer ID is accepted', async t => {
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.equal(values[2], 2147483647);
        return { rows: [] };
    });
    const res = response();
    await controller.updateParking({ user: { id: '7' }, params: { id: '2147483647' }, body: { name: 'Changed' } }, res);
    assert.equal(res.statusCode, 404);
});

test('empty bodies and changes to immutable or unsupported fields are rejected', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const body of [undefined, null, [], 'text', {}, { name: undefined },
        { owner_id: 99 }, { name: 'Changed', owner_id: 99 }, { location: 'North', user_id: 99 },
        { name: 'Changed', id: 99 }, { name: 'Changed', created_at: '1900-01-01' }, { unknown: 'value' }]) {
        const res = response();
        await controller.updateParking({ user: { id: '7' }, params: { id: '12' }, body }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('null, blank, non-string, oversized, and null-character values are rejected', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const body of [{ name: null }, { location: null }, { name: '' }, { location: '  ' },
        { name: 42 }, { location: false }, { name: [] }, { location: {} },
        { name: 'a'.repeat(256) }, { location: 'a'.repeat(256) }, { name: 'New\0name' }, { location: 'New\0location' }]) {
        const res = response();
        await controller.updateParking({ user: { id: '7' }, params: { id: '12' }, body }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('Unicode boundary values and SQL-looking text stay in parameters', async t => {
    const name = '🚗'.repeat(255);
    const location = "North'; DELETE FROM users; --";
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.deepEqual(values, [name, location, 12, '7']);
        assert.ok(!sql.includes(location));
        return { rows: [{ id: 12, name, location, created_at: null }] };
    });
    const res = response();
    await controller.updateParking({ user: { id: '7' }, params: { id: '12' }, body: { name, location } }, res);
    assert.equal(res.statusCode, 200);
});

test('unexpected database failures return a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'query', async () => { throw new Error('private database error'); });
    const res = response();
    await controller.updateParking({ user: { id: '7' }, params: { id: '12' }, body: { name: 'Changed' } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('the PATCH route requires a valid access token before updating', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const authorization of [undefined, 'Bearer invalid']) {
        const res = await patchParking({ authorization }, { name: 'Changed' });
        assert.equal(res.statusCode, 401);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('the PATCH route uses JWT ownership and the URL parking ID', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'parking-update-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const parking = { id: 12, name: 'Changed', location: 'Original location', created_at: null };
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.deepEqual(values, ['Changed', null, 12, '7']);
        return { rows: [parking] };
    });
    const res = await patchParking({ authorization: `Bearer ${token}` }, { name: 'Changed' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.parking, parking);
});
