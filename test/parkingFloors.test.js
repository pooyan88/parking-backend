const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const controller = require('../Controller/parkingFloorController');
const router = require('../Router/parkingFloorRouter');

test.after(() => pool.end());

function response(onJson = () => {}) {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; onJson(); return this; } };
}

function connection({ parkingRows = [{ id: 12 }], failures = {} } = {}) {
    const calls = [];
    const releases = [];
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            const failure = Object.entries(failures).find(([pattern]) => sql.includes(pattern));
            if (failure) throw failure[1];
            if (sql.includes('SELECT id FROM public.parkings')) return { rows: parkingRows };
            if (sql.includes('INSERT INTO public.parking_floors')) return { rows: [{
                id: 1, parking_id: values[0], floor_number: values[1], label: values[2],
                created_at: new Date('2026-11-15T10:00:00Z')
            }] };
            return { rows: [] };
        },
        release(error) { releases.push(error); }
    };
    return { client, calls, releases };
}

function createRequest(body, parkingId = '12') {
    return { user: { id: '7' }, params: { parkingId }, body };
}

async function route(method, headers, body) {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method, url: '/parkings/12/floors', headers, body }, res, error => {
            reject(error || new Error('Floor endpoint did not return a response'));
        });
    });
    return res;
}

test('creation checks and locks the authenticated owner\'s active lot on one transaction connection', async t => {
    const db = connection();
    const connect = t.mock.method(pool, 'connect', async () => db.client);
    t.mock.method(pool, 'query', () => assert.fail('transaction must use its own client'));
    const res = response();
    await controller.createFloor(createRequest({ floor_number: -1, label: ' Basement ' }), res);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(db.calls[0].sql, 'BEGIN');
    assert.match(db.calls[1].sql, /WHERE id = \$1 AND owner_id = \$2 AND archived_at IS NULL/);
    assert.match(db.calls[1].sql, /FOR UPDATE/);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.match(db.calls[2].sql, /VALUES \(\$1, \$2, \$3\)/);
    assert.deepEqual(db.calls[2].values, [12, -1, 'Basement']);
    assert.equal(db.calls[3].sql, 'COMMIT');
    assert.deepEqual(db.releases, [undefined]);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.floor.parking_id, 12);
    assert.equal(res.body.floor.label, 'Basement');
});

test('ground, positive, and integer boundary floors allow an omitted or null label', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    for (const floor_number of [0, 1, -2147483648, 2147483647]) {
        const res = response();
        await controller.createFloor(createRequest({ floor_number }), res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.floor.floor_number, floor_number);
        assert.equal(res.body.floor.label, null);
    }
    const res = response();
    await controller.createFloor(createRequest({ floor_number: 2, label: null }), res);
    assert.equal(res.statusCode, 201);
});

test('invalid creation bodies and client identity fields never open a connection', async t => {
    const connect = t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const body of [undefined, null, [], 'text', {}, { label: 'Basement' },
        ...['-1', null, true, 1.5, -2147483649, 2147483648, NaN, Infinity].map(floor_number => ({ floor_number })),
        ...['', '  ', 42, [], {}, 'x'.repeat(256), 'Bad\0label'].map(label => ({ floor_number: 0, label })),
        ...['parking_id', 'owner_id', 'user_id', 'id', 'created_at'].map(field => ({ floor_number: 0, [field]: 99 }))]) {
        const res = response();
        await controller.createFloor(createRequest(body), res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(connect.mock.callCount(), 0);
});

test('invalid parking IDs stop creation and listing before database access', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const parkingId of [undefined, '', '0', '-1', '01', '12x', '1.5', '2147483648', '12 OR 1=1']) {
        for (const action of [controller.createFloor, controller.getFloors]) {
            const res = response();
            await action(createRequest({ floor_number: 0 }, parkingId === undefined ? '' : parkingId), res);
            assert.equal(res.statusCode, 400);
        }
    }
});

test('Unicode labels at the length boundary and SQL-looking text are parameters', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    for (const label of ['🚗'.repeat(255), "Basement'); DROP TABLE users; --"]) {
        const res = response();
        await controller.createFloor(createRequest({ floor_number: 0, label }), res);
        assert.equal(res.statusCode, 201);
        const insert = db.calls.filter(call => call.sql.includes('INSERT INTO')).at(-1);
        assert.equal(insert.values[2], label);
        assert.ok(!insert.sql.includes(label));
    }
});

test('missing, archived, or foreign-owned parent rolls back before inserting', async t => {
    const db = connection({ parkingRows: [] });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createFloor(createRequest({ floor_number: 0 }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Parking lot not found' });
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!db.calls.some(call => call.sql.includes('INSERT INTO')));
    assert.deepEqual(db.releases, [undefined]);
});

test('duplicate floor numbers return 409 after rollback', async t => {
    t.mock.method(console, 'error', () => {});
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'parking_floors_parking_id_floor_number_key' });
    const db = connection({ failures: { 'INSERT INTO': duplicate } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createFloor(createRequest({ floor_number: 0 }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
    assert.deepEqual(db.releases, [undefined]);
});

test('insert and commit failures roll back and return a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    for (const failures of [
        { 'INSERT INTO': new Error('private insert failure') },
        { COMMIT: new Error('private commit failure') },
        { 'INSERT INTO': Object.assign(new Error('different uniqueness failure'), { code: '23505', constraint: 'another_constraint' }) }
    ]) {
        const db = connection({ failures });
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.createFloor(createRequest({ floor_number: 0 }), res);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { message: 'Internal server error' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('rollback failure removes the connection from the pool', async t => {
    t.mock.method(console, 'error', () => {});
    const rollbackError = new Error('broken connection');
    const db = connection({ failures: { 'INSERT INTO': new Error('insert failure'), ROLLBACK: rollbackError } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createFloor(createRequest({ floor_number: 0 }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.releases, [rollbackError]);
});

test('connection acquisition failure returns 500 without an insert', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'connect', async () => { throw new Error('private connection failure'); });
    const res = response();
    await controller.createFloor(createRequest({ floor_number: 0 }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('listing scopes the parent, hides archived floors, and orders numerically', async t => {
    const floors = [{ id: 1, parking_id: 12, floor_number: -1, label: null, created_at: new Date() }];
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /LEFT JOIN public\.parking_floors f/);
        assert.match(sql, /ON f.parking_id = p.id AND f.archived_at IS NULL/);
        assert.match(sql, /WHERE p.id = \$1 AND p.owner_id = \$2 AND p.archived_at IS NULL/);
        assert.match(sql, /ORDER BY f.floor_number, f.id/);
        assert.deepEqual(values, [12, '7']);
        return { rows: floors };
    });
    const req = createRequest();
    req.query = { owner_id: '99' };
    const res = response();
    await controller.getFloors(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, floors);
});

test('an accessible empty lot returns an empty floor array', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [{ id: null, parking_id: null, floor_number: null, label: null, created_at: null }] }));
    const res = response();
    await controller.getFloors(createRequest(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
});

test('listing an inaccessible parent returns 404', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = response();
    await controller.getFloors(createRequest(), res);
    assert.equal(res.statusCode, 404);
});

test('listing failures return a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'query', async () => { throw new Error('private database failure'); });
    const res = response();
    await controller.getFloors(createRequest(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('both floor routes reject missing or invalid JWTs before database access', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const method of ['GET', 'POST']) {
        for (const authorization of [undefined, 'Bearer invalid']) {
            const res = await route(method, { authorization }, { floor_number: 0 });
            assert.equal(res.statusCode, 401);
        }
    }
});

test('both floor routes get the parent from the URL and owner from the JWT', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'parking-floor-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.deepEqual(values, [12, '7']);
        return { rows: [{ id: null }] };
    });
    const headers = { authorization: `Bearer ${token}` };
    const created = await route('POST', headers, { floor_number: -1 });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    const listed = await route('GET', headers);
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.body, []);
});
