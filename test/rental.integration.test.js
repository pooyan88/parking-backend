const test = require('node:test');
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { database } = require('./helpers/postgres');
const rentals = require('../Service/rentalService');
const lifecycle = require('../Service/rentalLifecycle');
const reports = require('../Service/parkingReports');
const parkingController = require('../Controller/parkingController');
const floorController = require('../Controller/parkingFloorController');
const slotController = require('../Controller/parkingSlotController');
const customerController = require('../Controller/customerController');

function response() { return {statusCode:200,status(c){this.statusCode=c;return this;},json(b){this.body=b;return this;},send(){return this;}}; }
function custom(d,slot,start,end) {return {customer_id:d.customer,slot_id:slot,rental_type:'custom',starts_at:start,ends_at:end,timezone:'UTC'};}
const options={skip:!process.env.PARKING_TEST_DATABASE_URL};

test('PostgreSQL calendars, overlap constraint, tenant FKs, and adjacent bookings',options,async t=>{
    const d=await database(t);
    const monthly=await rentals.create(d.owner,{customer_id:d.customer,slot_id:d.slots[0],rental_type:'monthly',
        starts_at:'2100-01-31T10:00:00Z',timezone:'UTC',agreed_price:'1000.00',currency:'IRR'});
    assert.equal(monthly.ends_at.toISOString(),'2100-02-28T10:00:00.000Z');
    const renewal=await lifecycle.run(d.owner,monthly.id,'renew',{});
    assert.equal(renewal.starts_at.toISOString(),'2100-02-28T10:00:00.000Z');
    assert.equal(renewal.ends_at.toISOString(),'2100-03-31T10:00:00.000Z');
    assert.equal(renewal.agreed_price,'1000.00');
    const quarter=await rentals.create(d.owner,{customer_id:d.customer,slot_id:d.slots[1],rental_type:'quarterly',
        starts_at:'2100-01-31T10:00:00Z',timezone:'UTC'});
    assert.equal(quarter.ends_at.toISOString(),'2100-04-30T10:00:00.000Z');
    const dst=await rentals.create(d.owner,{customer_id:d.customer,slot_id:d.slots[2],rental_type:'monthly',
        starts_at:'2024-03-01T10:00:00-05:00',timezone:'America/New_York'});
    assert.equal(dst.ends_at.toISOString(),'2024-04-01T14:00:00.000Z');
    assert.equal(dst.current_status,'expired');
    const request=custom(d,d.slots[3],'2100-05-01T00:00:00Z','2100-05-01T02:00:00Z');
    const race=await Promise.allSettled([rentals.create(d.owner,request),rentals.create(d.owner,request)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(race.find(r=>r.status==='rejected').reason.code,'23P01');
    await assert.rejects(d.pool.query(`INSERT INTO public.rental_contracts
        (owner_id,parking_id,customer_id,slot_id,rental_type,starts_at,ends_at,timezone,billing_anchor_at)
        VALUES ($1,$2,$3,$4,'custom',$5,$6,'UTC',$5)`,
        [d.owner,d.parking,d.customer,d.slots[3],request.starts_at,request.ends_at]),{code:'23P01'});
    await assert.rejects(d.pool.query(`INSERT INTO public.rental_contracts
        (owner_id,parking_id,customer_id,slot_id,rental_type,starts_at,ends_at,timezone,billing_anchor_at)
        VALUES ($1,$2,$3,$4,'custom',$5,$6,'UTC',$5)`,
        [d.owner,d.parking,d.foreignCustomer,d.slots[4],request.starts_at,request.ends_at]),{code:'23503'});
    await assert.rejects(rentals.create(d.owner,{...request,slot_id:d.foreignSlot}),e=>e.status===404);
    const first=await rentals.create(d.owner,custom(d,d.slots[5],'2100-06-01T00:00:00Z','2100-06-01T01:00:00Z'));
    await rentals.create(d.owner,custom(d,d.slots[5],'2100-06-01T01:00:00Z','2100-06-01T02:00:00Z'));
    await lifecycle.run(d.owner,first.id,'cancel',{});
    await rentals.create(d.owner,custom(d,d.slots[5],'2100-06-01T00:00:00Z','2100-06-01T01:00:00Z'));
    await assert.rejects(rentals.details(d.pool,d.foreignOwner,monthly.id),e=>e.status===404);
});

test('PostgreSQL early leaving, automatic expiry, and archive/maintenance guards',options,async t=>{
    const d=await database(t);const now=Date.now();const iso=offset=>new Date(now+offset).toISOString();
    const active=await rentals.create(d.owner,custom(d,d.slots[0],iso(-3600000),iso(3600000)));
    const expired=await rentals.create(d.owner,custom(d,d.slots[1],iso(-10800000),iso(-7200000)));
    assert.equal(expired.current_status,'expired');assert.equal(expired.remaining_seconds,0);
    assert.equal(active.current_status,'active');assert.ok(active.elapsed_seconds>=3599);
    for(const [handler,params,body] of [
        [parkingController.archiveParking,{id:String(d.parking)}],
        [floorController.archiveFloor,{parkingId:String(d.parking),floorId:String(d.floor)}],
        [slotController.archiveSlot,{parkingId:String(d.parking),floorId:String(d.floor),slotId:String(d.slots[0])}],
        [slotController.updateSlot,{parkingId:String(d.parking),floorId:String(d.floor),slotId:String(d.slots[0])},{operational_status:'maintenance'}],
        [customerController.archive,{id:String(d.customer)}]
    ]){
        const res=response();await handler({user:{id:d.owner},params,body},res);assert.equal(res.statusCode,409);
    }
    const ended=await lifecycle.run(d.owner,active.id,'end',{});
    assert.equal(ended.status,'ended');assert.equal(ended.ends_at.getTime(),active.ends_at.getTime());
    assert.equal(ended.remaining_seconds,0);assert.equal(ended.is_occupied,false);
    const free=await reports.availability(d.owner,d.parking,null,ended.effective_ends_at,active.ends_at,100,0);
    assert.equal(free.find(row=>row.slot_id===d.slots[0]).available_for_period,true);
    const res=response();await slotController.updateSlot({user:{id:d.owner},params:{parkingId:String(d.parking),floorId:String(d.floor),slotId:String(d.slots[0])},body:{operational_status:'maintenance'}},res);
    assert.equal(res.statusCode,200);
    await assert.rejects(rentals.create(d.owner,custom(d,d.slots[0],iso(7200000),iso(10800000))),e=>e.status===409);
    const archived=response();await customerController.archive({user:{id:d.owner},params:{id:String(d.customer)}},archived);
    assert.equal(archived.statusCode,204);
    assert.equal((await rentals.details(d.pool,d.owner,active.id)).status,'ended');
    await assert.rejects(rentals.create(d.owner,custom(d,d.slots[2],iso(7200000),iso(10800000))),e=>e.status===404);
});

test('PostgreSQL moves and extensions are atomic and renewals remain unique',options,async t=>{
    const d=await database(t);
    const original=await rentals.create(d.owner,custom(d,d.slots[0],'2100-08-01T00:00:00Z','2100-08-02T00:00:00Z'));
    const blocker=await rentals.create(d.owner,custom(d,d.slots[1],'2100-08-01T00:00:00Z','2100-08-02T00:00:00Z'));
    await assert.rejects(lifecycle.run(d.owner,original.id,'move',{slot_id:d.slots[1]}),{code:'23P01'});
    assert.equal((await rentals.details(d.pool,d.owner,original.id)).status,'confirmed');
    assert.equal((await d.pool.query('SELECT COUNT(*)::integer AS count FROM public.contract_events WHERE contract_id=$1',[original.id])).rows[0].count,1);
    await lifecycle.run(d.owner,blocker.id,'cancel',{});
    const moved=await lifecycle.run(d.owner,original.id,'move',{slot_id:d.slots[1]});
    assert.equal(moved.previous_contract_id,original.id);assert.equal(moved.ends_at.getTime(),original.ends_at.getTime());
    assert.equal((await rentals.details(d.pool,d.owner,original.id)).status,'cancelled');
    const source=await rentals.create(d.owner,{...custom(d,d.slots[2],'2100-09-01T00:00:00Z','2100-09-02T00:00:00Z'),agreed_price:'100',currency:'IRR'});
    const next=await rentals.create(d.owner,custom(d,d.slots[2],'2100-09-02T00:00:00Z','2100-09-03T00:00:00Z'));
    await assert.rejects(lifecycle.run(d.owner,source.id,'extend',{ends_at:'2100-09-02T12:00:00Z'}),{code:'23P01'});
    assert.equal((await rentals.details(d.pool,d.owner,source.id)).ends_at.getTime(),source.ends_at.getTime());
    await lifecycle.run(d.owner,next.id,'cancel',{});
    const extended=await lifecycle.run(d.owner,source.id,'extend',{ends_at:'2100-09-03T00:00:00Z'});
    assert.equal(extended.agreed_price,'100.00');
    const renewed=await lifecycle.run(d.owner,source.id,'renew',{ends_at:'2100-09-04T00:00:00Z'});
    await assert.rejects(lifecycle.run(d.owner,source.id,'renew',{ends_at:'2100-09-04T00:00:00Z'}));
    await lifecycle.run(d.owner,renewed.id,'cancel',{});
    await lifecycle.run(d.owner,source.id,'renew',{ends_at:'2100-09-04T00:00:00Z'});
    const now=Date.now();const live=await rentals.create(d.owner,custom(d,d.slots[3],new Date(now-3600000).toISOString(),new Date(now+3600000).toISOString()));
    const liveMove=await lifecycle.run(d.owner,live.id,'move',{slot_id:d.slots[4]});
    const closed=await rentals.details(d.pool,d.owner,live.id);
    assert.equal(closed.effective_ends_at.getTime(),liveMove.starts_at.getTime());
    assert.equal(closed.status,'ended');assert.equal(liveMove.current_status,'active');
});

test('PostgreSQL availability and dashboard agree on time and capacity without duplicate counts',options,async t=>{
    const d=await database(t);const now=Date.now();const iso=ms=>new Date(now+ms).toISOString();
    await rentals.create(d.owner,custom(d,d.slots[0],iso(-3600000),iso(3600000)));
    await rentals.create(d.owner,custom(d,d.slots[1],iso(3600000),iso(7200000)));
    await rentals.create(d.owner,custom(d,d.slots[2],iso(-10800000),iso(-7200000)));
    await d.pool.query("UPDATE public.parking_slots SET operational_status='maintenance' WHERE id=$1",[d.slots[5]]);
    const rows=await reports.availability(d.owner,d.parking,null,new Date(now),new Date(now+1800000),100,0);
    assert.equal(rows.length,6);assert.equal(rows.find(r=>r.slot_id===d.slots[0]).current_state,'occupied');
    assert.equal(rows.find(r=>r.slot_id===d.slots[0]).available_for_period,false);
    assert.equal(rows.find(r=>r.slot_id===d.slots[1]).current_state,'available');
    const future=await reports.availability(d.owner,d.parking,null,new Date(now+5400000),new Date(now+7200000),100,0);
    assert.equal(future.find(r=>r.slot_id===d.slots[1]).period_state,'reserved');
    assert.equal(future.find(r=>r.slot_id===d.slots[5]).period_state,'maintenance');
    const summary=await reports.dashboard(d.owner,null,7);
    assert.equal(summary.total_parking_lots,1);assert.equal(summary.total_slots,6);
    assert.equal(summary.occupied_slots,1);assert.equal(summary.available_slots,4);assert.equal(summary.maintenance_slots,1);
    assert.equal(summary.occupancy_percentage,20);assert.equal(summary.total_customers,1);
    assert.equal(summary.active_contracts,1);assert.equal(summary.upcoming_contracts,1);assert.equal(summary.expired_contracts,1);
    assert.equal(summary.floors[0].available_slots,4);
    await assert.rejects(reports.dashboard(d.owner,d.foreignParking,7),e=>e.status===404);
    await assert.rejects(reports.availability(d.owner,d.parking,d.foreignFloor,new Date(now),new Date(now+1000),100,0),e=>e.status===404);
});
