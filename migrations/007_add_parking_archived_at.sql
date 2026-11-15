-- NULL means the lot is active. Preserve all existing rows and relationships.
ALTER TABLE public.parkings ADD COLUMN archived_at TIMESTAMPTZ;
