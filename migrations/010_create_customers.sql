CREATE TABLE public.customers (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL CHECK (BTRIM(name) <> ''),
    customer_code VARCHAR(100) NOT NULL CHECK (customer_code <> '' AND customer_code = BTRIM(customer_code)),
    phone_number VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    CONSTRAINT customers_owner_id_id_key UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX customers_owner_code_key ON public.customers (owner_id, LOWER(customer_code));
CREATE INDEX customers_owner_name_idx ON public.customers (owner_id, name);
