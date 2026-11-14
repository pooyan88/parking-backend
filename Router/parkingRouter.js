const controller = require('../Controller/parkingController');

const express = require('express');
const router = express.Router();

router.get('/parkings', controller.getAllParkings);

module.exports = router;