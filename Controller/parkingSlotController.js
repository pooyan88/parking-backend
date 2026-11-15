const pool = require('../Database/db');
const { parseParkingId } = require('../Utils/parkingValidation');
const { validateParkingSlot } = require('../Utils/parkingSlotValidation');
const { transaction } = require('../Database/transaction');
const { HttpError, sendError } = require('../Utils/httpErrors');

const parkingSlotController = {
    getSlots: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        const floorId = parseParkingId(req.params?.floorId);
        if (parkingId === null || floorId === null) {
            return res.status(400).json({ message: 'Parking ID and floor ID must be positive integers up to 2147483647' });
        }

        try {
            // An accessible empty floor returns one null slot, while an
            // inaccessible parent chain returns no rows.
            const result = await pool.query(
                `SELECT s.id, s.parking_id, s.floor_id, s.code, s.operational_status,
                        s.maintenance_note, s.created_at
                 FROM public.parkings p
                 JOIN public.parking_floors f
                   ON f.parking_id = p.id AND f.id = $2 AND f.archived_at IS NULL
                 LEFT JOIN public.parking_slots s
                   ON s.parking_id = p.id AND s.floor_id = f.id AND s.archived_at IS NULL
                 WHERE p.id = $1 AND p.owner_id = $3 AND p.archived_at IS NULL
                 ORDER BY LOWER(s.code), s.id`,
                [parkingId, floorId, req.user.id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ message: 'Parking floor not found' });
            }
            return res.status(200).json(result.rows.filter(row => row.id !== null));
        } catch (error) {
            console.error('Error listing parking slots:', error.message);
            return res.status(500).json({ message: 'Internal server error' });
        }
    },

    createSlot: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        const floorId = parseParkingId(req.params?.floorId);
        if (parkingId === null || floorId === null) {
            return res.status(400).json({ message: 'Parking ID and floor ID must be positive integers up to 2147483647' });
        }
        const details = validateParkingSlot(req.body);
        if (details.error) return res.status(400).json({ message: details.error });

        let client;
        let transactionStarted = false;
        let connectionError;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            transactionStarted = true;
            // Keep the lock order consistent: parking lot first, then floor.
            const parking = await client.query(
                `SELECT id FROM public.parkings
                 WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL
                 FOR UPDATE`,
                [parkingId, req.user.id]
            );
            if (parking.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking floor not found' });
            }
            const floor = await client.query(
                `SELECT id FROM public.parking_floors
                 WHERE id = $1 AND parking_id = $2 AND archived_at IS NULL
                 FOR UPDATE`,
                [floorId, parkingId]
            );
            if (floor.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking floor not found' });
            }

            const result = await client.query(
                `INSERT INTO public.parking_slots (parking_id, floor_id, code)
                 VALUES ($1, $2, $3)
                 RETURNING id, parking_id, floor_id, code, operational_status, maintenance_note, created_at`,
                [parkingId, floorId, details.code]
            );
            await client.query('COMMIT');
            transactionStarted = false;
            return res.status(201).json({ message: 'Parking slot created successfully', slot: result.rows[0] });
        } catch (error) {
            if (client && transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    connectionError = rollbackError;
                    console.error('Parking slot rollback error:', rollbackError.message);
                }
            }
            console.error('Error creating parking slot:', error.message);
            if (!connectionError && error.code === '23505' && error.constraint === 'parking_slots_parking_id_code_key') {
                return res.status(409).json({ message: 'This slot code already exists in this parking lot' });
            }
            return res.status(500).json({ message: 'Internal server error' });
        } finally {
            if (client) client.release(connectionError);
        }
    },

    updateSlot: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        const floorId = parseParkingId(req.params?.floorId);
        const slotId = parseParkingId(req.params?.slotId);
        if (parkingId === null || floorId === null || slotId === null) {
            return res.status(400).json({ message: 'Parking, floor, and slot IDs must be positive integers up to 2147483647' });
        }
        const details = validateParkingSlot(req.body, { partial: true });
        if (details.error) return res.status(400).json({ message: details.error });

        let client;
        let transactionStarted = false;
        let connectionError;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            transactionStarted = true;
            const parking = await client.query(
                `SELECT id FROM public.parkings
                 WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL
                 FOR UPDATE`,
                [parkingId, req.user.id]
            );
            if (parking.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking slot not found' });
            }
            const floor = await client.query(
                `SELECT id FROM public.parking_floors
                 WHERE id = $1 AND parking_id = $2 AND archived_at IS NULL
                 FOR UPDATE`,
                [floorId, parkingId]
            );
            if (floor.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking slot not found' });
            }
            const slot = await client.query(
                `SELECT id, operational_status, maintenance_note FROM public.parking_slots
                 WHERE id = $1 AND floor_id = $2 AND parking_id = $3 AND archived_at IS NULL
                 FOR UPDATE`,
                [slotId, floorId, parkingId]
            );
            if (slot.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking slot not found' });
            }

            const status = details.operationalStatus ?? slot.rows[0].operational_status;
            if (status === 'usable' && details.hasMaintenanceNote && details.maintenanceNote !== null) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(400).json({ message: 'Maintenance notes can only be set for slots under maintenance' });
            }
            const note = status === 'usable' ? null
                : details.hasMaintenanceNote ? details.maintenanceNote : slot.rows[0].maintenance_note;
            const result = await client.query(
                `UPDATE public.parking_slots
                 SET code = COALESCE($1, code), operational_status = $2, maintenance_note = $3
                 WHERE id = $4 AND floor_id = $5 AND parking_id = $6 AND archived_at IS NULL
                 RETURNING id, parking_id, floor_id, code, operational_status, maintenance_note, created_at`,
                [details.code ?? null, status, note, slotId, floorId, parkingId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking slot not found' });
            }
            await client.query('COMMIT');
            transactionStarted = false;
            return res.status(200).json({ message: 'Parking slot updated successfully', slot: result.rows[0] });
        } catch (error) {
            if (client && transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    connectionError = rollbackError;
                    console.error('Parking slot update rollback error:', rollbackError.message);
                }
            }
            console.error('Error updating parking slot:', error.message);
            if (!connectionError && error.code === '23505' && error.constraint === 'parking_slots_parking_id_code_key') {
                return res.status(409).json({ message: 'This slot code already exists in this parking lot' });
            }
            return res.status(500).json({ message: 'Internal server error' });
        } finally {
            if (client) client.release(connectionError);
        }
    },

    archiveSlot: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        const floorId = parseParkingId(req.params?.floorId);
        const slotId = parseParkingId(req.params?.slotId);
        if (parkingId === null || floorId === null || slotId === null) {
            return res.status(400).json({ message: 'Invalid parking, floor, or slot ID' });
        }
        try {
            await transaction(pool, async client => {
                const parking = await client.query(`SELECT id FROM public.parkings
                    WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL FOR UPDATE`, [parkingId, req.user.id]);
                if (!parking.rows.length) throw new HttpError(404, 'Parking slot not found');
                const floor = await client.query(`SELECT id FROM public.parking_floors
                    WHERE id = $1 AND parking_id = $2 AND archived_at IS NULL FOR UPDATE`, [floorId, parkingId]);
                if (!floor.rows.length) throw new HttpError(404, 'Parking slot not found');
                const result = await client.query(`UPDATE public.parking_slots
                    SET archived_at = COALESCE(archived_at, NOW())
                    WHERE id = $1 AND floor_id = $2 AND parking_id = $3 RETURNING id`, [slotId, floorId, parkingId]);
                if (!result.rows.length) throw new HttpError(404, 'Parking slot not found');
            });
            return res.status(204).send();
        } catch (error) { return sendError(res, error); }
    }
};

module.exports = parkingSlotController;
