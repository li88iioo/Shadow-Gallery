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
        this.currentProgress = 0;
        this.loadingStates = new Map();
    }

    /**
     * 生成智能骨架屏
     * @param {string} type - 骨架屏类型 ('album', 'photo', 'video', 'mixed')
     * @param {number} count - 骨架屏数量
     * @param {Object} options - 额外选项
     * @returns {string} HTML字符串
     */
    generateSkeletonGrid(type = 'mixed', count = 12, options = {}) {
        const { gridClass = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 p-4', itemClass = '' } = options;

        let skeletonItems = '';

        for (let i = 0; i < count; i++) {
            let itemClass = '';
            let content = '';

            // 使用现有的 skeleton-card 类，不管类型如何都一样
            itemClass = 'skeleton-card';

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
     * 显示现代化连接状态
     * @param {string} title - 连接状态标题
     * @param {string} subtitle - 连接状态副标题
     */
    showConnectingState(title = '正在连接后端服务...', subtitle = '系统启动中，请稍候') {
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

        const connectingHTML = `
            <div class="connecting-container">
                <div class="connecting-illustration">
                    <div class="connecting-icon-container">
                        <svg class="connecting-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 2L2 7V10C2 16 6 20.9 12 22C18 20.9 22 16 22 10V7L12 2Z" />
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12L11 14L15 10" />
                        </svg>
                        <div class="connecting-icon-glow"></div>
                    </div>
                    <div class="connecting-dots">
                        <div class="connecting-dot"></div>
                        <div class="connecting-dot"></div>
                        <div class="connecting-dot"></div>
                    </div>
                </div>
                <div class="connecting-content">
                    <h2 class="connecting-title">${title}</h2>
                    ${subtitle ? `<p class="connecting-message">${subtitle}</p>` : ''}
                </div>
            </div>
        `;

        if (elements.contentGrid) {
            elements.contentGrid.innerHTML = connectingHTML;
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
        this.hideLoadingIndicator();
        this.loadingStates.clear();
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
        skeletonCount: 10,
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
 * 显示现代化后端连接状态
 */
export function showBackendConnectingState(title, subtitle) {
    loadingStateManager.showConnectingState(title, subtitle);
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
/**
 * 显示索引构建状态并轮询进度
 */
export function showIndexBuildingState() {
    loadingStateManager.showEmptyState(
        '首次启动，正在构建图库索引...',
        `已处理 <span id="processed-count">0</span> 个文件，请您耐心等待。`,
        []
    );

    // 启动轮询来更新进度
    const intervalId = setInterval(async () => {
        try {
            const response = await fetch('/api/status/indexing');
            if (!response.ok) {
                // 如果获取状态失败，不需要抛出错误，因为可能是后端重启等临时情况
                console.warn('获取索引状态失败，将重试...');
                return;
            }
            const status = await response.json();

            const countElement = document.getElementById('processed-count');
            if (countElement) {
                countElement.textContent = status.processed_files;
            }

            // 如果索引完成，停止轮询并刷新页面
            if (status.status === 'complete') {
                clearInterval(intervalId);
                const titleElement = document.querySelector('.empty-title');
                if (titleElement) titleElement.textContent = '索引完成！正在加载画廊...';
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            }
        } catch (error) {
            // 只有在网络完全断开等情况下才会捕获到这个错误
            console.error('轮询索引状态时出错:', error);
            clearInterval(intervalId); // 出错时停止轮询
            const titleElement = document.querySelector('.empty-title');
            if (titleElement) titleElement.textContent = '无法获取索引状态，请手动刷新。';
        }
    }, 2000); // 每2秒轮询一次
}