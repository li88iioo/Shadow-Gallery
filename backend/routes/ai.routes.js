const express = require('express');
const router = express.Router();
const aiController = require('../controllers/ai.controller');

router.post('/generate', aiController.generateCaption);
router.get('/job/:jobId', aiController.getJobStatus);

module.exports = router;