const pool = require('../Database/db');
const { transaction } = require('../Database/transaction');
const { HttpError, sendError } = require('../Utils/httpErrors');
const input = require('../Utils/input');
const { assertNoBookings } = require('../Service/rentalGuards');

function validate(body, partial = false) {
    input.object(body, ['name', 'customer_code', 'phone_number']);
    if (partial && !Object.keys(body).length) throw new HttpError(400, 'Provide at least one customer field');
    const name = !partial || Object.hasOwn(body, 'name') ? input.text(body.name, 'name') : null;
    const code = !partial || Object.hasOwn(body, 'customer_code') ? input.text(body.customer_code, 'customer_code', 100) : null;
    const hasPhone = Object.hasOwn(body, 'phone_number');
    const phone = !hasPhone || body.phone_number === null ? null : input.text(body.phone_number, 'phone_number', 50);
    return { name, code, hasPhone, phone };
}
function failure(res, error) {
    if (!error.rollbackFailed && error.code === '23505' && error.constraint === 'customers_owner_code_key') {
        return res.status(409).json({ message: 'Customer code already exists for this owner' });
    }
    if (error.code === '23503' && error.constraint === 'customers_owner_id_fkey') {
        return res.status(401).json({ message: 'Authenticated user no longer exists' });
    }
    return sendError(res, error);
}
const customerController = {
    create: async (req, res) => {
        try {
            const value = validate(req.body);
            const result = await pool.query(`INSERT INTO public.customers (owner_id, name, customer_code, phone_number)
                VALUES ($1, $2, $3, $4) RETURNING id, name, customer_code, phone_number, created_at, updated_at`,
                [req.user.id, value.name, value.code, value.phone]);
            return res.status(201).json({ message: 'Customer created successfully', customer: result.rows[0] });
        } catch (error) { return failure(res, error); }
    },
    list: async (req, res) => {
        try {
            const [limit, offset] = input.page(req.query);
            const result = await pool.query(`SELECT id, name, customer_code, phone_number, created_at, updated_at
                FROM public.customers WHERE owner_id = $1 AND archived_at IS NULL ORDER BY id LIMIT $2 OFFSET $3`,
                [req.user.id, limit, offset]);
            return res.json(result.rows);
        } catch (error) { return failure(res, error); }
    },
    get: async (req, res) => {
        try {
            const customerId = input.id(req.params.id, 'customer ID');
            const result = await pool.query(`SELECT id, name, customer_code, phone_number, created_at, updated_at
                FROM public.customers WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`, [customerId, req.user.id]);
            if (!result.rows.length) throw new HttpError(404, 'Customer not found');
            return res.json(result.rows[0]);
        } catch (error) { return failure(res, error); }
    },
    update: async (req, res) => {
        try {
            const customerId = input.id(req.params.id, 'customer ID');
            const value = validate(req.body, true);
            const result = await pool.query(`UPDATE public.customers SET name = COALESCE($1, name),
                customer_code = COALESCE($2, customer_code), phone_number = CASE WHEN $3::boolean THEN $4 ELSE phone_number END,
                updated_at = NOW() WHERE id = $5 AND owner_id = $6 AND archived_at IS NULL
                RETURNING id, name, customer_code, phone_number, created_at, updated_at`,
                [value.name, value.code, value.hasPhone, value.phone, customerId, req.user.id]);
            if (!result.rows.length) throw new HttpError(404, 'Customer not found');
            return res.json({ message: 'Customer updated successfully', customer: result.rows[0] });
        } catch (error) { return failure(res, error); }
    },
    archive: async (req, res) => {
        try {
            const customerId = input.id(req.params.id, 'customer ID');
            await transaction(pool, async client => {
                const result = await client.query(`SELECT id FROM public.customers WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
                    [customerId, req.user.id]);
                if (!result.rows.length) throw new HttpError(404, 'Customer not found');
                await assertNoBookings(client, { ownerId: req.user.id, customerId });
                await client.query(`UPDATE public.customers SET archived_at = COALESCE(archived_at, NOW()) WHERE id = $1`, [customerId]);
            });
            return res.status(204).send();
        } catch (error) { return failure(res, error); }
    }
};
module.exports = customerController;
