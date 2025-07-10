const chokidar = require('chokidar');
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { dbWorker, videoWorker } = require('./worker.manager');
const { startIdleThumbnailGeneration, lowPriorityThumbnailQueue, dispatchThumbnailTask, isTaskQueuedOrActive } = require('./thumbnail.service');

let rebuildTimeout;
let isIndexing = false;
let pendingIndexChanges = [];

function setupWorkerListeners() {
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

    videoWorker.on('message', (result) => {
        if (result.success) {
            logger.info(`视频处理完成或跳过: ${result.path}`);
            if (!pendingIndexChanges.some(c => c.filePath === result.path)) {
                pendingIndexChanges.push({ type: 'add', filePath: result.path });
            }
            triggerDelayedIndexProcessing();
        } else {
            logger.error(`视频处理失败: ${result.path}, 原因: ${result.error}`);
        }
    });

    videoWorker.on('error', (err) => logger.error(`视频处理器Worker遇到错误: ${err.message}`));
}

function consolidateIndexChanges(changes) {
    logger.info(`开始合并 ${changes.length} 个原始变更事件...`);
    const changeMap = new Map();
    for (const change of changes) {
        const { type, filePath } = change;
        const existingChange = changeMap.get(filePath);
        if (existingChange) {
            if ((existingChange.type === 'add' && type === 'unlink') || (existingChange.type === 'addDir' && type === 'unlinkDir')) {
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
    dbWorker.postMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR } });
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
    dbWorker.postMessage({ type: 'process_changes', payload: { changes: changesToProcess, photosDir: PHOTOS_DIR } });
}

function triggerDelayedIndexProcessing() {
    clearTimeout(rebuildTimeout);
    rebuildTimeout = setTimeout(async () => {
        logger.info('文件系统稳定，开始清理缓存并处理索引变更...');
        try {
            const stream = redis.scanStream({ match: 'browse:*', count: 100 });
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
}


function watchPhotosDir() {
    const watcher = chokidar.watch(PHOTOS_DIR, {
        ignoreInitial: true,
        persistent: true,
        depth: 99,
        ignored: /(^|[\/\\])\..|@eaDir/,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    });

    const onFileChange = (type, filePath) => {
        logger.debug(`检测到文件变动: ${filePath} (${type})。等待文件系统稳定...`);

        if (type === 'add' && /\.(mp4|webm|mov)$/i.test(filePath)) {
            logger.info(`检测到新视频文件，发送到处理器进行优化: ${filePath}`);
            videoWorker.postMessage({ filePath });
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
        
        if (!pendingIndexChanges.some(c => c.type === type && c.filePath === filePath)) {
            pendingIndexChanges.push({ type, filePath });
        }
        
        triggerDelayedIndexProcessing();
    };

    logger.info(`开始监控照片目录: ${PHOTOS_DIR}`);
    watcher
        .on('add', path => onFileChange('add', path))
        .on('unlink', path => onFileChange('unlink', path))
        .on('addDir', path => onFileChange('addDir', path))
        .on('unlinkDir', path => onFileChange('unlinkDir', path))
        .on('error', error => logger.error('目录监控出错:', error));
}


module.exports = {
    setupWorkerListeners,
    buildSearchIndex,
    watchPhotosDir,
};