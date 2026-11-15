const pool = require('../Database/db');
const service = require('../Service/rentalService');
const input = require('../Utils/input');
const { HttpError, sendError } = require('../Utils/httpErrors');
function failure(res, error) {
    if (!error.rollbackFailed && (error.code === '23P01' || error.constraint === 'rental_contracts_one_renewal_key')) {
        return res.status(409).json({ message: 'Slot period conflicts with another contract or renewal' });
    }
    return sendError(res, error);
}
const rentalController = {
    create: async (req, res) => {
        try { return res.status(201).json({ contract: await service.create(req.user.id, req.body) }); }
        catch (error) { return failure(res, error); }
    },
    get: async (req, res) => {
        try { return res.json(await service.details(pool, req.user.id, input.id(req.params.id, 'contract ID'))); }
        catch (error) { return failure(res, error); }
    },
    list: async (req, res) => {
        try {
            const [limit, offset] = input.page(req.query);
            const parkingId = req.query?.parking_id === undefined ? null : input.id(req.query.parking_id, 'parking ID');
            const customerId = req.query?.customer_id === undefined ? null : input.id(req.query.customer_id, 'customer ID');
            const status = req.query?.status ?? null;
            if (status !== null && !['upcoming','active','expired','ended','cancelled'].includes(status)) throw new HttpError(400, 'Invalid status');
            const result = await pool.query(`SELECT * FROM public.rental_contract_details
                WHERE owner_id = $1 AND ($2::integer IS NULL OR parking_id = $2)
                AND ($3::integer IS NULL OR customer_id = $3) AND ($4::text IS NULL OR current_status = $4)
                ORDER BY id DESC LIMIT $5 OFFSET $6`, [req.user.id, parkingId, customerId, status, limit, offset]);
            return res.json(result.rows.map(({ rental_period, ...row }) => row));
        } catch (error) { return failure(res, error); }
    },
    events: async (req, res) => {
        try {
            const contractId = input.id(req.params.id, 'contract ID');
            await service.details(pool, req.user.id, contractId);
            const [limit, offset] = input.page(req.query);
            const result = await pool.query(`SELECT id, event_type, before_values, after_values, created_at
                FROM public.contract_events WHERE contract_id = $1 AND owner_id = $2 ORDER BY id LIMIT $3 OFFSET $4`,
                [contractId, req.user.id, limit, offset]);
            return res.json(result.rows);
        } catch (error) { return failure(res, error); }
    }
};
module.exports = { ...rentalController, failure };
