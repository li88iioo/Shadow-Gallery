const { redis } = require('../config/redis');
const logger = require('../config/logger');

/**
 * 创建一个 Express 中间件，用于缓存 GET 请求的响应。
 * @param {number} duration - 缓存的持续时间（秒）。
 * @returns {Function} Express 中间件。
 */
function cache(duration) {
    return async (req, res, next) => {
        // 仅缓存 GET 请求
        if (req.method !== 'GET') {
            return next();
        }

        // 基于请求的原始 URL 生成缓存键
        const userId = req.headers['x-user-id'] || 'anonymous'; // 获取用户ID，若无则为匿名
        const key = `route_cache:${userId}:${req.originalUrl}`;

        try {
            const cachedData = await redis.get(key);
            if (cachedData) {
                logger.debug(`成功命中路由缓存: ${key}`);
                res.setHeader('X-Cache', 'HIT');
                // 直接发送缓存的 JSON 数据
                return res.type('json').send(cachedData);
            }

            logger.debug(`未命中路由缓存: ${key}`);
            res.setHeader('X-Cache', 'MISS');

            // 重写 res.json 方法以自动缓存结果
            const originalJson = res.json;
            res.json = (body) => {
                // 异步写入缓存，不阻塞响应
                redis.set(key, JSON.stringify(body), 'EX', duration).catch(err => {
                    logger.warn(`写入路由缓存失败 for key ${key}:`, err);
                });
                // 调用原始的 res.json 方法将响应发回客户端
                originalJson.call(res, body);
            };

            next();
        } catch (err) {
            logger.warn(`缓存中间件出错 for key ${key}:`, err.message);
            // 即使缓存出错，也应继续处理请求
            next();
        }
    };
}

module.exports = cache;
