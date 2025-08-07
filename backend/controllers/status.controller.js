const { dbAll } = require('../db/multi-db');
const logger = require('../config/logger');

exports.getIndexingStatus = async (req, res) => {
    try {
        const status = await dbAll('index', "SELECT * FROM index_status WHERE id = 1");
        if (status.length > 0) {
            res.json(status[0]);
        } else {
            // 如果在索引完成前请求，可能还没有状态记录，返回一个默认的“正在构建”状态
            res.json({ status: 'building', processed_files: 0 });
        }
    } catch (error) {
        logger.error('获取索引状态失败:', error);
        res.status(500).json({ error: '获取状态失败' });
    }
};