// Disposable loopback-only backend for the shared app's real HTTP/database UI test.
const { Pool } = require('pg');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const { runMigrations } = require('../Database/migrationRunner');

async function start() {
    const url = new URL(process.env.PARKING_TEST_DATABASE_URL);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.search) {
        throw new Error('Only a local PostgreSQL maintenance database without query overrides is allowed');
    }
    const name = `parking_ui_test_${randomUUID().replaceAll('-','')}`;
    const admin = new Pool({ connectionString: url.href });
    await admin.query(`CREATE DATABASE "${name}"`);
    Object.assign(process.env, { DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: name,
        DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
        JWT_ACCESS_SECRET: randomBytes(48).toString('hex') });
    const pool = require('../Database/db');
    let server;
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        if (server) await new Promise(resolve=>server.close(resolve));
        await pool.end();
        await admin.query(`DROP DATABASE "${name}"`);
        await admin.end();
    };
    process.on('SIGTERM',()=>close().then(()=>process.exit(0)).catch(()=>process.exit(1)));
    process.on('SIGINT',()=>close().then(()=>process.exit(0)).catch(()=>process.exit(1)));
    try {
        await runMigrations(pool,'up',{log(){}});
        server = require('../app').listen(0,'127.0.0.1',async()=>{
            const baseUrl = `http://127.0.0.1:${server.address().port}`;
            if (process.env.PARKING_UI_TEST_SERVER_FILE) await fs.writeFile(process.env.PARKING_UI_TEST_SERVER_FILE,JSON.stringify({baseUrl,pid:process.pid}));
            console.log(`Disposable UI test API ready at ${baseUrl}`);
        });
    } catch(error) { await close(); throw error; }
}
start().catch(error=>{console.error(error.message);process.exitCode=1;});
