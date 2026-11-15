const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const controller = require('../Controller/parkingFloorController');
const router = require('../Router/parkingFloorRouter');

test.after(() => pool.end());

function response(onFinish = () => {}) {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; onFinish(); return this; },
        send(body) { this.body = body; onFinish(); return this; } };
}

function connection({ parentRows = [{ id: 12 }], floorRows = [{ id: 1 }], failures = {} } = {}) {
    const calls = [];
    const releases = [];
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            const failure = Object.entries(failures).find(([pattern]) => sql.includes(pattern));
            if (failure) throw failure[1];
            if (sql.includes('SELECT id FROM public.parkings')) return { rows: parentRows };
            if (sql.includes('UPDATE public.parking_floors')) return { rows: floorRows };
            return { rows: [] };
        },
        release(error) { releases.push(error); }
    };
    return { client, calls, releases };
}

function request(params = { parkingId: '12', floorId: '1' }) {
    return { user: { id: '7' }, params, body: { owner_id: 99, parking_id: 99, floor_id: 99 },
        query: { owner_id: '99' } };
}

async function route(headers) {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method: 'DELETE', url: '/parkings/12/floors/1', headers }, res, error => {
            reject(error || new Error('Floor archive route did not return a response'));
        });
    });
    return res;
}

test('floor archive uses the authenticated parent and both URL IDs in one transaction', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    t.mock.method(pool, 'query', () => assert.fail('must use the transaction connection'));
    const res = response();
    await controller.archiveFloor(request(), res);
    assert.equal(db.calls[0].sql, 'BEGIN');
    assert.match(db.calls[1].sql, /WHERE id = \$1 AND owner_id = \$2 AND archived_at IS NULL/);
    assert.match(db.calls[1].sql, /FOR UPDATE/);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    const update = db.calls.find(call => call.sql.includes('UPDATE public.parking_floors'));
    assert.match(update.sql, /SET archived_at = COALESCE\(archived_at, NOW\(\)\)/);
    assert.match(update.sql, /WHERE id = \$1 AND parking_id = \$2/);
    assert.ok(!update.sql.includes('DELETE FROM'));
    assert.deepEqual(update.values, [1, 12]);
    assert.equal(db.calls.at(-1).sql, 'COMMIT');
    assert.deepEqual(db.releases, [undefined]);
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, undefined);
});

test('repeated archive requests succeed without replacing the first archive time', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = response();
        await controller.archiveFloor(request(), res);
        assert.equal(res.statusCode, 204);
    }
    const updates = db.calls.filter(call => call.sql.includes('UPDATE public.parking_floors'));
    assert.equal(updates.length, 2);
    assert.ok(updates.every(call => call.sql.includes('COALESCE(archived_at, NOW())')));
});

test('inaccessible parent and missing or cross-lot floor return 404 after rollback', async t => {
    for (const options of [{ parentRows: [] }, { floorRows: [] }]) {
        const db = connection(options);
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.archiveFloor(request(), res);
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { message: 'Parking floor not found' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
        if (options.parentRows) assert.ok(!db.calls.some(call => call.sql.includes('UPDATE public.parking_floors')));
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('invalid IDs stop before a connection is acquired', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const bad of [undefined, '', '0', '-1', '01', '1.5', '1e2', '2147483648', '1 OR 1=1']) {
        for (const params of [{ parkingId: bad, floorId: '1' }, { parkingId: '12', floorId: bad }]) {
            const res = response();
            await controller.archiveFloor(request(params), res);
            assert.equal(res.statusCode, 400);
        }
    }
});

test('update and commit errors roll back and return a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    for (const failures of [{ 'UPDATE public.parking_floors': new Error('private database error') },
        { COMMIT: new Error('private commit error') }]) {
        const db = connection({ failures });
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.archiveFloor(request(), res);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { message: 'Internal server error' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('rollback failures remove the broken connection from the pool', async t => {
    t.mock.method(console, 'error', () => {});
    const rollback = new Error('broken connection');
    const db = connection({ failures: { 'UPDATE public.parking_floors': new Error('update error'), ROLLBACK: rollback } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.archiveFloor(request(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.releases, [rollback]);
});

test('connection acquisition errors return 500 without changing rows', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'connect', async () => { throw new Error('private connection error'); });
    const res = response();
    await controller.archiveFloor(request(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('the DELETE floor route rejects requests without a valid token', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const authorization of [undefined, 'Bearer invalid']) {
        assert.equal((await route({ authorization })).statusCode, 401);
    }
});

test('the DELETE floor route uses the URL IDs and verified JWT subject', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'floor-archive-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    const res = await route({ authorization: `Bearer ${token}` });
    assert.equal(res.statusCode, 204);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.deepEqual(db.calls.find(call => call.sql.includes('UPDATE public.parking_floors')).values, [1, 12]);
});
