/**
 * 数据库维护脚本
 * 定期整理数据库，回收空闲空间，保持数据库文件紧凑
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { 
    DB_FILE, 
    SETTINGS_DB_FILE, 
    HISTORY_DB_FILE, 
    INDEX_DB_FILE 
} = require('../config');
const logger = require('../config/logger');

/**
 * 执行数据库维护
 * 对所有数据库文件执行 VACUUM 命令以回收空间
 */
async function performDatabaseMaintenance() {
    const databases = [
        { name: '主数据库', path: DB_FILE },
        { name: '设置数据库', path: SETTINGS_DB_FILE },
        { name: '历史记录数据库', path: HISTORY_DB_FILE },
        { name: '索引数据库', path: INDEX_DB_FILE }
    ];

    logger.info('开始执行数据库维护任务...');

    for (const db of databases) {
        try {
            // 检查数据库文件是否存在
            const fs = require('fs');
            if (!fs.existsSync(db.path)) {
                logger.info(`${db.name} 文件不存在，跳过维护: ${db.path}`);
                continue;
            }

            // 获取维护前的文件大小
            const statsBefore = fs.statSync(db.path);
            const sizeBeforeMB = (statsBefore.size / (1024 * 1024)).toFixed(2);

            logger.info(`开始维护 ${db.name} (${sizeBeforeMB}MB)...`);

            // 执行 VACUUM 命令
            await new Promise((resolve, reject) => {
                const database = new sqlite3.Database(db.path, (err) => {
                    if (err) {
                        logger.error(`无法打开 ${db.name}: ${err.message}`);
                        reject(err);
                        return;
                    }

                    // 执行 VACUUM 命令
                    database.run('VACUUM;', (err) => {
                        if (err) {
                            logger.error(`VACUUM 命令执行失败 (${db.name}): ${err.message}`);
                            reject(err);
                        } else {
                            logger.info(`${db.name} VACUUM 命令执行成功`);
                        }
                        
                        // 关闭数据库连接
                        database.close((closeErr) => {
                            if (closeErr) {
                                logger.warn(`关闭 ${db.name} 连接时出错: ${closeErr.message}`);
                            }
                            resolve();
                        });
                    });
                });
            });

            // 获取维护后的文件大小
            const statsAfter = fs.statSync(db.path);
            const sizeAfterMB = (statsAfter.size / (1024 * 1024)).toFixed(2);
            const savedMB = (statsBefore.size - statsAfter.size) / (1024 * 1024);

            if (savedMB > 0) {
                logger.info(`${db.name} 维护完成，释放了 ${savedMB.toFixed(2)}MB 空间 (${sizeBeforeMB}MB -> ${sizeAfterMB}MB)`);
            } else {
                logger.info(`${db.name} 维护完成，文件大小无变化 (${sizeAfterMB}MB)`);
            }

        } catch (error) {
            logger.error(`维护 ${db.name} 时出错: ${error.message}`);
        }
    }

    logger.info('数据库维护任务完成');
}

/**
 * 主函数
 */
async function main() {
    try {
        await performDatabaseMaintenance();
        process.exit(0);
    } catch (error) {
        logger.error('数据库维护失败:', error.message);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main();
}

module.exports = {
    performDatabaseMaintenance
}; 