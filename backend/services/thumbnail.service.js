/**
 * 缩略图服务模块
 * 管理缩略图的生成、队列调度和工作线程协调，支持优先级队列和失败重试机制
 */
const crypto = require('crypto');
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { THUMBS_DIR, MAX_THUMBNAIL_RETRIES, INITIAL_RETRY_DELAY } = require('../config');
const { idleThumbnailWorkers } = require('./worker.manager');
const { indexingWorker } = require('./worker.manager');
const eventBus = require('./event.service');

// 缩略图任务队列管理
const highPriorityThumbnailQueue = [];  // 高优先级队列（浏览器直接请求）
const lowPriorityThumbnailQueue = [];   // 低优先级队列（后台批量生成）
const activeTasks = new Set();          // 正在处理的任务集合
const failureCounts = new Map();        // 任务失败次数统计

/**
 * 设置缩略图工作线程监听器
 * 为每个空闲工作线程添加消息处理和错误监听
 */
function setupThumbnailWorkerListeners() {
    idleThumbnailWorkers.forEach((worker, index) => {
        // 监听工作线程完成消息
        worker.on('message', async (result) => {
            const { success, error, task, workerId } = result;
            const relativePath = task.relativePath;
            const workerLogId = `[THUMBNAIL-WORKER-${workerId || '?'}]`;
            const failureKey = `thumb_failed_permanently:${relativePath}`;

            // 从活动任务集合中移除已完成的任务
            activeTasks.delete(relativePath);

            if (success) {
                // 任务成功处理
                logger.info(`${workerLogId} 成功处理任务: ${relativePath}`);
                failureCounts.delete(relativePath);

                // >>> 发射事件，通知 SSE 等监听器
                eventBus.emit('thumbnail-generated', { path: relativePath });

                // 清理Redis中的永久失败标记
                await redis.del(failureKey).catch(err => logger.warn(`清理Redis永久失败标记时出错: ${err.message}`));
                // 成功后可在此处打点（供可观测性使用）
                try { await redis.incr('metrics:thumb:success'); } catch {}
            } else {
                // 任务处理失败，实现指数退避重试机制
                const currentFailures = (failureCounts.get(relativePath) || 0) + 1;
                failureCounts.set(relativePath, currentFailures);
                logger.error(`${workerLogId} 处理任务失败: ${relativePath} (第 ${currentFailures} 次)。错误: ${error}`);
                try { await redis.incr('metrics:thumb:fail'); } catch {}

                if (currentFailures < MAX_THUMBNAIL_RETRIES) {
                    // 计算重试延迟时间（指数退避）
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, currentFailures - 1);
                    logger.warn(`任务 ${relativePath} 将在 ${retryDelay / 1000}秒 后重试...`);
                    setTimeout(() => {
                        // 将失败任务重新加入高优先级队列
                        highPriorityThumbnailQueue.unshift(task);
                        dispatchThumbnailTask();
                    }, retryDelay);
                } else {
                    // 达到最大重试次数，标记为永久失败
                    logger.error(`任务 ${relativePath} 已达到最大重试次数 (${MAX_THUMBNAIL_RETRIES}次)，标记为永久失败。`);
                    await redis.set(failureKey, '1', 'EX', 3600 * 24 * 7); // 缓存7天
                    try { await redis.incr('metrics:thumb:permanent_fail'); } catch {}
                }
            }

            // 将工作线程放回空闲队列，继续处理下一个任务
            idleThumbnailWorkers.push(worker);
            dispatchThumbnailTask();
        });

        // 监听工作线程错误和退出事件
        worker.on('error', (err) => logger.error(`缩略图工人 ${index + 1} 遇到错误:`, err));
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`缩略图工人 ${index + 1} 退出，代码: ${code}`);
        });
    });
}

/**
 * 调度缩略图任务
 * 从队列中取出任务分配给空闲的工作线程
 */
function dispatchThumbnailTask() {
    while (idleThumbnailWorkers.length > 0) {
        let task = null;
        
        // 优先处理高优先级队列中的任务
        if (highPriorityThumbnailQueue.length > 0) {
            task = highPriorityThumbnailQueue.shift();
        } else if (lowPriorityThumbnailQueue.length > 0) {
            // 不占用最后一个空闲工人，预留以便随时响应用户操作（高优先级）
            if (idleThumbnailWorkers.length > 1) {
                task = lowPriorityThumbnailQueue.shift();
            } else {
                break;
            }
        } else {
            break; // 没有任务可处理
        }

        // 额外防御：若拿到非媒体任务（历史脏数据或外部注入），直接丢弃并继续
        if (!task || !/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(task.filePath || task.relativePath || '')) {
            continue;
        }

        const worker = idleThumbnailWorkers.shift();
        
        // 检查任务是否已在处理中，避免重复处理
        if (activeTasks.has(task.relativePath)) {
            idleThumbnailWorkers.push(worker); // 将工作线程放回空闲队列
            continue;
        }

        // 标记任务为活动状态，发送给工作线程处理
        activeTasks.add(task.relativePath);
        worker.postMessage({ ...task, thumbsDir: THUMBS_DIR });
    }
}

/**
 * 检查任务是否已在队列或正在处理中
 * @param {string} relativePath - 相对路径
 * @returns {boolean} 如果任务已排队或正在处理返回true
 */
function isTaskQueuedOrActive(relativePath) {
    if (activeTasks.has(relativePath)) return true;
    if (highPriorityThumbnailQueue.some(t => t.relativePath === relativePath)) return true;
    if (lowPriorityThumbnailQueue.some(t => t.relativePath === relativePath)) return true;
    return false;
}

/**
 * 确保缩略图存在
 * 检查缩略图是否存在，不存在则创建生成任务
 * @param {string} sourceAbsPath - 源文件绝对路径
 * @param {string} sourceRelPath - 源文件相对路径
 * @returns {Promise<Object>} 缩略图状态信息
 */
async function ensureThumbnailExists(sourceAbsPath, sourceRelPath) {
    // 检查是否包含 @eaDir，如果是则直接返回失败状态
    if (sourceRelPath.includes('@eaDir')) {
        logger.debug(`跳过 @eaDir 文件的缩略图生成: ${sourceRelPath}`);
        return { status: 'failed' };
    }

    // 根据文件类型确定缩略图格式
    const isVideo = /\.(mp4|webm|mov)$/i.test(sourceAbsPath);
    const extension = isVideo ? '.jpg' : '.webp';
    const thumbRelPath = sourceRelPath.replace(/\.[^.]+$/, extension);
    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
    // 修复：使用API调用方式生成缩略图URL，与文件服务保持一致
    const thumbUrl = `/api/thumbnail?path=${encodeURIComponent(sourceRelPath)}`;

    try {
        // 检查缩略图文件是否存在
        await fs.access(thumbAbsPath);
        return { status: 'exists', path: thumbUrl };
    } catch (e) {
        // 检查是否已标记为永久失败
        const isPermanentlyFailed = await redis.get(`thumb_failed_permanently:${sourceRelPath}`);
        if (isPermanentlyFailed) {
            return { status: 'failed' };
        }

        // 如果任务未在队列或处理中，创建新的生成任务
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

/**
 * 启动空闲缩略图生成任务
 * 向索引工作线程请求所有媒体文件，用于后台批量生成缩略图
 */
async function startIdleThumbnailGeneration() {
    logger.info('[Main-Thread] 准备启动智能缩略图后台生成任务...');
    indexingWorker.postMessage({ type: 'get_all_media_items' });
}

// 导出缩略图服务函数
module.exports = {
    setupThumbnailWorkerListeners,    // 设置工作线程监听器
    dispatchThumbnailTask,            // 调度缩略图任务
    isTaskQueuedOrActive,             // 检查任务状态
    ensureThumbnailExists,            // 确保缩略图存在
    startIdleThumbnailGeneration,     // 启动后台生成任务
    lowPriorityThumbnailQueue,        // 低优先级队列（供外部访问）
};