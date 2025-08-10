const { parentPort } = require('worker_threads');
const path = require('path');
const os = require('os');
const winston = require('winston');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const { initializeConnections, getDB } = require('../db/multi-db');
const { redis } = require('../config/redis');

// 引入通用 ngram 工具函数，避免重复实现
const { createNgrams } = require('../utils/search.utils');

(async () => {
    await initializeConnections();
    // --- 日志配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'debug',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [INDEXING-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const { runAsync, dbRun, dbAll } = require('../db/multi-db');

    // --- 辅助函数 ---
    const { promises: fs } = require('fs');
    
    // --- 性能优化配置 ---
    const THREAD_POOL_SIZE = Math.min(os.cpus().length * 2, 8); // 增加到8个并发
    const CONCURRENT_LIMIT = 50; // 同时处理的文件数量限制
    const DIMENSION_CACHE = new Map(); // 尺寸信息缓存
    const CACHE_TTL = 1000 * 60 * 10; // 缓存10分钟
    
    // 清理过期缓存
    const cacheCleanupInterval = setInterval(() => {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [key, value] of DIMENSION_CACHE.entries()) {
            if (now - value.timestamp > CACHE_TTL) {
                DIMENSION_CACHE.delete(key);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            logger.debug(`[缓存清理] 清理了 ${cleanedCount} 个过期缓存项，当前缓存大小: ${DIMENSION_CACHE.size}`);
        }
    }, CACHE_TTL);

    // 监听worker退出事件，清理定时器防止内存泄漏
    process.on('exit', () => {
        clearInterval(cacheCleanupInterval);
        DIMENSION_CACHE.clear();
        logger.debug('[内存清理] Worker退出，已清理所有缓存和定时器');
    });

    /**
     * 获取媒体文件的尺寸信息（带缓存）
     * @param {string} filePath - 文件绝对路径
     * @param {string} type - 文件类型 ('photo' 或 'video')
     * @param {number} mtime - 文件修改时间
     * @returns {Promise<{width: number, height: number}>}
     */
    async function getMediaDimensions(filePath, type, mtime) {
        const cacheKey = `${filePath}:${mtime}`;
        
        // 检查缓存
        const cached = DIMENSION_CACHE.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            return cached.dimensions;
        }
        
        try {
            let dimensions;
            if (type === 'video') {
                dimensions = await new Promise((resolve) => {
                    ffmpeg.ffprobe(filePath, (err, metadata) => {
                        if (err) {
                            logger.debug(`ffprobe 失败: ${path.basename(filePath)}`);
                            return resolve({ width: 1920, height: 1080 }); // 默认视频尺寸
                        }
                        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                        if (videoStream && videoStream.width && videoStream.height) {
                            resolve({ width: videoStream.width, height: videoStream.height });
                        } else {
                            resolve({ width: 1920, height: 1080 });
                        }
                    });
                });
            } else {
                // 图片文件
                const metadata = await sharp(filePath).metadata();
                dimensions = { 
                    width: metadata.width || 1920, 
                    height: metadata.height || 1080 
                };
            }
            
            // 存入缓存
            DIMENSION_CACHE.set(cacheKey, {
                dimensions,
                timestamp: Date.now()
            });
            
            return dimensions;
        } catch (error) {
            logger.debug(`获取文件尺寸失败: ${path.basename(filePath)}, ${error.message}`);
            const defaultDimensions = { width: 1920, height: 1080 };
            
            // 即使失败也缓存默认值，避免重复尝试
            DIMENSION_CACHE.set(cacheKey, {
                dimensions: defaultDimensions,
                timestamp: Date.now()
            });
            
            return defaultDimensions;
        }
    }
    
    /**
     * 并行处理文件尺寸获取
     * @param {Array} items - 待处理的文件项目列表
     * @param {string} photosDir - 照片目录路径
     * @returns {Promise<Array>} 处理后的项目列表
     */
    /**
     * 控制并发数量的处理函数
     */
    async function processConcurrentBatch(items, concurrency, processor) {
        const results = [];
        for (let i = 0; i < items.length; i += concurrency) {
            const batch = items.slice(i, i + concurrency);
            const batchResults = await Promise.all(batch.map(processor));
            results.push(...batchResults);
        }
        return results;
    }

    async function processDimensionsInParallel(items, photosDir) {
        logger.info(`[并行处理] 开始处理 ${items.length} 个项目，并发限制: ${CONCURRENT_LIMIT}`);
        const startTime = Date.now();
        
        // 直接使用高并发处理所有项目
        const results = await processConcurrentBatch(items, CONCURRENT_LIMIT, async (item) => {
            let width = null, height = null;
            
            if (item.type === 'photo' || item.type === 'video') {
                const fullPath = path.resolve(photosDir, item.path);
                try {
                    const dimensions = await getMediaDimensions(fullPath, item.type, item.mtime);
                    width = dimensions.width;
                    height = dimensions.height;
                } catch (error) {
                    logger.debug(`获取 ${item.path} 尺寸失败: ${error.message}`);
                    width = item.type === 'video' ? 1920 : 1920;
                    height = item.type === 'video' ? 1080 : 1080;
                }
            }
            
            return { ...item, width, height };
        });
        
        const endTime = Date.now();
        logger.info(`[并行处理] 完成处理 ${items.length} 个项目，耗时: ${endTime - startTime}ms`);
        return results;
    }

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
                // 重置索引状态，标记为正在构建
                await dbRun('index', "DELETE FROM index_status");
                await dbRun('index', "INSERT INTO index_status (id, status, processed_files) VALUES (1, 'building', 0)");

                const batchSize = 1000; // 优化批次大小以平衡内存和性能
                let count = 0;
                
                // 清空现有数据（注意：应用层维护 FTS，无触发器）
                await dbRun('main', "DELETE FROM items");
                await dbRun('main', "DELETE FROM items_fts");
                
                const itemsStmt = getDB('main').prepare("INSERT INTO items (name, path, type, mtime, width, height) VALUES (?, ?, ?, ?, ?, ?)");
                const ftsStmt = getDB('main').prepare("INSERT INTO items_fts (rowid, name) VALUES (?, ?)");
                
                let batch = [];
                for await (const item of walkDirStream(photosDir)) {
                    batch.push(item);
                    if (batch.length >= batchSize) {
                        // 并行处理尺寸获取
                        const processedBatch = await processDimensionsInParallel(batch, photosDir);
                        // 批次事务：提交后前端即可查询到已索引的记录，实现“边建边可见”
                        await dbRun('main', 'BEGIN IMMEDIATE');
                        try {
                            await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt);
                            await dbRun('main', 'COMMIT');
                        } catch (e) {
                            await dbRun('main', 'ROLLBACK').catch(()=>{});
                            throw e;
                        }
                        count += batch.length;
                        // 更新进度到数据库
                        await dbRun('index', "UPDATE index_status SET processed_files = ? WHERE id = 1", [count]);
                        logger.info(`[INDEXING-WORKER] 已处理 ${count} 个条目...`);
                        batch = [];
                    }
                }
                if (batch.length > 0) {
                    // 并行处理最后一批
                    const processedBatch = await processDimensionsInParallel(batch, photosDir);
                    await dbRun('main', 'BEGIN IMMEDIATE');
                    try {
                        await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt);
                        await dbRun('main', 'COMMIT');
                    } catch (e) {
                        await dbRun('main', 'ROLLBACK').catch(()=>{});
                        throw e;
                    }
                    count += batch.length;
                    // 更新最终进度
                    await dbRun('index', "UPDATE index_status SET processed_files = ? WHERE id = 1", [count]);
                }
                
                await new Promise((resolve, reject) => itemsStmt.finalize(err => err ? reject(err) : resolve()));
                await new Promise((resolve, reject) => ftsStmt.finalize(err => err ? reject(err) : resolve()));
                
                // 标记索引完成
                await dbRun('index', "UPDATE index_status SET status = 'complete', processed_files = ? WHERE id = 1", [count]);

                logger.info(`[INDEXING-WORKER] 索引重建完成，共处理 ${count} 个条目。`);
                parentPort.postMessage({ type: 'rebuild_complete', count });
            } catch (error) {
                logger.error('[INDEXING-WORKER] 重建索引失败:', error.message);
                // 最外层失败尝试回滚当前事务（若存在）
                await dbRun('main', 'ROLLBACK').catch(()=>{});
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
                    
                                    // 优化FTS索引内容：移除文件扩展名，为视频文件添加类型标签
                const baseText = item.path.replace(/\.[^.]+$/, '').replace(/[\/\\]/g, ' ');
                const typeLabel = item.type === 'video' ? ' mp4 avi mov webm video' : ' jpg png webp gif photo';
                const searchableText = baseText + typeLabel;
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
        
        async processBatchInTransaction(batch, itemsStmt, ftsStmt, photosDir) {
            // 在现有事务中处理批次，不创建新事务
            for (const item of batch) {
                let width = null, height = null;
                
                // 为媒体文件获取尺寸信息
                if (item.type === 'photo' || item.type === 'video') {
                    const fullPath = path.resolve(photosDir, item.path);
                    try {
                        const dimensions = await getMediaDimensions(fullPath, item.type, item.mtime);
                        width = dimensions.width;
                        height = dimensions.height;
                    } catch (error) {
                        logger.debug(`获取 ${item.path} 尺寸失败: ${error.message}`);
                        // 使用默认值
                        width = item.type === 'video' ? 1920 : 1920;
                        height = item.type === 'video' ? 1080 : 1080;
                    }
                }
                
                const result = await new Promise((resolve, reject) => {
                    itemsStmt.run(item.name, item.path, item.type, item.mtime, width, height, function(err) {
                        if (err) return reject(err);
                        resolve({ lastID: this.lastID });
                    });
                });
                
                // 优化FTS索引内容：移除文件扩展名，为视频文件添加类型标签
                const baseText = item.path.replace(/\.[^.]+$/, '').replace(/[\/\\]/g, ' ');
                const typeLabel = item.type === 'video' ? ' mp4 avi mov webm video' : ' jpg png webp gif photo';
                const searchableText = baseText + typeLabel;
                const tokenizedName = createNgrams(searchableText, 1, 2);
                await new Promise((resolve, reject) => {
                    ftsStmt.run(result.lastID, tokenizedName, (err) => {
                         if (err) return reject(err);
                         resolve();
                    });
                });
            }
        },
        
        async processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt) {
            // 处理已经获取尺寸信息的批次，不需要再次获取尺寸
            for (const item of processedBatch) {
                const result = await new Promise((resolve, reject) => {
                    itemsStmt.run(item.name, item.path, item.type, item.mtime, item.width, item.height, function(err) {
                        if (err) return reject(err);
                        resolve({ lastID: this.lastID });
                    });
                });
                
                // 优化FTS索引内容：移除文件扩展名，为视频文件添加类型标签
                const baseText = item.path.replace(/\.[^.]+$/, '').replace(/[\/\\]/g, ' ');
                const typeLabel = item.type === 'video' ? ' mp4 avi mov webm video' : ' jpg png webp gif photo';
                const searchableText = baseText + typeLabel;
                const tokenizedName = createNgrams(searchableText, 1, 2);
                await new Promise((resolve, reject) => {
                    ftsStmt.run(result.lastID, tokenizedName, (err) => {
                         if (err) return reject(err);
                         resolve();
                    });
                });
            }
        },

        async process_changes({ changes, photosDir }) {
            if (!changes || changes.length === 0) return;
            logger.info(`[INDEXING-WORKER] 开始处理 ${changes.length} 个索引变更...`);
            try {
                await dbRun('main', "BEGIN TRANSACTION");
                const changedAlbumPaths = new Set();
                
                // 批量处理添加操作
                const addOperations = [];
                const deleteOperations = [];
                
                // 预处理所有变更，收集操作
                for (const change of changes) {
                    const relativePath = path.relative(photosDir, change.filePath);
                    const name = path.basename(change.filePath);
                    const parentDir = path.dirname(relativePath);
                    if (parentDir !== '.') {
                        changedAlbumPaths.add(parentDir);
                    }

                    if (change.type === 'add' || change.type === 'addDir') {
                        const stats = await fs.stat(change.filePath).catch(() => ({ mtimeMs: Date.now() }));
                        if (change.type === 'add') {
                            // 仅当明确匹配图片或视频扩展名时才入库；否则跳过（避免将 .db/.wal/.shm 等当作视频）
                            if (/\.(jpe?g|png|webp|gif)$/i.test(name)) {
                                addOperations.push({ name, relativePath, type: 'photo', mtime: stats.mtimeMs });
                            } else if (/\.(mp4|webm|mov)$/i.test(name)) {
                                addOperations.push({ name, relativePath, type: 'video', mtime: stats.mtimeMs });
                            } else {
                                // 非媒体文件：不入库，不触发缩略图
                                continue;
                            }
                        } else {
                            addOperations.push({ name, relativePath, type: 'album', mtime: stats.mtimeMs });
                        }
                    } else if (change.type === 'unlink' || change.type === 'unlinkDir') {
                        deleteOperations.push(relativePath);
                    }
                }
                
                // 批量执行删除操作
                if (deleteOperations.length > 0) {
                    // 构建批量删除的SQL语句
                    const deletePaths = deleteOperations.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
                    const deleteLikeConditions = deleteOperations.map(p => `path LIKE '${p + '/%'}'`).join(' OR ');
                    
                    const deleteSQL = `DELETE FROM items WHERE path IN (${deletePaths}) OR ${deleteLikeConditions}`;
                    await dbRun('main', deleteSQL);
                    logger.info(`[INDEXING-WORKER] 批量删除 ${deleteOperations.length} 个索引项`);
                }
                
                // 批量执行添加操作
                if (addOperations.length > 0) {
                    const itemsStmt = getDB('main').prepare("INSERT OR IGNORE INTO items (name, path, type, mtime, width, height) VALUES (?, ?, ?, ?, ?, ?)");
                    const ftsStmt = getDB('main').prepare("INSERT INTO items_fts (rowid, name) VALUES (?, ?)");
                    
                    for (const operation of addOperations) {
                        let width = null, height = null;
                        
                        // 为媒体文件获取尺寸信息（带缓存）
                        if (operation.type === 'photo' || operation.type === 'video') {
                            const fullPath = path.resolve(photosDir, operation.relativePath);
                            try {
                                const dimensions = await getMediaDimensions(fullPath, operation.type, operation.mtime);
                                width = dimensions.width;
                                height = dimensions.height;
                            } catch (error) {
                                logger.debug(`获取 ${operation.relativePath} 尺寸失败: ${error.message}`);
                                // 使用默认值
                                width = operation.type === 'video' ? 1920 : 1920;
                                height = operation.type === 'video' ? 1080 : 1080;
                            }
                        }
                        
                        const result = await new Promise((resolve, reject) => {
                            itemsStmt.run(operation.name, operation.relativePath, operation.type, operation.mtime, width, height, function(err) {
                                if (err) return reject(err);
                                resolve({ lastID: this.lastID });
                            });
                        });
                        
                        if (result.lastID) {
                            // 优化FTS索引内容：移除文件扩展名，为视频文件添加类型标签
                            const baseText = operation.relativePath.replace(/\.[^.]+$/, '').replace(/[\/\\]/g, ' ');
                            const typeLabel = operation.type === 'video' ? ' mp4 avi mov webm video' : ' jpg png webp gif photo';
                            const searchableText = baseText + typeLabel;
                            const tokenizedName = createNgrams(searchableText, 1, 2);
                            await new Promise((resolve, reject) => {
                                ftsStmt.run(result.lastID, tokenizedName, (err) => {
                                    if (err) return reject(err);
                                    resolve();
                                });
                            });
                        }
                    }
                    
                    await new Promise((resolve, reject) => itemsStmt.finalize(err => err ? reject(err) : resolve()));
                    await new Promise((resolve, reject) => ftsStmt.finalize(err => err ? reject(err) : resolve()));
                    logger.info(`[INDEXING-WORKER] 批量添加 ${addOperations.length} 个索引项`);
                }
                
                await dbRun('main', "COMMIT");

                if (changedAlbumPaths.size > 0) {
                    const cacheKeys = Array.from(changedAlbumPaths).map(p => `cover_info:${p}`);
                    await redis.del(cacheKeys);
                    logger.info(`[INDEXING-WORKER] 清理了 ${cacheKeys.length} 个相册的封面缓存。`);
                }

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