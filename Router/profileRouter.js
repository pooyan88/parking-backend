const router = require('express').Router();
const auth = require('../Middleware/authMiddleware');
const controller = require('../Controller/profileController');

router.get('/profile', auth, controller.get);
router.patch('/profile', auth, controller.update);

module.exports = router;
