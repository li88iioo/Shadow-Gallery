/**
 * 浏览控制器模块
 * 处理文件浏览相关的请求，包括目录内容获取和访问时间更新
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { PHOTOS_DIR } = require('../config');
const { historyWorker } = require('../services/worker.manager');
const { getDirectoryContents } = require('../services/file.service');
const { isPathSafe, sanitizePath } = require('../utils/path.utils');

/**
 * 浏览目录内容
 * 获取指定目录下的文件和子目录，支持分页和用户访问记录
 * @param {Object} req - Express请求对象，包含路径参数和查询参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含目录内容、分页信息和总数
 */
exports.browseDirectory = async (req, res) => {
    // 从请求头获取用户ID，用于访问记录
    const userId = req.headers['x-user-id'];
    // 从URL参数获取要浏览的路径，默认为空字符串（根目录）
    const queryPath = req.params[0] || '';
    // 获取分页限制，默认50项
    const limit = parseInt(req.query.limit, 10) || 50;
    // 获取页码，默认第1页
    const page = parseInt(req.query.page, 10) || 1;
    const sort = req.query.sort || 'smart'; // 新增：获取排序参数，默认为 'smart'

    try {
        // 清理和验证路径安全性
        const sanitizedPath = sanitizePath(queryPath);
        if (!isPathSafe(sanitizedPath)) {
            return res.status(403).json({ error: '路径访问被拒绝' });
        }

        // 构建完整的目录路径
        const currentPath = path.join(PHOTOS_DIR, sanitizedPath);
        // 检查路径是否存在且为目录
        const stats = await fs.stat(currentPath).catch(() => null);
        if (!stats || !stats.isDirectory()) {
            return res.status(404).json({ error: '路径未找到或不是目录' });
        }

        // 获取目录内容，包含分页信息和用户访问记录
        const { items, totalPages, totalResults } = await getDirectoryContents(currentPath, sanitizedPath, page, limit, userId, sort);
        
        // 构建响应数据
        const responseData = { items, page, totalPages, totalResults };
        
        // 返回目录内容
        res.json(responseData);

    } catch (err) {
        // 记录错误日志
        logger.error(`处理 /api/browse 请求时出错: ${err.message}`);
        // 确保响应头未发送时才返回错误
        if (!res.headersSent) {
            res.status(500).json({ error: '服务器内部错误', message: err.message });
        }
    }
};

/**
 * 更新文件访问时间
 * 记录用户访问特定文件或目录的时间，用于历史记录功能
 * @param {Object} req - Express请求对象，包含用户ID和文件路径
 * @param {Object} res - Express响应对象
 * @returns {Object} 204状态码表示成功，或错误信息
 */
exports.updateViewTime = async (req, res) => {
    // 从请求头获取用户ID
    const userId = req.headers['x-user-id'];
    if (!userId) {
        return res.status(400).json({ error: '缺少用户ID' });
    }

    // 从请求体获取要更新访问时间的路径
    const { path: queryPath } = req.body;
    if (!queryPath) {
        return res.status(400).json({ error: '缺少路径' });
    }

    // 清理和验证路径安全性
    const sanitizedPath = sanitizePath(queryPath);
    if (!isPathSafe(sanitizedPath)) {
        return res.status(403).json({ error: '路径访问被拒绝' });
    }

    // 向历史记录工作线程发送更新访问时间的消息
    historyWorker.postMessage({ 
        type: 'update_view_time', 
        payload: { userId, path: sanitizedPath } 
    });

    // 返回204状态码表示成功（无内容）
    res.status(204).send();
};