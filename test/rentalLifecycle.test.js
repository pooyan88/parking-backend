const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../Database/db');
const rentals = require('../Service/rentalService');
const lifecycle = require('../Service/rentalLifecycle');
test.after(()=>pool.end());

function setup(t, overrides = {}, insertFailure = false) {
    const source = { id:5,owner_id:7,parking_id:12,customer_id:2,slot_id:10,status:'confirmed',rental_type:'monthly',period_months:1,
        starts_at:new Date('2030-01-31T10:00:00Z'),ends_at:new Date('2030-02-28T10:00:00Z'),timezone:'UTC',
        billing_anchor_at:new Date('2030-01-31T10:00:00Z'),billing_month_offset:0,agreed_price:'1000.00',currency:'IRR',
        action_at:new Date('2030-02-01T10:00:00Z'),...overrides };
    const calls=[];const inserted=[];const events=[];
    const client={query:async(sql,values)=>{
        calls.push({sql,values});
        if(sql.startsWith('SELECT slot_id'))return {rows:[{slot_id:source.slot_id}]};
        if(sql.includes('SELECT c.*'))return {rows:[source]};
        if(sql.includes('UPDATE public.rental_contracts'))return {rows:[{...source}]};
        return {rows:[]};
    },release(){}};
    t.mock.method(pool,'connect',async()=>client);
    t.mock.method(rentals,'lockResources',async(c,owner,ids)=>{
        assert.equal(owner,'7');assert.ok(ids.includes(10));return {parkings:[{id:12}],slots:ids.map(id=>({id,parking_id:12,code:'Existing',operational_status:'usable'}))};
    });
    t.mock.method(rentals,'lockCustomer',async()=>{});
    t.mock.method(rentals,'calendarEnd',async(c,anchor,months,zone)=>{
        assert.equal(anchor.getTime(),source.billing_anchor_at.getTime());assert.equal(months,2);assert.equal(zone,'UTC');
        return new Date('2030-03-31T10:00:00Z');
    });
    t.mock.method(rentals,'insert',async(c,owner,value)=>{if(insertFailure)throw Object.assign(new Error('overlap'),{code:'23P01'});inserted.push(value);return {id:6,...value};});
    t.mock.method(rentals,'event',async(c,owner,id,type)=>events.push({id,type}));
    t.mock.method(rentals,'details',async(c,owner,id)=>({id}));
    return {source,calls,inserted,events};
}
test('monthly renewal carries the original day anchor and creates a linked agreement',async t=>{
    const db=setup(t);const result=await lifecycle.run('7',5,'renew',{});
    assert.equal(result.id,6);assert.equal(db.inserted[0].monthOffset,1);
    assert.equal(db.inserted[0].startsAt.toISOString(),'2030-02-28T10:00:00.000Z');
    assert.equal(db.inserted[0].endsAt.toISOString(),'2030-03-31T10:00:00.000Z');
    assert.equal(db.inserted[0].agreedPrice,'1000.00');assert.equal(db.inserted[0].previousId,5);
    assert.equal(db.calls.at(-1).sql,'COMMIT');
});
test('active slot move ends the source and creates a linked remaining-period agreement',async t=>{
    const db=setup(t);await lifecycle.run('7',5,'move',{slot_id:2});
    const close=db.calls.find(call=>call.sql.includes("status = 'ended'"));
    assert.deepEqual(close.values,[5,'7',db.source.action_at]);
    assert.equal(db.inserted[0].slotId,2);assert.equal(db.inserted[0].startsAt,db.source.action_at);
    assert.equal(db.inserted[0].endsAt,db.source.ends_at);assert.equal(db.events.length,2);
});
test('failed destination insert rolls back the source closure and creates no events',async t=>{
    const db=setup(t,{},true);await assert.rejects(lifecycle.run('7',5,'move',{slot_id:2}),error=>error.code==='23P01');
    assert.ok(db.calls.some(call=>call.sql.includes("status = 'ended'")));
    assert.equal(db.calls.at(-1).sql,'ROLLBACK');assert.equal(db.events.length,0);
});
test('upcoming move cancels the old reservation while preserving the original start',async t=>{
    const db=setup(t,{action_at:new Date('2030-01-01T00:00:00Z')});
    await lifecycle.run('7',5,'move',{slot_id:2});
    assert.ok(db.calls.some(call=>call.sql.includes("status = 'cancelled'")));
    assert.equal(db.inserted[0].startsAt,db.source.starts_at);
});
test('active cancellation is rejected without changing the agreement',async t=>{
    const db=setup(t);await assert.rejects(lifecycle.run('7',5,'cancel',{}),error=>error.status===409);
    assert.ok(!db.calls.some(call=>call.sql.includes('UPDATE public.rental_contracts')));
    assert.equal(db.calls.at(-1).sql,'ROLLBACK');
});
test('early ending uses the database millisecond action instant and preserves agreed end',async t=>{
    const db=setup(t);await lifecycle.run('7',5,'end',{});
    const update=db.calls.find(call=>call.sql.includes('UPDATE public.rental_contracts'));
    assert.match(update.sql,/ended_at = \$3/);assert.ok(!update.sql.includes('ends_at ='));
    assert.equal(update.values[2],db.source.action_at);assert.equal(db.events[0].type,'ended');
});
test('extension records revised custom terms and does not silently calculate a new price',async t=>{
    const db=setup(t);await lifecycle.run('7',5,'extend',{ends_at:'2030-03-15T10:00:00Z'});
    const update=db.calls.find(call=>call.sql.includes('UPDATE public.rental_contracts'));
    assert.match(update.sql,/rental_type = 'custom'/);assert.equal(update.values[1],'1000.00');
    assert.equal(db.events[0].type,'extended');
});
test('already closed contracts reject lifecycle changes',async t=>{
    const db=setup(t,{status:'ended'});await assert.rejects(lifecycle.run('7',5,'renew',{}),error=>error.status===409);
    assert.equal(db.inserted.length,0);assert.equal(db.calls.at(-1).sql,'ROLLBACK');
});
