# Deployment plan — approval still required

No Ubuntu server, PM2 process, Nginx configuration, production database, backup,
or remote Git branch was changed during this work. This document prepares the
release; it does not authorize deploying it.

## Local acceptance before deployment

Use Node.js 22+ and PostgreSQL 14+. Preserve the existing .env, users table,
password hashes, JWT secret, refresh token hashes, and migration history.

```sh
npm run check
npm test
npm run db:preflight -- --allow-pending
npm run db:migrate
npm run db:preflight
```

Then set PARKING_TEST_DATABASE_URL to a **local maintenance database** with a
role that can create databases and install trusted btree_gist, and run:

```sh
npm run test:integration
```

The integration suites create/drop isolated databases with random parking test
names, never the database in the connection URL. They reject remote hosts and
URL query parameters that could override the generated database name. Do not
point them at a remote or production service. The dedicated command exits with
failure if configuration is absent, so acceptance cannot silently skip tests.

## Migration compatibility

Review migrations 010–014 for this final batch:

- 010: adds customers; no existing account data changes.
- 011: installs trusted btree_gist if missing; adds the lot timezone default
  Asia/Tehran and a combined unique key; creates contracts, events, and a read
  view. Requires database CREATE permission or prior extension installation.
- 012: adds the active-contract reporting index.
- 013: adds nullable user `name` and `family_name` columns. Apply before starting
  the updated signup/login code; existing credentials and sessions are preserved.
- 014: creates and backfills one profile per user, with a trigger keeping signup
  and account updates synchronized. Apply before exposing GET/PATCH `/profile`.

001–009 remain unchanged. A server without schema_migrations needs verified
baseline adoption before new migrations; never rerun original scripts blindly.
Ambiguous ownership in migration 005 stops rather than assigning arbitrary users.
The runner verifies checksums and order, permits one writer, uses a transaction
per migration, and stops lock waits after five seconds. Earlier successful
migrations remain applied if a later one fails. Keep the API stopped until the
entire approved batch succeeds.

All added business timestamps use TIMESTAMPTZ. Existing users.created_at is an
unmodified TIMESTAMP without timezone. Do not reinterpret old values or change
the database timezone without first establishing their original timezone.
Calendar contracts store their chosen timezone and billing anchor separately.

## Environment and security review

PORT now controls the listener (default 3002). NODE_ENV should be production on
the server. Existing DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, and
JWT_ACCESS_SECRET are required. The JWT secret must be at least 32 bytes; do not
rotate it during this upgrade unless intentionally invalidating access tokens.
.env.example contains no secrets. Keep actual .env outside Git and restrict its
permissions. Do not log or paste credentials into deployment notes.

Authentication still uses HS256 access tokens and hashed rotating refresh tokens.
JWT subjects are checked as positive integer user IDs. Business endpoints scope
queries to the verified owner; combined foreign keys also prevent cross-owner
contracts. Queries are parameterized. JSON bodies are bounded at 100 KB, and
malformed/oversized input has JSON errors. There is no generic SQL endpoint or
business hard-delete endpoint. No extra framework or ORM was introduced.

Check current production dependency advisories before approval:

```sh
npm audit --omit=dev --audit-level=high
```

Ensure the existing HTTPS proxy, firewall, trusted-proxy policy, request limits,
and server access remain appropriate. This release does not change Nginx or
introduce an unreviewed proxy-trust configuration.

## Approved server rollout, only after acceptance

1. Record the current Git commit, clean-tree status, PM2 process name/config,
   Node/PostgreSQL versions, database target, and existing environment locations.
2. Stop writes through the existing approved maintenance procedure. Use the
   server's actual PM2 process name; do not guess it.
3. Make a full database backup including users, refresh tokens, schemas, and
   migration history. Use protected credential handling, not a password in a URL
   on a process command line. Example with the existing database settings:

   ```sh
   pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Fc -f "$BACKUP_FILE"
   pg_restore --list "$BACKUP_FILE"
   ```

   Confirm exit codes, file size, permissions, free disk space, and restore into
   a separate disposable database. A backup filename alone is not verification.
4. Check out the reviewed release commit with Git, preserve environment files,
   and install locked dependencies with `npm ci --omit=dev`.
5. Run the read-only preflight with --allow-pending, then the approved migration
   batch, then preflight without that flag. On any failure, keep maintenance in
   place and investigate. Do not delete tables or mark failed migrations applied.
6. Restart the existing PM2 process with the reviewed environment. Verify login,
   refresh, owner isolation, customers, booking conflicts, early end, renewal,
   slot move, archive guards, availability, and dashboard values through HTTPS.
7. Review PM2/application/Nginx logs, check database activity and errors, then
   reopen writes and monitor. Push/tag a release only when explicitly authorized.

## Recovery

Prefer a reviewed forward fix. Reverting application code alone may be unsafe
after new contracts exist: older code lacks rental-aware archive guards.
Do not run destructive down-migrations. Restoring the full backup is a separate
approved recovery action after stopping writes, with an explicit decision about
data entered since backup. Keep accounts and authentication records intact.

## Verification limits in the implementation environment

Local PostgreSQL connections were blocked with EPERM, and starting an isolated
PostgreSQL instance was blocked by shared-memory permissions. Unit tests and
in-memory full Express HTTP tests ran; the real PostgreSQL suites were written
but could not run here. Real migrations, exclusion constraints, timezone/DST
arithmetic, and database integration require local acceptance above. No backup
or deployment was performed or claimed.

The dependency audit could not reach registry.npmjs.org (ENOTFOUND). Run the
audit command above when network access is available; dependency security
acceptance is still pending.
