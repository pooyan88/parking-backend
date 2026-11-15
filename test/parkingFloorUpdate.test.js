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

function connection({ parentRows = [{ id: 12 }], floorRows, failures = {} } = {}) {
    const calls = [];
    const releases = [];
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            const failure = Object.entries(failures).find(([pattern]) => sql.includes(pattern));
            if (failure) throw failure[1];
            if (sql.includes('SELECT id FROM public.parkings')) return { rows: parentRows };
            if (sql.includes('UPDATE public.parking_floors')) return { rows: floorRows ?? [{
                id: values[3], parking_id: values[4], floor_number: values[0] ?? -1,
                label: values[1] ? values[2] : 'Basement', created_at: new Date('2026-11-15T10:00:00Z')
            }] };
            return { rows: [] };
        },
        release(error) { releases.push(error); }
    };
    return { client, calls, releases };
}

function request(body, params = { parkingId: '12', floorId: '1' }) {
    return { user: { id: '7' }, params, body };
}

async function route(headers, body) {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method: 'PATCH', url: '/parkings/12/floors/1', headers, body }, res, error => {
            reject(error || new Error('Floor update route did not return a response'));
        });
    });
    return res;
}

test('floor update locks the active owner\'s parent and restricts the floor to that lot', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    t.mock.method(pool, 'query', () => assert.fail('must use one transaction connection'));
    const res = response();
    const req = request({ floor_number: -2, label: ' Lower basement ' });
    req.query = { owner_id: '99', parking_id: '99' };
    await controller.updateFloor(req, res);
    assert.equal(db.calls[0].sql, 'BEGIN');
    assert.match(db.calls[1].sql, /WHERE id = \$1 AND owner_id = \$2 AND archived_at IS NULL/);
    assert.match(db.calls[1].sql, /FOR UPDATE/);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.match(db.calls[2].sql, /WHERE id = \$4 AND parking_id = \$5 AND archived_at IS NULL/);
    assert.deepEqual(db.calls[2].values, [-2, true, 'Lower basement', 1, 12]);
    assert.equal(db.calls[3].sql, 'COMMIT');
    assert.deepEqual(db.releases, [undefined]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.floor.floor_number, -2);
    assert.equal(res.body.floor.label, 'Lower basement');
});

test('partial updates distinguish an omitted label from explicitly clearing it', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    for (const [body, expected, number, label] of [
        [{ floor_number: 0 }, [0, false, null, 1, 12], 0, 'Basement'],
        [{ label: ' New label ' }, [null, true, 'New label', 1, 12], -1, 'New label'],
        [{ label: null }, [null, true, null, 1, 12], -1, null]
    ]) {
        const res = response();
        await controller.updateFloor(request(body), res);
        const update = db.calls.filter(call => call.sql.includes('UPDATE public.parking_floors')).at(-1);
        assert.match(update.sql, /floor_number = COALESCE\(\$1, floor_number\)/);
        assert.match(update.sql, /label = CASE WHEN \$2::boolean THEN \$3 ELSE label END/);
        assert.deepEqual(update.values, expected);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.floor.floor_number, number);
        assert.equal(res.body.floor.label, label);
    }
});

test('inaccessible parent or missing, archived, or cross-lot floor returns 404 and rolls back', async t => {
    for (const options of [{ parentRows: [] }, { floorRows: [] }]) {
        const db = connection(options);
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.updateFloor(request({ label: 'Changed' }), res);
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { message: 'Parking floor not found' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
        if (options.parentRows) assert.ok(!db.calls.some(call => call.sql.includes('UPDATE public.parking_floors')));
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('invalid parking or floor IDs never open a connection', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const bad of [undefined, '', '0', '-1', '01', '1.5', '1e2', '2147483648', '1 OR 1=1']) {
        for (const params of [{ parkingId: bad, floorId: '1' }, { parkingId: '12', floorId: bad }]) {
            const res = response();
            await controller.updateFloor(request({ label: 'Changed' }, params), res);
            assert.equal(res.statusCode, 400);
        }
    }
});

test('empty bodies, invalid fields, and identity changes are rejected', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const body of [undefined, null, [], 'text', {}, { floor_number: undefined }, { label: undefined },
        ...[null, true, '0', 1.5, -2147483649, 2147483648].map(floor_number => ({ floor_number })),
        ...['', ' ', 42, [], {}, 'x'.repeat(256), 'Bad\0label'].map(label => ({ label })),
        ...['owner_id', 'user_id', 'parking_id', 'id', 'created_at', 'archived_at'].map(field => ({ label: 'Changed', [field]: 99 }))]) {
        const res = response();
        await controller.updateFloor(request(body), res);
        assert.equal(res.statusCode, 400);
    }
});

test('Unicode labels and integer boundary numbers remain supported', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    for (const floor_number of [-2147483648, 2147483647]) {
        const res = response();
        await controller.updateFloor(request({ floor_number, label: '🚗'.repeat(255) }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.floor.floor_number, floor_number);
    }
    const label = "Changed'; DELETE FROM users; --";
    await controller.updateFloor(request({ label }), response());
    const update = db.calls.filter(call => call.sql.includes('UPDATE public.parking_floors')).at(-1);
    assert.equal(update.values[2], label);
    assert.ok(!update.sql.includes(label));
});

test('duplicate floor numbers roll back all requested changes and return 409', async t => {
    t.mock.method(console, 'error', () => {});
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'parking_floors_parking_id_floor_number_key' });
    const db = connection({ failures: { 'UPDATE public.parking_floors': duplicate } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.updateFloor(request({ floor_number: 0, label: 'Changed' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
    assert.deepEqual(db.releases, [undefined]);
});

test('unexpected update and commit errors return 500 after rollback', async t => {
    t.mock.method(console, 'error', () => {});
    for (const failures of [{ 'UPDATE public.parking_floors': new Error('private failure') },
        { COMMIT: new Error('commit failure') }]) {
        const db = connection({ failures });
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.updateFloor(request({ label: null }), res);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { message: 'Internal server error' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('a failed rollback destroys the connection instead of returning it to the pool', async t => {
    t.mock.method(console, 'error', () => {});
    const rollback = new Error('broken connection');
    const db = connection({ failures: { 'UPDATE public.parking_floors': new Error('update failure'), ROLLBACK: rollback } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.updateFloor(request({ label: 'Changed' }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.releases, [rollback]);
});

test('the PATCH floor route requires authentication before database access', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const authorization of [undefined, 'Bearer invalid']) {
        assert.equal((await route({ authorization }, { label: 'Changed' })).statusCode, 401);
    }
});

test('the PATCH floor route uses both URL IDs and the verified JWT subject', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'floor-update-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    const res = await route({ authorization: `Bearer ${token}` }, { label: null });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.deepEqual(db.calls[2].values, [null, true, null, 1, 12]);
});
