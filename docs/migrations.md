# Database migrations

A migration is a numbered database change. `schema_migrations` records changes
that have already run, so the runner does not run them again.

## Current local database: one-time baseline

Check that `.env` points to your **local** database. These commands use the
existing `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` settings.
Do not run them against the Ubuntu server before deployment approval.

```sh
npm run db:status
npm run db:baseline
npm run db:migrate
```

`db:status` only reads migration history. It does not verify the whole schema.

`db:baseline` verifies the existing `parkings`, `users`, and `refresh_tokens`
tables against migrations 001–004: columns, types, null rules, defaults, owned
ID sequences, primary keys, unique constraints, and the refresh-token foreign
key including cascading deletion. It then records those four files in one
transaction. It does not insert, update, or delete business rows.

If verification fails, the command stops without recording a baseline. Review
the difference before changing anything. Do not remove tables or user data to
make the check pass. Verification checks the required original constraints;
it is not a general schema-diff tool or proof of the historical execution date.

`recorded_at` means the time we recorded a migration. For a baseline, the
original execution time is unknown. Repeating `db:baseline` is a no-op once the
baseline is recorded; it does not repeat schema verification after later changes.

## Empty development database

Create the database and configure `.env`, then run `npm run db:migrate`.
The runner creates the history table and applies 001–004 using fixed SQL
adapters matching the original scripts. The original JavaScript scripts are
never executed or imported. An existing database without history is rejected
by `db:migrate`; use the verified baseline instead.

## Future features

Add a SQL file such as `migrations/005_add_parking_ownership.sql`. Use consecutive
three-digit numbers and lowercase names with underscores. No new package or
ORM is needed. Do not create that example file until the ownership feature starts.

- Never edit or rename a recorded migration. Add a new one instead.
- Run migrations through `npm run db:migrate`, not the original scripts.
- Each file and its history record use one transaction and one connection.
- Do not put `BEGIN`, `COMMIT`, `ROLLBACK`, connection commands, or other
  transaction-control statements in migration files. The runner owns transactions.
- Use transaction-compatible SQL; for example, `CREATE INDEX CONCURRENTLY`
  cannot run through this runner.
- One migration command can write at a time. Other writers fail with a clear
  message. Database lock waits stop after five seconds.
- A failed file rolls back and exits with failure. Earlier completed files stay
  applied. Fix the pending file and rerun; completed files are skipped.
- SHA-256 checksums detect changed recorded files. Original scripts 001–004
  also have fixed checksums, checked before database access.
- There is no automatic rollback command. Plan a reviewed forward migration
  when an applied change needs correction.

## Verification

`npm test` runs the runner safety tests using Node's built-in test runner.
These tests do not connect to the configured application database.
Real PostgreSQL verification is still required before deployment.
