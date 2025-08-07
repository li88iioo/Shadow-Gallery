// frontend/js/main.js

import { state } from './state.js';
import { initializeAuth, checkAuthStatus, showLoginScreen, getAuthToken, getRandomCoverUrl } from './auth.js';
import { initializeRouter } from './router.js';
import { setupEventListeners } from './listeners.js';
import { fetchSettings } from './api.js';
import { showInitialLoadingState } from './loading-states.js';

async function initializeApp() {
    // 初始化基础组件
    state.update('userId', initializeAuth());
    setupEventListeners();
    
    try {
        // 显示加载状态
        showAppState({
            title: '正在连接后端服务...',
            subtitle: '系统启动中，请稍候'
        });
        
        // 等待后端就绪
        console.log('等待后端服务就绪...');
        const backendReady = await waitForBackendWithRetry();
        if (!backendReady) {
            showAppState({
                type: 'error',
                title: '连接失败',
                subtitle: '无法连接到后端服务，请稍后重试',
                showInApp: false,
                showRefreshBtn: true
            });
            return;
        }
        
        // 检查认证状态
        const [authStatus, token] = await Promise.all([
            checkAuthStatus().catch(error => {
                console.warn('认证状态检查失败:', error.message);
                return { passwordEnabled: false };
            }),
            Promise.resolve(getAuthToken())
        ]);
        
        // 根据认证状态显示内容
        if (authStatus.passwordEnabled && !token) {
            showAuth();
            showLoginScreen();
        } else {
            startMainApp();
        }
    } catch (error) {
        console.error('应用初始化失败:', error);
        showAppState({
            type: 'error',
            title: '初始化失败',
            subtitle: '应用启动时发生错误，请刷新重试',
            showInApp: false,
            showRefreshBtn: true,
            errorMessage: error.message
        });
    }
}

/**
 * 启动主应用
 */
function startMainApp() {
    showApp();
    showInitialLoadingState();
    initializeRouter();
    loadAppSettings();
}

/**
 * 显示应用并隐藏认证层
 */
function showApp() {
    document.getElementById('app-container').classList.add('opacity-100');
    document.getElementById('auth-overlay').classList.add('opacity-0', 'pointer-events-none');
}

/**
 * 隐藏应用并显示认证层
 */
function showAuth() {
    document.getElementById('app-container').classList.remove('opacity-100');
    document.getElementById('app-container').classList.add('opacity-0');
    document.getElementById('auth-overlay').classList.remove('opacity-0', 'pointer-events-none');
    document.getElementById('auth-overlay').classList.add('opacity-100');
}

/**
 * 通用状态显示函数
 * @param {Object} options - 配置选项
 */
function showAppState(options = {}) {
    const {
        type = 'loading', // 'loading', 'error', 'progress'
        title = '',
        subtitle = '',
        showInApp = true, // true: 显示在app区域, false: 显示在auth区域
        progress = null, // { current: 1, total: 6 }
        errorMessage = '',
        showRefreshBtn = false
    } = options;
    
    // 选择显示区域
    if (showInApp) {
        showApp();
        const contentGrid = document.getElementById('content-grid');
        if (!contentGrid) return;
        
        let progressHTML = '';
        if (progress && type === 'progress') {
            const percentage = (progress.current / progress.total) * 100;
            progressHTML = `
                <p class="text-gray-500 text-sm mt-2">尝试连接 ${progress.current}/${progress.total}</p>
                <div class="w-48 bg-gray-700 rounded-full h-2 mt-3 mx-auto">
                    <div class="bg-purple-500 h-2 rounded-full transition-all duration-300" 
                         style="width: ${percentage}%"></div>
                </div>
            `;
        }
        
        contentGrid.innerHTML = `
            <div class="flex items-center justify-center min-h-[60vh]">
                <div class="text-center">
                    <div class="spinner mx-auto mb-4"></div>
                    <p class="text-gray-400 text-lg">${title}</p>
                    ${subtitle ? `<p class="text-gray-500 text-sm mt-2">${subtitle}</p>` : ''}
                    ${progressHTML}
                </div>
            </div>
        `;
    } else {
        showAuth();
        const authContainer = document.getElementById('auth-container');
        if (!authContainer) return;
        
        const isError = type === 'error';
        authContainer.innerHTML = `
            <div class="auth-card text-center">
                <h2 class="auth-title ${isError ? 'text-red-500' : ''}">${title}</h2>
                <p class="text-gray-300">${subtitle}</p>
                ${showRefreshBtn ? '<button id="refresh-btn" class="btn btn-primary mt-4">刷新页面</button>' : ''}
                ${errorMessage ? `<p class="text-gray-400 text-sm mt-2">${errorMessage}</p>` : ''}
            </div>
        `;
        
        if (showRefreshBtn) {
            document.getElementById('refresh-btn')?.addEventListener('click', () => {
                window.location.reload();
            });
        }
    }
}

/**
 * 加载应用设置
 */
async function loadAppSettings() {
    try {
        const clientSettings = await fetchSettings();
        const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
        
        // 优先使用本地AI设置
        if (localAI.AI_ENABLED !== undefined) {
            state.update('aiEnabled', localAI.AI_ENABLED === 'true');
        } else {
            state.update('aiEnabled', clientSettings.AI_ENABLED === 'true');
        }
        
        state.update('passwordEnabled', clientSettings.PASSWORD_ENABLED === 'true');
    } catch (e) {
        console.warn("无法获取设置:", e.message);
        const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
        state.update('aiEnabled', localAI.AI_ENABLED === 'true' || false);
        state.update('passwordEnabled', false);
    }
}

/**
 * 等待后端服务就绪
 * @returns {Promise<boolean>} 后端是否就绪
 */
async function waitForBackendWithRetry() {
    const maxAttempts = 6;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`检查后端服务 (尝试 ${attempt}/${maxAttempts})`);
            showAppState({
                type: 'progress',
                title: '正在连接后端服务...',
                progress: { current: attempt, total: maxAttempts }
            });
            
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 2000);
            
            const response = await fetch('/api/auth/status', {
                signal: controller.signal,
                cache: 'no-cache'
            });
            
            if (response.ok) {
                console.log('后端服务就绪');
                return true;
            }
        } catch (error) {
            if (attempt === maxAttempts) {
                console.error('后端服务未就绪');
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return false;
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