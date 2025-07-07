const { parentPort } = require('worker_threads');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { promises: fs } = require('fs');
const winston = require('winston');
const Redis = require('ioredis'); // <--- 新增此行
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379'); // <--- 新增此行


function createNgrams(text, minGram = 1, maxGram = 2) {
    const sanitizedText = text.toLowerCase().replace(/\s+/g, '');
    const ngrams = new Set(); // 使用 Set 自动去重

    for (let n = minGram; n <= maxGram; n++) {
        for (let i = 0; i < sanitizedText.length - n + 1; i++) {
            ngrams.add(sanitizedText.substring(i, i + n));
        }
    }
    return Array.from(ngrams).join(' ');
}

// --- 日志配置 ---
// Worker内的日志，可以简化配置，或与主线程保持一致
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [DB-WORKER] ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});


// --- 数据库连接 ---
// Worker 必须独立维护自己的数据库连接
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, 'data');
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        logger.error(`[DB-WORKER] 无法连接到 SQLite 数据库: ${err.message}`);
        // 关键：如果数据库连接失败，需要通知主线程并退出
        parentPort.postMessage({ type: 'error', error: err.message });
        process.exit(1);
    }
    logger.info('[DB-WORKER] 成功连接到 SQLite 数据库。');
    
    // 设置 5 秒的忙时超时
    db.configure('busyTimeout', 5000);
    
    // **关键：在Worker中也开启WAL模式**
    db.run('PRAGMA journal_mode = WAL;', (walErr) => {
        if (walErr) {
             logger.error(`[DB-WORKER] 开启 WAL 模式失败: ${walErr.message}`);
        } else {
             logger.info('[DB-WORKER] 成功开启 WAL 模式。');
        }
    });
});

// --- 辅助函数 ---
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));

const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => {
    if (err) rej(err);
    else res(rows);
}));
async function* walkDirStream(dir, relativePath = '') {
    // (这个函数和 server.js 中的版本相同)
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);

            if (entry.isDirectory()) {
                if (entry.name === '@eaDir') {
                    continue; // 跳过当前循环，不处理这个目录
                }
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

// --- 任务处理逻辑 ---
const tasks = {
    async rebuild_index({ photosDir }) {
        logger.info('[DB-WORKER] 开始执行索引重建任务...');
        try {
            await dbRun("BEGIN TRANSACTION");
            // 清理 items 和 items_fts 表
            await dbRun("DELETE FROM items");
            await dbRun("DELETE FROM items_fts");

            const itemsStmt = db.prepare("INSERT OR IGNORE INTO items (name, path, type) VALUES (?, ?, ?)");
            const ftsStmt = db.prepare("INSERT INTO items_fts (rowid, name) VALUES (?, ?)");

            let count = 0;
            for await (const { value } of walkDirStream(photosDir)) {
                // 使用 run 的回调来获取 lastID (即 rowid)
                await new Promise((resolve, reject) => {
                    itemsStmt.run(value.name, value.path, value.type, function(err) {
                        if (err) return reject(err);
                        
                        // --- ↓↓↓ 使用 n-gram 替换旧的分词逻辑 ↓↓↓ ---
                        const searchableText = value.path.replace(/[\/\\]/g, ' '); 
                        const tokenizedName = createNgrams(searchableText, 1, 2); // 1-gram 和 2-gram

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

    /**
     * 批量处理文件系统变更
     */
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
                    case 'addDir': // 将 add 和 addDir 逻辑合并
                        const type = change.type === 'add' 
                            ? (/\.(jpe?g|png|webp|gif)$/i.test(name) ? 'photo' : 'video')
                            : 'album';
                        
                        const result = await dbRun("INSERT OR IGNORE INTO items (name, path, type) VALUES (?, ?, ?)", [name, relativePath, type]);
                        
                        if (result.changes > 0) {
                            // --- ↓↓↓使用 n-gram 替换旧的分词逻辑 ↓↓↓ ---
                            const searchableText = relativePath.replace(/[\/\\]/g, ' ');
                            const tokenizedName = createNgrams(searchableText, 1, 2); // 1-gram 和 2-gram
                            await dbRun("INSERT INTO items_fts (rowid, name) VALUES (?, ?)", [result.lastID, tokenizedName]);
                            logger.info(`[DB-WORKER] 索引新增: ${relativePath}`);
                        }
                        break;
                    case 'unlink':
                    case 'unlinkDir': // 将 unlink 和 unlinkDir 逻辑合并
                        // FTS 表的删除由数据库触发器自动处理，这里无需改动
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

    /**
     * 新增：更新项目的最后查看时间
     */
    async update_view_time({ path: itemPath }) {
        if (!itemPath) return;

        try {
            await dbRun("UPDATE items SET last_viewed_at = CURRENT_TIMESTAMP WHERE path = ?", [itemPath]);
            logger.debug(`[DB-WORKER] 成功更新查看时间: ${itemPath}`);

            // 更新成功后，清理其父目录的缓存，以确保排序能立即生效
            const parentPath = path.dirname(itemPath);
            const parentCachePath = (parentPath === '.' || parentPath === '/') ? '' : parentPath;
            const parentCacheKeyPattern = `browse:${parentCachePath}:*`;

            // 使用 scan 和 del 安全地清除缓存
            const stream = redis.scanStream({ match: parentCacheKeyPattern });
            const keysToClear = [];
            stream.on('data', (keys) => keys.forEach(key => keysToClear.push(key)));
            stream.on('end', async () => {
                if (keysToClear.length > 0) {
                    await redis.del(keysToClear);
                    logger.info(`[DB-WORKER] 因查看操作，清除了父目录缓存: ${keysToClear.join(', ')}`);
                }
            });

        } catch (error) {
            logger.error(`[DB-WORKER] 更新查看时间失败 for path ${itemPath}: ${error.message}`);
        }
    },

    /**
     * 新增：获取所有媒体类型项目的列表
     */
    async get_all_media_items() {
        try {
            // 查询数据库中所有类型为 'photo' 或 'video' 的条目
            const items = await dbAll("SELECT path, type FROM items WHERE type = 'photo' OR type = 'video'");
            // 将查询结果发送回主线程
            parentPort.postMessage({ type: 'all_media_items_result', payload: items });
        } catch (error) {
            logger.error('[DB-WORKER] 获取所有媒体项目失败:', error.message);
            parentPort.postMessage({ type: 'error', error: error.message });
        }
    }
};

// --- Worker 消息监听 ---
parentPort.on('message', async (task) => {
    const handler = tasks[task.type];
    if (handler) {
        await handler(task.payload);
    } else {
        logger.warn(`[DB-WORKER] 收到未知任务类型: ${task.type}`);
    }
});