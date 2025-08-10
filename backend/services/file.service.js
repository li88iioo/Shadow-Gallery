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
    // 改为 DB 获取当前目录的“直接子项”（albums 优先，media 其后），尽量避免读取 FS 列表
    const prefix = relativePathPrefix.replace(/\\/g, '/');

    function immediateWhereFor(prefix) {
        if (!prefix) {
            return { clause: 'instr(path, "/") = 0', params: [] };
        }
        // path LIKE 'prefix/%' AND instr(substr(path, length(prefix)+2), '/') = 0
        return {
            clause: 'path LIKE ? || "/%" AND instr(substr(path, length(?) + 2), "/") = 0',
            params: [prefix, prefix]
        };
    }

    const where = immediateWhereFor(prefix);

    // 取出 albums 与 media 列表（仅当前目录的直接子项）
    const albums = await dbAll(
        'main',
        `SELECT name, path, mtime FROM items WHERE type = 'album' AND ${where.clause}`,
        where.params
    );
    const media = await dbAll(
        'main',
        `SELECT name, path, mtime FROM items WHERE type IN ('photo','video') AND ${where.clause}`,
        where.params
    );

    // 历史视图映射（仅对 albums 需要）
    let viewedAtMap = new Map();
    if (albums.length > 0 && userId) {
        const albumPaths = albums.map(a => a.path);
        const placeholders = albumPaths.map(() => '?').join(',');
        const rows = await dbAll(
            'history',
            `SELECT item_path, MAX(viewed_at) AS last_viewed FROM view_history WHERE user_id = ? AND item_path IN (${placeholders}) GROUP BY item_path`,
            [userId, ...albumPaths]
        );
        viewedAtMap = new Map(rows.map(r => [r.item_path, r.last_viewed]));
    }

    // 排序（albums 优先，media 其次），尽量贴合原有策略
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

    function sortByNameAsc(a, b) { return collator.compare(a.name, b.name); }
    function sortByNameDesc(a, b) { return collator.compare(b.name, a.name); }
    function sortByMtimeAsc(a, b) { return (a.mtime || 0) - (b.mtime || 0); }
    function sortByMtimeDesc(a, b) { return (b.mtime || 0) - (a.mtime || 0); }

    switch (sort) {
        case 'name_asc':
            albums.sort(sortByNameAsc); media.sort(sortByNameAsc); break;
        case 'name_desc':
            albums.sort(sortByNameDesc); media.sort(sortByNameDesc); break;
        case 'mtime_asc':
            albums.sort(sortByMtimeAsc); media.sort(sortByMtimeAsc); break;
        case 'mtime_desc':
            albums.sort(sortByMtimeDesc); media.sort(sortByMtimeDesc); break;
        case 'viewed_desc':
            albums.sort((a, b) => (viewedAtMap.get(b.path) || 0) - (viewedAtMap.get(a.path) || 0) || sortByNameAsc(a, b));
            media.sort(sortByNameAsc); // 保持与原策略一致
            break;
        default: { // smart
            if (!prefix) {
                const threshold = Date.now() - (24 * 60 * 60 * 1000);
                const newer = albums.filter(a => (a.mtime || 0) > threshold).sort(sortByMtimeDesc);
                const older = albums.filter(a => (a.mtime || 0) <= threshold).sort(sortByNameAsc);
                albums.length = 0; albums.push(...newer, ...older);
            } else {
                albums.sort((a, b) => (viewedAtMap.get(b.path) || 0) - (viewedAtMap.get(a.path) || 0) || sortByNameAsc(a, b));
            }
            media.sort(sortByNameAsc);
        }
    }

    // 返回 albums 在前、media 在后的统一列表（仿原实现）
    // 统一为 Dirent-like 的轻量对象，供上游分页与渲染
    return [
        ...albums.map(a => ({ isDirectory: () => true, name: path.basename(a.path), _path: a.path })),
        ...media.map(m => ({ isDirectory: () => false, name: path.basename(m.path), _path: m.path }))
    ];
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
            // 目录为空
            return { items: [], totalPages: 1, totalResults: 0 };
        }

        const offset = (page - 1) * limit;
        const paginatedEntries = allSortedEntries.slice(offset, offset + limit);

        const albumEntries = paginatedEntries.filter(entry => entry.isDirectory());
        const albumPaths = albumEntries.map(entry => path.join(PHOTOS_DIR, entry._path));
        const coversMap = await findCoverPhotosBatch(albumPaths);

        const paginatedRelativePaths = paginatedEntries.map(e => e._path);
        const dbResults = await dbAll('main', `SELECT path, mtime, width, height FROM items WHERE path IN (${paginatedRelativePaths.map(() => '?').join(',')})`, paginatedRelativePaths);
        const mtimeMap = new Map(dbResults.map(row => [row.path, row.mtime]));
        const dimensionsMap = new Map(dbResults.map(row => [row.path, { width: row.width, height: row.height }]));

        const items = await Promise.all(paginatedEntries.map(async (entry) => {
            const entryRelativePath = entry._path;
            const fullAbsPath = path.join(PHOTOS_DIR, entryRelativePath);

            if (entry.isDirectory()) {
                const coverInfo = coversMap.get(fullAbsPath);
                let coverUrl = 'data:image/svg+xml,...';
                let coverWidth = 1, coverHeight = 1;
                
                if (coverInfo && coverInfo.path) {
                    const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                    const coverMtime = coverInfo.mtime || (await fs.stat(coverInfo.path).then(s=>s.mtimeMs).catch(()=>Date.now()));
                    coverUrl = `${API_BASE} /api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}&v=${coverMtime}`;
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

                // 优先使用数据库中的预存储宽高信息
                let dimensions = dimensionsMap.get(entryRelativePath);
                
                // 如果数据库中没有宽高信息或数据无效，则动态获取
                if (!dimensions || !dimensions.width || !dimensions.height) {
                    const cacheKey = `dim:${entryRelativePath}:${mtime}`;
                    const cachedDimensions = await redis.get(cacheKey);

                    if (cachedDimensions) {
                        try {
                            dimensions = JSON.parse(cachedDimensions);
                            if (!dimensions || typeof dimensions.width !== 'number' || typeof dimensions.height !== 'number') {
                                logger.debug(`无效的缓存尺寸数据 for ${entryRelativePath}, 将重新计算。`);
                                dimensions = null;
                            }
                        } catch (e) {
                            logger.debug(`解析缓存尺寸失败 for ${entryRelativePath}, 将重新计算。`, e);
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
                            logger.debug(`动态获取 ${entryRelativePath} 的尺寸: ${dimensions.width}x${dimensions.height}`);
                        } catch (e) {
                            logger.error(`无法获取媒体文件尺寸: ${entryRelativePath}`, e);
                            dimensions = { width: 1920, height: 1080 };
                        }
                    }
                } else {
                    logger.debug(`使用数据库预存储的 ${entryRelativePath} 尺寸: ${dimensions.width}x${dimensions.height}`);
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
            logger.debug(`已清除 ${cacheKeys.length} 个封面缓存: ${changedPath}`);
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
