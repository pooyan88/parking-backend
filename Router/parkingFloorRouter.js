const express = require('express');
const controller = require('../Controller/parkingFloorController');
const authMiddleware = require('../Middleware/authMiddleware');

const router = express.Router();

router.get('/parkings/:parkingId/floors', authMiddleware, controller.getFloors);
router.post('/parkings/:parkingId/floors', authMiddleware, controller.createFloor);
router.patch('/parkings/:parkingId/floors/:floorId', authMiddleware, controller.updateFloor);
router.delete('/parkings/:parkingId/floors/:floorId', authMiddleware, controller.archiveFloor);

module.exports = router;
