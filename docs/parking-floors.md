# Create and list parking floors

Apply migration 008 locally with `npm run db:migrate`, then restart the API if
needed. Both endpoints require `Authorization: Bearer <access_token>`.

## Create

`POST /parkings/:parkingId/floors`

```json
{
  "floor_number": -1,
  "label": "Basement"
}
```

`floor_number` is required as a JSON integer, from -2147483648 to 2147483647.
Negative floors, ground floor 0, and positive floors are all supported.
It must be unique inside that parking lot. Another lot can use the same number.

`label` is optional. Omitted or null means no label. Otherwise it must be
non-empty text after trimming, up to 255 Unicode characters, without null
characters. Fields such as `owner_id`, `parking_id`, or `id` are rejected.

Success returns `201`:

```json
{
  "message": "Parking floor created successfully",
  "floor": {
    "id": 1,
    "parking_id": 12,
    "floor_number": -1,
    "label": "Basement",
    "created_at": "2026-11-15T10:00:00.000Z"
  }
}
```

## List

`GET /parkings/:parkingId/floors` returns `200` and an array of active floors,
ordered by floor number: -1, 0, 1, and so on. Each item has the fields shown
above. An accessible lot with no active floors returns `[]`.

Both endpoints return `404` if the lot is missing, archived, or owned by
another user. Client owner fields cannot select a different owner's data.
Listing uses one query, including the parent ownership and archive checks.

Other responses:

- `400`: invalid parking ID or creation body.
- `401`: missing, invalid, or expired access token.
- `409`: that floor number already exists in this lot.
- `500`: unexpected database failure; database details are not returned.

## Database and transactions

`parking_floors` stores an integer identity primary key, required parking ID
and floor number, optional label, required creation time, and optional archive
time. Timestamps use `TIMESTAMPTZ`. The owner is reached through `parkings`;
there is no separate floor owner field that could disagree with the parent.

The parking foreign key uses restricted deletion. Unique `(parking_id,
floor_number)` also creates an index that supports listing one lot's floors
in order. Unique `(parking_id, id)` lets future slots use a combined foreign
key to prove that their floor belongs to their parking lot. No extra index on
just `parking_id` is needed.

Creation uses one connection for a transaction:

1. Lock and check the active parking row using the authenticated owner ID.
2. Insert the floor.
3. Commit, or roll back on failure.

The row lock coordinates creation with parking archiving. If archiving wins,
creation returns `404`. If creation wins, it finishes before archiving proceeds.
Duplicate floor numbers are also rejected by PostgreSQL, including concurrent
requests. A rollback failure removes that connection from the pool.

Archiving a lot keeps its floors in the database but hides them through the
parent check. See [floor updates](parking-floor-updates.md) for editing.
See [floor archiving](parking-floor-archiving.md) for soft deletion.
Floor numbers remain reserved after archiving.

See [parking slots](parking-slots.md) for slot creation and listing inside a
floor. Slot counts and occupancy statistics will be calculated from slots and
rental periods later. There are no capacity or occupancy counters here.

## Verification

`npm test` covers input validation, JWT routing, tenant checks, transaction
rollback, and duplicate handling. The optional local PostgreSQL tests also
cover actual uniqueness, foreign keys, sorting, concurrent creation, and parent
archiving. See [test setup](parking-ownership.md#tests).
