# User names

Migration `013_add_user_names.sql` adds nullable `name` and `family_name`
columns (`VARCHAR(255)`) to `users`. Existing account IDs, credentials,
creation timestamps, and refresh tokens are preserved. Existing names are null.

`POST /auth/signup` accepts both fields optionally:

```json
{
  "username": "ali",
  "phone_number": "09120000000",
  "password": "your-password",
  "name": "علی",
  "family_name": "محمدی"
}
```

Both fields are trimmed. Omitted fields, explicit nulls, and blank strings
are stored as SQL NULL. Other non-string values, null characters, and values
longer than 255 Unicode characters return 400.

Signup and login include `name` and `family_name` in their `user` response.
Each SQL NULL is returned as `"کاربر جدید"`; a supplied name is preserved even
if the other field is missing. This fallback is applied when reading, so it
also covers old accounts and subsequent database updates to NULL. Raw database
queries still see NULL. Refresh-token responses and JWT claims are unchanged.

Before starting the updated API on the server, back up the database and apply
the migration with the existing runner:

```sh
npm run db:status
npm run db:migrate
npm run db:preflight
```

Then restart the API and verify signup and login. The updated API requires
migration 013; the previous API remains compatible with the added columns.
See the [deployment plan](deployment-plan.md) for the complete release process.
