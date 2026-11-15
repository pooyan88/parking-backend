# Rental contracts

Migration 011 requires PostgreSQL's trusted `btree_gist` extension. The database
role needs permission to install it, or it must already be installed in public.
Existing users, passwords, tokens, lots, floors, and slots are preserved.

All routes require JWT: POST/GET `/contracts`, GET `/contracts/:id`, and
GET `/contracts/:id/events`. Lists accept limit/offset, optional parking_id,
customer_id, and status (upcoming/active/expired/ended/cancelled).

Create example:
```json
{
  "customer_id": 1,
  "slot_id": 1,
  "rental_type": "monthly",
  "starts_at": "2030-01-31T10:00:00+03:30",
  "timezone": "Asia/Tehran",
  "agreed_price": "1000000.00",
  "currency": "IRR"
}
```

Dates require explicit offsets and seconds, with at most 3 fractional digits.
Historical start dates are allowed, but all overlap constraints still apply.
Hourly rentals require an integer hours value (1–87600). Monthly is one
Gregorian calendar month; quarterly is three. They calculate the end in the
specified IANA timezone, defaulting to the lot's Asia/Tehran timezone. A month
is never fixed at 30 days. January 31 clamps to February's last day. Custom
rentals require ends_at and support manually chosen Jalali-calendar periods.
The chosen timezone is saved on each contract; UTC API times preserve instants.

Price is optional. When supplied, it is a non-negative decimal string (up to
16 integer digits, 2 decimals) with an explicit uppercase three-letter unit,
such as IRR or IRT. There is no conversion, payment, refund, or tax calculation.

A database exclusion constraint rejects overlaps for the same slot, including
simultaneous requests and direct database inserts. Periods include the start
and exclude the end, allowing adjacent contracts. Cancelled bookings do not
block; early-ended bookings retain only their actual historical period.

Creation locks lots, floors, and slots in sorted order, verifies the active
customer belongs to the same owner, checks maintenance, and records the
agreement plus an event in one transaction. Database conflicts return 409,
inaccessible resources 404, and invalid input 400.

Expiration and current status are computed on read. No scheduled expiration
writer is needed. Responses include as_of, effective_ends_at, elapsed_seconds,
remaining_seconds, time_until_start_seconds, is_expired, and is_occupied.
Elapsed time stops at expiry or early ending. Upcoming remaining_seconds is
the rental duration, excluding the wait until the start. Occupied means rented,
not physical car presence. Expired contract history remains readable.

Archiving a lot, floor, slot, or customer, or starting slot maintenance, now
returns 409 while current/future confirmed contracts remain. Parent/customer
locks serialize these actions with booking creation and later lifecycle changes.
There are no hard-delete endpoints for business history.
