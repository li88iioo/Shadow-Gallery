const express = require('express');
const router = express.Router();
const eventController = require('../controllers/event.controller.js');

// @route   GET /api/events
// @desc    建立 SSE 连接以接收服务器事件
// @access  Public
router.get('/', eventController.streamEvents);

module.exports = router;
