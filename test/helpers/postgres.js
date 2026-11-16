const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { runMigrations } = require('../../Database/migrationRunner');

async function database(t, { directory } = {}) {
    const url = new URL(process.env.PARKING_TEST_DATABASE_URL);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only local integration databases are allowed');
    assert.equal(url.search, '', 'Query parameters may not override the generated database target');
    const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 3000 });
    const name = `parking_rental_test_${randomUUID().replaceAll('-', '')}`;
    let created = false; let pool;
    t.after(async () => {
        try {
            if (pool) await pool.end();
            if (created) await admin.query(`DROP DATABASE "${name}"`);
        } finally { await admin.end(); }
    });
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 3000 });
    await runMigrations(pool, 'up', { directory, log() {} });
    const application = require('../../Database/db');
    t.mock.method(application, 'connect', () => pool.connect());
    t.mock.method(application, 'query', (sql, values) => pool.query(sql, values));
    t.mock.method(console, 'error', () => {});
    const owners = (await pool.query(`INSERT INTO public.users (username,phone_number,password_hash)
        VALUES ('owner_a','test-a','not-a-real-hash'),('owner_b','test-b','not-a-real-hash') RETURNING id`)).rows;
    const lots = (await pool.query(`INSERT INTO public.parkings (owner_id,name,location)
        VALUES ($1,'Lot A','A'),($2,'Lot B','B') RETURNING id`, [owners[0].id,owners[1].id])).rows;
    const floors = (await pool.query(`INSERT INTO public.parking_floors (parking_id,floor_number)
        VALUES ($1,0),($2,0) RETURNING id`,[lots[0].id,lots[1].id])).rows;
    const customers = (await pool.query(`INSERT INTO public.customers (owner_id,name,customer_code)
        VALUES ($1,'Alice','C1'),($2,'Bob','C1') RETURNING id`,[owners[0].id,owners[1].id])).rows;
    const slots=[];
    for(let n=1;n<=6;n++) slots.push((await pool.query(`INSERT INTO public.parking_slots (parking_id,floor_id,code)
        VALUES ($1,$2,$3) RETURNING id`,[lots[0].id,floors[0].id,`A-${n}`])).rows[0].id);
    const foreignSlot=(await pool.query(`INSERT INTO public.parking_slots (parking_id,floor_id,code)
        VALUES ($1,$2,'B-1') RETURNING id`,[lots[1].id,floors[1].id])).rows[0].id;
    return { pool, owner:owners[0].id, foreignOwner:owners[1].id, parking:lots[0].id, foreignParking:lots[1].id,
        floor:floors[0].id,foreignFloor:floors[1].id,customer:customers[0].id,foreignCustomer:customers[1].id,slots,foreignSlot };
}
module.exports={database};
