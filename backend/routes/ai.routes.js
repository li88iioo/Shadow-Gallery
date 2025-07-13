/**
 * AI功能路由模块
 * 处理AI相关的API请求，包括图片标题生成和任务状态查询
 */
const express = require('express');
const router = express.Router();
const aiController = require('../controllers/ai.controller');

// AI标题生成路由
// 接收图片路径和AI配置，创建异步任务生成图片描述
router.post('/generate', aiController.generateCaption);

// AI任务状态查询路由
// 根据任务ID查询AI处理任务的状态和结果
router.get('/job/:jobId', aiController.getJobStatus);

// 导出AI路由模块
module.exports = router;