// frontend/js/lazyload.js

import { state } from './state.js';
import { triggerMasonryUpdate } from './masonry.js';
import { getAuthToken } from './auth.js';

/**
 * 懒加载管理模块
 * 负责处理图片的懒加载、缩略图加载、错误处理和瀑布流布局更新
 */

/**
 * 图片加载成功处理函数
 * 移除占位符、添加加载完成样式、触发瀑布流更新
 * @param {Event} event - 图片加载事件
 */
function handleImageLoad(event) {
    const img = event.target;
    img.classList.add('loaded');
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
    // 成功后清理轮询与控制器
    cleanupPolling(img);
    triggerMasonryUpdate();
}

/**
 * 图片加载失败处理函数
 * 显示损坏图片占位符、移除模糊效果
 * @param {Event} event - 图片错误事件
 */
function handleImageError(event) {
    const img = event.target;
    img.onerror = null; // 防止错误循环
    img.src = '/assets/broken-image.svg'; // 确保路径正确
    img.classList.add('loaded');
    img.classList.remove('blurred');
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
    // 失败后也清理轮询与控制器
    cleanupPolling(img);
}

/**
 * 取消并清理某个图片元素的缩略图轮询/控制器/定时器
 * @param {HTMLImageElement} img
 */
function cleanupPolling(img) {
    if (!img) return;
    img._pollingCancelled = true;
    if (img._thumbAbortController) {
        try { img._thumbAbortController.abort(); } catch {}
        img._thumbAbortController = null;
    }
    if (img._pollTimers) {
        img._pollTimers.forEach(id => clearTimeout(id));
        img._pollTimers.clear();
    }
}

/**
 * 统一取消当前页面所有懒加载图片的轮询
 */
function cancelAllThumbnailPolling() {
    document.querySelectorAll('.lazy-image').forEach(img => cleanupPolling(img));
}

/**
 * 带轮询的缩略图加载函数
 * 处理服务器异步生成缩略图的情况，支持重试和限流处理
 * @param {HTMLImageElement} img - 图片元素
 * @param {string} thumbnailUrl - 缩略图URL
 * @param {number} retries - 重试次数
 * @param {number} delay - 重试延迟（毫秒）
 */
async function loadThumbnailWithPolling(img, thumbnailUrl, retries = 10, delay = 2000) {
    // 检查URL有效性，避免处理data URI
    if (!thumbnailUrl || thumbnailUrl.startsWith('data:')) {
        img.dispatchEvent(new Event('error'));
        return;
    }

    // 重试次数耗尽，触发错误
    if (retries <= 0) {
        console.error('Thumbnail load timeout:', thumbnailUrl);
        img.dispatchEvent(new Event('error'));
        return;
    }
    
    try {
        // 获取认证令牌
        const token = getAuthToken();
        const headers = {};
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        // 初始化/复用 AbortController 与定时器集合
        if (!img._thumbAbortController) img._thumbAbortController = new AbortController();
        if (!img._pollTimers) img._pollTimers = new Set();
        img._pollingCancelled = false;
        
        const response = await fetch(thumbnailUrl, { headers, signal: img._thumbAbortController.signal });
        
        if (response.status === 200) {
            // 成功获取缩略图
            const imageBlob = await response.blob();
            img.src = URL.createObjectURL(imageBlob);
            cleanupPolling(img);
        } else if (response.status === 202) {
            // 服务器正在处理，稍后重试
            if (!img.isConnected || img._pollingCancelled) return;
            const timerId = setTimeout(() => {
                if (!img.isConnected || img._pollingCancelled) return;
                loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, delay);
            }, delay);
            img._pollTimers.add(timerId);
        } else if (response.status === 429) {
            // 限流处理，使用指数退避
            const backoffDelay = delay * 2 + (Math.random() * 1000);
            console.warn(`Rate limit hit (429), retrying in ${Math.round(backoffDelay / 1000)}s...`, thumbnailUrl);
            if (!img.isConnected || img._pollingCancelled) return;
            const timerId = setTimeout(() => {
                if (!img.isConnected || img._pollingCancelled) return;
                loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, backoffDelay);
            }, backoffDelay);
            img._pollTimers.add(timerId);
        } else {
            throw new Error(`Server responded with status: ${response.status}`);
        }
    } catch (error) {
        console.error('Polling for thumbnail failed:', error);
        if (!img.isConnected || img._pollingCancelled) return;
        const timerId = setTimeout(() => {
            if (!img.isConnected || img._pollingCancelled) return;
            loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, delay);
        }, delay);
        if (!img._pollTimers) img._pollTimers = new Set();
        img._pollTimers.add(timerId);
    }
}

/**
 * 处理缩略图请求队列
 * 控制并发请求数量，避免过多请求影响性能
 */
function processThumbnailQueue() {
    while (state.activeThumbnailRequests < state.MAX_CONCURRENT_THUMBNAIL_REQUESTS && state.thumbnailRequestQueue.length > 0) {
        state.activeThumbnailRequests++;
        const { img, thumbnailUrl } = state.thumbnailRequestQueue.shift();
        
        // 加载完成后减少活跃请求数并处理队列中的下一个
        loadThumbnailWithPolling(img, thumbnailUrl).finally(() => {
            state.activeThumbnailRequests--;
            processThumbnailQueue();
        });
    }
}

/**
 * 设置懒加载功能
 * 使用Intersection Observer监听图片可见性，实现懒加载
 */
export function setupLazyLoading() {
    // 创建交叉观察器，监听图片进入视口
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;

                // 绑定图片加载事件处理器
                img.onload = handleImageLoad;
                img.onerror = handleImageError;

                // 获取懒加载的图片URL
                const dataSrc = img.dataset.src;
                if (dataSrc && !dataSrc.includes('undefined') && !dataSrc.includes('null')) {
                    // 将请求加入队列
                    // 开始前重置取消标志
                    img._pollingCancelled = false;
                    state.thumbnailRequestQueue.push({ img, thumbnailUrl: dataSrc });
                    processThumbnailQueue();
                } else {
                    console.error('Lazy load failed: Invalid image URL:', dataSrc);
                    // 手动触发错误事件显示损坏图片占位符
                    img.dispatchEvent(new Event('error'));
                }
                
                // 禁用右键菜单
                if (!img._noContextMenuBound) {
                    img.addEventListener('contextmenu', e => e.preventDefault());
                    img._noContextMenuBound = true;
                }
                
                // 应用模糊模式
                if (state.isBlurredMode) img.classList.add('blurred');
                
                // 停止观察已处理的图片
                observer.unobserve(img);
            }
        });
    }, { 
        rootMargin: '200px 0px', // 增加提前加载距离到200px
        threshold: 0.01          // 1%可见时触发
    });

    // 观察所有懒加载图片
    document.querySelectorAll('.lazy-image').forEach(img => {
        imageObserver.observe(img);
    });
}

// 路由切换或页面隐藏时，统一中止轮询与挂起的请求
window.addEventListener('hashchange', cancelAllThumbnailPolling);
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelAllThumbnailPolling();
});