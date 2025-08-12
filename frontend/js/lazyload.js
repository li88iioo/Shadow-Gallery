import { state } from './state.js';
import { AbortBus } from './abort-bus.js';
import { triggerMasonryUpdate } from './masonry.js';
import { getAuthToken } from './auth.js';

/**
 * 图片加载成功处理函数
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
 * @param {Event} event - 图片错误事件
 */
function handleImageError(event) {
    const img = event.target;
    img.onerror = null; // 防止错误循环
    img.src = '/assets/broken-image.svg';
    img.classList.add('loaded', 'error');
    img.classList.remove('blurred');
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
}

/**
 * 为懒加载图片发起一次性加载请求
 * 不再轮询，而是依赖 SSE 事件来处理正在生成的缩略图
 * @param {HTMLImageElement} img - 图片元素
 */
async function requestLazyImage(img) {
    const thumbnailUrl = img.dataset.src;
    if (!thumbnailUrl || thumbnailUrl.includes('undefined') || thumbnailUrl.includes('null')) {
        console.error('Lazy load failed: Invalid image URL:', thumbnailUrl);
        img.dispatchEvent(new Event('error'));
        return;
    }

    // 如果已完成加载，或已有真实 src（非 data: 与非 blob:），则不重复请求
    if (img.classList.contains('loaded')) return;
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) return;

    try {
        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const signal = AbortBus.get('thumb'); // 使用全局 AbortBus 来取消请求

        const response = await fetch(thumbnailUrl, { headers, signal });

        if (response.status === 200) {
            // 成功获取，直接加载
            const imageBlob = await response.blob();
            img.src = URL.createObjectURL(imageBlob);
        } else if (response.status === 202) {
            // 正在处理中，什么都不做，等待 SSE 事件
            console.log(`[LazyLoad] Thumbnail for ${thumbnailUrl} is processing. Waiting for SSE event.`);
        } else {
            // 其他错误状态
            throw new Error(`Server responded with status: ${response.status}`);
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Failed to fetch lazy-load image:', thumbnailUrl, error);
            img.dispatchEvent(new Event('error'));
        }
    }
}

/**
 * 设置懒加载功能
 * 使用 Intersection Observer 监听图片可见性
 */
export function setupLazyLoading() {
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;

                img.onload = handleImageLoad;
                img.onerror = handleImageError;

                requestLazyImage(img);

                if (!img._noContextMenuBound) {
                    img.addEventListener('contextmenu', e => e.preventDefault());
                    img._noContextMenuBound = true;
                }
                
                if (state.isBlurredMode) img.classList.add('blurred');
                
                observer.unobserve(img);
            }
        });
    }, {
        rootMargin: '200px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.lazy-image').forEach(img => {
        if (!img._observed) {
            imageObserver.observe(img);
            img._observed = true;
        }
    });
}
