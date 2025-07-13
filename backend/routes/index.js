/**
 * 主路由模块
 * 整合所有子路由模块，提供统一的API入口点
 */
const express = require('express');
const router = express.Router();

// 导入各个功能模块的路由
const browseRoutes = require('./browse.routes');      // 文件浏览路由
const searchRoutes = require('./search.routes');      // 搜索功能路由
const thumbnailRoutes = require('./thumbnail.routes'); // 缩略图路由
const aiRoutes = require('./ai.routes');              // AI功能路由
const settingsRoutes = require('./settings.routes');  // 设置管理路由

// 注册各个子路由模块
// 每个路由模块处理特定功能的API请求
router.use('/browse', browseRoutes);        // 文件浏览相关API
router.use('/search', searchRoutes);        // 搜索相关API
router.use('/thumbnail', thumbnailRoutes);  // 缩略图相关API
router.use('/ai', aiRoutes);                // AI功能相关API
router.use('/settings', settingsRoutes);    // 设置管理相关API
router.use('/albums', require('./album.routes')); // 相册相关API

// 导出主路由模块
module.exports = router;