# Archive a parking floor

No new migration is needed: migration 008 already created `archived_at`.
Restart the local API after updating the code.

```http
DELETE /parkings/12/floors/1
Authorization: Bearer <access_token>
```

No request body is needed. The server checks that the parking lot is active,
belongs to the authenticated owner, and contains the requested floor. Both
IDs must follow the positive integer rules used by floor updates.

This is a soft delete. It sets the database archive time and preserves the
floor's ID, parking reference, number, label, and creation time. The lot itself
and the other floors stay unchanged.

## Responses

- `204 No Content`: archived successfully, with no response body.
- `400`: invalid parking or floor ID.
- `401`: missing, invalid, or expired access token.
- `404`: missing or archived parent lot, another owner, a missing floor, or a
  floor outside the lot in the URL. All return `Parking floor not found`.
- `409`: current or future confirmed rentals on this floor must be resolved.
- `500`: unexpected database failure, without database details.

Repeating the request returns `204` while the parent lot is active and owned
by the same user. The first archive timestamp stays unchanged. Request body
and query fields cannot change ownership or the target IDs.

Archived floors disappear from `GET /parkings/:parkingId/floors` and cannot
be edited with PATCH. A lot with no active floors still returns `[]`.
The floor number stays reserved by the unique constraint; creating a new
floor with that number in the same lot returns `409`. Restore and permanent
deletion are not included in this feature.

## Transactions and related data

The controller starts a transaction, locks the owner's active parking row,
updates the floor using both URL IDs, then commits. Errors and missing rows
roll back the transaction. A failed rollback removes that connection from the
pool. Locking the same parent as floor creation and editing coordinates these
actions with archiving and prevents changes after the parent is archived.

Slot creation and listing check the floor archive state. Archiving a floor
preserves its slots without rewriting each child row. Future booking actions
also check that state. A `409` guard rejects current or future confirmed
contracts, using the same parent locks as booking creation. Owner-level
customers remain available for other floors and lots. Contract history remains
stored and readable by its owner.

## Verification

`npm test` covers IDs, JWT routing, owner and parent conditions, repeated
requests, rollback, and database errors. The optional local PostgreSQL suite
checks row preservation, stable timestamps, cross-lot access, archived-floor
filtering, edit restrictions, and the reserved floor number.
