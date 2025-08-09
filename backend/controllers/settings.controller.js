const bcrypt = require('bcryptjs');
const logger = require('../config/logger');
const settingsService = require('../services/settings.service');
const { settingsWorker } = require('../services/worker.manager'); // <-- 引入 settingsWorker

// 存储最近的设置更新状态
let lastSettingsUpdateStatus = null;

// 获取设置的逻辑不变
exports.getSettingsForClient = async (req, res) => {
    try {
        const allSettings = await settingsService.getAllSettings();
        const clientSettings = {
            AI_ENABLED: allSettings.AI_ENABLED,
            AI_URL: allSettings.AI_URL,
            AI_MODEL: allSettings.AI_MODEL,
            AI_PROMPT: allSettings.AI_PROMPT,
            // 不泄露任何 AI_KEY/AI_API_KEY
            PASSWORD_ENABLED: allSettings.PASSWORD_ENABLED,
            hasPassword: !!(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== ''),
            isAdminSecretConfigured: !!(process.env.ADMIN_SECRET && process.env.ADMIN_SECRET.trim() !== '')
        };
        res.json(clientSettings);
    } catch (error) {
        logger.error('获取客户端配置失败:', error);
        res.status(500).json({ code: 'SETTINGS_FETCH_ERROR', message: '获取配置失败', requestId: req.requestId });
    }
};

// 通用旧密码或管理员密钥校验函数
async function verifyAdminSecret(adminSecret) {
    // 首先检查服务器是否配置了ADMIN_SECRET
    if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.trim() === '') {
        logger.warn('安全操作失败：管理员密钥未在.env文件中配置。');
        return { ok: false, code: 500, msg: '管理员密钥未在服务器端配置，无法执行此操作' };
    }

    // 然后检查用户是否提供了密钥
    if (!adminSecret || adminSecret.trim() === '') {
        return { ok: false, code: 400, msg: '必须提供管理员密钥' };
    }

    // 最后验证密钥是否正确
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return { ok: false, code: 401, msg: '管理员密钥错误' };
    }

    logger.info('管理员密钥验证成功');
    return { ok: true };
}

// 更新设置的逻辑改变
exports.updateSettings = async (req, res) => {
    try {
        const { newPassword, adminSecret, ...rawSettings } = req.body;

        // 明确禁止持久化 AI 密钥相关字段
        const forbiddenKeys = ['AI_KEY', 'AI_API_KEY', 'OPENAI_API_KEY'];
        const settingsToUpdate = Object.fromEntries(
            Object.entries(rawSettings).filter(([k]) => !forbiddenKeys.includes(k))
        );

        const allSettings = await settingsService.getAllSettings();
        const passwordIsCurrentlySet = !!(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== '');

        const isTryingToSetOrChangePassword = newPassword && newPassword.trim() !== '';
        const isTryingToDisablePassword = Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') && settingsToUpdate.PASSWORD_ENABLED === 'false';

        // 敏感操作指的是修改或禁用一个已经存在的密码
        const isSensitiveOperation = (isTryingToSetOrChangePassword || isTryingToDisablePassword) && passwordIsCurrentlySet;

        if (isSensitiveOperation) {
            const verifyResult = await verifyAdminSecret(adminSecret);
            if (!verifyResult.ok) {
                return res.status(verifyResult.code).json({ error: verifyResult.msg });
            }
        }

        // 根据操作类型，更新密码哈希
        if (isTryingToSetOrChangePassword) {
            logger.info('正在为新密码生成哈希值...');
            const salt = await bcrypt.genSalt(10);
            settingsToUpdate.PASSWORD_HASH = await bcrypt.hash(newPassword, salt);
        } else if (isTryingToDisablePassword && passwordIsCurrentlySet) {
            settingsToUpdate.PASSWORD_HASH = '';
        }
        
        // 开启密码访问时，若数据库无密码，必须强制要求设置新密码
        if (
            Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') &&
            settingsToUpdate.PASSWORD_ENABLED === 'true' &&
            !passwordIsCurrentlySet && !isTryingToSetOrChangePassword
        ) {
            return res.status(400).json({ error: '请设置新密码以启用密码访问' });
        }

        // 重置更新状态
        lastSettingsUpdateStatus = {
            timestamp: Date.now(),
            status: 'pending',
            updatedKeys: Object.keys(settingsToUpdate)
        };

        // 检查是否包含认证相关设置（密码或AI配置）
        const authRelatedKeys = ['PASSWORD_ENABLED', 'PASSWORD_HASH', 'AI_ENABLED', 'AI_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_PROMPT'];
        const hasAuthChanges = Object.keys(settingsToUpdate).some(key => authRelatedKeys.includes(key));

        if (hasAuthChanges) {
            // 对于认证相关设置，等待后台任务完成
            logger.info('检测到认证相关设置变更，等待后台任务完成...');
            
            // 给 settings worker 发送消息
            settingsWorker.postMessage({
                type: 'update_settings',
                payload: settingsToUpdate
            });

            // 等待任务完成（最多等待5秒）
            const maxWaitTime = 5000; // 5秒
            const startTime = Date.now();
            
            while (lastSettingsUpdateStatus.status === 'pending' && (Date.now() - startTime) < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, 50)); // 等待50ms，更频繁检查
            }

            if (lastSettingsUpdateStatus.status === 'pending') {
                // 超时
                logger.warn('设置更新超时，返回超时状态');
                return res.json({ 
                    success: false, 
                    message: '设置更新超时，请稍后检查状态',
                    status: 'timeout',
                    updateId: lastSettingsUpdateStatus.timestamp
                });
            } else if (lastSettingsUpdateStatus.status === 'success') {
                // 成功
                return res.json({ 
                    success: true, 
                    message: '设置更新成功',
                    status: 'success',
                    updateId: lastSettingsUpdateStatus.timestamp
                });
            } else if (lastSettingsUpdateStatus.status === 'failed') {
                // 失败
                return res.status(500).json({ 
                    code: 'SETTINGS_UPDATE_FAILED',
                    message: lastSettingsUpdateStatus.message || '未知错误',
                    status: 'failed',
                    updateId: lastSettingsUpdateStatus.timestamp,
                    requestId: req.requestId
                });
            } else {
                // 其它未知状态
                return res.status(500).json({ 
                    code: 'SETTINGS_UPDATE_UNKNOWN',
                    message: lastSettingsUpdateStatus.message || '未知错误',
                    status: lastSettingsUpdateStatus.status,
                    updateId: lastSettingsUpdateStatus.timestamp,
                    requestId: req.requestId
                });
            }
        } else {
            // 对于非认证相关设置，立即返回成功
            logger.info('非认证相关设置变更，立即返回成功');
            
            settingsWorker.postMessage({
                type: 'update_settings',
                payload: settingsToUpdate
            });

            res.json({ 
                success: true, 
                message: '配置更新任务已提交',
                status: 'submitted',
                updateId: lastSettingsUpdateStatus.timestamp
            });
        }

    } catch (error) {
        logger.error(`[${req.requestId || '-'}] 提交更新配置任务失败:`, error);
        res.status(500).json({ code: 'SETTINGS_SUBMIT_ERROR', message: '提交更新配置任务失败', requestId: req.requestId });
    }
};

// 新增：获取设置更新状态
exports.getSettingsUpdateStatus = async (req, res) => {
    try {
        if (!lastSettingsUpdateStatus) {
            return res.status(404).json({ error: '没有找到最近的设置更新记录' });
        }

        // 如果状态是 pending 且超过30秒，认为超时
        if (lastSettingsUpdateStatus.status === 'pending' && 
            Date.now() - lastSettingsUpdateStatus.timestamp > 30000) {
            lastSettingsUpdateStatus.status = 'timeout';
        }

        res.json({
            status: lastSettingsUpdateStatus.status,
            timestamp: lastSettingsUpdateStatus.timestamp,
            updatedKeys: lastSettingsUpdateStatus.updatedKeys,
            message: lastSettingsUpdateStatus.message || null
        });
    } catch (error) {
        logger.error('获取设置更新状态失败:', error);
        res.status(500).json({ error: '获取设置更新状态失败' });
    }
};

// 导出函数供 indexer.service.js 调用
exports.updateSettingsStatus = (status, message = null) => {
    if (lastSettingsUpdateStatus) {
        lastSettingsUpdateStatus.status = status;
        lastSettingsUpdateStatus.message = message;
    }
};