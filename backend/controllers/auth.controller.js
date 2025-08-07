const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getAllSettings } = require('../services/settings.service');
const logger = require('../config/logger');

// 建议将 JWT_SECRET 放入 .env 文件中
const JWT_SECRET = process.env.JWT_SECRET || 'a-very-strong-secret-key-for-shadow-gallery';

// 检查是否需要密码
exports.getAuthStatus = async (req, res) => {
    try {
        const { PASSWORD_ENABLED } = await getAllSettings();
        res.json({ 
            passwordEnabled: PASSWORD_ENABLED === 'true'
        });
    } catch (error) {
        logger.error('获取认证状态失败:', error);
        // 即使数据库失败，也应让前端有机会进入设置流程
        res.status(200).json({ 
            error: '无法获取认证状态', 
            passwordEnabled: false
        });
    }
};

// 登录处理
exports.login = async (req, res) => {
    try {
        const { password } = req.body;
        const { PASSWORD_ENABLED, PASSWORD_HASH } = await getAllSettings();

        if (PASSWORD_ENABLED !== 'true') {
            return res.status(400).json({ error: '密码访问未开启' });
        }

        if (!password || !PASSWORD_HASH) {
            return res.status(401).json({ error: '密码错误' });
        }

        const isMatch = await bcrypt.compare(password, PASSWORD_HASH);

        if (!isMatch) {
            return res.status(401).json({ error: '密码错误' });
        }

        // 密码正确，签发一个 token
        const token = jwt.sign({ user: 'gallery_user' }, JWT_SECRET, { expiresIn: '7d' });
        logger.info('用户登录成功，已签发 Token。');
        res.json({ success: true, token });

    } catch(error) {
        logger.error('登录处理时发生错误:', error);
        res.status(500).json({ error: '登录时发生内部错误' });
    }
};