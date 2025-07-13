/**
 * 缩略图路由模块
 * 处理缩略图生成和获取相关的API请求
 */
const express = require('express');
const router = express.Router();
const thumbnailController = require('../controllers/thumbnail.controller');

// 缩略图获取路由
// 根据查询参数中的文件路径生成或获取对应的缩略图
router.get('/', thumbnailController.getThumbnail);

// 导出缩略图路由模块
module.exports = router;