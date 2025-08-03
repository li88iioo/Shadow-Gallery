/**
 * Express应用主配置文件
 * 
 * 负责：
 * - Express应用实例创建和配置
 * - 中间件设置（CORS、JSON解析、速率限制等）
 * - 静态文件服务配置
 * - API路由注册和认证中间件
 * - 错误处理中间件
 * - 健康检查端点
 * 
 * @module app
 * @author Shadow Gallery
 * @version 1.0.0
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { PHOTOS_DIR, THUMBS_DIR } = require('./config');
const apiLimiter = require('./middleware/rateLimiter');
const mainRouter = require('./routes');
const logger = require('./config/logger');
const authMiddleware = require('./middleware/auth');
const authRouter = require('./routes/auth.routes');

/**
 * Express应用实例
 * @type {express.Application}
 */
const app = express();

// --- 中间件设置 ---

/**
 * 信任代理设置
 * 当应用运行在反向代理（如Nginx）后面时，确保正确获取客户端IP
 */
app.set('trust proxy', 1);

/**
 * CORS中间件
 * 允许跨域请求，支持前端应用访问API
 */
app.use(cors());

/**
 * JSON解析中间件
 * 解析请求体中的JSON数据，限制大小为50MB
 */
app.use(express.json({ limit: '50mb' }));

// --- 静态文件服务 ---

/**
 * 照片文件静态服务
 * 
 * 配置：
 * - 路径：/static
 * - 目录：PHOTOS_DIR（照片存储目录）
 * - 缓存：30天
 * - 媒体文件特殊缓存：30天，不可变
 * 
 * 支持的媒体格式：
 * - 图片：jpeg, jpg, png, webp, gif
 * - 视频：mp4, webm, mov
 */
app.use('/static', express.static(PHOTOS_DIR, {
    maxAge: '30d',           // 基础缓存时间：30天
    etag: true,              // 启用ETag支持
    lastModified: true,      // 启用Last-Modified头
    setHeaders: (res, filePath) => {
        // 为媒体文件设置更长的缓存时间
        if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        }
    }
}));

/**
 * 缩略图静态服务
 * 
 * 配置：
 * - 路径：/thumbs
 * - 目录：THUMBS_DIR（缩略图存储目录）
 * - 缓存：30天，不可变
 * 
 * 缩略图文件通常不会改变，因此设置为不可变缓存
 */
app.use('/thumbs', express.static(THUMBS_DIR, {
    maxAge: '30d',           // 缓存时间：30天
    immutable: true          // 不可变缓存
}));

// --- API 路由 ---

/**
 * 认证路由（无需登录验证）
 * 
 * 包含：
 * - 用户登录
 * - 用户注册
 * - 密码重置
 * - 令牌刷新
 * 
 * 应用速率限制中间件防止暴力攻击
 */
app.use('/api/auth', apiLimiter, authRouter);

/**
 * 受保护的API路由
 * 
 * 所有其他API端点都需要：
 * - 速率限制保护
 * - JWT认证验证
 * - 用户权限检查
 * 
 * 包含：
 * - 相册管理
 * - 文件浏览
 * - 搜索功能
 * - AI功能
 * - 设置管理
 * - 缩略图生成
 */
app.use('/api', apiLimiter, authMiddleware, mainRouter);

// --- 健康检查 ---

/**
 * 健康检查端点
 * 
 * 用于：
 * - 负载均衡器健康检查
 * - 容器编排系统监控
 * - 服务可用性验证
 * 
 * @route GET /health
 * @returns {Object} 服务状态信息
 */
app.get('/health', async (req, res) => {
    try {
        const { dbAll } = require('./db/multi-db');
        const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
        const ftsCount = await dbAll('main', "SELECT COUNT(*) as count FROM items_fts");
        
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: {
                items: itemCount[0].count,
                fts: ftsCount[0].count
            }
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// --- 错误处理中间件 ---

/**
 * 全局错误处理中间件
 * 
 * 捕获所有未处理的错误：
 * - 记录错误日志
 * - 返回500状态码
 * - 发送通用错误消息
 * 
 * @param {Error} err - 错误对象
 * @param {express.Request} req - 请求对象
 * @param {express.Response} res - 响应对象
 * @param {express.NextFunction} next - 下一个中间件函数
 */
app.use((err, req, res, next) => {
    logger.error('未捕获的服务器错误:', err);
    res.status(500).send('服务器发生内部错误');
});

/**
 * 导出Express应用实例
 * @exports app
 */
module.exports = app;
