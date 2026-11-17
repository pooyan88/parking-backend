-- Keep signup and concurrent user updates stable during the backfill.
LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.user_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    username VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    family_name VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.user_profiles (user_id, username, phone_number, name, family_name)
SELECT id, username, phone_number, name, family_name FROM public.users;

-- Users remain the write source for account details. A trigger keeps the
-- profile synchronized atomically, including signup and older API versions.
CREATE FUNCTION public.sync_user_profile() RETURNS TRIGGER
LANGUAGE plpgsql AS $function$
BEGIN
    INSERT INTO public.user_profiles (user_id, username, phone_number, name, family_name)
    VALUES (NEW.id, NEW.username, NEW.phone_number, NEW.name, NEW.family_name)
    ON CONFLICT (user_id) DO UPDATE
    SET username = EXCLUDED.username,
        phone_number = EXCLUDED.phone_number,
        name = EXCLUDED.name,
        family_name = EXCLUDED.family_name,
        updated_at = NOW()
    WHERE (user_profiles.username, user_profiles.phone_number, user_profiles.name, user_profiles.family_name)
        IS DISTINCT FROM (EXCLUDED.username, EXCLUDED.phone_number, EXCLUDED.name, EXCLUDED.family_name);
    RETURN NEW;
END;
$function$;

CREATE TRIGGER users_sync_profile
AFTER INSERT OR UPDATE OF username, phone_number, name, family_name ON public.users
FOR EACH ROW EXECUTE FUNCTION public.sync_user_profile();
