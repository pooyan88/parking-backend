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

function connection({ parkingRows = [{ id: 12 }], floorRows = [{ id: 1 }], failures = {} } = {}) {
    const calls = [];
    const releases = [];
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            const failure = Object.entries(failures).find(([pattern]) => sql.includes(pattern));
            if (failure) throw failure[1];
            if (sql.includes('SELECT id FROM public.parkings')) return { rows: parkingRows };
            if (sql.includes('SELECT id FROM public.parking_floors')) return { rows: floorRows };
            if (sql.includes('INSERT INTO public.parking_slots')) return { rows: [{
                id: 1, parking_id: values[0], floor_id: values[1], code: values[2],
                operational_status: 'usable', maintenance_note: null, created_at: new Date('2026-11-15T10:00:00Z')
            }] };
            return { rows: [] };
        },
        release(error) { releases.push(error); }
    };
    return { client, calls, releases };
}

function request(body, params = { parkingId: '12', floorId: '1' }) {
    return { user: { id: '7' }, params, body, query: { owner_id: '99' } };
}

async function route(method, headers, body) {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method, url: '/parkings/12/floors/1/slots', headers, body }, res, error => {
            reject(error || new Error('Slot endpoint did not return a response'));
        });
    });
    return res;
}

test('slot creation locks the owner\'s active lot then the matching active floor', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    t.mock.method(pool, 'query', () => assert.fail('must use the same transaction connection'));
    const res = response();
    await controller.createSlot(request({ code: ' A-101 ' }), res);
    assert.equal(db.calls[0].sql, 'BEGIN');
    assert.match(db.calls[1].sql, /WHERE id = \$1 AND owner_id = \$2 AND archived_at IS NULL/);
    assert.match(db.calls[1].sql, /FOR UPDATE/);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.match(db.calls[2].sql, /WHERE id = \$1 AND parking_id = \$2 AND archived_at IS NULL/);
    assert.match(db.calls[2].sql, /FOR UPDATE/);
    assert.deepEqual(db.calls[2].values, [1, 12]);
    assert.match(db.calls[3].sql, /VALUES \(\$1, \$2, \$3\)/);
    assert.deepEqual(db.calls[3].values, [12, 1, 'A-101']);
    assert.equal(db.calls[4].sql, 'COMMIT');
    assert.deepEqual(db.releases, [undefined]);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.slot.code, 'A-101');
    assert.equal(res.body.slot.operational_status, 'usable');
    assert.equal(res.body.slot.maintenance_note, null);
    assert.ok(!Object.hasOwn(res.body.slot, 'is_available'));
    assert.ok(!Object.hasOwn(res.body.slot, 'is_occupied'));
});

test('invalid codes and client ownership or availability fields stop before connecting', async t => {
    const connect = t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    for (const body of [undefined, null, [], 'text', {},
        ...[undefined, null, '', '  ', 42, [], {}, 'a'.repeat(256), 'A\0code'].map(code => ({ code })),
        ...['id', 'owner_id', 'user_id', 'parking_id', 'floor_id', 'operational_status', 'maintenance_note',
            'is_available', 'is_occupied', 'created_at'].map(field => ({ code: 'A-101', [field]: 99 }))]) {
        const res = response();
        await controller.createSlot(request(body), res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(connect.mock.callCount(), 0);
});

test('invalid parent IDs stop both slot actions before database access', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const bad of [undefined, '', '0', '-1', '01', '1.5', '2147483648', '1 OR 1=1']) {
        for (const params of [{ parkingId: bad, floorId: '1' }, { parkingId: '12', floorId: bad }]) {
            for (const action of [controller.createSlot, controller.getSlots]) {
                const res = response();
                await action(request({ code: 'A-101' }, params), res);
                assert.equal(res.statusCode, 400);
            }
        }
    }
});

test('Unicode codes at the length boundary and SQL-looking input stay in parameters', async t => {
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    for (const code of ['🚗'.repeat(255), "A-101'); DROP TABLE users; --"]) {
        const res = response();
        await controller.createSlot(request({ code }), res);
        assert.equal(res.statusCode, 201);
        const insert = db.calls.filter(call => call.sql.includes('INSERT INTO')).at(-1);
        assert.deepEqual(insert.values, [12, 1, code]);
        assert.ok(!insert.sql.includes(code));
    }
});

test('missing, archived, foreign-owned, or cross-lot parents roll back before insert', async t => {
    for (const options of [{ parkingRows: [] }, { floorRows: [] }]) {
        const db = connection(options);
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.createSlot(request({ code: 'A-101' }), res);
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { message: 'Parking floor not found' });
        assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
        assert.ok(!db.calls.some(call => call.sql.includes('INSERT INTO')));
        if (options.parkingRows) assert.ok(!db.calls.some(call => call.sql.includes('SELECT id FROM public.parking_floors')));
        assert.deepEqual(db.releases, [undefined]);
        connect.mock.restore();
    }
});

test('duplicate slot codes return 409 after rollback', async t => {
    t.mock.method(console, 'error', () => {});
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'parking_slots_parking_id_code_key' });
    const db = connection({ failures: { 'INSERT INTO': duplicate } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createSlot(request({ code: 'A-101' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
    assert.deepEqual(db.releases, [undefined]);
});

test('unexpected insert and commit failures roll back and return a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    for (const failures of [{ 'INSERT INTO': new Error('private failure') }, { COMMIT: new Error('commit failure') },
        { 'INSERT INTO': Object.assign(new Error('different uniqueness violation'), { code: '23505', constraint: 'another_constraint' }) }]) {
        const db = connection({ failures });
        const connect = t.mock.method(pool, 'connect', async () => db.client);
        const res = response();
        await controller.createSlot(request({ code: 'A-101' }), res);
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
    const db = connection({ failures: { 'INSERT INTO': new Error('insert failure'), ROLLBACK: rollback } });
    t.mock.method(pool, 'connect', async () => db.client);
    const res = response();
    await controller.createSlot(request({ code: 'A-101' }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.releases, [rollback]);
});

test('connection acquisition failures return a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'connect', async () => { throw new Error('private connection failure'); });
    const res = response();
    await controller.createSlot(request({ code: 'A-101' }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('listing checks both active parents and returns maintenance slots without booking flags', async t => {
    const slots = [{ id: 1, parking_id: 12, floor_id: 1, code: 'A-101', operational_status: 'maintenance',
        maintenance_note: 'Repair', created_at: new Date() }];
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /JOIN public\.parking_floors f/);
        assert.match(sql, /f.parking_id = p.id AND f.id = \$2 AND f.archived_at IS NULL/);
        assert.match(sql, /s.parking_id = p.id AND s.floor_id = f.id AND s.archived_at IS NULL/);
        assert.match(sql, /WHERE p.id = \$1 AND p.owner_id = \$3 AND p.archived_at IS NULL/);
        assert.match(sql, /ORDER BY LOWER\(s.code\), s.id/);
        assert.deepEqual(values, [12, 1, '7']);
        return { rows: slots };
    });
    const res = response();
    await controller.getSlots(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, slots);
});

test('an accessible empty floor returns an empty slot array', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [{ id: null }] }));
    const res = response();
    await controller.getSlots(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
});

test('inaccessible floor listing returns 404', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = response();
    await controller.getSlots(request(), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Parking floor not found' });
});

test('listing database errors do not expose details', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'query', async () => { throw new Error('private database details'); });
    const res = response();
    await controller.getSlots(request(), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('both slot routes require a valid access token before database access', async t => {
    t.mock.method(pool, 'connect', () => assert.fail('must not connect'));
    t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const method of ['GET', 'POST']) {
        for (const authorization of [undefined, 'Bearer invalid']) {
            assert.equal((await route(method, { authorization }, { code: 'A-101' })).statusCode, 401);
        }
    }
});

test('both slot routes use URL parents and the verified JWT owner', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'parking-slot-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    const db = connection();
    t.mock.method(pool, 'connect', async () => db.client);
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.deepEqual(values, [12, 1, '7']);
        return { rows: [{ id: null }] };
    });
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await route('POST', headers, { code: 'A-101' })).statusCode, 201);
    assert.deepEqual(db.calls[1].values, [12, '7']);
    assert.deepEqual(db.calls[2].values, [1, 12]);
    assert.equal((await route('GET', headers)).statusCode, 200);
});
