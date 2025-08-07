// frontend/js/main.js

import { state } from './state.js';
import { initializeAuth, checkAuthStatus, showLoginScreen, getAuthToken, getRandomCoverUrl } from './auth.js';
import { initializeRouter } from './router.js';
import { setupEventListeners } from './listeners.js';
import { fetchSettings } from './api.js';
import { showInitialLoadingState } from './loading-states.js';

async function initializeApp() {
    // 显示初始加载状态
    showInitialLoadingState();
    
    // 1. 初始化本地用户ID（同步操作，不阻塞）
    state.update('userId', initializeAuth());

    // 2. 设置所有事件监听器（同步操作，不阻塞）
    setupEventListeners();

    try {
        // 3. 并行执行认证状态检查和设置获取
        const [authStatus, token] = await Promise.all([
            checkAuthStatus().catch(error => {
                console.warn('认证状态检查失败:', error.message);
                return { passwordEnabled: false };
            }),
            Promise.resolve(getAuthToken())
        ]);
        
        // 4. 根据状态决定显示内容（减少重复请求）
        if (authStatus.passwordEnabled) {
            if (token) {
                // 已登录，直接进入应用
                document.getElementById('app-container').classList.add('opacity-100');
                document.getElementById('auth-overlay').classList.add('opacity-0', 'pointer-events-none');
                document.getElementById('content-grid').innerHTML = '';
                initializeRouter();
                
                // 异步获取设置，但优先使用本地设置
                fetchSettings().then(clientSettings => {
                    // 检查本地是否有更新的AI设置
                    const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
                    const shouldUseLocalAI = localAI.AI_ENABLED !== undefined;
                    
                    // 优先使用本地AI设置，如果没有则使用服务器设置
                    if (shouldUseLocalAI) {
                        state.update('aiEnabled', localAI.AI_ENABLED === 'true');
                    } else {
                        state.update('aiEnabled', clientSettings.AI_ENABLED === 'true');
                    }
                    
                    state.update('passwordEnabled', clientSettings.PASSWORD_ENABLED === 'true');
                }).catch(e => {
                    console.warn("无法在启动时获取设置:", e.message);
                    // 使用本地存储的设置
                    const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
                    state.update('aiEnabled', localAI.AI_ENABLED === 'true' || false);
                    state.update('passwordEnabled', false);
                });
            } else {
                // 需要登录，立即显示登录界面
                showLoginScreen();
            }
        } else {
            // 密码未启用，直接进入应用
            document.getElementById('app-container').classList.add('opacity-100');
            document.getElementById('auth-overlay').classList.add('opacity-0', 'pointer-events-none');
            document.getElementById('content-grid').innerHTML = '';
            initializeRouter();
            
            // 异步获取设置，但优先使用本地设置
            fetchSettings().then(clientSettings => {
                // 检查本地是否有更新的AI设置
                const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
                const shouldUseLocalAI = localAI.AI_ENABLED !== undefined;
                
                // 优先使用本地AI设置，如果没有则使用服务器设置
                if (shouldUseLocalAI) {
                    state.update('aiEnabled', localAI.AI_ENABLED === 'true');
                } else {
                    state.update('aiEnabled', clientSettings.AI_ENABLED === 'true');
                }
                
                state.update('passwordEnabled', clientSettings.PASSWORD_ENABLED === 'true');
            }).catch(e => {
                console.warn("无法在启动时获取设置:", e.message);
                // 使用本地存储的设置
                const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
                state.update('aiEnabled', localAI.AI_ENABLED === 'true' || false);
                state.update('passwordEnabled', false);
            });
        }
    } catch (error) {
        console.error('应用初始化失败:', error);
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