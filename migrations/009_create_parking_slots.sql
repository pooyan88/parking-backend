CREATE TABLE public.parking_slots (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parking_id INTEGER NOT NULL,
    floor_id INTEGER NOT NULL,
    code VARCHAR(255) NOT NULL,
    operational_status TEXT NOT NULL DEFAULT 'usable',
    maintenance_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    CONSTRAINT parking_slots_parking_floor_fkey
        FOREIGN KEY (parking_id, floor_id)
        REFERENCES public.parking_floors(parking_id, id) ON DELETE RESTRICT,
    CONSTRAINT parking_slots_code_check CHECK (code <> '' AND code = BTRIM(code)),
    CONSTRAINT parking_slots_operational_status_check
        CHECK (operational_status IN ('usable', 'maintenance')),
    CONSTRAINT parking_slots_parking_id_id_key UNIQUE (parking_id, id)
);

-- Codes belong to the whole lot, including archived slots and floors.
CREATE UNIQUE INDEX parking_slots_parking_id_code_key
    ON public.parking_slots (parking_id, LOWER(code));

CREATE INDEX parking_slots_parking_floor_idx
    ON public.parking_slots (parking_id, floor_id);
