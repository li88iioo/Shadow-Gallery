const path = require('path');
const { PHOTOS_DIR } = require('../config');
const logger = require('../config/logger');

function isPathSafe(requestedPath) {
    const safeBaseDir = path.resolve(PHOTOS_DIR);
    const resolvedPath = path.resolve(safeBaseDir, requestedPath);
    const isSafe = resolvedPath.startsWith(safeBaseDir + path.sep) || resolvedPath === safeBaseDir;
    if (!isSafe) {
        logger.warn(`检测到不安全的路径访问尝试: 请求的路径 "${requestedPath}" 解析到了安全目录之外的 "${resolvedPath}"`);
    }
    return isSafe;
}

function sanitizePath(inputPath) {
    if (typeof inputPath !== 'string') return '';
    return inputPath.replace(/\.\./g, '').replace(/[<>:"|?*]/g, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

module.exports = {
    isPathSafe,
    sanitizePath
};