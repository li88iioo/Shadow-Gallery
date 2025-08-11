// frontend/js/ui.js

import { elements, state } from './state.js';
import { getAllViewed } from './indexeddb-helper.js';

// 重新导出 elements 以供其他模块使用
export { elements };

/**
 * 格式化时间显示
 * @param {number} timestamp - 时间戳（毫秒）
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    // 小于1分钟
    if (diff < 60 * 1000) {
        return '刚刚';
    }
    // 小于1小时
    if (diff < 60 * 60 * 1000) {
        return `${Math.floor(diff / (60 * 1000))}分钟前`;
    }
    // 小于24小时
    if (diff < 24 * 60 * 60 * 1000) {
        return `${Math.floor(diff / (60 * 60 * 1000))}小时前`;
    }
    // 小于30天
    if (diff < 30 * 24 * 60 * 60 * 1000) {
        return `${Math.floor(diff / (24 * 60 * 60 * 1000))}天前`;
    }
    // 小于12个月
    if (diff < 12 * 30 * 24 * 60 * 60 * 1000) {
        return `${Math.floor(diff / (30 * 24 * 60 * 60 * 1000))}个月前`;
    }
    // 超过1年
    return `${Math.floor(diff / (12 * 30 * 24 * 60 * 60 * 1000))}年前`;
}

/**
 * 根据已查看状态对相册进行排序
 * 已查看的相册会排在未查看的相册后面
 */
export async function sortAlbumsByViewed() {
    const hash = window.location.hash;
    const questionMarkIndex = hash.indexOf('?');
    const urlParams = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
    const currentSort = urlParams.get('sort') || 'smart';

    if (currentSort !== 'smart') return;
    // 获取所有已查看的相册数据
    const viewedAlbumsData = await getAllViewed();
    const viewedAlbumPaths = viewedAlbumsData.map(item => item.path);
    const albumElements = Array.from(document.querySelectorAll('.album-link'));

    // 对相册元素进行排序
    albumElements.sort((a, b) => {
        const pathA = a.dataset.path;
        const pathB = b.dataset.path;
        const viewedA = viewedAlbumPaths.includes(pathA);
        const viewedB = viewedAlbumPaths.includes(pathB);

        if (viewedA && !viewedB) {
            return 1; // A (已查看) 排在 B (未查看) 后面
        }
        if (!viewedA && viewedB) {
            return -1; // B (已查看) 排在 A (未查看) 后面
        }
        return 0; // 保持原有顺序
    });

    // 重新排列DOM元素
    const grid = elements.contentGrid;
    if (!grid) return
    albumElements.forEach(el => grid.appendChild(el));
}

/**
 * 渲染面包屑导航
 * @param {string} path - 当前路径
 */
export function renderBreadcrumb(path) {
    // 解析路径并过滤空字符串
    const parts = path ? path.split('/').filter(p => p) : [];
    let currentPath = '';
    
    // 获取当前排序参数 - 使用进入当前页面时的排序方式
    let sortParam = '';

    if (state.entrySort && state.entrySort !== 'smart') {
        sortParam = `?sort=${state.entrySort}`;
    } else {
        const hash = window.location.hash;
        const questionMarkIndex = hash.indexOf('?');
        sortParam = questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '';
    }

    
    // 创建首页链接
    const homeLink = `<a href="#/${sortParam}" class="text-purple-400 hover:text-purple-300">首页</a>`;
    
    // 创建路径链接
    const pathLinks = parts.map((part, index) => {
        currentPath += (currentPath ? '/' : '') + part;
        const isLast = index === parts.length - 1;
        return isLast 
            ? `<span class="text-white">${decodeURIComponent(part)}</span>` 
            : `<a href="#/${encodeURIComponent(currentPath)}${sortParam}" class="text-purple-400 hover:text-purple-300">${decodeURIComponent(part)}</a>`;
    });
    
    // 组合面包屑导航HTML
    const breadcrumbNav = document.getElementById('breadcrumb-nav');
    if (!breadcrumbNav) {
        return;
    }
    
    // 只更新面包屑链接部分，保留排序按钮
    const breadcrumbLinks = breadcrumbNav.querySelector('#breadcrumb-links');
    if (breadcrumbLinks) {
        // 如果存在 breadcrumb-links 子元素，只更新它
        const breadcrumbHtml = `<div class="flex flex-wrap items-center">${[homeLink, ...pathLinks].join('<span class="mx-2">/</span>')}</div>`;
        breadcrumbLinks.innerHTML = breadcrumbHtml;
    } else {
        // 如果不存在子元素，更新整个容器（搜索页面的情况）
        // 但保留排序容器的结构
        const breadcrumbHtml = `
            <div id="breadcrumb-links" class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center">${[homeLink, ...pathLinks].join('<span class="mx-2">/</span>')}</div>
            </div>
            <div id="sort-container" class="flex-shrink-0 ml-4"></div>
        `;
        breadcrumbNav.innerHTML = breadcrumbHtml;
    }
    
    // 检查是否需要显示排序控件
    // 从搜索页面进入相册后，需要重新检查并显示排序控件
    setTimeout(() => {
        const sortContainer = document.getElementById('sort-container');
        if (sortContainer) {
            // 检查是否为最终相册页面
            checkIfHasMediaFiles(path).then(hasMedia => {
                if (!hasMedia) {
                    // 目录页面，显示排序控件
                    renderSortDropdown();
                }
            }).catch(() => {
                // 如果检查失败，默认显示排序控件
                renderSortDropdown();
            });
        }
    }, 100);
}

/**
 * 渲染相册卡片
 * @param {Object} album - 相册数据对象
 * @returns {string} 相册卡片的HTML字符串
 */
export function displayAlbum(album) {
    // 计算封面图片的宽高比
    const aspectRatio = album.coverHeight ? album.coverWidth / album.coverHeight : 1;
    
    // 格式化时间
    const timeText = formatTime(album.mtime);
    
    // 获取当前排序参数 - 使用进入当前页面时的排序方式
    let sortParam = '';
    if (state.entrySort && state.entrySort !== 'smart') {
        sortParam = `?sort=${state.entrySort}`;
    } else {
        const hash = window.location.hash;
        const questionMarkIndex = hash.indexOf('?');
        sortParam = questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '';
    }
    
    return `<div class="grid-item album-link" data-path="${album.path}" data-width="${album.coverWidth || 1}" data-height="${album.coverHeight || 1}">
                <a href="#/${encodeURIComponent(album.path)}${sortParam}" class="album-card group block bg-gray-800 rounded-lg overflow-hidden shadow-lg hover:shadow-purple-500/30 transition-shadow">
                    <div class="relative" style="aspect-ratio: ${aspectRatio};">
                        <div class="image-placeholder absolute inset-0"></div>
                        <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${album.coverUrl}" alt="${album.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300">
                        
                        <!-- 新增：悬停时浮现的信息覆盖层 -->
                        <div class="card-info-overlay">
                            <div class="album-title">${album.name}</div>
                            <div class="album-meta">
                                <span class="album-type">相册</span>
                                ${timeText ? `<span class="album-time">${timeText}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    
                    <!-- 移除默认状态下的文字信息 -->
                    <div class="album-info" style="display: none;">
                        <h3 class="font-bold text-sm sm:text-lg truncate group-hover:text-purple-300">${album.name}</h3>
                    </div>
                </a>
            </div>`;
}

/**
 * 渲染流式媒体项（图片或视频）
 * @param {string} type - 媒体类型 ('photo' 或 'video')
 * @param {Object} mediaData - 媒体数据对象
 * @param {number} index - 媒体索引
 * @returns {string} 媒体项的HTML字符串
 */
export function displayStreamedMedia(type, mediaData, index, showTimestamp) {
    const isVideo = type === 'video';
    // 计算媒体项的宽高比
    const aspectRatio = mediaData.height ? mediaData.width / mediaData.height : 1;
    
    // 根据条件格式化时间
    const timeText = showTimestamp ? formatTime(mediaData.mtime) : '';
    
    return `<div class="grid-item photo-link" data-url="${mediaData.originalUrl}" data-index="${index}" data-width="${mediaData.width}" data-height="${mediaData.height}">
                <div class="photo-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer">
                    <div class="relative w-full h-full" style="aspect-ratio: ${aspectRatio}">
                        <div class="image-placeholder absolute inset-0"></div>
                        <div class="loading-overlay"><svg class="progress-circle" viewBox="0 0 20 20"><circle class="progress-circle-track" cx="10" cy="10" r="8" stroke-width="2"></circle><circle class="progress-circle-bar" cx="10" cy="10" r="8" stroke-width="2"></circle></svg></div>
                        ${isVideo 
                            ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="视频预览" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` 
                            : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="图片" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300">`
                        }
                        ${timeText ? `<div class="absolute bottom-2 right-2 bg-black/50 text-white text-sm px-2 py-1 rounded shadow-lg">${timeText}</div>` : ''}
                    </div>
                </div>
            </div>`;
}

/**
 * 渲染搜索结果中的媒体项
 * @param {Object} result - 搜索结果对象
 * @param {number} index - 媒体索引
 * @returns {string} 搜索媒体项的HTML字符串
 */
export function displaySearchMedia(result, index) {
    const isVideo = result.type === 'video';
    
    // 格式化时间（如果有mtime字段）
    const timeText = formatTime(result.mtime);
    
    return `<div class="grid-item photo-link" data-url="${result.originalUrl}" data-index="${index}">
                <div class="photo-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer">
                    <div class="aspect-w-1 aspect-h-1 relative">
                        <div class="image-placeholder absolute inset-0"></div>
                        <div class="loading-overlay"><svg class="progress-circle" viewBox="0 0 20 20"><circle class="progress-circle-track" cx="10" cy="10" r="8" stroke-width="2"></circle><circle class="progress-circle-bar" cx="10" cy="10" r="8" stroke-width="2"></circle></svg></div>
                        ${isVideo  
                            ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${result.thumbnailUrl}" alt="视频预览：${result.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` 
                            : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${result.thumbnailUrl}" alt="${result.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300">`
                        }
                        ${timeText ? `<div class="absolute bottom-2 right-2 bg-black/50 text-white text-sm px-2 py-1 rounded shadow-lg">${timeText}</div>` : ''}
                    </div>
                </div>
                <div class="mt-2"><p class="text-xs text-gray-400 truncate">${result.name}</p></div>
            </div>`;
}

/**
 * 渲染浏览网格
 * @param {Array} items - 要渲染的项目数组
 * @param {number} currentPhotoCount - 当前照片数量
 * @returns {Object} 包含HTML内容和媒体URL数组的对象
 */
export function renderBrowseGrid(items, currentPhotoCount) {
    let contentHtml = '';
    const newMediaUrls = [];

    const hasAlbums = items.some(item => item.type === 'album');

    // 遍历项目并生成HTML
    items.forEach(item => {
        const itemData = item.data;
        if (item.type === 'album') {
            contentHtml += displayAlbum(itemData);
        } else {
            const mediaIndex = currentPhotoCount + newMediaUrls.length;
            contentHtml += displayStreamedMedia(item.type, itemData, mediaIndex, hasAlbums);
            newMediaUrls.push(itemData.originalUrl);
        }
    });

    return { contentHtml, newMediaUrls };
}

/**
 * 渲染排序下拉菜单
 */
export function renderSortDropdown() {
    const sortContainer = document.getElementById('sort-container');
    if (!sortContainer) return;

    const sortOptions = {
        smart: '🧠 智能',
        name: '📝 名称',
        mtime: '📅 日期',
        viewed_desc: '👁️ 访问',
    };

    const hash = window.location.hash;
    const questionMarkIndex = hash.indexOf('?');
    const urlParams = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
    const currentSort = urlParams.get('sort') || 'smart';



    // 确定当前应该高亮的选项
    function getCurrentOption(sortValue) {
        if (sortValue === 'name_asc' || sortValue === 'name_desc') return 'name';
        if (sortValue === 'mtime_asc' || sortValue === 'mtime_desc') return 'mtime';
        return sortValue;
    }

    // 获取排序显示文本的函数
    function getSortDisplayText(sortValue) {
        switch (sortValue) {
            case 'smart': return '智能';
            case 'name_asc': return '名称↑';
            case 'name_desc': return '名称↓';
            case 'mtime_desc': return '日期↓';
            case 'mtime_asc': return '日期↑';
            case 'viewed_desc': return '访问↓';
            default: return '智能';
        }
    }

    // 确定当前应该高亮的选项
    function getCurrentOption(sortValue) {
        if (sortValue === 'name_asc' || sortValue === 'name_desc') return 'name';
        if (sortValue === 'mtime_asc' || sortValue === 'mtime_desc') return 'mtime';
        return sortValue;
    }

    const currentOption = getCurrentOption(currentSort);

    sortContainer.innerHTML = `
        <div class="relative inline-flex items-center">
            <button id="sort-button" class="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block w-20 p-1.5 sm:p-2.5 transition-colors hover:border-purple-500 cursor-pointer flex items-center justify-between">
                <span id="sort-display">${getSortDisplayText(currentSort)}</span>
                <svg class="w-3 h-3 sm:w-4 sm:h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                </svg>
            </button>
            <div id="sort-dropdown" class="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50 hidden w-full">
                ${Object.entries(sortOptions).map(([value, label]) => `
                    <button class="sort-option w-full text-left px-3 py-2 text-sm text-white hover:bg-gray-700 transition-colors ${currentOption === value ? 'bg-purple-600' : ''}" data-value="${value}">
                        ${label}
                    </button>
                `).join('')}
            </div>
        </div>
    `;

    const sortButton = document.getElementById('sort-button');
    const sortDropdown = document.getElementById('sort-dropdown');
    const sortDisplay = document.getElementById('sort-display');
    
    if (sortButton && sortDropdown) {
        // 切换下拉菜单显示
        sortButton.addEventListener('click', (e) => {
            e.stopPropagation();
            sortDropdown.classList.toggle('hidden');
        });
        
        // 处理选项点击
        const sortOptions = sortDropdown.querySelectorAll('.sort-option');
        sortOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                let newSort = option.dataset.value;
                
                // 处理名称和日期的升序/降序切换
                if (newSort === 'name') {
                    // 如果当前是名称升序，切换到降序；否则切换到升序
                    newSort = currentSort === 'name_asc' ? 'name_desc' : 'name_asc';
                } else if (newSort === 'mtime') {
                    // 如果当前是日期降序，切换到升序；否则切换到降序
                    newSort = currentSort === 'mtime_desc' ? 'mtime_asc' : 'mtime_desc';
                }
                
                const currentHash = window.location.hash.split('?')[0];
                const newHash = `${currentHash}?sort=${newSort}`;
                
                // 更新显示文本
                const displayText = getSortDisplayText(newSort);
                sortDisplay.textContent = displayText;
                
                // 更新选中状态
                sortOptions.forEach(opt => opt.classList.remove('bg-purple-600'));
                option.classList.add('bg-purple-600');
                
                // 隐藏下拉菜单
                sortDropdown.classList.add('hidden');
                
                // 避免无限循环：只有当hash真正改变时才更新
                if (window.location.hash !== newHash) {
                    window.location.hash = newHash;
                }
            });
        });
        
        // 点击外部关闭下拉菜单
        document.addEventListener('click', (e) => {
            if (!sortButton.contains(e.target) && !sortDropdown.contains(e.target)) {
                sortDropdown.classList.add('hidden');
            }
        });
        
        // 键盘导航支持
        sortButton.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                sortDropdown.classList.toggle('hidden');
            }
        });
    }
}

/**
 * 检查路径是否包含媒体文件
 * @param {string} path - 路径
 * @returns {Promise<boolean>} 是否包含媒体文件
 */
export async function checkIfHasMediaFiles(path) {
    try {
        const api = await import('./api.js');
        const data = await api.fetchBrowseResults(path, 1, new AbortController().signal);
        if (!data || !data.items) return false;
        
        // 检查是否有媒体文件（照片或视频）
        return data.items.some(item => item.type === 'photo' || item.type === 'video');
    } catch (error) {
        // 静默处理错误，避免在控制台显示警告
        return false;
    }
}

/**
 * 渲染搜索网格
 * @param {Array} results - 搜索结果数组
 * @param {number} currentPhotoCount - 当前照片数量
 * @returns {Object} 包含HTML内容和媒体URL数组的对象
 */
export function renderSearchGrid(results, currentPhotoCount) {
    let contentHtml = '';
    const newMediaUrls = [];

    // 遍历搜索结果并生成HTML
    results.forEach(result => {
        if (result.type === 'album') {
            contentHtml += displayAlbum(result);
        } else if (result.type === 'photo' || result.type === 'video') {
            const mediaIndex = currentPhotoCount + newMediaUrls.length;
            contentHtml += displaySearchMedia(result, mediaIndex);
            newMediaUrls.push(result.originalUrl);
        }
    });

    return { contentHtml, newMediaUrls };
}