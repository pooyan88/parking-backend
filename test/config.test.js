const test=require('node:test');
const assert=require('node:assert/strict');
const {validateEnvironment}=require('../Utils/config');
const input=require('../Utils/input');
const {timezone}=require('../Utils/rentalValidation');
const env={DB_HOST:'localhost',DB_PORT:'5432',DB_NAME:'test',DB_USER:'test',DB_PASSWORD:'test',JWT_ACCESS_SECRET:'x'.repeat(32)};
test('startup validates settings without returning or exposing secret values',()=>{
    assert.deepEqual(validateEnvironment(env),{port:3002});
    assert.throws(()=>validateEnvironment({...env,JWT_ACCESS_SECRET:'short'}),/32 bytes/);
    assert.throws(()=>validateEnvironment({...env,PORT:'1e3'}),/PORT/);
    assert.throws(()=>validateEnvironment({...env,DB_PORT:'0'}),/DB_PORT/);
    assert.throws(()=>validateEnvironment({...env,DB_PASSWORD:''}),/DB_PASSWORD/);
});
test('IDs and pagination reject arrays and coerced query objects',()=>{
    for(const value of [[1],{},null,true])assert.throws(()=>input.id(value),e=>e.status===400);
    for(const query of [{limit:['10']},{offset:{}},{offset:'1e2'},{limit:'201'}])assert.throws(()=>input.page(query),e=>e.status===400);
    assert.deepEqual(input.page({limit:'10',offset:'20'}),[10,20]);
});
test('calendar zones reject numeric offsets with ambiguous PostgreSQL sign semantics',()=>{
    for(const value of ['+03:30','-03:00','unknown'])assert.throws(()=>timezone(value),e=>e.status===400);
    assert.equal(timezone('Asia/Tehran'),'Asia/Tehran');assert.equal(timezone('UTC'),'UTC');
});
