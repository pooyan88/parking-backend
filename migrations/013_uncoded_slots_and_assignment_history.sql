-- Retain every existing slot/code and contract. NULL codes identify new unassigned slots.
ALTER TABLE public.parking_slots ALTER COLUMN code DROP NOT NULL;
ALTER TABLE public.rental_contracts ADD COLUMN assigned_code VARCHAR(255);
UPDATE public.rental_contracts c SET assigned_code = s.code
FROM public.parking_slots s WHERE s.id = c.slot_id AND s.parking_id = c.parking_id;
-- Keep the existing view column order and API shape; historical codes no longer follow later slot renames.
CREATE OR REPLACE VIEW public.rental_contract_details AS
SELECT c.id, c.owner_id, c.parking_id, c.customer_id, c.slot_id, c.rental_type, c.starts_at, c.ends_at, c.timezone, c.period_months, c.billing_anchor_at, c.billing_month_offset, c.status, c.ended_at, c.cancelled_at, c.agreed_price, c.currency, c.previous_contract_id, c.link_type, c.created_at, c.updated_at, c.rental_period,
       cu.name AS customer_name, COALESCE(c.assigned_code, s.code) AS slot_code, s.floor_id,
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
