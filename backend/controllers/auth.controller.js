const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getAllSettings } = require('../services/settings.service');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { warmupCache } = require('../middleware/cache');

// 强制要求 JWT_SECRET 从环境变量提供
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET 未配置。为确保安全，必须在环境变量中提供 JWT_SECRET。');
}

// 计算登录防爆破锁定时长（秒）——参考 iOS 风格的递增策略
function computeLoginLockSeconds(failures) {
    if (failures <= 4) return 0;      // 前4次不锁
    if (failures === 5) return 60;    // 第5次：1分钟
    if (failures === 6) return 300;   // 第6次：5分钟
    if (failures === 7) return 900;   // 第7次：15分钟
    if (failures >= 8 && failures <= 10) return 3600; // 8-10次：60分钟
    return 3600; // ≥11 次：维持60分钟（可按需提高到更长）
}

function getLoginKeyBase(req) {
    const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
    const userKey = headerUserId ? `uid:${String(headerUserId)}` : `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
    return `login_guard:${userKey}`;
}

// 检查是否需要密码
exports.getAuthStatus = async (req, res) => {
    try {
        const { PASSWORD_ENABLED } = await getAllSettings();
        res.json({ 
            passwordEnabled: PASSWORD_ENABLED === 'true'
        });
    } catch (error) {
        logger.error('获取认证状态失败:', error);
        // 即使数据库失败，也应让前端有机会进入设置流程
        res.status(200).json({ 
            error: '无法获取认证状态', 
            passwordEnabled: false
        });
    }
};

// 登录处理
exports.login = async (req, res) => {
    try {
        // 登录前：检查是否处于锁定状态
        try {
            const base = getLoginKeyBase(req);
            const lockKey = `${base}:lock`;
            const ttl = await redis.ttl(lockKey);
            if (ttl && ttl > 0) {
                res.setHeader('Retry-After', String(ttl));
                return res.status(429).json({ code: 'LOGIN_LOCKED', message: `尝试过于频繁，请在 ${ttl} 秒后重试`, retryAfterSeconds: ttl, requestId: req.requestId });
            }
        } catch {}

        const { password } = req.body;
        const { PASSWORD_ENABLED, PASSWORD_HASH } = await getAllSettings();

        if (PASSWORD_ENABLED !== 'true') {
            return res.status(400).json({ code: 'PASSWORD_DISABLED', message: '密码访问未开启', requestId: req.requestId });
        }

        if (!password || !PASSWORD_HASH) {
            // 记录失败并评估锁定
            try {
                const base = getLoginKeyBase(req);
                const failKey = `${base}:fails`;
                const lockKey = `${base}:lock`;
                const fails = await redis.incr(failKey);
                if (fails === 1) await redis.expire(failKey, 24 * 60 * 60);
                const lockSec = computeLoginLockSeconds(fails);
                if (lockSec > 0) await redis.set(lockKey, '1', 'EX', lockSec);
            } catch {}
            // 返回剩余尝试次数与下一次锁定时长提示
            try {
                const base = getLoginKeyBase(req);
                const failsNow = Number(await redis.get(`${base}:fails`)) || 0;
                const remaining = Math.max(0, 5 - failsNow);
                const nextLock = computeLoginLockSeconds(failsNow + 1) || 0;
                return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: '密码错误', remainingAttempts: remaining, nextLockSeconds: nextLock, requestId: req.requestId });
            } catch {
                return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: '密码错误', requestId: req.requestId });
            }
        }

        const isMatch = await bcrypt.compare(password, PASSWORD_HASH);

        if (!isMatch) {
            // 记录失败并评估锁定
            try {
                const base = getLoginKeyBase(req);
                const failKey = `${base}:fails`;
                const lockKey = `${base}:lock`;
                const fails = await redis.incr(failKey);
                if (fails === 1) await redis.expire(failKey, 24 * 60 * 60);
                const lockSec = computeLoginLockSeconds(fails);
                if (lockSec > 0) await redis.set(lockKey, '1', 'EX', lockSec);
            } catch {}
            // 如果刚刚触发了锁定，返回 429 比 401 更直观
            try {
                const base = getLoginKeyBase(req);
                const ttl = await redis.ttl(`${base}:lock`);
                if (ttl && ttl > 0) {
                    res.setHeader('Retry-After', String(ttl));
                    return res.status(429).json({ code: 'LOGIN_LOCKED', message: `尝试过于频繁，请在 ${ttl} 秒后重试`, retryAfterSeconds: ttl, requestId: req.requestId });
                }
            } catch {}
            // 未触发锁定时，告知还可尝试次数与下一次锁定时长
            try {
                const base = getLoginKeyBase(req);
                const failsNow = Number(await redis.get(`${base}:fails`)) || 0;
                const remaining = Math.max(0, 5 - failsNow);
                const nextLock = computeLoginLockSeconds(failsNow + 1) || 0;
                return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: '密码错误', remainingAttempts: remaining, nextLockSeconds: nextLock, requestId: req.requestId });
            } catch {
                return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: '密码错误', requestId: req.requestId });
            }
        }

        // 密码正确，签发一个 token（加入标准声明，可后续扩展 aud/iss）
        const token = jwt.sign({ sub: 'gallery_user' }, JWT_SECRET, { expiresIn: '7d' });
        logger.info('用户登录成功，已签发 Token。');
        // 登录成功：清理失败与锁定
        try {
            const base = getLoginKeyBase(req);
            await redis.del(`${base}:fails`);
            await redis.del(`${base}:lock`);
        } catch {}
        res.json({ success: true, token });

        // 登录后预热常用公共路由（真实请求，不写占位数据），后台异步执行
        try {
            setTimeout(async () => {
                try {
                    const axios = require('axios');
                    const base = process.env.BACKEND_INTERNAL_URL || `http://localhost:${process.env.PORT || 13001}`;
                    const urls = [
                        `${base}/api/browse/?page=1&limit=50&sort=smart`,
                        `${base}/api/albums/covers`
                    ];
                    await Promise.allSettled(urls.map(u => axios.get(u, { timeout: 5000 }).catch(()=>null)));
                } catch {}
            }, 0);
        } catch {}

    } catch(error) {
        logger.error(`[${req.requestId || '-'}] 登录处理时发生错误:`, error);
        res.status(500).json({ code: 'LOGIN_ERROR', message: '登录时发生内部错误', requestId: req.requestId });
    }
};

// 刷新 Token（简易滑动续期）：
// 前端以现有 Authorization: Bearer <token> 调用本接口，验证通过后签发新的 7 天 token
exports.refresh = async (req, res) => {
    try {
        const authHeader = req.header('Authorization') || req.header('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(400).json({ code: 'MISSING_TOKEN', message: '缺少 Authorization Bearer Token', requestId: req.requestId });
        }

        const oldToken = authHeader.replace('Bearer ', '');
        let decoded;
        try {
            decoded = jwt.verify(oldToken, JWT_SECRET);
        } catch (e) {
            const code = e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
            return res.status(401).json({ code, message: 'Token 无效或已过期', requestId: req.requestId });
        }

        // 保持主体标识，最小改动：沿用 sub/id/user
        const subject = decoded?.sub || decoded?.id || decoded?.user || 'gallery_user';
        const newToken = jwt.sign({ sub: subject }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({ success: true, token: newToken });
    } catch (error) {
        logger.error(`[${req.requestId || '-'}] 刷新 Token 时发生错误:`, error);
        return res.status(500).json({ code: 'REFRESH_ERROR', message: '刷新 Token 失败', requestId: req.requestId });
    }
};