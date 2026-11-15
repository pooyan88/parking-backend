const test = require('node:test');
const assert = require('node:assert/strict');
const { transaction } = require('../Database/transaction');

test('transaction commits on its single connection and returns the work result', async () => {
    const calls = []; let released = false;
    const client = { query: async sql => calls.push(sql), release: () => { released = true; } };
    const result = await transaction({ connect: async () => client }, async c => { assert.equal(c, client); await c.query('work'); return 42; });
    assert.equal(result, 42); assert.deepEqual(calls, ['BEGIN', 'work', 'COMMIT']); assert.ok(released);
});

test('failed work rolls back and a failed rollback destroys the connection', async () => {
    for (const broken of [false, true]) {
        const calls = []; let releasedWith;
        const client = { query: async sql => { calls.push(sql); if (broken && sql === 'ROLLBACK') throw new Error('connection failed'); },
            release: error => { releasedWith = error; } };
        const failure = new Error('work failed');
        await assert.rejects(transaction({ connect: async () => client }, async () => { throw failure; }), /work failed/);
        assert.deepEqual(calls, ['BEGIN', 'ROLLBACK']);
        assert.equal(Boolean(releasedWith), broken); assert.equal(Boolean(failure.rollbackFailed), broken);
    }
});
