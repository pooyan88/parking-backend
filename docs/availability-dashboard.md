# Availability and dashboard

JWT is required. Apply migration 012 for the reporting index.

GET `/parkings/:parkingId/slots/availability?starts_at=...&ends_at=...` requires
ISO times with offsets and a positive period. Optional floor_id scopes a floor.
Lists accept limit/offset (default 100, maximum 200). A timezone `+` must be URL
encoded as `%2B`. Every parent must be active and owned, otherwise 404.

Each slot shows current_state (available, occupied, or maintenance),
available_for_period, period_state (available, occupied, reserved, maintenance),
and next_reservation_start. A reservation tomorrow does not occupy a slot today,
but may prevent renting for the requested period. Historical effective rental
ranges also block overlapping backdated agreements. Cancelled bookings do not.
Current rented slots include customer_name, contract_starts_at/contract_ends_at,
elapsed_seconds, remaining_seconds, and current_contract_id. Times use the
database as_of instant. Maintenance is distinct from rental occupancy.

GET `/dashboard` returns the owner's active lot/floor/slot totals, occupied,
available, maintenance and usable slots, active customers, rental counts by
current state, expiring soon, and a floor summary array. Optional parking_id
scopes physical resources and contract history to one lot. Customer count
remains owner-wide because customers belong to owners, not lots.
GET `/parkings/:parkingId/statistics` is the scoped form. expiring_days defaults
to 7 and accepts 1–365.

Occupancy percentage is occupied / usable * 100, rounded to two decimal places,
or zero when there are no usable slots. Archived resources are excluded from
capacity; expired/ended/cancelled contract history remains counted for the owner
or selected lot. Maintenance slots are not available. Revenue is not reported
because agreed contract prices are not a payment ledger.

Reports use read-only repeatable-read transactions, so counts and floor details
describe the same database snapshot. No counters, expiration flags, elapsed
times, or occupancy percentages are stored or periodically rewritten.
