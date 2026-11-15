const express = require('express');
const controller = require('../Controller/parkingController');
const authMiddleware = require('../Middleware/authMiddleware');

const router = express.Router();

router.get('/parkings', authMiddleware, controller.getAllParkings);
router.post('/parkings', authMiddleware, controller.createParking);
router.patch('/parkings/:id', authMiddleware, controller.updateParking);
router.delete('/parkings/:id', authMiddleware, controller.archiveParking);

module.exports = router;
