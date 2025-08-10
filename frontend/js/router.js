// frontend/js/router.js

import { state, elements } from './state.js';
import { applyMasonryLayout, getMasonryColumns, initializeVirtualScroll } from './masonry.js';
import { setupLazyLoading } from './lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import { renderBreadcrumb, renderBrowseGrid, renderSearchGrid, sortAlbumsByViewed, renderSortDropdown, checkIfHasMediaFiles } from './ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from './indexeddb-helper.js';
import { AbortBus } from './abort-bus.js';
import { handleBrowseScroll, handleSearchScroll, removeScrollListeners } from './listeners.js';
import { showNetworkError, showEmptySearchResults, showEmptyAlbum, showIndexBuildingError, showSkeletonGrid } from './loading-states.js';


/**
 * 路由管理模块
 * 负责处理前端路由、页面导航、内容加载和状态管理
 */

let currentRequestController = null;  // 当前请求的中止控制器（保持但不再直接使用）

// 获取当前哈希对应的路径（不含查询）
function getPathOnlyFromHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    const questionMarkIndex = newDecodedPath.indexOf('?');
    return questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
}

/**
 * 初始化路由系统
 * 设置哈希变化监听器并处理初始路由
 */
export function initializeRouter() {
    // 恢复会话滚动缓存（最多50条）
    try {
        const raw = sessionStorage.getItem('sg_scroll_positions');
        if (raw) {
            const obj = JSON.parse(raw);
        const entries = Object.entries(obj).slice(-200);
            const map = new Map(entries);
            state.update('scrollPositions', map);
        }
        const pre = sessionStorage.getItem('sg_pre_search_hash');
        if (pre) state.update('preSearchHash', pre);
    } catch {}

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

/**
 * 核心路由处理函数
 * 根据URL哈希变化加载相应内容，支持浏览和搜索两种模式
 */
export async function handleHashChange() {
    // 保留原有逻辑：在路由变更前保存一次滚动位置（用于SPA内路由切换）
    if (typeof state.currentBrowsePath === 'string') {
        const key = state.currentBrowsePath;
        state.scrollPositions.set(key, window.scrollY);
    }
    
    // 统一中止上一页的主请求与分页请求，并为本次路由创建新的页级信号
    AbortBus.abortMany(['page','scroll']);
    const pageSignal = AbortBus.next('page');

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
    

    
    // 如果路径和排序参数都未变化且非初始加载，则仅在已有内容时跳过；
    // 当内容区为空或仅有骨架时，强制继续执行以自愈异常状态。
    if (!pathChanged && !sortChanged && !state.isInitialLoad) {
        const hasRealContent = !!(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
        const hasSkeleton = !!document.getElementById('skeleton-grid');
        if (hasRealContent) {
            return;
        }
        // 没有真实内容（空白或仅骨架），继续向下加载当前路径
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
        await executeSearch(query || '', pageSignal);
    } else {
        // 更新排序状态
        state.currentSort = currentSortValue;
        // 提前同步当前路径与面包屑，避免长耗时请求期间显示旧路径
        state.currentBrowsePath = pathOnly;
        renderBreadcrumb(pathOnly);
        
        // 记录进入页面时的排序方式
        if (pathChanged) {
            // 路径改变时，记录进入新页面时的排序
            state.entrySort = currentSortValue;
        } else if (sortChanged) {
            // 如果只是排序改变（路径没变），更新entrySort为当前排序
            // 这样在同一页面内改变排序时，面包屑会使用当前排序
            state.entrySort = currentSortValue;
        }
        
        // 启动主加载
        await streamPath(pathOnly, pageSignal);

        // 自愈守护：若一定时间后仍无真实内容且仍处于同一路由，则自动重试一次
        try {
            setTimeout(async () => {
                const stillSameRoute = getPathOnlyFromHash() === pathOnly && AbortBus.get('page') === pageSignal;
                const noRealContent = !(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
                const notError = !(elements.contentGrid && elements.contentGrid.classList.contains('error-container'));
                if (stillSameRoute && noRealContent && notError) {
                    const retrySignal = AbortBus.next('page');
                    await streamPath(pathOnly, retrySignal);
                }
            }, 6000);
        } catch {}
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
    
    // 不在此处清空内容区域，交由 prepareForNewContent 统一处理（保留骨架占位）
    
    renderBreadcrumb(path);
    
    // 预处理搜索页面
    if (path.startsWith('search?q=')) {
        console.error('搜索页面不应该调用 streamPath 函数');
        return;
    }
    
    // 并行执行多个异步操作
    window.addEventListener('scroll', handleBrowseScroll);
    
    try {
        // 并行执行：数据获取和访问记录
        const [data] = await Promise.all([
            fetchBrowseResults(path, state.currentBrowsePage, signal),
            onAlbumViewed(path) // 不等待访问记录完成
        ]);

        // 路由已切换或请求已被新的页面信号取代，丢弃过期响应
        if (!data || signal.aborted || AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        state.currentBrowsePath = path;
        state.totalBrowsePages = data.totalPages;
        
        // 处理空文件夹的情况
        if (!data.items || data.items.length === 0) {
            // 清空排序控件
            const sortContainer = document.getElementById('sort-container');
            if (sortContainer) sortContainer.innerHTML = '';
            // 空结果：重置分页信息并隐藏加载更多
            state.totalBrowsePages = 0;
            state.currentBrowsePage = 1;
            elements.infiniteScrollLoader.classList.add('hidden');
            
            showEmptyAlbum();
            return;
        }

        // 基于数据判断是否显示排序控件（避免额外API请求）
        const hasMediaFiles = data.items.some(item => item.type === 'photo' || item.type === 'video');
        const sortContainer = document.getElementById('sort-container');
        if (sortContainer) {
            if (hasMediaFiles) {
                sortContainer.innerHTML = ''; // 相册页面，不显示排序
            } else {
                renderSortDropdown(); // 目录页面，显示排序
            }
        }

        // 渲染内容网格（骨架 -> 实际内容 无缝替换）
        elements.contentGrid.classList.add('masonry-mode');
        const { contentHtml, newMediaUrls } = renderBrowseGrid(data.items, 0);
        const skeleton = document.getElementById('skeleton-grid');
        if (skeleton) {
            skeleton.outerHTML = contentHtml;
        } else {
            elements.contentGrid.innerHTML = contentHtml;
        }
        
        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage++;
        
        // 再次确认仍是当前页面
        if (AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;
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
    
    // 不在此处清空内容区域，交由 prepareForNewContent 统一处理（保留骨架占位）
    
    window.addEventListener('scroll', handleSearchScroll);

    try {
        const data = await fetchSearchResults(query, state.currentSearchPage, signal);
        // 路由已切换或请求已被新的页面信号取代，丢弃过期响应
        const searchPathKey = `search?q=${query}`;
        if (signal.aborted || AbortBus.get('page') !== signal) return;

        // 检查数据完整性
        if (!data || !data.results) {
            console.error('搜索返回数据不完整:', data);
            showNetworkError();
            return;
        }

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
          // 空结果：重置分页信息并隐藏加载更多
          state.totalSearchPages = 0;
          state.currentSearchPage = 1;
          elements.infiniteScrollLoader.classList.add('hidden');
          
          showEmptySearchResults(query);
          removeScrollListeners(); // 移除滚动监听，防止触发无限加载
          elements.contentGrid.style.minHeight = ''; // 重置高度
          return;
       }

        // 渲染搜索结果网格（骨架 -> 实际内容 无缝替换）
        elements.contentGrid.classList.add('masonry-mode');
        const { contentHtml, newMediaUrls } = renderSearchGrid(data.results, 0);
        const skeleton = document.getElementById('skeleton-grid');
        if (skeleton) {
            skeleton.outerHTML = contentHtml;
        } else {
            elements.contentGrid.innerHTML = contentHtml;
        }
        
        state.totalSearchPages = data.totalPages;
        state.currentPhotos = newMediaUrls;
        state.currentSearchPage++;
        
        // 再次确认仍是当前页面
        if (AbortBus.get('page') !== signal) return;
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
    // 直接展示骨架占位，避免用户看到空白状态
    showSkeletonGrid();
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

// --- 统一滚动位置保存（增强）：在页面隐藏或卸载前再保存一次 ---
function saveCurrentScrollPosition() {
    const key = state.currentBrowsePath;
    if (typeof key === 'string' && key.length > 0) {
        state.scrollPositions.set(key, window.scrollY);
        // 同步到 sessionStorage（限制最多50条，LRU近似：仅保留最近写入）
        try {
            const obj = Object.fromEntries(state.scrollPositions);
            const entries = Object.entries(obj);
            const limited = entries.slice(-200);
            sessionStorage.setItem('sg_scroll_positions', JSON.stringify(Object.fromEntries(limited)));
            sessionStorage.setItem('sg_pre_search_hash', state.preSearchHash || '#/');
        } catch {}
    }
}

window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveCurrentScrollPosition();
    }
});

window.addEventListener('beforeunload', () => {
    saveCurrentScrollPosition();
});

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