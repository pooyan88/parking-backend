const pool = require('../Database/db');
const express = require('express');

const parkingController = {
    getAllParkings: async (req, res) => { 
        try {
            const result = await pool.query('SELECT * FROM parkings');
            res.json(result.rows);
        } catch(error) {
            console.error('Error fetching parkings:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}

module.exports = parkingController;