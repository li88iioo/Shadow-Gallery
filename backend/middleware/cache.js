const { redis } = require('../config/redis');
const logger = require('../config/logger');

// 缓存统计
const cacheStats = {
    hits: 0,
    misses: 0,
    totalRequests: 0
};

/**
 * 获取缓存命中率
 * @returns {Object} 缓存统计信息
 */
function getCacheStats() {
    const hitRate = cacheStats.totalRequests > 0 ? (cacheStats.hits / cacheStats.totalRequests * 100).toFixed(2) : 0;
    return {
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        totalRequests: cacheStats.totalRequests,
        hitRate: `${hitRate}%`
    };
}

/**
 * 智能缓存预热
 * @param {string} key - 缓存键
 * @param {Function} dataGenerator - 数据生成函数
 * @param {number} ttl - 缓存时间
 */
async function warmupCache(key, dataGenerator, ttl = 300) {
    try {
        const exists = await redis.exists(key);
        if (!exists) {
            logger.info(`预热缓存: ${key}`);
            const data = await dataGenerator();
            await redis.set(key, JSON.stringify(data), 'EX', ttl);
        }
    } catch (error) {
        logger.warn(`缓存预热失败: ${key}`, error);
    }
}

/**
 * 分级缓存策略
 * @param {string} route - 路由路径
 * @returns {Object} 缓存配置
 */
function getCacheStrategy(route) {
    // 高优先级缓存（长时间缓存）
    if (route.includes('/api/browse/') || route.includes('/api/thumbnail/')) {
        return {
            duration: 3600, // 1小时
            strategy: 'cache-first',
            warmup: true
        };
    }
    
    // 中优先级缓存（中等时间缓存）
    if (route.includes('/api/search')) {
        return {
            duration: 300, // 5分钟
            strategy: 'network-first',
            warmup: false
        };
    }
    
    // 低优先级缓存（短时间缓存）
    if (route.includes('/api/settings')) {
        return {
            duration: 60, // 1分钟
            strategy: 'stale-while-revalidate',
            warmup: false
        };
    }
    
    // 默认缓存策略
    return {
        duration: 300, // 5分钟
        strategy: 'cache-first',
        warmup: false
    };
}

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
        
        // 获取缓存策略
        const strategy = getCacheStrategy(req.originalUrl);
        const cacheDuration = duration || strategy.duration;

        try {
            // 更新统计信息
            cacheStats.totalRequests++;
            
            const cachedData = await redis.get(key);
            if (cachedData) {
                cacheStats.hits++;
                logger.debug(`成功命中路由缓存: ${key}`);
                res.setHeader('X-Cache', 'HIT');
                res.setHeader('X-Cache-Hit-Rate', getCacheStats().hitRate);
                // 直接发送缓存的 JSON 数据
                return res.type('json').send(cachedData);
            }

            cacheStats.misses++;
            logger.debug(`未命中路由缓存: ${key}`);
            res.setHeader('X-Cache', 'MISS');
            res.setHeader('X-Cache-Hit-Rate', getCacheStats().hitRate);

            // 重写 res.json 方法以自动缓存结果
            const originalJson = res.json;
            res.json = (body) => {
                // 异步写入缓存，不阻塞响应
                redis.set(key, JSON.stringify(body), 'EX', cacheDuration).catch(err => {
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

/**
 * 智能缓存中间件（自动选择缓存策略）
 * @returns {Function} Express 中间件
 */
function smartCache() {
    return async (req, res, next) => {
        if (req.method !== 'GET') {
            return next();
        }

        const userId = req.headers['x-user-id'] || 'anonymous';
        const key = `route_cache:${userId}:${req.originalUrl}`;
        const strategy = getCacheStrategy(req.originalUrl);

        try {
            cacheStats.totalRequests++;
            
            if (strategy.strategy === 'cache-first') {
                // 缓存优先策略
                const cachedData = await redis.get(key);
                if (cachedData) {
                    cacheStats.hits++;
                    res.setHeader('X-Cache', 'HIT');
                    res.setHeader('X-Cache-Strategy', 'cache-first');
                    return res.type('json').send(cachedData);
                }
                
                cacheStats.misses++;
                res.setHeader('X-Cache', 'MISS');
                res.setHeader('X-Cache-Strategy', 'cache-first');
                
                const originalJson = res.json;
                res.json = (body) => {
                    redis.set(key, JSON.stringify(body), 'EX', strategy.duration).catch(err => {
                        logger.warn(`写入缓存失败: ${key}`, err);
                    });
                    originalJson.call(res, body);
                };
                
                next();
            } else if (strategy.strategy === 'network-first') {
                // 网络优先策略
                const originalJson = res.json;
                res.json = (body) => {
                    redis.set(key, JSON.stringify(body), 'EX', strategy.duration).catch(err => {
                        logger.warn(`写入缓存失败: ${key}`, err);
                    });
                    originalJson.call(res, body);
                };
                
                next();
            } else if (strategy.strategy === 'stale-while-revalidate') {
                // 过期重验证策略
                const cachedData = await redis.get(key);
                if (cachedData) {
                    cacheStats.hits++;
                    res.setHeader('X-Cache', 'HIT');
                    res.setHeader('X-Cache-Strategy', 'stale-while-revalidate');
                    res.type('json').send(cachedData);
                    
                    // 后台更新缓存
                    setTimeout(async () => {
                        try {
                            // 这里可以触发数据重新获取
                            logger.debug(`后台更新缓存: ${key}`);
                        } catch (error) {
                            logger.warn(`后台更新缓存失败: ${key}`, error);
                        }
                    }, 0);
                } else {
                    cacheStats.misses++;
                    res.setHeader('X-Cache', 'MISS');
                    res.setHeader('X-Cache-Strategy', 'stale-while-revalidate');
                    
                    const originalJson = res.json;
                    res.json = (body) => {
                        redis.set(key, JSON.stringify(body), 'EX', strategy.duration).catch(err => {
                            logger.warn(`写入缓存失败: ${key}`, err);
                        });
                        originalJson.call(res, body);
                    };
                    
                    next();
                }
            }
        } catch (err) {
            logger.warn(`智能缓存中间件出错: ${key}`, err.message);
            next();
        }
    };
}

/**
 * 缓存清理中间件
 * @param {string} pattern - 缓存键模式
 * @returns {Function} Express 中间件
 */
function clearCache(pattern = '*') {
    return async (req, res, next) => {
        try {
            const keys = await redis.keys(pattern);
            if (keys.length > 0) {
                await redis.del(...keys);
                logger.info(`清理缓存: ${keys.length} 个键`);
            }
            res.json({ success: true, clearedKeys: keys.length });
        } catch (error) {
            logger.error('清理缓存失败:', error);
            res.status(500).json({ error: '清理缓存失败' });
        }
    };
}

module.exports = {
    cache,
    smartCache,
    clearCache,
    getCacheStats,
    warmupCache
};
