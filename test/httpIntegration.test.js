const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const app = require('../app');
const pool = require('../Database/db');
const reports = require('../Service/parkingReports');
const { inject } = require('./helpers/http');
const { HttpError } = require('../Utils/httpErrors');
test.after(() => pool.end());
const secret = 'in-memory-http-test-secret-at-least-32-bytes';
test.beforeEach(t => {
    const previous = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = secret;
    t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
    t.mock.method(pool, 'query', () => assert.fail('Unexpected database query'));
    t.mock.method(pool, 'connect', () => assert.fail('Unexpected database connection'));
});
function headers(payload = { sub: '7' }) {
    return { authorization: `Bearer ${jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '1m' })}` };
}
test('Express returns JSON for unknown routes and disables framework identification', async () => {
    const result = await inject(app, { url: '/unknown' });
    assert.equal(result.status, 404); assert.deepEqual(result.body, { message: 'Route not found' });
    assert.equal(result.headers['x-powered-by'], undefined);
});
test('every new resource router rejects missing tokens through the complete Express stack', async () => {
    for (const [method, url, body] of [['GET','/customers'],['POST','/customers',{}],['GET','/contracts'],
        ['POST','/contracts',{}],['POST','/contracts/1/move',{}],['GET','/dashboard'],
        ['GET','/parkings/1/slots/availability'],['DELETE','/parkings/1/floors/1/slots/1']]) {
        const result = await inject(app, { method, url, body }); assert.equal(result.status,401,`${method} ${url}`);
    }
});
test('valid signatures with malformed subjects are rejected before queries', async () => {
    for (const payload of [{}, {sub:'0'}, {sub:'2147483648'}, {sub:'1 OR 1=1'}]) {
        const result = await inject(app, {url:'/customers',headers:headers(payload)});assert.equal(result.status,401);
    }
    const expired=jwt.sign({sub:'7'},secret,{algorithm:'HS256',expiresIn:-1});
    assert.equal((await inject(app,{url:'/customers',headers:{authorization:`Bearer ${expired}`}})).status,401);
});
test('JSON parsing and immutable customer ownership are enforced through HTTP', async t => {
    let values;
    t.mock.method(pool,'query',async(sql,args)=>{values=args;return {rows:[{id:1,name:'Alice',customer_code:'C1'}]};});
    const created=await inject(app,{method:'POST',url:'/customers',headers:headers(),body:{name:'Alice',customer_code:'C1'}});
    assert.equal(created.status,201);assert.deepEqual(values,['7','Alice','C1',null]);
    const forged=await inject(app,{method:'POST',url:'/customers',headers:headers(),body:{name:'Alice',customer_code:'C1',owner_id:99}});
    assert.equal(forged.status,400);
});
test('malformed JSON and oversized bodies return controlled JSON errors',async()=>{
    const malformed=await inject(app,{method:'POST',url:'/customers',headers:headers(),rawBody:'{'});
    assert.equal(malformed.status,400);assert.match(malformed.body.message,/Invalid JSON/);
    const large=await inject(app,{method:'POST',url:'/customers',headers:headers(),body:{name:'x'.repeat(110000)}});
    assert.equal(large.status,413);
});
test('contract detail access scopes the verified owner regardless of query owner fields',async t=>{
    t.mock.method(pool,'query',async(sql,args)=>{assert.match(sql,/owner_id = \$2/);assert.deepEqual(args,[1,'7']);return {rows:[]};});
    const result=await inject(app,{url:'/contracts/1?owner_id=99',headers:headers()});
    assert.equal(result.status,404);assert.equal(result.body.message,'Rental contract not found');
});
test('scoped dashboard passes only verified ownership and controlled parameters',async t=>{
    t.mock.method(reports,'dashboard',async(owner,parking,days)=>{
        assert.deepEqual([owner,parking,days],['7',12,7]);throw new HttpError(404,'Parking lot not found');
    });
    const result=await inject(app,{url:'/parkings/12/statistics?owner_id=99',headers:headers()});assert.equal(result.status,404);
});
test('single parking detail scopes owner and exposes the configured default timezone',async t=>{
    t.mock.method(pool,'query',async(sql,args)=>{
        assert.match(sql,/owner_id = \$2 AND archived_at IS NULL/);assert.deepEqual(args,[12,'7']);
        return {rows:[{id:12,name:'Main',timezone:'Asia/Tehran',created_at:null}]};
    });
    const result=await inject(app,{url:'/parkings/12?owner_id=99',headers:headers()});
    assert.equal(result.status,200);assert.equal(result.body.timezone,'Asia/Tehran');
});
test('expiring contract listing keeps filtering inside the verified owner scope',async t=>{
    t.mock.method(pool,'query',async(sql,args)=>{
        assert.match(sql,/owner_id = \$1/);assert.match(sql,/ends_at > NOW\(\)/);
        assert.deepEqual(args,['7',null,null,'active',100,0,7]);return {rows:[]};
    });
    const result=await inject(app,{url:'/contracts?status=active&expiring_days=7&owner_id=99',headers:headers()});
    assert.equal(result.status,200);assert.deepEqual(result.body,[]);
});
test('contract input errors are handled as HTTP 400 before any database work',async()=>{
    const result=await inject(app,{method:'POST',url:'/contracts',headers:headers(),body:{
        customer_id:1,slot_id:1,rental_type:'custom',starts_at:'2030-02-30T10:00:00Z',ends_at:'2030-03-01T10:00:00Z'
    }});assert.equal(result.status,400);
});
