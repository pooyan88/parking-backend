# Create and list parking slots

Run `npm run db:migrate` locally to apply migration 009, then restart the API.
Both endpoints require `Authorization: Bearer <access_token>`.

## Create

`POST /parkings/:parkingId/floors/:floorId/slots`

```json
{
  "code": "A-101"
}
```

Only `code` is accepted. It must be non-empty text after trimming, up to 255
Unicode characters, without null characters. The stored spelling is preserved.
The database compares codes using `LOWER`, so `A-101` and `a-101` conflict
inside the same lot, even on different floors. Another lot can use that code.
Codes on archived slots or archived floors remain reserved within the lot.

The lot and floor come from the URL. The owner comes from the verified token.
Extra body fields such as IDs, ownership, status, and availability are rejected.

Success returns `201`:

```json
{
  "message": "Parking slot created successfully",
  "slot": {
    "id": 1,
    "parking_id": 12,
    "floor_id": 1,
    "code": "A-101",
    "operational_status": "usable",
    "maintenance_note": null,
    "created_at": "2026-11-15T10:00:00.000Z"
  }
}
```

## List

`GET /parkings/:parkingId/floors/:floorId/slots` returns `200` and an array
of active slots with the fields above, ordered by `LOWER(code)` then ID.
An accessible empty floor returns `[]`. A slot under an archived lot or floor
is not available through this endpoint. Maintenance slots remain visible to
the owner; their status is returned in the response.

- `400`: invalid parking/floor ID or creation body.
- `401`: missing, invalid, or expired access token.
- `404`: missing or archived parent, another owner, or a floor outside the lot
  in the URL. All return `Parking floor not found`.
- `409`: code already exists in the same lot.
- `500`: unexpected database failure, without database details.

## Schema and ownership

`parking_slots` stores an identity primary key, parking ID, floor ID, code,
operational status, optional maintenance note, creation time, and archive time.
Creation time is required and defaults to database time. Timestamps use
`TIMESTAMPTZ`. Existing user, token, parking, and floor rows are unchanged.

The combined foreign key `(parking_id, floor_id)` references the matching pair
on `parking_floors`. This prevents a slot's parking and floor from disagreeing.
The floor already references its lot, so a second direct lot foreign key is
not needed. Deletion of a referenced floor is restricted.

Important indexes:

- Unique `(parking_id, LOWER(code))` enforces lot-wide code uniqueness.
- Unique `(parking_id, id)` supports future contract references to a slot in
  the same lot.
- `(parking_id, floor_id)` supports floor lookups and the combined foreign key.

There is no slot owner field. Every API query checks ownership through the lot.

## Transactions and availability

Creation uses one connection and a transaction. It locks the active owned lot,
then the active floor in that lot, then inserts. This order coordinates with
parent archiving. Failure rolls back; a failed rollback removes the connection
from the pool. Database uniqueness also protects concurrent code creation.

`operational_status` describes physical condition: `usable` or `maintenance`.
New slots always start as `usable`, with no maintenance note. See
[slot updates](parking-slot-updates.md) for code and maintenance controls.

There is no stored `is_available` or `is_occupied` flag. A usable slot is not
automatically free to rent: the contract feature must check overlapping rental
periods. That feature will calculate available, occupied, and reserved states
from contracts. This feature creates no contracts or double-booking protection.

Archiving a floor or lot preserves the slots and hides them through parent
checks. See [slot archiving](parking-slot-archiving.md) for individual soft deletion. Slot counts
and occupancy statistics will be calculated from the underlying data later.

## Verification

`npm test` covers validation, JWT routing, ownership and parent checks,
transaction cleanup, and duplicate handling. Optional local PostgreSQL tests
also cover the combined foreign key, lot-wide code uniqueness, concurrent
creation, physical status defaults, and parent archive behavior. See
[test setup](parking-ownership.md#tests).
