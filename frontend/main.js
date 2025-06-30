// --- App State & API Config ---
// 应用状态与API基础配置
const API_BASE = ''; // 在Docker环境中，通过Nginx代理访问后端API
let currentPhotos = []; // 存储当前视图下的所有图片URL，用于模态框导航
let currentPhotoIndex = 0; // 当前查看的图片索引
let searchResults = []; // 存储搜索结果
let isBlurredMode = false;
let captionDebounceTimer = null; // 新增：用于AI密语的防抖计时器

// --- Element Selections ---
// 选择页面上的主要DOM元素
const contentGrid = document.getElementById('content-grid');
const loadingIndicator = document.getElementById('loading');
const breadcrumbNav = document.getElementById('breadcrumb-nav');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
const mediaPanel = document.getElementById('media-panel');
const captionPanel = document.getElementById('caption-panel');
const modalImg = document.getElementById('modal-img');
const modalVideo = document.getElementById('modal-video');
const captionContainer = document.getElementById('caption-container');
const modalClose = document.getElementById('modal-close');
const modalPrev = document.getElementById('modal-prev');
const modalNext = document.getElementById('modal-next');


// --- 错误通知函数 ---
// 显示错误或成功通知的弹窗
function showNotification(message, type = 'error') {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 20px;
        border-radius: 5px;
        color: white;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.5s ease-in-out;
    `;
    if (type === 'error') {
        notification.style.backgroundColor = '#dc3545'; // Bootstrap danger color
    } else if (type === 'success') {
        notification.style.backgroundColor = '#28a745'; // Bootstrap success color
    }
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.opacity = '1';
    }, 10);

    setTimeout(() => {
        notification.style.opacity = '0';
        notification.addEventListener('transitionend', () => notification.remove());
    }, 3000);
}

// 图片预加载机制
// 预加载当前图片后面的几张图片，提高模态浏览体验
function preloadNextImages(startIndex) {
    const toPreload = currentPhotos.slice(startIndex + 1, startIndex + 3);
    toPreload.forEach(url => {
        if (url && !/\.(mp4|webm|mov)$/i.test(url)) { // 只预加载图片
            const img = new Image();
            img.src = url;
        }
    });
}

/**
 * 新增：图片压缩函数
 * 在保持图片比例的同时，将其最大边长限制在指定的大小内。
 * @param {string} base64Str - 原始图片的Base64字符串。
 * @param {number} maxWidth - 目标最大宽度。
 * @param {number} maxHeight - 目标最大高度。
 * @returns {Promise<string>} 压缩后的图片Base64字符串。
 */
function resizeImage(base64Str, maxWidth, maxHeight) {
    return new Promise(resolve => {
        const img = new Image();
        img.src = "data:image/jpeg;base64," + base64Str;
        img.onload = () => {
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
            } else {
                if (height > maxHeight) {
                    width *= maxHeight / height;
                    height = maxHeight;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // 将canvas内容转换为jpeg格式的Base64，并指定压缩质量
            const resizedBase64 = canvas.toDataURL('image/jpeg', 0.8); // 0.8 是压缩质量
            
            // 去掉前缀 "data:image/jpeg;base64,"
            resolve(resizedBase64.split(',')[1]);
        };
        img.onerror = () => {
             // 如果加载失败，直接返回原始的base64，避免流程中断
            resolve(base64Str);
        };
    });
}


// --- 懒加载实现 ---
// 懒加载图片，提升页面性能
function setupLazyLoading() {
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                const dataSrc = img.dataset.src;

                // 禁止右键（只绑定一次）
                if (!img._noContextMenuBound) {
                    img.addEventListener('contextmenu', e => {
                        e.preventDefault();
                    });
                    img._noContextMenuBound = true;
                }

                // 全局模糊模式下自动加模糊
                if (isBlurredMode) {
                    img.classList.add('blurred');
                }

                if (!dataSrc || dataSrc.includes('undefined') || dataSrc.includes('null')) {
                    console.error('懒加载失败：无效的图片URL:', dataSrc);
                    handleImageError(img);
                } else {
                    img.src = dataSrc;
                }

                observer.unobserve(img);
            }
        });
    }, {
        rootMargin: '50px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.lazy-image').forEach(img => {
        imageObserver.observe(img);
        // 立即绑定禁止右键（防止未懒加载时也能右键）
        if (!img._noContextMenuBound) {
            img.addEventListener('contextmenu', e => {
                e.preventDefault();
            });
            img._noContextMenuBound = true;
        }
        // 全局模糊模式下自动加模糊
        if (isBlurredMode) {
            img.classList.add('blurred');
        }
    });
}

// 新增：懒加载视频
function setupLazyVideoLoading() {
    const videoObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const video = entry.target;
                const dataSrc = video.dataset.src;
                if (dataSrc) {
                    video.src = dataSrc;
                }
                observer.unobserve(video);
            }
        });
    }, {
        rootMargin: '50px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.lazy-video').forEach(video => {
        videoObserver.observe(video);
    });
}


// --- 图片加载成功/失败处理 ---
// 图片加载成功时的处理
function handleImageLoad(img) {
    img.classList.add('loaded');
}

// 图片加载失败时的处理，显示占位图
function handleImageError(img) {
    img.onerror = null;
    
    // 创建专业错误占位图
    const placeholder = document.createElement('div');
    placeholder.className = 'image-placeholder w-full h-full flex items-center justify-center';
    placeholder.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <span class="ml-2">加载失败</span>
    `;
    
    // Check if the image has a parent node before replacing
    if (img.parentNode) {
        img.parentNode.replaceChild(placeholder, img);
    }
}
  

// --- 搜索功能 ---
// 执行搜索请求，渲染搜索结果
async function performSearch(query) {
    if (!query.trim()) return;

    loadingIndicator.style.display = 'block';
    contentGrid.innerHTML = '';
    currentPhotos = [];

    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error(`搜索失败: ${response.status}`);

        const data = await response.json();
        searchResults = data.results;

        currentPhotos = searchResults
            .filter(r => r.type === 'photo' || r.type === 'video')
            .map(r => r.path ? `/static/${r.path}` : '');

        if (searchResults.length === 0) {
            contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">没有找到相关结果。</p>';
        } else {
            let mediaIndex = 0;
            searchResults.forEach(result => {
                if (result.type === 'album') {
                    displayAlbum(result);
                } else if (result.type === 'photo' || result.type === 'video') {
                    displaySearchMedia(result, mediaIndex++);
                }
            });
        }

        breadcrumbNav.innerHTML = `<span class="text-white">搜索结果: "${query}" (${searchResults.length}项)</span>`;

    } catch (error) {
        showNotification(`搜索失败: ${error.message}`);
        contentGrid.innerHTML = ''; // 清空内容，只显示通知
    } finally {
        loadingIndicator.style.display = 'none';
        setupLazyLoading();
        setupLazyVideoLoading(); // 新增
    }
}

// 渲染搜索结果中的相册节点 (此函数在原代码中未被调用，但我们保留它以防万一)
function displaySearchAlbum(result) {
    const coverUrl = result.coverUrl || 'data:image/svg+xml,...'; // Fallback
    const albumName = result.name || '未命名相册';
    const albumPath = result.path || '#';

    const albumHtml = `
        <div class="grid-item">
            <a href="#/${encodeURIComponent(albumPath)}" 
               onclick="if(document.activeElement) document.activeElement.blur()" 
               class="album-card group block bg-gray-800 rounded-lg overflow-hidden shadow-lg hover:shadow-purple-500/30 transition-shadow">
                <div class="aspect-w-1 aspect-h-1 bg-gray-700">
                    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" 
                         data-src="${coverUrl}" 
                         alt="${albumName}" class="w-full h-full object-cover lazy-image" 
                         onerror="handleImageError(this)"
                         onload="handleImageLoad(this)">
                </div>
                <div class="p-2 sm:p-4">
                    <h3 class="font-bold text-sm sm:text-lg truncate group-hover:text-purple-300">📁 ${albumName}</h3>
                    <p class="text-xs text-gray-400 mt-1">相册</p>
                </div>
            </a>
        </div>`;
    contentGrid.insertAdjacentHTML('beforeend', albumHtml);
}

// 渲染搜索结果中的媒体节点
function displaySearchMedia(result, index) {
    const mediaPath = result.path ? `/static/${result.path}` : '';
    const mediaName = result.name || '媒体文件';
    const isVideo = result.type === 'video';
    
    // 修改点：将 relative 和 onclick 移到 .photo-item 上
    const mediaHtml = `
        <div class="grid-item">
            <div class="photo-item relative cursor-pointer" onclick="openModal('${mediaPath}', ${index})">
            ${
              isVideo
                ? `<video muted preload="metadata" class="w-full h-auto rounded-lg shadow-lg lazy-video" data-src="${mediaPath}#t=0.5"></video>
                   <div class="absolute bottom-2 left-2 bg-gray-900 bg-opacity-75 rounded-sm p-0.5 pointer-events-none">
                       <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor">
                           <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.555 7.168A1 1 0 006 8v4a1 1 0 001.544.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
                       </svg>
                   </div>`
                : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'%3E%3Crect width='600' height='600' fill='%23374151'/%3E%3C/svg%3E" 
                     data-src="${mediaPath}" 
                     alt="${mediaName}" 
                     class="w-full h-auto rounded-lg shadow-lg lazy-image"
                     onerror="handleImageError(this)"
                     onload="handleImageLoad(this)">`
            }
            </div>
            <div class="mt-2">
                <p class="text-xs text-gray-400 truncate">${mediaName}</p>
            </div>
        </div>`;
    contentGrid.insertAdjacentHTML('beforeend', mediaHtml);
}


// --- Data Fetching & Rendering ---
// 拉取指定路径下的相册和图片，流式渲染
async function streamPath(path) {
    contentGrid.innerHTML = '';
    loadingIndicator.style.display = 'block';
    let contentFound = false;
    currentPhotos = [];
    
    renderBreadcrumb(path || '');

    try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(path || '')}`);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`服务器错误: ${response.status} - ${errorData.message || response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (!contentFound) {
                contentFound = true;
                loadingIndicator.style.display = 'none';
            }
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); 

            for (const line of lines) {
                if (line.trim() === '') continue;
                try {
                    const item = JSON.parse(line);
                    if (item.type === 'error') {
                        throw new Error(`服务器流式响应错误: ${item.data.message}`);
                    }
                    if (item.type === 'album') {
                        displayAlbum(item.data);
                    } else if (item.type === 'photo' || item.type === 'video') {
                        currentPhotos.push(item.data);
                        displayStreamedMedia(item.type, item.data, currentPhotos.length - 1);
                    }
                } catch (e) {
                    console.error('解析JSON或处理流数据时出错:', line, e);
                }
            }
        }

        if (!contentFound) {
            loadingIndicator.style.display = 'none';
            contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">这个文件夹是空的。</p>';
        }

        setupLazyLoading();
        setupLazyVideoLoading();

    } catch (error) {
        showNotification(`加载失败: ${error.message}`);
        loadingIndicator.style.display = 'none';
        contentGrid.innerHTML = '';
    }
}

// 渲染面包屑导航
function renderBreadcrumb(path) {
    const parts = path ? path.split('/').filter(p => p) : [];
    let currentPath = '';

    const homeLink = `<a href="#/" onclick="this.blur()" class="text-purple-400 hover:text-purple-300">首页</a>`;

    const pathLinks = parts.map((part, index) => {
        currentPath += (currentPath ? '/' : '') + part;
        const isLast = index === parts.length - 1;
        return isLast 
            ? `<span class="text-white">${decodeURIComponent(part)}</span>`
            : `<a href="#/${encodeURIComponent(currentPath)}" onclick="this.blur()" class="text-purple-400 hover:text-purple-300">${decodeURIComponent(part)}</a>`;
    });
    breadcrumbNav.innerHTML = [homeLink, ...pathLinks].join('<span class="mx-2">/</span>');
}

// 渲染相册节点（浏览模式）
function displayAlbum(album) {
    const albumHtml = `
        <div class="grid-item">
            <a href="#/${encodeURIComponent(album.path)}" 
               onclick="if(document.activeElement) document.activeElement.blur()"
               class="album-card group block bg-gray-800 rounded-lg overflow-hidden shadow-lg hover:shadow-purple-500/30 transition-shadow">
                <div class="aspect-w-1 aspect-h-1 bg-gray-700">
                    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${album.coverUrl}" alt="${album.name}" class="w-full h-full object-cover lazy-image" onerror="handleImageError(this)" onload="handleImageLoad(this)">
                </div>
                <div class="p-2 sm:p-4">
                    <h3 class="font-bold text-sm sm:text-lg truncate group-hover:text-purple-300">📁 ${album.name}</h3>
                </div>
            </a>
        </div>`;
    contentGrid.insertAdjacentHTML('beforeend', albumHtml);
}

// 渲染图片或视频节点（浏览模式）
function displayStreamedMedia(type, mediaUrl, index) {
    const isVideo = type === 'video';
    // 修改点：将 relative 和 onclick 移到 .photo-item 上
    const mediaHtml = `
        <div class="grid-item">
            <div class="photo-item relative cursor-pointer" onclick="openModal('${mediaUrl}', ${index})">
            ${
              isVideo
                ? `<video muted preload="metadata" class="w-full h-auto rounded-lg shadow-lg lazy-video" data-src="${mediaUrl}#t=0.5"></video>
                   <div class="absolute bottom-2 left-2 bg-gray-900 bg-opacity-75 rounded-sm p-0.5 pointer-events-none">
                       <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor">
                           <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.555 7.168A1 1 0 006 8v4a1 1 0 001.544.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
                       </svg>
                   </div>`
                : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'%3E%3Crect width='600' height='600' fill='%23374151'/%3E%3C/svg%3E" 
                     data-src="${mediaUrl}" 
                     alt="写真照片" 
                     class="w-full h-auto rounded-lg shadow-lg lazy-image" 
                     onerror="handleImageError(this)" 
                     onload="handleImageLoad(this)">`
            }
            </div>
        </div>`;
    contentGrid.insertAdjacentHTML('beforeend', mediaHtml);
}

// 监听hash变化，切换路径
function handleHashChange() {
    const path = window.location.hash.substring(1).replace(/^\//, '');
    streamPath(decodeURIComponent(path));
}

// --- Modal & AI Logic ---
async function callBackendAI(body) {
    const response = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(`AI服务调用失败: ${response.status} - ${errorBody.message || response.statusText}`);
    }

    const result = await response.json();
    return result.description || "抱歉，AI 暂时无法回应。";
}

async function generateImageCaption(base64ImageData, imageUrl) {
    captionContainer.innerHTML = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">正在倾听她的密语...</p></div>';
    
    const payload = {
        image_data: base64ImageData,
        image_url: imageUrl,
    };

    try {
        captionContainer.textContent = await callBackendAI(payload);
    } catch (error) {
        captionContainer.textContent = `对话生成失败: ${error.message}`;
        showNotification(`对话生成失败: ${error.message}`);
    }
}

async function imageUrlToBase64(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`图片获取失败: ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => {
            reject(new Error('图片读取失败: FileReader error'));
        };
        reader.readAsDataURL(blob);
    });
}

function closeModal() {
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    modal.classList.add('opacity-0', 'pointer-events-none');
    
    modalVideo.pause();
    modalVideo.src = '';

    // Reset layout to default for next open
    captionPanel.classList.remove('hidden');
    mediaPanel.classList.remove('md:w-full');
    mediaPanel.classList.add('md:w-2/3');

    if (document.activeElement) {
        document.activeElement.blur();
    }
}

function updateModalContent(mediaSrc, index) {
    currentPhotoIndex = index;

    // Stop any currently playing video before switching
    modalVideo.pause();
    modalVideo.src = '';

    const isVideo = /\.(mp4|webm|mov)$/i.test(mediaSrc);

    if (isVideo) {
        // Video mode: fullscreen video, hide caption
        captionPanel.classList.add('hidden');
        mediaPanel.classList.remove('md:w-2/3');
        mediaPanel.classList.add('md:w-full');

        modalImg.classList.add('hidden');
        modalVideo.classList.remove('hidden');
        modalVideo.src = mediaSrc;
        modalVideo.play().catch(e => console.error("Video playback failed:", e));
        
    } else {
        // Image mode: show caption, restore layout
        captionPanel.classList.remove('hidden');
        mediaPanel.classList.remove('md:w-full');
        mediaPanel.classList.add('md:w-2/3');

        modalVideo.classList.add('hidden');
        modalImg.classList.remove('hidden');
        
        // Prevent right-click, bind only once
        if (!modalImg._noContextMenuBound) {
            modalImg.addEventListener('contextmenu', e => e.preventDefault());
            modalImg._noContextMenuBound = true;
        }

        // Create an in-memory image to preload the new source without flicker
        const tempImg = new Image();
        
        tempImg.onload = () => {
            // Once loaded, instantly swap the src of the visible image
            modalImg.src = tempImg.src;

            // --- 防抖核心 ---
            clearTimeout(captionDebounceTimer); // 清除上一个计时器
            captionDebounceTimer = setTimeout(() => { // 设置新计时器
                // Then, start the AI caption generation process
                imageUrlToBase64(mediaSrc)
                    .then(base64Data => {
                        if (base64Data.length > 8000000) { 
                            console.log("Image is large, resizing...");
                            return resizeImage(base64Data, 1024, 1024);
                        }
                        console.log("Image is small, skipping resize.");
                        return base64Data;
                    })
                    .then(processedBase64Data => {
                        return generateImageCaption(processedBase64Data, mediaSrc);
                    })
                    .catch(error => {
                        captionContainer.textContent = 'AI解读失败: ' + error.message;
                    });
            }, 300); // 300毫秒延迟
        };

        tempImg.onerror = () => {
            // If the new image fails, show the error placeholder on the visible image
            handleImageError(modalImg);
            captionContainer.textContent = '图片加载失败。';
        };

        // Set the src to start loading. The old image remains visible until onload.
        tempImg.src = mediaSrc;

        // Immediately provide feedback in the caption area that something is happening.
        // generateImageCoption will overwrite this with its own loading message.
        captionContainer.innerHTML = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">正在加载...</p></div>';
    }

    preloadNextImages(index);
    updateModalNavigation();
}

window.openModal = function(mediaSrc, index = 0) {
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    
    if (document.activeElement) {
        document.activeElement.blur();
    }

    if (!mediaSrc || typeof mediaSrc !== 'string' || mediaSrc.trim() === '') {
        console.error('Modal打开失败：媒体源为空或无效:', mediaSrc);
        return;
    }
    
    modal.classList.remove('opacity-0', 'pointer-events-none');
    
    updateModalContent(mediaSrc, index);
}

function updateModalNavigation() {
    if (modalPrev) {
      modalPrev.classList.toggle('hidden', currentPhotoIndex <= 0);
    }
    if (modalNext) {
      modalNext.classList.toggle('hidden', currentPhotoIndex >= currentPhotos.length - 1);
    }
}

function navigateModal(direction) {
    if (document.activeElement) {
        document.activeElement.blur();
    }

    const newIndex = direction === 'prev' ? currentPhotoIndex - 1 : currentPhotoIndex + 1;
    if (newIndex >= 0 && newIndex < currentPhotos.length) {
        updateModalContent(currentPhotos[newIndex], newIndex);
    }
}

// --- Global function exposure ---
window.performSearch = performSearch;

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    
    if (modalClose) modalClose.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    if (modalPrev) {
        modalPrev.addEventListener('click', (e) => { 
            navigateModal('prev');
            e.currentTarget.blur();
        });
    }
    if (modalNext) {
        modalNext.addEventListener('click', (e) => { 
            navigateModal('next');
            e.currentTarget.blur();
        });
    }
    
    document.addEventListener('keydown', (e) => {
        if (!modal || modal.classList.contains('opacity-0')) return;
        if (e.key === 'Escape') closeModal();
        else if (e.key === 'ArrowLeft') navigateModal('prev');
        else if (e.key === 'ArrowRight') navigateModal('next');
    });
    
    // Mobile touch swipe handler
    let touchStartY = 0;
    const swipeThreshold = 50; 
    if (modalContent) {
        modalContent.addEventListener('touchstart', e => {
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: true });

        modalContent.addEventListener('touchend', e => {
            const touchEndY = e.changedTouches[0].screenY;
            const deltaY = touchEndY - touchStartY;
            if (Math.abs(deltaY) > swipeThreshold) {
                if (deltaY > 0) {
                    navigateModal('prev');
                } else {
                    navigateModal('next');
                }
            }
        });
    }
});

// --- Initial Load & PWA ---
handleHashChange();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(registration => {
            console.log('ServiceWorker registration successful with scope: ', registration.scope);
        }, err => {
            console.log('ServiceWorker registration failed: ', err);
        });
    });
}

// Global 'B' key listener for blur effect
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }
    if (e.key.toLowerCase() === 'b') {
        isBlurredMode = !isBlurredMode;
        document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
            media.classList.toggle('blurred', isBlurredMode);
        });
    }
});