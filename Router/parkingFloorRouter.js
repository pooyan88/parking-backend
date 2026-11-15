const express = require('express');
const controller = require('../Controller/parkingFloorController');
const authMiddleware = require('../Middleware/authMiddleware');

const router = express.Router();

router.get('/parkings/:parkingId/floors', authMiddleware, controller.getFloors);
router.post('/parkings/:parkingId/floors', authMiddleware, controller.createFloor);

module.exports = router;
