const test = require('node:test');
const assert = require('node:assert/strict');
const reports = require('../Service/parkingReports');
const controller = require('../Controller/reportController');
const pool = require('../Database/db');
test.after(()=>pool.end());
test('dashboard uses one read-only snapshot and safely handles zero capacity',async t=>{
    const calls=[];
    const client={query:async(sql,args)=>{
        calls.push({sql,args});
        if(sql.startsWith('WITH lots'))return {rows:[{occupied_slots:0,usable_slots:0,total_slots:0}]};
        if(sql.startsWith('SELECT f.id'))return {rows:[{id:1,occupied_slots:0,usable_slots:0,total_slots:0}]};
        return {rows:[]};
    },release(){}};
    t.mock.method(pool,'connect',async()=>client);
    const result=await reports.dashboard('7',null,7);
    assert.equal(calls[1].sql,'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.deepEqual(calls.find(call=>call.sql.startsWith('WITH lots')).args,['7',null,7]);
    assert.equal(result.occupancy_percentage,0);assert.equal(result.floors[0].available_slots,0);
    assert.equal(calls.at(-1).sql,'COMMIT');
});
test('availability validates the full requested period before reaching reports',async t=>{
    t.mock.method(reports,'availability',()=>assert.fail('must not query'));
    const res={status(c){this.code=c;return this;},json(b){this.body=b;return this;}};
    await controller.availability({user:{id:'7'},params:{parkingId:'1'},query:{starts_at:'2030-01-01T10:00:00Z',ends_at:'2030-01-01T09:00:00Z'}},res);
    assert.equal(res.code,400);
});
test('dashboard rejects invalid scope and expiry windows',async t=>{
    t.mock.method(reports,'dashboard',()=>assert.fail('must not query'));
    for(const query of [{parking_id:'bad'},{expiring_days:0},{expiring_days:366}]){
        const res={status(c){this.code=c;return this;},json(){return this;}};
        await controller.dashboard({user:{id:'7'},query},res);assert.equal(res.code,400);
    }
});
