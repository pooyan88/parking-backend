CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE public.parkings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Tehran';
ALTER TABLE public.parkings ADD CONSTRAINT parkings_owner_id_id_key UNIQUE (owner_id, id);

CREATE TABLE public.rental_contracts (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    parking_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    slot_id INTEGER NOT NULL,
    rental_type TEXT NOT NULL CHECK (rental_type IN ('hourly', 'monthly', 'quarterly', 'custom')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    timezone TEXT NOT NULL,
    period_months INTEGER,
    billing_anchor_at TIMESTAMPTZ NOT NULL,
    billing_month_offset INTEGER NOT NULL DEFAULT 0 CHECK (billing_month_offset >= 0),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'ended')),
    ended_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    agreed_price NUMERIC(18,2),
    currency VARCHAR(3),
    previous_contract_id INTEGER,
    link_type TEXT CHECK (link_type IN ('renewal', 'move')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rental_period TSTZRANGE GENERATED ALWAYS AS
        (TSTZRANGE(starts_at, COALESCE(ended_at, ends_at), '[)')) STORED,
    CONSTRAINT rental_contracts_owner_id_id_key UNIQUE (owner_id, id),
    FOREIGN KEY (owner_id, parking_id) REFERENCES public.parkings(owner_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, customer_id) REFERENCES public.customers(owner_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (parking_id, slot_id) REFERENCES public.parking_slots(parking_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, previous_contract_id) REFERENCES public.rental_contracts(owner_id, id) ON DELETE RESTRICT,
    CHECK (ISFINITE(starts_at) AND ISFINITE(ends_at) AND ISFINITE(billing_anchor_at) AND ends_at > starts_at),
    CHECK (cancelled_at IS NULL OR ISFINITE(cancelled_at)),
    CHECK ((rental_type = 'monthly' AND period_months IS NOT NULL AND period_months = 1) OR
           (rental_type = 'quarterly' AND period_months IS NOT NULL AND period_months = 3) OR
           (rental_type IN ('hourly', 'custom') AND period_months IS NULL)),
    CHECK ((status = 'confirmed' AND ended_at IS NULL AND cancelled_at IS NULL) OR
           (status = 'cancelled' AND ended_at IS NULL AND cancelled_at IS NOT NULL) OR
           (status = 'ended' AND cancelled_at IS NULL AND ended_at IS NOT NULL
            AND ISFINITE(ended_at) AND ended_at >= starts_at AND ended_at <= ends_at)),
    CHECK ((agreed_price IS NULL AND currency IS NULL) OR
           (agreed_price IS NOT NULL AND agreed_price >= 0 AND agreed_price <> 'NaN'::numeric
            AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$')),
    CHECK ((previous_contract_id IS NULL AND link_type IS NULL) OR
           (previous_contract_id IS NOT NULL AND link_type IS NOT NULL)),
    CONSTRAINT rental_contracts_no_overlap EXCLUDE USING gist
        (slot_id WITH =, rental_period WITH &&) WHERE (status <> 'cancelled')
);
CREATE INDEX rental_contracts_owner_end_idx ON public.rental_contracts (owner_id, status, ends_at);
CREATE INDEX rental_contracts_customer_idx ON public.rental_contracts (owner_id, customer_id);
CREATE INDEX rental_contracts_parking_idx ON public.rental_contracts (parking_id);
CREATE UNIQUE INDEX rental_contracts_one_renewal_key ON public.rental_contracts (previous_contract_id)
    WHERE link_type = 'renewal' AND status <> 'cancelled';

CREATE TABLE public.contract_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    contract_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    before_values JSONB,
    after_values JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (owner_id, contract_id) REFERENCES public.rental_contracts(owner_id, id) ON DELETE RESTRICT
);
CREATE INDEX contract_events_contract_idx ON public.contract_events (owner_id, contract_id, id);

CREATE VIEW public.rental_contract_details AS
SELECT c.*, cu.name AS customer_name, s.code AS slot_code, s.floor_id,
       f.floor_number, p.name AS parking_name, NOW() AS as_of,
       COALESCE(c.ended_at, c.ends_at) AS effective_ends_at,
       CASE WHEN c.status = 'cancelled' THEN 'cancelled' WHEN c.status = 'ended' THEN 'ended'
            WHEN c.starts_at > NOW() THEN 'upcoming' WHEN c.ends_at <= NOW() THEN 'expired' ELSE 'active' END AS current_status,
       (c.status = 'confirmed' AND c.ends_at <= NOW()) AS is_expired,
       (c.status = 'confirmed' AND c.starts_at <= NOW() AND c.ends_at > NOW()) AS is_occupied,
       CASE WHEN c.status = 'cancelled' THEN 0 ELSE
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM LEAST(NOW(), COALESCE(c.ended_at, c.ends_at)) - c.starts_at))) END::double precision AS elapsed_seconds,
       CASE WHEN c.status <> 'confirmed' THEN 0 ELSE
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM c.ends_at - GREATEST(NOW(), c.starts_at)))) END::double precision AS remaining_seconds,
       CASE WHEN c.status <> 'confirmed' THEN 0 ELSE
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM c.starts_at - NOW()))) END::double precision AS time_until_start_seconds
FROM public.rental_contracts c
JOIN public.customers cu ON cu.id = c.customer_id AND cu.owner_id = c.owner_id
JOIN public.parking_slots s ON s.id = c.slot_id AND s.parking_id = c.parking_id
JOIN public.parking_floors f ON f.id = s.floor_id AND f.parking_id = s.parking_id
JOIN public.parkings p ON p.id = c.parking_id AND p.owner_id = c.owner_id;
