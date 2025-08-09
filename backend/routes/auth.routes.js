/**
 * 认证路由模块
 * 处理用户认证相关的API请求，包括登录状态检查和用户登录
 */
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const apiLimiter = require('../middleware/rateLimiter');
const { validate, Joi } = require('../middleware/validation');

// 定义认证相关的路由端点
router.get('/status', authController.getAuthStatus);  // 获取认证状态

// 登录参数校验
const loginSchema = Joi.object({
  password: Joi.string().min(4).max(256).required()
});

// 登录接口使用更严格的速率限制：在全局基础上再套一层更小窗口/更小配额（覆盖默认配置）
router.post('/login', apiLimiter, validate(loginSchema), authController.login);          // 用户登录

// 导出认证路由模块
module.exports = router;