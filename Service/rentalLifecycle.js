const pool = require('../Database/db');
const { transaction } = require('../Database/transaction');
const { HttpError } = require('../Utils/httpErrors');
const input = require('../Utils/input');
const validation = require('../Utils/rentalValidation');
const rentals = require('./rentalService');

async function lockedContract(client, ownerId, contractId, extraSlots) {
    const initial = await client.query('SELECT slot_id FROM public.rental_contracts WHERE id = $1 AND owner_id = $2', [contractId, ownerId]);
    if (!initial.rows.length) throw new HttpError(404, 'Rental contract not found');
    const resources = await rentals.lockResources(client, ownerId, [initial.rows[0].slot_id, ...extraSlots]);
    const current = await client.query(`SELECT c.*, date_trunc('milliseconds', NOW()) AS action_at FROM public.rental_contracts c
        WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [contractId, ownerId]);
    const source = current.rows[0];
    if (!source || !resources.slots.some(slot => slot.id === source.slot_id)) throw new HttpError(409, 'Contract changed; retry');
    return { source, resources };
}

async function run(ownerId, contractId, action, requestBody) {
    const body = requestBody ?? {};
    const allowed = {
        cancel: [], end: [], extend: ['ends_at', 'agreed_price', 'currency'],
        renew: ['rental_type', 'hours', 'ends_at', 'agreed_price', 'currency'],
        move: ['slot_id', 'slot_code', 'agreed_price', 'currency']
    };
    if (!Object.hasOwn(allowed, action)) throw new HttpError(400, 'Unknown contract action');
    input.object(body, allowed[action]);
    const targetId = action === 'move' ? input.id(body.slot_id, 'slot ID') : null;
    const targetCode = action === 'move' ? validation.assignmentCode(body) : undefined;
    const extensionEnd = action === 'extend' ? validation.timestamp(body.ends_at, 'ends_at') : null;
    return transaction(pool, async client => {
        const { source, resources } = await lockedContract(client, ownerId, contractId, targetId === null ? [] : [targetId]);
        const now = source.action_at;
        if (source.status !== 'confirmed') throw new HttpError(409, 'Contract is already cancelled or ended');
        if (action === 'cancel' || action === 'end') {
            if (action === 'cancel' && source.starts_at <= now) throw new HttpError(409, 'Only an upcoming contract can be cancelled');
            if (action === 'end' && (source.starts_at > now || source.ends_at <= now)) {
                throw new HttpError(409, 'Only a currently active contract can end early');
            }
            const result = action === 'cancel'
                ? await client.query(`UPDATE public.rental_contracts SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                    WHERE id = $1 AND owner_id = $2 RETURNING *`, [contractId, ownerId])
                : await client.query(`UPDATE public.rental_contracts SET status = 'ended', ended_at = $3, updated_at = NOW()
                    WHERE id = $1 AND owner_id = $2 RETURNING *`, [contractId, ownerId, now]);
            await rentals.event(client, ownerId, contractId, action === 'cancel' ? 'cancelled' : 'ended', source, result.rows[0]);
            return rentals.details(client, ownerId, contractId);
        }
        const money = validation.price(body, source);
        if (action === 'extend') {
            if (resources.slots.find(slot => slot.id === source.slot_id).operational_status !== 'usable') {
                throw new HttpError(409, 'Slot is under maintenance');
            }
            if (source.ends_at <= now || extensionEnd <= source.ends_at) throw new HttpError(409, 'Extend a non-expired contract to a later end');
            const result = await client.query(`UPDATE public.rental_contracts SET ends_at = $1, agreed_price = $2, currency = $3,
                rental_type = 'custom', period_months = NULL, billing_anchor_at = starts_at, billing_month_offset = 0, updated_at = NOW()
                WHERE id = $4 AND owner_id = $5 RETURNING *`, [extensionEnd, money.agreedPrice, money.currency, contractId, ownerId]);
            await rentals.event(client, ownerId, contractId, 'extended', source, result.rows[0]);
            return rentals.details(client, ownerId, contractId);
        }
        await rentals.lockCustomer(client, ownerId, source.customer_id);
        if (action === 'renew') {
            const slot = resources.slots.find(row => row.id === source.slot_id);
            if (slot.operational_status !== 'usable') throw new HttpError(409, 'Slot is under maintenance');
            if (!slot.code) throw new HttpError(409, 'Assign a code to the slot before renewing a contract');
            const spec = { ...body, rental_type: body.rental_type ?? source.rental_type };
            if (spec.rental_type === 'hourly' && source.rental_type === 'hourly' && spec.hours === undefined) {
                spec.hours = (source.ends_at - source.starts_at) / 3600000;
            }
            const period = validation.period(spec, source.ends_at);
            const carryAnchor = Boolean(source.period_months && period.periodMonths);
            const anchor = carryAnchor ? source.billing_anchor_at : source.ends_at;
            const offset = carryAnchor ? source.billing_month_offset + source.period_months : 0;
            if (period.periodMonths) period.endsAt = await rentals.calendarEnd(client, anchor, offset + period.periodMonths, source.timezone);
            const row = await rentals.insert(client, ownerId, { ...period, ...money,
                parkingId: source.parking_id, customerId: source.customer_id, slotId: source.slot_id,
                startsAt: source.ends_at, timezone: source.timezone, billingAnchor: anchor, monthOffset: offset,
                previousId: source.id, linkType: 'renewal', slotCode: slot.code });
            await rentals.event(client, ownerId, row.id, 'renewed', null, row);
            return rentals.details(client, ownerId, row.id);
        }
        if (targetId === source.slot_id) throw new HttpError(400, 'Choose a different slot');
        if (source.ends_at <= now) throw new HttpError(409, 'An expired contract cannot change slots');
        const target = resources.slots.find(row => row.id === targetId);
        if (target.operational_status !== 'usable') throw new HttpError(409, 'Target slot is under maintenance');
        const assignedCode = await rentals.assignCode(client,ownerId,target,targetCode);
        const upcoming = source.starts_at > now;
        const closed = upcoming
            ? await client.query(`UPDATE public.rental_contracts SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                WHERE id = $1 AND owner_id = $2 RETURNING *`, [contractId, ownerId])
            : await client.query(`UPDATE public.rental_contracts SET status = 'ended', ended_at = $3, updated_at = NOW()
                WHERE id = $1 AND owner_id = $2 RETURNING *`, [contractId, ownerId, now]);
        const row = await rentals.insert(client, ownerId, { ...money, parkingId: target.parking_id,
            customerId: source.customer_id, slotId: targetId, rentalType: source.period_months ? source.rental_type : 'custom',
            periodMonths: source.period_months, startsAt: upcoming ? source.starts_at : now, endsAt: source.ends_at,
            timezone: source.timezone, billingAnchor: source.billing_anchor_at, monthOffset: source.billing_month_offset,
            previousId: source.id, linkType: 'move', slotCode: assignedCode });
        await rentals.event(client, ownerId, source.id, 'moved_out', source, { ...closed.rows[0], moved_to_contract_id: row.id });
        await rentals.event(client, ownerId, row.id, 'moved_in', null, row);
        return rentals.details(client, ownerId, row.id);
    });
}
module.exports = { run };
