// frontend/js/settings.js

import { state } from './state.js';
import { fetchSettings, saveSettings } from './api.js';

/**
 * 设置管理模块
 * 负责处理应用程序的设置界面、数据存储和用户交互
 */

// --- DOM元素 ---
const modal = document.getElementById('settings-modal');           // 设置模态框
const card = document.getElementById('settings-card');             // 设置卡片容器
const settingsTemplate = document.getElementById('settings-form-template'); // 设置表单模板

let initialSettings = {};  // 初始设置状态，用于检测变更

/**
 * AI配置本地存储工具
 * 用于在本地存储中保存和获取AI相关设置
 */
const AI_LOCAL_KEY = 'ai_settings';  // AI设置的本地存储键名

/**
 * 获取本地存储的AI设置
 * @returns {Object} AI设置对象
 */
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem(AI_LOCAL_KEY)) || {};
    } catch { return {}; }
}

/**
 * 保存AI设置到本地存储
 * @param {Object} obj - 要保存的AI设置对象
 */
function setLocalAISettings(obj) {
    localStorage.setItem(AI_LOCAL_KEY, JSON.stringify(obj || {}));
}

/**
 * AI提示词默认值
 * 定义AI对话的默认提示模板
 */
const DEFAULT_AI_PROMPT = `请你扮演这张照片中的人物，以第一人称的视角，对正在看照片的我说话。
你的任务是：
1.  仔细观察你的着装、姿态、表情和周围的环境。
2.  基于这些观察，构思一个符合你当前人设和心境的对话。
3.  你的话语可以是对我的邀请、提问，也可以是分享你此刻的感受或一个只属于我们之间的小秘密。
4.  语言风格要自然、有代入感，就像我们正在面对面交流。
5.  请直接开始对话，不要有任何前缀，比如“你好”或“嗨”。
6.  总字数控制在80字以内。
7.  中文回复。`;

// --- 核心模态框函数 ---
/**
 * 显示设置模态框
 * 加载设置数据并初始化设置界面
 */
export async function showSettingsModal() {
    // 显示加载状态
    card.innerHTML = `<div style="display:flex;justify-content:center;align-items:center;height:100%;"><div class="spinner" style="width:3rem;height:3rem;"></div></div>`;
    modal.classList.add('visible');
    
    try {
        // 获取服务器设置和本地AI设置
        const settings = await fetchSettings();
        const localAI = getLocalAISettings();
        
        // 合并设置，AI功能默认关闭
        settings.AI_ENABLED = (typeof localAI.AI_ENABLED !== 'undefined') ? localAI.AI_ENABLED : 'false';
        settings.AI_URL = localAI.AI_URL ?? ''; 
        settings.AI_MODEL = localAI.AI_MODEL ?? 'gemini-2.0-flash'; 
        settings.AI_PROMPT = localAI.AI_PROMPT ?? DEFAULT_AI_PROMPT; 
        settings.AI_KEY = '';

        // 保存初始设置并渲染表单
        initialSettings = { ...settings, ...localAI };
        card.innerHTML = settingsTemplate.innerHTML;
        requestAnimationFrame(() => {
            populateForm(settings);
            setupListeners();
        });
    } catch (error) {
        // 显示错误信息
        card.innerHTML = `<p style="color:var(--red-400);text-align:center;">加载失败: ${error.message}</p>`;
        console.error("加载设置失败:", error);
    }
}

/**
 * 关闭设置模态框
 * 移除可见状态并在过渡动画结束后清空内容
 */
function closeSettingsModal() {
    modal.classList.remove('visible');
    modal.addEventListener('transitionend', () => {
        card.innerHTML = '';
    }, { once: true });
}

// --- 表单与数据处理 ---
/**
 * 根据设置对象填充表单内容
 * @param {Object} settings - 设置数据对象
 */
function populateForm(settings) {
    card.querySelector('#password-enabled').checked = settings.PASSWORD_ENABLED === 'true';
    card.querySelector('#ai-enabled').checked = settings.AI_ENABLED === 'true';
    card.querySelector('#ai-url').value = settings.AI_URL || '';
    card.querySelector('#ai-key').value = '';
    card.querySelector('#ai-model').value = settings.AI_MODEL || '';
    card.querySelector('#ai-prompt').value = settings.AI_PROMPT || '';
    updateDynamicUI(settings.PASSWORD_ENABLED === 'true', settings.AI_ENABLED === 'true', settings.hasPassword);
}

/**
 * 根据当前开关状态动态显示/隐藏相关设置区域
 * @param {boolean} isPasswordEnabled - 是否启用密码
 * @param {boolean} isAiEnabled - 是否启用AI
 * @param {boolean} hasPassword - 是否已设置过密码
 */
function updateDynamicUI(isPasswordEnabled, isAiEnabled, hasPassword) {
    const passwordSettingsGroup = card.querySelector('#password-settings-group');
    const apiSettingsGroup = card.querySelector('#api-settings-group');
    const oldPasswordWrapper = card.querySelector('#old-password-wrapper');
    const newPasswordInput = card.querySelector('#new-password');

    if (passwordSettingsGroup) {
        passwordSettingsGroup.style.display = isPasswordEnabled ? 'block' : 'none';
    }
    if (apiSettingsGroup) {
        apiSettingsGroup.style.display = isAiEnabled ? 'block' : 'none';
    }

    if (isPasswordEnabled) {
        if (oldPasswordWrapper && newPasswordInput) {
            if (hasPassword) {
                oldPasswordWrapper.style.display = 'block';
                newPasswordInput.placeholder = '新密码';
            } else {
                oldPasswordWrapper.style.display = 'none';
                newPasswordInput.placeholder = '设置新密码';
            }
        }
    }
}

/**
 * 检查表单内容是否有变更，控制保存按钮状态
 */
function checkForChanges() {
    const saveBtn = card.querySelector('.save-btn');
    if (!saveBtn) return;
    const currentData = {
        PASSWORD_ENABLED: card.querySelector('#password-enabled').checked,
        AI_ENABLED: card.querySelector('#ai-enabled').checked,
        AI_URL: card.querySelector('#ai-url').value,
        AI_MODEL: card.querySelector('#ai-model').value,
        AI_PROMPT: card.querySelector('#ai-prompt').value,
    };
    let hasChanged = false;
    if (String(currentData.PASSWORD_ENABLED) !== String(initialSettings.PASSWORD_ENABLED === 'true') ||
        String(currentData.AI_ENABLED) !== String(initialSettings.AI_ENABLED === 'true') ||
        currentData.AI_URL !== initialSettings.AI_URL ||
        currentData.AI_MODEL !== initialSettings.AI_MODEL ||
        currentData.AI_PROMPT !== initialSettings.AI_PROMPT) {
        hasChanged = true;
    }
    if (card.querySelector('#new-password').value || card.querySelector('#old-password').value || card.querySelector('#ai-key').value) {
        hasChanged = true;
    }
    saveBtn.disabled = !hasChanged;
}

/**
 * 处理设置保存逻辑，包括本地AI设置和后端设置
 * 异步保存，处理表单校验和错误提示
 */
async function handleSave() {
    const saveBtn = card.querySelector('.save-btn');
    saveBtn.classList.add('loading');
    saveBtn.disabled = true;

    const oldPassInput = card.querySelector('#old-password');
    const newPassInput = card.querySelector('#new-password');
    oldPassInput.classList.remove('input-error');
    newPassInput.classList.remove('input-error');

    const isPasswordEnabled = card.querySelector('#password-enabled').checked;
    const newPasswordValue = newPassInput.value;

    // 校验：首次启用密码必须设置新密码
    if (isPasswordEnabled && !initialSettings.hasPassword && !newPasswordValue) {
        showNotification('请设置新密码以启用密码访问', 'error');
        card.querySelector('button[data-tab="security"]').click();
        newPassInput.focus();
        newPassInput.classList.add('input-error');
        saveBtn.classList.remove('loading');
        saveBtn.disabled = false;
        return;
    }

    // 组装本地AI设置
    const localAI = {
        AI_ENABLED: String(card.querySelector('#ai-enabled').checked),
        AI_URL: card.querySelector('#ai-url').value.trim(),
        AI_MODEL: card.querySelector('#ai-model').value.trim(),
        AI_PROMPT: card.querySelector('#ai-prompt').value.trim(),
    };
    const newApiKey = card.querySelector('#ai-key').value;
    if (newApiKey) {
        localAI.AI_KEY = newApiKey;
    } else {
        const oldAI = getLocalAISettings();
        if (oldAI.AI_KEY) localAI.AI_KEY = oldAI.AI_KEY;
    }
    setLocalAISettings(localAI);

    // 组装要发送到后端的设置
    const settingsToSend = {
        PASSWORD_ENABLED: String(isPasswordEnabled),
    };
    
    const oldPassword = oldPassInput.value;
    if (newPasswordValue) settingsToSend.newPassword = newPasswordValue;
    if (oldPassword) settingsToSend.oldPassword = oldPassword;

    try {
        const result = await saveSettings(settingsToSend);
        showNotification(result.message || '设置已成功保存！', 'success');
        state.aiEnabled = localAI.AI_ENABLED === 'true';
        state.passwordEnabled = settingsToSend.PASSWORD_ENABLED === 'true';
        setTimeout(closeSettingsModal, 500);
    } catch (error) {
        showNotification(error.message, 'error');
        if (error.message.includes('密码')) {
            if(error.message.includes('旧密码')) {
                oldPassInput.classList.add('input-error');
                oldPassInput.focus();
            } else {
                newPassInput.classList.add('input-error');
                newPassInput.focus();
            }
        }
        saveBtn.classList.remove('loading');
        checkForChanges();
    }
}

// --- 事件监听与交互 ---
/**
 * 设置界面所有事件监听器的初始化
 * 包括tab切换、保存、取消、输入变更等
 */
function setupListeners() {
    const nav = card.querySelector('.settings-nav');
    const panels = card.querySelectorAll('.settings-tab-content');
    const passwordEnabledToggle = card.querySelector('#password-enabled');
    const aiEnabledToggle = card.querySelector('#ai-enabled');
    const newPasswordInput = card.querySelector('#new-password');

    // tab切换
    nav.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        nav.querySelector('.active').classList.remove('active');
        panels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        card.querySelector(`#${btn.dataset.tab}-settings-content`).classList.add('active');
    });

    // 关闭与取消按钮
    card.querySelector('.close-btn').addEventListener('click', closeSettingsModal);
    card.querySelector('.cancel-btn').addEventListener('click', closeSettingsModal);
    card.querySelector('.save-btn').addEventListener('click', handleSave);

    // 输入变更检测
    card.querySelectorAll('input, textarea').forEach(el => {
        el.addEventListener('input', checkForChanges);
        el.addEventListener('change', checkForChanges);
    });

    // 新密码输入时去除错误样式
    if(newPasswordInput) {
        newPasswordInput.addEventListener('input', () => {
            newPasswordInput.classList.remove('input-error');
        });
    }

    // 密码开关逻辑
    passwordEnabledToggle.addEventListener('change', e => {
        const isChecked = e.target.checked;
        updateDynamicUI(isChecked, aiEnabledToggle.checked, initialSettings.hasPassword);

        // 已设置密码时关闭需二次验证
        if (!isChecked && initialSettings.hasPassword) {
            e.preventDefault();
            e.target.checked = true;
            updateDynamicUI(true, aiEnabledToggle.checked, initialSettings.hasPassword);
            
            showPasswordPrompt({
                onConfirm: async (password) => {
                    const saveBtn = card.querySelector('.save-btn');
                    saveBtn.classList.add('loading');
                    try {
                        await saveSettings({ oldPassword: password, PASSWORD_ENABLED: 'false' });
                        showNotification('访问密码已成功关闭', 'success');
                        initialSettings.PASSWORD_ENABLED = 'false';
                        initialSettings.hasPassword = false;
                        passwordEnabledToggle.checked = false;
                        updateDynamicUI(false, aiEnabledToggle.checked, false);
                        checkForChanges();
                        return true;
                    } catch (err) {
                        return false;
                    } finally {
                        saveBtn.classList.remove('loading');
                    }
                }
            });
        }
    });

    // AI开关逻辑
    aiEnabledToggle.addEventListener('change', e => {
        updateDynamicUI(passwordEnabledToggle.checked, e.target.checked, initialSettings.hasPassword);
    });

    setupPasswordToggles();
}

/**
 * 密码输入框显示/隐藏切换功能
 * 绑定眼睛图标点击事件
 */
function setupPasswordToggles() {
    const wrappers = card.querySelectorAll('.password-wrapper');
    wrappers.forEach(wrapper => {
        const input = wrapper.querySelector('input');
        const icon = wrapper.querySelector('.password-toggle-icon');
        if (!input || !icon) return;
        const openEye = icon.querySelector('.eye-open');
        const closedEye = icon.querySelector('.eye-closed');
        openEye.style.display = input.type === 'password' ? 'block' : 'none';
        closedEye.style.display = input.type === 'password' ? 'none' : 'block';
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            openEye.style.display = isPassword ? 'none' : 'block';
            closedEye.style.display = isPassword ? 'block' : 'none';
            const originalColor = icon.style.color;
            icon.style.color = 'white';
            setTimeout(() => {
                icon.style.color = originalColor || '';
            }, 200);
        });
    });
}

// --- 工具函数 ---
/**
 * 显示通知消息
 * @param {string} message - 消息内容
 * @param {string} type - 通知类型（success, error等）
 */
function showNotification(message, type = 'success') {
    const container = document.getElementById('notification-container');
    if (!container) return;
    const notification = document.createElement('div');
    notification.className = `notification show ${type}`;
    notification.innerHTML = `<span>${message}</span><button class="close-btn" aria-label="关闭">&times;</button>`;
    
    const closeBtn = notification.querySelector('.close-btn');
    const removeNotif = () => {
        notification.classList.remove('show');
        notification.addEventListener('transitionend', () => notification.remove(), { once: true });
    };
    
    if(closeBtn) {
        closeBtn.onclick = removeNotif;
    }
    
    setTimeout(removeNotif, 4000);
    
    container.appendChild(notification);
}

/**
 * 显示密码验证弹窗
 * @param {Object} param0 - 配置对象，包含onConfirm和onCancel回调
 */
function showPasswordPrompt({ onConfirm, onCancel }) {
    const template = document.getElementById('password-prompt-template');
    if (!template) return;
    const promptElement = template.content.cloneNode(true).firstElementChild;
    document.body.appendChild(promptElement);

    const cardEl = promptElement.querySelector('.password-prompt-card');
    const input = promptElement.querySelector('#prompt-password-input');
    const inputGroup = promptElement.querySelector('.input-group');
    const errorMsg = promptElement.querySelector('#prompt-error-message');
    const confirmBtn = promptElement.querySelector('.confirm-btn');
    const cancelBtn = promptElement.querySelector('.cancel-btn');
    const toggleBtn = promptElement.querySelector('.password-toggle-btn');

    /**
     * 关闭弹窗
     */
    const closePrompt = () => {
        promptElement.classList.remove('active');
        promptElement.addEventListener('transitionend', () => promptElement.remove(), { once: true });
        if (onCancel) onCancel();
    };

    requestAnimationFrame(() => {
        promptElement.classList.add('active');
        input.focus();
    });

    // 密码可见性切换
    toggleBtn.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        toggleBtn.querySelector('.eye-open').style.display = isPassword ? 'none' : 'block';
        toggleBtn.querySelector('.eye-closed').style.display = isPassword ? 'block' : 'none';
        input.focus();
    });

    // 确认按钮逻辑
    confirmBtn.addEventListener('click', async () => {
        inputGroup.classList.remove('error');
        errorMsg.textContent = '';
        cardEl.classList.remove('shake');
        if (!input.value) {
            errorMsg.textContent = '密码不能为空。';
            inputGroup.classList.add('error');
            cardEl.classList.add('shake');
            input.focus();
            return;
        }
        confirmBtn.classList.add('loading');
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
            const success = await onConfirm(input.value);
            if (success === true) {
                inputGroup.classList.add('success');
                confirmBtn.classList.remove('loading');
                setTimeout(closePrompt, 800);
            } else {
                throw new Error("密码错误或验证失败");
            }
        } catch (err) {
            confirmBtn.classList.remove('loading');
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            cardEl.classList.add('shake');
            inputGroup.classList.add('error');
            errorMsg.textContent = err.message || '密码错误或验证失败';
            input.focus();
            input.select();
        }
    });

    // 输入框事件
    input.addEventListener('input', () => {
        inputGroup.classList.remove('error');
        errorMsg.textContent = '';
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });
    cancelBtn.addEventListener('click', closePrompt);
    promptElement.addEventListener('click', (e) => { if (e.target === promptElement) closePrompt(); });
    
    // ESC键关闭弹窗
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closePrompt();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}