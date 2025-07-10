const path = require('path');
const logger = require('../config/logger');
const { dbAll } = require('../db/sqlite');
const { createNgrams } = require('../utils/search.utils');
const { findCoverPhotosBatch } = require('../services/file.service');
const { PHOTOS_DIR } = require('../config');


exports.searchItems = async (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        const userId = req.headers['x-user-id'] || null; // 接收用户ID

        if (!query) {
            return res.status(400).json({ error: '搜索关键词不能为空' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = (page - 1) * limit;

        const sanitizedQuery = query.replace(/[(){}\[\]\/\\."*?!:^~+-,]/g, ' ').trim();
        if (!sanitizedQuery) {
            return res.json({ query, results: [], page: 1, totalPages: 1, totalResults: 0, limit });
        }
        
        const ftsQuery = createNgrams(sanitizedQuery, 1, 2);

        // --- ↓↓↓ 性能优先分页优化 ↓↓↓ ---

        // 1. 使用一条SQL统计 album 和 video 总数
        const countSql = `
            SELECT
                i.type,
                COUNT(1) as count
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE items_fts.name MATCH ?
              AND i.type IN ('album', 'video')
              AND NOT (
                  i.type = 'album' AND EXISTS (
                      SELECT 1 FROM items AS sub
                      WHERE sub.type = 'album'
                        AND sub.path LIKE i.path || '/%'
                  )
              )
            GROUP BY i.type
        `;
        const counts = await dbAll(countSql, [ftsQuery]);
        const albumTotal = counts.find(c => c.type === 'album')?.count || 0;
        const videoTotal = counts.find(c => c.type === 'video')?.count || 0;
        const totalResults = albumTotal + videoTotal;
        const totalPages = Math.ceil(totalResults / limit);

        // 2. 分别对 album 和 video 排序分页
        let albumOffset = offset;
        let albumLimit = Math.max(0, Math.min(limit, albumTotal - albumOffset));
        let videoOffset = Math.max(0, offset - albumTotal);
        let videoLimit = Math.max(0, limit - albumLimit);
        if (albumLimit === 0 && videoLimit > 0) {
            albumOffset = 0;
            videoOffset = offset - albumTotal;
            videoLimit = limit;
        }
        const albumSql = `
            SELECT i.id, i.path, i.type, items_fts.rank, i.name
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE items_fts.name MATCH ?
              AND i.type = 'album'
              AND NOT EXISTS (
                  SELECT 1 FROM items AS sub
                  WHERE sub.type = 'album'
                    AND sub.path LIKE i.path || '/%'
              )
            ORDER BY items_fts.rank ASC
            LIMIT ? OFFSET ?
        `;
        const videoSql = `
            SELECT i.id, i.path, i.type, items_fts.rank, i.name
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE items_fts.name MATCH ?
              AND i.type = 'video'
            ORDER BY items_fts.rank ASC
            LIMIT ? OFFSET ?
        `;
        const albumResults = albumLimit > 0 ? await dbAll(albumSql, [ftsQuery, albumLimit, albumOffset]) : [];
        const videoResults = videoLimit > 0 ? await dbAll(videoSql, [ftsQuery, videoLimit, videoOffset]) : [];
        const sortedPaginatedResults = [...albumResults, ...videoResults];

        // --- ↑↑↑ 性能优先分页优化结束 ↑↑↑ ---

        // 直接使用 sortedPaginatedResults 作为 paginatedResults，无需多余过滤
        const paginatedResults = sortedPaginatedResults;

        const albumResultsForCover = paginatedResults.filter(r => r.type === 'album');
        const albumPaths = albumResultsForCover.map(r => path.join(PHOTOS_DIR, r.path));
        const coversMap = await findCoverPhotosBatch(albumPaths);

        const resultsWithData = await Promise.all(paginatedResults.map(async (result) => {
            if (!result) return null;
            const parentPath = path.dirname(result.path).replace(/\\/g, '/');
            if (result.type === 'album') {
                const fullAbsPath = path.join(PHOTOS_DIR, result.path);
                const coverInfo = coversMap.get(fullAbsPath);
                let coverUrl = 'data:image/svg+xml,...';
                let coverWidth = 1, coverHeight = 1;
                if (coverInfo && coverInfo.path) {
                    const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                    coverUrl = `/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}`;
                    coverWidth = coverInfo.width;
                    coverHeight = coverInfo.height;
                }
                return { ...result, path: result.path.replace(/\\/g, '/'), coverUrl, parentPath, coverWidth, coverHeight };
            } else { // video
                const originalUrl = `/static/${result.path.split(path.sep).map(encodeURIComponent).join('/')}`;
                const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(result.path)}`;
                return { ...result, path: result.path.replace(/\\/g, '/'), originalUrl, thumbnailUrl, parentPath };
            }
        }));
        
        res.json({ query, results: resultsWithData.filter(Boolean), page, totalPages, totalResults, limit });
    } catch (err) {
        logger.error("FTS 搜索 API 顶层出错:", err && (err.stack || err.message || err));
        res.status(500).json({ error: '搜索失败' });
    }
};