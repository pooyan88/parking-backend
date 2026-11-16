const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { database } = require('./helpers/postgres');
const { inject } = require('./helpers/http');
const app = require('../app');
const reports = require('../Service/parkingReports');
const rentals = require('../Service/rentalService');
const lifecycle = require('../Service/rentalLifecycle');
const { runMigrations } = require('../Database/migrationRunner');
const application = require('../Database/db');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const options = { skip: !process.env.PARKING_TEST_DATABASE_URL };
const secret = 'disposable-profile-test-secret-at-least-32-bytes';
test.beforeEach(t => {
    const old = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = secret;
    t.after(() => { if (old === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = old; });
});
test.after(() => application.end());
const headers = id => ({ authorization: `Bearer ${jwt.sign({ sub: String(id) }, secret, { algorithm: 'HS256', expiresIn: '1m' })}` });
const batchUrl = d => `/parkings/${d.parking}/floors/${d.floor}/slots/batch`;

test('registered phone is returned by login and protected profile without exposing hashes', options, async t => {
    const d = await database(t);
    const signup = await inject(app, { method: 'POST', url: '/auth/signup', body: {
        username: 'registered-test-owner', phone_number: 'synthetic-registered-phone', password: 'synthetic-test-password'
    } });
    assert.equal(signup.status, 201);
    const login = await inject(app, { method: 'POST', url: '/auth/login', body: {
        username: 'registered-test-owner', password: 'synthetic-test-password'
    } });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.phone_number, 'synthetic-registered-phone');
    const profile = await inject(app, { url: '/auth/me', headers: { authorization: `Bearer ${login.body.access_token}` } });
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body.user, signup.body.user);
    assert.equal(Object.hasOwn(profile.body.user, 'password_hash'), false);
    assert.equal((await inject(app, { url: '/auth/me' })).status, 401);
    const other = await inject(app, { url: `/auth/me?user_id=${signup.body.user.id}`, headers: headers(d.owner) });
    assert.equal(other.body.user.id, d.owner);
});

test('10 existing slots plus a batch of 5 creates 15 slots with 5 NULL codes and accurate occupancy', options, async t => {
    const d = await database(t);
    await d.pool.query(`INSERT INTO public.parking_slots (parking_id,floor_id,code)
        SELECT $1,$2,'extra-' || n FROM generate_series(1,4) n`, [d.parking,d.floor]);
    const before = (await d.pool.query('SELECT id,code FROM public.parking_slots WHERE floor_id=$1 ORDER BY id',[d.floor])).rows;
    const result = await inject(app, { method: 'POST', url: batchUrl(d), headers: headers(d.owner), body: { count: 5 } });
    assert.equal(result.status, 201);
    assert.equal(result.body.slots.length, 5);
    assert.equal(new Set(result.body.slots.map(s => s.id)).size, 5);
    assert.ok(result.body.slots.every(s => s.code === null));
    const after = (await d.pool.query('SELECT id,code FROM public.parking_slots WHERE floor_id=$1 ORDER BY id',[d.floor])).rows;
    assert.deepEqual(after.slice(0,10), before);
    const stats = await reports.dashboard(d.owner,d.parking,7);
    assert.deepEqual([stats.total_slots,stats.available_slots,stats.occupied_slots],[15,15,0]);
    for (const count of [0,-1,1.5,'5',1001]) {
        assert.equal((await inject(app,{method:'POST',url:batchUrl(d),headers:headers(d.owner),body:{count}})).status,400);
    }
    assert.equal((await inject(app,{method:'POST',url:batchUrl(d),headers:headers(d.foreignOwner),body:{count:5}})).status,404);
    assert.equal((await d.pool.query('SELECT COUNT(*)::integer AS n FROM public.parking_slots WHERE floor_id=$1',[d.floor])).rows[0].n,15);
});

test('slot code and contract commit together; conflicts roll back code and preserve history', options, async t => {
    const d = await database(t);
    const batch = await inject(app,{method:'POST',url:batchUrl(d),headers:headers(d.owner),body:{count:5}});
    const ids = batch.body.slots.map(s=>s.id);
    const start = new Date(Date.now()-60000).toISOString(), end = new Date(Date.now()+3600000).toISOString();
    const body = {customer_id:d.customer,slot_id:ids[0],slot_code:'A-105',rental_type:'custom',starts_at:start,ends_at:end,timezone:'UTC',agreed_price:'100.00',currency:'IRR'};
    const free = await reports.availability(d.owner,d.parking,d.floor,start,end,100,0);
    assert.equal(free.find(s=>s.slot_id===ids[0]).code,null);
    const created = await inject(app,{method:'POST',url:'/contracts',headers:headers(d.owner),body});
    assert.equal(created.status,201); assert.equal(created.body.contract.slot_code,'A-105');
    assert.equal(created.body.contract.customer_id,d.customer);
    const occupied = await reports.availability(d.owner,d.parking,d.floor,start,end,100,0);
    assert.equal(occupied.find(s=>s.slot_id===ids[0]).current_state,'occupied');
    assert.equal(occupied.filter(s=>ids.includes(s.slot_id)&&s.code===null).length,4);
    assert.equal((await inject(app,{method:'POST',url:'/contracts',headers:headers(d.owner),body})).status,409);
    assert.equal((await inject(app,{method:'POST',url:'/contracts',headers:headers(d.owner),body:{...body,slot_id:ids[1]}})).status,409);
    assert.equal((await d.pool.query('SELECT code FROM public.parking_slots WHERE id=$1',[ids[1]])).rows[0].code,null);
    const stats = await reports.dashboard(d.owner,d.parking,7);
    assert.equal(stats.total_slots,11);assert.equal(stats.available_slots,10);assert.equal(stats.occupied_slots,1);
    await lifecycle.run(d.owner,created.body.contract.id,'end',{});
    await rentals.create(d.owner,{...body,slot_code:'A-106',starts_at:new Date(Date.now()+60000).toISOString()});
    assert.equal((await rentals.details(d.pool,d.owner,created.body.contract.id)).slot_code,'A-105');
    const race = await Promise.all([0,1].map(n=>inject(app,{method:'POST',url:'/contracts',headers:headers(d.owner),body:{...body,slot_id:ids[2],slot_code:`RACE-${n}`}})));
    assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
    assert.equal((await d.pool.query('SELECT COUNT(*)::integer AS n FROM public.rental_contracts WHERE slot_id=$1',[ids[2]])).rows[0].n,1);
    const winner = race.find(r=>r.status===201).body.contract;
    const moved = await lifecycle.run(d.owner,winner.id,'move',{slot_id:ids[3],slot_code:'MOVE-105'});
    assert.equal(moved.slot_code,'MOVE-105');
    assert.equal((await d.pool.query('SELECT code FROM public.parking_slots WHERE id=$1',[ids[3]])).rows[0].code,'MOVE-105');
});

test('upgrade preserves existing slot IDs/codes/contracts and snapshots historical codes', options, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),'parking-old-schema-'));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    for (const filename of await fs.readdir(path.join(__dirname,'../migrations'))) {
        if (Number(filename.slice(0,3))<=12) await fs.copyFile(path.join(__dirname,'../migrations',filename),path.join(directory,filename));
    }
    const d = await database(t,{directory});
    // Insert through the old schema before the additive upgrade.
    const old = (await d.pool.query(`INSERT INTO public.rental_contracts
        (owner_id,parking_id,customer_id,slot_id,rental_type,starts_at,ends_at,timezone,billing_anchor_at)
        VALUES ($1,$2,$3,$4,'custom','2020-01-01','2020-01-02','UTC','2020-01-01') RETURNING id`,[d.owner,d.parking,d.customer,d.slots[0]])).rows[0];
    await runMigrations(d.pool,'up',{log(){}});
    await d.pool.query('UPDATE public.parking_slots SET code=$1 WHERE id=$2',['NEW-CODE',d.slots[0]]);
    assert.equal((await rentals.details(d.pool,d.owner,old.id)).slot_code,'A-1');
    assert.equal((await d.pool.query('SELECT COUNT(*)::integer AS n FROM public.parking_slots WHERE floor_id=$1',[d.floor])).rows[0].n,6);
});
