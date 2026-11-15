# Update a slot and its maintenance status

No new migration is needed. Restart the local API after updating the code.

```http
PATCH /parkings/12/floors/1/slots/1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "operational_status": "maintenance",
  "maintenance_note": "Repairing the floor surface"
}
```

Send any combination of `code`, `operational_status`, and `maintenance_note`.
An empty body, unknown field, or identity change returns `400`.

- `code`: the same trimmed text rules as creation, up to 255 Unicode characters.
  Codes must remain unique across the whole lot using PostgreSQL `LOWER`.
- `operational_status`: exactly `usable` or `maintenance`.
- `maintenance_note`: optional text, trimmed, non-empty, and at most 1000 Unicode
  characters, or null to clear it. Null characters are rejected.

Omitted fields stay unchanged, with one rule: setting the status to `usable`
clears the maintenance note. A non-null note is accepted only when the resulting
status is `maintenance`. For example, a note-only update to a usable slot is
rejected; send `operational_status: "maintenance"` with the note to start repairs.
Sending `maintenance_note: null` can clear a note without changing status.

Success returns `200` with `message: "Parking slot updated successfully"` and
the updated `slot`, using the same fields as the creation response. ID, parking
reference, floor reference, and creation time stay unchanged. Renaming a slot
does not move it to another floor.

Other responses:

- `400`: invalid IDs, body, values, or a note on a usable slot.
- `401`: missing, invalid, or expired access token.
- `404`: missing, archived, or mismatched lot/floor/slot, or another owner.
  All return `Parking slot not found`.
- `409`: code already exists elsewhere in the lot, including archived slots
  or slots on archived floors. All attempted changes are rolled back.
- `500`: unexpected database failure, without database details.

## Transaction and booking rules

The controller starts a transaction and locks the active lot, floor, and slot
in that order. Ownership comes from the JWT and the lot, and every child must
match its parent. The slot state is read under that lock before computing
the final status and note, so concurrent edits cannot use stale note values.
It commits one update or rolls back on failure. A failed rollback removes
the connection from the pool.

Sending the same code or status again is allowed. If concurrent requests edit
the same field, the last update wins. All writes use parameterized queries.

This endpoint manages physical condition. It cannot set `occupied`, `reserved`,
`is_available`, or `is_occupied`; those belong to rental calculations. There are
no contracts yet. Before rentals are enabled, add a conflict check under the
same locks so maintenance cannot start with unresolved current or future
confirmed rentals. Scheduled maintenance periods are outside this feature.

## Verification

`npm test` covers partial edits, state transitions, note clearing, validation,
JWT routing, parent checks, rollback, and duplicates. Optional local PostgreSQL
tests also cover real code collisions, cross-floor access, state preservation,
and archive restrictions.
