const { parentPort } = require('worker_threads');
const path = require('path');
const winston = require('winston');
const { initializeConnections, getDB } = require('../db/multi-db');

// 引入通用 ngram 工具函数，避免重复实现
const { createNgrams } = require('../utils/search.utils');

(async () => {
    await initializeConnections();
    // --- 日志配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [INDEXING-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const { runAsync, dbRun, dbAll } = require('../db/multi-db');

    // --- 辅助函数 ---
    const { promises: fs } = require('fs');

    async function* walkDirStream(dir, relativePath = '') {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const entryRelativePath = path.join(relativePath, entry.name);
                const stats = await fs.stat(fullPath).catch(() => ({ mtimeMs: 0 }));
                if (entry.isDirectory()) {
                    if (entry.name === '@eaDir') continue;
                    yield { type: 'album', path: entryRelativePath, name: entry.name, mtime: stats.mtimeMs };
                    yield* walkDirStream(fullPath, entryRelativePath);
                } else if (entry.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(entry.name)) {
                    const type = /\.(jpe?g|png|webp|gif)$/i.test(entry.name) ? 'photo' : 'video';
                    yield { type: type, path: entryRelativePath, name: entry.name, mtime: stats.mtimeMs };
                }
            }
        } catch (e) {
            logger.error(`[INDEXING-WORKER] 遍历目录失败: ${dir}`, e);
        }
    }

    // --- 索引任务处理器 ---
    const tasks = {
        async rebuild_index({ photosDir }) {
            logger.info('[INDEXING-WORKER] 开始执行索引重建任务...');
            try {
                // 使用较小的批处理来减少锁持有时间
                const batchSize = 1000;
                let count = 0;
                // 清空现有数据
                await dbRun('main', "BEGIN");
                await dbRun('main', "DELETE FROM items");
                await dbRun('main', "DELETE FROM items_fts");
                await dbRun('main', "COMMIT");
                const itemsStmt = getDB('main').prepare("INSERT INTO items (name, path, type, mtime) VALUES (?, ?, ?, ?)");
                const ftsStmt = getDB('main').prepare("INSERT INTO items_fts (rowid, name) VALUES (?, ?)");
                let batch = [];
                for await (const item of walkDirStream(photosDir)) {
                    batch.push(item);
                    if (batch.length >= batchSize) {
                        await tasks.processBatch(batch, itemsStmt, ftsStmt);
                        count += batch.length;
                        logger.info(`[INDEXING-WORKER] 已处理 ${count} 个条目...`);
                        batch = [];
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
                if (batch.length > 0) {
                    await tasks.processBatch(batch, itemsStmt, ftsStmt);
                    count += batch.length;
                }
                await new Promise((resolve, reject) => itemsStmt.finalize(err => err ? reject(err) : resolve()));
                await new Promise((resolve, reject) => ftsStmt.finalize(err => err ? reject(err) : resolve()));
                logger.info(`[INDEXING-WORKER] 索引重建完成，共处理 ${count} 个条目。`);
                parentPort.postMessage({ type: 'rebuild_complete', count });
            } catch (error) {
                logger.error('[INDEXING-WORKER] 重建索引失败:', error.message);
                await dbRun('main', "ROLLBACK").catch(rbError => logger.error('[INDEXING-WORKER] 索引重建事务回滚失败:', rbError.message));
                parentPort.postMessage({ type: 'error', error: error.message });
            }
        },
        
        async processBatch(batch, itemsStmt, ftsStmt) {
            await dbRun('main', "BEGIN");
            try {
                for (const item of batch) {
                    const result = await new Promise((resolve, reject) => {
                        itemsStmt.run(item.name, item.path, item.type, item.mtime, function(err) {
                            if (err) return reject(err);
                            resolve({ lastID: this.lastID });
                        });
                    });
                    
                    const searchableText = item.path.replace(/[\/\\]/g, ' '); 
                    const tokenizedName = createNgrams(searchableText, 1, 2);
                    await new Promise((resolve, reject) => {
                        ftsStmt.run(result.lastID, tokenizedName, (err) => {
                             if (err) return reject(err);
                             resolve();
                        });
                    });
                }
                await dbRun('main', "COMMIT");
            } catch (error) {
                await dbRun('main', "ROLLBACK");
                throw error;
            }
        },

        async process_changes({ changes, photosDir }) {
            if (!changes || changes.length === 0) return;
            logger.info(`[INDEXING-WORKER] 开始处理 ${changes.length} 个索引变更...`);
            try {
                await dbRun('main', "BEGIN TRANSACTION");
                for (const change of changes) {
                    const relativePath = path.relative(photosDir, change.filePath);
                    const name = path.basename(change.filePath);
                    switch (change.type) {
                        case 'add':
                        case 'addDir':
                            const type = change.type === 'add' 
                                ? (/\.(jpe?g|png|webp|gif)$/i.test(name) ? 'photo' : 'video')
                                : 'album';
                            const result = await dbRun('main', "INSERT OR IGNORE INTO items (name, path, type) VALUES (?, ?, ?)", [name, relativePath, type]);
                            if (result.changes > 0) {
                                const searchableText = relativePath.replace(/[\/\\]/g, ' ');
                                const tokenizedName = createNgrams(searchableText, 1, 2);
                                await dbRun('main', "INSERT INTO items_fts (rowid, name) VALUES (?, ?)", [result.lastID, tokenizedName]);
                                logger.info(`[INDEXING-WORKER] 索引新增: ${relativePath}`);
                            }
                            break;
                        case 'unlink':
                        case 'unlinkDir':
                            await dbRun('main', "DELETE FROM items WHERE path = ? OR path LIKE ?", [relativePath, `${relativePath}/%`]);
                            logger.info(`[INDEXING-WORKER] 索引删除: ${relativePath}`);
                            break;
                    }
                }
                await dbRun('main', "COMMIT");
                logger.info('[INDEXING-WORKER] 索引增量更新完成。');
                parentPort.postMessage({ type: 'process_changes_complete' });
            } catch (error) {
                logger.error('[INDEXING-WORKER] 处理索引变更失败:', error.message);
                await dbRun('main', "ROLLBACK").catch(rbError => logger.error('[INDEXING-WORKER] 变更处理事务回滚失败:', rbError.message));
                parentPort.postMessage({ type: 'error', error: error.message });
            }
        },

        async get_all_media_items() {
            try {
                                const items = await dbAll('main', "SELECT path, type FROM items WHERE type = 'photo' OR type = 'video'");
                parentPort.postMessage({ type: 'all_media_items_result', payload: items });
            } catch (error) {
                logger.error('[INDEXING-WORKER] 获取所有媒体项目失败:', error.message);
                parentPort.postMessage({ type: 'error', error: error.message });
            }
        }
    };

    let isCriticalTaskRunning = false; // 用于关键任务的锁

    parentPort.on('message', async (task) => {
        const isCritical = (type) => ['rebuild_index', 'process_changes'].includes(type);

        if (isCriticalTaskRunning) {
            logger.warn(`[INDEXING-WORKER] 关键任务正在运行，已忽略新的任务: ${task.type}`);
            return;
        }

        const handler = tasks[task.type];
        if (handler) {
            if (isCritical(task.type)) {
                isCriticalTaskRunning = true;
            }

            try {
                await handler(task.payload);
            } catch (e) {
                logger.error(`[INDEXING-WORKER] 执行任务 ${task.type} 时发生未捕获的错误:`, e);
            } finally {
                if (isCritical(task.type)) {
                    isCriticalTaskRunning = false;
                }
            }
        } else {
            logger.warn(`[INDEXING-WORKER] 收到未知任务类型: ${task.type}`);
        }
    });
})(); 