const pool = require('../Database/db');
const { transaction } = require('../Database/transaction');
const { HttpError } = require('../Utils/httpErrors');

async function snapshot(work) {
    return transaction(pool, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return work(client);
    });
}
async function verifyParking(client, ownerId, parkingId, floorId = null) {
    const parking = await client.query(`SELECT id FROM public.parkings
        WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`, [parkingId, ownerId]);
    if (!parking.rows.length) throw new HttpError(404, 'Parking lot not found');
    if (floorId !== null) {
        const floor = await client.query(`SELECT id FROM public.parking_floors WHERE id = $1 AND parking_id = $2 AND archived_at IS NULL`,
            [floorId, parkingId]);
        if (!floor.rows.length) throw new HttpError(404, 'Parking floor not found');
    }
}
async function availability(ownerId, parkingId, floorId, startsAt, endsAt, limit, offset) {
    return snapshot(async client => {
        await verifyParking(client, ownerId, parkingId, floorId);
        const result = await client.query(`SELECT s.id AS slot_id, s.code, s.floor_id, f.floor_number,
            s.operational_status, s.maintenance_note, NOW() AS as_of,
            CASE WHEN s.operational_status = 'maintenance' THEN 'maintenance'
                 WHEN active_rental.id IS NOT NULL THEN 'occupied' ELSE 'available' END AS current_state,
            (s.operational_status = 'usable' AND conflict.id IS NULL) AS available_for_period,
            CASE WHEN s.operational_status = 'maintenance' THEN 'maintenance'
                 WHEN conflict.id IS NULL THEN 'available' WHEN conflict.starts_at > NOW() THEN 'reserved'
                 ELSE 'occupied' END AS period_state,
            active_rental.id AS current_contract_id, active_rental.customer_name,
            active_rental.starts_at AS contract_starts_at, active_rental.ends_at AS contract_ends_at,
            COALESCE(active_rental.elapsed_seconds, 0) AS elapsed_seconds,
            COALESCE(active_rental.remaining_seconds, 0) AS remaining_seconds,
            (SELECT MIN(c.starts_at) FROM public.rental_contracts c
             WHERE c.slot_id = s.id AND c.status = 'confirmed' AND c.starts_at > NOW()) AS next_reservation_start
            FROM public.parking_slots s
            JOIN public.parking_floors f ON f.id = s.floor_id AND f.parking_id = s.parking_id
            JOIN public.parkings p ON p.id = s.parking_id
            LEFT JOIN public.rental_contract_details active_rental ON active_rental.slot_id = s.id AND active_rental.owner_id = $1 AND active_rental.current_status = 'active'
            LEFT JOIN LATERAL (SELECT c.id, c.starts_at FROM public.rental_contracts c
                WHERE c.slot_id = s.id AND c.status <> 'cancelled' AND c.rental_period && tstzrange($4::timestamptz,$5::timestamptz,'[)')
                ORDER BY c.starts_at, c.id LIMIT 1) conflict ON TRUE
            WHERE p.owner_id = $1 AND p.id = $2 AND ($3::integer IS NULL OR f.id = $3)
              AND p.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL
            ORDER BY f.floor_number, LOWER(s.code), s.id LIMIT $6 OFFSET $7`,
            [ownerId, parkingId, floorId, startsAt, endsAt, limit, offset]);
        return result.rows;
    });
}

async function dashboard(ownerId, parkingId, expiringDays) {
    return snapshot(async client => {
        if (parkingId !== null) await verifyParking(client, ownerId, parkingId);
        const result = await client.query(`WITH lots AS (
            SELECT id FROM public.parkings WHERE owner_id = $1 AND archived_at IS NULL AND ($2::integer IS NULL OR id = $2)
        ), floors AS (
            SELECT f.id, f.parking_id FROM public.parking_floors f JOIN lots p ON p.id = f.parking_id WHERE f.archived_at IS NULL
        ), slots AS (
            SELECT s.*, EXISTS(SELECT 1 FROM public.rental_contracts c WHERE c.slot_id = s.id AND c.status = 'confirmed'
                AND c.starts_at <= NOW() AND c.ends_at > NOW()) AS occupied
            FROM public.parking_slots s JOIN floors f ON f.id = s.floor_id AND f.parking_id = s.parking_id WHERE s.archived_at IS NULL
        ), contracts AS (
            SELECT * FROM public.rental_contracts WHERE owner_id = $1 AND ($2::integer IS NULL OR parking_id = $2)
        ) SELECT NOW() AS as_of,
            (SELECT COUNT(*)::integer FROM lots) AS total_parking_lots,
            (SELECT COUNT(*)::integer FROM floors) AS total_floors,
            (SELECT COUNT(*)::integer FROM slots) AS total_slots,
            (SELECT COUNT(*)::integer FROM slots WHERE occupied) AS occupied_slots,
            (SELECT COUNT(*)::integer FROM slots WHERE NOT occupied AND operational_status = 'usable') AS available_slots,
            (SELECT COUNT(*)::integer FROM slots WHERE operational_status = 'maintenance') AS maintenance_slots,
            (SELECT COUNT(*)::integer FROM slots WHERE operational_status = 'usable') AS usable_slots,
            (SELECT COUNT(*)::integer FROM public.customers WHERE owner_id = $1 AND archived_at IS NULL) AS total_customers,
            (SELECT COUNT(*)::integer FROM contracts WHERE status = 'confirmed' AND starts_at <= NOW() AND ends_at > NOW()) AS active_contracts,
            (SELECT COUNT(*)::integer FROM contracts WHERE status = 'confirmed' AND starts_at > NOW()) AS upcoming_contracts,
            (SELECT COUNT(*)::integer FROM contracts WHERE status = 'confirmed' AND ends_at <= NOW()) AS expired_contracts,
            (SELECT COUNT(*)::integer FROM contracts WHERE status = 'ended') AS ended_contracts,
            (SELECT COUNT(*)::integer FROM contracts WHERE status = 'cancelled') AS cancelled_contracts,
            (SELECT COUNT(*)::integer FROM contracts WHERE status = 'confirmed' AND ends_at > NOW()
                AND ends_at <= NOW() + make_interval(days => $3::integer)) AS expiring_soon_contracts`, [ownerId, parkingId, expiringDays]);
        const floors = await client.query(`SELECT f.id, f.parking_id, f.floor_number, f.label,
            COUNT(s.id)::integer AS total_slots,
            COUNT(s.id) FILTER (WHERE s.operational_status = 'maintenance')::integer AS maintenance_slots,
            COUNT(s.id) FILTER (WHERE s.operational_status = 'usable')::integer AS usable_slots,
            COUNT(s.id) FILTER (WHERE EXISTS(SELECT 1 FROM public.rental_contracts c WHERE c.slot_id = s.id
                AND c.status = 'confirmed' AND c.starts_at <= NOW() AND c.ends_at > NOW()))::integer AS occupied_slots
            FROM public.parking_floors f JOIN public.parkings p ON p.id = f.parking_id
            LEFT JOIN public.parking_slots s ON s.floor_id = f.id AND s.parking_id = f.parking_id AND s.archived_at IS NULL
            WHERE p.owner_id = $1 AND ($2::integer IS NULL OR p.id = $2) AND p.archived_at IS NULL AND f.archived_at IS NULL
            GROUP BY f.id ORDER BY f.parking_id, f.floor_number`, [ownerId, parkingId]);
        const summary = result.rows[0];
        const percentage = (occupied, usable) => usable ? Math.round(occupied * 10000 / usable) / 100 : 0;
        return { ...summary, occupancy_percentage: percentage(summary.occupied_slots, summary.usable_slots),
            floors: floors.rows.map(row => ({ ...row, available_slots: row.usable_slots - row.occupied_slots,
                occupancy_percentage: percentage(row.occupied_slots, row.usable_slots) })) };
    });
}
module.exports = { availability, dashboard };
