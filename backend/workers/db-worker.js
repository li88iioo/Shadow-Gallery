// backend/workers/db-worker.js

const { parentPort } = require('worker_threads');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { promises: fs } = require('fs');
const winston = require('winston');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// ... (createNgrams 和其他辅助函数)
function createNgrams(text, minGram = 1, maxGram = 2) {
    const sanitizedText = text.toLowerCase().replace(/\s+/g, '');
    const ngrams = new Set();
    for (let n = minGram; n <= maxGram; n++) {
        for (let i = 0; i < sanitizedText.length - n + 1; i++) {
            ngrams.add(sanitizedText.substring(i, i + n));
        }
    }
    return Array.from(ngrams).join(' ');
}
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [DB-WORKER] ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, 'data');
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        logger.error(`[DB-WORKER] 无法连接到 SQLite 数据库: ${err.message}`);
        parentPort.postMessage({ type: 'error', error: err.message });
        process.exit(1);
    }
    logger.info('[DB-WORKER] 成功连接到 SQLite 数据库。');
    db.configure('busyTimeout', 5000);
    // 性能优化 PRAGMA
    try {
        db.run('PRAGMA synchronous = NORMAL;'); // 写入同步级别，兼顾安全和性能
        db.run('PRAGMA temp_store = MEMORY;'); // 临时表放内存
        db.run('PRAGMA cache_size = -8000;'); // 8MB 内存缓存
        db.run('PRAGMA journal_mode = WAL;'); // 已有，可保留
        db.run('PRAGMA mmap_size = 268435456;'); // 256MB 内存映射
        db.run('PRAGMA foreign_keys = ON;'); // 保证外键约束
        db.run('PRAGMA optimize;'); // 自动优化
    } catch (e) { logger.warn('PRAGMA 优化参数设置失败:', e.message); }
});
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); }));
async function* walkDirStream(dir, relativePath = '') {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '@eaDir') continue;
                yield { value: { type: 'album', path: entryRelativePath, name: entry.name } };
                yield* walkDirStream(fullPath, entryRelativePath);
            } else if (entry.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(entry.name)) {
                const type = /\.(jpe?g|png|webp|gif)$/i.test(entry.name) ? 'photo' : 'video';
                yield { value: { type: type, path: entryRelativePath, name: entry.name } };
            }
        }
    } catch (e) {
        logger.error(`[DB-WORKER] 遍历目录失败: ${dir}`, e);
    }
}


const tasks = {
    async rebuild_index({ photosDir }) {
        logger.info('[DB-WORKER] 开始执行索引重建任务...');
        try {
            await dbRun("BEGIN TRANSACTION");
            await dbRun("DELETE FROM items");
            await dbRun("DELETE FROM items_fts");

            const itemsStmt = db.prepare("INSERT OR IGNORE INTO items (name, path, type) VALUES (?, ?, ?)");
            const ftsStmt = db.prepare("INSERT INTO items_fts (rowid, name) VALUES (?, ?)");

            let count = 0;
            for await (const { value } of walkDirStream(photosDir)) {
                await new Promise((resolve, reject) => {
                    itemsStmt.run(value.name, value.path, value.type, function(err) {
                        if (err) return reject(err);
                        const searchableText = value.path.replace(/[\/\\]/g, ' '); 
                        const tokenizedName = createNgrams(searchableText, 1, 2);
                        ftsStmt.run(this.lastID, tokenizedName, (ftsErr) => {
                             if (ftsErr) return reject(ftsErr);
                             resolve();
                        });
                    });
                });
                count++;
            }
            
            await new Promise((resolve, reject) => itemsStmt.finalize(err => err ? reject(err) : resolve()));
            await new Promise((resolve, reject) => ftsStmt.finalize(err => err ? reject(err) : resolve()));
            await dbRun("COMMIT");

            logger.info(`[DB-WORKER] 索引重建完成，共处理 ${count} 个条目。`);
            parentPort.postMessage({ type: 'rebuild_complete', count });
        } catch (error) {
            logger.error('[DB-WORKER] 重建索引失败:', error.message);
            await dbRun("ROLLBACK").catch(rbError => logger.error('[DB-WORKER] 事务回滚失败:', rbError.message));
            parentPort.postMessage({ type: 'error', error: error.message });
        }
    },
    async process_changes({ changes, photosDir }) {
        if (!changes || changes.length === 0) return;
        logger.info(`[DB-WORKER] 开始处理 ${changes.length} 个索引变更...`);
        try {
            await dbRun("BEGIN TRANSACTION");
            for (const change of changes) {
                const relativePath = path.relative(photosDir, change.filePath);
                const name = path.basename(change.filePath);
                switch (change.type) {
                    case 'add':
                    case 'addDir':
                        const type = change.type === 'add' 
                            ? (/\.(jpe?g|png|webp|gif)$/i.test(name) ? 'photo' : 'video')
                            : 'album';
                        const result = await dbRun("INSERT OR IGNORE INTO items (name, path, type) VALUES (?, ?, ?)", [name, relativePath, type]);
                        if (result.changes > 0) {
                            const searchableText = relativePath.replace(/[\/\\]/g, ' ');
                            const tokenizedName = createNgrams(searchableText, 1, 2);
                            await dbRun("INSERT INTO items_fts (rowid, name) VALUES (?, ?)", [result.lastID, tokenizedName]);
                            logger.info(`[DB-WORKER] 索引新增: ${relativePath}`);
                        }
                        break;
                    case 'unlink':
                    case 'unlinkDir':
                        await dbRun("DELETE FROM items WHERE path = ? OR path LIKE ?", [relativePath, `${relativePath}/%`]);
                        logger.info(`[DB-WORKER] 索引删除: ${relativePath}`);
                        break;
                }
            }
            await dbRun("COMMIT");
            logger.info('[DB-WORKER] 索引增量更新完成。');
            parentPort.postMessage({ type: 'process_changes_complete' });
        } catch (error) {
            logger.error('[DB-WORKER] 处理索引变更失败:', error.message);
            await dbRun("ROLLBACK").catch(rbError => logger.error('[DB-WORKER] 事务回滚失败:', rbError.message));
            parentPort.postMessage({ type: 'error', error: error.message });
        }
    },
    
    async update_view_time({ userId, path: itemPath }) {
        if (!itemPath || !userId) return;

        try {
            // 只 prepare 一次，循环 run，最后 finalize
            const insertStmt = db.prepare("INSERT OR REPLACE INTO view_history (user_id, item_path, viewed_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
            
            // 2. 标记当前路径及其所有上级路径
            const pathParts = itemPath.split('/');
            const allPathsToUpdate = [];
            for (let i = 1; i <= pathParts.length; i++) {
                allPathsToUpdate.push(pathParts.slice(0, i).join('/'));
            }
            logger.info(`[VIEW_UPDATE] 将为用户 ${userId} 标记以下所有路径为已读: ${JSON.stringify(allPathsToUpdate)}`);

            for (const p of allPathsToUpdate) {
                if (p) await new Promise((resolve, reject) => insertStmt.run(userId, p, (err) => err ? reject(err) : resolve()));
            }
            await new Promise((resolve, reject) => insertStmt.finalize((err) => err ? reject(err) : resolve()));
            logger.debug(`[DB-WORKER] 成功为用户 ${userId} 更新 ${allPathsToUpdate.length} 条查看时间记录。`);

            // 3. 清理缓存的逻辑保持不变
            const parentDirectoriesToClear = allPathsToUpdate.map(p => path.dirname(p)).map(p => p === '.' ? '' : p);
            const uniqueParentDirs = [...new Set(parentDirectoriesToClear)];
            const keysToClear = new Set();
            for (const dir of uniqueParentDirs) {
                 const pattern = `route_cache:${userId}:/api/browse/${dir}*`;
                 const stream = redis.scanStream({ match: pattern });
                 for await (const keys of stream) {
                    keys.forEach(key => keysToClear.add(key));
                 }
            }
            if (keysToClear.size > 0) {
                await redis.del(...keysToClear);
                logger.info(`[DB-WORKER] 因查看操作，清除了 ${keysToClear.size} 个相关缓存键`);
            }
        } catch (error) {
            logger.error(`[DB-WORKER] 更新查看时间失败 for user ${userId}, path ${itemPath}: ${error.message}`);
        }
    },

    async get_all_media_items() {
        try {
            const items = await dbAll("SELECT path, type FROM items WHERE type = 'photo' OR type = 'video'");
            parentPort.postMessage({ type: 'all_media_items_result', payload: items });
        } catch (error) {
            logger.error('[DB-WORKER] 获取所有媒体项目失败:', error.message);
            parentPort.postMessage({ type: 'error', error: error.message });
        }
    }
};

parentPort.on('message', async (task) => {
    const handler = tasks[task.type];
    if (handler) {
        await handler(task.payload);
    } else {
        logger.warn(`[DB-WORKER] 收到未知任务类型: ${task.type}`);
    }
});