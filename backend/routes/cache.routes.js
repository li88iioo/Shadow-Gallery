const express = require('express');
const router = express.Router();
const { getCacheStats, clearCache } = require('../middleware/cache');
const logger = require('../config/logger');

/**
 * 获取缓存统计信息
 * GET /api/cache/stats
 */
router.get('/stats', (req, res) => {
    try {
        const stats = getCacheStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        logger.error('获取缓存统计失败:', error);
        res.status(500).json({ error: '获取缓存统计失败' });
    }
});

/**
 * 清理缓存
 * POST /api/cache/clear
 */
router.post('/clear', clearCache('route_cache:*'), (req, res) => {
    res.json({ success: true, message: '缓存清理完成' });
});

/**
 * 清理特定模式的缓存
 * POST /api/cache/clear/:pattern
 */
router.post('/clear/:pattern', (req, res) => {
    const pattern = req.params.pattern;
    clearCache(pattern)(req, res, () => {
        res.json({ success: true, message: `清理缓存模式: ${pattern}` });
    });
});

module.exports = router; 