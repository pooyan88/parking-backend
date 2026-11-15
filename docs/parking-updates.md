# Update a parking lot

This feature uses the existing columns. No new migration is needed.

`PATCH /parkings/:id` changes a lot's name, location, or both. PATCH means a
partial update: leave out a field to keep its current value.

```http
PATCH /parkings/12
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "name": "Updated parking name"
}
```

This request changes the name and keeps the location. You can also send just
`location`, or both fields. Validation is shared with parking creation: trim
outer whitespace, require non-empty text, allow up to 255 Unicode characters,
and reject null characters. A field cannot be cleared with `null` or blank text.

The ID must be a positive whole number without leading zeros, up to
2147483647, matching the existing PostgreSQL integer primary key.

Only `name` and `location` are accepted in the body. Extra fields, including
`owner_id`, `user_id`, `id`, and `created_at`, return `400` without an update.
Ownership always comes from the verified JWT, not a client field.

## Responses

Success returns `200`:

```json
{
  "message": "Parking lot updated successfully",
  "parking": {
    "id": 12,
    "name": "Updated parking name",
    "location": "Original location",
    "created_at": "2026-11-15T10:00:00.000Z"
  }
}
```

The original creation time is preserved, including `null` for older lots.
Sending the current value again is allowed and returns `200`.

- `400`: invalid ID, body, field value, or unsupported field.
- `401`: missing, invalid, or expired access token.
- `404`: the lot does not exist, is archived, or belongs to another owner. The response is
  the same for both cases: `Parking lot not found`.
- `500`: unexpected database failure; database details are not returned.

## Database behavior

One parameterized `UPDATE` includes the parking ID, authenticated owner ID, and
`archived_at IS NULL` in its `WHERE` condition. There is no separate lookup before the update.
This checks ownership and changes the row in one atomic statement.

`COALESCE` means “use the first value that is not null.” Here, omitted fields
are passed as null parameters, so SQL keeps their existing values. Actual null
input from the client is rejected before the query. The update only assigns
name and location; ownership and creation time stay unchanged.

If two requests change different fields at the same time, omitted fields keep
their database values. If both change the same field, the last database update
wins. This feature does not add version checks for conflicting edits.

## Verification

`npm test` covers validation, partial updates, immutable fields, JWT routing,
ownership conditions, and error responses. The optional PostgreSQL suite also
checks that one owner cannot update another owner's lot, and that partial
updates preserve other values and creation times.
