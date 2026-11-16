const pool = require('../Database/db');
const service = require('../Service/rentalService');
const input = require('../Utils/input');
const { HttpError, sendError } = require('../Utils/httpErrors');
function failure(res, error) {
    if (!error.rollbackFailed && error.code === '23505' && error.constraint === 'parking_slots_parking_id_code_key') {
        return res.status(409).json({ message: 'This slot code already exists in this parking lot' });
    }
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
            const expiringDays = req.query?.expiring_days === undefined ? null : Number(req.query.expiring_days);
            if (expiringDays !== null && (typeof req.query.expiring_days !== 'string' || !/^\d+$/.test(req.query.expiring_days)
                || !Number.isInteger(expiringDays) || expiringDays < 1 || expiringDays > 365)) {
                throw new HttpError(400, 'expiring_days must be 1–365');
            }
            if (status !== null && !['upcoming','active','expired','ended','cancelled'].includes(status)) throw new HttpError(400, 'Invalid status');
            const result = await pool.query(`SELECT * FROM public.rental_contract_details
                WHERE owner_id = $1 AND ($2::integer IS NULL OR parking_id = $2)
                AND ($3::integer IS NULL OR customer_id = $3) AND ($4::text IS NULL OR current_status = $4)
                AND ($7::integer IS NULL OR (status = 'confirmed' AND ends_at > NOW() AND ends_at <= NOW() + make_interval(days => $7::integer)))
                ORDER BY id DESC LIMIT $5 OFFSET $6`, [req.user.id, parkingId, customerId, status, limit, offset, expiringDays]);
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
for (const action of ['cancel', 'end', 'extend', 'renew', 'move']) {
    rentalController[action] = async (req, res) => {
        try {
            const contractId = input.id(req.params.id, 'contract ID');
            const contract = await require('../Service/rentalLifecycle').run(req.user.id, contractId, action, req.body);
            return res.status(action === 'renew' || action === 'move' ? 201 : 200).json({ contract });
        } catch (error) { return failure(res, error); }
    };
}
module.exports = { ...rentalController, failure };
