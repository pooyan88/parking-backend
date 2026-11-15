const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../Database/db');
const controller = require('../Controller/parkingController');
const router = require('../Router/parkingRouter');

test.after(() => pool.end());
test.beforeEach(t => {
    t.mock.method(pool, 'connect', async () => ({ query: async (sql, values) => {
        if (sql.includes('SELECT id FROM public.parkings')) return { rows: [{ id: 12 }] };
        if (sql.includes('FROM public.rental_contracts') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        return pool.query(sql, values);
    }, release() {} }));
});

function response(onFinish = () => {}) {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; onFinish(); return this; },
        send(body) { this.body = body; onFinish(); return this; }
    };
}

async function deleteParking(headers, id = '12') {
    let res;
    await new Promise((resolve, reject) => {
        res = response(resolve);
        router.handle({ method: 'DELETE', url: `/parkings/${id}`, headers }, res, error => {
            reject(error || new Error('DELETE /parkings/:id did not return a response'));
        });
    });
    return res;
}

test('archiving preserves the row and checks the parking ID and authenticated owner', async t => {
    const query = t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /UPDATE public\.parkings/);
        assert.match(sql, /SET archived_at = COALESCE\(archived_at, NOW\(\)\)/);
        assert.match(sql, /WHERE id = \$1 AND owner_id = \$2/);
        assert.ok(!sql.includes('DELETE FROM'));
        assert.deepEqual(values, [12, '7']);
        return { rows: [{ id: 12 }] };
    });
    const res = response();
    await controller.archiveParking({ user: { id: '7' }, params: { id: '12' },
        query: { owner_id: '99' }, body: { user_id: 99, owner_id: 99 } }, res);
    assert.equal(query.mock.callCount(), 1);
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, undefined);
});

test('repeated archiving succeeds and keeps the original archive timestamp', async t => {
    const query = t.mock.method(pool, 'query', async (sql, values) => {
        assert.match(sql, /COALESCE\(archived_at, NOW\(\)\)/);
        assert.deepEqual(values, [12, '7']);
        return { rows: [{ id: 12 }] };
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = response();
        await controller.archiveParking({ user: { id: '7' }, params: { id: '12' } }, res);
        assert.equal(res.statusCode, 204);
    }
    assert.equal(query.mock.callCount(), 2);
});

test('missing or another owner\'s parking returns 404', async t => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = response();
    await controller.archiveParking({ user: { id: '7' }, params: { id: '12' } }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Parking lot not found' });
});

test('invalid parking IDs stop before the database query', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const id of [undefined, '', '0', '-1', '01', '1.5', '1e2', '2147483648', '9'.repeat(100), '12 OR 1=1']) {
        const res = response();
        await controller.archiveParking({ user: { id: '7' }, params: { id } }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('database errors return a generic 500', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(pool, 'query', async () => { throw new Error('private database details'); });
    const res = response();
    await controller.archiveParking({ user: { id: '7' }, params: { id: '12' } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Internal server error' });
});

test('the DELETE route rejects requests without a valid access token', async t => {
    const query = t.mock.method(pool, 'query', () => assert.fail('must not query'));
    for (const authorization of [undefined, 'Bearer invalid']) {
        const res = await deleteParking({ authorization });
        assert.equal(res.statusCode, 401);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('the DELETE route uses JWT ownership and the URL parking ID', async t => {
    const originalSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'parking-archive-test-secret';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = originalSecret;
    });
    const token = jwt.sign({ sub: '7', username: 'test-owner' }, process.env.JWT_ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: '1m' });
    t.mock.method(pool, 'query', async (sql, values) => {
        assert.deepEqual(values, [12, '7']);
        return { rows: [{ id: 12 }] };
    });
    const res = await deleteParking({ authorization: `Bearer ${token}` });
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, undefined);
});
