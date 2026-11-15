CREATE TABLE public.parking_floors (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parking_id INTEGER NOT NULL,
    floor_number INTEGER NOT NULL,
    label VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    CONSTRAINT parking_floors_parking_id_fkey
        FOREIGN KEY (parking_id) REFERENCES public.parkings(id) ON DELETE RESTRICT,
    CONSTRAINT parking_floors_parking_id_floor_number_key
        UNIQUE (parking_id, floor_number),
    -- Future slots can reference both IDs to enforce that their floor belongs
    -- to the same parking lot as the slot.
    CONSTRAINT parking_floors_parking_id_id_key UNIQUE (parking_id, id)
);
