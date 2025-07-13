/**
 * 后端服务器主入口文件
 * 
 * 负责：
 * - 服务器启动和初始化
 * - 数据库连接管理
 * - 工作线程池创建和管理
 * - 文件系统权限检查
 * - 优雅关闭处理
 * - 错误处理和日志记录
 * 
 * @module server
 * @author Shadow Gallery
 * @version 1.0.0
 */

const app = require('./app');
const { promises: fs } = require('fs');
const path = require('path');
const logger = require('./config/logger');
const { PORT, THUMBS_DIR } = require('./config');
const { initializeConnections, closeAllConnections } = require('./db/multi-db');
const { initializeAllDBs } = require('./db/migrations');
const { migrateToMultiDB } = require('./db/migrate-to-multi-db');
const { createThumbnailWorkerPool } = require('./services/worker.manager');
const { setupThumbnailWorkerListeners } = require('./services/thumbnail.service');
const { setupWorkerListeners, buildSearchIndex, watchPhotosDir } = require('./services/indexer.service');

/**
 * 检查目录是否可写
 * 
 * 通过创建和删除测试文件来验证目录的写入权限。
 * 如果权限不足，会抛出异常并记录详细的错误信息。
 * 
 * @async
 * @function checkDirectoryWritable
 * @param {string} directory - 要检查的目录路径
 * @throws {Error} 当目录不可写时抛出错误
 * @returns {Promise<void>} 检查完成
 * 
 * @example
 * await checkDirectoryWritable('/path/to/directory');
 */
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
        throw error; // 关键：抛出异常，交由 startServer 统一处理
    }
}

/**
 * 启动服务器的主函数
 * 
 * 按顺序执行以下初始化步骤：
 * 1. 检查并创建必要的目录
 * 2. 执行数据库迁移（如果需要）
 * 3. 初始化多数据库连接
 * 4. 创建工作线程池
 * 5. 设置事件监听器
 * 6. 启动Express服务器
 * 7. 构建搜索索引并开始文件监控
 * 
 * @async
 * @function startServer
 * @throws {Error} 当任何初始化步骤失败时抛出错误
 * @returns {Promise<void>} 服务器启动完成
 * 
 * @example
 * startServer().catch(error => {
 *   console.error('服务器启动失败:', error);
 *   process.exit(1);
 * });
 */
async function startServer() {
    logger.info(`后端服务正在启动...`);
    try {
        // 1. 确保目录存在且可写
        await fs.mkdir(THUMBS_DIR, { recursive: true });
        await checkDirectoryWritable(THUMBS_DIR); // 失败会直接进入 catch
        
        // 2. 执行数据迁移（如果需要）
        try {
            await migrateToMultiDB();
        } catch (error) {
            logger.warn('数据迁移失败或不需要迁移:', error.message);
        }
        
        // 3. 初始化多数据库连接
        await initializeConnections();
        await initializeAllDBs();
        
        // 4. 创建 Worker Pool
        createThumbnailWorkerPool();
        
        // 5. 设置所有 Worker 的事件监听器
        setupWorkerListeners(); // DB and Video worker listeners
        setupThumbnailWorkerListeners(); // Thumbnail worker listeners
        
        // 6. 启动 Express 应用
        app.listen(PORT, async () => {
            try {
                logger.info(`后端服务已启动在 http://localhost:${PORT}`);
                logger.info(`照片目录: ${process.env.PHOTOS_DIR}`);
                logger.info(`数据目录: ${process.env.DATA_DIR}`);

                if (!process.env.ONEAPI_URL || !process.env.ONEAPI_KEY) {
                    logger.warn('警告: AI服务环境变量未设置，AI功能将不可用。');
                }

                // 7. 首次构建索引并开始监控文件
                await buildSearchIndex();
                watchPhotosDir();
            } catch (error) {
                logger.error('Express 启动后异步流程发生错误:', error.message);
                process.exit(1);
            }
        });

    } catch (error) {
        logger.error('启动过程中发生致命错误:', error.message);
        process.exit(1); // 立即退出
    }
}

/**
 * 优雅关闭处理 - SIGINT 信号（Ctrl+C）
 * 
 * 当收到中断信号时，按顺序执行：
 * 1. 记录关闭日志
 * 2. 关闭所有数据库连接
 * 3. 正常退出进程
 * 
 * @async
 * @function sigintHandler
 * @returns {Promise<void>} 关闭完成
 */
process.on('SIGINT', async () => {
    logger.info('收到关闭信号，正在优雅关闭...');
    try {
        await closeAllConnections();
        logger.info('所有数据库连接已关闭');
        process.exit(0);
    } catch (error) {
        logger.error('关闭数据库连接时出错:', error.message);
        process.exit(1);
    }
});

/**
 * 优雅关闭处理 - SIGTERM 信号（Docker stop等）
 * 
 * 当收到终止信号时，按顺序执行：
 * 1. 记录关闭日志
 * 2. 关闭所有数据库连接
 * 3. 正常退出进程
 * 
 * @async
 * @function sigtermHandler
 * @returns {Promise<void>} 关闭完成
 */
process.on('SIGTERM', async () => {
    logger.info('收到终止信号，正在优雅关闭...');
    try {
        await closeAllConnections();
        logger.info('所有数据库连接已关闭');
        process.exit(0);
    } catch (error) {
        logger.error('关闭数据库连接时出错:', error.message);
        process.exit(1);
    }
});

// 启动服务器
startServer();