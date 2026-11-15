# Archive a slot

`DELETE /parkings/:parkingId/floors/:floorId/slots/:slotId` requires the owner's
access token and active parents. No body or migration is needed. It preserves
the row, sets `archived_at`, and returns 204 with no body. Repeating the request
keeps the first timestamp. Its code remains reserved throughout the lot.
Listings hide archived slots and updates return 404 for them. Invalid IDs
return 400; inaccessible resources return 404. Parent rows are locked in lot,
floor order, and the update and checks use one transaction.
