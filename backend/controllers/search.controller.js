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
        // 获取并清理搜索查询关键词（已由 Joi 校验基本合法性）
        const query = (req.query.q || '').trim();
        // 获取用户ID，用于个性化搜索（可选）
        const userId = req.headers['x-user-id'] || null;

        // 验证搜索关键词不能为空
        if (!query) {
            return res.status(400).json({ code: 'INVALID_QUERY', message: '搜索关键词不能为空', requestId: req.requestId });
        }

        // 检查索引状态
        const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
        const ftsCount = await dbAll('main', "SELECT COUNT(*) as count FROM items_fts");
        if (!itemCount || !ftsCount) throw new Error('INDEX_CHECK_FAILED');
        if (itemCount[0].count === 0 || ftsCount[0].count === 0) {
            return res.status(503).json({ code: 'SEARCH_UNAVAILABLE', message: '搜索索引正在构建中，请稍后再试', requestId: req.requestId });
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

        // --- ↓↓↓ 简化分页逻辑：单条 SQL 完成计数与分页 ↓↓↓ ---

        // 1) 计算总数：相册仅统计“非嵌套相册”，视频全部纳入
        const totalCountSql = `
            SELECT COUNT(1) AS count
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE items_fts.name MATCH ?
              AND (
                    i.type = 'video'
                 OR (
                      i.type = 'album'
                  AND NOT EXISTS (
                        SELECT 1 FROM items AS sub
                        WHERE sub.type = 'album' AND sub.path LIKE i.path || '/%'
                  )
                 )
              )
        `;
        const totalRow = await dbAll('main', totalCountSql, [ftsQuery]);
        const totalResults = totalRow?.[0]?.count || 0;
        const totalPages = Math.ceil(totalResults / limit);

        // 2) 取当页数据：先按“相册优先”，再按相关性排序
        const unifiedSql = `
            SELECT i.id, i.path, i.type, i.mtime, i.width, i.height, items_fts.rank, i.name
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE items_fts.name MATCH ?
              AND (
                    i.type = 'video'
                 OR (
                      i.type = 'album'
                  AND NOT EXISTS (
                        SELECT 1 FROM items AS sub
                        WHERE sub.type = 'album' AND sub.path LIKE i.path || '/%'
                  )
                 )
              )
            ORDER BY CASE i.type WHEN 'album' THEN 0 ELSE 1 END, items_fts.rank ASC
            LIMIT ? OFFSET ?
        `;
        const paginatedResults = await dbAll('main', unifiedSql, [ftsQuery, limit, offset]);

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
                    mtime: result.mtime,
                    width: result.width || 1920,  // 使用数据库中的宽度，默认1920
                    height: result.height || 1080  // 使用数据库中的高度，默认1080
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
};