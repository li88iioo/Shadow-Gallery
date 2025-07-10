const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');

const dbWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'db-worker.js'));
const videoWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'video-processor.js'));

const thumbnailWorkers = [];
const idleThumbnailWorkers = [];

const createThumbnailWorkerPool = () => {
    logger.info(`创建 ${NUM_WORKERS} 个缩略图处理工人...`);
    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'), {
            workerData: { workerId: i + 1 }
        });
        thumbnailWorkers.push(worker);
        idleThumbnailWorkers.push(worker);
    }
};

module.exports = {
    dbWorker,
    videoWorker,
    thumbnailWorkers,
    idleThumbnailWorkers,
    createThumbnailWorkerPool,
};