# Archive a parking lot

Run `npm run db:migrate` locally to apply migration 007, then restart the API if
it is already running. The migration adds nullable `archived_at TIMESTAMPTZ`.
Existing rows keep null, meaning active.

```http
DELETE /parkings/12
Authorization: Bearer <access_token>
```

No request body is needed. This is a soft delete: the server records the
database time in `archived_at` and keeps the row and its relationships.

## Responses

- `204 No Content`: the owner's lot is archived; the response has no body.
- `400`: invalid parking ID, using the same rules as parking updates.
- `401`: missing, invalid, or expired access token.
- `404`: the lot is missing or belongs to another owner.
- `409`: current or future confirmed rentals must be resolved first.
- `500`: unexpected database failure, without internal details.

Repeating the request for an already archived lot owned by the same user also
returns `204`. Its original archive time is preserved. Client owner fields
cannot change which user is used for authorization.

`GET /parkings` lists only the owner's active lots. `PATCH /parkings/:id`
returns `404` for an archived lot, so it cannot be edited. Creation still makes
an active lot. Archiving does not change its owner, name, location, or creation
time. No restore or archived-list endpoint is included in this feature.

## Related resources and rental history

Floors are preserved when a lot is archived. Their create, list, update, and archive endpoints
check the parent lot's archive state, so they reject an archived lot with `404`.
Slot creation and listing also check the parent lot and floor archive states.
Existing slots and contract history are preserved. Owner-level customers remain
available for other lots. Archiving keeps the parking row and its references.

As those features are added:

- Floor creation, listing, updates, and archiving check the parent archive state.
  Slot creation and listing do too. Future slot actions and bookings must also
  check it. The parent's archive state applies without rewriting each child row.
- Customers belong to the owner and must remain available for other lots.
- Contract history remains available. Archiving rejects current or future
  confirmed rentals with `409`. The guard and booking creation lock the parent
  lot consistently so concurrent requests cannot bypass this rule.

This endpoint does not delete a user, revoke tokens, or cascade database deletes.
A transaction locks and verifies the owner-scoped lot, checks rental conflicts,
then records the archive time. Failure rolls back without changing the lot.

## Verification

`npm test` covers authentication, owner-scoped queries, IDs, repeated requests,
and archive filters on listing and editing. The optional local PostgreSQL suite
checks actual row preservation, stable timestamps, authorization, and the
behavior of archived lots.
