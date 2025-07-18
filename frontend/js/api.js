// frontend/js/api.js

import { state, elements } from './state.js';
import { showNotification } from './utils.js';
import { getAuthToken } from './auth.js';

/**
 * API 请求与数据交互模块
 * 负责与后端进行所有数据交互，包括设置、搜索、浏览、AI等
 */

/**
 * 通用fetch重试工具
 * 支持服务器错误/限流时自动重试
 * @param {string} url - 请求URL
 * @param {object} options - fetch选项
 * @param {number} retries - 最大重试次数
 * @param {number} delay - 重试延迟（毫秒）
 * @returns {Promise<Response>} fetch响应
 */
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if ((response.status >= 500 || response.status === 429) && i < retries - 1) {
                let retryDelay = delay * (i + 1);
                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    if (retryAfter) {
                        const after = Number(retryAfter);
                        if (!isNaN(after)) {
                            retryDelay = after * 1000;
                        } else {
                            const date = new Date(retryAfter);
                            if (!isNaN(date.getTime())) {
                                retryDelay = date.getTime() - Date.now();
                            }
                        }
                    }
                    console.warn(`429 Too Many Requests. Retrying in ${retryDelay}ms...`);
                } else {
                    console.warn(`Server error (${response.status}). Retrying in ${retryDelay}ms...`);
                }
                await new Promise(res => setTimeout(res, Math.max(retryDelay, 0)));
                continue;
            }
            return response;
        } catch (error) {
            if (i < retries - 1) {
                console.warn(`Fetch failed (network error). Retrying in ${delay * (i + 1)}ms...`);
                await new Promise(res => setTimeout(res, delay * (i + 1)));
                continue;
            }
            throw error;
        }
    }
}

/**
 * 获取认证请求头
 * 自动附加token和用户ID
 * @returns {object} 请求头对象
 */
function getAuthHeaders() {
    const token = getAuthToken();
    const headers = {
        'Content-Type': 'application/json',
        'X-User-ID': state.userId
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

// --- 设置相关API ---
/**
 * 获取全局设置
 * @returns {Promise<object>} 设置对象
 */
export async function fetchSettings() {
    const headers = getAuthHeaders();
    // For initial setup, we might not have a token
    if (!getAuthToken()) {
        delete headers.Authorization;
    }
    const response = await fetch('/api/settings', { headers });

    if (!response.ok) {
        if (response.status === 401) window.location.reload();
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || '无法获取设置');
    }
    return await response.json();
}

/**
 * 保存全局设置
 * @param {object} settingsData - 设置数据
 * @returns {Promise<object>} 保存结果
 */
export async function saveSettings(settingsData) {
    const headers = getAuthHeaders();
    // For initial setup, we might not have a token
    if (!getAuthToken()) {
        delete headers.Authorization;
    }
    const response = await fetch('/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify(settingsData)
    });

    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || '保存设置失败');
    }
    return result;
}
// --- END 设置API ---

// --- 搜索API ---
/**
 * 获取搜索结果
 * @param {string} query - 搜索关键词
 * @param {number} page - 页码
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<object>} 搜索结果
 */
export async function fetchSearchResults(query, page, signal) {
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}&limit=50`, {
            method: 'GET',
            headers: getAuthHeaders(),
            signal
        });
        if (!response.ok) throw new Error(`搜索失败: ${response.status}`);
        return await response.json();
    } catch (error) {
        if(error.name !== 'AbortError') showNotification(`搜索失败: ${error.message}`);
        throw error;
    }
}

// --- 浏览API ---
/**
 * 获取浏览结果
 * @param {string} path - 路径
 * @param {number} page - 页码
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<object>} 浏览结果
 */
export async function fetchBrowseResults(path, page, signal) {
    try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const headers = getAuthHeaders();
        if(path === '' && !getAuthToken()) {
            delete headers.Authorization;
        }
        
        const response = await fetch(`/api/browse/${encodedPath}?page=${page}&limit=50`, {
            method: 'GET',
            headers,
            signal
        });

        if (signal.aborted) return null;
        if (response.status === 401 && path !== '') {
             window.location.reload();
        }
        if (!response.ok) throw new Error(`服务器错误: ${response.status}`);
        return await response.json();
    } catch (error) {
        if (error.name !== 'AbortError') showNotification(`加载内容失败: ${error.message}`);
        throw error;
    }
}

/**
 * 上报已浏览相册/图片
 * @param {string} path - 路径
 */
export function postViewed(path) {
    if (!path) return;
    fetch('/api/browse/viewed', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ path }),
        keepalive: true
    }).catch(error => console.warn('更新浏览时间失败:', error));
}

// --- 获取随机缩略图 ---
/**
 * 获取随机缩略图URL
 * @returns {Promise<string|null>} 缩略图URL
 */
export async function fetchRandomThumbnail() {
    try {
        const data = await fetchBrowseResults('', 1, new AbortController().signal);
        const media = data.items.find(item => item.type === 'photo' || item.type === 'video');
        return media ? media.data.thumbnailUrl : null;
    } catch (error) {
        console.error("无法获取随机缩略图:", error);
        return null;
    }
}

// --- AI 标题生成 ---
/**
 * 读取本地AI设置
 * @returns {object} AI设置对象
 */
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem('ai_settings')) || {};
    } catch { return {}; }
}

/**
 * 生成图片AI标题
 * @param {string} imageUrl - 图片URL
 */
export async function generateImageCaption(imageUrl) {
    if (!state.aiEnabled) return; // 未启用AI时不执行任何AI相关逻辑
    const { captionContainer, captionContainerMobile } = elements;
    // 只有启用密码时才校验登录
    if (state.passwordEnabled && !getAuthToken()) {
        showNotification('需要登录才能使用 AI 功能', 'error');
        return;
    }
    const loadingHtml = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">她正在酝酿情绪，请稍候...</p></div>';
    captionContainer.innerHTML = loadingHtml;
    captionContainerMobile.innerHTML = '酝酿中...';
    try {
        const url = new URL(imageUrl, window.location.origin);
        const imagePath = url.pathname.startsWith('/static/') ? decodeURIComponent(url.pathname.substring(7)) : decodeURIComponent(url.pathname);
        // 读取本地AI配置
        const aiConfig = getLocalAISettings();
        // 校验
        if (!aiConfig.AI_URL || !aiConfig.AI_KEY || !aiConfig.AI_MODEL || !aiConfig.AI_PROMPT) {
            showNotification('请先在设置中填写完整的 AI 配置信息', 'error');
            captionContainer.textContent = 'AI 配置信息不完整';
            captionContainerMobile.textContent = 'AI 配置信息不完整';
            return;
        }
        const response = await fetch('/api/ai/generate', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_path: imagePath,
                aiConfig: {
                    url: aiConfig.AI_URL,
                    key: aiConfig.AI_KEY,
                    model: aiConfig.AI_MODEL,
                    prompt: aiConfig.AI_PROMPT
                }
            })
        });
        const data = await response.json();
        if (response.ok && data.source === 'cache') {
            captionContainer.textContent = data.description;
            captionContainerMobile.textContent = data.description;
            return;
        }
        if (response.status === 202) {
            pollJobStatus(data.jobId);
        } else {
            throw new Error(data.error || `服务器返回了非预期的状态: ${response.status}`);
        }
    } catch (error) {
        const errorMsg = `请求失败: ${error.message}`;
        captionContainer.textContent = errorMsg;
        captionContainerMobile.textContent = '生成失败';
        showNotification(`生成失败: ${error.message}`, 'error');
    }
}

/**
 * 轮询AI生成任务状态
 * @param {string} jobId - 任务ID
 */
function pollJobStatus(jobId) {
    if (state.currentAbortController) state.currentAbortController.abort();
    state.currentAbortController = new AbortController();
    const signal = state.currentAbortController.signal;
    const { captionContainer, captionContainerMobile } = elements;
    
    const intervalId = setInterval(async () => {
        try {
            const res = await fetch(`/api/ai/job/${jobId}`, { signal, headers: getAuthHeaders() });
            if (signal.aborted) {
                clearInterval(intervalId);
                return;
            }
            if (!res.ok) {
                clearInterval(intervalId);
                const errorMsg = '无法获取任务状态，请重试。';
                captionContainer.textContent = errorMsg;
                captionContainerMobile.textContent = '生成失败';
                return;
            }
            const data = await res.json();
            if (data.state === 'completed') {
                clearInterval(intervalId);
                if (data.result?.success) {
                    captionContainer.textContent = data.result.caption;
                    captionContainerMobile.textContent = data.result.caption;
                } else {
                    const reason = data.failedReason || 'AI Worker返回了失败的结果';
                    captionContainer.textContent = `生成失败: ${reason}`;
                    captionContainerMobile.textContent = '生成失败';
                }
            } else if (data.state === 'failed') {
                clearInterval(intervalId);
                const reason = data.failedReason || '未知错误';
                captionContainer.textContent = `生成失败: ${reason}`;
                captionContainerMobile.textContent = '生成失败';
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('轮询任务状态时发生错误:', error);
                captionContainer.textContent = '检查状态时发生网络错误。';
                captionContainerMobile.textContent = 'Failed';
            }
            clearInterval(intervalId);
        }
    }, 3000);

    setTimeout(() => {
        if (captionContainer.innerHTML.includes('spinner')) {
            captionContainer.textContent = '任务超时，请稍后重试。';
            captionContainerMobile.textContent = '任务超时';
        }
        clearInterval(intervalId)
    }, 120000);
}
