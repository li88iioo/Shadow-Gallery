// frontend/js/main.js

import { state } from './state.js';
import { initializeAuth, checkAuthStatus, showLoginScreen, showSetupScreen, getAuthToken, getRandomCoverUrl } from './auth.js';
import { initializeRouter } from './router.js';
import { setupEventListeners } from './listeners.js';
import { fetchSettings } from './api.js';

async function initializeApp() {
    // 1. 初始化本地用户ID
    state.userId = initializeAuth();

    // 2. 设置所有事件监听器
    setupEventListeners();

    try {
        // 3. 检查后端认证状态
        const authStatus = await checkAuthStatus();
        
        // 4. 检查本地是否存在Token
        const token = getAuthToken();
        
        // 启动时获取客户端设置 (如果不是首次设置且已登录)
        if (!authStatus.isInitialSetup && token) {
            try {
                const clientSettings = await fetchSettings();
                state.aiEnabled = clientSettings.AI_ENABLED === 'true';
                state.passwordEnabled = clientSettings.PASSWORD_ENABLED === 'true';
            } catch (e) {
                console.warn("无法在启动时获取设置:", e.message);
            }
        }

        // 5. 根据状态和Token决定显示内容
        if (authStatus.isInitialSetup) {
            showSetupScreen();
        } else if (authStatus.passwordEnabled) {
            if (token) {
                document.getElementById('app-container').classList.add('opacity-100');
                document.getElementById('auth-overlay').classList.add('opacity-0', 'pointer-events-none');
                initializeRouter();
            } else {
                // FIX: 立即显示登录界面，不再等待背景图
                showLoginScreen();
            }
        } else {
            // 如果密码未启用，也获取一下AI设置
            try {
                const clientSettings = await fetchSettings();
                state.aiEnabled = clientSettings.AI_ENABLED === 'true';
                state.passwordEnabled = clientSettings.PASSWORD_ENABLED === 'true';
            } catch(e) { /* an error is not critical here */ }
            
            document.getElementById('app-container').classList.add('opacity-100');
            document.getElementById('auth-overlay').classList.add('opacity-0', 'pointer-events-none');
            initializeRouter();
        }
    } catch (error) {
        // 如果后端连接失败
        const authContainer = document.getElementById('auth-container');
        const authOverlay = document.getElementById('auth-overlay');
        authContainer.innerHTML = `
            <div class="auth-card text-center">
                <h2 class="auth-title text-red-500">连接失败</h2>
                <p class="text-gray-300">无法连接到后端服务。请检查网络或服务状态。</p>
                <p class="text-gray-400 text-sm mt-2">${error.message}</p>
            </div>
        `;
        authOverlay.classList.add('opacity-100');
        authOverlay.classList.remove('pointer-events-none');
    }
}

// Service Worker 注册
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => console.log('ServiceWorker 注册成功，作用域: ', registration.scope))
            .catch(err => console.log('ServiceWorker 注册失败: ', err));
    });
}

// 应用启动
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    // 全局防止非输入区域出现输入光标
    document.addEventListener('focusin', function(e) {
        const tag = e.target.tagName.toLowerCase();
        if (
            tag !== 'input' &&
            tag !== 'textarea' &&
            !e.target.isContentEditable
        ) {
            e.target.blur();
        }
    });
});