const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../Database/db');
const parking = require('../Controller/parkingController');
const floor = require('../Controller/parkingFloorController');
const slot = require('../Controller/parkingSlotController');
const customer = require('../Controller/customerController');
test.after(() => pool.end());
test('all archive and maintenance entry points reject a booking under their transaction locks', async t => {
    t.mock.method(console, 'error', () => {});
    for (const [handler, params, body] of [
        [parking.archiveParking, { id:'12' }],
        [floor.archiveFloor, { parkingId:'12', floorId:'2' }],
        [slot.archiveSlot, { parkingId:'12', floorId:'2', slotId:'3' }],
        [slot.updateSlot, { parkingId:'12', floorId:'2', slotId:'3' }, { operational_status:'maintenance' }],
        [customer.archive, { id:'4' }]
    ]) {
        const calls=[]; let released=false;
        const connect=t.mock.method(pool,'connect',async()=>({query:async(sql,values)=>{
            calls.push({sql,values});
            assert.ok(!/^\s*(UPDATE|INSERT|DELETE)/.test(sql),'no business writes may happen after a blocking booking is found');
            if(sql.includes('FROM public.rental_contracts')) {assert.equal(values[0],'7');return {rows:[{one:1}]};}
            if(sql.includes('SELECT'))return {rows:[{id:3,operational_status:'usable',maintenance_note:null}]};
            return {rows:[]};
        },release(){released=true;}}));
        const res={status(c){this.code=c;return this;},json(b){this.body=b;return this;},send(){return this;}};
        await handler({user:{id:'7'},params,body},res);
        assert.equal(res.code,409);assert.equal(calls[0].sql,'BEGIN');
        assert.ok(calls.some(call=>call.sql.includes('FOR UPDATE')));
        assert.equal(calls.at(-1).sql,'ROLLBACK');assert.ok(released);
        connect.mock.restore();
    }
});
