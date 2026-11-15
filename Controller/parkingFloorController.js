const pool = require('../Database/db');
const { parseParkingId } = require('../Utils/parkingValidation');
const { validateParkingFloor } = require('../Utils/parkingFloorValidation');

const parkingFloorController = {
    getFloors: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        if (parkingId === null) {
            return res.status(400).json({ message: 'Parking ID must be a positive integer up to 2147483647' });
        }

        try {
            // A LEFT JOIN returns one null floor for an accessible but empty
            // lot, and no rows for a missing, archived, or foreign-owned lot.
            const result = await pool.query(
                `SELECT f.id, f.parking_id, f.floor_number, f.label, f.created_at
                 FROM public.parkings p
                 LEFT JOIN public.parking_floors f
                   ON f.parking_id = p.id AND f.archived_at IS NULL
                 WHERE p.id = $1 AND p.owner_id = $2 AND p.archived_at IS NULL
                 ORDER BY f.floor_number, f.id`,
                [parkingId, req.user.id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ message: 'Parking lot not found' });
            }
            return res.status(200).json(result.rows.filter(row => row.id !== null));
        } catch (error) {
            console.error('Error listing parking floors:', error.message);
            return res.status(500).json({ message: 'Internal server error' });
        }
    },

    createFloor: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        if (parkingId === null) {
            return res.status(400).json({ message: 'Parking ID must be a positive integer up to 2147483647' });
        }
        const details = validateParkingFloor(req.body);
        if (details.error) return res.status(400).json({ message: details.error });

        let client;
        let transactionStarted = false;
        let connectionError;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            transactionStarted = true;

            // Archiving updates this same row and must wait until creation
            // commits or rolls back. Check ownership on this locked connection.
            const parking = await client.query(
                `SELECT id FROM public.parkings
                 WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL
                 FOR UPDATE`,
                [parkingId, req.user.id]
            );
            if (parking.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking lot not found' });
            }

            const result = await client.query(
                `INSERT INTO public.parking_floors (parking_id, floor_number, label)
                 VALUES ($1, $2, $3)
                 RETURNING id, parking_id, floor_number, label, created_at`,
                [parkingId, details.floorNumber, details.label]
            );
            await client.query('COMMIT');
            transactionStarted = false;
            return res.status(201).json({
                message: 'Parking floor created successfully',
                floor: result.rows[0]
            });
        } catch (error) {
            if (client && transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    connectionError = rollbackError;
                    console.error('Parking floor rollback error:', rollbackError.message);
                }
            }
            console.error('Error creating parking floor:', error.message);
            if (!connectionError && error.code === '23505' && error.constraint === 'parking_floors_parking_id_floor_number_key') {
                return res.status(409).json({ message: 'This floor number already exists in this parking lot' });
            }
            return res.status(500).json({ message: 'Internal server error' });
        } finally {
            if (client) client.release(connectionError);
        }
    },

    updateFloor: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        const floorId = parseParkingId(req.params?.floorId);
        if (parkingId === null || floorId === null) {
            return res.status(400).json({ message: 'Parking ID and floor ID must be positive integers up to 2147483647' });
        }
        const details = validateParkingFloor(req.body, { partial: true });
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
                return res.status(404).json({ message: 'Parking floor not found' });
            }

            const result = await client.query(
                `UPDATE public.parking_floors
                 SET floor_number = COALESCE($1, floor_number),
                     label = CASE WHEN $2::boolean THEN $3 ELSE label END
                 WHERE id = $4 AND parking_id = $5 AND archived_at IS NULL
                 RETURNING id, parking_id, floor_number, label, created_at`,
                [details.floorNumber ?? null, details.hasLabel, details.label, floorId, parkingId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking floor not found' });
            }
            await client.query('COMMIT');
            transactionStarted = false;
            return res.status(200).json({ message: 'Parking floor updated successfully', floor: result.rows[0] });
        } catch (error) {
            if (client && transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    connectionError = rollbackError;
                    console.error('Parking floor update rollback error:', rollbackError.message);
                }
            }
            console.error('Error updating parking floor:', error.message);
            if (!connectionError && error.code === '23505' && error.constraint === 'parking_floors_parking_id_floor_number_key') {
                return res.status(409).json({ message: 'This floor number already exists in this parking lot' });
            }
            return res.status(500).json({ message: 'Internal server error' });
        } finally {
            if (client) client.release(connectionError);
        }
    },

    archiveFloor: async (req, res) => {
        const parkingId = parseParkingId(req.params?.parkingId);
        const floorId = parseParkingId(req.params?.floorId);
        if (parkingId === null || floorId === null) {
            return res.status(400).json({ message: 'Parking ID and floor ID must be positive integers up to 2147483647' });
        }

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
                return res.status(404).json({ message: 'Parking floor not found' });
            }

            const result = await client.query(
                `UPDATE public.parking_floors
                 SET archived_at = COALESCE(archived_at, NOW())
                 WHERE id = $1 AND parking_id = $2
                 RETURNING id`,
                [floorId, parkingId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ message: 'Parking floor not found' });
            }
            await client.query('COMMIT');
            transactionStarted = false;
            return res.status(204).send();
        } catch (error) {
            if (client && transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    connectionError = rollbackError;
                    console.error('Parking floor archive rollback error:', rollbackError.message);
                }
            }
            console.error('Error archiving parking floor:', error.message);
            return res.status(500).json({ message: 'Internal server error' });
        } finally {
            if (client) client.release(connectionError);
        }
    }
};

module.exports = parkingFloorController;
