# Customers

Migration 010 creates owner-level customers. JWT is required on all routes:
POST/GET `/customers`, GET/PATCH/DELETE `/customers/:id`.

Create with `{ "name": "Alice", "customer_code": "C-1", "phone_number": "+98123" }`.
Name and code are required. Phone is optional and may be shared. Code is unique
per owner using LOWER, including archived customers. PATCH accepts the same
fields; null clears phone. DELETE archives, preserving history. Lists exclude
archived records and accept limit (1–200, default 100) and offset (default 0).
Foreign resources return 404; duplicate codes return 409; invalid input 400.
The upcoming rental feature adds the archive guard for current/future contracts.
