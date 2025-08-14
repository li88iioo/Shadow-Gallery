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
const helmet = require('helmet');
const path = require('path');
const { PHOTOS_DIR, THUMBS_DIR } = require('./config');
const apiLimiter = require('./middleware/rateLimiter');
const requestId = require('./middleware/requestId');
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
 * 通过 CORS_ALLOWED_ORIGINS=origin1,origin2 白名单控制（未配置则放行）
 */

// 安全头（与 Nginx CSP 协同，Express 层兜底）
// 说明：为避免在 HTTP/内网 IP 访问时浏览器对 COOP/O-AC 的警告，这两项由我们按请求条件自行设置
app.use(helmet({
    contentSecurityPolicy: false, // 由前置 Nginx 控制 CSP，避免重复冲突
    crossOriginOpenerPolicy: false,
    originAgentCluster: false
}));

// 在可信环境（HTTPS 或 localhost）下启用 COOP 与 O-AC；否则不发送，避免浏览器噪音日志
app.use((req, res, next) => {
    try {
        const hostname = req.hostname || '';
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().toLowerCase();
        const isSecure = req.secure || forwardedProto === 'https';

        if (isSecure || isLocalhost) {
            // 仅在可信源上设置，且确保全站一致，避免 agent cluster 冲突
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Origin-Agent-Cluster', '?1');
        } else {
            // 确保在非可信源上不下发，避免浏览器告警
            res.removeHeader('Cross-Origin-Opener-Policy');
            res.removeHeader('Origin-Agent-Cluster');
        }
    } catch {}
    next();
});
app.use(requestId());

/**
 * JSON解析中间件
 * 解析请求体中的JSON数据，限制大小为50MB
 */
app.use(express.json({ limit: '50mb' }));

// --- API 路由（先于前端静态资源与 SPA catch-all） ---

// 认证路由（无需登录验证）
app.use('/api/auth', authRouter);

// 受保护的 API
app.use('/api', apiLimiter, authMiddleware, mainRouter);

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

// --- 前端静态文件（合并部署） ---
const frontendBuildPath = path.join(__dirname, 'public');
app.use(express.static(frontendBuildPath));

// 移除重复的 /api/cache 挂载，统一由 mainRouter 下的 /cache 提供

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
    const requestIdVal = req && req.requestId ? req.requestId : undefined;
    logger.error(`[${requestIdVal || '-'}] 未捕获的服务器错误:`, err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器发生内部错误', requestId: requestIdVal });
});

// --- SPA Catch-all：应在错误中间件之后，且在最后 ---
app.get('*', (req, res) => {
	const indexPath = path.resolve(frontendBuildPath, 'index.html');
	res.sendFile(indexPath, (err) => {
		if (err) {
			// 静态入口缺失时返回 404，避免走 500
			res.status(404).send('Not Found');
		}
	});
});

/**
 * 导出Express应用实例
 * @exports app
 */
module.exports = app;
