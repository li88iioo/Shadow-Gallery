// 引入所需模块
const express = require('express');
const {
    promises: fs
} = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const winston = require('winston');
const chokidar = require('chokidar');
const sqlite3 = require('sqlite3').verbose();
const {
    Worker
} = require('worker_threads');
const os = require('os');
const sharp = require('sharp');
const {
    Queue
} = require('bullmq');
const ffmpeg = require('fluent-ffmpeg');

// 生成 n-gram 分词字符串（用于模糊搜索）
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

// --- 配置 ---
const PORT = process.env.PORT || 13001;
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.resolve(__dirname, 'photos');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, 'data');
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');
const THUMBS_DIR = path.resolve(DATA_DIR, 'thumbnails');
const API_BASE = '';

// --- 更新占位符路径，指向容器内部 ---
const PLACEHOLDER_DIR = path.resolve(__dirname, 'assets');
const THUMB_PLACEHOLDER_PATH = path.join(PLACEHOLDER_DIR, 'loading-placeholder.svg');
const BROKEN_IMAGE_PATH = path.join(PLACEHOLDER_DIR, 'broken-image.svg');

// --- 日志, Redis, 数据库配置 ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
    retryStrategy: times => Math.min(times * 1000, 5000),
    maxRetriesPerRequest: 5
});
redis.on('connect', () => logger.info('Redis 连接成功!'));
redis.on('error', err => logger.error('Redis错误:', err.code === 'ECONNREFUSED' ? '无法连接Redis' : err));

// +++ 创建 BullMQ 任务队列实例 +++
const aiCaptionQueue = new Queue('ai-caption-queue', {
    connection: redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
    },
});
logger.info('AI 任务队列 (ai-caption-queue) 初始化成功。');


// --- 数据库索引专用 Worker ---
const dbWorker = new Worker(path.resolve(__dirname, 'db-worker.js'));

//  --- 视频处理器 Worker  ---
const videoWorker = new Worker(path.resolve(__dirname, 'video-processor.js'));
videoWorker.on('message', (result) => {
    if (result.success) {
        logger.info(`视频处理完成或跳过: ${result.path}`);
        if (!pendingIndexChanges.some(c => c.filePath === result.path)) {
            pendingIndexChanges.push({
                type: 'add',
                filePath: result.path
            });
        }
        clearTimeout(rebuildTimeout);
        rebuildTimeout = setTimeout(async () => {
            logger.info('文件系统稳定，开始清理缓存并处理索引变更...');
            try {
                const stream = redis.scanStream({
                    match: 'browse:*',
                    count: 100
                });
                const keysToClear = [];
                stream.on('data', (keys) => keys.forEach(key => keysToClear.push(key)));
                stream.on('end', async () => {
                    if (keysToClear.length > 0) {
                        await redis.del(keysToClear);
                        logger.info(`成功清除了 ${keysToClear.length} 个匹配的缓存。`);
                    }
                    await processPendingIndexChanges();
                });
            } catch (err) {
                logger.error('延迟清理缓存失败:', err);
                await processPendingIndexChanges();
            }
        }, 5000);

    } else {
        logger.error(`视频处理失败: ${result.path}, 原因: ${result.error}`);
    }
});
videoWorker.on('error', (err) => logger.error(`视频处理器Worker遇到错误: ${err.message}`));

// --- Worker Pool & 缩略图处理 ---
const NUM_WORKERS = Math.max(1, Math.floor(os.cpus().length / 2));
const workers = [];
const idleWorkers = [];
const MAX_THUMBNAIL_RETRIES = 5;
const INITIAL_RETRY_DELAY = 2000;
const highPriorityThumbnailQueue = [];
const lowPriorityThumbnailQueue = [];
const activeTasks = new Set();
const failureCounts = new Map();

function createWorkerPool() {
    logger.info(`创建 ${NUM_WORKERS} 个缩略图处理工人...`);
    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(path.resolve(__dirname, 'thumbnail-worker.js'), {
            workerData: {
                workerId: i + 1
            }
        });

        worker.on('message', async (result) => {
            const {
                success,
                error,
                task,
                workerId
            } = result;
            const relativePath = task.relativePath;
            const workerLogId = `[THUMBNAIL-WORKER-${workerId || '?'}]`;
            const failureKey = `thumb_failed_permanently:${relativePath}`;

            activeTasks.delete(relativePath);

            if (success) {
                logger.info(`${workerLogId} 成功处理任务: ${relativePath}`);
                failureCounts.delete(relativePath);
                await redis.del(failureKey).catch(err => logger.warn(`清理Redis永久失败标记时出错: ${err.message}`));
            } else {
                const currentFailures = (failureCounts.get(relativePath) || 0) + 1;
                failureCounts.set(relativePath, currentFailures);
                logger.error(`${workerLogId} 处理任务失败: ${relativePath} (第 ${currentFailures} 次)。错误: ${error}`);

                if (currentFailures < MAX_THUMBNAIL_RETRIES) {
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, currentFailures - 1);
                    logger.warn(`任务 ${relativePath} 将在 ${retryDelay / 1000}秒 后重试...`);
                    setTimeout(() => {
                        highPriorityThumbnailQueue.unshift(task);
                        dispatchThumbnailTask();
                    }, retryDelay);
                } else {
                    logger.error(`任务 ${relativePath} 已达到最大重试次数 (${MAX_THUMBNAIL_RETRIES}次)，标记为永久失败。`);
                    await redis.set(failureKey, '1', 'EX', 3600 * 24 * 7);
                }
            }

            idleWorkers.push(worker);
            dispatchThumbnailTask();
        });

        worker.on('error', (err) => logger.error(`缩略图工人 ${i + 1} 遇到错误:`, err));
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`缩略图工人 ${i + 1} 退出，代码: ${code}`);
        });

        workers.push(worker);
        idleWorkers.push(worker);
    }
}

function dispatchThumbnailTask() {
    while (idleWorkers.length > 0) {
        let task = null;
        if (highPriorityThumbnailQueue.length > 0) {
            task = highPriorityThumbnailQueue.shift();
        } else if (lowPriorityThumbnailQueue.length > 0) {
            task = lowPriorityThumbnailQueue.shift();
        } else {
            break;
        }

        const worker = idleWorkers.shift();

        if (activeTasks.has(task.relativePath)) {
            idleWorkers.push(worker);
            continue;
        }

        activeTasks.add(task.relativePath);
        worker.postMessage({ ...task, thumbsDir: THUMBS_DIR });
    }
}

function isTaskQueuedOrActive(relativePath) {
    if (activeTasks.has(relativePath)) return true;
    if (highPriorityThumbnailQueue.some(t => t.relativePath === relativePath)) return true;
    if (lowPriorityThumbnailQueue.some(t => t.relativePath === relativePath)) return true;
    return false;
}

async function ensureThumbnailExists(sourceAbsPath, sourceRelPath) {
    const isVideo = /\.(mp4|webm|mov)$/i.test(sourceAbsPath);
    const extension = isVideo ? '.jpg' : '.webp';
    const safeFileName = sourceRelPath.replace(/[^a-zA-Z0-9]/g, '_') + extension;
    const thumbPath = path.join(THUMBS_DIR, safeFileName);
    const thumbUrl = `/thumbs/${safeFileName}`;

    try {
        await fs.access(thumbPath);
        return {
            status: 'exists',
            path: thumbUrl
        };
    } catch (e) {
        const isPermanentlyFailed = await redis.get(`thumb_failed_permanently:${sourceRelPath}`);
        if (isPermanentlyFailed) {
            return {
                status: 'failed'
            };
        }

        if (!isTaskQueuedOrActive(sourceRelPath)) {
            logger.info(`[高优先级] 浏览器请求缩略图 ${sourceRelPath}，任务插入VIP队列。`);
            highPriorityThumbnailQueue.unshift({ // 使用 unshift() 将紧急任务插入到VIP队列的最前端
                filePath: sourceAbsPath,
                relativePath: sourceRelPath,
                type: isVideo ? 'video' : 'photo'
            });
            dispatchThumbnailTask();
        } else {
            logger.debug(`缩略图 ${sourceRelPath} 已在队列或正在处理中，等待完成。`);
        }

        return {
            status: 'processing'
        };
    }
}

// --- 数据库配置 ---
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) return logger.error(`无法连接或创建 SQLite 数据库: ${err.message}.`);
    logger.info('成功连接到 SQLite 数据库:', DB_FILE);

    db.configure('busyTimeout', 5000);

    db.run('PRAGMA journal_mode = WAL;', (walErr) => {
        if (walErr) {
            logger.error(`[Main-Thread] 开启 WAL 模式失败: ${walErr.message}`);
        } else {
            logger.info('[Main-Thread] 成功开启 WAL 模式。');
        }
    });
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, type TEXT NOT NULL, cover_path TEXT)`);
        db.all("PRAGMA table_info(items)", (err, rows) => {
            if (err) return logger.error("检查 items 表结构失败:", err.message);
            if (!rows.some(row => row.name === 'cover_path')) {
                db.run("ALTER TABLE items ADD COLUMN cover_path TEXT", (alterErr) => {
                    if (alterErr) logger.error("添加 cover_path 列失败:", alterErr.message);
                    else logger.info("成功为 items 表添加了 cover_path 列。");
                });
            }
            if (!rows.some(row => row.name === 'last_viewed_at')) {
                db.run("ALTER TABLE items ADD COLUMN last_viewed_at DATETIME", (alterErr) => {
                    if (alterErr) logger.error("添加 last_viewed_at 列失败:", alterErr.message);
                    else logger.info("成功为 items 表添加了 last_viewed_at 列。");
                });
            }
        });
        db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, content='items', content_rowid='id', tokenize = "unicode61")`);
        db.run(`CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, name) VALUES (new.id, new.name); END;`);
        db.run(`CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.id, old.name); END;`);
        db.run(`CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.id, old.name); INSERT INTO items_fts(rowid, name) VALUES (new.id, new.name); END;`);
    });
});
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) {
    if (err) rej(err);
    else res(this);
}));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => {
    if (err) rej(err);
    else res(rows);
}));


// --- 权限检查函数 ---
async function checkDirectoryWritable(directory) {
    const testFile = path.join(directory, '.writetest');
    try {
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
        logger.info(`目录 ${directory} 写入权限检查通过。`);
    } catch (error) {
        logger.error(`!!!!!!!!!!!!!!!!!!!! 致命错误：权限不足 !!!!!!!!!!!!!!!!!!!!`);
        logger.error(`无法写入缩略图目录: ${directory}`);
        logger.error(`错误详情: ${error.message}`);
        logger.error(`请检查您的 docker-compose.yml 文件中的 volumes 挂载设置，并确保运行Docker的用户对主机的'./data'目录有完全的读写权限。`);
        logger.error(`程序将在5秒后退出...`);
        setTimeout(() => process.exit(1), 5000);
        throw new Error(`Directory not writable: ${directory}`);
    }
}


// --- 辅助函数 (isPathSafe, sanitizePath, findCoverPhoto) ---
function isPathSafe(requestedPath) {
    const safeBaseDir = path.resolve(PHOTOS_DIR);
    const resolvedPath = path.resolve(safeBaseDir, requestedPath);
    const isSafe = resolvedPath.startsWith(safeBaseDir + path.sep) || resolvedPath === safeBaseDir;
    if (!isSafe) {
        logger.warn(`检测到不安全的路径访问尝试: 请求的路径 "${requestedPath}" 解析到了安全目录之外的 "${resolvedPath}"`);
    }
    return isSafe;
}

function sanitizePath(inputPath) {
    return inputPath.replace(/\.\./g, '').replace(/[<>:"|?*]/g, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

async function findCoverPhoto(directoryPath) {
    const cacheKey = `cover_info:${directoryPath.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`;
    try {
        const cachedCoverInfo = await redis.get(cacheKey);
        if (cachedCoverInfo) {
            return JSON.parse(cachedCoverInfo);
        }
        if (!directoryPath || typeof directoryPath !== 'string' || directoryPath.trim() === '') return null;
        const relativePath = path.relative(PHOTOS_DIR, directoryPath);
        if (!isPathSafe(relativePath)) return null;
        const entries = await fs.readdir(directoryPath, {
            withFileTypes: true
        });
        let foundCoverPath = null;
        for (const entry of entries) {
            if (entry.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(entry.name)) {
                foundCoverPath = path.join(directoryPath, entry.name);
                break;
            }
        }
        if (!foundCoverPath) {
            for (const entry of entries) {
                if (entry.isFile() && /\.(mp4|webm|mov)$/i.test(entry.name)) {
                    foundCoverPath = path.join(directoryPath, entry.name);
                    break;
                }
            }
        }
        if (!foundCoverPath) {
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const deeperCoverInfo = await findCoverPhoto(path.join(directoryPath, entry.name));
                    if (deeperCoverInfo && deeperCoverInfo.path) {
                        return deeperCoverInfo;
                    }
                }
            }
        }
        if (foundCoverPath) {
            let dimensions = {
                width: 1,
                height: 1
            };
            try {
                const isVideo = /\.(mp4|webm|mov)$/i.test(foundCoverPath);
                if (isVideo) {
                    dimensions = await getVideoDimensions(foundCoverPath);
                } else {
                    const metadata = await sharp(foundCoverPath).metadata();
                    dimensions = {
                        width: metadata.width,
                        height: metadata.height
                    };
                }
            } catch (e) {
                logger.error(`查找封面尺寸失败: ${foundCoverPath}`, e);
            }
            const coverInfo = {
                path: foundCoverPath,
                width: dimensions.width,
                height: dimensions.height
            };
            await redis.set(cacheKey, JSON.stringify(coverInfo), 'EX', 604800);
            return coverInfo;
        }
        return null;
    } catch (e) {
        logger.debug(`查找封面时发生错误: ${directoryPath}`, e);
        return null;
    }
}

function getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                logger.error(`ffprobe 失败: ${videoPath}`, err);
                return resolve({
                    width: 1,
                    height: 1
                });
            }
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            if (videoStream && videoStream.width && videoStream.height) {
                resolve({
                    width: videoStream.width,
                    height: videoStream.height
                });
            } else {
                logger.warn(`在 ${videoPath} 中未找到视频尺寸信息.`);
                resolve({
                    width: 1,
                    height: 1
                });
            }
        });
    });
}

async function getSortedDirectoryEntries(directory, relativePathPrefix) {
    let entries = await fs.readdir(directory, {
        withFileTypes: true
    });

    entries = entries.filter(e => e.name !== '@eaDir');

    const albumEntries = entries.filter(e => e.isDirectory());
    const mediaEntries = entries.filter(e => e.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(e.name));

    const albumsWithContext = await Promise.all(albumEntries.map(async e => {
        const entryRelativePath = path.join(relativePathPrefix, e.name).replace(/\\/g, '/');
        const fullAbsPath = path.join(directory, e.name);
        const dbResult = await dbAll("SELECT last_viewed_at FROM items WHERE path = ?", [entryRelativePath]);
        const stats = await fs.stat(fullAbsPath).catch(() => ({
            mtimeMs: 0
        }));
        return {
            entry: e,
            path: entryRelativePath,
            last_viewed_at: dbResult.length > 0 ? dbResult[0].last_viewed_at : null,
            mtime: stats.mtimeMs
        };
    }));

    let sortedAlbumEntries;
    if (relativePathPrefix === '') {
        const now = Date.now();
        const newThreshold = now - (24 * 60 * 60 * 1000);
        const newAlbums = albumsWithContext.filter(a => a.mtime > newThreshold);
        const oldAlbums = albumsWithContext.filter(a => a.mtime <= newThreshold);
        newAlbums.sort((a, b) => b.mtime - a.mtime);
        oldAlbums.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'zh-CN', {
            numeric: true,
            sensitivity: 'base'
        }));
        sortedAlbumEntries = [...newAlbums, ...oldAlbums].map(a => a.entry);
    } else {
        albumsWithContext.sort((a, b) => {
            const aIsViewed = a.last_viewed_at !== null;
            const bIsViewed = b.last_viewed_at !== null;
            if (aIsViewed && !bIsViewed) return 1;
            if (!aIsViewed && bIsViewed) return -1;
            return a.entry.name.localeCompare(b.entry.name, 'zh-CN', {
                numeric: true,
                sensitivity: 'base'
            });
        });
        sortedAlbumEntries = albumsWithContext.map(a => a.entry);
    }

    mediaEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', {
        numeric: true,
        sensitivity: 'base'
    }));
    return [...sortedAlbumEntries, ...mediaEntries];
}

async function getDirectoryContents(directory, relativePathPrefix, page, limit, req) {
    try {
        if (!isPathSafe(relativePathPrefix)) throw new Error('不安全的路径访问');

        const allSortedEntries = await getSortedDirectoryEntries(directory, relativePathPrefix);
        const totalResults = allSortedEntries.length;
        const totalPages = Math.ceil(totalResults / limit);
        const offset = (page - 1) * limit;
        const paginatedEntries = allSortedEntries.slice(offset, offset + limit);

        const items = await Promise.all(paginatedEntries.map(async (entry) => {
            const entryRelativePath = path.join(relativePathPrefix, entry.name);
            const fullAbsPath = path.join(PHOTOS_DIR, entryRelativePath);

            if (entry.isDirectory()) {
                const coverInfo = await findCoverPhoto(fullAbsPath);
                let coverUrl = 'data:image/svg+xml,...';
                let coverWidth = 1,
                    coverHeight = 1;
                if (coverInfo && coverInfo.path) {
                    const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                    coverUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}`;
                    coverWidth = coverInfo.width;
                    coverHeight = coverInfo.height;
                }
                return {
                    type: 'album',
                    data: {
                        name: entry.name,
                        path: entryRelativePath.replace(/\\/g, '/'),
                        coverUrl,
                        mtime: (await fs.stat(fullAbsPath).catch(() => ({
                            mtimeMs: 0
                        }))).mtimeMs,
                        coverWidth,
                        coverHeight
                    }
                };
            } else {
                const isVideo = /\.(mp4|webm|mov)$/i.test(entry.name);
                const stats = await fs.stat(fullAbsPath).catch(() => ({
                    mtimeMs: 0
                }));
                const cacheKey = `dim:${entryRelativePath}:${stats.mtimeMs}`;
                let dimensions = null;
                const cachedDimensions = await redis.get(cacheKey);

                if (cachedDimensions) {
                    dimensions = JSON.parse(cachedDimensions);
                } else {
                    try {
                        if (isVideo) {
                            dimensions = await getVideoDimensions(fullAbsPath);
                        } else {
                            const metadata = await sharp(fullAbsPath).metadata();
                            dimensions = {
                                width: metadata.width,
                                height: metadata.height
                            };
                        }
                        await redis.set(cacheKey, JSON.stringify(dimensions), 'EX', 60 * 60 * 24 * 30);
                    } catch (e) {
                        logger.error(`无法获取媒体文件尺寸: ${entryRelativePath}`, e);
                        dimensions = {
                            width: 1,
                            height: 1
                        };
                    }
                }

                const originalUrl = `/static/${entryRelativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
                const thumbnailUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(entryRelativePath)}`;

                return {
                    type: isVideo ? 'video' : 'photo',
                    data: {
                        originalUrl,
                        thumbnailUrl,
                        width: dimensions.width,
                        height: dimensions.height
                    }
                };
            }
        }));

        return {
            items,
            totalPages,
            totalResults
        };

    } catch (err) {
        logger.error(`获取目录内容时出错 ${directory}:`, err);
        throw err;
    }
}

// --- 搜索索引与文件监控  ---
let rebuildTimeout;
let isIndexing = false;
let pendingIndexChanges = [];
dbWorker.on('message', (msg) => {
    logger.debug(`收到来自 DB Worker 的消息: ${msg.type}`);
    switch (msg.type) {
        case 'rebuild_complete':
            logger.info(`[Main-Thread] DB Worker 完成索引重建，共处理 ${msg.count} 个条目。`);
            isIndexing = false;
            startIdleThumbnailGeneration();
            break;

        case 'all_media_items_result':
            const items = msg.payload;
            logger.info(`[Main-Thread] 收到 ${items.length} 个媒体项目，开始在后台检查并生成缺失的缩略图...`);

            let checkIndex = 0;
            const processBatch = () => {
                const batch = items.slice(checkIndex, checkIndex + 200);
                if (batch.length === 0) {
                    logger.info('[Main-Thread] 所有缩略图均已检查完毕。');
                    return;
                }

                for (const item of batch) {
                    const sourceAbsPath = path.join(PHOTOS_DIR, item.path);
                    const isVideo = item.type === 'video';
                    const extension = isVideo ? '.jpg' : '.webp';
                    const safeFileName = item.path.replace(/[^a-zA-Z0-9]/g, '_') + extension;
                    const thumbPath = path.join(THUMBS_DIR, safeFileName);

                    fs.access(thumbPath).catch(() => {
                        if (!isTaskQueuedOrActive(item.path)) {
                            lowPriorityThumbnailQueue.push({ 
                                filePath: sourceAbsPath,
                                relativePath: item.path,
                                type: item.type
                            });
                            dispatchThumbnailTask();
                        }
                    });
                }
                checkIndex += 200;
                setTimeout(processBatch, 100);
            };
            processBatch();
            break;

        case 'process_changes_complete':
            logger.info('[Main-Thread] DB Worker 完成索引增量更新。');
            isIndexing = false;
            break;
        case 'error':
            logger.error(`[Main-Thread] DB Worker 报告一个错误: ${msg.error}`);
            isIndexing = false;
            break;
        default:
            logger.warn(`[Main-Thread] 收到来自DB Worker的未知消息类型: ${msg.type}`);
    }
});
dbWorker.on('error', (err) => {
    logger.error(`[Main-Thread] DB Worker 遇到致命错误，索引功能可能中断: ${err.message}`, err);
    isIndexing = false;
});
dbWorker.on('exit', (code) => {
    if (code !== 0) {
        logger.warn(`[Main-Thread] DB Worker 意外退出，退出码: ${code}。索引功能将停止。`);
    }
    isIndexing = false;
});

function consolidateIndexChanges(changes) {
    logger.info(`开始合并 ${changes.length} 个原始变更事件...`);
    const changeMap = new Map();

    for (const change of changes) {
        const {
            type,
            filePath
        } = change;
        const existingChange = changeMap.get(filePath);

        if (existingChange) {
            if (existingChange.type === 'add' && type === 'unlink') {
                changeMap.delete(filePath);
            } else if (existingChange.type === 'addDir' && type === 'unlinkDir') {
                changeMap.delete(filePath);
            } else {
                changeMap.set(filePath, change);
            }
        } else {
            changeMap.set(filePath, change);
        }
    }

    const consolidated = Array.from(changeMap.values());
    logger.info(`合并后剩余 ${consolidated.length} 个有效变更事件。`);
    return consolidated;
}

async function buildSearchIndex() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次全量重建请求被跳过。');
        return;
    }
    isIndexing = true;
    logger.info('向 DB Worker 发送索引重建任务...');
    dbWorker.postMessage({
        type: 'rebuild_index',
        payload: {
            photosDir: PHOTOS_DIR
        }
    });
}
async function processPendingIndexChanges() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次增量更新请求被跳过。');
        return;
    }
    if (pendingIndexChanges.length === 0) return;

    const changesToProcess = consolidateIndexChanges(pendingIndexChanges);
    pendingIndexChanges = [];

    if (changesToProcess.length === 0) {
        logger.info('所有文件变更相互抵消，无需更新索引。');
        return;
    }

    if (changesToProcess.length > 1000) {
        logger.warn(`检测到超过 1000 个文件变更，将执行全量索引重建以保证数据一致性。`);
        await buildSearchIndex();
        return;
    }

    isIndexing = true;
    logger.info(`向 DB Worker 发送 ${changesToProcess.length} 个索引变更以进行处理...`);
    dbWorker.postMessage({
        type: 'process_changes',
        payload: {
            changes: changesToProcess,
            photosDir: PHOTOS_DIR
        }
    });
}

function watchPhotosDir() {
    const watcher = chokidar.watch(PHOTOS_DIR, {
        ignoreInitial: true,
        persistent: true,
        depth: 99,
        ignored: /(^|[\/\\])\..|@eaDir/,
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 100
        }
    });
    const triggerRebuild = (type, filePath) => {
        if (type === 'add' && /\.(mp4|webm|mov)$/i.test(filePath)) {
            logger.info(`检测到新视频文件，发送到处理器进行优化: ${filePath}`);
            videoWorker.postMessage({
                filePath
            });
            return;
        }

        if (type === 'unlink') {
            const relativePath = path.relative(PHOTOS_DIR, filePath);
            const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
            const extension = isVideo ? '.jpg' : '.webp';
            const safeFileName = relativePath.replace(/[^a-zA-Z0-9]/g, '_') + extension;
            const thumbPath = path.join(THUMBS_DIR, safeFileName);

            fs.unlink(thumbPath)
                .then(() => logger.info(`成功删除孤立的缩略图: ${thumbPath}`))
                .catch(err => {
                    if (err.code !== 'ENOENT') {
                        logger.error(`删除缩略图失败: ${thumbPath}`, err);
                    }
                });
        }

        clearTimeout(rebuildTimeout);
        logger.debug(`检测到文件变动: ${filePath} (${type})。等待文件系统稳定...`);
        if (!pendingIndexChanges.some(c => c.type === type && c.filePath === filePath)) {
            pendingIndexChanges.push({
                type,
                filePath
            });
        }
        rebuildTimeout = setTimeout(async () => {
            logger.info('文件系统稳定，开始清理缓存并处理索引变更...');
            try {
                const stream = redis.scanStream({
                    match: 'browse:*',
                    count: 100
                });
                const keysToClear = [];
                stream.on('data', (keys) => keys.forEach(key => keysToClear.push(key)));
                stream.on('end', async () => {
                    if (keysToClear.length > 0) {
                        await redis.del(keysToClear);
                        logger.info(`成功清除了 ${keysToClear.length} 个匹配的缓存。`);
                    }
                    await processPendingIndexChanges();
                });
            } catch (err) {
                logger.error('延迟清理缓存失败:', err);
                await processPendingIndexChanges();
            }
        }, 5000);
    };
    logger.info(`开始监控照片目录: ${PHOTOS_DIR}`);
    watcher.on('add', path => triggerRebuild('add', path)).on('unlink', path => triggerRebuild('unlink', path)).on('addDir', path => triggerRebuild('addDir', path)).on('unlinkDir', path => triggerRebuild('unlinkDir', path)).on('error', error => logger.error('目录监控出错:', error));
}


// --- Express App & API Endpoints ---
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({
    limit: '50mb'
}));
const apiLimiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW_MINUTES || 15) * 60 * 1000,
    max: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
    message: {
        error: '请求过于频繁，请稍后再试。'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);
app.use('/static', express.static(PHOTOS_DIR, {
    maxAge: '30d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        }
    }
}));
app.use('/thumbs', express.static(THUMBS_DIR, {
    maxAge: '30d',
    immutable: true
}));

app.post('/api/browse', async (req, res) => {
    const {
        path: queryPath = ''
    } = req.body;

    const limit = parseInt(req.query.limit, 10) || 50;
    const page = parseInt(req.query.page, 10) || 1;

    const cacheKey = `browse:${queryPath}:page:${page}:limit:${limit}`;

    try {
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
            logger.debug(`成功命中 /api/browse 缓存: ${cacheKey}`);
            res.setHeader('X-Cache', 'HIT');
            return res.json(JSON.parse(cachedData));
        }
        logger.debug(`未命中 /api/browse 缓存: ${cacheKey}，将从源获取数据。`);
        res.setHeader('X-Cache', 'MISS');

        const sanitizedPath = sanitizePath(queryPath);
        if (!isPathSafe(sanitizedPath)) {
            return res.status(403).json({
                error: '路径访问被拒绝'
            });
        }

        if (sanitizedPath) {
            dbWorker.postMessage({
                type: 'update_view_time',
                payload: {
                    path: sanitizedPath
                }
            });
        }

        const currentPath = path.join(PHOTOS_DIR, sanitizedPath);
        const stats = await fs.stat(currentPath).catch(() => null);
        if (!stats || !stats.isDirectory()) {
            return res.status(404).json({
                error: '路径未找到或不是目录'
            });
        }

        const {
            items,
            totalPages,
            totalResults
        } = await getDirectoryContents(currentPath, sanitizedPath, page, limit, req);

        const responseData = {
            items: items,
            page,
            totalPages,
            totalResults
        };

        await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 3600);

        res.json(responseData);

    } catch (err) {
        logger.error(`处理 /api/browse 请求时出错: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({
                error: '服务器内部错误',
                message: err.message
            });
        }
    }
});




app.get('/api/search', async (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        if (!query) {
            return res.status(400).json({ error: '搜索关键词不能为空' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = (page - 1) * limit;
        // 移除非法的FTS查询字符，并将它们替换为空格
        const sanitizedQuery = query.replace(/[(){}\[\]\/\\."*?!:^~+-,]/g, ' ').trim();
        if (!sanitizedQuery) {
            return res.json({
                query: query,
                results: [],
                page: 1,
                totalPages: 1,
                totalResults: 0,
                limit: limit
            });
        }
        const searchableQuery = createNgrams(query, 1, 2);
        const ftsQuery = searchableQuery; 

        const cacheKey = `search_v11:${query}:page:${page}:limit:${limit}`;
        
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
            logger.debug(`成功命中 /api/search 缓存: ${cacheKey}`);
            res.setHeader('X-Cache', 'HIT');
            return res.json(JSON.parse(cachedData));
        }
        res.setHeader('X-Cache', 'MISS');

        const allResultsSql = `SELECT i.id, i.path, i.type, i.name FROM items_fts JOIN items i ON items_fts.rowid = i.id WHERE items_fts.name MATCH ? ORDER BY rank`;
        const allMatchingResults = await dbAll(allResultsSql, [ftsQuery]);

        // 只保留相册和视频
        const typeFilteredResults = allMatchingResults.filter(result => {
            return result.type === 'album' || result.type === 'video';
        });

        // 过滤掉作为其他结果容器的上层目录
        const parentPaths = new Set();
        typeFilteredResults.forEach(result => {
            const parent = path.dirname(result.path);
            if (parent && parent !== '.') {
                parentPaths.add(parent);
            }
        });
        const finalFilteredResults = typeFilteredResults.filter(result => {
            return !(result.type === 'album' && parentPaths.has(result.path));
        });

        const totalResults = finalFilteredResults.length;
        const totalPages = Math.ceil(totalResults / limit);
        const paginatedResults = finalFilteredResults.slice(offset, offset + limit);

        const resultsWithData = await Promise.all(paginatedResults.map(async (result) => {
            if (!result) return null;
            const parentPath = path.dirname(result.path).replace(/\\/g, '/');
            if (result.type === 'album') {
                const coverInfo = await findCoverPhoto(path.join(PHOTOS_DIR, result.path));
                let coverUrl = 'data:image/svg+xml,...';
                let coverWidth = 1, coverHeight = 1;
                if (coverInfo && coverInfo.path) {
                    const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                    coverUrl = `/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}`;
                    coverWidth = coverInfo.width;
                    coverHeight = coverInfo.height;
                }
                return { ...result, path: result.path.replace(/\\/g, '/'), coverUrl, parentPath, coverWidth, coverHeight };
            } else { // 视频
                const originalUrl = `/static/${result.path.split(path.sep).map(encodeURIComponent).join('/')}`;
                const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(result.path)}`;
                return { ...result, path: result.path.replace(/\\/g, '/'), originalUrl, thumbnailUrl, parentPath };
            }
        }));

        const responseData = {
            query,
            results: resultsWithData.filter(Boolean),
            page,
            totalPages,
            totalResults,
            limit
        };

        await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 3600);
        res.json(responseData);
    } catch (err) {
        logger.error("FTS 搜索 API 顶层出错:", err.message);
        res.status(500).json({ error: '搜索失败' });
    }
});

app.post('/api/ai/generate', async (req, res) => {
    if (!process.env.ONEAPI_URL || !process.env.ONEAPI_KEY) {
        return res.status(500).json({
            error: 'AI服务未在后端配置'
        });
    }

    try {
        const {
            image_path
        } = req.body;
        if (!image_path) {
            return res.status(400).json({
                error: '缺少必要的参数: image_path'
            });
        }

        let cleanPath = image_path;
        if (cleanPath.startsWith('/static/')) {
            cleanPath = cleanPath.substring(7);
        }
        const sanitizedPath = sanitizePath(cleanPath);
        if (!isPathSafe(sanitizedPath)) {
            return res.status(403).json({
                error: '不安全的图片路径'
            });
        }

        const cacheKey = `ai_description:${sanitizedPath}`;
        const cachedDescription = await redis.get(cacheKey);
        if (cachedDescription) {
            logger.info(`从 Redis 缓存获取图片描述: ${sanitizedPath}`);
            return res.json({
                description: cachedDescription,
                source: 'cache'
            });
        }

        const job = await aiCaptionQueue.add('generate-caption', {
            imagePath: sanitizedPath
        });

        res.status(202).json({
            message: 'AI caption generation has been queued.',
            jobId: job.id,
        });

    } catch (error) {
        logger.error('派发AI任务时出错:', error.message);
        res.status(500).json({
            error: '派发AI任务时发生内部错误'
        });
    }
});

app.get('/api/ai/job/:jobId', async (req, res) => {
    const {
        jobId
    } = req.params;
    const job = await aiCaptionQueue.getJob(jobId);

    if (!job) {
        return res.status(404).json({
            error: 'Job not found'
        });
    }

    const state = await job.getState();
    const result = job.returnvalue;
    const failedReason = job.failedReason;

    if (state === 'completed' && result?.success) {
        const imagePath = job.data.imagePath;
        const cacheKey = `ai_description:${imagePath}`;
        await redis.set(cacheKey, result.caption, 'EX', 3600 * 24 * 7);
        logger.info(`任务 #${jobId} 结果已写入缓存。`);
    }

    res.json({
        jobId,
        state,
        result,
        failedReason,
    });
});


app.get('/api/thumbnail', async (req, res) => {
    try {
        const relativePath = req.query.path;
        if (!relativePath || !isPathSafe(relativePath)) {
            return res.status(400).send('Invalid or unsafe path');
        }

        const sourceAbsPath = path.join(PHOTOS_DIR, relativePath);
        const {
            status,
            path: thumbUrl
        } = await ensureThumbnailExists(sourceAbsPath, relativePath);

        switch (status) {
            case 'exists':
                res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
                res.sendFile(path.join(THUMBS_DIR, path.basename(thumbUrl)));
                break;
            case 'processing':
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.status(202).sendFile(THUMB_PLACEHOLDER_PATH);
                break;
            case 'failed':
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.status(500).sendFile(BROKEN_IMAGE_PATH);
                break;
        }
    } catch (error) {
        logger.error(`Error in /api/thumbnail: ${error.message}`);
        res.status(500).sendFile(BROKEN_IMAGE_PATH);
    }
});

app.get('/health', (req, res) => res.json({
    status: 'ok'
}));

// --- App Start ---
app.listen(PORT, async () => {
    logger.info(`后端服务正在启动...`);
    try {
        await fs.mkdir(THUMBS_DIR, {
            recursive: true
        });
        await checkDirectoryWritable(THUMBS_DIR);
        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, type TEXT NOT NULL, cover_path TEXT)`, (err) => {
                    if (err) return reject(err);
                    db.all("PRAGMA table_info(items)", (err, rows) => {
                        if (err) return reject(err);
                        let pendingMigrations = [];

                        if (!rows.some(row => row.name === 'cover_path')) {
                            pendingMigrations.push(new Promise((res, rej) => {
                                db.run("ALTER TABLE items ADD COLUMN cover_path TEXT", (alterErr) => {
                                    if (alterErr) {
                                        logger.error("添加 cover_path 列失败:", alterErr.message);
                                        rej(alterErr);
                                    } else {
                                        logger.info("成功为 items 表添加了 cover_path 列。");
                                        res();
                                    }
                                });
                            }));
                        }
                        if (!rows.some(row => row.name === 'last_viewed_at')) {
                            pendingMigrations.push(new Promise((res, rej) => {
                                db.run("ALTER TABLE items ADD COLUMN last_viewed_at DATETIME", (alterErr) => {
                                    if (alterErr) {
                                        logger.error("添加 last_viewed_at 列失败:", alterErr.message);
                                        rej(alterErr);
                                    } else {
                                        logger.info("成功为 items 表添加了 last_viewed_at 列。");
                                        res();
                                    }
                                });
                            }));
                        }
                        pendingMigrations.push(new Promise((res, rej) => {
                            db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, content='items', content_rowid='id', tokenize = "unicode61")`, (err) => {
                                if (err) return rej(err);
                                db.run(`CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, name) VALUES (new.id, new.name); END;`, (err) => {
                                    if (err) return rej(err);
                                    db.run(`CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.id, old.name); END;`, (err) => {
                                        if (err) return rej(err);
                                        db.run(`CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.id, old.name); INSERT INTO items_fts(rowid, name) VALUES (new.id, new.name); END;`, (err) => {
                                            if (err) return rej(err);
                                            res();
                                        });
                                    });
                                });
                            });
                        }));

                        Promise.all(pendingMigrations).then(resolve).catch(reject);
                    });
                });
            });
        });
        logger.info('所有数据库迁移已完成。');

        createWorkerPool();
        logger.info(`后端服务已启动在 http://localhost:${PORT}`);
        logger.info(`照片目录: ${PHOTOS_DIR}`);
        logger.info(`数据目录: ${DATA_DIR}`);
        if (!process.env.ONEAPI_URL || !process.env.ONEAPI_KEY) {
            logger.warn('警告: AI服务环境变量未设置，AI功能将不可用。');
        }
        await buildSearchIndex();
        watchPhotosDir();

    } catch (error) {
        logger.error('启动过程中发生致命错误:', error.message);
        setTimeout(() => process.exit(1), 5000);
    }
});

/**
 * 启动一个后台任务，用于在应用空闲时生成所有缺失的缩略图。
 */
async function startIdleThumbnailGeneration() {
    logger.info('[Main-Thread] 准备启动智能缩略图后台生成任务...');
    dbWorker.postMessage({
        type: 'get_all_media_items'
    });
}
