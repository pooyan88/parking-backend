
const express = require('express');
const authController = require('../Controller/authController');
const authMiddleware = require('../Middleware/authMiddleware');

const router = express.Router();

router.post('/auth/signup', authController.signup);
router.post('/auth/login', authController.login);
router.post('/auth/refresh', authController.refresh);
router.get('/auth/me', authMiddleware, authController.profile);

module.exports = router;
