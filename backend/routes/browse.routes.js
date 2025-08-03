/**
 * 文件浏览路由模块
 * 处理文件目录浏览相关的API请求，支持缓存和访问时间记录
 */
const express = require('express');
const router = express.Router();
const browseController = require('../controllers/browse.controller');
const { cache } = require('../middleware/cache');

// 更新文件访问时间的专用路由（不缓存）
// 用于记录用户查看特定文件或目录的时间
router.post('/viewed', browseController.updateViewTime);

// 文件浏览路由（缓存10分钟）
// 使用通配符 `*` 捕获所有路径，支持任意深度的目录浏览
// 缓存时间设置为600秒（10分钟），提高响应速度
router.get('/*', cache(600), browseController.browseDirectory);

// 导出浏览路由模块
module.exports = router;