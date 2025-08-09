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

// --- 通用：命中回放与写入封装 ---
const MAX_CACHEABLE_BYTES = 1024 * 1024; // 1MB 上限，避免缓存过大响应

function isEnvelope(obj) {
    return obj && typeof obj === 'object' && obj.__cached_envelope === 1;
}

function buildEnvelope(res, body) {
    // 推断内容与大小
    const contentType = res.get('Content-Type') || 'application/octet-stream';
    let isBase64 = false;
    let payload;
    if (Buffer.isBuffer(body)) {
        isBase64 = true;
        payload = body.toString('base64');
    } else if (typeof body === 'string') {
        payload = body;
    } else {
        // 对象等情况，按 json 序列化
        payload = JSON.stringify(body);
    }
    if (payload && typeof payload === 'string' && payload.length > MAX_CACHEABLE_BYTES) {
        return null; // 超限不缓存
    }
    return {
        __cached_envelope: 1,
        status: res.statusCode || 200,
        headers: { 'Content-Type': contentType },
        body: payload,
        isBase64
    };
}

function replayEnvelope(res, envelope) {
    if (envelope.headers && envelope.headers['Content-Type']) {
        res.setHeader('Content-Type', envelope.headers['Content-Type']);
    }
    const status = envelope.status || 200;
    if (envelope.isBase64) {
        const buf = Buffer.from(envelope.body || '', 'base64');
        return res.status(status).send(buf);
    }
    return res.status(status).send(envelope.body || '');
}

function attachWritersWithCache(res, key, ttlSeconds) {
    let streamingWritten = false;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    // 监测流式响应：一旦 write，被视为流式，跳过缓存
    res.write = function(chunk, encoding, cb) {
        streamingWritten = true;
        return originalWrite(chunk, encoding, cb);
    };

    res.end = function(chunk, encoding, cb) {
        try {
            if (!streamingWritten && res.statusCode === 200 && res.req && res.req.method === 'GET') {
                if (chunk && !res.headersSent) {
                    // 如果 end 写入主体，尝试缓存
                    const env = buildEnvelope(res, chunk);
                    if (env) {
                        redis.set(key, JSON.stringify(env), 'EX', ttlSeconds).catch(()=>{});
                    }
                }
            }
        } catch {}
        return originalEnd(chunk, encoding, cb);
    };

    res.send = function(body) {
        try {
            if (!streamingWritten && res.statusCode === 200 && res.req && res.req.method === 'GET') {
                const env = buildEnvelope(res, body);
                if (env) {
                    redis.set(key, JSON.stringify(env), 'EX', ttlSeconds).catch(()=>{});
                }
            }
        } catch {}
        return originalSend(body);
    };

    res.json = function(body) {
        try {
            if (!streamingWritten && res.statusCode === 200 && res.req && res.req.method === 'GET') {
                // json 特殊化，确保 content-type
                if (!res.get('Content-Type')) {
                    res.set('Content-Type', 'application/json; charset=utf-8');
                }
                const env = buildEnvelope(res, body);
                if (env) {
                    redis.set(key, JSON.stringify(env), 'EX', ttlSeconds).catch(()=>{});
                }
            }
        } catch {}
        return originalJson(body);
    };

    return res;
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
        // 优先使用认证注入的 req.user.id，其次使用前端传入的 x-user-id 进行用户级隔离
        const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
        const userId = (req.user && req.user.id) ? String(req.user.id) : (headerUserId ? String(headerUserId) : 'anonymous');
        const key = `route_cache:${userId}:${req.originalUrl}`;
        
        // 获取缓存策略
        const strategy = getCacheStrategy(req.originalUrl);
        const cacheDuration = duration || strategy.duration;

        try {
            // 更新统计信息
            cacheStats.totalRequests++;
            
            let cachedData;
            try {
                cachedData = await redis.get(key);
            } catch (e) {
                logger.warn(`读取缓存失败（降级直出）: ${e.message}`);
                return next();
            }
            if (cachedData) {
                cacheStats.hits++;
                logger.debug(`成功命中路由缓存: ${key}`);
                res.setHeader('X-Cache', 'HIT');
                res.setHeader('X-Cache-Hit-Rate', getCacheStats().hitRate);
                // 对带鉴权的变体进行区分
                res.setHeader('Vary', 'Authorization, X-User-ID');
                // 优先按封装回放；兼容旧值（纯JSON字符串）
                try {
                    const parsed = JSON.parse(cachedData);
                    if (isEnvelope(parsed)) {
                        res.setHeader('Cache-Control', `public, max-age=${cacheDuration}`);
                        return replayEnvelope(res, parsed);
                    }
                } catch {}
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', `public, max-age=${cacheDuration}`);
                res.setHeader('Vary', 'Authorization, X-User-ID');
                return res.send(cachedData);
            }

            cacheStats.misses++;
            logger.debug(`未命中路由缓存: ${key}`);
            res.setHeader('X-Cache', 'MISS');
            res.setHeader('X-Cache-Hit-Rate', getCacheStats().hitRate);
            res.setHeader('Vary', 'Authorization, X-User-ID');

            // 附加写入钩子，统一支持 json/send/end
            attachWritersWithCache(res, key, cacheDuration);

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

        const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
        const userId = (req.user && req.user.id) ? String(req.user.id) : (headerUserId ? String(headerUserId) : 'anonymous');
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
                    res.setHeader('Vary', 'Authorization, X-User-ID');
                    try {
                        const parsed = JSON.parse(cachedData);
                        if (isEnvelope(parsed)) {
                            res.setHeader('Cache-Control', `public, max-age=${strategy.duration}`);
                            return replayEnvelope(res, parsed);
                        }
                    } catch {}
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.setHeader('Cache-Control', `public, max-age=${strategy.duration}`);
                    res.setHeader('Vary', 'Authorization, X-User-ID');
                    return res.send(cachedData);
                }
                
                cacheStats.misses++;
                res.setHeader('X-Cache', 'MISS');
                res.setHeader('X-Cache-Strategy', 'cache-first');
                res.setHeader('Vary', 'Authorization, X-User-ID');
                
                attachWritersWithCache(res, key, strategy.duration);
                
                next();
            } else if (strategy.strategy === 'network-first') {
                // 网络优先策略
                attachWritersWithCache(res, key, strategy.duration);
                
                next();
            } else if (strategy.strategy === 'stale-while-revalidate') {
                // 过期重验证策略
                const cachedData = await redis.get(key);
                if (cachedData) {
                    cacheStats.hits++;
                    res.setHeader('X-Cache', 'HIT');
                    res.setHeader('X-Cache-Strategy', 'stale-while-revalidate');
                    res.setHeader('Vary', 'Authorization, X-User-ID');
                    try {
                        const parsed = JSON.parse(cachedData);
                        if (isEnvelope(parsed)) {
                            res.setHeader('Cache-Control', `public, max-age=${strategy.duration}`);
                            replayEnvelope(res, parsed);
                        } else {
                            res.setHeader('Content-Type', 'application/json; charset=utf-8');
                            res.setHeader('Cache-Control', `public, max-age=${strategy.duration}`);
                            res.setHeader('Vary', 'Authorization, X-User-ID');
                            res.send(cachedData);
                        }
                    } catch {
                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                        res.setHeader('Cache-Control', `public, max-age=${strategy.duration}`);
                        res.setHeader('Vary', 'Authorization, X-User-ID');
                        res.send(cachedData);
                    }
                    
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
                    res.setHeader('Vary', 'Authorization, X-User-ID');
                    attachWritersWithCache(res, key, strategy.duration);
                    
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
// 使用 SCAN + UNLINK/DEL 进行非阻塞清理
async function scanAndDelete(pattern) {
    let cursor = '0';
    let total = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = next;
        if (keys && keys.length) {
            if (typeof redis.unlink === 'function') {
                await redis.unlink(...keys);
            } else {
                await redis.del(...keys);
            }
            total += keys.length;
        }
    } while (cursor !== '0');
    return total;
}

function clearCache(pattern = '*') {
    return async (req, res, next) => {
        try {
            const cleared = await scanAndDelete(pattern);
            res.json({ success: true, clearedKeys: cleared });
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
    warmupCache,
    scanAndDelete
};
