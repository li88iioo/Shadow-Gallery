// frontend/js/masonry.js

import { elements } from './state.js';

export function getMasonryColumns() {
    const width = window.innerWidth;
    if (width >= 1536) return 6;
    if (width >= 1280) return 5;
    if (width >= 1024) return 4;
    if (width >= 768) return 3;
    if (width >= 640) return 2;
    return 1;
}

// 全局记录每列高度
let masonryColumnHeights = [];

// 增量布局：只布局新 items
export function applyMasonryLayoutIncremental(newItems) {
    const { contentGrid } = elements;
    if (!contentGrid.classList.contains('masonry-mode')) return;
    if (!newItems || newItems.length === 0) return;

    const numColumns = getMasonryColumns();
    const columnGap = 16;

    // 如果是首次加载或列数变化，重置所有列高度
    if (!masonryColumnHeights.length || contentGrid.children.length === newItems.length) {
        masonryColumnHeights = Array(numColumns).fill(0);
        // 重新布局所有 items
        Array.from(contentGrid.children).forEach(item => {
            const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
            const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
            item.style.position = 'absolute';
            item.style.width = `${itemWidth}px`;
            item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
            item.style.top = `${masonryColumnHeights[minColumnIndex]}px`;
            const actualItemHeight = item.offsetHeight;
            masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
        });
    } else {
        // 增量布局：只布局新 items
        newItems.forEach(item => {
            const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
            const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
            item.style.position = 'absolute';
            item.style.width = `${itemWidth}px`;
            item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
            item.style.top = `${masonryColumnHeights[minColumnIndex]}px`;
            const actualItemHeight = item.offsetHeight;
            masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
        });
    }
    contentGrid.style.height = `${Math.max(...masonryColumnHeights)}px`;
}

// 全量布局（窗口变化或首次加载）
export function applyMasonryLayout() {
    const { contentGrid } = elements;
    if (!contentGrid.classList.contains('masonry-mode')) return;
    const items = Array.from(contentGrid.children);
    if (items.length === 0) return;
    masonryColumnHeights = [];
    applyMasonryLayoutIncremental(items);
}

// 一个简单的事件触发器
export function triggerMasonryUpdate() {
    const event = new CustomEvent('masonry-update');
    document.dispatchEvent(event);
}

// 监听这个事件
// 仍然全量布局（如窗口resize、模式切换等）
document.addEventListener('masonry-update', () => {
    applyMasonryLayout();
});