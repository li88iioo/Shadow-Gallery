/**
 * 相册控制器模块
 * 处理相册相关的请求，包括获取所有相册封面图片
 */
const { PHOTOS_DIR, API_BASE } = require('../config');
const { findCoverPhotosBatchDb } = require('../services/file.service');
const { dbAll } = require('../db/multi-db');
const path = require('path');

/**
 * 获取所有相册封面图片
 * 基于数据库列出所有相册路径，批量获取封面图片URL
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含所有相册封面图片的URL数组
 */
exports.getAllAlbumCovers = async (req, res) => {
    try {
        // 通过数据库列出所有相册相对路径
        const rows = await dbAll('main', `SELECT path FROM items WHERE type='album'`);
        const allAlbumRel = rows.map(r => r.path);
        
        if (allAlbumRel.length === 0) {
            console.warn('未找到任何相册目录');
            return res.json([]);
        }
        
        // 批量查找每个相册的封面图片（DB 方案）
        const coversMap = await findCoverPhotosBatchDb(allAlbumRel);
        
        // 构建封面图片的URL数组
        const coverUrls = [];
        for (const [absAlbumPath, coverInfo] of coversMap.entries()) {
            if (coverInfo && coverInfo.path) {
                const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                const version = coverInfo.mtime || Date.now();
                coverUrls.push(`${API_BASE}/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}&v=${version}`);
            }
        }
        
        // 如果没有找到任何封面，返回空数组而不是错误
        if (coverUrls.length === 0) {
            console.warn('未找到任何封面图片');
        } else {
            console.log(`成功找到 ${coverUrls.length} 个封面图片`);
        }
        
        // 返回封面图片URL数组
        res.json(coverUrls);
    } catch (e) {
        console.error('获取相册封面失败:', e);
        // 错误处理：返回500状态码和错误信息
        res.status(500).json({ 
            error: '获取相册封面失败', 
            message: e.message,
            details: process.env.NODE_ENV === 'development' ? e.stack : undefined
        });
    }
}; 

/**
 * 游标式分页获取相册封面
 * 使用 items.id 作为游标，避免全量载入
 * GET /api/album/covers/cursor?limit=100&cursor=0
 */
exports.getAlbumCoversCursor = async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const cursor = Math.max(parseInt(req.query.cursor, 10) || 0, 0);

        // 读取一页相册路径（按 id 升序）
        const rows = await dbAll('main',
            `SELECT id, path, mtime, width, height
             FROM items
             WHERE type='album' AND id > ?
             ORDER BY id ASC
             LIMIT ?`,
            [cursor, limit]
        );

        if (!rows || rows.length === 0) {
            return res.json({ items: [], nextCursor: null, hasMore: false });
        }

        const allAlbumRel = rows.map(r => r.path);
        const coversMap = await findCoverPhotosBatchDb(allAlbumRel);

        const items = rows.map(r => {
            const absAlbum = path.join(PHOTOS_DIR, r.path);
            const coverInfo = coversMap.get(absAlbum);
            if (!coverInfo || !coverInfo.path) {
                return {
                    path: r.path,
                    coverUrl: null,
                    width: 1,
                    height: 1,
                    mtime: r.mtime || 0
                };
            }
            const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
            const version = coverInfo.mtime || Date.now();
            const coverUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}&v=${version}`;
            return {
                path: r.path,
                coverUrl,
                width: coverInfo.width || 1,
                height: coverInfo.height || 1,
                mtime: r.mtime || 0
            };
        });

        const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
        res.json({ items, nextCursor, hasMore: Boolean(nextCursor) });
    } catch (e) {
        console.error('游标式获取相册封面失败:', e);
        res.status(500).json({ error: '游标式获取相册封面失败', message: e.message });
    }
};