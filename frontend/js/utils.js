// frontend/js/utils.js

/**
 * 显示通知消息
 * @param {string} message - 要显示的消息内容
 * @param {string} type - 通知类型 ('info', 'success', 'warning', 'error')
 * @param {number} duration - 自动消失时间（毫秒）
 */
export function showNotification(message, type = 'info', duration = 3000) {
    // 获取或创建通知容器
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        document.body.appendChild(container);
    }
    
    // 创建通知元素
    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    notif.innerHTML = `
        <span>${message}</span>
        <button class="close-btn" aria-label="关闭">&times;</button>
    `;
    container.appendChild(notif);

    // 动画显示
    setTimeout(() => notif.classList.add('show'), 10);

    // 自动消失逻辑
    let hideTimeout = setTimeout(remove, duration);
    notif.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
    notif.addEventListener('mouseleave', () => hideTimeout = setTimeout(remove, duration));

    // 手动关闭按钮
    notif.querySelector('.close-btn').onclick = remove;

    // 移除通知的函数
    function remove() {
        notif.classList.remove('show');
        setTimeout(() => notif.remove(), 300);
    }
}

/**
 * 预加载下一批图片
 * @param {Array} currentPhotos - 当前照片数组
 * @param {number} startIndex - 当前显示的起始索引
 */
export function preloadNextImages(currentPhotos, startIndex) {
    // 获取需要预加载的图片（当前索引后的2张图片）
    const toPreload = currentPhotos.slice(startIndex + 1, startIndex + 3);
    
    // 遍历预加载列表，排除视频文件
    toPreload.forEach(url => {
        if (url && !/\.(mp4|webm|mov)$/i.test(url)) {
            const img = new Image();
            img.src = url;
        }
    });
}