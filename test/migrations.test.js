const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadMigrations, validateHistory, runMigrations } = require('../Database/migrationRunner');
const { verifyBaseline } = require('../Database/migrationBaseline');

const sourceDirectory = path.join(__dirname, '..', 'migrations');

async function copyMigrations(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'parking-migrations-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const filename of await fs.readdir(sourceDirectory)) {
        await fs.copyFile(path.join(sourceDirectory, filename), path.join(directory, filename));
    }
    return directory;
}

function schemaFixture() {
    const columns = [];
    function add(table, name, type, notNull, defaultValue = null) {
        columns.push({ table_name: table, column_name: name, data_type: type,
            not_null: notNull, default_value: defaultValue,
            owned_sequence: name === 'id' ? `public.${table}_id_seq` : null });
    }
    for (const table of ['parkings', 'users', 'refresh_tokens']) {
        add(table, 'id', 'integer', true, `nextval('${table}_id_seq'::regclass)`);
    }
    add('parkings', 'name', 'character varying(255)', false);
    add('parkings', 'location', 'character varying(255)', false);
    add('users', 'username', 'character varying(255)', true);
    add('users', 'phone_number', 'character varying(255)', true);
    add('users', 'password_hash', 'text', true);
    add('users', 'created_at', 'timestamp without time zone', false, 'now()');
    add('refresh_tokens', 'user_id', 'integer', true);
    add('refresh_tokens', 'token_hash', 'text', true);
    add('refresh_tokens', 'expires_at', 'timestamp with time zone', true);
    add('refresh_tokens', 'revoked_at', 'timestamp with time zone', false);
    add('refresh_tokens', 'created_at', 'timestamp with time zone', true, 'now()');
    const constraints = [
        ['parkings', 'p', 'id'], ['users', 'p', 'id'], ['refresh_tokens', 'p', 'id'],
        ['users', 'u', 'username'], ['users', 'u', 'phone_number'],
        ['refresh_tokens', 'u', 'token_hash'], ['refresh_tokens', 'f', 'user_id']
    ].map(([table, type, column]) => ({ table_name: table, type, columns: [column],
        validated: true, deferrable: false, referenced_schema: 'public',
        referenced_table: 'users', referenced_columns: ['id'], delete_action: 'c' }));
    return { tables: ['parkings', 'users', 'refresh_tokens'], columns, constraints };
}

// A connection double for transaction/error paths. This does not execute SQL;
// PostgreSQL catalog queries and DDL still need a real database integration run.
function database({ existing = false, history = null, schema = schemaFixture(), failSql, locked = true } = {}) {
    const calls = [];
    let records = history === null ? null : structuredClone(history);
    let snapshot;
    let released = false;
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            if (failSql && failSql(sql)) throw new Error('simulated database failure');
            if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
            if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
            if (sql.includes("to_regclass('public.schema_migrations')")) return { rows: [{ exists: records !== null }] };
            if (sql.includes('FROM public.schema_migrations ORDER BY')) return { rows: structuredClone(records) };
            if (sql.includes('FROM pg_catalog.pg_tables')) return { rows: existing ? [{ tablename: 'parkings' }] : [] };
            if (sql.includes('c.relkind =')) return { rows: schema.tables.map(table_name => ({ table_name })) };
            if (sql.includes('FROM pg_catalog.pg_attribute a')) return { rows: schema.columns };
            if (sql.includes('FROM pg_catalog.pg_constraint con')) return { rows: schema.constraints };
            if (sql === 'BEGIN') snapshot = structuredClone(records);
            if (sql === 'ROLLBACK') records = snapshot;
            if (sql.startsWith('CREATE TABLE public.schema_migrations')) records = [];
            if (sql.includes('INSERT INTO public.schema_migrations')) {
                const [version, filename, checksum, source] = values;
                records.push({ version, filename, checksum, source });
            }
            return { rows: [] };
        },
        release() { released = true; }
    };
    return { client, calls, connect: async () => client,
        get history() { return records; }, get released() { return released; } };
}

test('original files load without executing their self-running code', async () => {
    const migrations = await loadMigrations();
    assert.deepEqual(migrations.map(row => row.version), [1, 2, 3, 4]);
    assert.match(migrations[2].sql, /CREATE TABLE public\.users/);
});

test('changed original migration is rejected before connecting', async t => {
    const directory = await copyMigrations(t);
    await fs.appendFile(path.join(directory, '001_create_parkings.js'), '\n// changed');
    const pool = { connect() { assert.fail('must not connect'); } };
    await assert.rejects(runMigrations(pool, 'up', { directory }), /Original migration changed/);
});

test('missing original, duplicate number, gap, and new JS migrations are rejected', async t => {
    for (const filename of ['004_extra.sql', '006_gap.sql', '005_unsupported.js']) {
        const directory = await copyMigrations(t);
        await fs.writeFile(path.join(directory, filename), 'SELECT 1;');
        await assert.rejects(loadMigrations(directory), /Invalid migration order|must be SQL/);
    }
    const directory = await copyMigrations(t);
    await fs.unlink(path.join(directory, '004_create_refresh_tokens.js'));
    await assert.rejects(loadMigrations(directory), /001–004 are required/);
});

test('history rejects changed checksums, missing files, and gaps', async () => {
    const migrations = await loadMigrations();
    const history = migrations.map(row => ({ ...row, source: 'baseline' }));
    validateHistory(migrations, history);
    assert.throws(() => validateHistory(migrations, [{ ...history[0], checksum: '0'.repeat(64) }]), /Applied migration changed/);
    assert.throws(() => validateHistory(migrations, history.slice(1)), /history differs/);
    assert.throws(() => validateHistory(migrations.slice(0, 3), history), /history differs/);
});

test('status is read-only even when no history exists', async () => {
    const pool = database({ existing: true });
    const output = [];
    await runMigrations(pool, 'status', { log: line => output.push(line) });
    assert.equal(pool.history, null);
    assert.ok(output.some(line => line.includes('db:baseline')));
    assert.ok(output.some(line => line.includes('004_create_refresh_tokens.js: pending')));
    assert.ok(pool.calls.every(({ sql }) => /^\s*SELECT/.test(sql)));
    assert.ok(pool.released);
});

test('up refuses an existing database without making any changes', async () => {
    const pool = database({ existing: true });
    await assert.rejects(runMigrations(pool, 'up'), /db:baseline first/);
    assert.equal(pool.history, null);
    assert.ok(!pool.calls.some(({ sql }) => /CREATE|INSERT|ALTER|DELETE/.test(sql)));
    assert.ok(pool.released);
});

test('baseline records all four files without running business DDL or touching business rows', async () => {
    const pool = database({ existing: true });
    await runMigrations(pool, 'baseline', { log() {} });
    assert.equal(pool.history.length, 4);
    assert.ok(pool.history.every(row => row.source === 'baseline'));
    assert.ok(!pool.calls.some(({ sql }) => /(?:CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM) public\.(?:users|parkings|refresh_tokens)\b/.test(sql)));
    assert.equal(pool.calls.filter(({ sql }) => sql === 'COMMIT').length, 1);
    assert.ok(pool.calls.at(-1).sql.includes('pg_advisory_unlock'));
});

test('baseline rejects missing tables before recording history', async () => {
    const schema = schemaFixture();
    schema.tables.pop();
    const pool = database({ existing: true, schema });
    await assert.rejects(runMigrations(pool, 'baseline'), /refresh_tokens is missing/);
    assert.equal(pool.history, null);
    assert.ok(pool.calls.some(({ sql }) => sql === 'ROLLBACK'));
});

test('baseline rejects wrong timestamp types, null rules, defaults, and unowned IDs', async () => {
    for (const mutation of [
        schema => { schema.columns.find(row => row.table_name === 'users' && row.column_name === 'created_at').data_type = 'timestamp with time zone'; },
        schema => { schema.columns.find(row => row.column_name === 'username').not_null = false; },
        schema => { schema.columns.find(row => row.column_name === 'username').default_value = "'guest'::character varying"; },
        schema => { schema.columns[0].owned_sequence = null; },
        schema => { schema.columns.push({ table_name: 'users', column_name: 'unexpected' }); }
    ]) {
        const schema = schemaFixture();
        mutation(schema);
        const pool = database({ existing: true, schema });
        await assert.rejects(runMigrations(pool, 'baseline'), /Baseline mismatch/);
        assert.equal(pool.history, null);
    }
});

test('baseline rejects missing uniqueness and changed refresh-token FK behavior', async () => {
    for (const mutation of [
        schema => { schema.constraints = schema.constraints.filter(row => row.columns[0] !== 'username'); },
        schema => { schema.constraints.at(-1).delete_action = 'a'; },
        schema => { schema.constraints.at(-1).referenced_schema = 'other'; },
        schema => { schema.constraints.at(-1).validated = false; }
    ]) {
        const schema = schemaFixture();
        mutation(schema);
        const pool = database({ schema });
        await assert.rejects(verifyBaseline(pool.client), /constraint.*missing or different/);
    }
});

test('a failed baseline history insert rolls back all baseline records', async () => {
    let inserts = 0;
    const pool = database({ existing: true, failSql: sql => sql.includes('INSERT INTO public.schema_migrations') && ++inserts === 3 });
    await assert.rejects(runMigrations(pool, 'baseline'), /simulated database failure/);
    assert.equal(pool.history, null);
    assert.ok(pool.calls.some(({ sql }) => sql === 'ROLLBACK'));
    assert.ok(pool.released);
});

test('empty database initializes all originals and a second run does nothing', async () => {
    const pool = database();
    await runMigrations(pool, 'up', { log() {} });
    assert.equal(pool.history.length, 4);
    assert.ok(pool.history.every(row => row.source === 'applied'));
    const before = pool.calls.length;
    await runMigrations(pool, 'up', { log() {} });
    assert.ok(!pool.calls.slice(before).some(({ sql }) => /CREATE|ALTER|INSERT/.test(sql)));
});

test('baseline can be repeated without executing legacy SQL', async () => {
    const history = (await loadMigrations()).map(row => ({ ...row, source: 'baseline' }));
    const pool = database({ existing: true, history });
    await runMigrations(pool, 'baseline', { log() {} });
    assert.equal(pool.history.length, 4);
    assert.ok(!pool.calls.some(({ sql }) => /CREATE|ALTER|INSERT/.test(sql)));
});

test('a failed pending migration rolls back and stops before the next file', async t => {
    const directory = await copyMigrations(t);
    await fs.writeFile(path.join(directory, '005_failure.sql'), 'CREATE TABLE public.failure_probe (id INTEGER);');
    await fs.writeFile(path.join(directory, '006_later.sql'), 'CREATE TABLE public.later_probe (id INTEGER);');
    const history = (await loadMigrations()).map(row => ({ ...row, source: 'baseline' }));
    const pool = database({ existing: true, history, failSql: sql => sql.includes('CREATE TABLE public.failure_probe') });
    await assert.rejects(runMigrations(pool, 'up', { directory }), /simulated database failure/);
    assert.equal(pool.history.length, 4);
    assert.ok(pool.calls.some(({ sql }) => sql === 'ROLLBACK'));
    assert.ok(!pool.calls.some(({ sql }) => sql.includes('later_probe')));
    assert.ok(pool.released);
});

test('a future SQL file and its history record commit together', async t => {
    const directory = await copyMigrations(t);
    await fs.writeFile(path.join(directory, '005_probe.sql'), 'CREATE TABLE public.probe (id INTEGER);');
    const history = (await loadMigrations()).map(row => ({ ...row, source: 'baseline' }));
    let failInsert = true;
    const pool = database({ existing: true, history, failSql: sql => failInsert && sql.includes('INSERT INTO public.schema_migrations') });
    await assert.rejects(runMigrations(pool, 'up', { directory }), /simulated database failure/);
    assert.equal(pool.history.length, 4);
    failInsert = false;
    await runMigrations(pool, 'up', { directory, log() {} });
    assert.equal(pool.history.length, 5);
    assert.equal(pool.history.at(-1).filename, '005_probe.sql');
    assert.equal(pool.history.at(-1).source, 'applied');
});

test('another migration writer fails without executing DDL and releases its connection', async () => {
    const pool = database({ locked: false });
    await assert.rejects(runMigrations(pool, 'up'), /Another migration command/);
    assert.equal(pool.calls.length, 1);
    assert.ok(pool.released);
});

test('invalid command is rejected before loading a connection', async () => {
    const pool = { connect() { assert.fail('must not connect'); } };
    await assert.rejects(runMigrations(pool, 'down'), /Usage/);
});
