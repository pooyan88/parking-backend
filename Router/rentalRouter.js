const router = require('express').Router();
const auth = require('../Middleware/authMiddleware');
const controller = require('../Controller/rentalController');
router.use('/contracts', auth);
router.post('/contracts', controller.create);
router.get('/contracts', controller.list);
router.get('/contracts/:id', controller.get);
router.get('/contracts/:id/events', controller.events);
module.exports = router;
