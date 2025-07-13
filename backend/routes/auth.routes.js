/**
 * 认证路由模块
 * 处理用户认证相关的API请求，包括登录状态检查和用户登录
 */
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

// 定义认证相关的路由端点
router.get('/status', authController.getAuthStatus);  // 获取认证状态
router.post('/login', authController.login);          // 用户登录

// 导出认证路由模块
module.exports = router;