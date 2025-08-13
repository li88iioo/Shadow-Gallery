const { parentPort } = require('worker_threads');
const winston = require('winston');
const { initializeConnections, getDB, runPreparedBatch } = require('../db/multi-db');
const { redis } = require('../config/redis');
const { invalidateTags } = require('../services/cache.service.js');

(async () => {
    await initializeConnections();
    // --- 日志配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [SETTINGS-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const db = getDB('settings');

    const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));

    const tasks = {
        async update_settings(settingsToUpdate) {
            logger.info(`[SETTINGS-WORKER] 开始更新配置...`);
            
            const maxRetries = 3;
            let retryCount = 0;
            
            while (retryCount < maxRetries) {
                try {
                    const sql = 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)';
                    const rows = Object.entries(settingsToUpdate).map(([k, v]) => [k, String(v)]);
                    // 交由通用批处理托管事务
                    await runPreparedBatch('settings', sql, rows, { chunkSize: 500 });

                    logger.info('[SETTINGS-WORKER] 配置更新成功:', Object.keys(settingsToUpdate).join(', '));

                    // 清理 Redis 中的 settings_cache_v1 (如果存在)
                    await redis.del('settings_cache_v1').catch(e => logger.warn(`删除 Redis 设置缓存失败: ${e && e.message}`));

                    // 使用新的基于标签的缓存失效机制
                    // 任何设置变更都只影响被打上 'settings' 标签的缓存
                    await invalidateTags('settings');
                    
                    parentPort.postMessage({ 
                        type: 'settings_update_complete', 
                        success: true, 
                        updatedKeys: Object.keys(settingsToUpdate) 
                    });
                    
                    return; // 成功，退出循环
                    
                } catch (error) {
                    retryCount++;
                    
                    if (error.message.includes('SQLITE_BUSY') && retryCount < maxRetries) {
                        const delay = retryCount * 2000;
                        logger.warn(`[SETTINGS-WORKER] 数据库繁忙，${delay}ms后重试 (${retryCount}/${maxRetries}): ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                    
                    logger.error('[SETTINGS-WORKER] 更新配置时发生错误:', error.message);
                    parentPort.postMessage({ 
                        type: 'settings_update_failed', 
                        error: error.message,
                        updatedKeys: Object.keys(settingsToUpdate)
                    });
                    return; // 失败，退出循环
                }
            }
        }
    };

    parentPort.on('message', async (task) => {
        const handler = tasks[task.type];
        if (handler) {
            try {
                await handler(task.payload);
            } catch (e) {
                logger.error(`[SETTINGS-WORKER] 执行任务 ${task.type} 时发生未捕获的错误:`, e);
            }
        } else {
            logger.warn(`[SETTINGS-WORKER] 收到未知任务类型: ${task.type}`);
        }
    });
})();