# Parking ownership and listing

Migration 005 adds a required `parkings.owner_id` that refers to `users.id`.
An index helps PostgreSQL find one owner's parking lots. There is no default
owner: every future insert must provide the authenticated owner's ID.

Deleting a user who owns parking lots is rejected by the foreign key. This
feature does not add a user-deletion endpoint or change authentication data.

## Existing parking rows

The old table does not say who owns a parking lot. The migration uses this rule:

- No parking rows: no assignment is needed, regardless of user count.
- Existing parking rows and exactly one user: assign all rows to that user.
- Existing parking rows and zero or multiple users: stop and roll back the
  entire migration. Keep all rows and migration history unchanged. An explicit,
  reviewed ownership mapping is needed before this case can be migrated.

The migration locks the user table while it checks the count, so a signup or
user deletion cannot change the result during assignment. It does not assume
that the user ID is 1 or select an arbitrary owner from several users.

## Apply locally

Ensure `.env` points to the local database. If the original database has not
been baselined yet, first run `npm run db:baseline`.

```sh
npm run db:migrate
npm run db:status
```

Apply migration 005 before using the updated endpoint. Do not deploy to the
Ubuntu server yet.

## API

`GET /parkings` still requires `Authorization: Bearer <access_token>`.

The controller passes only `req.user.id` to the parameterized ownership filter.
Client fields such as `owner_id` or `user_id` cannot select another owner.
The response is an array with `id`, `name`, `location`, and `created_at`, ordered
by ID. Older lots have `created_at: null` because their creation dates are unknown.

- `200`: this owner's parking lots, or `[]` if there are none.
- `401`: access token is missing, invalid, or expired.
- `500`: database failure, without database details in the response.

See [parking creation](parking-creation.md) for `POST /parkings`, and
[parking updates](parking-updates.md) for `PATCH /parkings/:id`. Deletion,
floors, and other resources belong to later features.

## Tests

`npm test` runs the unit tests. The database calls in these tests are simulated.

The optional integration test uses a real **local** PostgreSQL instance. Set
`PARKING_TEST_DATABASE_URL` to a local maintenance database URL whose user can
create databases, then run `npm test`. Use a URL without query parameters so
the target host and database cannot be overridden. Do not put real credentials
in Git.

The integration test creates and deletes databases with random
`parking_ownership_test_` names. It never changes the database in that URL or the
application database in `.env`. It checks automatic assignment, empty tables,
database constraints, tenant filtering, and rollback for ambiguous ownership.
Without that variable, the integration test is reported as skipped.
