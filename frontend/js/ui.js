// frontend/js/ui.js

import { elements } from './state.js';
import { getAllViewed } from './indexeddb-helper.js';

export function renderBreadcrumb(path) {
    const parts = path ? path.split('/').filter(p => p) : [];
    let currentPath = '';
    const homeLink = `<a href="#/" onclick="this.blur()" class="text-purple-400 hover:text-purple-300">首页</a>`;
    const pathLinks = parts.map((part, index) => {
        currentPath += (currentPath ? '/' : '') + part;
        const isLast = index === parts.length - 1;
        return isLast ? `<span class="text-white">${decodeURIComponent(part)}</span>` : `<a href="#/${encodeURIComponent(currentPath)}" onclick="this.blur()" class="text-purple-400 hover:text-purple-300">${decodeURIComponent(part)}</a>`;
    });
    elements.breadcrumbNav.innerHTML = [homeLink, ...pathLinks].join('<span class="mx-2">/</span>');
}

export function displayAlbum(album) {
    const aspectRatio = album.coverHeight ? album.coverWidth / album.coverHeight : 1;
    // 移除了 onerror 和 onload
    return `<div class="grid-item" data-width="${album.coverWidth || 1}" data-height="${album.coverHeight || 1}"><a href="#/${encodeURIComponent(album.path)}" onclick="navigateToAlbum(event, '${album.path}')" class="album-card group block bg-gray-800 rounded-lg overflow-hidden shadow-lg hover:shadow-purple-500/30 transition-shadow" data-album-path="${album.path}"><div class="relative" style="aspect-ratio: ${aspectRatio};"><div class="image-placeholder absolute inset-0"></div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${album.coverUrl}" alt="${album.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300"></div><div class="p-2 sm:p-4"><h3 class="font-bold text-sm sm:text-lg truncate group-hover:text-purple-300">📁 ${album.name}</h3></div></a></div>`;
}

export function displayStreamedMedia(type, mediaData, index) {
    const isVideo = type === 'video';
    const aspectRatio = mediaData.height ? mediaData.width / mediaData.height : 1;
    // 移除了 onerror 和 onload
    return `<div class="grid-item" data-width="${mediaData.width}" data-height="${mediaData.height}"><div class="photo-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer" onclick="handleThumbnailClick(this, '${mediaData.originalUrl}', ${index})"><div class="relative w-full h-full" style="aspect-ratio: ${aspectRatio}"><div class="image-placeholder absolute inset-0"></div><div class="loading-overlay"><svg class="progress-circle" viewBox="0 0 20 20"><circle class="progress-circle-track" cx="10" cy="10" r="8" stroke-width="2"></circle><circle class="progress-circle-bar" cx="10" cy="10" r="8" stroke-width="2"></circle></svg></div>${isVideo ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="Video Thumbnail" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${mediaData.thumbnailUrl}" alt="Photo" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300">`}</div></div></div>`;
}

export function displaySearchMedia(result, index) {
    const isVideo = result.type === 'video';
    // 移除了 onerror 和 onload
    return `<div class="grid-item"><div class="photo-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer" onclick="handleThumbnailClick(this, '${result.originalUrl}', ${index})"><div class="aspect-w-1 aspect-h-1 relative"><div class="image-placeholder absolute inset-0"></div><div class="loading-overlay"><svg class="progress-circle" viewBox="0 0 20 20"><circle class="progress-circle-track" cx="10" cy="10" r="8" stroke-width="2"></circle><circle class="progress-circle-bar" cx="10" cy="10" r="8" stroke-width="2"></circle></svg></div>${isVideo ? `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${result.thumbnailUrl}" alt="Video Thumbnail: ${result.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300"><div class="video-thumbnail-overlay"><div class="video-play-button"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg></div></div>` : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E" data-src="${result.thumbnailUrl}" alt="${result.name}" class="w-full h-full object-cover absolute inset-0 lazy-image opacity-0 transition-opacity duration-300">`}</div></div><div class="mt-2"><p class="text-xs text-gray-400 truncate">${result.name}</p></div></div>`;
}

export function renderBrowseGrid(items, currentPhotoCount) {
    let contentHtml = '';
    const newMediaUrls = [];

    items.forEach(item => {
        const itemData = item.data;
        if (item.type === 'album') {
            contentHtml += displayAlbum(itemData);
        } else {
            const mediaIndex = currentPhotoCount + newMediaUrls.length;
            contentHtml += displayStreamedMedia(item.type, itemData, mediaIndex);
            newMediaUrls.push(itemData.originalUrl);
        }
    });

    return { contentHtml, newMediaUrls };
}

export function renderSearchGrid(results, currentPhotoCount) {
    let contentHtml = '';
    const newMediaUrls = [];

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
