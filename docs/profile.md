# Current user's profile

`GET /profile` and `PATCH /profile` require `Authorization: Bearer <access_token>`.
Both use the verified JWT subject. There is no user ID in the route; a caller
cannot select another user's profile through request fields or query parameters.

GET returns the profile directly:

```json
{
  "user_id": 1,
  "username": "ali",
  "phone_number": "09120000000",
  "name": "علی",
  "family_name": "محمدی",
  "created_at": "2026-11-17T09:00:00.000Z",
  "updated_at": "2026-11-17T09:00:00.000Z"
}
```

PATCH accepts one or more of `phone_number`, `name`, and `family_name`:

```json
{
  "phone_number": "09121111111",
  "name": "رضا",
  "family_name": "احمدی"
}
```

The response is `{ "message": "Profile updated successfully", "profile": ... }`.
Omitted fields retain their previous values. Username, user ID, credentials,
and timestamps cannot be changed through this endpoint. Last name uses
`family_name`, matching signup and login; `last_name` and `lastname` are not aliases.

Strings are trimmed and limited to 255 Unicode characters. Phone number must be
non-empty text and must remain unique across users. It cannot be cleared with
null. Name and family name may be null or blank; these are stored as NULL and
returned as `کاربر جدید` independently, consistently with signup and login.
Unknown fields, empty updates, wrong types, and null characters return 400.
Duplicate phone numbers return 409, missing profiles 404, and missing/invalid
access tokens 401. A failed update rolls back all changes in that request.

## Storage and migration

Migration `014_create_user_profiles.sql` creates `user_profiles` with `user_id`
as both its primary key and a foreign key to `users`. Existing users are
backfilled with their current username, phone number, name, and family name.
Each signup automatically creates its profile through the `users_sync_profile`
trigger. The trigger also synchronizes later account detail changes in the same
transaction. Deleting a user cascades to its profile.

`users` remains the write source for the shared account fields. PATCH updates
that record and reads its synchronized profile in one transaction; this keeps
the existing signup/login responses and uniqueness rules consistent, including
older API versions. Do not edit the copied fields in `user_profiles` directly.
Profile timestamps describe profile creation and modification, not the original
account's creation time. Backfill does not invent historical profile timestamps.

Account IDs, usernames, password hashes, original account timestamps, and
refresh tokens are preserved. Changing profile fields does not invalidate
existing access or refresh tokens. Preflight checks for missing or inconsistent
profiles and for the enabled synchronization trigger.

For an existing local database, back it up and run `npm run db:migrate`, then
`npm run db:preflight`. Migration 013 is applied first if still pending.
For deployment, apply migration 014 before exposing the new profile routes;
the preceding API version is compatible with the added table and trigger.
