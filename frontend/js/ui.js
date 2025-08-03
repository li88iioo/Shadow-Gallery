// frontend/js/ui.js

import { elements } from './state.js';
import { getAllViewed } from './indexeddb-helper.js';

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
    
    // 创建首页链接
    const homeLink = `<a href="#/" class="text-purple-400 hover:text-purple-300">首页</a>`;
    
    // 创建路径链接
    const pathLinks = parts.map((part, index) => {
        currentPath += (currentPath ? '/' : '') + part;
        const isLast = index === parts.length - 1;
        return isLast 
            ? `<span class="text-white">${decodeURIComponent(part)}</span>` 
            : `<a href="#/${encodeURIComponent(currentPath)}" class="text-purple-400 hover:text-purple-300">${decodeURIComponent(part)}</a>`;
    });
    
    // 组合面包屑导航HTML
    elements.breadcrumbNav.innerHTML = [homeLink, ...pathLinks].join('<span class="mx-2">/</span>');
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
    
    return `<div class="grid-item album-link" data-path="${album.path}" data-width="${album.coverWidth || 1}" data-height="${album.coverHeight || 1}">
                <a href="#/${encodeURIComponent(album.path)}" class="album-card group block bg-gray-800 rounded-lg overflow-hidden shadow-lg hover:shadow-purple-500/30 transition-shadow">
                    <div class="relative" style="aspect-ratio: ${aspectRatio};">
                        <div class="image-placeholder absolute inset-0"></div>
                        <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${album.coverUrl}" alt="${album.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300">
                        ${timeText ? `<div class="absolute bottom-2 right-2 bg-black/50 text-white text-sm px-2 py-1 rounded shadow-lg">${timeText}</div>` : ''}
                    </div>
                    <div class="p-2 sm:p-4">
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
                            ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="Video Thumbnail" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` 
                            : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="Photo" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300">`
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
                            ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${result.thumbnailUrl}" alt="Video Thumbnail: ${result.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` 
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