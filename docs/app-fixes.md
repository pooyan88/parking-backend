# Profile, uncoded slots and atomic rental assignment

These changes are prepared on `feature/complete-app-views`; pushing the branch does not apply database migrations or deploy the service.

## API additions

- Login now includes `user.phone_number` and `user.created_at`, queried from the registered user row. No names or password hashes are returned.
- Protected `GET /auth/me` returns `{ user: { id, username, phone_number, created_at } }` for the verified token owner. A client-supplied user ID cannot select another account.
- Protected `POST /parkings/:parkingId/floors/:floorId/slots/batch` accepts exactly `{ "count": 5 }`. Count must be an integer from 1 through 1000. The parent parking and floor are owner-checked and locked; a single transaction creates exactly that many usable slots with distinct internal IDs and `code: null`. The response is `{ message, slots: [...] }` with the existing slot shape. No codes are generated. The original single coded-slot API remains compatible for older clients.
- Contract creation accepts `slot_code`. It is required for an uncoded slot and may be omitted by legacy clients for an already coded slot. Codes are trimmed non-empty strings of at most 255 Unicode characters, without null characters. The chosen slot, customer and parking ownership are checked, and code assignment, agreement creation and its event commit in one transaction. Code uniqueness or booking conflicts return 409 and roll back all changes.
- Contract moves also accept `slot_code` so a new uncoded slot is a usable destination. Renaming an already booked slot remains prohibited. Existing move/renewal terms and the database period-exclusion constraint are retained.

## Database compatibility

Migration `013_uncoded_slots_and_assignment_history.sql` removes the slot code's NOT NULL requirement and adds/backfills a contract `assigned_code` snapshot. It retains slot IDs, existing codes, customers, contracts, counts, uniqueness, foreign keys and overlap constraints. Existing view columns retain their order and response shape. Historical contract codes no longer follow later slot renames. No rows or tables are deleted.

Deploy this backend and apply migration 013 with the existing migration runner before releasing the corresponding client. No production migration was run as part of implementation; migrations were exercised only in generated local test databases.

## Verification

`npm test` with `PARKING_TEST_DATABASE_URL` pointing to a disposable local PostgreSQL maintenance database runs all unit and database integration cases. The helper rejects remote hosts and creates/removes only generated test databases. Tests cover registration/login/profile phone mapping, ownership, 10 existing slots plus 5 uncoded slots, counts, invalid batches, availability, contract assignment, conflict rollback, concurrent booking, code assignment on move, historical-code preservation and an upgrade from the previous schema.

For the shared client's optional real HTTP/UI test, run `scripts/ui-test-server.js` with `PARKING_TEST_DATABASE_URL` and `PARKING_UI_TEST_SERVER_FILE` set. It creates a separate temporary database, applies migrations, generates an in-memory test signing secret, and listens only on `127.0.0.1` at an ephemeral port. Supply the emitted URL as `PARKING_UI_TEST_BASE_URL` to the client's Gradle tests. SIGINT/SIGTERM closes the server and removes its database. It never uses a deployed API or a production database.

The older ownership integration test fixtures now route transaction connections to their temporary database and accept both PostgreSQL foreign-key/restrict SQLSTATE variants for restricted deletes. These corrections change test infrastructure only, not deletion behavior.

Executed final verification: **178 tests passed, 0 failed, 0 skipped**, including real PostgreSQL integration. Syntax checks passed for **69 JavaScript files**. The matching client passed its **224-test** suite, including the real local HTTP/database UI scenario.
