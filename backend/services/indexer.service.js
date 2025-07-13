/**
 * 索引服务模块
 * 管理文件系统监控、索引重建、增量更新和缩略图生成协调
 */
const chokidar = require('chokidar');
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { indexingWorker, videoWorker } = require('./worker.manager');
const { startIdleThumbnailGeneration, lowPriorityThumbnailQueue, dispatchThumbnailTask, isTaskQueuedOrActive } = require('./thumbnail.service');
const settingsService = require('./settings.service');
const crypto = require('crypto');

// 索引服务状态管理
let rebuildTimeout;           // 重建超时定时器
let isIndexing = false;       // 索引进行中标志
let pendingIndexChanges = []; // 待处理的索引变更队列

/**
 * 设置工作线程监听器
 * 为索引工作线程、设置工作线程和视频工作线程添加消息处理
 */
function setupWorkerListeners() {
    // 索引工作线程消息处理
    indexingWorker.on('message', (msg) => {
        logger.debug(`收到来自 Indexing Worker 的消息: ${msg.type}`);
        switch (msg.type) {
            case 'rebuild_complete':
                // 索引重建完成，启动缩略图生成任务
                logger.info(`[Main-Thread] Indexing Worker 完成索引重建，共处理 ${msg.count} 个条目。`);
                isIndexing = false;
                logger.info('[Main-Thread] 准备启动智能缩略图后台生成任务...');
                startIdleThumbnailGeneration();
                indexingWorker.postMessage({ type: 'get_all_media_items' });
                break;

            case 'all_media_items_result':
                // 收到所有媒体项目，开始批量检查缩略图
                const items = msg.payload;
                logger.info(`[Main-Thread] 收到 ${items.length} 个媒体项目，开始在后台检查并生成缺失的缩略图...`);
                let checkIndex = 0;
                
                // 分批处理缩略图检查，避免阻塞主线程
                const processBatch = () => {
                    const batch = items.slice(checkIndex, checkIndex + 200);
                    if (batch.length === 0) {
                        logger.info('[Main-Thread] 所有缩略图均已检查完毕。');
                        return;
                    }
                    
                    // 检查每个媒体文件的缩略图是否存在
                    for (const item of batch) {
                        const sourceAbsPath = path.join(PHOTOS_DIR, item.path);
                        const isVideo = item.type === 'video';
                        const extension = isVideo ? '.jpg' : '.webp';
                        const safeFileName = item.path.replace(/[^a-zA-Z0-9]/g, '_') + extension;
                        const thumbPath = path.join(THUMBS_DIR, safeFileName);
                        
                        // 如果缩略图不存在且未在队列中，添加到低优先级队列
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
                    setTimeout(processBatch, 100); // 100ms延迟，避免阻塞
                };
                processBatch();
                break;

            case 'process_changes_complete':
                // 增量更新完成
                logger.info('[Main-Thread] Indexing Worker 完成索引增量更新。');
                isIndexing = false;
                break;
                
            case 'error':
                // 索引工作线程报告错误
                logger.error(`[Main-Thread] Indexing Worker 报告一个错误: ${msg.error}`);
                isIndexing = false;
                break;
            default:
                logger.warn(`[Main-Thread] 收到来自Indexing Worker的未知消息类型: ${msg.type}`);
        }
    });

    // 设置工作线程消息处理
    const { settingsWorker } = require('./worker.manager');
    settingsWorker.on('message', (msg) => {
        logger.debug(`收到来自 Settings Worker 的消息: ${msg.type}`);
        switch (msg.type) {
            case 'settings_update_complete':
                // 设置更新成功
                logger.info(`[Main-Thread] 设置更新成功: ${msg.updatedKeys.join(', ')}`);
                settingsService.clearCache();
                // 更新设置状态（如果控制器可用）
                try {
                    const { updateSettingsStatus } = require('../controllers/settings.controller');
                    updateSettingsStatus('success', '设置更新成功');
                } catch (e) {
                    logger.debug('无法更新设置状态（控制器可能未加载）');
                }
                break;
                
            case 'settings_update_failed':
                // 设置更新失败
                logger.error(`[Main-Thread] 设置更新失败: ${msg.error}, 涉及设置: ${msg.updatedKeys.join(', ')}`);
                // 更新设置状态（如果控制器可用）
                try {
                    const { updateSettingsStatus } = require('../controllers/settings.controller');
                    updateSettingsStatus('failed', msg.error);
                } catch (e) {
                    logger.debug('无法更新设置状态（控制器可能未加载）');
                }
                break;
                
            default:
                logger.warn(`[Main-Thread] 收到来自Settings Worker的未知消息类型: ${msg.type}`);
        }
    });

    // 索引工作线程错误和退出处理
    indexingWorker.on('error', (err) => {
        logger.error(`[Main-Thread] Indexing Worker 遇到致命错误，索引功能可能中断: ${err.message}`, err);
        isIndexing = false;
    });

    indexingWorker.on('exit', (code) => {
        if (code !== 0) {
            logger.warn(`[Main-Thread] Indexing Worker 意外退出，退出码: ${code}。索引功能将停止。`);
        }
        isIndexing = false;
    });

    // 视频工作线程消息处理
    videoWorker.on('message', (result) => {
        if (result.success) {
            logger.info(`视频处理完成或跳过: ${result.path}`);
            // 将处理完成的视频添加到待索引队列
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

/**
 * 计算文件内容哈希值（SHA256）
 * 用于检测文件是否真正发生变化
 * @param {string} filePath - 文件路径
 * @returns {Promise<string|null>} 文件哈希值或null
 */
async function computeFileHash(filePath) {
    try {
        const fileBuffer = await fs.readFile(filePath);
        const hashSum = crypto.createHash('sha256');
        hashSum.update(fileBuffer);
        return hashSum.digest('hex');
    } catch (err) {
        logger.warn(`计算文件 hash 失败: ${filePath}`, err);
        return null;
    }
}

/**
 * 合并索引变更事件
 * 将连续的变更事件合并，避免重复处理
 * @param {Array} changes - 原始变更事件数组
 * @returns {Array} 合并后的变更事件数组
 */
function consolidateIndexChanges(changes) {
    logger.info(`开始合并 ${changes.length} 个原始变更事件...`);
    const changeMap = new Map();
    
    for (const change of changes) {
        const { type, filePath, hash } = change;
        const existingChange = changeMap.get(filePath);
        
        if (existingChange) {
            // 处理文件删除和重新创建的情况
            if (((existingChange.type === 'add' && type === 'unlink') || (existingChange.type === 'addDir' && type === 'unlinkDir')) && existingChange.hash === hash) {
                // 添加后立即删除且哈希相同，视为无变化
                changeMap.delete(filePath);
            } else if (existingChange.type === 'add' && type === 'add' && existingChange.hash === hash) {
                // 连续两次添加且哈希相同，保留一次即可
                changeMap.set(filePath, change);
            } else {
                // 哈希不同，视为更新
                changeMap.set(filePath, { ...change, type: 'update' });
            }
        } else {
            changeMap.set(filePath, change);
        }
    }
    
    const consolidated = Array.from(changeMap.values());
    logger.info(`合并后剩余 ${consolidated.length} 个有效变更事件。`);
    return consolidated;
}

/**
 * 构建搜索索引
 * 执行全量索引重建
 */
async function buildSearchIndex() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次全量重建请求被跳过。');
        return;
    }
    isIndexing = true;
    logger.info('向 Indexing Worker 发送索引重建任务...');
    indexingWorker.postMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR } });
}

/**
 * 处理待处理的索引变更
 * 执行增量索引更新
 */
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

    // 执行增量索引更新
    isIndexing = true;
    logger.info(`向 Indexing Worker 发送 ${changesToProcess.length} 个索引变更以进行处理...`);
    indexingWorker.postMessage({ type: 'process_changes', payload: { changes: changesToProcess, photosDir: PHOTOS_DIR } });
}

/**
 * 触发延迟索引处理
 * 在文件系统稳定后清理相关缓存并处理索引变更
 * 使用5秒延迟确保文件系统操作完成
 */
function triggerDelayedIndexProcessing() {
    clearTimeout(rebuildTimeout);
    rebuildTimeout = setTimeout(async () => {
        logger.info('文件系统稳定，开始清理缓存并处理索引变更...');
        try {
            // 使用Redis scan流式清理浏览缓存
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
    }, 5000); // 5秒延迟，等待文件系统稳定
}


/**
 * 监控照片目录
 * 使用chokidar库监控文件系统变化，处理文件添加、删除、目录创建等事件
 */
function watchPhotosDir() {
    // 配置chokidar文件监控器
    const watcher = chokidar.watch(PHOTOS_DIR, {
        ignoreInitial: true,    // 忽略初始扫描
        persistent: true,       // 持续监控
        depth: 99,              // 监控深度99层
        ignored: /(^|[\/\\])\..|@eaDir/,  // 忽略隐藏文件和Synology系统目录
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }, // 等待文件写入完成
    });

    /**
     * 文件变更事件处理函数
     * 处理文件添加、删除、目录创建等事件
     * @param {string} type - 事件类型（add, unlink, addDir, unlinkDir）
     * @param {string} filePath - 文件路径
     */
    const onFileChange = async (type, filePath) => {
        logger.debug(`检测到文件变动: ${filePath} (${type})。等待文件系统稳定...`);

        // 处理新视频文件，发送到视频处理器进行优化
        if (type === 'add' && /\.(mp4|webm|mov)$/i.test(filePath)) {
            logger.info(`检测到新视频文件，发送到处理器进行优化: ${filePath}`);
            videoWorker.postMessage({ filePath });
            return;
        }

        // 处理文件删除事件，清理对应的缩略图
        if (type === 'unlink') {
            const relativePath = path.relative(PHOTOS_DIR, filePath);
            const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
            const extension = isVideo ? '.jpg' : '.webp';
            const safeFileName = relativePath.replace(/[^a-zA-Z0-9]/g, '_') + extension;
            const thumbPath = path.join(THUMBS_DIR, safeFileName);

            // 删除孤立的缩略图文件
            fs.unlink(thumbPath)
                .then(() => logger.info(`成功删除孤立的缩略图: ${thumbPath}`))
                .catch(err => {
                    if (err.code !== 'ENOENT') {
                        logger.error(`删除缩略图失败: ${thumbPath}`, err);
                    }
                });
        }
        
        // 只对添加事件计算文件哈希值，用于检测重复事件
        let hash = undefined;
        if (type === 'add') {
            hash = await computeFileHash(filePath);
        }
        
        // 避免重复添加相同的变更事件
        if (!pendingIndexChanges.some(c => c.type === type && c.filePath === filePath && (type !== 'add' || c.hash === hash))) {
            pendingIndexChanges.push({ type, filePath, ...(type === 'add' && hash ? { hash } : {}) });
        }
        
        // 触发延迟索引处理
        triggerDelayedIndexProcessing();
    };

    logger.info(`开始监控照片目录: ${PHOTOS_DIR}`);
    
    // 绑定文件系统事件监听器
    watcher
        .on('add', path => onFileChange('add', path))           // 文件添加事件
        .on('unlink', path => onFileChange('unlink', path))     // 文件删除事件
        .on('addDir', path => onFileChange('addDir', path))     // 目录添加事件
        .on('unlinkDir', path => onFileChange('unlinkDir', path)) // 目录删除事件
        .on('error', error => logger.error('目录监控出错:', error)); // 错误处理
}


// 导出索引服务函数
module.exports = {
    setupWorkerListeners,    // 设置工作线程监听器
    buildSearchIndex,        // 构建搜索索引
    watchPhotosDir,          // 监控照片目录
};