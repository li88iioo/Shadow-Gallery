/**
 * 相册控制器模块
 * 处理相册相关的请求，包括获取所有相册封面图片
 */
const { PHOTOS_DIR } = require('../config');
const { findCoverPhotosBatch } = require('../services/file.service');
const fs = require('fs').promises;
const path = require('path');

/**
 * 获取所有相册封面图片
 * 递归遍历照片目录，找到所有相册文件夹并获取其封面图片URL
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含所有相册封面图片的URL数组
 */
exports.getAllAlbumCovers = async (req, res) => {
    /**
     * 递归获取指定目录下的所有子目录
     * 深度优先遍历，收集所有文件夹路径
     * @param {string} dir - 要遍历的目录路径
     * @returns {Array<string>} 所有子目录的完整路径数组
     */
    async function getAllAlbumDirs(dir) {
        let dirs = [];
        // 读取目录内容，包含文件类型信息
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        // 遍历目录中的每个条目
        for (const entry of entries) {
            if (entry.isDirectory()) {
                // 如果是目录，构建完整路径并添加到结果数组
                const fullPath = path.join(dir, entry.name);
                dirs.push(fullPath);
                // 递归获取子目录
                dirs = dirs.concat(await getAllAlbumDirs(fullPath));
            }
        }
        return dirs;
    }
    
    try {
        // 获取照片目录下的所有相册文件夹
        const allAlbumDirs = await getAllAlbumDirs(PHOTOS_DIR);
        
        // 批量查找每个相册的封面图片
        const coversMap = await findCoverPhotosBatch(allAlbumDirs);
        
        // 构建封面图片的URL数组
        const coverUrls = [];
        for (const coverInfo of coversMap.values()) {
            if (coverInfo && coverInfo.path) {
                // 将绝对路径转换为相对于照片目录的相对路径
                const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                // 构建缩略图API的URL
                coverUrls.push(`/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}`);
            }
        }
        
        // 返回封面图片URL数组
        res.json(coverUrls);
    } catch (e) {
        // 错误处理：返回500状态码和错误信息
        res.status(500).json({ error: '获取相册封面失败', message: e.message });
    }
}; 