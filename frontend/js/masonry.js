// frontend/js/masonry.js

import { elements } from './state.js';

/**
 * 瀑布流布局管理模块
 * 负责处理图片网格的瀑布流布局、响应式列数和动态布局更新
 */

/**
 * 根据窗口宽度获取瀑布流列数
 * 响应式设计：不同屏幕宽度对应不同的列数
 * @returns {number} 列数
 */
export function getMasonryColumns() {
    const width = window.innerWidth;
    if (width >= 1536) return 6;  // 2xl屏幕：6列
    if (width >= 1280) return 5;  // xl屏幕：5列
    if (width >= 1024) return 4;  // lg屏幕：4列
    if (width >= 768) return 3;   // md屏幕：3列
    if (width >= 640) return 2;   // sm屏幕：2列
    return 1;                     // 默认：1列
}

// 全局记录每列高度，用于瀑布流布局计算
let masonryColumnHeights = [];

/**
 * 增量瀑布流布局
 * 只布局新添加的项目，提高性能
 * @param {Array|NodeList} newItems - 新添加的项目数组
 */
export function applyMasonryLayoutIncremental(newItems) {
    const { contentGrid } = elements;
    if (!contentGrid.classList.contains('masonry-mode')) return;
    if (!newItems || newItems.length === 0) return;

    const numColumns = getMasonryColumns();
    const columnGap = 16;  // 列间距

    // 如果是首次加载或列数变化，重置所有列高度并重新布局
    if (!masonryColumnHeights.length || contentGrid.children.length === newItems.length) {
        masonryColumnHeights = Array(numColumns).fill(0);
        
        // 重新布局所有项目
        Array.from(contentGrid.children).forEach(item => {
            const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
            const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
            
            // 设置项目位置和尺寸
            item.style.position = 'absolute';
            item.style.width = `${itemWidth}px`;
            item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
            item.style.top = `${masonryColumnHeights[minColumnIndex]}px`;
            
            // 更新列高度
            const actualItemHeight = item.offsetHeight;
            masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
        });
    } else {
        // 增量布局：只布局新项目
        newItems.forEach(item => {
            const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
            const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
            
            // 设置项目位置和尺寸
            item.style.position = 'absolute';
            item.style.width = `${itemWidth}px`;
            item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
            item.style.top = `${masonryColumnHeights[minColumnIndex]}px`;
            
            // 更新列高度
            const actualItemHeight = item.offsetHeight;
            masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
        });
    }
    
    // 设置容器高度为最高列的高度
    contentGrid.style.height = `${Math.max(...masonryColumnHeights)}px`;
}

/**
 * 全量瀑布流布局
 * 用于窗口变化或首次加载时重新布局所有项目
 */
export function applyMasonryLayout() {
    const { contentGrid } = elements;
    if (!contentGrid.classList.contains('masonry-mode')) return;
    
    const items = Array.from(contentGrid.children);
    if (items.length === 0) return;
    
    // 重置列高度并应用增量布局
    masonryColumnHeights = [];
    applyMasonryLayoutIncremental(items);
}

/**
 * 触发瀑布流更新事件
 * 用于通知其他模块瀑布流需要重新布局
 */
export function triggerMasonryUpdate() {
    const event = new CustomEvent('masonry-update');
    document.dispatchEvent(event);
}

/**
 * 监听瀑布流更新事件
 * 在窗口resize、模式切换等情况下重新布局
 */
document.addEventListener('masonry-update', () => {
    applyMasonryLayout();
});