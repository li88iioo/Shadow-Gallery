// frontend/js/loading-states.js

/**
 * 智能加载状态管理系统
 * 提供渐进式加载、智能骨架屏和错误状态处理
 */

import { elements, state } from './state.js';

/**
 * 加载状态管理器
 */
class LoadingStateManager {
    constructor() {
        this.progressiveBar = null;
        this.currentProgress = 0;
        this.loadingStates = new Map();
        this.initProgressiveBar();
    }

    /**
     * 初始化渐进式加载条
     */
    initProgressiveBar() {
        // 创建渐进式加载条
        this.progressiveBar = document.createElement('div');
        this.progressiveBar.className = 'progressive-loading';
        this.progressiveBar.innerHTML = '<div class="progressive-loading-bar"></div>';
        document.body.appendChild(this.progressiveBar);
        this.hideProgressiveBar();
    }

    /**
     * 显示渐进式加载条
     */
    showProgressiveBar() {
        this.progressiveBar.style.display = 'block';
        this.currentProgress = 0;
        this.updateProgressiveBar(0);
    }

    /**
     * 隐藏渐进式加载条
     */
    hideProgressiveBar() {
        this.progressiveBar.style.display = 'none';
    }

    /**
     * 更新渐进式加载进度
     * @param {number} progress - 进度百分比 (0-100)
     */
    updateProgressiveBar(progress) {
        this.currentProgress = Math.min(100, Math.max(0, progress));
        const bar = this.progressiveBar.querySelector('.progressive-loading-bar');
        bar.style.width = `${this.currentProgress}%`;
    }

    /**
     * 完成渐进式加载
     */
    completeProgressiveBar() {
        this.updateProgressiveBar(100);
        setTimeout(() => {
            this.hideProgressiveBar();
        }, 500);
    }

    /**
     * 生成智能骨架屏
     * @param {string} type - 骨架屏类型 ('album', 'photo', 'video', 'mixed')
     * @param {number} count - 骨架屏数量
     * @param {Object} options - 额外选项
     * @returns {string} HTML字符串
     */
    generateSkeletonGrid(type = 'mixed', count = 12, options = {}) {
        const { gridClass = 'skeleton-grid', itemClass = '' } = options;
        
        let skeletonItems = '';
        
        for (let i = 0; i < count; i++) {
            let itemClass = '';
            let content = '';
            
            if (type === 'album') {
                itemClass = 'skeleton-album';
                content = `
                    <div class="skeleton-album-info">
                        <div class="skeleton-album-title"></div>
                        <div class="skeleton-album-meta"></div>
                    </div>
                `;
            } else if (type === 'photo') {
                itemClass = 'skeleton-photo';
            } else if (type === 'video') {
                itemClass = 'skeleton-video';
                content = '<div class="skeleton-video-play"></div>';
            } else {
                // 混合类型，随机生成
                const types = ['album', 'photo', 'video'];
                const randomType = types[Math.floor(Math.random() * types.length)];
                
                if (randomType === 'album') {
                    itemClass = 'skeleton-album';
                    content = `
                        <div class="skeleton-album-info">
                            <div class="skeleton-album-title"></div>
                            <div class="skeleton-album-meta"></div>
                        </div>
                    `;
                } else if (randomType === 'photo') {
                    itemClass = 'skeleton-photo';
                } else {
                    itemClass = 'skeleton-video';
                    content = '<div class="skeleton-video-play"></div>';
                }
            }
            
            skeletonItems += `<div class="${itemClass}">${content}</div>`;
        }
        
        return `<div class="${gridClass}">${skeletonItems}</div>`;
    }

    /**
     * 显示智能加载状态
     * @param {string} type - 加载类型 ('browse', 'search', 'album')
     * @param {Object} options - 加载选项
     */
    showLoadingState(type = 'browse', options = {}) {
        const {
            showProgressive = true,
            skeletonType = 'mixed',
            skeletonCount = 12,
            loadingText = this.getLoadingText(type)
        } = options;

        // 显示渐进式加载条
        if (showProgressive) {
            this.showProgressiveBar();
        }

        // 生成并显示骨架屏
        const skeletonHTML = this.generateSkeletonGrid(skeletonType, skeletonCount);
        
        if (elements.contentGrid) {
            // 确保移除虚拟滚动模式
            elements.contentGrid.classList.remove('virtual-scroll-mode');
            elements.contentGrid.innerHTML = skeletonHTML;
            elements.contentGrid.classList.add('content-transition', 'content-loading');
        }

        // 隐藏加载指示器
        if (elements.loadingIndicator) {
            elements.loadingIndicator.classList.add('hidden');
        }

        // 记录加载状态
        this.loadingStates.set(type, {
            startTime: Date.now(),
            options
        });
    }

    /**
     * 隐藏加载状态
     * @param {string} type - 加载类型
     */
    hideLoadingState(type = 'browse') {
        // 完成渐进式加载
        this.completeProgressiveBar();

        // 移除加载状态类
        if (elements.contentGrid) {
            elements.contentGrid.classList.remove('content-loading');
            elements.contentGrid.classList.add('content-loaded');
        }

        // 清理加载状态记录
        this.loadingStates.delete(type);
    }

    /**
     * 获取加载文本
     * @param {string} type - 加载类型
     * @returns {string} 加载文本
     */
    getLoadingText(type) {
        const texts = {
            browse: '正在浏览相册...',
            search: '正在搜索内容...',
            album: '正在加载相册...',
            photo: '正在加载图片...',
            video: '正在加载视频...',
            default: '正在加载...'
        };
        return texts[type] || texts.default;
    }

    /**
     * 显示错误状态
     * @param {string} title - 错误标题
     * @param {string} message - 错误消息
     * @param {Array} actions - 操作按钮数组
     */
    showErrorState(title, message, actions = []) {
        // 清理虚拟滚动器
        const scroller = state.get('virtualScroller');
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }
        
        // 隐藏无限滚动加载器
        if (elements.infiniteScrollLoader) {
            elements.infiniteScrollLoader.classList.add('hidden');
        }
        
        // 确保移除虚拟滚动模式
        if (elements.contentGrid) {
            elements.contentGrid.classList.remove('virtual-scroll-mode');
            elements.contentGrid.style.height = 'auto';
        }
        
        const errorHTML = `
            <div class="error-container">
                <div class="error-illustration">
                    <div class="error-icon-container">
                        <svg class="error-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <div class="error-icon-glow"></div>
                    </div>
                    <div class="error-pulse"></div>
                </div>
                <div class="error-content">
                    <h2 class="error-title">${title}</h2>
                    ${message ? `<p class="error-message">${message}</p>` : ''}
                    ${actions.length > 0 ? `
                        <div class="error-actions">
                            ${actions.map((action, index) => `
                                <button class="error-btn ${action.primary ? 'error-btn-primary' : 'error-btn-secondary'}" 
                                        data-action="${action.onClick}" data-index="${index}">
                                    ${action.text}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        if (elements.contentGrid) {
            elements.contentGrid.innerHTML = errorHTML;
            
            // 添加事件监听器
            const buttons = elements.contentGrid.querySelectorAll('.error-btn');
            buttons.forEach(button => {
                button.addEventListener('click', (e) => {
                    const action = e.target.dataset.action;
                    console.log('Error button clicked:', action); // 调试日志
                    if (action === 'reload') {
                        window.location.reload();
                    } else if (action === 'home') {
                        window.location.hash = '#/';
                    }
                });
            });
        }
    }

    /**
     * 显示空状态
     * @param {string} title - 空状态标题
     * @param {string} message - 空状态消息
     * @param {Array} actions - 操作按钮数组
     */
    showEmptyState(title, message, actions = []) {
        // 清理虚拟滚动器
        const scroller = state.get('virtualScroller');
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }
        
        // 隐藏无限滚动加载器
        if (elements.infiniteScrollLoader) {
            elements.infiniteScrollLoader.classList.add('hidden');
        }
        
        // 确保移除虚拟滚动模式
        if (elements.contentGrid) {
            elements.contentGrid.classList.remove('virtual-scroll-mode');
            elements.contentGrid.style.height = 'auto';
        }
        
        const emptyHTML = `
            <div class="empty-state">
                <div class="empty-illustration">
                    <div class="empty-icon-container">
                        <svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                        </svg>
                        <div class="empty-icon-glow"></div>
                    </div>
                    <div class="empty-dots">
                        <div class="empty-dot"></div>
                        <div class="empty-dot"></div>
                        <div class="empty-dot"></div>
                    </div>
                </div>
                <div class="empty-content">
                    <h2 class="empty-title">${title}</h2>
                    ${message ? `<p class="empty-message">${message}</p>` : ''}
                    ${actions.length > 0 ? `
                        <div class="empty-actions">
                            ${actions.map((action, index) => `
                                <button class="empty-btn ${action.primary ? 'empty-btn-primary' : 'empty-btn-secondary'}" 
                                        data-action="${action.onClick}" data-index="${index}">
                                    ${action.text}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        if (elements.contentGrid) {
            elements.contentGrid.innerHTML = emptyHTML;
            
            // 添加事件监听器
            const buttons = elements.contentGrid.querySelectorAll('.empty-btn');
            buttons.forEach(button => {
                button.addEventListener('click', (e) => {
                    const action = e.target.dataset.action;
                    console.log('Empty button clicked:', action); // 调试日志
                    if (action === 'reload') {
                        window.location.reload();
                    } else if (action === 'home') {
                        window.location.hash = '#/';
                    } else if (action === 'browse') {
                        window.location.hash = '#/browse';
                    } else if (action === 'back') {
                        history.back();
                    }
                });
            });
        }
    }

    /**
     * 更新加载进度
     * @param {number} progress - 进度百分比
     */
    updateProgress(progress) {
        this.updateProgressiveBar(progress);
    }

    /**
     * 显示加载指示器
     * @param {string} text - 加载文本
     */
    showLoadingIndicator(text = '正在加载...') {
        const loadingHTML = `
            <div class="loading-indicator">
                <div class="loading-spinner"></div>
                <p class="loading-text">${text}</p>
            </div>
        `;

        if (elements.loadingIndicator) {
            elements.loadingIndicator.innerHTML = loadingHTML;
            elements.loadingIndicator.classList.remove('hidden');
        }
    }

    /**
     * 隐藏加载指示器
     */
    hideLoadingIndicator() {
        if (elements.loadingIndicator) {
            elements.loadingIndicator.classList.add('hidden');
        }
    }

    /**
     * 清理所有加载状态
     */
    cleanup() {
        this.hideProgressiveBar();
        this.hideLoadingIndicator();
        this.loadingStates.clear();
        
        // 清理渐进式加载条DOM元素
        if (this.progressiveBar && this.progressiveBar.parentNode) {
            this.progressiveBar.parentNode.removeChild(this.progressiveBar);
            this.progressiveBar = null;
        }
    }
}

// 创建全局加载状态管理器实例
export const loadingStateManager = new LoadingStateManager();

/**
 * 便捷的加载状态函数
 */

/**
 * 显示浏览加载状态
 */
export function showBrowseLoading() {
    loadingStateManager.showLoadingState('browse', {
        skeletonType: 'album',
        skeletonCount: 8,
        loadingText: '正在浏览相册...'
    });
}

/**
 * 显示搜索加载状态
 */
export function showSearchLoading() {
    loadingStateManager.showLoadingState('search', {
        skeletonType: 'mixed',
        skeletonCount: 12,
        loadingText: '正在搜索内容...'
    });
}

/**
 * 显示图片加载状态
 */
export function showPhotoLoading() {
    loadingStateManager.showLoadingState('photo', {
        skeletonType: 'photo',
        skeletonCount: 12,
        loadingText: '正在加载图片...'
    });
}

    /**
     * 显示网络错误状态
     */
    export function showNetworkError() {
        loadingStateManager.showErrorState(
            '无法连接到服务器，请检查网络连接后重试',
            '',
            [
                {
                    text: '重试',
                    primary: true,
                    onClick: 'reload'
                },
                {
                    text: '返回首页',
                    primary: false,
                    onClick: 'home'
                }
            ]
        );
    }

    /**
     * 显示空搜索结果状态
     */
    export function showEmptySearchResults(query) {
        // 隐藏无限滚动加载器
        if (elements.infiniteScrollLoader) {
            elements.infiniteScrollLoader.classList.add('hidden');
        }
        
        loadingStateManager.showEmptyState(
            `没有找到与"${query}"相关的相册或图片。请尝试其他关键词。`,
            '',
            [
                {
                    text: '返回首页',
                    primary: true,
                    onClick: 'home'
                }
            ]
        );
    }

    /**
     * 显示空相册状态
     */
    export function showEmptyAlbum() {
        // 隐藏无限滚动加载器
        if (elements.infiniteScrollLoader) {
            elements.infiniteScrollLoader.classList.add('hidden');
        }
        
        loadingStateManager.showEmptyState(
            '这个相册还没有任何图片或视频',
            '',
            [
                {
                    text: '返回上级',
                    primary: true,
                    onClick: 'back'
                }
            ]
        );
    }

        /**
     * 显示搜索索引构建中错误状态
     */
    export function showIndexBuildingError() {
        // 隐藏无限滚动加载器
        if (elements.infiniteScrollLoader) {
            elements.infiniteScrollLoader.classList.add('hidden');
        }
        
        loadingStateManager.showErrorState(
            '搜索功能暂时不可用，索引正在后台构建中，请稍后再试',
            '',
            [
                {
                    text: '重试',
                    primary: true,
                    onClick: 'reload'
                },
                {
                    text: '返回首页',
                    primary: false,
                    onClick: 'home'
                }
            ]
        );
    }

/**
 * 显示初始加载状态
 */
export function showInitialLoadingState() {
    const appContainer = document.getElementById('app-container');
    const contentGrid = document.getElementById('content-grid');
    
    // 立即显示应用容器
    appContainer.classList.remove('opacity-0');
    appContainer.classList.add('opacity-100');
    
    // 显示加载状态
    contentGrid.innerHTML = `
        <div class="flex items-center justify-center min-h-[60vh]">
            <div class="text-center">
                <div class="spinner mx-auto mb-4"></div>
                <p class="text-gray-400 text-lg">正在初始化应用...</p>
            </div>
        </div>
    `;
}
