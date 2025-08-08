/**
 * 速率限制中间件模块
 * 使用express-rate-limit库实现API请求频率限制，防止恶意攻击和资源滥用
 */
const rateLimit = require('express-rate-limit');

/**
 * API速率限制器配置
 * 限制客户端在指定时间窗口内的请求次数，保护服务器资源
 */
const apiLimiter = rateLimit({
    // 时间窗口：默认15分钟，可通过环境变量RATE_LIMIT_WINDOW_MINUTES配置
    // 单位：毫秒
    windowMs: (process.env.RATE_LIMIT_WINDOW_MINUTES || 15) * 60 * 1000,
    
    // 最大请求次数：默认100次，可通过环境变量RATE_LIMIT_MAX_REQUESTS配置
    // 在时间窗口内超过此次数将被限制
    max: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
    
    // 限制响应消息：当请求被限制时返回的错误信息
    message: {
        error: '请求过于频繁，请稍后再试。'
    },
    
    // 启用标准HTTP头：在响应中包含速率限制信息
    // 包括 X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
    standardHeaders: true,
    
    // 禁用旧版HTTP头：不包含 X-RateLimit-* 格式的旧版头信息
    legacyHeaders: false,

    // 登录后缩略图会在短时间内产生大量 GET 请求，为避免 429 限流造成感知卡顿，放行该路径
    skip: (req) => {
        try {
            // 该中间件挂载在 "/api"，此处的 req.path 为去掉 "/api" 的子路径
            return req.method === 'GET' && req.path === '/thumbnail';
        } catch { return false; }
    }
});

// 导出配置好的速率限制中间件
module.exports = apiLimiter;