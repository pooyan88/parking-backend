const express = require('express');
const controller = require('../Controller/parkingController');
const authMiddleware = require('../Middleware/authMiddleware');

const router = express.Router();

router.get('/parkings', authMiddleware, controller.getAllParkings);

module.exports = router;