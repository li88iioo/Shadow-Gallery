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
        // 等待后端就绪（这里会智能显示连接状态）
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
    
    // 清空内容区域并直接启动路由器
    const contentGrid = document.getElementById('content-grid');
    if (contentGrid) {
        contentGrid.innerHTML = '';
    }
    
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
        type = 'loading', // 'loading', 'error', 'progress', 'connecting'
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
 * 等待后端服务就绪（智能检测，只在必要时显示连接状态）
 * @returns {Promise<boolean>} 后端是否就绪
 */
async function waitForBackendWithRetry() {
    const totalTimeout = 30000; // 30秒总超时
    const checkInterval = 1000;  // 每1秒检查一次
    const startTime = Date.now();
    let attemptCount = 0;
    const maxAttempts = Math.floor(totalTimeout / checkInterval);
    let hasShownConnectingState = false;
    let consecutiveFailures = 0;
    const minWaitTime = 3000; // 最小等待时间3秒，超过这个时间才考虑显示连接状态
    
    // 首先尝试快速连接（不显示状态）
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2秒快速检测
        
        const response = await fetch('/api/auth/status', {
            signal: controller.signal,
            cache: 'no-cache',
            headers: {
                'X-Request-Type': 'health-check'
            }
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const responseTime = Date.now() - startTime;
            console.log(`后端服务连接成功，耗时: ${responseTime}ms`);
            return true;
        }
    } catch (error) {
        // 快速检测失败，继续重试
        consecutiveFailures++;
        console.warn('快速连接检测失败，开始重试:', error.message);
    }
    
    // 如果快速检测失败，开始重试并可能显示连接状态
    while (Date.now() - startTime < totalTimeout) {
        attemptCount++;
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒单次请求超时
            
            const response = await fetch('/api/auth/status', {
                signal: controller.signal,
                cache: 'no-cache',
                headers: {
                    'X-Request-Type': 'health-check'
                }
            });
            
            clearTimeout(timeoutId);
            
            if (response.ok) {
                const responseTime = Date.now() - startTime;
                console.log(`后端服务连接成功，耗时: ${responseTime}ms`);
                return true;
            } else {
                consecutiveFailures++;
            }
        } catch (error) {
            consecutiveFailures++;
            
            // 只有在连续失败3次且等待时间超过3秒后才显示连接状态
            const elapsedTime = Date.now() - startTime;
            if (!hasShownConnectingState && consecutiveFailures >= 3 && elapsedTime >= minWaitTime) {
                hasShownConnectingState = true;
                showBackendConnectingState();
            }
            
            // 记录错误但不中断重试
            if (error.name === 'AbortError') {
                console.warn(`连接检测超时 (尝试 ${attemptCount}/${maxAttempts})`);
            } else {
                console.warn(`连接检测失败 (尝试 ${attemptCount}/${maxAttempts}):`, error.message);
            }
        }
        
        // 如果还有时间，继续重试
        if (Date.now() - startTime < totalTimeout - checkInterval) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
    }
    
    // 如果超时了但还没显示过连接状态，现在显示
    if (!hasShownConnectingState) {
        showBackendConnectingState();
    }
    
    console.error(`后端服务未就绪，${totalTimeout/1000}秒超时，共尝试 ${attemptCount} 次`);
    return false;
}

/**
 * 显示后端连接状态（带动画和进度信息）
 */
function showBackendConnectingState() {
    // 使用现代化的连接状态（从 loading-states.js）
    import('./loading-states.js').then(module => {
        module.showBackendConnectingState('正在建立安全连接', '系统启动中，请稍候片刻...');
    }).catch(error => {
        console.warn('无法加载现代化连接状态，使用备用方案');
        // 确保显示在app区域
        showApp();
        const contentGrid = document.getElementById('content-grid');
        if (contentGrid) {
            contentGrid.innerHTML = `
                <div class="flex items-center justify-center min-h-[60vh]">
                    <div class="text-center">
                        <div class="spinner mx-auto mb-4"></div>
                        <p class="text-gray-400 text-lg">正在建立安全连接</p>
                        <p class="text-gray-500 text-sm mt-2">系统启动中，请稍候片刻...</p>
                    </div>
                </div>
            `;
        }
    });
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