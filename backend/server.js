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
const { initializeAllDBs, ensureCoreTables } = require('./db/migrations');
const { migrateToMultiDB } = require('./db/migrate-to-multi-db');
const { createThumbnailWorkerPool, ensureCoreWorkers } = require('./services/worker.manager');
const { setupThumbnailWorkerListeners, startIdleThumbnailGeneration } = require('./services/thumbnail.service');
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
        // 额外兜底：核心表幂等创建，防止并发/竞态导致的瞬时不存在
        await ensureCoreTables();
        
        // 4. 创建/初始化 Workers（惰性单例 + thumbnail 池）
        ensureCoreWorkers();
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

                // AI 配置由前端本地管理（url/key/model/prompt 由客户端传入），无需在服务端设置环境变量
                // 兼容历史：若仍在环境中配置了 ONEAPI_URL/ONEAPI_KEY，这里不再提示缺失

                // 7. 检查索引状态并决定是否构建索引
                try {
                    const { dbAll, dbGet } = require('./db/multi-db');
                    // 再次兜底，避免极端竞态
                    await ensureCoreTables();
                    const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");

                    // 检测是否存在未完成的全量索引（断点）
                    let hasResumePoint = false;
                    try {
                        const statusRow = await dbGet('index', "SELECT status FROM index_status WHERE id = 1");
                        const resumeRow = await dbGet('index', "SELECT value FROM index_progress WHERE key = 'last_processed_path'");
                        hasResumePoint = (statusRow && statusRow.status === 'building') || !!(resumeRow && resumeRow.value);
                    } catch {}

                    if (itemCount[0].count === 0 || hasResumePoint) {
                        const msg = itemCount[0].count === 0
                            ? '数据库为空，开始构建搜索索引...'
                            : '检测到未完成的索引任务，准备续跑构建搜索索引...';
                        logger.info(msg);
                        buildSearchIndex();
                    } else {
                        // 索引已存在，跳过全量构建；移除后台批量重建缩略图以减少冷启动负载
                        logger.info(`索引已存在，跳过全量构建。当前索引包含 ${itemCount[0].count} 个条目。`);
                        // 新增：开机后台补齐缩略图（默认开启，无需环境变量）
                        try {
                            logger.info('启动时触发一次后台缩略图检查/生成...');
                            startIdleThumbnailGeneration();
                        } catch (e) {
                            logger.warn('启动后台缩略图补齐触发失败（忽略）:', e && e.message);
                        }
                    }
                    
                    // 无论是否构建索引，都开始监控文件变更
                    watchPhotosDir();
                    
                } catch (dbError) {
                    logger.error('检查索引状态失败:', dbError.message);
                    // 如果检查失败，为了安全起见，仍然构建索引
                    logger.info('由于检查失败，开始构建搜索索引...');
                    buildSearchIndex();
                    watchPhotosDir();
                }
                
                // 添加索引状态检查，确保搜索功能可用
                setTimeout(async () => {
                    try {
                        const { dbAll } = require('./db/multi-db');
                        const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
                        const ftsCount = await dbAll('main', "SELECT COUNT(*) as count FROM items_fts");
                        logger.info(`索引状态检查 - items表: ${itemCount[0].count} 条记录, FTS表: ${ftsCount[0].count} 条记录`);
                        
                        if (itemCount[0].count === 0) {
                            logger.warn('警告: 数据库中没有索引数据，搜索功能可能不可用');
                        } else if (ftsCount[0].count === 0) {
                            logger.warn('警告: FTS索引为空，搜索功能可能不可用');
                        } else {
                            logger.info('搜索索引已准备就绪');
                        }
                    } catch (error) {
                        logger.error('索引状态检查失败:', error.message);
                    }
                }, 10000); // 10秒后检查索引状态
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