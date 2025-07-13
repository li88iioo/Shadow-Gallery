// frontend/js/router.js

import { state, elements } from './state.js';
import { applyMasonryLayout, getMasonryColumns } from './masonry.js';
import { setupLazyLoading } from './lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import { renderBreadcrumb, renderBrowseGrid, renderSearchGrid, sortAlbumsByViewed } from './ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from './indexeddb-helper.js';
import { handleBrowseScroll, handleSearchScroll, removeScrollListeners } from './listeners.js';

/**
 * 路由管理模块
 * 负责处理前端路由、页面导航、内容加载和状态管理
 */

let currentRequestController = null;  // 当前请求的中止控制器

/**
 * 初始化路由系统
 * 设置哈希变化监听器并处理初始路由
 */
export function initializeRouter() {
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

/**
 * 核心路由处理函数
 * 根据URL哈希变化加载相应内容，支持浏览和搜索两种模式
 */
export async function handleHashChange() {
    // 保存当前路径的滚动位置
    if (typeof state.currentBrowsePath === 'string') {
        const key = state.currentBrowsePath;
        state.scrollPositions.set(key, window.scrollY);
    }
    
    // 中止之前的请求
    if (currentRequestController) {
        currentRequestController.abort();
    }
    currentRequestController = new AbortController();

    // 解析新的路径
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));

    // 如果路径未变化且非初始加载，则跳过
    if (newDecodedPath === state.currentBrowsePath && !state.isInitialLoad) {
        return;
    }

    removeScrollListeners();

    // 处理搜索路径的返回链接
    if (cleanHashString.startsWith('#/search?q=')) {
        if (!state.currentBrowsePath || !state.currentBrowsePath.startsWith('search?q=')) {
            state.preSearchHash = state.currentBrowsePath ? `#/${encodeURIComponent(state.currentBrowsePath)}` : '#/';
        }
    }

    // 根据路径类型执行相应操作
    if (newDecodedPath.startsWith('search?q=')) {
        const urlParams = new URLSearchParams(newDecodedPath.substring(newDecodedPath.indexOf('?')));
        const query = urlParams.get('q');
        await executeSearch(query || '', currentRequestController.signal);
    } else {
        await streamPath(newDecodedPath, currentRequestController.signal);
    }
}

/**
 * 加载浏览页面内容
 * @param {string} path - 要浏览的路径
 * @param {AbortSignal} signal - 请求中止信号
 */
export async function streamPath(path, signal) {
    prepareForNewContent();
    state.isBrowseLoading = true;
    state.currentBrowsePage = 1;
    state.totalBrowsePages = 1;
    renderBreadcrumb(path);
    window.addEventListener('scroll', handleBrowseScroll);

    // 记录相册访问
    await onAlbumViewed(path);

    try {
        const data = await fetchBrowseResults(path, state.currentBrowsePage, signal);
        if (!data || signal.aborted) return; 

        state.currentBrowsePath = path;
        state.totalBrowsePages = data.totalPages;
        
        // 处理空文件夹情况
        if (data.items.length === 0) {
            elements.contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">这个文件夹是空的。</p>';
            return;
        }

        // 渲染内容网格
        elements.contentGrid.classList.add('masonry-mode');
        const { contentHtml, newMediaUrls } = renderBrowseGrid(data.items, 0);
        elements.contentGrid.innerHTML = contentHtml;
        
        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage++;
        
        finalizeNewContent(path);

    } catch (error) {
        if (error.name !== 'AbortError') console.error("Failed to stream path:", error);
    } finally {
        state.isBrowseLoading = false;
        elements.loadingIndicator.classList.add('hidden');
        elements.contentGrid.style.minHeight = '';
    }
}

/**
 * 执行搜索并加载搜索结果
 * @param {string} query - 搜索查询
 * @param {AbortSignal} signal - 请求中止信号
 */
async function executeSearch(query, signal) {
    prepareForNewContent();
    state.currentPhotos = [];
    state.currentSearchQuery = query;
    state.currentSearchPage = 1;
    state.totalSearchPages = 1;
    state.isSearchLoading = true;
    window.addEventListener('scroll', handleSearchScroll);

    try {
        const data = await fetchSearchResults(query, state.currentSearchPage, signal);
        if (signal.aborted) return;

        const searchPathKey = `search?q=${query}`;
        state.currentBrowsePath = searchPathKey; // 将搜索也视为一种路径
        
        // 渲染搜索面包屑导航
        elements.breadcrumbNav.innerHTML = `
           <div class="flex items-center">
               <a href="${state.preSearchHash}" class="flex items-center text-purple-400 hover:text-purple-300 transition-colors duration-200 group">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                   返回
               </a>
               ${data.results.length > 0 ? `<span class="mx-3 text-gray-600">/</span><span class="text-white">搜索结果: "${data.query}" (${data.totalResults}项)</span>` : ''}
           </div>`;

       // 处理无搜索结果情况
       if (data.results.length === 0) {
           elements.contentGrid.innerHTML = '<p class="text-center text-gray-500 col-span-full">没有找到相关结果。</p>';
           return;
       }

        // 渲染搜索结果网格
        elements.contentGrid.classList.add('masonry-mode');
        const { contentHtml, newMediaUrls } = renderSearchGrid(data.results, 0);
        elements.contentGrid.innerHTML = contentHtml;
        
        state.totalSearchPages = data.totalPages;
        state.currentPhotos = newMediaUrls;
        state.currentSearchPage++;

        finalizeNewContent(searchPathKey); // 使用搜索路径作为Key

    } catch (error) {
        if (error.name !== 'AbortError') console.error("Failed to execute search:", error);
    } finally {
        state.isSearchLoading = false;
        elements.loadingIndicator.classList.add('hidden');
    }
}


// --- 辅助函数 ---
/**
 * 准备新内容加载
 * 重置页面状态、清空内容、显示加载指示器
 */
function prepareForNewContent() {
    window.scrollTo({ top: 0, behavior: 'instant' });
    elements.contentGrid.style.minHeight = `${elements.contentGrid.offsetHeight}px`;
    elements.contentGrid.innerHTML = '';
    elements.contentGrid.classList.remove('masonry-mode');
    elements.contentGrid.style.height = 'auto';
    elements.loadingIndicator.classList.remove('hidden');
    elements.infiniteScrollLoader.classList.add('hidden');
    state.currentPhotos = [];
}

/**
 * 完成新内容加载后的收尾工作
 * @param {string} pathKey - 路径键名，用于恢复滚动位置
 */
function finalizeNewContent(pathKey) {
    setupLazyLoading();
    applyMasonryLayout();
    sortAlbumsByViewed();
    state.currentColumnCount = getMasonryColumns();
    
    // 恢复滚动位置
    if (state.scrollPositions.has(pathKey)) {
        window.scrollTo({ top: state.scrollPositions.get(pathKey), behavior: 'instant' });
        state.scrollPositions.delete(pathKey);
    } else if (state.isInitialLoad) {
        window.scrollTo({ top: 0, behavior: 'instant' });
    }
    
    state.isInitialLoad = false;
}

/**
 * 记录相册访问历史
 * @param {string} path - 相册路径
 */
async function onAlbumViewed(path) {
    if (!path) return; // 根目录不记录
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

/**
 * 网络恢复时自动补同步离线访问记录
 */
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