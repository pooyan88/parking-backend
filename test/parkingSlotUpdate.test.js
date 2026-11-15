const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const controller = require('../Controller/parkingSlotController');
const router = require('../Router/parkingSlotRouter');

test.after(() => pool.end());

function response(onJson = () => {}) {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; onJson(); return this; } };
}

function connection({ parkingRows = [{ id: 12 }], floorRows = [{ id: 2 }],
    slotRows = [{ id: 1, operational_status: 'usable', maintenance_note: null }], updateRows, failures = {} } = {}) {
    const calls = [];
    const releases = [];
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            const failure = Object.entries(failures).find(([pattern]) => sql.includes(pattern));
            if (failure) throw failure[1];
            if (sql.includes('SELECT id FROM public.parkings')) return { rows: parkingRows };
            if (sql.includes('SELECT id FROM public.parking_floors')) return { rows: floorRows };
            if (sql.includes('SELECT id, operational_status')) return { rows: slotRows };
            if (sql.includes('UPDATE public.parking_slots')) return { rows: updateRows ?? [{
                id: values[3], parking_id: values[5], floor_id: values[4], code: values[0] ?? 'A-101',
                operational_status: values[1], maintenance_note: values[2], created_at: new Date('2026-11-15T10:00:00Z')
            }] };
            return { rows: [] };
        },
        release(error) { releases.push(error); }
    };
    return { client, calls, releases };
}

function request(body, params = { parkingId: '12', floorId: '2', slotId: '1' }) {
    return { user: { id: '7' }, params, body, query: { owner_id: '99' } };
}

async function route(headers, body) {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method: 'PATCH', url: '/parkings/12/floors/2/slots/1', headers, body }, res, error => {
            reject(error || new Error('Slot update route did not return a response'));
        });
    });
    return res;
}

test('slot update locks the owner\'s active lot, matching floor, and matching slot in order', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    t.mock.method(pool, 'query', () => assert.fail('must use the transaction connection'));
    const res = response();
    await controller.updateSlot(request({ code: ' B-101 ', operational_status: 'maintenance', maintenance_note: ' Repair ' }), res);
    assert.equal(db.calls[0].sql, 'BEGIN');
    assert.match(db.calls[1].sql, /WHERE id = \$1 AND owner_id = \$2 AND archived_at IS NULL/);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.match(db.calls[2].sql, /WHERE id = \$1 AND parking_id = \$2 AND archived_at IS NULL/);
    assert.deepEqual(db.calls[2].values, [2, 12]);
    assert.match(db.calls[3].sql, /WHERE id = \$1 AND floor_id = \$2 AND parking_id = \$3 AND archived_at IS NULL/);
    assert.deepEqual(db.calls[3].values, [1, 2, 12]);
    assert.ok(db.calls.slice(1, 4).every(call => call.sql.includes('FOR UPDATE')));
    const update = db.calls.find(call => call.sql.includes('UPDATE public.parking_slots'));
    assert.match(update.sql, /WHERE id = \$4 AND floor_id = \$5 AND parking_id = \$6 AND archived_at IS NULL/);
    assert.deepEqual(update.values, ['B-101', 'maintenance', 'Repair', 1, 2, 12]);
    assert.equal(db.calls.at(-1).sql, 'COMMIT');
    assert.deepEqual(db.releases, [undefined]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.slot.code, 'B-101');
    assert.equal(res.body.slot.operational_status, 'maintenance');
    assert.equal(res.body.slot.maintenance_note, 'Repair');
});

test('partial updates preserve omitted state and support clearing notes and returning to usable', async t => {
    const maintenance = { id: 1, operational_status: 'maintenance', maintenance_note: 'Existing repair' };
    const usable = { id: 1, operational_status: 'usable', maintenance_note: null };
    for (const [stored, body, expected] of [
        [maintenance, { code: 'New code' }, ['New code', 'maintenance', 'Existing repair', 1, 2, 12]],
        [maintenance, { maintenance_note: ' New repair ' }, [null, 'maintenance', 'New repair', 1, 2, 12]],
        [maintenance, { maintenance_note: null }, [null, 'maintenance', null, 1, 2, 12]],
        [maintenance, { operational_status: 'usable' }, [null, 'usable', null, 1, 2, 12]],
        [usable, { maintenance_note: null }, [null, 'usable', null, 1, 2, 12]],
        [usable, { operational_status: 'maintenance' }, [null, 'maintenance', null, 1, 2, 12]]
    ]) {
        const db = connection({ slotRows: [stored] });
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.updateSlot(request(body), res);
        assert.equal(res.statusCode, 200);
        const update = db.calls.find(call => call.sql.includes('UPDATE public.parking_slots'));
        assert.match(update.sql, /code = COALESCE\(\$1, code\)/);
        assert.deepEqual(update.values, expected);
        assert.equal(res.body.slot.operational_status, expected[1]);
        assert.equal(res.body.slot.maintenance_note, expected[2]);
        connect.mock.restore();
    }
});

test('non-null notes on a resulting usable slot return 400 without applying any changes', async t => {
    for (const [storedStatus, body] of [
        ['usable', { maintenance_note: 'Repair' }],
        ['usable', { code: 'Must not change', operational_status: 'usable', maintenance_note: 'Repair' }],
        ['maintenance', { operational_status: 'usable', maintenance_note: 'Repair' }]
    ]) {
        const db = connection({ slotRows: [{ id: 1, operational_status: storedStatus, maintenance_note: null }] });
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.updateSlot(request(body), res);
        assert.equal(res.statusCode, 400);
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.ok(!db.calls.some(call => call.sql.includes('UPDATE public.parking_slots')));
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('missing, archived, foreign-owned, or mismatched resources return 404 after rollback', async t => {
    for (const options of [{ parkingRows: [] }, { floorRows: [] }, { slotRows: [] }, { updateRows: [] }]) {
        const db = connection(options);
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.updateSlot(request({ code: 'New code' }), res);
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { message: 'Parking slot not found' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('invalid IDs stop before a connection is acquired', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const bad of [undefined, '', '0', '-1', '01', '1.5', '1e2', '2147483648', '1 OR 1=1']) {
        for (const field of ['parkingId', 'floorId', 'slotId']) {
            const res = response();
            await controller.updateSlot(request({ code: 'New code' }, { parkingId: '12', floorId: '2', slotId: '1', [field]: bad }), res);
            assert.equal(res.statusCode, 400);
        }
    }
});

test('invalid bodies, identity changes, and derived availability fields are rejected', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const body of [undefined, null, [], 'text', {},
        ...['id', 'floor_id', 'parking_id', 'owner_id', 'user_id', 'created_at', 'archived_at', 'is_available', 'is_occupied']
            .map(field => ({ code: 'New code', [field]: 99 })),
        ...[undefined, null, '', ' ', 42, [], {}, 'x'.repeat(256), 'Bad\0code'].map(code => ({ code })),
        ...[undefined, null, 'occupied', 'reserved', 'Usable', ' maintenance ', 42].map(operational_status => ({ operational_status })),
        ...[undefined, '', ' ', 42, [], {}, 'x'.repeat(1001), 'Bad\0note'].map(maintenance_note => ({ maintenance_note }))]) {
        const res = response();
        await controller.updateSlot(request(body), res);
        assert.equal(res.statusCode, 400);
    }
});

test('Unicode length boundaries and SQL-looking values remain query parameters', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    const code = '🚗'.repeat(255);
    const note = '🚗'.repeat(1000);
    const res = response();
    await controller.updateSlot(request({ code, operational_status: 'maintenance', maintenance_note: note }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(db.calls.find(call => call.sql.includes('UPDATE public.parking_slots')).values, [code, 'maintenance', note, 1, 2, 12]);
    const sqlText = "Renamed'; DROP TABLE users; --";
    await controller.updateSlot(request({ code: sqlText }), response());
    const update = db.calls.filter(call => call.sql.includes('UPDATE public.parking_slots')).at(-1);
    assert.equal(update.values[0], sqlText);
    assert.ok(!update.sql.includes(sqlText));
});

test('duplicate code errors roll back code, status, and note changes together', async t => {
    t.mock.method(console, 'error', () => {});
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'parking_slots_parking_id_code_key' });
    const db = connection({ failures: { 'UPDATE public.parking_slots': duplicate } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.updateSlot(request({ code: 'Existing code', operational_status: 'maintenance', maintenance_note: 'Repair' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
    assert.deepEqual(db.releases, [undefined]);
});

test('unexpected update and commit errors return 500 after rollback', async t => {
    t.mock.method(console, 'error', () => {});
    for (const failures of [{ 'UPDATE public.parking_slots': new Error('private failure') },
        { COMMIT: new Error('commit failure') },
        { 'UPDATE public.parking_slots': Object.assign(new Error('another conflict'), { code: '23505', constraint: 'another_constraint' }) }]) {
        const db = connection({ failures });
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.updateSlot(request({ code: 'New code' }), res);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { message: 'Internal server error' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('rollback failure removes the broken connection from the pool', async t => {
    t.mock.method(console, 'error', () => {});
    const rollback = new Error('broken connection');
    const db = connection({ failures: { 'UPDATE public.parking_slots': new Error('update failure'), ROLLBACK: rollback } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.updateSlot(request({ code: 'New code' }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.releases, [rollback]);
});

test('connection failure returns a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'connect', async () => { throw new Error('private connection failure'); });
    const res = response();
    await controller.updateSlot(request({ code: 'New code' }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('the PATCH slot route requires authentication before acquiring a connection', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const authorization of [undefined, 'Bearer invalid']) {
        assert.equal((await route({ authorization }, { code: 'New code' })).statusCode, 401);
    }
});

test('the PATCH slot route gets all IDs from the URL and ownership from the verified JWT', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'slot-update-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    const res = await route({ authorization: `Bearer ${token}` }, { operational_status: 'maintenance' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.deepEqual(db.calls[2].values, [2, 12]);
    assert.deepEqual(db.calls[3].values, [1, 2, 12]);
});
