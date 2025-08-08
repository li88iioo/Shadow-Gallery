const { parentPort } = require('worker_threads');
const path = require('path');
const winston = require('winston');
const Redis = require('ioredis');
const { initializeConnections, getDB } = require('../db/multi-db');

(async () => {
    await initializeConnections();
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    // --- 日志配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [SETTINGS-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const db = getDB('settings');

    // --- 辅助函数 ---
    const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));

    // --- 设置任务处理器 ---
    const tasks = {
        async update_settings(settingsToUpdate) {
            logger.info(`[SETTINGS-WORKER] 开始更新配置...`);
            
            const maxRetries = 3;
            let retryCount = 0;
            
            while (retryCount < maxRetries) {
                try {
                    logger.debug('[SETTINGS-WORKER] 开始事务...');
                    await dbRun('BEGIN TRANSACTION');
                    const updateStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
                    for (const [key, value] of Object.entries(settingsToUpdate)) {
                        logger.debug(`[SETTINGS-WORKER] 准备更新/插入设置: ${key} = ${value}`);
                        await new Promise((resolve, reject) => {
                            updateStmt.run(key, String(value), function(err) {
                                if (err) {
                                    logger.error(`[SETTINGS-WORKER] 更新/插入设置 ${key} 失败: ${err.message}`);
                                    return reject(err);
                                }
                                logger.debug(`[SETTINGS-WORKER] 更新/插入设置 ${key} 成功. 影响行数: ${this.changes}, 最后插入ID: ${this.lastID}`);
                                resolve();
                            });
                        });
                    }
                    await new Promise((resolve, reject) => updateStmt.finalize(err => {
                        if(err) {
                            logger.error(`[SETTINGS-WORKER] 准备语句 finalize 失败: ${err.message}`);
                            return reject(err);
                        }
                        logger.debug('[SETTINGS-WORKER] 准备语句 finalize 成功');
                        resolve();
                    }));
                    logger.debug('[SETTINGS-WORKER] 提交事务...');
                    await dbRun('COMMIT');

                    logger.info('[SETTINGS-WORKER] 配置更新成功:', Object.keys(settingsToUpdate).join(', '));
                    
                    // 有选择地清理路由缓存：
                    // - 如果仅更新了认证相关设置（PASSWORD_ENABLED / PASSWORD_HASH），
                    //   仅清理与设置页面相关的缓存，避免大范围冷缓存造成短暂性能抖动
                    // - 否则，清理所有路由缓存
                    const updatedKeys = Object.keys(settingsToUpdate);
                    const authOnly = updatedKeys.every(k => ['PASSWORD_ENABLED', 'PASSWORD_HASH'].includes(k));
                    if (authOnly) {
                        const settingKeys = await redis.keys('route_cache:*:/api/settings*');
                        if (settingKeys.length > 0) {
                            await redis.del(...settingKeys);
                            logger.info(`[SETTINGS-WORKER] 因认证相关配置变更，已精确清理 ${settingKeys.length} 个设置相关路由缓存。`);
                        } else {
                            logger.info('[SETTINGS-WORKER] 认证相关配置变更，无需清理目录/搜索缓存。');
                        }
                    } else {
                        const keys = await redis.keys('route_cache:*');
                        if (keys.length > 0) {
                            await redis.del(...keys);
                            logger.info(`[SETTINGS-WORKER] 因配置变更，已清理 ${keys.length} 个路由缓存。`);
                        }
                    }
                    
                    // 发送成功消息给主线程
                    parentPort.postMessage({ 
                        type: 'settings_update_complete', 
                        success: true, 
                        updatedKeys: Object.keys(settingsToUpdate) 
                    });
                    
                    return; // 成功，退出重试循环
                    
                } catch (error) {
                    retryCount++;
                    await dbRun('ROLLBACK').catch(rbErr => logger.error('[SETTINGS-WORKER] 设置更新事务回滚失败:', rbErr.message));
                    
                    if (error.message.includes('SQLITE_BUSY') && retryCount < maxRetries) {
                        const delay = retryCount * 2000; // 递增延迟：2秒、4秒、6秒
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
                    return; // 失败，退出重试循环
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