// frontend/js/auth.js

/**
 * 初始化用户身份认证。
 * 检查本地存储中是否存在用户ID，如果不存在，则创建一个新的UUID并存储。
 * @returns {string} 当前用户的唯一ID。
 */
export function initializeAuth() {
    let userId = localStorage.getItem('userId');
    if (!userId) {
        // 提供一个备用方案来确保兼容性
        const generateUUID = () => {
            if (window.crypto && window.crypto.randomUUID) {
                return window.crypto.randomUUID();
            }
            // 如果 crypto.randomUUID 不可用，使用一个简单的备用方法
            return Date.now().toString(36) + Math.random().toString(36).substring(2);
        };
        userId = generateUUID();
        localStorage.setItem('userId', userId);
    }
    return userId;
}
