# Create and list parking slots

The slots table requires migration 009. Range creation uses that existing schema
and adds no migration; deploy the updated API after applying any pending migrations.
Both endpoints require `Authorization: Bearer <access_token>`.

## Create

`POST /parkings/:parkingId/floors/:floorId/slots`

Create an inclusive range on the floor in the URL:

```json
{
  "start_code": "A-001",
  "end_code": "A-010"
}
```

This creates ten separate slots, `A-001` through `A-010`. Send either
`start_code` and `end_code` together, or the existing single-slot `code` body.
Combining both forms or sending extra fields returns `400`.

Range rules:

- Both endpoints must be strings, non-empty after trimming, at most 255 Unicode
  characters, and without null characters. Their stored spelling is preserved.
- Codes must end in ASCII digits (`0`–`9`). Any prefix must contain no digits
  and match exactly at both ends, including case. Numeric-only ranges such as
  `"1"` to `"100"` and prefixed ranges such as `"A1"` to `"A100"` are accepted.
- The starting number must be no greater than the ending number. Zero and
  equal endpoints are allowed. Each request may create at most 1,000 slots.
- If either numeric suffix is zero-padded, both suffixes must have the same
  width: `"A-001"` to `"A-010"` is valid; `"A-001"` to `"A-10"` is rejected.
  Unpadded ranges may cross a width boundary, such as `"9"` to `"10"`.

Range success returns `201` with `message: "Parking slots created successfully"`,
`count`, and `slots`. The array contains all created slots in numeric range
order, with the same fields shown in the single-slot response below. Even a
range with equal endpoints uses this response shape.

### Single-slot compatibility

```json
{
  "code": "A-101"
}
```

For a single slot, only `code` is accepted. It must be non-empty text after trimming, up to 255
Unicode characters, without null characters. The stored spelling is preserved.
Single-slot codes keep their existing validation and need not end in a number.

### Ownership and conflicts

The database compares codes using `LOWER`, so `A-101` and `a-101` conflict
inside the same lot, even on different floors. Another lot can use that code.
Codes on archived slots or archived floors remain reserved within the lot.

The lot and floor come from the URL. The owner comes from the verified token.
Extra body fields such as IDs, ownership, status, and availability are rejected.

Single-slot success returns `201`:

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
- `409`: at least one code already exists in the same lot; no slots from the
  request are created.
- `500`: unexpected database failure, without database details.

## Schema and ownership

`parking_slots` stores an identity primary key, parking ID, floor ID, code,
operational status, optional maintenance note, creation time, and archive time.
Creation time is required and defaults to database time. Timestamps use
`TIMESTAMPTZ`. Existing user, token, parking, and floor rows are unchanged.
Range creation stores one row for each generated code, so existing rentals,
maintenance controls, and availability calculations continue to use slot IDs.

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
parent archiving. A range is inserted in one transaction: any conflicting code
or other failure rolls back every slot in the request. Conflicts include codes
reserved by other floors and archived slots. A failed rollback removes the connection
from the pool. Database uniqueness also protects concurrent code creation.

`operational_status` describes physical condition: `usable` or `maintenance`.
New slots always start as `usable`, with no maintenance note. See
[slot updates](parking-slot-updates.md) for code and maintenance controls.

There is no stored `is_available` or `is_occupied` flag. A usable slot is not
automatically free to rent: the contract feature must check overlapping rental
periods. The [rental feature](rental-contracts.md) enforces overlap constraints,
and [availability reports](availability-dashboard.md) calculate available,
occupied, and reserved states from those agreements.

Archiving a floor or lot preserves the slots and hides them through parent
checks. See [slot archiving](parking-slot-archiving.md) for individual soft deletion. Slot counts
and occupancy statistics will be calculated from the underlying data later.

## Verification

`npm test` covers validation, JWT routing, ownership and parent checks,
transaction cleanup, and duplicate handling. Optional local PostgreSQL tests
also cover the combined foreign key, lot-wide code uniqueness, concurrent
creation, physical status defaults, and parent archive behavior. See
[test setup](parking-ownership.md#tests).
