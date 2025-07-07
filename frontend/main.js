// --- App State & API Config ---
const API_BASE = ''; 
let currentPhotos = []; 
let currentPhotoIndex = 0; 
let isModalNavigating = false; 
let isBlurredMode = false;
let captionDebounceTimer = null; 
let currentAbortController = null; 
let currentObjectURL = null; 
let scrollPositions = new Map(); 
let preSearchHash = '#/'; 
let searchDebounceTimer = null; 
let hasShownNavigationHint = false;
let lastWheelTime = 0;
let uiVisibilityTimer = null; 
let activeBackdrop = 'one';
const backdrops = {
    one: document.getElementById('modal-backdrop-one'),
    two: document.getElementById('modal-backdrop-two')
};
// --- Thumbnail Request Queue ---
const thumbnailRequestQueue = [];
let activeThumbnailRequests = 0;
const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 6;

// --- Search & Browse State ---
let isSearchLoading = false;
let currentSearchPage = 1;
let totalSearchPages = 1;
let currentSearchQuery = '';
let isBrowseLoading = false;
let currentBrowsePage = 1;
let totalBrowsePages = 1;
let currentBrowsePath = null;
let currentColumnCount = 0;

// --- Element Selections ---
const contentGrid = document.getElementById('content-grid');
const loadingIndicator = document.getElementById('loading');
const breadcrumbNav = document.getElementById('breadcrumb-nav');
const modal = document.getElementById('modal');
const modalBackdrop = document.querySelector('.modal-backdrop');
const modalContent = document.getElementById('modal-content');
const modalImg = document.getElementById('modal-img');
const modalVideo = document.getElementById('modal-video');
const modalClose = document.getElementById('modal-close');
const captionContainer = document.getElementById('caption-container');
const captionContainerMobile = document.getElementById('caption-container-mobile');
const captionBubble = document.getElementById('caption-bubble');
const captionBubbleWrapper = document.getElementById('caption-bubble-wrapper');
const toggleCaptionBtn = document.getElementById('toggle-caption-btn');
const navigationHint = document.getElementById('navigation-hint');
const mediaPanel = document.getElementById('media-panel');


// --- Masonry Layout ---
function getMasonryColumns() {
    const width = window.innerWidth;
    if (width >= 1536) return 6;
    if (width >= 1280) return 5;
    if (width >= 1024) return 4;
    if (width >= 768) return 3;
    if (width >= 640) return 2;
    return 1;
}
function applyMasonryLayout() {
    if (!contentGrid.classList.contains('masonry-mode')) return;
    const items = Array.from(contentGrid.children);
    if (items.length === 0) return;
    const numColumns = getMasonryColumns();
    const columnHeights = Array(numColumns).fill(0);
    const columnGap = 16;
    items.forEach(item => {
        const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
        const originalWidth = parseFloat(item.dataset.width) || 1;
        const originalHeight = parseFloat(item.dataset.height) || 1;
        const itemHeight = (originalHeight / originalWidth) * itemWidth;
        const minColumnIndex = columnHeights.indexOf(Math.min(...columnHeights));
        item.style.position = 'absolute';
        item.style.width = `${itemWidth}px`;
        item.style.height = `${itemHeight}px`;
        item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
        item.style.top = `${columnHeights[minColumnIndex]}px`;
        columnHeights[minColumnIndex] += itemHeight + columnGap;
    });
    contentGrid.style.height = `${Math.max(...columnHeights)}px`;
}

// --- Utility Functions ---
function showNotification(message, type = 'error') {
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

function preloadNextImages(startIndex) {
    const toPreload = currentPhotos.slice(startIndex + 1, startIndex + 3);
    toPreload.forEach(url => {
        if (url && !/\.(mp4|webm|mov)$/i.test(url)) {
            const img = new Image();
            img.src = url;
        }
    });
}

// --- Thumbnail Loading ---
function processThumbnailQueue() {
    while (activeThumbnailRequests < MAX_CONCURRENT_THUMBNAIL_REQUESTS && thumbnailRequestQueue.length > 0) {
        activeThumbnailRequests++;
        const { img, thumbnailUrl } = thumbnailRequestQueue.shift();
        loadThumbnailWithPolling(img, thumbnailUrl).finally(() => {
            activeThumbnailRequests--;
            processThumbnailQueue();
        });
    }
}

async function loadThumbnailWithPolling(img, thumbnailUrl, retries = 10, delay = 2000) {
    if (retries <= 0) {
        console.error('Thumbnail load timeout:', thumbnailUrl);
        handleImageError(img);
        return;
    }
    try {
        const response = await fetch(thumbnailUrl);
        if (response.status === 200) {
            const imageBlob = await response.blob();
            img.src = URL.createObjectURL(imageBlob);
            handleImageLoad(img);
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

// --- Lazy Loading ---
function setupLazyLoading() {
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                const dataSrc = img.dataset.src;
                if (dataSrc && !dataSrc.includes('undefined') && !dataSrc.includes('null')) {
                    thumbnailRequestQueue.push({ img, thumbnailUrl: dataSrc });
                    processThumbnailQueue();
                } else {
                    console.error('Lazy load failed: Invalid image URL:', dataSrc);
                    handleImageError(img);
                }
                if (!img._noContextMenuBound) {
                    img.addEventListener('contextmenu', e => e.preventDefault());
                    img._noContextMenuBound = true;
                }
                if (isBlurredMode) img.classList.add('blurred');
                observer.unobserve(img);
            }
        });
    }, { rootMargin: '50px 0px', threshold: 0.01 });
    document.querySelectorAll('.lazy-image').forEach(img => {
        imageObserver.observe(img);
        if (!img._noContextMenuBound) {
            img.addEventListener('contextmenu', e => e.preventDefault());
            img._noContextMenuBound = true;
        }
        if (isBlurredMode) img.classList.add('blurred');
    });
}

// --- Image Load/Error Handling ---
function handleImageLoad(img) {
    img.classList.add('loaded');
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
}

function handleImageError(img) {
    img.onerror = null;
    img.src = '/broken-image.svg';
    img.classList.add('loaded');
    img.classList.remove('blurred');
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
}

// --- Routing & Data Fetching ---
async function handleHashChange() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const cleanPath = cleanHashString.substring(1).replace(/^\//, '');

    if (cleanPath === currentBrowsePath && currentBrowsePath !== null) {
        return;
    }

    window.removeEventListener('scroll', handleScroll);
    window.removeEventListener('scroll', handleBrowseScroll);

    const newHash = cleanHashString || '#/';

    if (newHash.startsWith('#/search?q=')) {
        if (!currentBrowsePath.startsWith('search?q=')) {
            preSearchHash = currentBrowsePath ? `#/${currentBrowsePath}` : '#/';
        }
    }

    const hash = newHash.substring(1).replace(/^\//, '');

    currentBrowsePath = hash;

    if (hash.startsWith('search?q=')) {
        const urlParams = new URLSearchParams(hash.substring(hash.indexOf('?')));
        const query = urlParams.get('q');
        executeSearch(decodeURIComponent(query || ''));
    } else {
        streamPath(decodeURIComponent(hash));
    }
}

function performSearch(query) {

    window.location.hash = `/search?q=${encodeURIComponent(query)}`;
}

async function executeSearch(query) {
    contentGrid.innerHTML = '';
    contentGrid.classList.remove('masonry-mode');
    contentGrid.style.height = 'auto';
    currentPhotos = [];
    currentSearchQuery = query;
    currentSearchPage = 1;
    totalSearchPages = 1;
    isSearchLoading = false;
    window.addEventListener('scroll', handleScroll);
    document.getElementById('infinite-scroll-loader').classList.add('hidden');
    loadingIndicator.classList.remove('hidden');
    await fetchSearchResults();
    loadingIndicator.classList.add('hidden');
}

async function fetchSearchResults() {
    if (isSearchLoading || currentSearchPage > totalSearchPages) return;
    isSearchLoading = true;
    const loader = document.getElementById('infinite-scroll-loader');
    if (currentSearchPage > 1) loader.classList.remove('hidden');
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(currentSearchQuery)}&page=${currentSearchPage}&limit=50`);
        if (!response.ok) throw new Error(`搜索失败: ${response.status}`);
        const data = await response.json();
        totalSearchPages = data.totalPages;
        if (currentSearchPage === 1) {
            breadcrumbNav.innerHTML = `
               <div class="flex items-center">
                   <a href="${preSearchHash}" class="flex items-center text-purple-400 hover:text-purple-300 transition-colors duration-200 group">
                       <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform">
                           <line x1="19" y1="12" x2="5" y2="12"></line>
                           <polyline points="12 19 5 12 12 5"></polyline>
                       </svg>
                       返回
                   </a>
                   ${data.results.length > 0 ? `
                       <span class="mx-3 text-gray-600">/</span>
                       <span class="text-white">搜索结果: "${data.query}" (${data.totalResults}项)</span>
                   ` : ''}
               </div>
           `;
           if (data.results.length === 0) {
               contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">没有找到相关结果。</p>';
               return;
           }
       }

        let contentHtml = '';
        let newMediaUrls = [];
        data.results.forEach(result => {
            if (result.type === 'album') {
                contentHtml += displayAlbum(result);
            } else if (result.type === 'photo' || result.type === 'video') {
                const mediaIndex = currentPhotos.length + newMediaUrls.length;
                contentHtml += displaySearchMedia(result, mediaIndex);
                newMediaUrls.push(result.originalUrl);
            }
        });
        contentGrid.insertAdjacentHTML('beforeend', contentHtml);
        currentPhotos = currentPhotos.concat(newMediaUrls);
        setupLazyLoading();
        currentSearchPage++;
    } catch (error) {
        showNotification(`搜索失败: ${error.message}`);
    } finally {
        isSearchLoading = false;
        loader.classList.add('hidden');
        if (currentSearchPage > totalSearchPages) window.removeEventListener('scroll', handleScroll);
    }
}

async function streamPath(path) {
    const previousPath = currentBrowsePath;
    if (typeof previousPath === 'string') scrollPositions.set(previousPath, window.scrollY);
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    contentGrid.innerHTML = '';
    contentGrid.classList.remove('masonry-mode');
    contentGrid.style.height = 'auto';
    currentPhotos = [];
    isBrowseLoading = false;
    currentBrowsePath = path || '';
    currentBrowsePage = 1;
    totalBrowsePages = 1;
    renderBreadcrumb(currentBrowsePath);
    window.removeEventListener('scroll', handleBrowseScroll);
    window.addEventListener('scroll', handleBrowseScroll);
    document.getElementById('infinite-scroll-loader').classList.add('hidden');
    loadingIndicator.classList.remove('hidden');
    const albumToHighlight = sessionStorage.getItem('highlightNext');
    const highlightParent = sessionStorage.getItem('highlightParent');
    let highlightInfo = null;
    if (albumToHighlight && highlightParent === currentBrowsePath) {
        highlightInfo = albumToHighlight;
        sessionStorage.removeItem('highlightNext');
        sessionStorage.removeItem('highlightParent');
    }
    await fetchBrowseResults(highlightInfo);
    loadingIndicator.classList.add('hidden');
    if (!highlightInfo && scrollPositions.has(currentBrowsePath)) {
        window.scrollTo(0, scrollPositions.get(currentBrowsePath));
        scrollPositions.delete(currentBrowsePath);
    }
}

async function fetchBrowseResults(albumToHighlightPath = null) {
    if (isBrowseLoading || currentBrowsePage > totalBrowsePages) return;
    isBrowseLoading = true;
    const loader = document.getElementById('infinite-scroll-loader');
    if (currentBrowsePage > 1 && currentBrowsePage <= totalBrowsePages) loader.classList.remove('hidden');
    else loader.classList.add('hidden');
    const signal = currentAbortController.signal;
    try {
        const response = await fetch(`/api/browse?page=${currentBrowsePage}&limit=50`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: currentBrowsePath }), signal });
        if (signal.aborted) return;
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const data = await response.json();
        totalBrowsePages = data.totalPages;
        if (currentBrowsePage === 1 && data.items.length === 0) {
            contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">这个文件夹是空的。</p>';
            return;
        }
        if (currentBrowsePage === 1 && data.items.length > 0) {
            if (data.items.some(item => item.type === 'album')) contentGrid.classList.remove('masonry-mode');
            else contentGrid.classList.add('masonry-mode');
        }
        let contentHtml = '';
        let newMediaUrls = [];
        data.items.forEach(item => {
            const itemData = item.data;
            if (item.type === 'album') {
                contentHtml += displayAlbum(itemData);
            } else {
                const mediaIndex = currentPhotos.length + newMediaUrls.length;
                contentHtml += displayStreamedMedia(item.type, itemData, mediaIndex);
                newMediaUrls.push(itemData.originalUrl);
            }
        });
        contentGrid.insertAdjacentHTML('beforeend', contentHtml);
        currentPhotos = currentPhotos.concat(newMediaUrls);
        setupLazyLoading();
        if (signal.aborted) return;
        
        applyMasonryLayout();

        if (currentBrowsePage === 1) {
            currentColumnCount = getMasonryColumns();
        }
        
        if (albumToHighlightPath) {
            const albumElement = document.querySelector(`[data-album-path="${albumToHighlightPath}"]`);
            if (albumElement) {
                albumElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                albumElement.classList.add('highlight-album');
                setTimeout(() => albumElement.classList.remove('highlight-album'), 1500);
            }
        }
        currentBrowsePage++;
    } catch (error) {
        if (error.name !== 'AbortError') showNotification(`加载内容失败: ${error.message}`);
    } finally {
        isBrowseLoading = false;
        if (currentBrowsePage > totalBrowsePages) {
            loader.classList.add('hidden');
            window.removeEventListener('scroll', handleBrowseScroll);
        } else {
            loader.classList.add('hidden');
        }
    }
}

function handleBrowseScroll() {
    if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) fetchBrowseResults();
}

function handleScroll() {
    if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) fetchSearchResults();
}

// --- UI Rendering ---
function renderBreadcrumb(path) {
    const parts = path ? path.split('/').filter(p => p) : [];
    let currentPath = '';
    const homeLink = `<a href="#/" onclick="this.blur()" class="text-purple-400 hover:text-purple-300">首页</a>`;
    const pathLinks = parts.map((part, index) => {
        currentPath += (currentPath ? '/' : '') + part;
        const isLast = index === parts.length - 1;
        return isLast ? `<span class="text-white">${decodeURIComponent(part)}</span>` : `<a href="#/${encodeURIComponent(currentPath)}" onclick="this.blur()" class="text-purple-400 hover:text-purple-300">${decodeURIComponent(part)}</a>`;
    });
    breadcrumbNav.innerHTML = [homeLink, ...pathLinks].join('<span class="mx-2">/</span>');
}

function displayAlbum(album) {
    const aspectRatio = album.coverHeight ? album.coverWidth / album.coverHeight : 1;
    return `<div class="grid-item"><a href="#/${encodeURIComponent(album.path)}" onclick="navigateToAlbum(event, '${album.path}')" class="album-card group block bg-gray-800 rounded-lg overflow-hidden shadow-lg hover:shadow-purple-500/30 transition-shadow" data-album-path="${album.path}"><div class="relative" style="aspect-ratio: ${aspectRatio};"><div class="image-placeholder absolute inset-0"></div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${album.coverUrl}" alt="${album.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300" onerror="handleImageError(this)" onload="handleImageLoad(this)"></div><div class="p-2 sm:p-4"><h3 class="font-bold text-sm sm:text-lg truncate group-hover:text-purple-300">📁 ${album.name}</h3></div></a></div>`;
}

function displayStreamedMedia(type, mediaData, index) {
    const isVideo = type === 'video';
    return `<div class="grid-item" data-width="${mediaData.width}" data-height="${mediaData.height}"><div class="photo-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer" onclick="handleThumbnailClick(this, '${mediaData.originalUrl}', ${index})"><div class="relative w-full h-full"><div class="image-placeholder absolute inset-0"></div><div class="loading-overlay"><svg class="progress-circle" viewBox="0 0 20 20"><circle class="progress-circle-track" cx="10" cy="10" r="8" stroke-width="2"></circle><circle class="progress-circle-bar" cx="10" cy="10" r="8" stroke-width="2"></circle></svg></div>${isVideo ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="Video Thumbnail" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300" onerror="handleImageError(this)" onload="handleImageLoad(this)"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="Photo" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300" onerror="handleImageError(this)" onload="handleImageLoad(this)">`}</div></div></div>`;
}

function displaySearchMedia(result, index) {
    const isVideo = result.type === 'video';
    return `<div class="grid-item"><div class="photo-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer" onclick="handleThumbnailClick(this, '${result.originalUrl}', ${index})"><div class="aspect-w-1 aspect-h-1 relative"><div class="image-placeholder absolute inset-0"></div><div class="loading-overlay"><svg class="progress-circle" viewBox="0 0 20 20"><circle class="progress-circle-track" cx="10" cy="10" r="8" stroke-width="2"></circle><circle class="progress-circle-bar" cx="10" cy="10" r="8" stroke-width="2"></circle></svg></div>${isVideo ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${result.thumbnailUrl}" alt="Video Thumbnail: ${result.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300" onerror="handleImageError(this)" onload="handleImageLoad(this)"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${result.thumbnailUrl}" alt="${result.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300" onerror="handleImageError(this)" onload="handleImageLoad(this)">`}</div></div><div class="mt-2"><p class="text-xs text-gray-400 truncate">${result.name}</p></div></div>`;
}

window.navigateToAlbum = function(event, albumPath) {
    event.preventDefault();
    if (document.activeElement) document.activeElement.blur();
    const currentAlbumElement = event.currentTarget;
    const parent = currentAlbumElement.parentElement;
    let nextSibling = parent.nextElementSibling;
    while(nextSibling && !nextSibling.querySelector('.album-card')) nextSibling = nextSibling.nextElementSibling;
    if (nextSibling) {
        const nextAlbumCard = nextSibling.querySelector('.album-card');
        if (nextAlbumCard) {
            sessionStorage.setItem('highlightNext', nextAlbumCard.dataset.albumPath);
            sessionStorage.setItem('highlightParent', currentBrowsePath);
        }
    }
    window.location.hash = `/${encodeURIComponent(albumPath)}`;
};

// --- Modal & AI Logic ---
async function generateImageCaption(imageUrl) {
    const loadingHtml = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">她正在酝酿情绪，请稍候...</p></div>';
    captionContainer.innerHTML = loadingHtml;
    captionContainerMobile.innerHTML = '酝酿中...';
    try {
        const url = new URL(imageUrl, window.location.origin);
        const imagePath = url.pathname.startsWith('/static/') ? decodeURIComponent(url.pathname.substring(7)) : decodeURIComponent(url.pathname);
        const response = await fetch('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_path: imagePath }) });
        const data = await response.json();
        if (response.ok && data.source === 'cache') {
            captionContainer.textContent = data.description;
            captionContainerMobile.textContent = data.description;
            return;
        }
        if (response.status === 202) {
            pollJobStatus(data.jobId);
        } else {
            throw new Error(data.error || '派发AI任务失败');
        }
    } catch (error) {
        const errorMsg = `请求失败: ${error.message}`;
        captionContainer.textContent = errorMsg;
        captionContainerMobile.textContent = '生成失败';
        showNotification(`生成失败: ${error.message}`, 'error');
    }
}

function pollJobStatus(jobId) {
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
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
                    captionContainer.textContent = `Generation failed: ${reason}`;
                    captionContainerMobile.textContent = 'Failed';
                }
            } else if (data.state === 'failed') {
                clearInterval(intervalId);
                const reason = data.failedReason || '未知错误';
                captionContainer.textContent = `Generation failed: ${reason}`;
                captionContainerMobile.textContent = 'Failed';
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Error polling job status:', error);
                captionContainer.textContent = '检查状态时发生网络错误。';
                captionContainerMobile.textContent = 'Failed';
            }
            clearInterval(intervalId);
        }
    }, 3000);
    setTimeout(() => clearInterval(intervalId), 120000);
}

function closeModal() {
    if (window.location.hash.endsWith('#modal')) {
        window.history.back();
    } else {
        document.documentElement.classList.remove('modal-open');
        document.body.classList.remove('modal-open');
        modal.classList.add('opacity-0', 'pointer-events-none');
        modalImg.src = '';
        modalVideo.pause();
        modalVideo.src = '';
        backdrops.one.style.backgroundImage = 'none';
        backdrops.two.style.backgroundImage = 'none';
        if (currentObjectURL) {
            URL.revokeObjectURL(currentObjectURL);
            currentObjectURL = null;
        }
        captionBubble.classList.remove('show');
        if (document.activeElement) {
            document.activeElement.blur();
        }
    }
}

function updateModalContent(mediaSrc, index, originalPathForAI) {
    currentPhotoIndex = index;
    modalVideo.pause();
    modalVideo.src = '';
    const isVideo = /\.(mp4|webm|mov)$/i.test(mediaSrc);

    toggleCaptionBtn.style.display = isVideo ? 'none' : 'flex';
    modalVideo.classList.toggle('hidden', !isVideo);
    modalImg.classList.toggle('hidden', isVideo);
    if (isVideo) {
        navigationHint.classList.remove('show-hint');
        navigationHint.style.display = 'none';
        modalVideo.src = mediaSrc;
        modalVideo.play().catch(e => {
            console.error("视频播放失败:", e);
            showNotification('视频无法自动播放。', 'error');
        });
        captionBubble.classList.remove('show');
    } else {
        navigationHint.style.display = 'flex';
        modalImg.src = mediaSrc; // 只更新前景图
        if (!modalImg._noContextMenuBound) {
            modalImg.addEventListener('contextmenu', e => e.preventDefault());
            modalImg._noContextMenuBound = true;
        }
        clearTimeout(captionDebounceTimer);
        captionDebounceTimer = setTimeout(() => generateImageCaption(originalPathForAI), 300);
        captionContainer.innerHTML = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">酝酿中...</p></div>';
        captionContainerMobile.innerHTML = '酝酿中...';
    }
    preloadNextImages(index);
}

let activeLoader = null;
async function handleThumbnailClick(element, mediaSrc, index) {
    const photoItem = element.closest('.photo-item');
    if (photoItem.classList.contains('is-loading')) return;
    if (mediaSrc.match(/\.(mp4|webm|mov)$/i)) {
        openModal(mediaSrc, index, false, mediaSrc);
        return;
    }
    
    if (activeLoader) activeLoader.abort();
    const progressCircle = photoItem.querySelector('.progress-circle-bar');
    const radius = progressCircle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    progressCircle.style.strokeDasharray = `${circumference} ${circumference}`;
    progressCircle.style.strokeDashoffset = circumference;
    photoItem.classList.add('is-loading');
    const controller = new AbortController();
    const { signal } = controller;
    activeLoader = controller;
    try {
        const response = await fetch(mediaSrc, { signal });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const reader = response.body.getReader();
        const contentLength = +response.headers.get('Content-Length');
        let receivedLength = 0;
        let chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            receivedLength += value.length;
            if (contentLength) {
                const progress = receivedLength / contentLength;
                const offset = circumference - progress * circumference;
                progressCircle.style.strokeDashoffset = offset;
            }
        }
        const blob = new Blob(chunks);
        const objectURL = URL.createObjectURL(blob);
        if (activeLoader === controller) {
            openModal(objectURL, index, true, mediaSrc);
        } else {
            URL.revokeObjectURL(objectURL);
        }
    } catch (error) {
        if (error.name !== 'AbortError') showNotification('图片加载失败', 'error');
    } finally {
        photoItem.classList.remove('is-loading');
        if (activeLoader === controller) activeLoader = null;
    }
}

window.openModal = function(mediaSrc, index = 0, isObjectURL = false, originalPathForAI = null) {
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    if (document.activeElement) document.activeElement.blur();
    if (!mediaSrc || typeof mediaSrc !== 'string' || mediaSrc.trim() === '') {
        console.error('Failed to open modal: Invalid media source:', mediaSrc);
        return;
    }
    backdrops.one.style.backgroundImage = `url('${mediaSrc}')`;
    backdrops.one.classList.add('active-backdrop');
    backdrops.two.classList.remove('active-backdrop');
    activeBackdrop = 'one';
    modalImg.src = mediaSrc;
    modal.classList.remove('opacity-0', 'pointer-events-none');
    const aiPath = originalPathForAI || mediaSrc;
    updateModalContent(mediaSrc, index, aiPath);
    if (isObjectURL) currentObjectURL = mediaSrc;
    if (!hasShownNavigationHint && window.innerWidth > 768) {
        navigationHint.classList.add('show-hint');
        hasShownNavigationHint = true;
        setTimeout(() => navigationHint.classList.remove('show-hint'), 4000);
    }
    if (!window.location.hash.endsWith('#modal')) {
        window.history.pushState({ modal: true }, '', window.location.href + '#modal');
    }
};

function navigateModal(direction) {
    if (document.activeElement) document.activeElement.blur();
    if (isModalNavigating) return;
    hideModalControls(); // 立即隐藏UI
    clearTimeout(uiVisibilityTimer); // 清除上一个计时器
    uiVisibilityTimer = setTimeout(showModalControls, 500); // 启动新计时器，500毫秒后显示UI
    const newIndex = direction === 'prev' ? currentPhotoIndex - 1 : currentPhotoIndex + 1;
    if (newIndex >= 0 && newIndex < currentPhotos.length) {
        const nextMediaSrc = currentPhotos[newIndex];
        handleModalNavigationLoad(nextMediaSrc, newIndex);
    }
}


async function handleModalNavigationLoad(mediaSrc, index) {
    if (mediaSrc.match(/\.(mp4|webm|mov)$/i)) {
        backdrops.one.classList.remove('active-backdrop');
        backdrops.two.classList.remove('active-backdrop');
        updateModalContent(mediaSrc, index, mediaSrc);
        return;
    }
    if (isModalNavigating) return;
    isModalNavigating = true;
    const tempImg = new Image();
    tempImg.onload = () => {
        const inactiveBackdropKey = activeBackdrop === 'one' ? 'two' : 'one';
        const activeBackdropElem = backdrops[activeBackdrop];
        const inactiveBackdropElem = backdrops[inactiveBackdropKey];
        inactiveBackdropElem.style.backgroundImage = `url('${tempImg.src}')`;
        updateModalContent(tempImg.src, index, currentPhotos[index]);
        inactiveBackdropElem.classList.add('active-backdrop'); // 淡入新背景
        activeBackdropElem.classList.remove('active-backdrop'); // 淡出旧背景
        activeBackdrop = inactiveBackdropKey;
        isModalNavigating = false;
    };

    tempImg.onerror = () => {
        showNotification('图片加载或解码失败', 'error');
        isModalNavigating = false;
    };

    tempImg.src = mediaSrc;
}

// --- Event Listeners ---
function hideModalControls() {
    modalClose.classList.add('opacity-0');
    captionBubbleWrapper.classList.add('opacity-0');
}

function showModalControls() {
    modalClose.classList.remove('opacity-0');
    captionBubbleWrapper.classList.remove('opacity-0');
}

function setupEventListeners() {
    window.addEventListener('hashchange', handleHashChange);
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchDebounceTimer);
            const query = e.target.value;
            searchDebounceTimer = setTimeout(() => {
                const trimmedQuery = query.trim();
                if (query.trim()) {
                    performSearch(query);
                } else if (window.location.hash.includes('search?q=')) {
                    window.location.hash = preSearchHash || '#/';
                }
            }, 800);
        });
    }

    window.addEventListener('popstate', (event) => {
        if (!window.location.hash.endsWith('#modal')) {
            if (!modal.classList.contains('opacity-0')) {
                document.documentElement.classList.remove('modal-open');
                document.body.classList.remove('modal-open');
                modal.classList.add('opacity-0', 'pointer-events-none');
                
                modalImg.src = '';
                modalVideo.pause();
                modalVideo.src = '';
                backdrops.one.style.backgroundImage = 'none';
                backdrops.two.style.backgroundImage = 'none';
                if (currentObjectURL) {
                    URL.revokeObjectURL(currentObjectURL);
                    currentObjectURL = null;
                }
                captionBubble.classList.remove('show');
            }
        }
    });

    modalClose.addEventListener('click', closeModal);
    mediaPanel.addEventListener('click', (e) => {
        if (e.target === mediaPanel) {
            closeModal();
        }
    });
    toggleCaptionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        captionBubble.classList.toggle('show');
    });
    document.addEventListener('click', (e) => {
        if (captionBubble.classList.contains('show') && !captionBubble.contains(e.target) && !toggleCaptionBtn.contains(e.target)) {
            captionBubble.classList.remove('show');
        }
    });
    document.addEventListener('keydown', (e) => {
        if (modal.classList.contains('opacity-0')) return;
        if (e.key === 'Escape') closeModal();
        else if (e.key === 'ArrowLeft') navigateModal('prev');
        else if (e.key === 'ArrowRight') navigateModal('next');
    });
    let lastWheelTime = 0;
    modal.addEventListener('wheel', (e) => {
        if (window.innerWidth <= 768) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastWheelTime < 300) return;
        lastWheelTime = now;
        hideModalControls();
        clearTimeout(uiVisibilityTimer);
        uiVisibilityTimer = setTimeout(showModalControls, 500);
        if (e.deltaY < 0) navigateModal('prev');
        else navigateModal('next');
    });
    let touchStartY = 0;
    const swipeThreshold = 50;
    modalContent.addEventListener('touchstart', e => { touchStartY = e.changedTouches[0].screenY; }, { passive: true });
    modalContent.addEventListener('touchend', e => {
        const touchEndY = e.changedTouches[0].screenY;
        const deltaY = touchEndY - touchStartY;
        if (Math.abs(deltaY) > swipeThreshold) {
            if (deltaY > 0) navigateModal('prev');
            else navigateModal('next');
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key.toLowerCase() === 'b') {
            isBlurredMode = !isBlurredMode;
            document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
                media.classList.toggle('blurred', isBlurredMode);
            });
        }
    });
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const newColumnCount = getMasonryColumns();
            // 只有在列数发生变化时，才重新计算瀑布流
            if (newColumnCount !== currentColumnCount) {
                currentColumnCount = newColumnCount;
                applyMasonryLayout();
            }
        }, 100); // 可以将延迟改短一些
    });
}

// --- PWA & Initial Load ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(registration => {
            console.log('ServiceWorker registration successful with scope: ', registration.scope);
        }).catch(err => {
            console.log('ServiceWorker registration failed: ', err);
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    handleHashChange();
    setupEventListeners();
});