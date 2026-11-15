const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../Database/db');
const controller = require('../Controller/customerController');
test.after(() => pool.end());
function res() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
test('customer creation derives ownership and accepts an optional shared phone', async t => {
    let parameters;
    t.mock.method(pool, 'query', async (sql, values) => { parameters = values; return { rows: [{ id: 1 }] }; });
    const response = res();
    await controller.create({user:{id:'7'},body:{name:' Alice ',customer_code:' C-1 ',phone_number:'+98 123'}},response);
    assert.equal(response.statusCode,201); assert.deepEqual(parameters,['7','Alice','C-1','+98 123']);
});
test('customer identity injection and invalid input never query the database', async t => {
    t.mock.method(pool,'query',()=>assert.fail('must not query'));
    for(const body of [{name:'Alice',customer_code:'C',owner_id:99},{name:' ',customer_code:'C'},{name:'Alice',customer_code:'C',phone_number:42}]) {
        const response=res(); await controller.create({user:{id:'7'},body},response); assert.equal(response.statusCode,400);
    }
});
test('foreign or missing customer returns 404 with an owner-scoped query', async t => {
    t.mock.method(pool,'query',async(sql,values)=>{assert.match(sql,/owner_id = \$2/);assert.deepEqual(values,[1,'7']);return {rows:[]};});
    const response=res();await controller.get({user:{id:'7'},params:{id:'1'}},response);assert.equal(response.statusCode,404);
});
test('nullable phone update distinguishes clearing from omission', async t => {
    t.mock.method(pool,'query',async(sql,values)=>{assert.match(sql,/CASE WHEN \$3::boolean/);assert.deepEqual(values,[null,null,true,null,1,'7']);return {rows:[{id:1}]};});
    const response=res();await controller.update({user:{id:'7'},params:{id:'1'},body:{phone_number:null}},response);assert.equal(response.statusCode,200);
});
