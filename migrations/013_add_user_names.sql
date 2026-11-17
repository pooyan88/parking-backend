-- Names are optional. Authentication responses use a fallback for NULL values.
-- Existing accounts keep their IDs, credentials, and sessions unchanged.
ALTER TABLE public.users
    ADD COLUMN name VARCHAR(255),
    ADD COLUMN family_name VARCHAR(255);
