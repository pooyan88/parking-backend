# Create a parking lot

Run `npm run db:migrate` locally to apply migration 006 before using the API.
The baseline is already recorded; it does not need to run again.

## Request

`POST /parkings` requires an access token and a JSON body:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "name": "Main parking",
  "location": "Tehran"
}
```

Both values must be non-empty strings after trimming outer whitespace, with
at most 255 Unicode characters. Null characters are rejected because PostgreSQL
text cannot store them. Duplicate parking names are allowed; IDs identify lots.

Ownership always comes from `req.user.id`, set by JWT middleware. Client fields
such as `owner_id`, `user_id`, `id`, and `created_at` are ignored.

## Response

Success returns `201 Created`:

```json
{
  "message": "Parking lot created successfully",
  "parking": {
    "id": 12,
    "name": "Main parking",
    "location": "Tehran",
    "created_at": "2026-11-15T10:00:00.000Z"
  }
}
```

- `400`: missing or invalid name/location.
- `401`: missing, invalid, or expired token, or the authenticated user was deleted.
- `500`: an unexpected database error. Database details are not returned.

A single parameterized insert creates the row and returns it. PostgreSQL makes
this statement atomic: it either succeeds or fails as a whole. An extra
multi-statement transaction is not needed.

## Creation times

Migration 006 adds `created_at` as `TIMESTAMPTZ`. Existing rows keep `null`
because their real creation dates are unknown. A separate default of `NOW()`
provides the database time for new rows. The API does not accept a creation date.

The column remains nullable to preserve unknown historical dates. This endpoint
always uses the database default for new lots. The original name/location
columns also remain unchanged; the endpoint requires both fields for new lots.

`GET /parkings` now also returns `created_at`, as an ISO 8601 UTC string for new
lots or `null` for older ones. It still returns only the signed-in owner's lots.

## Verification

`npm test` checks validation, ownership, JWT routing, parameterized input, and
error responses with simulated database calls. The optional local PostgreSQL
suite also checks that old dates stay unknown, new dates use the database time,
and creation and listing enforce ownership. See the integration-test setup in
[parking-ownership.md](parking-ownership.md).
