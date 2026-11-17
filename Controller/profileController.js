const pool = require('../Database/db');
const { transaction } = require('../Database/transaction');
const { HttpError, sendError } = require('../Utils/httpErrors');
const input = require('../Utils/input');

const profileQuery = `SELECT user_id, username, phone_number,
    COALESCE(name, 'کاربر جدید') AS name,
    COALESCE(family_name, 'کاربر جدید') AS family_name,
    created_at, updated_at
    FROM public.user_profiles WHERE user_id = $1`;

function optionalName(value, field) {
    if (value === null) return null;
    if (typeof value !== 'string' || [...value.trim()].length > 255 || value.includes('\0')) {
        throw new HttpError(400, `${field} must be text up to 255 characters or null`);
    }
    return value.trim() || null;
}

function failure(res, error) {
    if (!error.rollbackFailed && error.code === '23505' &&
        ['users_phone_number_key', 'user_profiles_phone_number_key'].includes(error.constraint)) {
        return res.status(409).json({ message: 'Phone number already exists' });
    }
    return sendError(res, error);
}

module.exports = {
    get: async (req, res) => {
        try {
            const result = await pool.query(profileQuery, [req.user.id]);
            if (!result.rows.length) throw new HttpError(404, 'Profile not found');
            return res.json(result.rows[0]);
        } catch (error) { return failure(res, error); }
    },
    update: async (req, res) => {
        try {
            const body = input.object(req.body, ['phone_number', 'name', 'family_name']);
            if (!Object.keys(body).length) throw new HttpError(400, 'Provide at least one profile field');
            const hasPhone = Object.hasOwn(body, 'phone_number');
            const hasName = Object.hasOwn(body, 'name');
            const hasFamily = Object.hasOwn(body, 'family_name');
            const phone = hasPhone ? input.text(body.phone_number, 'phone_number') : null;
            const name = hasName ? optionalName(body.name, 'name') : null;
            const family = hasFamily ? optionalName(body.family_name, 'family_name') : null;
            const profile = await transaction(pool, async client => {
                const updated = await client.query(`UPDATE public.users
                    SET phone_number = CASE WHEN $2::boolean THEN $3 ELSE phone_number END,
                        name = CASE WHEN $4::boolean THEN $5 ELSE name END,
                        family_name = CASE WHEN $6::boolean THEN $7 ELSE family_name END
                    WHERE id = $1 RETURNING id`,
                    [req.user.id, hasPhone, phone, hasName, name, hasFamily, family]);
                if (!updated.rows.length) throw new HttpError(404, 'Profile not found');
                const result = await client.query(profileQuery, [req.user.id]);
                if (!result.rows.length) throw new HttpError(404, 'Profile not found');
                return result.rows[0];
            });
            return res.json({ message: 'Profile updated successfully', profile });
        } catch (error) { return failure(res, error); }
    }
};
