const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { THUMBS_DIR, MAX_THUMBNAIL_RETRIES, INITIAL_RETRY_DELAY } = require('../config');
const { idleThumbnailWorkers } = require('./worker.manager');
const { dbWorker } = require('./worker.manager');

const highPriorityThumbnailQueue = [];
const lowPriorityThumbnailQueue = [];
const activeTasks = new Set();
const failureCounts = new Map();

function setupThumbnailWorkerListeners() {
    idleThumbnailWorkers.forEach((worker, index) => {
        worker.on('message', async (result) => {
            const { success, error, task, workerId } = result;
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

            idleThumbnailWorkers.push(worker);
            dispatchThumbnailTask();
        });

        worker.on('error', (err) => logger.error(`缩略图工人 ${index + 1} 遇到错误:`, err));
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`缩略图工人 ${index + 1} 退出，代码: ${code}`);
        });
    });
}

function dispatchThumbnailTask() {
    while (idleThumbnailWorkers.length > 0) {
        let task = null;
        if (highPriorityThumbnailQueue.length > 0) {
            task = highPriorityThumbnailQueue.shift();
        } else if (lowPriorityThumbnailQueue.length > 0) {
            task = lowPriorityThumbnailQueue.shift();
        } else {
            break;
        }

        const worker = idleThumbnailWorkers.shift();
        
        if (activeTasks.has(task.relativePath)) {
            idleThumbnailWorkers.push(worker); // Put worker back
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
        return { status: 'exists', path: thumbUrl };
    } catch (e) {
        const isPermanentlyFailed = await redis.get(`thumb_failed_permanently:${sourceRelPath}`);
        if (isPermanentlyFailed) {
            return { status: 'failed' };
        }

        if (!isTaskQueuedOrActive(sourceRelPath)) {
            logger.info(`[高优先级] 浏览器请求缩略图 ${sourceRelPath}，任务插入VIP队列。`);
            highPriorityThumbnailQueue.unshift({
                filePath: sourceAbsPath,
                relativePath: sourceRelPath,
                type: isVideo ? 'video' : 'photo'
            });
            dispatchThumbnailTask();
        } else {
            logger.debug(`缩略图 ${sourceRelPath} 已在队列或正在处理中，等待完成。`);
        }

        return { status: 'processing' };
    }
}

async function startIdleThumbnailGeneration() {
    logger.info('[Main-Thread] 准备启动智能缩略图后台生成任务...');
    dbWorker.postMessage({ type: 'get_all_media_items' });
}


module.exports = {
    setupThumbnailWorkerListeners,
    dispatchThumbnailTask,
    isTaskQueuedOrActive,
    ensureThumbnailExists,
    startIdleThumbnailGeneration,
    lowPriorityThumbnailQueue,
};