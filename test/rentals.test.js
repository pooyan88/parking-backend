const test = require('node:test');
const assert = require('node:assert/strict');
const validation = require('../Utils/rentalValidation');
const { assertNoBookings } = require('../Service/rentalGuards');
const pool = require('../Database/db');
const service = require('../Service/rentalService');
const controller = require('../Controller/rentalController');
test.after(() => pool.end());

const body = { customer_id: 2, slot_id: 3, starts_at: '2030-01-31T10:00:00Z', rental_type: 'monthly', timezone: 'UTC' };
test('timestamp validation rejects impossible dates, missing offsets, leap seconds, and overflow', () => {
    for (const value of ['2030-02-30T12:00:00Z','2030-01-01T12:00:00','2030-01-01T24:00:00Z',
        '2030-01-01T12:00:60Z','2030-01-01T12:00:00+14:30','not a date']) {
        assert.throws(()=>validation.timestamp(value,'time'), error=>error.status===400);
    }
    assert.equal(validation.timestamp('2028-02-29T10:00:00+03:30','time').toISOString(),'2028-02-29T06:30:00.000Z');
});
test('rental types use hours, calendar months, or explicit custom ends without accepting ambiguous inputs', () => {
    assert.equal(validation.creation(body).periodMonths,1);
    assert.equal(validation.creation({...body,rental_type:'quarterly'}).periodMonths,3);
    assert.equal(validation.creation({...body,rental_type:'hourly',hours:2}).endsAt.toISOString(),'2030-01-31T12:00:00.000Z');
    for(const extra of [{owner_id:99},{hours:30},{ends_at:'2030-03-01T10:00:00Z'},{rental_type:'hourly',hours:1.5},
        {rental_type:'custom',ends_at:'2030-01-01T10:00:00Z'},{timezone:'invalid/place'}]) {
        assert.throws(()=>validation.creation({...body,...extra}),error=>error.status===400);
    }
});
test('money uses explicit decimal strings and a paired currency, preserving optional prices',()=>{
    assert.deepEqual(validation.price({}),{agreedPrice:null,currency:null});
    assert.deepEqual(validation.price({agreed_price:'1000.50',currency:'IRR'}),{agreedPrice:'1000.50',currency:'IRR'});
    for(const value of [{agreed_price:1000,currency:'IRR'},{agreed_price:'-1',currency:'IRR'},
        {agreed_price:'1.001',currency:'IRR'},{agreed_price:'1'}, {currency:'IRR'}]) {
        assert.throws(()=>validation.price(value),error=>error.status===400);
    }
});
test('archive and maintenance guard scopes owner and rejects active or future bookings',async()=>{
    let values;
    const client={query:async(sql,args)=>{values=args;assert.match(sql,/ends_at > NOW\(\)/);return {rows:[{one:1}]};}};
    await assert.rejects(assertNoBookings(client,{ownerId:'7',parkingId:12,slotId:3}),error=>error.status===409);
    assert.deepEqual(values,['7',12,null,3,null]);
});

function fakeDatabase({customer=true,eventFailure=false}={}) {
    const calls=[];let released=false;
    const client={query:async(sql,values)=>{
        calls.push({sql,values});
        if(sql.includes('SELECT s.id, s.floor_id'))return {rows:[{id:3,floor_id:1,parking_id:12}]};
        if(sql.includes('SELECT * FROM public.parkings'))return {rows:[{id:12,timezone:'UTC'}]};
        if(sql.includes('SELECT * FROM public.parking_floors'))return {rows:[{id:1,parking_id:12}]};
        if(sql.includes('SELECT * FROM public.parking_slots'))return {rows:[{id:3,floor_id:1,parking_id:12,operational_status:'usable'}]};
        if(sql.includes('FROM public.customers')){assert.deepEqual(values,[2,'7']);return {rows:customer?[{id:2}]:[]};}
        if(sql.includes('make_interval')){assert.deepEqual(values,[new Date(body.starts_at),1,'UTC']);return {rows:[{ends_at:new Date('2030-02-28T10:00:00Z')}]};}
        if(sql.includes('INSERT INTO public.rental_contracts'))return {rows:[{id:50,owner_id:7,ends_at:values[6]}]};
        if(sql.includes('INSERT INTO public.contract_events')&&eventFailure)throw new Error('event failed');
        if(sql.includes('FROM public.rental_contract_details'))return {rows:[{id:50,owner_id:7,current_status:'upcoming'}]};
        return {rows:[]};
    },release(){released=true;}};
    return {client,calls,get released(){return released;}};
}
test('contract creation locks resources and customer, calculates months in SQL, and records history atomically',async t=>{
    const db=fakeDatabase();t.mock.method(pool,'connect',async()=>db.client);
    const result=await service.create('7',body);
    assert.equal(result.id,50);assert.deepEqual(db.calls[1].values,[[3],'7']);
    assert.ok(db.calls.some(call=>call.sql.includes('contract_events')));
    assert.equal(db.calls.at(-1).sql,'COMMIT');assert.ok(db.released);
});
test('foreign customers and event failures roll back contract creation',async t=>{
    for(const options of [{customer:false},{eventFailure:true}]) {
        const db=fakeDatabase(options);const mock=t.mock.method(pool,'connect',async()=>db.client);
        await assert.rejects(service.create('7',body));assert.equal(db.calls.at(-1).sql,'ROLLBACK');
        assert.ok(!db.calls.some(call=>call.sql==='COMMIT'));assert.ok(db.released);mock.mock.restore();
    }
});
test('database exclusion conflicts map to HTTP 409',()=>{
    const response={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    controller.failure(response,{code:'23P01'});assert.equal(response.code,409);
});
