import { showNotification } from './utils.js';
import { getAuthToken } from './auth.js';

let eventSource = null;
let retryCount = 0;
const MAX_RETRY_DELAY = 60000; // 最大重连延迟: 60秒

/**
 * 建立到后端的 SSE 连接，包含自动重连和认证逻辑
 */
function connect() {
    if (eventSource) {
        eventSource.close();
    }

    const token = getAuthToken();
    // 如果需要认证，则将 token 作为查询参数传递
    const url = token ? `/api/events?token=${token}` : '/api/events';

    eventSource = new EventSource(url);

    eventSource.onopen = () => {
        retryCount = 0;
    };

    eventSource.onerror = (err) => {
        // 可选：静默错误，避免污染控制台
        eventSource.close();
        const delay = Math.min(MAX_RETRY_DELAY, 1000 * Math.pow(2, retryCount));
        retryCount++;
        // console.debug(`[SSE] Connection lost. Retrying in ${delay / 1000} seconds...`);
        setTimeout(connect, delay);
    };

    eventSource.addEventListener('connected', (e) => {
        const data = JSON.parse(e.data);
    });

    eventSource.addEventListener('thumbnail-generated', (e) => {
        try {
            const data = JSON.parse(e.data);
            if (!data || !data.path) return;

            const imagePath = data.path;
            const imagesToUpdate = document.querySelectorAll(`img[data-src*="${encodeURIComponent(imagePath)}"]`);

            if (imagesToUpdate.length > 0) {
                imagesToUpdate.forEach(img => {
                    if (img.classList.contains('loaded')) return;

                    console.log(`[SSE] Received thumbnail for ${imagePath}. Updating image via fetch.`);
                    
                    // 使用 fetch 和 blob URL 来处理需要认证的图片
                    const thumbnailUrl = img.dataset.src;
                    const token = getAuthToken();
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

                    fetch(thumbnailUrl, { headers })
                        .then(response => {
                            if (response.ok) {
                                return response.blob();
                            }
                            throw new Error(`Failed to fetch thumbnail via SSE event: ${response.statusText}`);
                        })
                        .then(blob => {
                            img.src = URL.createObjectURL(blob);
                        })
                        .catch(error => {
                            console.error(error);
                            img.dispatchEvent(new Event('error'));
                        });
                });
            }
        } catch (error) {
            console.error('[SSE] Error processing thumbnail-generated event:', error);
        }
    });
}

/**
 * 初始化 SSE 服务
 */
export function initializeSSE() {
    connect();
}
