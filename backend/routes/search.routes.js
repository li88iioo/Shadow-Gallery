/**
 * 搜索路由模块
 * 处理文件搜索相关的API请求，支持全文搜索和结果缓存
 */
const express = require('express');
const router = express.Router();
const searchController = require('../controllers/search.controller');
const cache = require('../middleware/cache');

// 搜索功能路由（缓存1小时）
// 为搜索结果应用3600秒（1小时）的缓存，减少重复搜索的服务器负载
// 提高搜索响应速度，特别是对于相同关键词的重复搜索
router.get('/', cache(3600), searchController.searchItems);

// 导出搜索路由模块
module.exports = router;