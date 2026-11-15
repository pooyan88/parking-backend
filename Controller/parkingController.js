const pool = require('../Database/db');

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

        if (
            typeof name !== 'string' ||
            typeof location !== 'string' ||
            !name.trim() ||
            !location.trim()
        ) {
            return res.status(400).json({
                message: 'Name and location are required and must be non-empty strings'
            });
        }

        const parkingName = name.trim();
        const parkingLocation = location.trim();

        if ([...parkingName].length > 255 || [...parkingLocation].length > 255) {
            return res.status(400).json({
                message: 'Name and location must be at most 255 characters'
            });
        }

        if (parkingName.includes('\0') || parkingLocation.includes('\0')) {
            return res.status(400).json({
                message: 'Name and location must not contain null characters'
            });
        }

        try {
            const result = await pool.query(
                `INSERT INTO public.parkings (name, location, owner_id)
                 VALUES ($1, $2, $3)
                 RETURNING id, name, location, created_at`,
                [parkingName, parkingLocation, req.user.id]
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
    }
}

module.exports = parkingController;
