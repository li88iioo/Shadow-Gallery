const app = require('./app');
const { promises: fs } = require('fs');
const path = require('path');
const logger = require('./config/logger');
const { PORT, THUMBS_DIR } = require('./config');
const { initializeDB } = require('./db/sqlite');
const { createThumbnailWorkerPool } = require('./services/worker.manager');
const { setupThumbnailWorkerListeners } = require('./services/thumbnail.service');
const { setupWorkerListeners, buildSearchIndex, watchPhotosDir } = require('./services/indexer.service');

async function checkDirectoryWritable(directory) {
    const testFile = path.join(directory, '.writetest');
    try {
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
        logger.info(`目录 ${directory} 写入权限检查通过。`);
    } catch (error) {
        logger.error(`!!!!!!!!!!!!!!!!!!!! 致命错误：权限不足 !!!!!!!!!!!!!!!!!!!!`);
        logger.error(`无法写入目录: ${directory}`);
        logger.error(`错误详情: ${error.message}`);
        logger.error(`请检查您的 Docker 挂载设置，并确保运行容器的用户对该目录有完全的读写权限。`);
        logger.error(`程序将在5秒后退出...`);
        setTimeout(() => process.exit(1), 5000);
    }
}

async function startServer() {
    logger.info(`后端服务正在启动...`);
    try {
        // 1. 确保目录存在且可写
        await fs.mkdir(THUMBS_DIR, { recursive: true });
        await checkDirectoryWritable(THUMBS_DIR);
        
        // 2. 初始化数据库
        await initializeDB();
        
        // 3. 创建 Worker Pool
        createThumbnailWorkerPool();
        
        // 4. 设置所有 Worker 的事件监听器
        setupWorkerListeners(); // DB and Video worker listeners
        setupThumbnailWorkerListeners(); // Thumbnail worker listeners
        
        // 5. 启动 Express 应用
        app.listen(PORT, async () => {
            logger.info(`后端服务已启动在 http://localhost:${PORT}`);
            logger.info(`照片目录: ${process.env.PHOTOS_DIR}`);
            logger.info(`数据目录: ${process.env.DATA_DIR}`);

            if (!process.env.ONEAPI_URL || !process.env.ONEAPI_KEY) {
                logger.warn('警告: AI服务环境变量未设置，AI功能将不可用。');
            }

            // 6. 首次构建索引并开始监控文件
            await buildSearchIndex();
            watchPhotosDir();
        });

    } catch (error) {
        logger.error('启动过程中发生致命错误:', error.message);
        setTimeout(() => process.exit(1), 5000);
    }
}

startServer();