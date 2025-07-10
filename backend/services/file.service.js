// backend/services/file.service.js

const { promises: fs } = require('fs');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { PHOTOS_DIR, API_BASE } = require('../config');
const { isPathSafe } = require('../utils/path.utils');
const { dbAll } = require('../db/sqlite');

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
            coversMap.set(directoryPaths[index], JSON.parse(cached));
        } else {
            uncachedPaths.push(directoryPaths[index]);
        }
    });

    if (uncachedPaths.length > 0) {
        const foundCovers = await Promise.all(uncachedPaths.map(p => findCoverPhoto(p)));
        foundCovers.forEach((coverInfo, index) => {
            coversMap.set(uncachedPaths[index], coverInfo);
        });
    }

    return coversMap;
}

async function findCoverPhoto(directoryPath) {

    const cacheKey = `cover_info:${directoryPath.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`;
    try {
        const cachedCoverInfo = await redis.get(cacheKey);
        if (cachedCoverInfo) return JSON.parse(cachedCoverInfo);
        
        if (!directoryPath || typeof directoryPath !== 'string' || directoryPath.trim() === '') return null;
        const relativePath = path.relative(PHOTOS_DIR, directoryPath);
        if (!isPathSafe(relativePath)) return null;

        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        let foundCoverPath = null;
        
        for (const entry of entries) {
            if (entry.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(entry.name)) {
                foundCoverPath = path.join(directoryPath, entry.name);
                break;
            }
        }
        if (!foundCoverPath) {
            for (const entry of entries) {
                if (entry.isFile() && /\.(mp4|webm|mov)$/i.test(entry.name)) {
                    foundCoverPath = path.join(directoryPath, entry.name);
                    break;
                }
            }
        }
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
            await redis.set(cacheKey, JSON.stringify(coverInfo), 'EX', 604800);
            return coverInfo;
        }

        return null;
    } catch (e) {
        logger.debug(`查找封面时发生错误: ${directoryPath}`, e);
        return null;
    }
}

async function getSortedDirectoryEntries(directory, relativePathPrefix, userId) {
    let entries = await fs.readdir(directory, { withFileTypes: true });
    entries = entries.filter(e => e.name !== '@eaDir');

    const albumEntries = entries.filter(e => e.isDirectory());
    const mediaEntries = entries.filter(e => e.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(e.name));

    let viewedAtMap = new Map();
    if (albumEntries.length > 0 && userId) {
        const albumRelativePaths = albumEntries.map(e => path.join(relativePathPrefix, e.name).replace(/\\/g, '/'));
        
        const dbResults = await dbAll(`SELECT item_path FROM view_history WHERE user_id = ? AND item_path IN (${albumRelativePaths.map(() => '?').join(',')})`, [userId, ...albumRelativePaths]);
        viewedAtMap = new Map(dbResults.map(row => [row.item_path, true]));
    }

    const albumsWithContext = await Promise.all(albumEntries.map(async e => {
        const entryRelativePath = path.join(relativePathPrefix, e.name).replace(/\\/g, '/');
        const fullAbsPath = path.join(directory, e.name);
        const stats = await fs.stat(fullAbsPath).catch(() => ({ mtimeMs: 0 }));
        return {
            entry: e,
            path: entryRelativePath,
            isViewed: viewedAtMap.has(entryRelativePath),
            mtime: stats.mtimeMs,
        };
    }));
    
    let sortedAlbumEntries;

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
            if (a.isViewed !== b.isViewed) {
                return a.isViewed ? 1 : -1;
            }
            return a.entry.name.localeCompare(b.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
        });
        sortedAlbumEntries = albumsWithContext.map(a => a.entry);
    }

    mediaEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return [...sortedAlbumEntries, ...mediaEntries];
}

async function getDirectoryContents(directory, relativePathPrefix, page, limit, userId) {
    try {
        if (!isPathSafe(relativePathPrefix)) throw new Error('不安全的路径访问');

        const allSortedEntries = await getSortedDirectoryEntries(directory, relativePathPrefix, userId);
        const totalResults = allSortedEntries.length;
        const totalPages = Math.ceil(totalResults / limit);
        const offset = (page - 1) * limit;
        const paginatedEntries = allSortedEntries.slice(offset, offset + limit);

        const albumEntries = paginatedEntries.filter(entry => entry.isDirectory());
        const albumPaths = albumEntries.map(entry => path.join(PHOTOS_DIR, relativePathPrefix, entry.name));
        const coversMap = await findCoverPhotosBatch(albumPaths);

        const items = await Promise.all(paginatedEntries.map(async (entry) => {
            const entryRelativePath = path.join(relativePathPrefix, entry.name);
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
                        path: entryRelativePath.replace(/\\/g, '/'),
                        coverUrl,
                        mtime: (await fs.stat(fullAbsPath).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
                        coverWidth,
                        coverHeight
                    }
                };
            } else {
                const isVideo = /\.(mp4|webm|mov)$/i.test(entry.name);
                const stats = await fs.stat(fullAbsPath).catch(() => ({ mtimeMs: 0 }));
                const cacheKey = `dim:${entryRelativePath}:${stats.mtimeMs}`;
                let dimensions = null;
                const cachedDimensions = await redis.get(cacheKey);

                if (cachedDimensions) {
                    dimensions = JSON.parse(cachedDimensions);
                } else {
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

module.exports = {
    getVideoDimensions,
    findCoverPhoto,
    findCoverPhotosBatch,
    getDirectoryContents
};