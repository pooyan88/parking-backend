const { HttpError } = require('../Utils/httpErrors');

async function assertNoBookings(client, { ownerId, parkingId = null, floorId = null, slotId = null, customerId = null }) {
    const result = await client.query(`SELECT 1 FROM public.rental_contracts c
        JOIN public.parking_slots s ON s.id = c.slot_id AND s.parking_id = c.parking_id
        WHERE c.owner_id = $1 AND c.status = 'confirmed' AND c.ends_at > NOW()
          AND ($2::integer IS NULL OR c.parking_id = $2)
          AND ($3::integer IS NULL OR s.floor_id = $3)
          AND ($4::integer IS NULL OR c.slot_id = $4)
          AND ($5::integer IS NULL OR c.customer_id = $5) LIMIT 1`,
        [ownerId, parkingId, floorId, slotId, customerId]);
    if (result.rows.length) throw new HttpError(409, 'Resolve current or future rental contracts before this action');
}
module.exports = { assertNoBookings };
