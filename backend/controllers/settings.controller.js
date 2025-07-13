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
            PASSWORD_ENABLED: allSettings.PASSWORD_ENABLED,
            hasPassword: !!(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== '')
        };
        res.json(clientSettings);
    } catch (error) {
        logger.error('获取客户端配置失败:', error);
        res.status(500).json({ error: '获取配置失败' });
    }
};

// 通用旧密码校验函数
async function verifyOldPassword(oldPassword) {
    const allSettings = await settingsService.getAllSettings();
    const currentHash = allSettings.PASSWORD_HASH;
    if (currentHash && currentHash !== '') {
        if (!oldPassword || oldPassword.trim() === '') {
            return { ok: false, code: 400, msg: '请提供旧密码以验证身份' };
        }
        if (!(await bcrypt.compare(oldPassword, currentHash))) {
            return { ok: false, code: 401, msg: '旧密码错误' };
        }
    }
    return { ok: true };
}

// 更新设置的逻辑改变
exports.updateSettings = async (req, res) => {
    try {
        const { newPassword, oldPassword, ...settingsToUpdate } = req.body;

        // 修改密码时校验旧密码
        if (newPassword && newPassword.trim() !== '') {
            const verifyResult = await verifyOldPassword(oldPassword);
            if (!verifyResult.ok) {
                return res.status(verifyResult.code).json({ error: verifyResult.msg + '，无法修改密码' });
            }
            logger.info('正在为新密码生成哈希值...');
            const salt = await bcrypt.genSalt(10);
            settingsToUpdate.PASSWORD_HASH = await bcrypt.hash(newPassword, salt);
        }

        // 关闭密码访问时校验旧密码
        if (
            Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') &&
            settingsToUpdate.PASSWORD_ENABLED === 'false'
        ) {
            const verifyResult = await verifyOldPassword(oldPassword);
            if (!verifyResult.ok) {
                return res.status(verifyResult.code).json({ error: verifyResult.msg + '，无法关闭密码访问' });
            }
            settingsToUpdate.PASSWORD_HASH = '';
        }

        // 开启密码访问时，若数据库无密码，必须强制要求设置新密码
        if (
            Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') &&
            settingsToUpdate.PASSWORD_ENABLED === 'true'
        ) {
            const allSettings = await settingsService.getAllSettings();
            const currentHash = allSettings.PASSWORD_HASH;
            if (!currentHash || currentHash === '') {
                if (!newPassword || newPassword.trim() === '') {
                    return res.status(400).json({ error: '请设置新密码以启用密码访问' });
                }
                logger.info('正在为新密码生成哈希值...');
                const salt = await bcrypt.genSalt(10);
                settingsToUpdate.PASSWORD_HASH = await bcrypt.hash(newPassword, salt);
            }
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
                    error: '设置更新失败',
                    message: lastSettingsUpdateStatus.message || '未知错误',
                    status: 'failed',
                    updateId: lastSettingsUpdateStatus.timestamp
                });
            } else {
                // 其它未知状态
                return res.status(500).json({ 
                    error: '设置更新未知状态',
                    message: lastSettingsUpdateStatus.message || '未知错误',
                    status: lastSettingsUpdateStatus.status,
                    updateId: lastSettingsUpdateStatus.timestamp
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
        logger.error('提交更新配置任务失败:', error);
        res.status(500).json({ error: '提交更新配置任务失败' });
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