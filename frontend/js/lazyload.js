// frontend/js/lazyload.js

import { state } from './state.js';
import { AbortBus } from './abort-bus.js';
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
    // 统一中止thumb分组，确保并发fetch也被打断
    AbortBus.abort('thumb');
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
        
        const groupSignal = AbortBus.get('thumb');
        const signal = groupSignal || img._thumbAbortController.signal;
        let response;
        try {
            response = await fetch(thumbnailUrl, { headers, signal });
        } catch (err) {
            // Firefox/Chromium 在布局/滚动时可能抛出 NS_BINDING_ABORTED，快速抖动重试一次
            if ((err && (err.name === 'AbortError' || /NS_BINDING_ABORTED/i.test(String(err.message)))) && retries > 0) {
                const jitter = 200 + Math.random() * 300;
                const timerId = setTimeout(() => {
                    if (!img.isConnected || img._pollingCancelled) return;
                    loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, delay);
                }, jitter);
                if (!img._pollTimers) img._pollTimers = new Set();
                img._pollTimers.add(timerId);
                return; // 本轮终止，交给后续重试
            }
            throw err;
        }
        
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
        // 主动取消（如路由切换、元素移除）会触发 AbortError：不视为错误，也不再重试
        if (error && (error.name === 'AbortError' || error.code === 20)) {
            console.debug('Thumbnail polling aborted:', thumbnailUrl);
            cleanupPolling(img);
            return;
        }
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
        const { img, thumbnailUrl } = state.thumbnailRequestQueue.shift();
        if (!img || img._pollingCancelled || !img.isConnected) {
            // 跳过已被取消或已移除的任务
            continue;
        }
        state.activeThumbnailRequests++;
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

                    // 预取下一屏：找到同列后续若干张图片的 URL，加入低优先级预热
                    try {
                        const allImages = Array.from(document.querySelectorAll('.lazy-image'));
                        const startIndex = allImages.indexOf(img) + 1;
                        const prefetchTargets = allImages.slice(startIndex, startIndex + 6);
                        prefetchTargets.forEach(nextImg => {
                            if (!nextImg || nextImg.src || !nextImg.dataset || !nextImg.dataset.src) return;
                            if (nextImg._prefetched) return;
                            nextImg._prefetched = true;
                            const controller = new AbortController();
                            nextImg._prefetchAbort = controller;
                            const _token = getAuthToken();
                            const _headers = _token ? { 'Authorization': `Bearer ${_token}` } : {};
                            fetch(nextImg.dataset.src, { method: 'GET', cache: 'force-cache', headers: _headers, signal: controller.signal })
                                .catch(() => {})
                                .finally(() => { nextImg._prefetchAbort = null; });
                        });
                    } catch {}
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
        // 提前距离略增，结合并发限流避免抖动
        rootMargin: '200px 0px',
        threshold: 0.01
    });

    // 观察所有懒加载图片
    document.querySelectorAll('.lazy-image').forEach(img => {
        // 防止重复绑定
        if (!img._observed) {
            imageObserver.observe(img);
            img._observed = true;
        }
    });

    // 首屏兜底：10秒内未加载成功/失败的图片，强制触发一次轮询加载
    setTimeout(() => {
        document.querySelectorAll('.lazy-image').forEach(img => {
            if (img && !img.classList.contains('loaded') && img.dataset && img.dataset.src) {
                // 未加载成功也未触发错误，强制加入队列重试一次
                if (!img._pollingCancelled) {
                    state.thumbnailRequestQueue.push({ img, thumbnailUrl: img.dataset.src });
                    processThumbnailQueue();
                }
            }
        });
    }, 10000);
}

// 页面隐藏时，统一中止轮询与挂起的请求（避免切换标签页浪费资源）
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelAllThumbnailPolling();
});