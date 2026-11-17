const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const controller = require('../Controller/parkingSlotController');
const router = require('../Router/parkingSlotRouter');
const { validateParkingSlotCreation } = require('../Utils/parkingSlotValidation');

test.after(() => pool.end());

function response(onJson = () => {}) {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; onJson(); return this; } };
}

function request(body, params = { parkingId: '12', floorId: '1' }) {
    return { user: { id: '7' }, params, body };
}

function connection({ parkingRows = [{ id: 12 }], floorRows = [{ id: 1 }], failures = {} } = {}) {
    const calls = [];
    const releases = [];
    const rows = [];
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            const failure = Object.entries(failures).find(([pattern]) => sql.includes(pattern));
            if (failure) throw failure[1];
            if (sql.includes('SELECT id FROM public.parkings')) return { rows: parkingRows };
            if (sql.includes('SELECT id FROM public.parking_floors')) return { rows: floorRows };
            if (sql.includes('INSERT INTO public.parking_slots')) {
                const codes = Array.isArray(values[2]) ? values[2] : [values[2]];
                rows.push(...codes.map((code, index) => ({ id: index + 1, parking_id: values[0],
                    floor_id: values[1], code, operational_status: 'usable', maintenance_note: null,
                    created_at: new Date('2026-11-15T10:00:00Z') })));
                return { rows };
            }
            return { rows: [] };
        },
        release(error) { releases.push(error); }
    };
    return { client, calls, releases, rows };
}

async function route(headers, body) {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method: 'POST', url: '/parkings/12/floors/1/slots', headers, body }, res,
            error => reject(error || new Error('Slot endpoint did not return a response')));
    });
    return res;
}

test('slot ranges include both endpoints and preserve prefixes, spelling, and padding', () => {
    const cases = [
        [{ start_code: '1', end_code: '3' }, ['1', '2', '3']],
        [{ start_code: ' A-009 ', end_code: ' A-011 ' }, ['A-009', 'A-010', 'A-011']],
        [{ start_code: 'b9', end_code: 'b11' }, ['b9', 'b10', 'b11']],
        [{ start_code: '0', end_code: '0' }, ['0']],
        [{ start_code: 'طبقه-1', end_code: 'طبقه-2' }, ['طبقه-1', 'طبقه-2']],
        [{ start_code: '9007199254740992', end_code: '9007199254740994' },
            ['9007199254740992', '9007199254740993', '9007199254740994']],
        [{ start_code: `${'🚗'.repeat(254)}1`, end_code: `${'🚗'.repeat(254)}2` },
            [`${'🚗'.repeat(254)}1`, `${'🚗'.repeat(254)}2`]]
    ];
    for (const [body, codes] of cases) {
        const details = validateParkingSlotCreation(body);
        assert.equal(details.error, undefined, JSON.stringify(body));
        assert.equal(details.isRange, true);
        assert.deepEqual(details.codes, codes);
    }
});

test('slot range limit counts endpoints and allows exactly 1000 slots', () => {
    const details = validateParkingSlotCreation({ start_code: '1', end_code: '1000' });
    assert.equal(details.error, undefined);
    assert.equal(details.codes.length, 1000);
    assert.equal(details.codes[0], '1');
    assert.equal(details.codes.at(-1), '1000');
    for (const end_code of ['1001', '999999999999999999999999999999999999999']) {
        assert.ok(validateParkingSlotCreation({ start_code: '1', end_code }).error);
    }
});

test('legacy single-slot creation still accepts arbitrary valid slot text', () => {
    for (const code of [' A-101 ', 'Visitor', '🚗'.repeat(255)]) {
        const details = validateParkingSlotCreation({ code });
        assert.equal(details.error, undefined);
        assert.equal(details.isRange, false);
        assert.equal(details.code, code.trim());
        assert.deepEqual(details.codes, [code.trim()]);
    }
});

test('invalid or ambiguous ranges are rejected before database access', async t => {
    const connect = t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    const invalid = [undefined, null, [], 'range', {},
        { start_code: '1' }, { end_code: '2' },
        { code: 'A1', start_code: 'A1', end_code: 'A2' },
        { start_code: 'A1', end_code: 'B2' }, { start_code: 'A1', end_code: 'a2' },
        { start_code: 'A1', end_code: '2' },
        { start_code: 'A2', end_code: 'A1' },
        { start_code: 'A', end_code: 'B' },
        { start_code: 'A1B1', end_code: 'A1B2' },
        { start_code: 'A1.5', end_code: 'A2.5' },
        { start_code: 'A01', end_code: 'A3' },
        { start_code: 'A1', end_code: 'A03' },
        { start_code: 'A001', end_code: 'A0003' },
        { start_code: '1', end_code: '1001' },
        ...[undefined, null, '', '  ', 1, [], {}, 'a'.repeat(256), `A${String.fromCharCode(0)}1`, 'A١']
            .flatMap(value => [{ start_code: value, end_code: 'A2' }, { start_code: 'A1', end_code: value }]),
        ...['id', 'owner_id', 'parking_id', 'floor_id', 'operational_status', 'maintenance_note',
            'is_available', 'is_occupied', 'created_at'].map(field => ({ start_code: 'A1', end_code: 'A2', [field]: 99 }))
    ];
    for (const body of invalid) {
        const res = response();
        await controller.createSlots(request(body), res);
        assert.equal(res.statusCode, 400, JSON.stringify(body));
        assert.equal(typeof res.body.message, 'string');
    }
    assert.equal(connect.mock.callCount(), 0);
});

test('bulk creation returns individual usable slots in range order after committing', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response(() => assert.equal(db.calls.at(-1).sql, 'COMMIT'));
    await controller.createSlots(request({ start_code: 'A-9', end_code: 'A-11' }), res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, { message: 'Parking slots created successfully', count: 3, slots: db.rows });
    assert.deepEqual(res.body.slots.map(slot => slot.code), ['A-9', 'A-10', 'A-11']);
    assert.ok(res.body.slots.every(slot => slot.parking_id === 12 && slot.floor_id === 1
        && slot.operational_status === 'usable' && slot.maintenance_note === null));
    assert.equal(db.calls[0].sql, 'BEGIN');
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.deepEqual(db.calls[2].values, [1, 12]);
    const inserts = db.calls.filter(call => call.sql.includes('INSERT INTO public.parking_slots'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].values, [12, 1, ['A-9', 'A-10', 'A-11']]);
    assert.deepEqual(db.releases, [undefined]);
});

test('range creation never inserts under inaccessible parking lots or floors', async t => {
    for (const options of [{ parkingRows: [] }, { floorRows: [] }]) {
        const db = connection(options);
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.createSlots(request({ start_code: '1', end_code: '3' }), res);
        assert.equal(res.statusCode, 404);
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.ok(!db.calls.some(call => call.sql.includes('INSERT INTO')));
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('one conflicting range code rolls back the request and returns 409', async t => {
    t.mock.method(console, 'error', () => {});
    const duplicate = Object.assign(new Error('private duplicate detail'),
        { code: '23505', constraint: 'parking_slots_parking_id_code_key' });
    const db = connection({ failures: { 'INSERT INTO': duplicate } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createSlots(request({ start_code: 'A1', end_code: 'A3' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
    assert.ok(!res.body.slots);
    assert.deepEqual(db.releases, [undefined]);
});

test('bulk commit failure returns a generic error and rolls back', async t => {
    t.mock.method(console, 'error', () => {});
    const db = connection({ failures: { COMMIT: new Error('private commit failure') } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createSlots(request({ start_code: 'A1', end_code: 'A3' }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.deepEqual(db.releases, [undefined]);
});

test('failed bulk rollback removes the connection and does not claim a clean conflict', async t => {
    t.mock.method(console, 'error', () => {});
    const duplicate = Object.assign(new Error('duplicate'),
        { code: '23505', constraint: 'parking_slots_parking_id_code_key' });
    const rollback = new Error('rollback connection failure');
    const db = connection({ failures: { 'INSERT INTO': duplicate, ROLLBACK: rollback } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createSlots(request({ start_code: 'A1', end_code: 'A3' }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
    assert.deepEqual(db.releases, [rollback]);
});

test('range POST requires authentication and scopes creation to the verified token owner', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'parking-slot-range-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const db = connection();
    const connect = t.mock.method(pool, 'connect', async () => db.client);
    const body = { start_code: 'A1', end_code: 'A3' };
    for (const authorization of [undefined, 'Bearer invalid']) {
        assert.equal((await route({ authorization }, body)).statusCode, 401);
    }
    assert.equal(connect.mock.callCount(), 0);
    const token = jwt.sign({ sub: '7', username: 'range-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const res = await route({ authorization: `Bearer ${token}` }, body);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.count, 3);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.deepEqual(db.calls[2].values, [1, 12]);
});
