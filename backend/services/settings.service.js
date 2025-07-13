/**
 * 设置管理服务模块
 * 处理系统设置的存储、缓存和更新，支持内存缓存和数据库事务
 */
const { dbAll, dbRun, getDB } = require('../db/multi-db'); // 使用多数据库管理器
const logger = require('../config/logger');

// --- 内存缓存配置 ---
let settingsCache = null;           // 设置缓存对象
let cacheTimestamp = 0;             // 缓存时间戳
const CACHE_TTL = 5 * 60 * 1000;    // 5分钟缓存时间（毫秒）

/**
 * 检查缓存是否有效
 * 验证缓存是否存在且未过期
 * @returns {boolean} 如果缓存有效返回true，否则返回false
 */
function isCacheValid() {
    return settingsCache && (Date.now() - cacheTimestamp) < CACHE_TTL;
}

/**
 * 清除缓存
 * 重置缓存对象和时间戳，强制下次从数据库读取
 */
function clearCache() {
    settingsCache = null;
    cacheTimestamp = 0;
    logger.debug('设置缓存已清除');
}

/**
 * 从数据库获取所有设置项
 * 优先从内存缓存读取，缓存无效时从数据库读取并更新缓存
 * @returns {Promise<Object>} 一个包含所有设置的键值对对象
 */
async function getAllSettings() {
    try {
        // 检查缓存是否有效
        if (isCacheValid()) {
            logger.debug('从内存缓存获取设置');
            // 补充 ALLOW_PUBLIC_ACCESS 默认值
            if (typeof settingsCache.ALLOW_PUBLIC_ACCESS === 'undefined') {
                settingsCache.ALLOW_PUBLIC_ACCESS = 'true';
            }
            return settingsCache;
        }

        // 缓存无效，从数据库读取
        logger.debug('从设置数据库获取设置');
        const rows = await dbAll('settings', 'SELECT key, value FROM settings');
        const settings = {};
        
        // 将数据库行转换为键值对对象
        for (const row of rows) {
            settings[row.key] = row.value;
        }
        
        // 补充 ALLOW_PUBLIC_ACCESS 默认值
        if (typeof settings.ALLOW_PUBLIC_ACCESS === 'undefined') {
            settings.ALLOW_PUBLIC_ACCESS = 'true';
        }
        
        // 更新缓存
        settingsCache = settings;
        cacheTimestamp = Date.now();
        return settings;
    } catch (error) {
        logger.error('从数据库获取设置失败:', error);
        throw error;
    }
}

/**
 * 批量更新一个或多个设置项
 * 使用数据库事务确保原子性，更新成功后清除缓存
 * @param {Object} settingsToUpdate - 一个包含要更新的设置的键值对对象
 * @returns {Promise<{success: boolean}>} 更新操作的结果
 */
async function updateSettings(settingsToUpdate) {
    // 使用事务确保原子性
    await dbRun('settings', 'BEGIN TRANSACTION');
    try {
        // 使用 prepare 可以提高批量操作的性能
        const db = getDB('settings');
        const updateStmt = db.prepare('INSERT OR REPLACE INTO settings (value, key) VALUES (?, ?)');
        
        // 批量更新设置项
        for (const [key, value] of Object.entries(settingsToUpdate)) {
            // 使用 Promise 包装回调式的 run 方法
            await new Promise((resolve, reject) => {
                updateStmt.run(value, key, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        }
        
        // 完成所有 run 操作后，finalize a prepared statement
        await new Promise((resolve, reject) => {
            updateStmt.finalize((err) => {
                if(err) return reject(err);
                resolve();
            });
        });

        // 提交事务
        await dbRun('settings', 'COMMIT');
        
        // 更新成功后立即清除缓存
        clearCache();
        
        // 检查是否包含认证相关设置，如果是则强制清除缓存
        const authRelatedKeys = ['PASSWORD_ENABLED', 'PASSWORD_HASH', 'AI_ENABLED'];
        const hasAuthChanges = Object.keys(settingsToUpdate).some(key => authRelatedKeys.includes(key));
        if (hasAuthChanges) {
            logger.info('检测到认证相关设置变更，已强制清除缓存');
        }
        
        logger.info('成功更新设置:', Object.keys(settingsToUpdate).join(', '));
        return { success: true };
    } catch (error) {
        // 如果出错，回滚事务
        await dbRun('settings', 'ROLLBACK');
        logger.error('更新设置时发生错误，事务已回滚:', error);
        throw error;
    }
}

// 导出设置服务函数
module.exports = {
    getAllSettings,    // 获取所有设置
    updateSettings,    // 批量更新设置
    clearCache         // 清除缓存方法，供外部调用
};