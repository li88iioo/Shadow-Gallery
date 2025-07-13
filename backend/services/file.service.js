/**
 * 文件服务模块
 * 处理文件系统操作、目录浏览、封面查找和媒体文件管理
 */
// backend/services/file.service.js

const { promises: fs } = require('fs');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { PHOTOS_DIR, API_BASE } = require('../config');
const { isPathSafe } = require('../utils/path.utils');
const { dbAll } = require('../db/multi-db');

/**
 * 获取视频文件的尺寸信息
 * 使用ffprobe工具解析视频文件的宽度和高度
 * @param {string} videoPath - 视频文件路径
 * @returns {Promise<Object>} 包含width和height的对象
 */
function getVideoDimensions(videoPath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                logger.error(`ffprobe 失败: ${videoPath}`, err);
                return resolve({ width: 1, height: 1 });
            }
            // 查找视频流信息
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            if (videoStream && videoStream.width && videoStream.height) {
                resolve({ width: videoStream.width, height: videoStream.height });
            } else {
                logger.warn(`在 ${videoPath} 中未找到视频尺寸信息.`);
                resolve({ width: 1, height: 1 });
            }
        });
    });
}

/**
 * 批量查找相册封面图片
 * 使用Redis缓存优化多个目录的封面查找性能
 * @param {Array<string>} directoryPaths - 目录路径数组
 * @returns {Promise<Map>} 目录路径到封面信息的映射
 */
async function findCoverPhotosBatch(directoryPaths) {
    const coversMap = new Map();
    if (directoryPaths.length === 0) {
        return coversMap;
    }

    // 构建缓存键，用于批量获取Redis缓存
    const cacheKeys = directoryPaths.map(p => `cover_info:${p.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`);
    const cachedResults = await redis.mget(cacheKeys);

    // 分离已缓存和未缓存的路径
    const uncachedPaths = [];
    cachedResults.forEach((cached, index) => {
        if (cached) {
            coversMap.set(directoryPaths[index], JSON.parse(cached));
        } else {
            uncachedPaths.push(directoryPaths[index]);
        }
    });

    // 对未缓存的路径进行封面查找
    if (uncachedPaths.length > 0) {
        const foundCovers = await Promise.all(uncachedPaths.map(p => findCoverPhoto(p)));
        foundCovers.forEach((coverInfo, index) => {
            coversMap.set(uncachedPaths[index], coverInfo);
        });
    }

    return coversMap;
}

/**
 * 查找单个目录的封面图片
 * 优先查找图片文件，其次查找视频文件，最后递归查找子目录
 * @param {string} directoryPath - 目录路径
 * @returns {Promise<Object|null>} 封面信息对象或null
 */
async function findCoverPhoto(directoryPath) {
    const cacheKey = `cover_info:${directoryPath.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`;
    try {
        // 检查Redis缓存
        const cachedCoverInfo = await redis.get(cacheKey);
        if (cachedCoverInfo) return JSON.parse(cachedCoverInfo);
        
        // 验证路径参数
        if (!directoryPath || typeof directoryPath !== 'string' || directoryPath.trim() === '') return null;
        const relativePath = path.relative(PHOTOS_DIR, directoryPath);
        if (!isPathSafe(relativePath)) return null;

        // 读取目录内容
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        let foundCoverPath = null;
        
        // 优先查找图片文件作为封面
        for (const entry of entries) {
            if (entry.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(entry.name)) {
                foundCoverPath = path.join(directoryPath, entry.name);
                break;
            }
        }
        
        // 如果没有图片文件，查找视频文件
        if (!foundCoverPath) {
            for (const entry of entries) {
                if (entry.isFile() && /\.(mp4|webm|mov)$/i.test(entry.name)) {
                    foundCoverPath = path.join(directoryPath, entry.name);
                    break;
                }
            }
        }
        
        // 如果当前目录没有媒体文件，递归查找子目录
        if (!foundCoverPath) {
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const deeperCoverInfo = await findCoverPhoto(path.join(directoryPath, entry.name));
                    if (deeperCoverInfo && deeperCoverInfo.path) {
                        return deeperCoverInfo; 
                    }
                }
            }
        }

        // 如果找到封面文件，获取其尺寸信息并缓存
        if (foundCoverPath) {
            let dimensions = { width: 1, height: 1 };
            try {
                const isVideo = /\.(mp4|webm|mov)$/i.test(foundCoverPath);
                if (isVideo) {
                    dimensions = await getVideoDimensions(foundCoverPath);
                } else {
                    const metadata = await sharp(foundCoverPath).metadata();
                    dimensions = { width: metadata.width, height: metadata.height };
                }
            } catch (e) {
                logger.error(`查找封面尺寸失败: ${foundCoverPath}`, e);
            }
            
            const coverInfo = { path: foundCoverPath, width: dimensions.width, height: dimensions.height };
            // 缓存封面信息，过期时间7天
            await redis.set(cacheKey, JSON.stringify(coverInfo), 'EX', 604800);
            return coverInfo;
        }

        return null;
    } catch (e) {
        logger.debug(`查找封面时发生错误: ${directoryPath}`, e);
        return null;
    }
}

/**
 * 获取排序后的目录条目
 * 根据用户访问历史和文件修改时间对目录内容进行智能排序
 * @param {string} directory - 目录路径
 * @param {string} relativePathPrefix - 相对路径前缀
 * @param {string} userId - 用户ID
 * @returns {Promise<Array>} 排序后的目录条目数组
 */
async function getSortedDirectoryEntries(directory, relativePathPrefix, userId) {
    let entries = await fs.readdir(directory, { withFileTypes: true });
    entries = entries.filter(e => e.name !== '@eaDir'); // 过滤Synology NAS系统目录

    // 分离相册目录和媒体文件
    const albumEntries = entries.filter(e => e.isDirectory());
    const mediaEntries = entries.filter(e => e.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(e.name));

    // 获取用户访问历史记录
    let viewedAtMap = new Map();
    if (albumEntries.length > 0 && userId) {
        const albumRelativePaths = albumEntries.map(e => path.join(relativePathPrefix, e.name).replace(/\\/g, '/'));
        
        const dbResults = await dbAll('history', `SELECT item_path, MAX(viewed_at) as last_viewed FROM view_history WHERE user_id = ? AND item_path IN (${albumRelativePaths.map(() => '?').join(',')}) GROUP BY item_path`, [userId, ...albumRelativePaths]);
        viewedAtMap = new Map(dbResults.map(row => [row.item_path, row.last_viewed]));
    }

    // 为相册条目添加上下文信息（访问时间、修改时间）
    const albumsWithContext = await Promise.all(albumEntries.map(async e => {
        const entryRelativePath = path.join(relativePathPrefix, e.name).replace(/\\/g, '/');
        const fullAbsPath = path.join(directory, e.name);
        const stats = await fs.stat(fullAbsPath).catch(() => ({ mtimeMs: 0 }));
        return {
            entry: e,
            path: entryRelativePath,
            lastViewed: viewedAtMap.get(entryRelativePath) || 0,
            mtime: stats.mtimeMs,
        };
    }));
    
    let sortedAlbumEntries;

    // 根目录使用特殊排序：新相册按修改时间排序，旧相册按名称排序
    if (relativePathPrefix === '') {
        const now = Date.now();
        const newThreshold = now - (24 * 60 * 60 * 1000); // 24小时前
        const newAlbums = albumsWithContext.filter(a => a.mtime > newThreshold);
        const oldAlbums = albumsWithContext.filter(a => a.mtime <= newThreshold);

        newAlbums.sort((a, b) => b.mtime - a.mtime); // 新相册按修改时间倒序
        oldAlbums.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' })); // 旧相册按名称排序
        
        sortedAlbumEntries = [...newAlbums, ...oldAlbums].map(a => a.entry);
    } 
    else {
        // 子目录按访问时间排序，相同访问时间按名称排序
        albumsWithContext.sort((a, b) => {
            if (a.lastViewed !== b.lastViewed) {
                return b.lastViewed - a.lastViewed; // 最近访问的在前
            }
            return a.entry.name.localeCompare(b.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
        });
        sortedAlbumEntries = albumsWithContext.map(a => a.entry);
    }

    // 媒体文件按名称排序
    mediaEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return [...sortedAlbumEntries, ...mediaEntries];
}

/**
 * 获取目录内容
 * 获取指定目录的分页内容，包括相册和媒体文件，支持封面图片和尺寸信息
 * @param {string} directory - 目录路径
 * @param {string} relativePathPrefix - 相对路径前缀
 * @param {number} page - 页码
 * @param {number} limit - 每页数量
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} 包含items、totalPages、totalResults的对象
 */
async function getDirectoryContents(directory, relativePathPrefix, page, limit, userId) {
    try {
        // 验证路径安全性
        if (!isPathSafe(relativePathPrefix)) throw new Error('不安全的路径访问');

        // 获取排序后的所有条目并计算分页信息
        const allSortedEntries = await getSortedDirectoryEntries(directory, relativePathPrefix, userId);
        const totalResults = allSortedEntries.length;
        const totalPages = Math.ceil(totalResults / limit);
        const offset = (page - 1) * limit;
        const paginatedEntries = allSortedEntries.slice(offset, offset + limit);

        // 批量获取相册封面信息
        const albumEntries = paginatedEntries.filter(entry => entry.isDirectory());
        const albumPaths = albumEntries.map(entry => path.join(PHOTOS_DIR, relativePathPrefix, entry.name));
        const coversMap = await findCoverPhotosBatch(albumPaths);

        // 处理每个条目，构建返回数据
        const items = await Promise.all(paginatedEntries.map(async (entry) => {
            const entryRelativePath = path.join(relativePathPrefix, entry.name);
            const fullAbsPath = path.join(PHOTOS_DIR, entryRelativePath);

            if (entry.isDirectory()) {
                // 处理相册条目
                const coverInfo = coversMap.get(fullAbsPath);
                let coverUrl = 'data:image/svg+xml,...'; // 默认占位符
                let coverWidth = 1, coverHeight = 1;
                
                if (coverInfo && coverInfo.path) {
                    const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                    coverUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}`;
                    coverWidth = coverInfo.width;
                    coverHeight = coverInfo.height;
                }
                
                return {
                    type: 'album',
                    data: {
                        name: entry.name,
                        path: entryRelativePath.replace(/\\/g, '/'),
                        coverUrl,
                        mtime: (await fs.stat(fullAbsPath).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
                        coverWidth,
                        coverHeight
                    }
                };
            } else {
                // 处理媒体文件条目
                const isVideo = /\.(mp4|webm|mov)$/i.test(entry.name);
                const stats = await fs.stat(fullAbsPath).catch(() => ({ mtimeMs: 0 }));
                const cacheKey = `dim:${entryRelativePath}:${stats.mtimeMs}`;
                let dimensions = null;
                
                // 尝试从缓存获取尺寸信息
                const cachedDimensions = await redis.get(cacheKey);

                if (cachedDimensions) {
                    dimensions = JSON.parse(cachedDimensions);
                } else {
                    // 缓存未命中，重新计算尺寸信息
                    try {
                        if (isVideo) {
                            dimensions = await getVideoDimensions(fullAbsPath);
                        } else {
                            const metadata = await sharp(fullAbsPath).metadata();
                            dimensions = { width: metadata.width, height: metadata.height };
                        }
                        // 缓存尺寸信息30天
                        await redis.set(cacheKey, JSON.stringify(dimensions), 'EX', 60 * 60 * 24 * 30);
                    } catch (e) {
                        logger.error(`无法获取媒体文件尺寸: ${entryRelativePath}`, e);
                        dimensions = { width: 1, height: 1 };
                    }
                }

                // 构建媒体文件的URL
                const originalUrl = `/static/${entryRelativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
                const thumbnailUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(entryRelativePath)}`;

                return {
                    type: isVideo ? 'video' : 'photo',
                    data: {
                        originalUrl,
                        thumbnailUrl,
                        width: dimensions.width,
                        height: dimensions.height
                    }
                };
            }
        }));

        return { items, totalPages, totalResults };

    } catch (err) {
        logger.error(`获取目录内容时出错 ${directory}:`, err);
        throw err;
    }
}

// 导出文件服务函数
module.exports = {
    getVideoDimensions,      // 获取视频尺寸
    findCoverPhoto,          // 查找单个封面
    findCoverPhotosBatch,    // 批量查找封面
    getDirectoryContents     // 获取目录内容
};