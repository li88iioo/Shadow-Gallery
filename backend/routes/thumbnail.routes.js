const express = require('express');
const router = express.Router();
const thumbnailController = require('../controllers/thumbnail.controller');

router.get('/', thumbnailController.getThumbnail);

module.exports = router;