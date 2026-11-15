-- Old rows have no known creation date. Keep them NULL instead of assigning
-- the migration time. Set the default separately so only new rows use it.
ALTER TABLE public.parkings ADD COLUMN created_at TIMESTAMPTZ;
ALTER TABLE public.parkings ALTER COLUMN created_at SET DEFAULT NOW();
