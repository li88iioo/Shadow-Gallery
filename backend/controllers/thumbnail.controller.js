/**
 * 缩略图控制器模块
 * 处理缩略图相关的请求，包括缩略图生成、缓存控制和状态管理
 */
const path = require('path');
const logger = require('../config/logger');
const { PHOTOS_DIR, THUMBS_DIR, THUMB_PLACEHOLDER_PATH, BROKEN_IMAGE_PATH } = require('../config');
const { ensureThumbnailExists } = require('../services/thumbnail.service');
const { isPathSafe } = require('../utils/path.utils');

/**
 * 获取缩略图
 * 根据源文件路径生成或获取缩略图，支持不同的处理状态和缓存控制
 * @param {Object} req - Express请求对象，包含path查询参数
 * @param {Object} res - Express响应对象
 * @returns {Object} 文件响应或错误状态码
 */
exports.getThumbnail = async (req, res) => {
    try {
        // 获取相对路径参数
        const relativePath = req.query.path;
        
        // 验证路径参数是否存在且安全
        if (!relativePath || !isPathSafe(relativePath)) {
            return res.status(400).send('Invalid or unsafe path');
        }

        // 构建源文件的绝对路径
        const sourceAbsPath = path.join(PHOTOS_DIR, relativePath);
        
        // 确保缩略图存在，获取处理状态和缩略图路径
        const { status, path: thumbUrl } = await ensureThumbnailExists(sourceAbsPath, relativePath);

        // 根据缩略图处理状态返回不同的响应
        switch (status) {
            case 'exists':
                // 缩略图已存在：设置长期缓存，返回缩略图文件
                res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
                // 修复：使用新的镜像路径结构
                const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
                const extension = isVideo ? '.jpg' : '.webp';
                const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
                const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
                res.sendFile(thumbAbsPath);
                break;
                
            case 'processing':
                // 缩略图正在处理中：设置不缓存，返回占位符图片
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.status(202).sendFile(THUMB_PLACEHOLDER_PATH);
                break;
                
            case 'failed':
                // 缩略图生成失败：设置不缓存，返回损坏图片占位符
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.status(500).sendFile(BROKEN_IMAGE_PATH);
                break;
        }
    } catch (error) {
        // 记录错误日志
        logger.error(`Error in /api/thumbnail: ${error.message}`);
        // 返回损坏图片占位符
        res.status(500).sendFile(BROKEN_IMAGE_PATH);
    }
};