// frontend/js/lazyload.js

import { state } from './state.js';
import { triggerMasonryUpdate } from './masonry.js';

// 这两个函数现在是模块内的私有函数，但会被下面的 setupLazyLoading 使用
function handleImageLoad(event) {
    const img = event.target;
    img.classList.add('loaded');
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
    triggerMasonryUpdate();
}

function handleImageError(event) {
    const img = event.target;
    img.onerror = null; // 防止错误循环
    img.src = '/assets/broken-image.svg'; // 确保路径正确
    img.classList.add('loaded');
    img.classList.remove('blurred');
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
}

async function loadThumbnailWithPolling(img, thumbnailUrl, retries = 10, delay = 2000) {
    if (retries <= 0) {
        console.error('Thumbnail load timeout:', thumbnailUrl);
        // 直接触发 img 元素的 error 事件
        img.dispatchEvent(new Event('error'));
        return;
    }
    try {
        const response = await fetch(thumbnailUrl);
        if (response.status === 200) {
            const imageBlob = await response.blob();
            // 设置 src 会触发 img 的 'load' 事件
            img.src = URL.createObjectURL(imageBlob);
        } else if (response.status === 202) {
            setTimeout(() => loadThumbnailWithPolling(img, thumbnailUrl, retries - 1, delay), delay);
        } else if (response.status === 429) {
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

function processThumbnailQueue() {
    while (state.activeThumbnailRequests < state.MAX_CONCURRENT_THUMBNAIL_REQUESTS && state.thumbnailRequestQueue.length > 0) {
        state.activeThumbnailRequests++;
        const { img, thumbnailUrl } = state.thumbnailRequestQueue.shift();
        loadThumbnailWithPolling(img, thumbnailUrl).finally(() => {
            state.activeThumbnailRequests--;
            processThumbnailQueue();
        });
    }
}

export function setupLazyLoading() {
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;

                // --- 核心修改在这里 ---
                // 在加载图片前，以编程方式绑定事件
                img.onload = handleImageLoad;
                img.onerror = handleImageError;
                // --- 修改结束 ---

                const dataSrc = img.dataset.src;
                if (dataSrc && !dataSrc.includes('undefined') && !dataSrc.includes('null')) {
                    state.thumbnailRequestQueue.push({ img, thumbnailUrl: dataSrc });
                    processThumbnailQueue();
                } else {
                    console.error('Lazy load failed: Invalid image URL:', dataSrc);
                    // 手动触发 error 事件来显示损坏的图片占位符
                    img.dispatchEvent(new Event('error'));
                }
                
                if (!img._noContextMenuBound) {
                    img.addEventListener('contextmenu', e => e.preventDefault());
                    img._noContextMenuBound = true;
                }
                if (state.isBlurredMode) img.classList.add('blurred');
                
                observer.unobserve(img);
            }
        });
    }, { rootMargin: '50px 0px', threshold: 0.01 });

    document.querySelectorAll('.lazy-image').forEach(img => {
        imageObserver.observe(img);
    });
}
