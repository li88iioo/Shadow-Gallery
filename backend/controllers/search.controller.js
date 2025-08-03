/**
 * 搜索控制器模块
 * 处理全文搜索相关的请求，支持相册和视频的智能搜索和分页
 */
const path = require('path');
const fs = require('fs').promises;
const logger = require('../config/logger');
const { dbAll } = require('../db/multi-db');
const { createNgrams } = require('../utils/search.utils');
const { findCoverPhotosBatch } = require('../services/file.service');
const { PHOTOS_DIR } = require('../config');

/**
 * 搜索文件和相册
 * 使用SQLite FTS全文搜索功能，支持相册和视频的智能搜索、分页和封面图片获取
 * @param {Object} req - Express请求对象，包含搜索查询参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含搜索结果、分页信息和总数
 */
exports.searchItems = async (req, res) => {
    try {
        // 获取并清理搜索查询关键词
        const query = (req.query.q || '').trim();
        // 获取用户ID，用于个性化搜索（可选）
        const userId = req.headers['x-user-id'] || null;

        // 验证搜索关键词不能为空
        if (!query) {
            return res.status(400).json({ error: '搜索关键词不能为空' });
        }

        // 检查索引状态
        try {
            const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
            const ftsCount = await dbAll('main', "SELECT COUNT(*) as count FROM items_fts");
            
            if (itemCount[0].count === 0) {
                return res.status(503).json({ error: '搜索索引正在构建中，请稍后再试' });
            }
            
            if (ftsCount[0].count === 0) {
                return res.status(503).json({ error: '搜索索引正在构建中，请稍后再试' });
            }
        } catch (dbError) {
            logger.error('检查索引状态失败:', dbError);
            return res.status(503).json({ error: '搜索服务暂时不可用，请稍后再试' });
        }

        // 获取分页参数
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = (page - 1) * limit;

        // 清理搜索查询，移除特殊字符
        const sanitizedQuery = query.replace(/[(){}\[\]\/\\."*?!:^~+-,]/g, ' ').trim();
        if (!sanitizedQuery) {
            return res.json({ query, results: [], page: 1, totalPages: 1, totalResults: 0, limit });
        }
        
        // 创建n-gram搜索查询，支持1-2字符的模糊匹配
        const ftsQuery = createNgrams(sanitizedQuery, 1, 2);

        // --- ↓↓↓ 性能优先分页优化 ↓↓↓ ---

        // 1. 使用一条SQL统计 album 和 video 总数
        // 排除嵌套相册，只统计顶级相册
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
        const counts = await dbAll('main', countSql, [ftsQuery]);
        const albumTotal = counts.find(c => c.type === 'album')?.count || 0;
        const videoTotal = counts.find(c => c.type === 'video')?.count || 0;
        const totalResults = albumTotal + videoTotal;
        const totalPages = Math.ceil(totalResults / limit);

        // 2. 分别对 album 和 video 排序分页
        // 计算相册和视频的偏移量和限制数，确保分页正确
        let albumOffset = offset;
        let albumLimit = Math.max(0, Math.min(limit, albumTotal - albumOffset));
        let videoOffset = Math.max(0, offset - albumTotal);
        let videoLimit = Math.max(0, limit - albumLimit);
        
        // 如果相册数量不足，调整视频的偏移量
        if (albumLimit === 0 && videoLimit > 0) {
            albumOffset = 0;
            videoOffset = offset - albumTotal;
            videoLimit = limit;
        }
        
        // 相册搜索SQL：排除嵌套相册，按相关性排序
        const albumSql = `
            SELECT i.id, i.path, i.type, i.mtime, items_fts.rank, i.name
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
        
        // 视频搜索SQL：按相关性排序
        const videoSql = `
            SELECT i.id, i.path, i.type, i.mtime, items_fts.rank, i.name
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE items_fts.name MATCH ?
              AND i.type = 'video'
            ORDER BY items_fts.rank ASC
            LIMIT ? OFFSET ?
        `;
        
        // 执行相册和视频搜索查询
        const albumResults = albumLimit > 0 ? await dbAll('main', albumSql, [ftsQuery, albumLimit, albumOffset]) : [];
        const videoResults = videoLimit > 0 ? await dbAll('main', videoSql, [ftsQuery, videoLimit, videoOffset]) : [];
        const sortedPaginatedResults = [...albumResults, ...videoResults];

        // --- ↑↑↑ 性能优先分页优化结束 ↑↑↑ ---

        // 直接使用 sortedPaginatedResults 作为 paginatedResults，无需多余过滤
        const paginatedResults = sortedPaginatedResults;

        // 批量获取相册封面图片
        const albumResultsForCover = paginatedResults.filter(r => r.type === 'album');
        const albumPaths = albumResultsForCover.map(r => path.join(PHOTOS_DIR, r.path));
        const coversMap = await findCoverPhotosBatch(albumPaths);

        // 处理搜索结果，添加封面图片和URL信息
        const resultsWithData = await Promise.all(paginatedResults.map(async (result) => {
            if (!result) return null;
            
            // 获取父目录路径，统一使用正斜杠
            const parentPath = path.dirname(result.path).replace(/\\/g, '/');
            
            if (result.type === 'album') {
                // 处理相册结果：添加封面图片信息
                const fullAbsPath = path.join(PHOTOS_DIR, result.path);
                const coverInfo = coversMap.get(fullAbsPath);
                
                // 默认封面图片（SVG占位符）
                let coverUrl = 'data:image/svg+xml,...';
                let coverWidth = 1, coverHeight = 1;
                
                // 如果找到封面图片，构建缩略图URL
                if (coverInfo && coverInfo.path) {
                    const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                    coverUrl = `/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}`;
                    coverWidth = coverInfo.width;
                    coverHeight = coverInfo.height;
                }
                
                return { 
                    ...result, 
                    path: result.path.replace(/\\/g, '/'), 
                    coverUrl, 
                    parentPath, 
                    coverWidth, 
                    coverHeight,
                    mtime: result.mtime
                };
            } else { // video
                // 处理视频结果：添加原始视频和缩略图URL
                const originalUrl = `/static/${result.path.split(path.sep).map(encodeURIComponent).join('/')}`;
                const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(result.path)}`;
                return { 
                    ...result, 
                    path: result.path.replace(/\\/g, '/'), 
                    originalUrl, 
                    thumbnailUrl, 
                    parentPath,
                    mtime: result.mtime
                };
            }
        }));
        
        // 返回搜索结果，过滤掉空值
        res.json({ 
            query, 
            results: resultsWithData.filter(Boolean), 
            page, 
            totalPages, 
            totalResults, 
            limit 
        });
    } catch (err) {
        // 记录详细错误信息
        logger.error("FTS 搜索 API 顶层出错:", err && (err.stack || err.message || err));
        res.status(500).json({ error: '搜索失败' });
    }
};