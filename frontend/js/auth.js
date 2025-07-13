// frontend/js/auth.js

import { state } from './state.js';
import { initializeRouter } from './router.js';
// ✨ FIX: 从 api.js 导入，打破循环依赖
import { fetchSettings, saveSettings } from './api.js';

/**
 * 认证管理模块
 * 负责用户认证、登录界面、初始设置和令牌管理
 */

const AUTH_TOKEN_KEY = 'authToken';  // 认证令牌的本地存储键名

/**
 * 初始化用户认证
 * 检查本地存储中的用户ID，如果不存在则生成新的UUID
 * @returns {string} 用户的唯一ID
 */
export function initializeAuth() {
    let userId = localStorage.getItem('userId');
    if (!userId) {
        const generateUUID = () => (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).substring(2);
        userId = generateUUID();
        localStorage.setItem('userId', userId);
    }
    return userId;
}

/**
 * 检查后端的认证状态
 * @returns {Promise<{passwordEnabled: boolean, isInitialSetup: boolean}>} 认证状态对象
 */
export async function checkAuthStatus() {
    const response = await fetch('/api/auth/status');
    if (!response.ok) {
        if (response.status === 404) {
            return { passwordEnabled: false, isInitialSetup: true };
        }
        throw new Error(`Could not fetch auth status: ${response.status}`);
    }
    return await response.json();
}

/**
 * 显示登录界面
 * 渲染登录表单并设置背景图片
 */
export function showLoginScreen() {
    const authOverlay = document.getElementById('auth-overlay');
    const authContainer = document.getElementById('auth-container');
    const authBackground = document.getElementById('auth-background');

    // 重置背景样式
    authBackground.style.backgroundImage = '';
    authBackground.classList.remove('opacity-50');

    // 渲染登录表单
    authContainer.innerHTML = `
    <div class="login-card">
        <h2 class="auth-title">登录到 光影画廊</h2>
        <form id="login-form">
            <div class="password-wrapper mb-6">
                <input type="password" id="password" class="form-input" placeholder="密码" required>
                <span class="password-toggle-icon">
                    <svg class="eye-open" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    <svg class="eye-closed" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" style="display: none;"><path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                </span>
            </div>
            <button type="submit" class="btn btn-primary w-full">登录</button>
            <p id="login-error" class="text-red-400 text-center text-sm mt-4 min-h-[1.25rem]"></p>
        </form>
    </div>
    `;

    // 立即显示登录遮罩层
    authOverlay.classList.remove('opacity-0', 'pointer-events-none');
    authOverlay.classList.add('opacity-100');

    // 异步获取并设置背景图
    getRandomCoverUrl().then(backgroundUrl => {
        if (backgroundUrl) {
            authBackground.style.backgroundImage = `url(${backgroundUrl})`;
            authBackground.classList.add('opacity-50');
        }
    });

    document.getElementById('login-form').addEventListener('submit', handleLogin);
    setupPasswordToggle();
}

/**
 * 显示初始设置向导
 * 用于首次访问时的系统配置
 */
export function showSetupScreen() {
    const authOverlay = document.getElementById('auth-overlay');
    const authContainer = document.getElementById('auth-container');
    const settingsTemplate = document.getElementById('settings-form-template');
    
    // 使用设置模板渲染初始设置界面
    authContainer.innerHTML = `<div class="auth-card">${settingsTemplate.innerHTML}</div>`;
    authOverlay.classList.remove('opacity-0', 'pointer-events-none');
    authOverlay.classList.add('opacity-100');
    
    const form = authContainer.querySelector('#settings-form');
    form.querySelector('h2').textContent = '欢迎，请完成初始设置';
    form.querySelector('#settings-cancel-btn').style.display = 'none';

    // 设置默认值：启用AI，禁用密码
    document.getElementById('ai-enabled').checked = true;
    document.getElementById('password-enabled').checked = false;
    toggleAIFields(true);
    togglePasswordFields(false);

    // 处理设置表单提交
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const saveButton = form.querySelector('#settings-save-btn');
        saveButton.disabled = true;
        saveButton.textContent = '正在保存...';

        const formData = new FormData(form);
        const settings = Object.fromEntries(formData.entries());
        settings.AI_ENABLED = form.querySelector('#ai-enabled').checked;
        settings.PASSWORD_ENABLED = form.querySelector('#password-enabled').checked;

        try {
            await saveSettings(settings);
            window.location.reload();
        } catch (error) {
            alert(`Save failed: ${error.message}`);
            saveButton.disabled = false;
            saveButton.textContent = '保存设置';
        }
    });

    setupSettingsToggles();
}

/**
 * 处理登录表单提交
 * @param {Event} e - 表单提交事件
 */
async function handleLogin(e) {
    e.preventDefault();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');
    const loginButton = e.target.querySelector('button');
    const originalButtonText = loginButton.textContent;
    
    // 重置错误信息并设置加载状态
    errorEl.textContent = '';
    loginButton.disabled = true;
    loginButton.textContent = '登录中...';

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await response.json();
        
        if (!response.ok || !data.success) {
            // 登录失败时的抖动动画效果
            const loginCard = document.querySelector('.login-card');
            if (loginCard) {
                loginCard.classList.remove('shake'); // 先移除，防止连续触发无效
                void loginCard.offsetWidth; // 触发重绘，确保动画能重新播放
                loginCard.classList.add('shake');
                loginCard.addEventListener('animationend', () => {
                    loginCard.classList.remove('shake');
                }, { once: true });
            }
            throw new Error(data.error || 'Login failed');
        }
        
        // 登录成功，保存令牌并隐藏登录界面
        setAuthToken(data.token);
        
        const authOverlay = document.getElementById('auth-overlay');
        authOverlay.classList.remove('opacity-100');
        authOverlay.classList.add('opacity-0', 'pointer-events-none');
        
        const appContainer = document.getElementById('app-container');
        appContainer.classList.add('opacity-100');
        
        initializeRouter();

    } catch (error) {
        errorEl.textContent = error.message;
        loginButton.disabled = false;
        loginButton.textContent = originalButtonText;
    }
}   

// --- 辅助函数 ---

/**
 * 设置密码输入框的显示/隐藏切换
 */
function setupPasswordToggle() {
    const wrapper = document.querySelector('.password-wrapper');
    if (!wrapper) return;
    
    const icon = wrapper.querySelector('.password-toggle-icon');
    const input = wrapper.querySelector('input');
    const openEye = icon.querySelector('.eye-open');
    const closedEye = icon.querySelector('.eye-closed');
    
    // 初始化眼睛图标状态
    openEye.style.display = 'block';
    closedEye.style.display = 'none';
    
    icon.addEventListener('click', (e) => {
        e.stopPropagation();
        
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        
        openEye.style.display = isPassword ? 'none' : 'block';
        closedEye.style.display = isPassword ? 'block' : 'none';
        
        // 点击时的视觉反馈
        const originalColor = icon.style.color;
        icon.style.color = 'white';
        
        setTimeout(() => {
            icon.style.color = originalColor || '';
        }, 200);
    });
}

/**
 * 设置设置页面的开关事件监听
 */
export function setupSettingsToggles() {
    const aiEnabledToggle = document.getElementById('ai-enabled');
    const passwordEnabledToggle = document.getElementById('password-enabled');

    if(aiEnabledToggle) {
        aiEnabledToggle.addEventListener('change', (e) => toggleAIFields(e.target.checked));
    }
    if(passwordEnabledToggle) {
        passwordEnabledToggle.addEventListener('change', (e) => togglePasswordFields(e.target.checked));
    }
}

/**
 * 切换AI相关字段的显示状态
 * @param {boolean} isEnabled - 是否启用AI功能
 */
export function toggleAIFields(isEnabled) {
    const fields = document.getElementById('ai-fields');
    if (fields) fields.style.display = isEnabled ? 'block' : 'none';
}

/**
 * 切换密码相关字段的显示状态
 * @param {boolean} isEnabled - 是否启用密码功能
 */
export function togglePasswordFields(isEnabled) {
    const fields = document.getElementById('password-fields');
    if (fields) fields.style.display = isEnabled ? 'block' : 'none';
}

/**
 * 保存认证令牌到本地存储
 * @param {string} token - 认证令牌
 */
export function setAuthToken(token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
}

/**
 * 从本地存储获取认证令牌
 * @returns {string|null} 认证令牌
 */
export function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY);
}

/**
 * 从本地存储移除认证令牌
 */
export function removeAuthToken() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
}

/**
 * 获取随机封面图片URL
 * 用于登录界面的背景图片
 * @returns {Promise<string|null>} 随机封面URL
 */
export async function getRandomCoverUrl() {
    try {
        const res = await fetch('/api/albums/covers');
        if (!res.ok) return null; // 如果请求失败则直接返回
        const covers = await res.json();
        if (Array.isArray(covers) && covers.length > 0) {
            const idx = Math.floor(Math.random() * covers.length);
            return covers[idx];
        }
    } catch (e) {
        console.error("Failed to get random cover", e);
    }
    return null;
}