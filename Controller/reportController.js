const input = require('../Utils/input');
const { timestamp } = require('../Utils/rentalValidation');
const { HttpError, sendError } = require('../Utils/httpErrors');
const reports = require('../Service/parkingReports');

module.exports = {
    availability: async (req, res) => {
        try {
            const parkingId = input.id(req.params.parkingId, 'parking ID');
            const floorId = req.query.floor_id === undefined ? null : input.id(req.query.floor_id, 'floor ID');
            const start = timestamp(req.query.starts_at, 'starts_at');
            const end = timestamp(req.query.ends_at, 'ends_at');
            if (end <= start) throw new HttpError(400, 'ends_at must be after starts_at');
            const [limit, offset] = input.page(req.query);
            return res.json(await reports.availability(req.user.id, parkingId, floorId, start, end, limit, offset));
        } catch (error) { return sendError(res, error); }
    },
    dashboard: async (req, res) => {
        try {
            const raw = req.params?.parkingId ?? req.query?.parking_id;
            const parkingId = raw === undefined ? null : input.id(raw, 'parking ID');
            const days = req.query?.expiring_days === undefined ? 7 : Number(req.query.expiring_days);
            if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'expiring_days must be 1–365');
            return res.json(await reports.dashboard(req.user.id, parkingId, days));
        } catch (error) { return sendError(res, error); }
    }
};
