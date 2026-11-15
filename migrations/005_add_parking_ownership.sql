-- The runner executes this entire file and its history record in one transaction.
-- Keep the user count stable while assigning rows from the original schema.
LOCK TABLE public.users IN SHARE MODE;

ALTER TABLE public.parkings ADD COLUMN owner_id INTEGER;

DO $migration$
DECLARE
    legacy_owner_id INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM public.parkings) THEN
        IF (SELECT COUNT(*) FROM public.users) <> 1 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'Cannot assign existing parking lots: the database must have exactly one user for automatic assignment.',
                HINT = 'The original schema has no ownership information. A reviewed parking-to-owner mapping is required; no changes have been committed.';
        END IF;

        SELECT id INTO legacy_owner_id FROM public.users;
        UPDATE public.parkings SET owner_id = legacy_owner_id;
    END IF;
END;
$migration$;

ALTER TABLE public.parkings
    ALTER COLUMN owner_id SET NOT NULL,
    ADD CONSTRAINT parkings_owner_id_fkey
        FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE RESTRICT;

CREATE INDEX parkings_owner_id_idx ON public.parkings (owner_id);
