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
        // 简化构造函数，移除不再使用的属性
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
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 currentTarget 确保获取到按钮元素本身
                    const action = e.currentTarget.dataset.action;
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
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 currentTarget 确保获取到按钮元素本身
                    const action = e.currentTarget.dataset.action;
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


}

// 创建全局加载状态管理器实例
export const loadingStateManager = new LoadingStateManager();

/**
 * 便捷的加载状态函数
 */



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
 * 显示首屏骨架占位网格，避免内容加载前出现空白
 * @param {number} preferredCount 可选的建议数量
 */
export function showSkeletonGrid(preferredCount) {
    try {
        const grid = elements.contentGrid;
        if (!grid) return;
        // 注入一次骨架动画样式（无需重新构建CSS）
        if (!document.getElementById('skeleton-style')) {
            const style = document.createElement('style');
            style.id = 'skeleton-style';
            style.textContent = `
                /* 骨架网格：两侧与容器齐平，随屏宽自适应列数 */
                #skeleton-grid.skeleton-grid {
                    --gap: 16px;
                    --min-col: 210px;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(var(--min-col), 1fr));
                    gap: var(--gap);
                    justify-content: start;
                    align-content: start;
                }
                /* 小屏列宽更窄，便于移动端适配 */
                @media (max-width: 640px) {
                    #skeleton-grid.skeleton-grid { --min-col: 160px; --gap: 12px; }
                }
                #skeleton-grid .skeleton-card {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 2 / 3;
                    border-radius: 12px;
                    background: rgba(255,255,255,0.06);
                    overflow: hidden;
                    transform: translateY(6px);
                    opacity: 0;
                    animation: skeleton-enter 260ms ease-out forwards, skeleton-pulse 1600ms ease-in-out infinite;
                }
                #skeleton-grid .skeleton-card::after {
                    content: '';
                    position: absolute; inset: 0;
                    background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.10), rgba(255,255,255,0));
                    transform: translateX(-150%);
                    animation: skeleton-shimmer 1400ms linear infinite;
                }
                @keyframes skeleton-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes skeleton-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.08); } }
                @keyframes skeleton-shimmer { 0% { transform: translateX(-150%); } 100% { transform: translateX(150%); } }
            `;
            document.head.appendChild(style);
        }
        // 估算列数以与内容布局接近：容器宽 / 列宽
        const containerWidth = grid.clientWidth || window.innerWidth - 48;
        const minCol = window.innerWidth <= 640 ? 160 : 210;
        const columns = Math.max(2, Math.floor(containerWidth / (minCol + 16)));
        const rows = 3; // 首屏三行即可，视觉更接近实际布局
        const count = preferredCount || columns * rows;
        const skeletons = new Array(count).fill(0).map(() => (
            '<div class="skeleton-card"></div>'
        )).join('');
        grid.innerHTML = `<div id="skeleton-grid" class="skeleton-grid">${skeletons}</div>`;
    } catch {}
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


