// frontend/js/listeners.js

import { state, elements } from './state.js';
import { applyMasonryLayout, getMasonryColumns, applyMasonryLayoutIncremental } from './masonry.js';
import { closeModal, navigateModal, _handleThumbnailClick, _navigateToAlbum } from './modal.js';
import { SwipeHandler } from './touch.js';
import { showSettingsModal } from './settings.js';
import { fetchBrowseResults, fetchSearchResults } from './api.js';
import { renderBrowseGrid, renderSearchGrid } from './ui.js';
import { setupLazyLoading } from './lazyload.js';

/**
 * 事件监听器管理模块
 * 负责处理所有用户交互事件，包括滚动、点击、键盘、触摸等
 */

/**
 * 移除滚动监听器
 * 在路由切换时清理滚动事件监听
 */
export function removeScrollListeners() {
    window.removeEventListener('scroll', handleBrowseScroll);
    window.removeEventListener('scroll', handleSearchScroll);
}

/**
 * 浏览页面的滚动处理
 * 触发浏览模式的无限滚动加载
 */
export function handleBrowseScroll() {
    handleScroll('browse');
}

/**
 * 搜索页面的滚动处理
 * 触发搜索模式的无限滚动加载
 */
export function handleSearchScroll() {
    handleScroll('search');
}

/**
 * 通用滚动处理函数
 * 实现无限滚动加载功能
 * @param {string} type - 滚动类型 ('browse' 或 'search')
 */
async function handleScroll(type) {
    // 获取对应类型的状态
    const isLoading = type === 'browse' ? state.isBrowseLoading : state.isSearchLoading;
    const currentPage = type === 'browse' ? state.currentBrowsePage : state.currentSearchPage;
    const totalPages = type === 'browse' ? state.totalBrowsePages : state.totalSearchPages;

    // 如果正在加载或已到最后一页，则跳过
    if (isLoading || currentPage > totalPages) return;

    // 检查是否接近页面底部（距离底部500px时触发加载）
    if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) {
        // 设置加载状态
        if (type === 'browse') state.isBrowseLoading = true;
        else state.isSearchLoading = true;

        elements.infiniteScrollLoader.classList.remove('hidden');
        
        try {
            let data;
            const signal = new AbortController().signal;
            
            // 根据类型获取数据
            if (type === 'browse') {
                data = await fetchBrowseResults(state.currentBrowsePath, currentPage, signal);
            } else {
                data = await fetchSearchResults(state.currentSearchQuery, currentPage, signal);
            }
            
            if (!data) return;

            const items = type === 'browse' ? data.items : data.results;
            if (items.length === 0) {
                 if (type === 'browse') state.isBrowseLoading = false; else state.isSearchLoading = false;
                 elements.infiniteScrollLoader.classList.add('hidden');
                 return;
            };

            // 更新总页数
            if (type === 'browse') state.totalBrowsePages = data.totalPages;
            else state.totalSearchPages = data.totalPages;

            // 渲染新内容
            const prevCount = elements.contentGrid.children.length;
            const { contentHtml, newMediaUrls } = type === 'browse' 
                ? renderBrowseGrid(items, state.currentPhotos.length)
                : renderSearchGrid(items, state.currentPhotos.length);
            
            elements.contentGrid.insertAdjacentHTML('beforeend', contentHtml);
            state.currentPhotos = state.currentPhotos.concat(newMediaUrls);

            // 更新页码
            if (type === 'browse') state.currentBrowsePage++;
            else state.currentSearchPage++;
            
            // 设置懒加载和瀑布流布局
            setupLazyLoading();
            const newItems = Array.from(elements.contentGrid.children).slice(prevCount);
            applyMasonryLayoutIncremental(newItems);
        } catch (error) {
            if (error.name !== 'AbortError') console.error("Failed to fetch more items:", error);
        } finally {
             if (type === 'browse') state.isBrowseLoading = false;
             else state.isSearchLoading = false;
            elements.infiniteScrollLoader.classList.add('hidden');
        }
    }
}

/**
 * 设置所有事件监听器
 * 包括点击、搜索、键盘、滚动、触摸等事件
 */
export function setupEventListeners() {
    // 内容网格点击事件处理
    elements.contentGrid.addEventListener('click', (e) => {
        const albumLink = e.target.closest('.album-link');
        const photoLink = e.target.closest('.photo-link');

        if (albumLink) {
            // 相册链接点击
            e.preventDefault();
            const path = albumLink.dataset.path;
            _navigateToAlbum(e, path);
        } else if (photoLink) {
            // 图片/视频点击
            e.preventDefault();
            const url = photoLink.dataset.url;
            const index = parseInt(photoLink.dataset.index, 10);
            _handleThumbnailClick(photoLink, url, index);
        }
    });
    
    // 搜索输入框事件处理
    if (elements.searchInput) {
        // 搜索历史容器
        const searchHistoryContainer = document.getElementById('search-history');
        
        // 异步加载搜索历史功能
        let searchHistoryModule = null;
        import('./search-history.js').then(module => {
            searchHistoryModule = module;
        });
        
        elements.searchInput.addEventListener('input', (e) => {
            clearTimeout(state.searchDebounceTimer);
            const query = e.target.value;
            
            // 如果输入框为空，显示搜索历史
            if (!query.trim()) {
                if (searchHistoryModule) {
                    searchHistoryModule.showSearchHistory(elements.searchInput, searchHistoryContainer);
                }
                return;
            }
            
            // 隐藏搜索历史
            if (searchHistoryModule) {
                searchHistoryModule.hideSearchHistory(searchHistoryContainer);
            }
            
            // 防抖处理：800ms后执行搜索
            state.searchDebounceTimer = setTimeout(() => {
                const currentQuery = new URLSearchParams(window.location.hash.substring(window.location.hash.indexOf('?'))).get('q');
                if (query.trim()) {
                    if(query.trim() !== currentQuery) {
                       window.location.hash = `/search?q=${encodeURIComponent(query)}`;
                       // 保存搜索历史
                       if (searchHistoryModule) {
                           searchHistoryModule.saveSearchHistory(query);
                       }
                    }
                } else if (window.location.hash.includes('search?q=')) {
                    // 清空搜索时返回之前的页面
                    window.location.hash = state.preSearchHash || '#/';
                }
            }, 800);
        });
        
        // 搜索框获得焦点时显示历史
        elements.searchInput.addEventListener('focus', () => {
            if (!elements.searchInput.value.trim() && searchHistoryModule) {
                searchHistoryModule.showSearchHistory(elements.searchInput, searchHistoryContainer);
            }
        });
        
        // 点击外部隐藏搜索历史
        document.addEventListener('click', (e) => {
            if (!elements.searchInput.contains(e.target) && !searchHistoryContainer.contains(e.target)) {
                if (searchHistoryModule) {
                    searchHistoryModule.hideSearchHistory(searchHistoryContainer);
                }
            }
        });
    }

    // 浏览器前进后退事件处理
    window.addEventListener('popstate', (event) => {
        if (!window.location.hash.endsWith('#modal') && !elements.modal.classList.contains('opacity-0')) {
            closeModal();
        }
    });
    
    // 模态框关闭按钮事件
    elements.modalClose.addEventListener('click', () => {
        if (window.location.hash.endsWith('#modal')) {
            window.history.back();
        }
    });
    
    // 模态框背景点击关闭
    elements.mediaPanel.addEventListener('click', (e) => {
        if (e.target === elements.mediaPanel && window.location.hash.endsWith('#modal')) {
            window.history.back();
        }
    });
    
    // AI标题气泡切换
    elements.toggleCaptionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.captionBubble.classList.toggle('show');
    });
    
    // 点击外部关闭AI标题气泡
    document.addEventListener('click', (e) => {
        if (elements.captionBubble.classList.contains('show') && !elements.captionBubble.contains(e.target) && !elements.toggleCaptionBtn.contains(e.target)) {
            elements.captionBubble.classList.remove('show');
        }
    });

    // 键盘事件处理
    document.addEventListener('keydown', (e) => {
        // 模态框内的键盘操作
        if (!elements.modal.classList.contains('opacity-0')) {
            if (e.key === 'Escape') { 
                if (window.location.hash.endsWith('#modal')) window.history.back(); 
            }
            else if (e.key === 'ArrowLeft') { navigateModal('prev'); }
            else if (e.key === 'ArrowRight') { navigateModal('next'); }
        }

        // 全局快捷键（排除输入框）
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        
        switch (e.key.toLowerCase()) {
            case 'b':
                // B键切换模糊模式
                state.isBlurredMode = !state.isBlurredMode;
                document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
                    media.classList.toggle('blurred', state.isBlurredMode);
                });
                break;
            case 'f':
                // F键全屏模式
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => {
                        console.log('全屏模式失败:', err);
                    });
                } else {
                    document.exitFullscreen();
                }
                break;
            case 's':
                // S键聚焦搜索框
                e.preventDefault();
                elements.searchInput.focus();
                elements.searchInput.select();
                break;
            case 'r':
                // R键刷新当前页面
                e.preventDefault();
                window.location.reload();
                break;
            case 'h':
                // H键返回首页
                e.preventDefault();
                window.location.hash = '#/';
                break;
            case 'escape':
                // ESC键关闭模态框或返回
                if (window.location.hash.includes('search?q=')) {
                    window.location.hash = state.preSearchHash || '#/';
                }
                break;
        }
        
        // 数字键快速导航（1-9）
        if (/^[1-9]$/.test(e.key)) {
            const index = parseInt(e.key) - 1;
            const photoLinks = document.querySelectorAll('.photo-link');
            if (photoLinks[index]) {
                photoLinks[index].click();
            }
        }
    });

    // 模态框滚轮导航（桌面端）
    elements.modal.addEventListener('wheel', (e) => {
        if (window.innerWidth <= 768) return;  // 移动端禁用
        e.preventDefault();
        const now = Date.now();
        if (now - state.lastWheelTime < 300) return;  // 防抖处理
        state.lastWheelTime = now;
        if (e.deltaY < 0) navigateModal('prev'); else navigateModal('next');
    });
    
    // 触摸滑动处理
    new SwipeHandler(elements.mediaPanel, {
        onSwipe: (direction) => {
            if (elements.modal.classList.contains('opacity-0')) return;
            // 向左滑动 -> 下一张
            if (direction === 'left') {
                navigateModal('next');
            } 
            // 向右滑动 -> 上一张
            else if (direction === 'right') {
                navigateModal('prev');
            }
        }
    });

    // 窗口大小变化处理
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const newColumnCount = getMasonryColumns();
            if (newColumnCount !== state.currentColumnCount) {
                state.currentColumnCount = newColumnCount;
                applyMasonryLayout();  // 重新布局
            }
        }, 100);  // 防抖处理
    });

    // 回到顶部按钮
    const backToTopBtn = document.getElementById('back-to-top-btn');
    if (backToTopBtn) {
        // 滚动时显示/隐藏按钮
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) {
                backToTopBtn.classList.add('visible');
            } else {
                backToTopBtn.classList.remove('visible');
            }
        });
        
        // 点击回到顶部
        backToTopBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    // 设置按钮
    const settingsBtn = document.getElementById('settings-btn');
    if(settingsBtn) {
        settingsBtn.addEventListener('click', showSettingsModal);
    }
}