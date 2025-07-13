/**
 * 设置管理路由模块
 * 处理系统设置相关的API请求，包括获取、更新和状态查询
 */
const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');

// 定义获取和更新设置的路由端点
router.get('/', settingsController.getSettingsForClient);     // 获取客户端设置
router.post('/', settingsController.updateSettings);          // 更新系统设置
router.get('/status', settingsController.getSettingsUpdateStatus); // 获取设置更新状态

// 导出设置路由模块
module.exports = router;