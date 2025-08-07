// frontend/js/router.js

import { state, elements } from './state.js';
import { applyMasonryLayout, getMasonryColumns, initializeVirtualScroll } from './masonry.js';
import { setupLazyLoading } from './lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import { renderBreadcrumb, renderBrowseGrid, renderSearchGrid, sortAlbumsByViewed, renderSortDropdown, checkIfHasMediaFiles } from './ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from './indexeddb-helper.js';
import { handleBrowseScroll, handleSearchScroll, removeScrollListeners } from './listeners.js';
import { showBrowseLoading, showSearchLoading, showNetworkError, showEmptySearchResults, showEmptyAlbum, showIndexBuildingError, showIndexBuildingState } from './loading-states.js';


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
    
    // 分离路径和查询参数
    const questionMarkIndex = newDecodedPath.indexOf('?');
    const pathOnly = questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
    let newSortParam = questionMarkIndex !== -1 ? newDecodedPath.substring(questionMarkIndex) : '';
    
    // 如果newSortParam以?sort=开头，提取排序值
    if (newSortParam.startsWith('?sort=')) {
        newSortParam = newSortParam.substring(6); // 移除 '?sort=' 前缀
    }

    // 检查路径是否改变
    const pathChanged = pathOnly !== state.currentBrowsePath;
    
    // 检查排序参数是否改变
    // 如果路径改变但没有新的排序参数，保持之前的排序
    const currentSortValue = newSortParam || (pathChanged ? (state.currentSort || 'smart') : 'smart');
    const previousSort = state.currentSort || 'smart';
    const sortChanged = currentSortValue !== previousSort;
    

    
    // 如果路径和排序参数都未变化且非初始加载，则跳过
    if (!pathChanged && !sortChanged && !state.isInitialLoad) {
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
        // 更新排序状态
        state.currentSort = currentSortValue;
        
        // 记录进入页面时的排序方式
        if (pathChanged) {
            // 路径改变时，记录进入新页面时的排序
            state.entrySort = currentSortValue;
        } else if (sortChanged) {
            // 如果只是排序改变（路径没变），更新entrySort为当前排序
            // 这样在同一页面内改变排序时，面包屑会使用当前排序
            state.entrySort = currentSortValue;
        }
        
        await streamPath(pathOnly, currentRequestController.signal);
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
    
    // 显示浏览加载状态
    showBrowseLoading();
    
    renderBreadcrumb(path);
    
    // 只在浏览目录时显示排序控件（排除最终相册页面和搜索页面）
    if (path.startsWith('search?q=')) {
        // 搜索页面，不显示排序控件
        const sortContainer = document.getElementById('sort-container');
        if (sortContainer) {
            sortContainer.innerHTML = '';
        }
    } else {
        // 检查是否为最终相册页面
        const hasMediaFiles = await checkIfHasMediaFiles(path);
        if (hasMediaFiles) {
            // 最终相册页面，不显示排序控件
            const sortContainer = document.getElementById('sort-container');
            if (sortContainer) {
                sortContainer.innerHTML = '';
            }
        } else {
            // 目录页面，显示排序控件
            renderSortDropdown();
        }
    }
    
    window.addEventListener('scroll', handleBrowseScroll);

    // 记录相册访问
    await onAlbumViewed(path);

    try {
        // 检查是否为搜索页面
        if (path.startsWith('search?q=')) {
            // 搜索页面应该使用 executeSearch 函数，不应该调用 streamPath
            console.error('搜索页面不应该调用 streamPath 函数');
            return;
        }
        
        const data = await fetchBrowseResults(path, state.currentBrowsePage, signal);
        if (!data || signal.aborted) return; 

        state.currentBrowsePath = path;
        
        state.totalBrowsePages = data.totalPages;
        
        // 处理空文件夹或正在索引的情况
        if (!data.items || data.items.length === 0) {
            if (data.indexStatus && data.indexStatus.status === 'building') {
                showIndexBuildingState();
            } else {
                showEmptyAlbum();
            }
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
        if (error.name !== 'AbortError') {
            console.error("Failed to stream path:", error);
            showNetworkError();
            // 网络错误时不重置minHeight，让错误状态保持
            return;
        }
    } finally {
        state.isBrowseLoading = false;
        // 只有在非错误状态下才重置minHeight
        if (!elements.contentGrid.classList.contains('error-container')) {
            elements.contentGrid.style.minHeight = '';
        }
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
    
    // 显示搜索加载状态
    showSearchLoading();
    
    window.addEventListener('scroll', handleSearchScroll);

    try {
        const data = await fetchSearchResults(query, state.currentSearchPage, signal);
        if (signal.aborted) return;

        // 检查数据完整性
        if (!data || !data.results) {
            console.error('搜索返回数据不完整:', data);
            showNetworkError();
            return;
        }

        const searchPathKey = `search?q=${query}`;
        state.currentBrowsePath = searchPathKey; // 将搜索也视为一种路径
        
        // 渲染搜索面包屑导航
        elements.breadcrumbNav.innerHTML = `
           <div class="flex items-center">
               <a href="${state.preSearchHash}" class="flex items-center text-purple-400 hover:text-purple-300 transition-colors duration-200 group">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                   返回
               </a>
               ${data.results.length > 0 ? `<span class="mx-3 text-gray-600">/</span><span class="text-white">搜索结果: "${data.query || query}" (${data.totalResults || 0}项)</span>` : ''}
           </div>`;

       // 处理无搜索结果情况
       if (data.results.length === 0) {
           showEmptySearchResults(query);
           removeScrollListeners(); // 移除滚动监听，防止触发无限加载
           elements.contentGrid.style.minHeight = ''; // 重置高度
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
        if (error.name !== 'AbortError') {
            console.error("Failed to execute search:", error);
            
            // 检查是否为搜索索引构建中的错误
            if (error.message && error.message.includes('搜索索引正在构建中')) {
                // 显示特定的索引构建错误状态
                showIndexBuildingError();
            } else {
                // 显示通用网络错误
                showNetworkError();
            }
            
            // 网络错误时不重置minHeight，让错误状态保持
            return;
        }
    } finally {
        state.isSearchLoading = false;
        // 只有在非错误状态下才重置minHeight
        if (!elements.contentGrid.classList.contains('error-container')) {
            elements.contentGrid.style.minHeight = '';
        }
    }
}


// --- 辅助函数 ---
/**
 * 准备新内容加载
 * 重置页面状态、清空内容、显示加载指示器
 */
function prepareForNewContent() {
    const scroller = state.get('virtualScroller');
    if (scroller) {
        scroller.destroy();
        state.update('virtualScroller', null);
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
    elements.contentGrid.style.minHeight = `${elements.contentGrid.offsetHeight}px`;
    elements.contentGrid.innerHTML = '';
    elements.contentGrid.classList.remove('masonry-mode');
    elements.contentGrid.style.height = 'auto';
    elements.infiniteScrollLoader.classList.add('hidden');
    state.update('currentPhotos', []);
}

/**
 * 完成新内容加载后的收尾工作
 * @param {string} pathKey - 路径键名，用于恢复滚动位置
 */
function finalizeNewContent(pathKey) {
    // 只有在非虚拟滚动模式下才需要手动调用懒加载和瀑布流
    if (!state.get('virtualScroller')) {
        setupLazyLoading();
        applyMasonryLayout();
    }
    
    sortAlbumsByViewed();
    state.update('currentColumnCount', getMasonryColumns());
    
    // 恢复滚动位置
    const scrollY = state.get('scrollPositions').get(pathKey);
    if (scrollY) {
        window.scrollTo({ top: scrollY, behavior: 'instant' });
        state.get('scrollPositions').delete(pathKey);
    } else if (state.get('isInitialLoad')) {
        window.scrollTo({ top: 0, behavior: 'instant' });
    }
    
    // 无论如何，在最后都重置minHeight
    elements.contentGrid.style.minHeight = '';
    state.update('isInitialLoad', false);
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