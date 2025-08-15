const { redis } = require('../config/redis');
const logger = require('../config/logger');
const { addTagsToKey } = require('../services/cache.service.js');

const cacheStats = { hits: 0, misses: 0, totalRequests: 0 };
const inFlight = new Map();
const INFLIGHT_TIMEOUT_MS = 8000;

function generateTagsFromReq(req) {
    const tags = new Set();
    const url = req.originalUrl || req.url;
    const urlParts = new URL(url, 'http://local');
    const routePath = urlParts.pathname;

    if (routePath.startsWith('/api/settings')) {
        tags.add('settings');
    }
    if (routePath.startsWith('/api/thumbnail')) {
        const itemPath = urlParts.searchParams.get('path');
        if (itemPath) tags.add(`item:${itemPath}`);
    }
    if (routePath.startsWith('/api/browse')) {
        const browsePath = routePath.substring('/api/browse'.length).replace(/^\/|\/$/g, '');
        tags.add('album:/');
        if (browsePath) {
            const segments = browsePath.split('/').filter(Boolean);
            let currentPath = '';
            for (const segment of segments) {
                currentPath = `${currentPath}/${segment}`;
                tags.add(`album:${currentPath}`);
            }
        }
    }
    return Array.from(tags);
}

async function singleflight(key, producer) {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
        try { return await producer(); }
        finally { setTimeout(() => inFlight.delete(key), 0); }
    })();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('singleflight_timeout')), INFLIGHT_TIMEOUT_MS));
    const wrapped = Promise.race([p, timeout]);
    inFlight.set(key, wrapped);
    return wrapped;
}

const MAX_CACHEABLE_BYTES = 1024 * 1024;

function buildEnvelope(res, body) {
    const contentType = res.get('Content-Type') || 'application/octet-stream';
    let isBase64 = false, payload;
    if (Buffer.isBuffer(body)) {
        isBase64 = true;
        payload = body.toString('base64');
    } else {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (payload && payload.length > MAX_CACHEABLE_BYTES) return null;
    return { __cached_envelope: 1, status: res.statusCode || 200, headers: { 'Content-Type': contentType }, body: payload, isBase64 };
}

function replayEnvelope(res, envelope) {
    res.setHeader('Vary', 'Authorization, X-User-ID');
    if (envelope.headers && envelope.headers['Content-Type']) {
        res.setHeader('Content-Type', envelope.headers['Content-Type']);
    }
    const status = envelope.status || 200;
    const body = envelope.body || '';
    return res.status(status).send(envelope.isBase64 ? Buffer.from(body, 'base64') : body);
}

function attachWritersWithCache(res, key, ttlSeconds) {
    let streamingWritten = false;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    const cacheAndTag = (body) => {
        try {
            if (!streamingWritten && res.statusCode >= 200 && res.statusCode < 300 && res.req && res.req.method === 'GET') {
                const env = buildEnvelope(res, body);
                if (env) {
                    redis.set(key, JSON.stringify(env), 'EX', ttlSeconds)
                        .then(() => {
                            const tags = generateTagsFromReq(res.req);
                            if (tags.length > 0) addTagsToKey(key, tags);
                        })
                        .catch(err => logger.warn(`缓存或标记失败 for key ${key}:`, err));
                }
            }
        } catch (e) { logger.warn(`缓存封装或标记过程中出错 for key ${key}:`, e); }
    };

    res.write = (chunk, encoding, cb) => { streamingWritten = true; return originalWrite(chunk, encoding, cb); };
    res.end = (chunk, encoding, cb) => { if (chunk && !res.headersSent) cacheAndTag(chunk); return originalEnd(chunk, encoding, cb); };
    res.send = (body) => { cacheAndTag(body); return originalSend(body); };
    res.json = (body) => { if (!res.get('Content-Type')) res.set('Content-Type', 'application/json; charset=utf-8'); cacheAndTag(body); return originalJson(body); };

    return res;
}

function cache(duration) {
    return async (req, res, next) => {
        if (req.method !== 'GET') return next();

        // 统一获取用户ID：仅信任已认证的 req.user.id；未认证一律视为 anonymous，忽略自报 ID 头，防止缓存键爆炸
        const userId = (req.user && req.user.id) ? String(req.user.id) : 'anonymous';

        // 根据路由与查询参数决定是否按用户隔离缓存
        const urlObj = new URL(req.originalUrl, 'http://local');
        const pathname = urlObj.pathname || '';
        const sortParam = (urlObj.searchParams.get('sort') || 'smart').toLowerCase();
        let bucket = 'public';
        if (pathname.startsWith('/api/browse')) {
            const suffix = pathname.substring('/api/browse'.length);
            const isSubdir = !!(suffix && suffix !== '/');
            if (sortParam === 'viewed_desc' || (sortParam === 'smart' && isSubdir)) {
                bucket = `user:${userId}`;
            }
        }
        
        const key = `route_cache:${bucket}:${req.originalUrl}`;
        const cacheDuration = duration || 300;

        try {
            cacheStats.totalRequests++;
            let cachedData = await redis.get(key).catch(() => null);

            if (cachedData) {
                cacheStats.hits++;
                logger.debug(`成功命中路由缓存: ${key}`);
                res.setHeader('X-Cache', 'HIT');
                try {
                    const parsed = JSON.parse(cachedData);
                    if (parsed && parsed.__cached_envelope === 1) {
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
            res.setHeader('Vary', 'Authorization, X-User-ID');

            await singleflight(`build:${key}`, async () => {
                attachWritersWithCache(res, key, cacheDuration);
            });

            next();
        } catch (err) {
            logger.warn(`缓存中间件出错 for key ${key}:`, err.message);
            next();
        }
    };
}

async function scanAndDelete(pattern) {
    let cursor = '0', total = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = next;
        if (keys && keys.length) {
            await (typeof redis.unlink === 'function' ? redis.unlink(...keys) : redis.del(...keys));
            total += keys.length;
        }
    } while (cursor !== '0');
    return total;
}

function clearCache(pattern = '*') {
    return async (req, res) => {
        try {
            const cleared = await scanAndDelete(pattern);
            res.json({ success: true, clearedKeys: cleared });
        } catch (error) {
            logger.error('清理缓存失败:', error);
            res.status(500).json({ error: '清理缓存失败' });
        }
    };
}

module.exports = { cache, clearCache, getCacheStats: () => cacheStats, scanAndDelete };