const express = require('express');
const router = express.Router();
const statusController = require('../controllers/status.controller');

router.get('/indexing', statusController.getIndexingStatus);

module.exports = router;