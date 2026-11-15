const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const controller = require('../Controller/parkingController');
const authMiddleware = require('../Middleware/authMiddleware');

test.after(() => pool.end());

function response() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('listing uses the verified owner ID and ignores client ownership fields', async t => {
    const ownParkings = [{ id: 12, name: 'Owner A lot', location: 'North' }];
    const query = t.mock.method(pool, 'query', async (sql, parameters) => {
        assert.match(sql, /WHERE\s+owner_id\s*=\s*\$1/i);
        assert.match(sql, /AND archived_at IS NULL/i);
        assert.match(sql, /ORDER BY id/i);
        assert.deepEqual(parameters, ['7']);
        return { rows: ownParkings };
    });
    const req = {
        user: { id: '7' },
        query: { user_id: '99', owner_id: '99' },
        body: { user_id: '99', owner_id: '99' }
    };
    const res = response();
    await controller.getAllParkings(req, res);
    assert.equal(query.mock.callCount(), 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, ownParkings);
});

test('different authenticated owners produce different query parameters', async t => {
    const owners = [];
    t.mock.method(pool, 'query', async (sql, parameters) => {
        owners.push(parameters[0]);
        return { rows: [] };
    });
    await controller.getAllParkings({ user: { id: '7' } }, response());
    await controller.getAllParkings({ user: { id: '99' } }, response());
    assert.deepEqual(owners, ['7', '99']);
});

test('an owner with no parking lots receives an empty array', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = response();
    await controller.getAllParkings({ user: { id: '7' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
});

test('database failures return 500 without exposing database details', async t => {
    t.mock.method(pool, 'query', async () => { throw new Error('private database details'); });
    t.mock.method(console, 'error', () => {});
    const res = response();
    await controller.getAllParkings({ user: { id: '7' } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error' });
});

test('missing or invalid access tokens stop before listing queries', t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const authorization of [undefined, 'Bearer invalid']) {
        const res = response();
        authMiddleware({ headers: { authorization } }, res, () => assert.fail('must not authorize'));
        assert.equal(res.statusCode, 401);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('the JWT subject supplies the owner ID used by the listing', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'parking-ownership-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    t.mock.method(pool, 'query', async (sql, parameters) => {
        assert.deepEqual(parameters, ['7']);
        return { rows: [] };
    });
    const req = { headers: { authorization: `Bearer ${token}` }, query: { owner_id: '99' } };
    const res = response();
    let authenticated = false;
    authMiddleware(req, res, () => { authenticated = true; });
    assert.ok(authenticated);
    await controller.getAllParkings(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
});
