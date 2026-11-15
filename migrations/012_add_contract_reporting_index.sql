CREATE INDEX rental_contracts_slot_end_idx ON public.rental_contracts (slot_id, ends_at)
    WHERE status = 'confirmed';
