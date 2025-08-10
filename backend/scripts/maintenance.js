/**
 * 数据库维护脚本
 * 定期整理数据库，回收空闲空间，保持数据库文件紧凑
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
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
        // 解析命令行：支持 --clean-legacy-after-migration 安全清理已迁移到多库后的主库遗留表
        const args = process.argv.slice(2);
        const shouldCleanLegacy = args.includes('--clean-legacy-after-migration');

        if (shouldCleanLegacy) {
            await cleanLegacyTablesIfMigrated();
        }

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

/**
 * 安全清理：在确认 settings/history 已迁移到对应独立库后，清理主库中的遗留旧表
 * - 仅当两个外部库都存在目标数据且主库存在对应旧表时执行
 * - 清理前先创建备份（copy 文件）
 */
async function cleanLegacyTablesIfMigrated() {
    logger.info('开始检测并清理主库遗留旧表（如已迁移至多库）...');
    if (!fs.existsSync(DB_FILE)) {
        logger.info('主库文件不存在，跳过清理');
        return;
    }

    const backupPath = DB_FILE.replace(/\.db$/i, `_legacy_backup_${new Date().toISOString().replace(/[:.]/g,'-')}.db`);
    try {
        fs.copyFileSync(DB_FILE, backupPath);
        logger.info(`已备份主库至: ${backupPath}`);
    } catch (e) {
        logger.error(`备份主库失败，放弃清理: ${e.message}`);
        return;
    }

    // 打开三个库进行检查
    const mainDb = new sqlite3.Database(DB_FILE);
    const settingsDb = fs.existsSync(SETTINGS_DB_FILE) ? new sqlite3.Database(SETTINGS_DB_FILE) : null;
    const historyDb = fs.existsSync(HISTORY_DB_FILE) ? new sqlite3.Database(HISTORY_DB_FILE) : null;

    function all(db, sql, params = []) { return new Promise((resolve,reject)=> db.all(sql, params, (e,rows)=> e?reject(e):resolve(rows))); }
    function run(db, sql, params = []) { return new Promise((resolve,reject)=> db.run(sql, params, function(e){ e?reject(e):resolve(this); })); }

    try {
        // 仅当外部分库存在且有数据时，才认为迁移完成
        let settingsCount = 0, historyCount = 0;
        if (settingsDb) {
            try { const r = await all(settingsDb, 'SELECT COUNT(1) as c FROM settings'); settingsCount = r?.[0]?.c || 0; } catch {}
        }
        if (historyDb) {
            try { const r = await all(historyDb, 'SELECT COUNT(1) as c FROM view_history'); historyCount = r?.[0]?.c || 0; } catch {}
        }

        // 主库存在的疑似旧表
        const legacyCandidates = ['settings', 'view_history'];
        const legacyInMain = await all(mainDb, `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${legacyCandidates.map(()=>'?').join(',')})`, legacyCandidates);
        const legacyNames = legacyInMain.map(r => r.name);

        if ((settingsCount > 0 || historyCount > 0) && legacyNames.length > 0) {
            logger.warn(`检测到主库遗留旧表: ${legacyNames.join(', ')}。将开始安全清理（已备份）...`);
            await run(mainDb, 'BEGIN');
            for (const tbl of legacyNames) {
                await run(mainDb, `DROP TABLE IF EXISTS ${tbl}`);
            }
            await run(mainDb, 'COMMIT');
            logger.info('主库遗留旧表清理完成');
        } else {
            logger.info('未发现需要清理的主库旧表，或分库数据尚未准备就绪。');
        }
    } catch (e) {
        try { await run(mainDb, 'ROLLBACK'); } catch {}
        logger.error(`清理旧表失败: ${e.message}，主库已保留备份: ${backupPath}`);
    } finally {
        try { mainDb.close(); } catch {}
        try { settingsDb && settingsDb.close(); } catch {}
        try { historyDb && historyDb.close(); } catch {}
    }
}