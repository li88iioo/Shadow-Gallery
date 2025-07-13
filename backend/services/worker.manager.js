/**
 * 工作线程管理器模块
 * 管理各种后台任务的工作线程，包括索引、设置、历史记录、视频处理和缩略图生成
 */
const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');

// 创建专门的单例工作线程
// 这些工作线程处理特定的后台任务，每个任务类型只有一个实例
const indexingWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'indexing-worker.js'));
const settingsWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'settings-worker.js'));
const historyWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'history-worker.js'));

// 视频处理工作线程
// 处理视频文件的转码、压缩等操作
const videoWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'video-processor.js'));

// 缩略图工作线程池管理
// 使用线程池模式处理缩略图生成任务，提高并发处理能力
const thumbnailWorkers = [];        // 所有缩略图工作线程的数组
const idleThumbnailWorkers = [];    // 空闲的缩略图工作线程队列

/**
 * 创建缩略图工作线程池
 * 根据配置的工作线程数量创建缩略图处理线程池
 */
const createThumbnailWorkerPool = () => {
    logger.info(`创建 ${NUM_WORKERS} 个缩略图处理工人...`);
    
    // 创建指定数量的缩略图工作线程
    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'), {
            workerData: { workerId: i + 1 }  // 为每个工作线程分配唯一ID
        });
        
        // 将工作线程添加到管理数组中
        thumbnailWorkers.push(worker);
        idleThumbnailWorkers.push(worker);
    }
};

// 设置专门工作线程的错误处理
// 为索引、设置和历史记录工作线程添加统一的错误处理机制
[indexingWorker, settingsWorker, historyWorker].forEach((worker, index) => {
    const workerNames = ['indexingWorker', 'settingsWorker', 'historyWorker'];
    
    // 监听工作线程错误事件
    worker.on('error', (err) => {
        logger.error(`${workerNames[index]} 遇到错误:`, err);
    });
    
    // 监听工作线程退出事件
    worker.on('exit', (code) => {
        if (code !== 0) {
            logger.warn(`${workerNames[index]} 意外退出，退出码: ${code}`);
        }
    });
});

// 导出工作线程管理器
module.exports = {
    // 专门的单例工作线程
    indexingWorker,    // 文件索引工作线程
    settingsWorker,    // 设置管理工作线程
    historyWorker,     // 历史记录工作线程
    
    // 其他工作线程
    videoWorker,       // 视频处理工作线程
    thumbnailWorkers,  // 缩略图工作线程池
    idleThumbnailWorkers, // 空闲缩略图工作线程队列
    createThumbnailWorkerPool, // 创建缩略图工作线程池的函数
};