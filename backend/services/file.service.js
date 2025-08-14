/**
 * 文件服务模块
 * 处理文件系统操作、目录浏览、封面查找和媒体文件管理
 */
// backend/services/file.service.js

const { promises: fs } = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { PHOTOS_DIR, API_BASE, COVER_INFO_LRU_SIZE } = require('../config');
const { isPathSafe } = require('../utils/path.utils');
const { dbAll, runAsync } = require('../db/multi-db');
const { getVideoDimensions } = require('../utils/media.utils.js');

// 缓存配置
const CACHE_DURATION = 604800; // 7天缓存
// 进程内 LRU 缓存，用于减少对 Redis/DB 的重复读取
class LruCache {
    constructor(maxEntries = 2000) {
        this.maxEntries = maxEntries;
        this.map = new Map(); // 保持插入顺序以实现 LRU
    }
    get(key) {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key);
        // 刷新到末尾，表示最近使用
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.maxEntries) {
            // 删除最早的一个键（LRU）
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
    }
    delete(key) {
        this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
}

// 按相册绝对路径缓存封面信息：key = 绝对相册路径（如 /app/photos/AlbumA）
const coverInfoCache = (() => {
    // 自适应 LRU 容量：根据可用内存粗估（Node 无法直接取总内存上限，采用经验值）
    const base = COVER_INFO_LRU_SIZE || 4000;
    try {
        const os = require('os');
        const totalMemGB = os.totalmem() / (1024 ** 3);
        if (totalMemGB >= 16) return new LruCache(Math.max(base, 12000));
        if (totalMemGB >= 8) return new LruCache(Math.max(base, 8000));
        if (totalMemGB >= 4) return new LruCache(Math.max(base, 6000));
        return new LruCache(base);
    } catch {
        return new LruCache(base);
    }
})();


// 确保用于浏览/封面的关键索引，仅执行一次
let browseIndexesEnsured = false;
async function ensureBrowseIndexes() {
    if (browseIndexesEnsured) return;
    try {
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_path ON items(path)`)
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_type_path ON items(type, path)`)
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_path_mtime ON items(path, mtime DESC)`)
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_type_path_mtime ON items(type, path, mtime DESC)`)
        browseIndexesEnsured = true;
    } catch (e) {
        logger.warn('创建浏览相关索引失败（忽略，不影响功能）:', e && e.message);
    }
}

/**
 * 批量查找相册封面图片 (已优化)
 * 此函数现在是 findCoverPhotosBatchDb 的一个包装器, 完全依赖数据库, 移除了文件系统扫描.
 * @param {Array<string>} directoryPaths - 目录的绝对路径数组
 * @returns {Promise<Map>} 目录路径到封面信息的映射
 */
async function findCoverPhotosBatch(directoryPaths) {
    if (!Array.isArray(directoryPaths) || directoryPaths.length === 0) {
        return new Map();
    }
    // 将绝对路径转换为 findCoverPhotosBatchDb 所需的相对路径
    const relativeDirs = directoryPaths.map(p => path.relative(PHOTOS_DIR, p));
    
    // 直接调用基于数据库的实现
    return findCoverPhotosBatchDb(relativeDirs);
}

/**
 * 使用数据库查找相册封面（基于相对路径，避免递归 FS 扫描）
 * @param {Array<string>} relativeDirs - 相册相对路径数组（例如 'AlbumA' 或 'Parent/AlbumB'）
 * @returns {Promise<Map>} key 为相册绝对路径（PHOTOS_DIR 拼接），value 为封面信息
 */
async function findCoverPhotosBatchDb(relativeDirs) {
    await ensureBrowseIndexes();
    const coversMap = new Map();
    if (!Array.isArray(relativeDirs) || relativeDirs.length === 0) return coversMap;

    // 过滤并规范路径
    const safeRels = relativeDirs
        .map(rel => (rel || '').replace(/\\/g, '/'))
        .filter(rel => isPathSafe(rel));
    if (safeRels.length === 0) return coversMap;

    // 先从进程内 LRU 命中
    const relToAbs = new Map();
    const remainingForRedis = [];
    for (const rel of safeRels) {
        const absAlbumPath = path.join(PHOTOS_DIR, rel);
        relToAbs.set(rel, absAlbumPath);
        const inMem = coverInfoCache.get(absAlbumPath);
        if (inMem && inMem.path) {
            coversMap.set(absAlbumPath, inMem);
        } else {
            remainingForRedis.push(rel);
        }
    }

    // 对剩余项优先读取 Redis
    const cacheKeys = remainingForRedis.map(rel => `cover_info:/${rel}`);
    let cachedResults = [];
    try {
        cachedResults = cacheKeys.length > 0 ? await redis.mget(cacheKeys) : [];
    } catch {
        cachedResults = new Array(cacheKeys.length).fill(null);
    }

    const missing = [];
    remainingForRedis.forEach((rel, idx) => {
        const absAlbumPath = relToAbs.get(rel);
        const cached = cachedResults[idx];
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.path) {
                    coversMap.set(absAlbumPath, parsed);
                    coverInfoCache.set(absAlbumPath, parsed);
                    return;
                }
            } catch {}
        }
        missing.push(rel);
    });

    if (missing.length > 0) {
        // 优先从 album_covers 表按 IN 批量查找，分批避免超长 SQL
        const BATCH = 200;
        try {
            for (let i = 0; i < missing.length; i += BATCH) {
                const batch = missing.slice(i, i + BATCH);
                const placeholders = batch.map(() => '?').join(',');
                const rows = await dbAll(
                    'main',
                    `SELECT album_path, cover_path, width, height, mtime
                     FROM album_covers
                     WHERE album_path IN (${placeholders})`,
                    batch
                );
                for (const row of rows || []) {
                    const absAlbumPath = path.join(PHOTOS_DIR, row.album_path);
                    const absMedia = path.join(PHOTOS_DIR, row.cover_path);
                    const info = { path: absMedia, width: row.width || 1, height: row.height || 1, mtime: row.mtime || Date.now() };
                    coversMap.set(absAlbumPath, info);
                    try { await redis.set(`cover_info:/${row.album_path}`, JSON.stringify(info), 'EX', CACHE_DURATION); } catch {}
                    coverInfoCache.set(absAlbumPath, info);
                }
            }
        } catch (e) {
            logger.warn('从 album_covers 表批量读取失败，将回退逐相册计算: ' + (e && e.message));
        }

        // 对仍未命中的相册，回退为逐相册计算（仅个别漏网）
        const stillMissing = missing.filter(rel => !coversMap.has(path.join(PHOTOS_DIR, rel)));
        for (const rel of stillMissing) {
            try {
                const likeParam = rel ? `${rel}/%` : '%';
                const rows = await dbAll('main',
                    `SELECT path, width, height, mtime
                     FROM items
                     WHERE type IN ('photo','video') AND path LIKE ?
                     ORDER BY mtime DESC
                     LIMIT 1`,
                    [likeParam]
                );
                if (rows && rows.length) {
                    const r = rows[0];
                    const absAlbumPath = path.join(PHOTOS_DIR, rel);
                    const abs = path.join(PHOTOS_DIR, r.path);
                    const info = { path: abs, width: r.width || 1, height: r.height || 1, mtime: r.mtime || Date.now() };
                    coversMap.set(absAlbumPath, info);
                    try { await redis.set(`cover_info:/${rel}`, JSON.stringify(info), 'EX', CACHE_DURATION); } catch {}
                    coverInfoCache.set(absAlbumPath, info);
                }
            } catch (err) {
                logger.debug('DB 封面逐条查询失败:', rel, err && err.message);
            }
        }
    }

    return coversMap;
}

/**
 * 直接子项（相册/媒体）分页，排序全部在 SQL 完成
 * @param {string} relativePathPrefix 相对路径前缀（'' 表示根）
 * @param {string} userId 用户ID（用于最近浏览排序）
 * @param {string} sort 排序策略：smart | name_asc | name_desc | mtime_asc | mtime_desc | viewed_desc
 * @param {number} limit 分页大小
 * @param {number} offset 偏移量
 * @returns {Promise<{ total:number, rows:Array }>}
 */
async function getDirectChildrenFromDb(relativePathPrefix, userId, sort, limit, offset) {
    await ensureBrowseIndexes();
    const prefix = (relativePathPrefix || '').replace(/\\/g, '/');

    const whereClause = !prefix
        ? `instr(path, '/') = 0`
        : `path LIKE ? || '/%' AND instr(substr(path, length(?) + 2), '/') = 0`;
    const whereParams = !prefix ? [] : [prefix, prefix];

    // 总数（albums + media）
    const totalRows = await dbAll('main',
        `SELECT COUNT(1) as c FROM items
         WHERE (${whereClause}) AND type IN ('album','photo','video')`,
        whereParams
    );
    const total = totalRows?.[0]?.c || 0;

    // 构建排序表达式
    const now = Date.now();
    const dayAgo = Math.floor(now - 24 * 60 * 60 * 1000);
    let orderBy = '';

    switch (sort) {
        case 'name_asc':
            orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE ASC`;
            break;
        case 'name_desc':
            orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE DESC`;
            break;
        case 'mtime_asc':
            orderBy = `ORDER BY is_dir DESC, mtime ASC`;
            break;
        case 'mtime_desc':
            orderBy = `ORDER BY is_dir DESC, mtime DESC`;
            break;
        case 'viewed_desc':
            // 不跨库 JOIN，先按名称排序，稍后在页面内做二次排序
            orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE ASC`;
            break;
        default: // smart
            if (!prefix) {
                orderBy = `ORDER BY is_dir DESC,
                                   CASE WHEN is_dir=1 THEN CASE WHEN mtime > ${dayAgo} THEN 0 ELSE 1 END END ASC,
                                   CASE WHEN is_dir=1 AND mtime > ${dayAgo} THEN mtime END DESC,
                                   CASE WHEN is_dir=1 AND mtime <= ${dayAgo} THEN name END COLLATE NOCASE ASC,
                                   CASE WHEN is_dir=0 THEN name END COLLATE NOCASE ASC`;
            } else {
                // 子目录 smart：历史优先改为名称排序，稍后在页面内做二次排序
                orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE ASC`;
            }
    }

    // albums 子查询（不跨库 JOIN）
    const albumsSelect = `SELECT 1 AS is_dir, i.name, i.path, i.mtime, i.width, i.height, NULL AS last_viewed
           FROM items i
           WHERE i.type = 'album' AND (${whereClause})`;

    // media 子查询
    const mediaSelect = `SELECT 0 AS is_dir, i.name, i.path, i.mtime, i.width, i.height, NULL AS last_viewed
                         FROM items i
                         WHERE i.type IN ('photo','video') AND (${whereClause})`;

    const unionSql = `SELECT * FROM (
                          ${albumsSelect}
                          UNION ALL
                          ${mediaSelect}
                      ) t
                      ${orderBy}
                      LIMIT ? OFFSET ?`;

    const params = [...whereParams, ...whereParams, limit, offset];

    const rows = await dbAll('main', unionSql, params);
    return { total, rows };
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
        // 先尝试进程内 LRU
        const inMem = coverInfoCache.get(directoryPath);
        if (inMem && inMem.path) return inMem;

        // 尝试获取 Redis 缓存
        const cachedCoverInfo = await redis.get(cacheKey);
        if (cachedCoverInfo) {
            try {
                const parsed = JSON.parse(cachedCoverInfo);
                if (parsed && parsed.path) {
                    coverInfoCache.set(directoryPath, parsed);
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
            try {
                await redis.set(cacheKey, JSON.stringify(coverInfo), 'EX', CACHE_DURATION);
            } catch (e) {
                logger.warn(`设置封面Redis缓存失败: ${cacheKey}`, e.message);
            }
            coverInfoCache.set(directoryPath, coverInfo);
            return coverInfo;
        }

        return null;
    } catch (e) {
        logger.debug(`查找封面时发生错误: ${directoryPath}`, e);
        return null;
    }
}


// 已下沉到 SQL：旧的 getSortedDirectoryEntries 已移除

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
async function getDirectoryContents(relativePathPrefix, page, limit, userId, sort = 'smart') {
    const directory = path.join(PHOTOS_DIR, relativePathPrefix);
    // 检查路径是否存在且为目录
    const stats = await fs.stat(directory).catch(() => null);
    if (!stats || !stats.isDirectory()) {
        // 对于根目录不存在的特殊情况，返回空结果而不是抛出错误
        if (relativePathPrefix === '') {
            logger.warn('照片根目录似乎不存在或不可读，返回空列表。');
            return { items: [], totalPages: 1, totalResults: 0 };
        }
        throw new Error(`路径未找到或不是目录: ${relativePathPrefix}`);
    }
    try {
        if (!isPathSafe(relativePathPrefix)) throw new Error('不安全的路径访问');

        const offset = (page - 1) * limit;
        const { total: totalResults, rows } = await getDirectChildrenFromDb(relativePathPrefix, userId, sort, limit, offset);
        const totalPages = Math.ceil(totalResults / limit) || 1;

        if (totalResults === 0 || rows.length === 0) {
            // 目录为空
            return { items: [], totalPages: 1, totalResults: 0 };
        }

        // 若需要“最近浏览优先”，在当前页范围内做二次排序（避免跨库 JOIN）
        const isSubdirSmart = sort === 'smart' && (relativePathPrefix || '').length > 0;
        const needViewedSort = sort === 'viewed_desc' || isSubdirSmart;
        let rowsEffective = rows;
        if (needViewedSort && userId) {
            const albumRows = rows.filter(r => r.is_dir === 1);
            if (albumRows.length > 0) {
                const albumPaths = albumRows.map(r => r.path);
                const placeholders = albumPaths.map(() => '?').join(',');
                try {
                    const viewRows = await dbAll(
                        'history',
                        `SELECT item_path, MAX(viewed_at) AS last_viewed FROM view_history WHERE user_id = ? AND item_path IN (${placeholders}) GROUP BY item_path`,
                        [userId, ...albumPaths]
                    );
                    const lastViewedMap = new Map(viewRows.map(v => [v.item_path, v.last_viewed || 0]));
                    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
                    const albumsSorted = albumRows.slice().sort((a, b) => (lastViewedMap.get(b.path) || 0) - (lastViewedMap.get(a.path) || 0) || collator.compare(a.name, b.name));
                    const mediaRows = rows.filter(r => r.is_dir === 0).slice().sort((a, b) => collator.compare(a.name, b.name));
                    rowsEffective = [...albumsSorted, ...mediaRows];
                } catch (e) {
                    logger.warn('读取最近浏览排序信息失败，回退为名称排序', e);
                }
            }
        }

        // 相册封面预取（基于 DB，避免递归 FS）
        const albumRows = rowsEffective.filter(r => r.is_dir === 1);
        const albumPathsRel = albumRows.map(r => r.path);
        const coversMap = await findCoverPhotosBatchDb(albumPathsRel);

        const items = await Promise.all(rowsEffective.map(async (row) => {
                const entryRelativePath = row.path;
                const fullAbsPath = path.join(PHOTOS_DIR, entryRelativePath);

                if (row.is_dir === 1) {
                    const coverInfo = coversMap.get(fullAbsPath);
                    let coverUrl = 'data:image/svg+xml,...';
                    let coverWidth = 1, coverHeight = 1;
                    
                    if (coverInfo && coverInfo.path) {
                        const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                        let coverMtime;
                        if (coverInfo.mtime != null) {
                            coverMtime = coverInfo.mtime;
                        } else {
                            logger.debug(`封面信息中缺少 mtime，回退到 fs.stat: ${coverInfo.path}`);
                            coverMtime = await fs.stat(coverInfo.path).then(s => s.mtimeMs).catch(() => Date.now());
                        }
                        coverUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}&v=${Math.floor(coverMtime)}`;
                        coverWidth = coverInfo.width;
                        coverHeight = coverInfo.height;
                    }
                    
                return {
                    type: 'album',
                    data: {
                        name: row.name || path.basename(entryRelativePath),
                        path: entryRelativePath,
                        coverUrl,
                        mtime: row.mtime || 0,
                        coverWidth,
                        coverHeight
                    }
                };
                } else {
                    const isVideo = /\.(mp4|webm|mov)$/i.test(row.name || path.basename(entryRelativePath));
                    let mtime = row.mtime;

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
                    let dimensions = { width: row.width, height: row.height };
                    
                // 如果数据库中没有宽高信息或数据无效，则动态获取
                    if (!dimensions || !dimensions.width || !dimensions.height) {
                        const cacheKey = `dim:${entryRelativePath}:${mtime}`;
                        let cachedDimensions = null;
                        try {
                            cachedDimensions = await redis.get(cacheKey);
                        } catch (e) {
                            logger.warn(`获取尺寸Redis缓存失败: ${cacheKey}`, e.message);
                        }

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
                            try {
                                await redis.set(cacheKey, JSON.stringify(dimensions), 'EX', 60 * 60 * 24 * 30);
                            } catch (e) {
                                logger.warn(`设置尺寸Redis缓存失败: ${cacheKey}`, e.message);
                            }
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
                    const thumbnailUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(entryRelativePath)}&v=${Math.floor(mtime)}`;

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
            await redis.del(...cacheKeys); // 使用扩展运算符展开数组
            logger.debug(`已清除 ${cacheKeys.length} 个封面缓存: ${changedPath}`);
        }
        // 同步清理进程内 LRU：按绝对父目录路径删除对应的相册键
        for (const absDir of affectedPaths) {
            try { coverInfoCache.delete(absDir); } catch {}
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
    findCoverPhoto,
    findCoverPhotosBatch,
    findCoverPhotosBatchDb,
    getDirectoryContents,
    invalidateCoverCache
};