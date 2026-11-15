const pool = require('../Database/db');
const { validateParkingDetails } = require('../Utils/parkingValidation');

const parkingController = {
    getAllParkings: async (req, res) => { 
        try {
            const result = await pool.query(
                `SELECT id, name, location, created_at
                 FROM public.parkings
                 WHERE owner_id = $1
                 ORDER BY id`,
                [req.user.id]
            );
            res.json(result.rows);
        } catch(error) {
            console.error('Error fetching parkings:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    },

    createParking: async (req, res) => {
        const { name, location } = req.body ?? {};
        const details = validateParkingDetails({ name, location });

        if (details.error) return res.status(400).json({ message: details.error });

        try {
            const result = await pool.query(
                `INSERT INTO public.parkings (name, location, owner_id)
                 VALUES ($1, $2, $3)
                 RETURNING id, name, location, created_at`,
                [details.name, details.location, req.user.id]
            );

            return res.status(201).json({
                message: 'Parking lot created successfully',
                parking: result.rows[0]
            });
        } catch (error) {
            console.error('Error creating parking:', error.message);

            if (error.code === '23503' && error.constraint === 'parkings_owner_id_fkey') {
                return res.status(401).json({
                    message: 'Authenticated user no longer exists'
                });
            }

            return res.status(500).json({
                message: 'Internal server error'
            });
        }
    },

    updateParking: async (req, res) => {
        const id = req.params?.id;
        if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) {
            return res.status(400).json({ message: 'Parking ID must be a positive integer up to 2147483647' });
        }

        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({ message: 'Provide name, location, or both in a JSON object' });
        }

        const fields = Object.keys(req.body);
        if (fields.length === 0 || fields.some(field => !['name', 'location'].includes(field))) {
            return res.status(400).json({ message: 'Only name and location can be updated; provide at least one' });
        }

        const details = validateParkingDetails(req.body, { partial: true });
        if (details.error) return res.status(400).json({ message: details.error });

        try {
            const result = await pool.query(
                `UPDATE public.parkings
                 SET name = COALESCE($1, name), location = COALESCE($2, location)
                 WHERE id = $3 AND owner_id = $4
                 RETURNING id, name, location, created_at`,
                [details.name, details.location, Number(id), req.user.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ message: 'Parking lot not found' });
            }

            return res.status(200).json({
                message: 'Parking lot updated successfully',
                parking: result.rows[0]
            });
        } catch (error) {
            console.error('Error updating parking:', error.message);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
}

module.exports = parkingController;
