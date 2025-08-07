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
        
        const response = await fetch(thumbnailUrl, { headers });
        
        if (response.status === 200) {
            // 成功获取缩略图
            const imageBlob = await response.blob();
            img.src = URL.createObjectURL(imageBlob);
        } else if (response.status === 202) {
            // 服务器正在处理，稍后重试
            setTimeout(() => loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, delay), delay);
        } else if (response.status === 429) {
            // 限流处理，使用指数退避
            const backoffDelay = delay * 2 + (Math.random() * 1000);
            console.warn(`Rate limit hit (429), retrying in ${Math.round(backoffDelay / 1000)}s...`, thumbnailUrl);
            setTimeout(() => loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, backoffDelay), backoffDelay);
        } else {
            throw new Error(`Server responded with status: ${response.status}`);
        }
    } catch (error) {
        console.error('Polling for thumbnail failed:', error);
        setTimeout(() => loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, delay), delay);
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