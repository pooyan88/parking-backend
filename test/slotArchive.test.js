const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../Database/db');
const controller = require('../Controller/parkingSlotController');
test.after(() => pool.end());
test('slot archive authorizes parent ownership and both child IDs, preserving the row', async t => {
    const calls = [];
    t.mock.method(pool, 'connect', async () => ({ query: async (sql, values) => {
        calls.push({sql, values}); return { rows: [{ id: 1 }] };
    }, release() {} }));
    const res = { status(code) { this.code = code; return this; }, send() { return this; } };
    await controller.archiveSlot({ params: { parkingId: '12', floorId: '2', slotId: '1' }, user: { id: '7' } }, res);
    assert.equal(res.code, 204);
    assert.deepEqual(calls[1].values, [12, '7']); assert.deepEqual(calls[2].values, [2, 12]);
    assert.deepEqual(calls[3].values, [1, 2, 12]); assert.match(calls[3].sql, /COALESCE\(archived_at, NOW\(\)\)/);
    assert.equal(calls.at(-1).sql, 'COMMIT');
});
