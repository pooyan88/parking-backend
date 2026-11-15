// Immutable adapters for the four original, self-running scripts. Never require
// those scripts: they open their own connection and some hide SQL failures.
const legacyMigrations = [
    {
        filename: '001_create_parkings.js',
        checksum: 'b26c7649ffe8532bc98bec57a4cd717411c2c305870d9709f8ab11dcfb81c4bc',
        sql: `CREATE TABLE public.parkings (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255)
        )`
    },
    {
        filename: '002_add_location.js',
        checksum: '5f97bca759833772d1362f7bfa019518ad8c55ac7520ffb303ef3c28cc0cccb3',
        sql: 'ALTER TABLE public.parkings ADD COLUMN location VARCHAR(255)'
    },
    {
        filename: '003_create_users.js',
        checksum: 'e0cb8c6b04d2ca6a7f41dbcffc7e81f4a3014a1a7e868f60a85d782974d9b28d',
        sql: `CREATE TABLE public.users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            phone_number VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )`
    },
    {
        filename: '004_create_refresh_tokens.js',
        checksum: '03659585ad3ef6b136fd76fc2275678c3a15b717213ce9721db633388018193b',
        sql: `CREATE TABLE public.refresh_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ DEFAULT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
    }
];

// [PostgreSQL type, NOT NULL, expected default]. Extra columns are rejected so
// an unknown schema is never silently recorded as the original baseline.
const baselineColumns = {
    parkings: {
        id: ['integer', true, 'sequence'],
        name: ['character varying(255)', false, null],
        location: ['character varying(255)', false, null]
    },
    users: {
        id: ['integer', true, 'sequence'],
        username: ['character varying(255)', true, null],
        phone_number: ['character varying(255)', true, null],
        password_hash: ['text', true, null],
        created_at: ['timestamp without time zone', false, 'now()']
    },
    refresh_tokens: {
        id: ['integer', true, 'sequence'],
        user_id: ['integer', true, null],
        token_hash: ['text', true, null],
        expires_at: ['timestamp with time zone', true, null],
        revoked_at: ['timestamp with time zone', false, null],
        created_at: ['timestamp with time zone', true, 'now()']
    }
};

async function verifyBaseline(client) {
    const tableNames = Object.keys(baselineColumns);
    const tables = await client.query(`
        SELECT c.relname AS table_name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])`, [tableNames]);
    for (const table of tableNames) {
        if (!tables.rows.some(row => row.table_name === table)) {
            throw new Error(`Baseline mismatch: public.${table} is missing or is not an ordinary table.`);
        }
    }

    // Keep the schema stable between verification and recording the baseline.
    await client.query('LOCK TABLE public.parkings, public.users, public.refresh_tokens IN SHARE MODE');
    const columns = await client.query(`
        SELECT c.relname AS table_name, a.attname AS column_name,
               pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
               a.attnotnull AS not_null,
               pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
               pg_catalog.pg_get_serial_sequence(
                   pg_catalog.format('%I.%I', n.nspname, c.relname), a.attname
               ) AS owned_sequence
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
          AND a.attnum > 0 AND NOT a.attisdropped`, [tableNames]);

    for (const [table, expectedColumns] of Object.entries(baselineColumns)) {
        const actual = columns.rows.filter(row => row.table_name === table);
        if (actual.length !== Object.keys(expectedColumns).length) {
            throw new Error(`Baseline mismatch: public.${table} has unexpected or missing columns.`);
        }
        for (const [name, [type, notNull, expectedDefault]] of Object.entries(expectedColumns)) {
            const column = actual.find(row => row.column_name === name);
            const actualDefault = column?.default_value ?? null;
            const defaultMatches = expectedDefault === 'sequence'
                ? /^nextval\(/.test(actualDefault || '') && Boolean(column?.owned_sequence)
                : expectedDefault === null
                    ? actualDefault === null || /^NULL::/.test(actualDefault)
                    : actualDefault === expectedDefault;
            if (!column || column.data_type !== type || column.not_null !== notNull || !defaultMatches) {
                throw new Error(`Baseline mismatch: public.${table}.${name} has a different type, null rule, or default.`);
            }
        }
    }

    const constraints = await client.query(`
        SELECT c.relname AS table_name, con.contype AS type,
               ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(num, pos)
                     JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num
                     ORDER BY k.pos) AS columns,
               rn.nspname AS referenced_schema, rc.relname AS referenced_table,
               ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(num, pos)
                     JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num
                     ORDER BY k.pos) AS referenced_columns,
               con.confdeltype AS delete_action, con.convalidated AS validated,
               con.condeferrable AS deferrable
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
        LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
          AND con.contype IN ('p', 'u', 'f')`, [tableNames]);

    const required = [
        ['parkings', 'p', 'id'], ['users', 'p', 'id'], ['refresh_tokens', 'p', 'id'],
        ['users', 'u', 'username'], ['users', 'u', 'phone_number'],
        ['refresh_tokens', 'u', 'token_hash'], ['refresh_tokens', 'f', 'user_id']
    ];
    for (const [table, type, column] of required) {
        const found = constraints.rows.some(row =>
            row.table_name === table && row.type === type &&
            row.columns.length === 1 && row.columns[0] === column &&
            row.validated && !row.deferrable &&
            (type !== 'f' || (row.referenced_schema === 'public' && row.referenced_table === 'users' &&
                row.referenced_columns.length === 1 && row.referenced_columns[0] === 'id' && row.delete_action === 'c'))
        );
        if (!found) throw new Error(`Baseline mismatch: required ${type} constraint on ${table}.${column} is missing or different.`);
    }
}

module.exports = { legacyMigrations, verifyBaseline };
