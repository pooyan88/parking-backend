const express = require('express');
const controller = require('../Controller/parkingSlotController');
const authMiddleware = require('../Middleware/authMiddleware');

const router = express.Router();

router.get('/parkings/:parkingId/floors/:floorId/slots', authMiddleware, controller.getSlots);
router.post('/parkings/:parkingId/floors/:floorId/slots', authMiddleware, controller.createSlots);
router.patch('/parkings/:parkingId/floors/:floorId/slots/:slotId', authMiddleware, controller.updateSlot);
router.delete('/parkings/:parkingId/floors/:floorId/slots/:slotId', authMiddleware, controller.archiveSlot);

module.exports = router;
