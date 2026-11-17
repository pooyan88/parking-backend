# Parking management backend

JavaScript, Express, PostgreSQL, parameterized SQL, JWT access/refresh tokens,
and tracked migrations. No new ORM or web framework was introduced.

Implemented: owner-scoped parking/floor/slot management and soft deletion;
maintenance; owner-level customers; rental contracts with database overlap
protection; cancellation, early ending, extension, renewal, and slot changes;
period availability; calculated expiry/durations; owner and floor statistics.

## Local setup and acceptance

Use Node.js 22+ and PostgreSQL 14+. Keep your existing .env and authentication
data. For a new checkout, fill .env using .env.example. Never commit credentials.

```sh
npm ci
npm run check
npm test
npm run db:migrate
npm run db:preflight
npm run dev
```

Existing untracked databases need `npm run db:baseline` once before migration.
The current upgrade batch adds migrations 010–013. Real PostgreSQL validation is
still pending in the restricted implementation environment. To run it locally,
set PARKING_TEST_DATABASE_URL to a local maintenance database with a role that
can create disposable databases, then run `npm run test:integration`.
Plain npm test skips those suites if the variable is absent; the dedicated
integration command fails instead of silently skipping.

## API overview

All business routes require `Authorization: Bearer <access_token>`.

| Route | Methods | Purpose |
|---|---|---|
| `/auth/signup`, `/auth/login`, `/auth/refresh` | POST | Existing authentication |
| `/parkings` | GET, POST | Owner's active lots; create |
| `/parkings/:id` | GET, PATCH, DELETE | Detail, edit, archive |
| `/parkings/:parkingId/floors` | GET, POST | Floors in an active owned lot |
| `/parkings/:parkingId/floors/:floorId` | PATCH, DELETE | Edit/archive a floor |
| `/parkings/:parkingId/floors/:floorId/slots` | GET, POST | Slots in an active owned floor |
| `/parkings/:parkingId/floors/:floorId/slots/:slotId` | PATCH, DELETE | Code/maintenance; archive |
| `/customers` | GET, POST | Owner's active customers; create |
| `/customers/:id` | GET, PATCH, DELETE | Detail, edit, archive |
| `/contracts` | GET, POST | Rental history and creation |
| `/contracts/:id` | GET | Agreement and calculated time/state |
| `/contracts/:id/events` | GET | Owner-scoped change history |
| `/contracts/:id/cancel` | POST | Cancel an upcoming agreement |
| `/contracts/:id/end` | POST | End an active agreement early |
| `/contracts/:id/extend` | POST | Extend a non-expired agreement |
| `/contracts/:id/renew` | POST | Create a linked next agreement |
| `/contracts/:id/move` | POST | Change slots atomically |
| `/parkings/:parkingId/slots/availability` | GET | Requested period and current state |
| `/dashboard` | GET | Owner summary and floor statistics |
| `/parkings/:parkingId/statistics` | GET | One active lot's summary |

Signup accepts optional `name` and `family_name` fields. Signup and login return
`کاربر جدید` for each missing name. See the [user name guide](docs/authentication.md).

Customer/contract/event/availability lists use limit/offset (default 100,
maximum 200). Contract lists support parking_id, customer_id, status, and
expiring_days. Dashboard expiring_days defaults to 7. Unknown resources and
another owner's resources have the same 404 responses. Duplicate codes and
booking conflicts return 409. All business deletion is archival.

## Business rules

Customers belong to owners across their lots. Occupied means rented, not a
physical car detection. Dates require seconds and explicit ISO offsets.
Hourly uses actual hours. Monthly/quarterly use Gregorian calendar months in
the contract's IANA timezone, default Asia/Tehran; custom ends support manually
chosen periods, including Jalali dates converted to instants. Renewals preserve
the original day anchor to avoid January 31 → February 28 → March 28 drift.
Expiry is calculated, not dependent on a background job.

Price is optional and must have an explicit currency/unit code when provided.
There is no implicit rial/toman conversion, proration, payment, refund, tax,
or physical visit tracking. Starting maintenance or archiving a resource with
unresolved current/future rentals returns 409. History is preserved.

Read the [schema and ERD](docs/schema.md), [contract guide](docs/rental-contracts.md),
[customer guide](docs/customers.md), and [availability/dashboard guide](docs/availability-dashboard.md).

## Deployment

No deployment or production backup has been performed. Read the
[reviewed deployment plan](docs/deployment-plan.md). Deployment, server changes,
and pushing commits require separate explicit authorization.
