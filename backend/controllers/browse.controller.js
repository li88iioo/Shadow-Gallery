const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { PHOTOS_DIR } = require('../config');
const { dbWorker } = require('../services/worker.manager');
const { getDirectoryContents } = require('../services/file.service');
const { isPathSafe, sanitizePath } = require('../utils/path.utils');

exports.browseDirectory = async (req, res) => {
    const userId = req.headers['x-user-id']; // 读取用户ID
    const queryPath = req.params[0] || '';
    const limit = parseInt(req.query.limit, 10) || 50;
    const page = parseInt(req.query.page, 10) || 1;

    try {
        const sanitizedPath = sanitizePath(queryPath);
        if (!isPathSafe(sanitizedPath)) {
            return res.status(403).json({ error: '路径访问被拒绝' });
        }

        const currentPath = path.join(PHOTOS_DIR, sanitizedPath);
        const stats = await fs.stat(currentPath).catch(() => null);
        if (!stats || !stats.isDirectory()) {
            return res.status(404).json({ error: '路径未找到或不是目录' });
        }

        const { items, totalPages, totalResults } = await getDirectoryContents(currentPath, sanitizedPath, page, limit, userId);
        const responseData = { items, page, totalPages, totalResults };
        
        res.json(responseData);

    } catch (err) {
        logger.error(`处理 /api/browse 请求时出错: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: '服务器内部错误', message: err.message });
        }
    }
};

exports.updateViewTime = async (req, res) => {
    const userId = req.headers['x-user-id']; // 读取用户ID
    if (!userId) {
        return res.status(400).json({ error: '缺少用户ID' });
    }

    const { path: queryPath } = req.body;
    if (!queryPath) {
        return res.status(400).json({ error: '缺少路径' });
    }

    const sanitizedPath = sanitizePath(queryPath);
    if (!isPathSafe(sanitizedPath)) {
        return res.status(403).json({ error: '路径访问被拒绝' });
    }

    dbWorker.postMessage({ type: 'update_view_time', payload: { userId, path: sanitizedPath } });

    res.status(204).send();
};