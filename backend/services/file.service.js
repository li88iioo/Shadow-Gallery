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

// 缓存配置
const CACHE_DURATION = 604800; // 7天缓存



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

    const cacheKeys = directoryPaths.map(p => `cover_info:${p.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`);
    const cachedResults = await redis.mget(cacheKeys);

    const uncachedPaths = [];
    cachedResults.forEach((cached, index) => {
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.path) {
                    coversMap.set(directoryPaths[index], parsed);
                } else {
                    uncachedPaths.push(directoryPaths[index]);
                }
            } catch (e) {
                uncachedPaths.push(directoryPaths[index]);
            }
        } else {
            uncachedPaths.push(directoryPaths[index]);
        }
    });

    if (uncachedPaths.length > 0) {
        const foundCovers = await Promise.all(uncachedPaths.map(p => findCoverPhoto(p)));
        foundCovers.forEach((coverInfo, index) => {
            if (coverInfo) {
                coversMap.set(uncachedPaths[index], coverInfo);
            }
        });
    }

    return coversMap;
}

/**
 * 查找单个目录的封面图片
 * 递归查找所有子目录中最新修改的媒体文件作为封面
 * @param {string} directoryPath - 目录路径
 * @returns {Promise<Object|null>} 封面信息对象或null
 */
async function findCoverPhoto(directoryPath) {
    const cacheKey = `cover_info:${directoryPath.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`;
    try {
        // 尝试获取缓存
        const cachedCoverInfo = await redis.get(cacheKey);
        if (cachedCoverInfo) {
            try {
                const parsed = JSON.parse(cachedCoverInfo);
                if (parsed && parsed.path) {
                    return parsed;
                }
            } catch (e) {
                logger.warn(`解析封面缓存失败 for ${directoryPath}, 将重新计算。`, e);
            }
        }

        if (!directoryPath || typeof directoryPath !== 'string' || directoryPath.trim() === '') return null;
        const relativePath = path.relative(PHOTOS_DIR, directoryPath);
        if (!isPathSafe(relativePath)) return null;

        let bestCandidate = null;

        async function findLatestInDir(dir) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const filteredEntries = entries.filter(entry => entry.name !== '@eaDir' && !entry.name.includes('@eaDir'));

            for (const entry of filteredEntries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(entry.name)) {
                    try {
                        const stats = await fs.stat(fullPath);
                        if (!bestCandidate || stats.mtimeMs > bestCandidate.mtime) {
                            bestCandidate = { path: fullPath, mtime: stats.mtimeMs };
                        }
                    } catch (statError) {
                        logger.warn(`无法获取文件状态: ${fullPath}`, statError);
                    }
                } else if (entry.isDirectory()) {
                    await findLatestInDir(fullPath);
                }
            }
        }

        await findLatestInDir(directoryPath);

        if (bestCandidate) {
            let dimensions = { width: 1, height: 1 };
            try {
                const isVideo = /\.(mp4|webm|mov)$/i.test(bestCandidate.path);
                if (isVideo) {
                    dimensions = await getVideoDimensions(bestCandidate.path);
                } else {
                    const metadata = await sharp(bestCandidate.path).metadata();
                    dimensions = { width: metadata.width, height: metadata.height };
                }
            } catch (e) {
                logger.error(`查找封面尺寸失败: ${bestCandidate.path}`, e);
            }

            const coverInfo = { path: bestCandidate.path, width: dimensions.width || 1, height: dimensions.height || 1 };
            await redis.set(cacheKey, JSON.stringify(coverInfo), 'EX', CACHE_DURATION);
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
async function getSortedDirectoryEntries(directory, relativePathPrefix, userId, sort = 'smart') {
    let entries = await fs.readdir(directory, { withFileTypes: true });
    entries = entries.filter(e => e.name !== '@eaDir');

    const albumEntries = entries.filter(e => e.isDirectory());
    const mediaEntries = entries.filter(e => e.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(e.name));

    const allRelativePaths = entries.map(e => path.join(relativePathPrefix, e.name).replace(/\\/g, '/'));

    const mtimeResults = await dbAll('main', `SELECT path, mtime FROM items WHERE path IN (${allRelativePaths.map(() => '?').join(',')})`, allRelativePaths);
    const mtimeMap = new Map(mtimeResults.map(row => [row.path, row.mtime]));

    let viewedAtMap = new Map();
    if (albumEntries.length > 0 && userId) {
        const albumRelativePaths = albumEntries.map(e => path.join(relativePathPrefix, e.name).replace(/\\/g, '/'));
        const dbResults = await dbAll('history', `SELECT item_path, MAX(viewed_at) as last_viewed FROM view_history WHERE user_id = ? AND item_path IN (${albumRelativePaths.map(() => '?').join(',')}) GROUP BY item_path`, [userId, ...albumRelativePaths]);
        viewedAtMap = new Map(dbResults.map(row => [row.item_path, row.last_viewed]));
    }

    const albumsWithContext = await Promise.all(albumEntries.map(async e => {
        const entryRelativePath = path.join(relativePathPrefix, e.name).replace(/\\/g, '/');
        return {
            entry: e,
            path: entryRelativePath,
            lastViewed: viewedAtMap.get(entryRelativePath) || 0,
            mtime: mtimeMap.get(entryRelativePath) || 0,
        };
    }));
    
    let sortedAlbumEntries;

    // 根据排序参数对相册和媒体条目进行排序
    switch (sort) {
        case 'name_asc':
            albumsWithContext.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
            mediaEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
            sortedAlbumEntries = albumsWithContext.map(a => a.entry);
            break;
        case 'name_desc':
            albumsWithContext.sort((a, b) => b.entry.name.localeCompare(a.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
            mediaEntries.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
            sortedAlbumEntries = albumsWithContext.map(a => a.entry);
            break;
        case 'mtime_asc':
            albumsWithContext.sort((a, b) => a.mtime - b.mtime);
            mediaEntries.sort((a, b) => {
                const mtimeA = mtimeMap.get(path.join(relativePathPrefix, a.name).replace(/\\/g, '/')) || 0;
                const mtimeB = mtimeMap.get(path.join(relativePathPrefix, b.name).replace(/\\/g, '/')) || 0;
                return mtimeA - mtimeB;
            });
            sortedAlbumEntries = albumsWithContext.map(a => a.entry);
            break;
        case 'mtime_desc':
            albumsWithContext.sort((a, b) => b.mtime - a.mtime);
            mediaEntries.sort((a, b) => {
                const mtimeA = mtimeMap.get(path.join(relativePathPrefix, a.name).replace(/\\/g, '/')) || 0;
                const mtimeB = mtimeMap.get(path.join(relativePathPrefix, b.name).replace(/\\/g, '/')) || 0;
                return mtimeB - mtimeA;
            });
            sortedAlbumEntries = albumsWithContext.map(a => a.entry);
            break;
        case 'viewed_desc':
            albumsWithContext.sort((a, b) => b.lastViewed - a.lastViewed);
            // mediaEntries don't have viewed time, sort by name
            mediaEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
            sortedAlbumEntries = albumsWithContext.map(a => a.entry);
            break;
        default: // 'smart'
            if (relativePathPrefix === '') {
                const now = Date.now();
                const newThreshold = now - (24 * 60 * 60 * 1000);
                const newAlbums = albumsWithContext.filter(a => a.mtime > newThreshold);
                const oldAlbums = albumsWithContext.filter(a => a.mtime <= newThreshold);

                newAlbums.sort((a, b) => b.mtime - a.mtime);
                oldAlbums.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
                
                sortedAlbumEntries = [...newAlbums, ...oldAlbums].map(a => a.entry);
            } 
            else {
                albumsWithContext.sort((a, b) => {
                    if (a.lastViewed !== b.lastViewed) {
                        return b.lastViewed - a.lastViewed;
                    }
                    return a.entry.name.localeCompare(b.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
                });
                sortedAlbumEntries = albumsWithContext.map(a => a.entry);
            }
            mediaEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
            break;
    }

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
async function getDirectoryContents(directory, relativePathPrefix, page, limit, userId, sort = 'smart') {
    try {
        if (!isPathSafe(relativePathPrefix)) throw new Error('不安全的路径访问');

        const allSortedEntries = await getSortedDirectoryEntries(directory, relativePathPrefix, userId, sort);
        const totalResults = allSortedEntries.length;
        const totalPages = Math.ceil(totalResults / limit) || 1;

        if (totalResults === 0) {
            // 目录为空，检查数据库是否也为空，以判断是否正在首次索引
            try {
                const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
                if (itemCount[0].count === 0) {
                    // 数据库为空，这很可能意味着正在进行首次索引
                    return { items: [], totalPages: 1, totalResults: 0, indexStatus: { status: 'building' } };
                }
            } catch (dbError) {
                logger.warn('检查数据库状态时出错:', dbError.message);
            }
            // 如果数据库不为空，但目录为空，则确实是空相册
            return { items: [], totalPages: 1, totalResults: 0 };
        }

        const offset = (page - 1) * limit;
        const paginatedEntries = allSortedEntries.slice(offset, offset + limit);

        const albumEntries = paginatedEntries.filter(entry => entry.isDirectory());
        const albumPaths = albumEntries.map(entry => path.join(PHOTOS_DIR, relativePathPrefix, entry.name));
        const coversMap = await findCoverPhotosBatch(albumPaths);

        const paginatedRelativePaths = paginatedEntries.map(e => path.join(relativePathPrefix, e.name).replace(/\\/g, '/'));
        const mtimeResults = await dbAll('main', `SELECT path, mtime FROM items WHERE path IN (${paginatedRelativePaths.map(() => '?').join(',')})`, paginatedRelativePaths);
        const mtimeMap = new Map(mtimeResults.map(row => [row.path, row.mtime]));

        const items = await Promise.all(paginatedEntries.map(async (entry) => {
            const entryRelativePath = path.join(relativePathPrefix, entry.name).replace(/\\/g, '/');
            const fullAbsPath = path.join(PHOTOS_DIR, entryRelativePath);

            if (entry.isDirectory()) {
                const coverInfo = coversMap.get(fullAbsPath);
                let coverUrl = 'data:image/svg+xml,...';
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
                        path: entryRelativePath,
                        coverUrl,
                        mtime: mtimeMap.get(entryRelativePath) || 0,
                        coverWidth,
                        coverHeight
                    }
                };
            } else {
                const isVideo = /\.(mp4|webm|mov)$/i.test(entry.name);
                let mtime = mtimeMap.get(entryRelativePath);

                if (!mtime) {
                    try {
                        const stats = await fs.stat(fullAbsPath);
                        mtime = stats.mtimeMs;
                    } catch (e) {
                        logger.warn(`无法获取文件状态: ${fullAbsPath}`, e);
                        mtime = Date.now();
                    }
                }

                const cacheKey = `dim:${entryRelativePath}:${mtime}`;
                let dimensions;
                
                const cachedDimensions = await redis.get(cacheKey);

                if (cachedDimensions) {
                    try {
                        dimensions = JSON.parse(cachedDimensions);
                        if (!dimensions || typeof dimensions.width !== 'number' || typeof dimensions.height !== 'number') {
                            logger.warn(`无效的缓存尺寸数据 for ${entryRelativePath}, 将重新计算。`);
                            dimensions = null;
                        }
                    } catch (e) {
                        logger.warn(`解析缓存尺寸失败 for ${entryRelativePath}, 将重新计算。`, e);
                        dimensions = null;
                    }
                }

                if (!dimensions) {
                    try {
                        if (isVideo) {
                            dimensions = await getVideoDimensions(fullAbsPath);
                        } else {
                            const metadata = await sharp(fullAbsPath).metadata();
                            dimensions = { width: metadata.width, height: metadata.height };
                        }
                        await redis.set(cacheKey, JSON.stringify(dimensions), 'EX', 60 * 60 * 24 * 30);
                    } catch (e) {
                        logger.error(`无法获取媒体文件尺寸: ${entryRelativePath}`, e);
                        dimensions = { width: 1, height: 1 };
                    }
                }

                const originalUrl = `/static/${entryRelativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
                const thumbnailUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(entryRelativePath)}&v=${mtime}`;

                return {
                    type: isVideo ? 'video' : 'photo',
                    data: {
                        originalUrl,
                        thumbnailUrl,
                        width: dimensions.width,
                        height: dimensions.height,
                        mtime
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

/**
 * 智能失效封面缓存
 * @param {string} changedPath - 变化的文件路径
 */
async function invalidateCoverCache(changedPath) {
    try {
        // 获取所有受影响的目录路径
        const affectedPaths = getAllParentPaths(changedPath);
        const cacheKeys = affectedPaths.map(p => `cover_info:${p.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`);
        
        if (cacheKeys.length > 0) {
            await redis.del(cacheKeys);
            logger.info(`已清除 ${cacheKeys.length} 个封面缓存: ${changedPath}`);
        }
    } catch (error) {
        logger.error(`清除封面缓存失败: ${changedPath}`, error);
    }
}

/**
 * 获取所有父目录路径
 * @param {string} filePath - 文件路径
 * @returns {Array<string>} 父目录路径数组
 */
function getAllParentPaths(filePath) {
    const paths = [];
    let currentPath = path.dirname(filePath);
    
    while (currentPath !== PHOTOS_DIR && currentPath.startsWith(PHOTOS_DIR)) {
        paths.push(currentPath);
        currentPath = path.dirname(currentPath);
    }
    
    return paths;
}

// 导出文件服务函数
module.exports = {
    getVideoDimensions,
    findCoverPhoto,
    findCoverPhotosBatch,
    getDirectoryContents,
    invalidateCoverCache
};
