// frontend/js/api.js

import { state, elements } from './state.js';
import { showNotification } from './utils.js';

// --- 新增：用于重试的 fetch 辅助函数 ---
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            // 仅在服务器错误（5xx）时重试
            if (response.status >= 500 && i < retries - 1) {
                console.warn(`服务器错误 (${response.status})。${delay * (i + 1)}ms 后重试...`);
                await new Promise(res => setTimeout(res, delay * (i + 1)));
                continue;
            }
            return response;
        } catch (error) {
            // 网络错误时重试
            if (i < retries - 1) {
                console.warn(`Fetch 失败（网络错误）。${delay * (i + 1)}ms 后重试...`);
                await new Promise(res => setTimeout(res, delay * (i + 1)));
                continue;
            }
            throw error;
        }
    }
}


// --- 搜索 ---
export async function fetchSearchResults(query, page) {
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}&limit=50`, {
            method: 'GET'
        });
        if (!response.ok) {
            throw new Error(`搜索失败: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        showNotification(`搜索失败: ${error.message}`);
        throw error;
    }
}

// --- 浏览 ---
export async function fetchBrowseResults(path, page, signal) {
    try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const response = await fetch(`/api/browse/${encodedPath}?page=${page}&limit=50`, {
            method: 'GET',
            signal,
            headers: {
                'X-User-ID': state.userId
            }
        });

        if (signal.aborted) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`服务器错误: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        if (error.name !== 'AbortError') {
            showNotification(`加载内容失败: ${error.message}`);
        }
        throw error; // 重新抛出错误以便调用方捕获
    }
}

export function postViewed(path) {
    if (!path) return;
    fetch('/api/browse/viewed', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-User-ID': state.userId
        },
        body: JSON.stringify({ path }),
        keepalive: true // 允许请求在页面关闭后继续
    }).catch(error => {
        console.warn('更新浏览时间失败:', error);
    });
}

// --- AI 描述生成 ---
export async function generateImageCaption(imageUrl) {
    const { captionContainer, captionContainerMobile } = elements;
    const loadingHtml = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">她正在酝酿情绪，请稍候...</p></div>';
    captionContainer.innerHTML = loadingHtml;
    captionContainerMobile.innerHTML = '酝酿中...';

    try {
        const url = new URL(imageUrl, window.location.origin);
        const imagePath = url.pathname.startsWith('/static/') ? decodeURIComponent(url.pathname.substring(7)) : decodeURIComponent(url.pathname);

        const response = await fetchWithRetry('/api/ai/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_path: imagePath })
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

function pollJobStatus(jobId) {
    if (state.currentAbortController) state.currentAbortController.abort();
    state.currentAbortController = new AbortController();
    const signal = state.currentAbortController.signal;
    const { captionContainer, captionContainerMobile } = elements;

    const intervalId = setInterval(async () => {
        try {
            const res = await fetch(`/api/ai/job/${jobId}`, { signal });
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