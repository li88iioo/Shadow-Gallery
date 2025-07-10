// frontend/js/main.js

import { state, elements, backdrops } from './state.js';
import { applyMasonryLayout, getMasonryColumns, applyMasonryLayoutIncremental } from './masonry.js';
import { setupLazyLoading } from './lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import { renderBreadcrumb, renderBrowseGrid, renderSearchGrid } from './ui.js';
import { closeModal, navigateModal, _openModal, _handleThumbnailClick, _navigateToAlbum } from './modal.js';
import { SwipeHandler } from './touch.js';
import { initializeAuth } from './auth.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from './indexeddb-helper.js';

// 初始化用户身份，并将其存储在全局状态中
state.userId = initializeAuth();


if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

window.handleThumbnailClick = _handleThumbnailClick;
window.openModal = _openModal;
window.navigateToAlbum = _navigateToAlbum;

async function handleHashChange() {
    if (typeof state.currentBrowsePath === 'string') {
        state.scrollPositions.set(state.currentBrowsePath, window.scrollY);
    }
    
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));

    if (newDecodedPath === state.currentBrowsePath) {
        return;
    }

    window.removeEventListener('scroll', handleScroll);
    window.removeEventListener('scroll', handleBrowseScroll);

    if (cleanHashString.startsWith('#/search?q=')) {
        if (!state.currentBrowsePath || !state.currentBrowsePath.startsWith('search?q=')) {
            state.preSearchHash = state.currentBrowsePath ? `#/${encodeURIComponent(state.currentBrowsePath)}` : '#/';
        }
    }

    state.currentBrowsePath = newDecodedPath;

    if (state.currentBrowsePath.startsWith('search?q=')) {
        const urlParams = new URLSearchParams(state.currentBrowsePath.substring(state.currentBrowsePath.indexOf('?')));
        const query = urlParams.get('q');
        executeSearch(query || '');
    } else {
        streamPath(state.currentBrowsePath);
    }
}

function performSearch(query) {
    window.location.hash = `/search?q=${encodeURIComponent(query)}`;
}

async function executeSearch(query) {
    window.scrollTo({ top: 0, behavior: 'instant' }); 

    elements.contentGrid.innerHTML = '';
    elements.contentGrid.classList.remove('masonry-mode');
    elements.contentGrid.style.height = 'auto';
    elements.loadingIndicator.classList.remove('hidden');
    elements.infiniteScrollLoader.classList.add('hidden');

    state.currentPhotos = [];
    state.currentSearchQuery = query;
    state.currentSearchPage = 1;
    state.totalSearchPages = 1;
    state.isSearchLoading = true;

    window.removeEventListener('scroll', handleScroll);
    window.addEventListener('scroll', handleScroll);

    try {
        const data = await fetchSearchResults(query, state.currentSearchPage);

        elements.breadcrumbNav.innerHTML = `
           <div class="flex items-center">
               <a href="${state.preSearchHash}" class="flex items-center text-purple-400 hover:text-purple-300 transition-colors duration-200 group">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                   返回
               </a>
               ${data.results.length > 0 ? `<span class="mx-3 text-gray-600">/</span><span class="text-white">搜索结果: "${data.query}" (${data.totalResults}项)</span>` : ''}
           </div>`;

       if (data.results.length === 0) {
           elements.contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">没有找到相关结果。</p>';
           return;
       }

        const { contentHtml, newMediaUrls } = renderSearchGrid(data.results, state.currentPhotos.length);
        elements.contentGrid.insertAdjacentHTML('beforeend', contentHtml);

        state.totalSearchPages = data.totalPages;
        state.currentPhotos = state.currentPhotos.concat(newMediaUrls);
        state.currentSearchPage++;
        setupLazyLoading();
        // 为搜索页启用瀑布流
        elements.contentGrid.classList.add('masonry-mode');
        applyMasonryLayout();

    } catch (error) {
        console.error("Failed to execute search:", error);
    } finally {
        state.isSearchLoading = false;
        elements.loadingIndicator.classList.add('hidden');
        document.body.classList.remove('uninitialized');
    }
}

// 浏览相册/目录时，记录本地历史并同步
async function onAlbumViewed(path) {
    await saveViewed(path, Date.now(), navigator.onLine);
    if (navigator.onLine) {
        try {
            await postViewed(path);
            await markAsSynced(path);
        } catch (e) {
            // 网络异常，稍后自动补同步
        }
    }
}

// 网络恢复时自动补同步
window.addEventListener('online', async () => {
    const unsynced = await getUnsyncedViewed();
    for (const record of unsynced) {
        try {
            await postViewed(record.path);
            await markAsSynced(record.path);
        } catch (e) {
            // 失败下次再试
        }
    }
});

async function streamPath(path) {
    if (state.currentAbortController) state.currentAbortController.abort();
    state.currentAbortController = new AbortController();
    
    elements.contentGrid.style.minHeight = `${elements.contentGrid.scrollHeight}px`;
    
    elements.contentGrid.innerHTML = '';
    elements.contentGrid.classList.remove('masonry-mode');
    elements.contentGrid.style.height = 'auto';
    elements.loadingIndicator.classList.remove('hidden');
    elements.infiniteScrollLoader.classList.add('hidden');
    
    state.currentPhotos = [];
    state.isBrowseLoading = true;
    state.currentBrowsePage = 1;
    state.totalBrowsePages = 1;
    state.currentBrowsePath = path;

    renderBreadcrumb(state.currentBrowsePath);
    window.removeEventListener('scroll', handleBrowseScroll);
    window.addEventListener('scroll', handleBrowseScroll);

    await onAlbumViewed(state.currentBrowsePath);

    try {
        const data = await fetchBrowseResults(state.currentBrowsePath, state.currentBrowsePage, state.currentAbortController.signal);
        if (!data) return; 

        state.totalBrowsePages = data.totalPages;
        if (data.items.length === 0) {
            elements.contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">这个文件夹是空的。</p>';
            return;
        }

        // 强制启用瀑布流模式
        elements.contentGrid.classList.add('masonry-mode');

        // 用高亮渲染
        const { contentHtml, newMediaUrls } = renderBrowseGrid(data.items, state.currentPhotos.length);
        elements.contentGrid.insertAdjacentHTML('beforeend', contentHtml);
        
        state.currentPhotos = state.currentPhotos.concat(newMediaUrls);
        state.currentBrowsePage++;
        
        setupLazyLoading();
        applyMasonryLayout();
        state.currentColumnCount = getMasonryColumns();
        
        // 【最终修复】区分首次加载和后续导航的滚动行为
        if (state.scrollPositions.has(path)) {
            // 如果是“返回”，则恢复到离开时的位置
            window.scrollTo({ top: state.scrollPositions.get(path), behavior: 'instant' });
            state.scrollPositions.delete(path);
        } else {
            // 如果是“进入新页面”
            if (state.isInitialLoad) {
                // 首次加载网站，从最顶部开始
                window.scrollTo({ top: 0, behavior: 'instant' });
                state.isInitialLoad = false; // 关闭首次加载开关
            } else {
                // 后续进入新页面，从面包屑导航开始
                elements.breadcrumbNav.scrollIntoView({ behavior: 'instant', block: 'start' });
            }
        }

    } catch (error) {
        console.error("Failed to stream path:", error);
    } finally {
        state.isBrowseLoading = false;
        elements.loadingIndicator.classList.add('hidden');
        elements.contentGrid.style.minHeight = '';
    }
}

async function handleBrowseScroll() {
    if (state.isBrowseLoading || state.currentBrowsePage > state.totalBrowsePages) return;
    if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) {
        state.isBrowseLoading = true;
        elements.infiniteScrollLoader.classList.remove('hidden');
        try {
            const data = await fetchBrowseResults(state.currentBrowsePath, state.currentBrowsePage, state.currentAbortController.signal);
            if (!data || data.items.length === 0) return;
            state.totalBrowsePages = data.totalPages;
            const prevCount = elements.contentGrid.children.length;
            const { contentHtml, newMediaUrls } = renderBrowseGrid(data.items, state.currentPhotos.length);
            elements.contentGrid.insertAdjacentHTML('beforeend', contentHtml);
            state.currentPhotos = state.currentPhotos.concat(newMediaUrls);
            state.currentBrowsePage++;
            setupLazyLoading();
            const allItems = Array.from(elements.contentGrid.children);
            const newItems = allItems.slice(prevCount);
            applyMasonryLayoutIncremental(newItems);
        } catch (error) {
            if (error.name !== 'AbortError') console.error("Failed to fetch more items:", error);
        } finally {
            state.isBrowseLoading = false;
            elements.infiniteScrollLoader.classList.add('hidden');
        }
    }
}

async function handleScroll() {
    if (state.isSearchLoading || state.currentSearchPage > state.totalSearchPages) return;
    if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) {
        state.isSearchLoading = true;
        elements.infiniteScrollLoader.classList.remove('hidden');
        try {
            const data = await fetchSearchResults(state.currentSearchQuery, state.currentSearchPage);
            if (!data || data.results.length === 0) return;
            state.totalSearchPages = data.totalPages;
            const prevCount = elements.contentGrid.children.length;
            const { contentHtml, newMediaUrls } = renderSearchGrid(data.results, state.currentPhotos.length);
            elements.contentGrid.insertAdjacentHTML('beforeend', contentHtml);
            state.currentPhotos = state.currentPhotos.concat(newMediaUrls);
            state.currentSearchPage++;
            setupLazyLoading();
            const allItems = Array.from(elements.contentGrid.children);
            const newItems = allItems.slice(prevCount);
            applyMasonryLayoutIncremental(newItems);
        } catch (error) {
            console.error("Failed to fetch more search results:", error);
        } finally {
            state.isSearchLoading = false;
            elements.infiniteScrollLoader.classList.add('hidden');
        }
    }
}

function setupEventListeners() {
    window.addEventListener('hashchange', handleHashChange);
    if (elements.searchInput) {
        elements.searchInput.addEventListener('input', (e) => {
            clearTimeout(state.searchDebounceTimer);
            const query = e.target.value;
            state.searchDebounceTimer = setTimeout(() => {
                if (query.trim()) {
                    performSearch(query);
                } else if (window.location.hash.includes('search?q=')) {
                    window.location.hash = state.preSearchHash || '#/';
                }
            }, 800);
        });
    }
    window.addEventListener('popstate', (event) => {
        if (!window.location.hash.endsWith('#modal')) {
            if (!elements.modal.classList.contains('opacity-0')) {
                closeModal();
            }
        }
    });
    elements.modalClose.addEventListener('click', () => {
        if (window.location.hash.endsWith('#modal')) {
            window.history.back();
        }
    });
    elements.mediaPanel.addEventListener('click', (e) => {
        if (e.target === elements.mediaPanel) {
            if (window.location.hash.endsWith('#modal')) {
                window.history.back();
            }
        }
    });
    elements.toggleCaptionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.captionBubble.classList.toggle('show');
    });
    document.addEventListener('click', (e) => {
        if (elements.captionBubble.classList.contains('show') && !elements.captionBubble.contains(e.target) && !elements.toggleCaptionBtn.contains(e.target)) {
            elements.captionBubble.classList.remove('show');
        }
    });
    document.addEventListener('keydown', (e) => {
        if (elements.modal.classList.contains('opacity-0')) return;
        if (e.key === 'Escape') {
            if (window.location.hash.endsWith('#modal')) {
                window.history.back();
            }
        } else if (e.key === 'ArrowLeft') {
            navigateModal('prev');
        } else if (e.key === 'ArrowRight') {
            navigateModal('next');
        }
    });
    elements.modal.addEventListener('wheel', (e) => {
        if (window.innerWidth <= 768) return;
        e.preventDefault();
        const now = Date.now();
        if (now - state.lastWheelTime < 300) return;
        state.lastWheelTime = now;
        if (e.deltaY < 0) navigateModal('prev'); else navigateModal('next');
    });
    new SwipeHandler(elements.mediaPanel, {
        onSwipe: (direction) => {
            if (elements.modal.classList.contains('opacity-0')) return;
            if (direction === 'up') {
                navigateModal('next');
            } else if (direction === 'down') {
                navigateModal('prev');
            }
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key.toLowerCase() === 'b') {
            state.isBlurredMode = !state.isBlurredMode;
            document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
                media.classList.toggle('blurred', state.isBlurredMode);
            });
        }
    });
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const newColumnCount = getMasonryColumns();
            if (newColumnCount !== state.currentColumnCount) {
                state.currentColumnCount = newColumnCount;
                applyMasonryLayout();
            }
        }, 100);
    });
    const backToTopBtn = document.getElementById('back-to-top-btn');
    if (backToTopBtn) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) {
                backToTopBtn.classList.add('visible');
            } else {
                backToTopBtn.classList.remove('visible');
            }
        });
        backToTopBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(registration => {
            console.log('ServiceWorker 注册成功，作用域: ', registration.scope);
        }).catch(err => {
            console.log('ServiceWorker 注册失败: ', err);
        });
    });
}
document.addEventListener('DOMContentLoaded', () => {
    handleHashChange();
    setupEventListeners();
});