const pool = require('../Database/db');

const parkingController = {
    getAllParkings: async (req, res) => { 
        try {
            const result = await pool.query(
                `SELECT id, name, location
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
    }
}

module.exports = parkingController;
