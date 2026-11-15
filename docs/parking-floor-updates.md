# Update a parking floor

No new migration is needed. Restart the local API after updating the code.

```http
PATCH /parkings/12/floors/1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "floor_number": -2,
  "label": "Lower basement"
}
```

Send `floor_number`, `label`, or both. Omitted fields keep their current values.
Send `"label": null` to clear the optional label. Blank label text is rejected.

The same rules as creation apply: a JSON integer floor number in PostgreSQL's
integer range, and label text up to 255 Unicode characters after trimming.
Null characters are rejected. An empty body or extra fields return `400`.
The request cannot change owner, parking ID, floor ID, or timestamps.

Success returns `200` with a message and the updated floor:

```json
{
  "message": "Parking floor updated successfully",
  "floor": {
    "id": 1,
    "parking_id": 12,
    "floor_number": -2,
    "label": "Lower basement",
    "created_at": "2026-11-15T10:00:00.000Z"
  }
}
```

- `400`: invalid IDs, body, or field values.
- `401`: missing, invalid, or expired access token.
- `404`: missing or archived floor/lot, a different owner, or a floor that does
  not belong to the parking ID in the URL. All return `Parking floor not found`.
- `409`: another floor in this lot already has that number, including an
  archived floor. The attempted changes are rolled back.
- `500`: unexpected database failure, without internal details.

Sending the current number again is allowed. Renumbering preserves the floor's
ID, parking relationship, and creation time. Future slots will refer to its
stable ID, so changing the display number will not move slots between floors.

## Transaction behavior

The controller locks the owner's active parent lot, then updates the active
floor using both IDs on the same connection. It commits on success or rolls
back on failure. The parent lock coordinates updates with parking archiving
and the other floor actions using that lock.

SQL uses `COALESCE` to preserve an omitted number. A separate Boolean parameter
records whether the label was provided: this lets SQL distinguish “keep the
label” from “clear it with null.” Values always use query parameters.

If two requests change different fields, omitted fields stay unchanged. If
they change the same field, the last update wins. There is no edit-version
check in this feature.

`npm test` covers partial updates, label clearing, validation, JWT routing,
parent locks, rollback, and duplicate handling. The optional PostgreSQL suite
also checks actual uniqueness, cross-lot access, and archive restrictions.
