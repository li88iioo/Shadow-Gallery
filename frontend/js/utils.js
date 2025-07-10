// frontend/js/utils.js

export function showNotification(message, type = 'error') {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.className = `fixed top-5 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-md text-white z-[1000] opacity-0 transition-opacity duration-500 ${type === 'error' ? 'bg-red-600' : 'bg-green-600'}`;
    document.body.appendChild(notification);
    setTimeout(() => notification.classList.remove('opacity-0'), 10);
    setTimeout(() => {
        notification.classList.add('opacity-0');
        notification.addEventListener('transitionend', () => notification.remove());
    }, 3000);
}

export function preloadNextImages(currentPhotos, startIndex) {
    const toPreload = currentPhotos.slice(startIndex + 1, startIndex + 3);
    toPreload.forEach(url => {
        if (url && !/\.(mp4|webm|mov)$/i.test(url)) {
            const img = new Image();
            img.src = url;
        }
    });
}