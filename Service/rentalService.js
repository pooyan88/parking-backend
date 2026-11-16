const pool = require('../Database/db');
const { transaction } = require('../Database/transaction');
const { HttpError } = require('../Utils/httpErrors');
const validation = require('../Utils/rentalValidation');

async function lockResources(client, ownerId, slotIds) {
    const ids = [...new Set(slotIds)].sort((a, b) => a - b);
    const found = await client.query(`SELECT s.id, s.floor_id, s.parking_id FROM public.parking_slots s
        JOIN public.parkings p ON p.id = s.parking_id WHERE s.id = ANY($1::integer[]) AND p.owner_id = $2`, [ids, ownerId]);
    if (found.rows.length !== ids.length) throw new HttpError(404, 'Parking slot not found');
    const parkingIds = [...new Set(found.rows.map(row => row.parking_id))].sort((a, b) => a - b);
    const floorIds = [...new Set(found.rows.map(row => row.floor_id))].sort((a, b) => a - b);
    const parkings = await client.query(`SELECT * FROM public.parkings WHERE id = ANY($1::integer[])
        AND owner_id = $2 AND archived_at IS NULL ORDER BY id FOR UPDATE`, [parkingIds, ownerId]);
    if (parkings.rows.length !== parkingIds.length) throw new HttpError(404, 'Parking slot not found');
    const floors = await client.query(`SELECT * FROM public.parking_floors WHERE id = ANY($1::integer[])
        AND archived_at IS NULL ORDER BY id FOR UPDATE`, [floorIds]);
    const slots = await client.query(`SELECT * FROM public.parking_slots WHERE id = ANY($1::integer[])
        AND archived_at IS NULL ORDER BY id FOR UPDATE`, [ids]);
    if (floors.rows.length !== floorIds.length || slots.rows.length !== ids.length || slots.rows.some(slot =>
        !parkings.rows.some(p => p.id === slot.parking_id) || !floors.rows.some(f => f.id === slot.floor_id && f.parking_id === slot.parking_id))) {
        throw new HttpError(404, 'Parking slot not found');
    }
    return { parkings: parkings.rows, slots: slots.rows };
}
async function lockCustomer(client, ownerId, customerId) {
    const result = await client.query(`SELECT id FROM public.customers
        WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL FOR UPDATE`, [customerId, ownerId]);
    if (!result.rows.length) throw new HttpError(404, 'Customer not found');
}
async function calendarEnd(client, anchor, months, zone) {
    const result = await client.query(`SELECT (($1::timestamptz AT TIME ZONE $3::text)
        + make_interval(months => $2::integer)) AT TIME ZONE $3::text AS ends_at`, [anchor, months, zone]);
    const end = result.rows[0].ends_at;
    if (!Number.isFinite(end.getTime()) || end.getUTCFullYear() > 9999) throw new HttpError(400, 'Rental end is outside the supported range');
    return end;
}
async function event(client, ownerId, contractId, type, before, after) {
    await client.query(`INSERT INTO public.contract_events (owner_id, contract_id, event_type, before_values, after_values)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`, [ownerId, contractId, type, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
}
async function insert(client, ownerId, details) {
    const result = await client.query(`INSERT INTO public.rental_contracts
        (owner_id, parking_id, customer_id, slot_id, rental_type, starts_at, ends_at, timezone, period_months,
         billing_anchor_at, billing_month_offset, agreed_price, currency, previous_contract_id, link_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [ownerId, details.parkingId, details.customerId, details.slotId, details.rentalType, details.startsAt, details.endsAt,
            details.timezone, details.periodMonths, details.billingAnchor ?? details.startsAt, details.monthOffset ?? 0,
            details.agreedPrice, details.currency, details.previousId ?? null, details.linkType ?? null]);
    return result.rows[0];
}
async function details(client, ownerId, contractId) {
    const result = await client.query('SELECT * FROM public.rental_contract_details WHERE id = $1 AND owner_id = $2', [contractId, ownerId]);
    if (!result.rows.length) throw new HttpError(404, 'Rental contract not found');
    const row = result.rows[0];
    delete row.rental_period;
    return row;
}
async function create(ownerId, body) {
    const value = validation.creation(body);
    return transaction(pool, async client => {
        const resources = await lockResources(client, ownerId, [value.slotId]);
        if (resources.slots[0].operational_status !== 'usable') throw new HttpError(409, 'Slot is under maintenance');
        await lockCustomer(client, ownerId, value.customerId);
        value.timezone = value.timezone ?? resources.parkings[0].timezone;
        value.parkingId = resources.slots[0].parking_id;
        if (value.periodMonths) value.endsAt = await calendarEnd(client, value.startsAt, value.periodMonths, value.timezone);
        const row = await insert(client, ownerId, value);
        await event(client, ownerId, row.id, 'created', null, row);
        return details(client, ownerId, row.id);
    });
}
module.exports = { create, lockResources, lockCustomer, calendarEnd, event, insert, details };
