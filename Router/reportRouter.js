const router = require('express').Router();
const auth = require('../Middleware/authMiddleware');
const controller = require('../Controller/reportController');
router.get('/parkings/:parkingId/slots/availability', auth, controller.availability);
router.get('/dashboard', auth, controller.dashboard);
router.get('/parkings/:parkingId/statistics', auth, controller.dashboard);
module.exports = router;
