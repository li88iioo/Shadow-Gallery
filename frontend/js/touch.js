// frontend/js/touch.js
/**
 * 一个帮助类，用于管理 DOM 元素上的滑动收拾。
 */
export class SwipeHandler {
    /**
     * @param {HTMLElement} element 要监听滑动的元素。
     * @param {object} [options]
     * @param {number} [options.threshold=50] 识别为有效滑动的最小像素距离。
     * @param {function(string): void} [options.onSwipe] 成功滑动后的回调函数，它会接收方向参数 ('up', 'down', 'left', 'right')。
     */
    constructor(element, options = {}) {
        this.element = element;
        this.threshold = options.threshold || 50;
        this.onSwipe = options.onSwipe;

        this.touchStartX = 0;
        this.touchStartY = 0;
        this.isSwiping = false; // 此标志位用于在垂直滑动时阻止页面滚动

        // 绑定方法以确保 'this' 指向正确
        this.handleTouchStart = this.handleTouchStart.bind(this);
        this.handleTouchMove = this.handleTouchMove.bind(this);
        this.handleTouchEnd = this.handleTouchEnd.bind(this);

        this.attach();
    }

    /**
     * 将触摸事件监听器附加到元素上。
     */
    attach() {
        this.element.addEventListener('touchstart', this.handleTouchStart, { passive: true });
        this.element.addEventListener('touchmove', this.handleTouchMove, { passive: false });
        this.element.addEventListener('touchend', this.handleTouchEnd, { passive: true });
    }

    /**
     * 从元素上移除触摸事件监听器。
     */
    detach() {
        this.element.removeEventListener('touchstart', this.handleTouchStart);
        this.element.removeEventListener('touchmove', this.handleTouchMove);
        this.element.removeEventListener('touchend', this.handleTouchEnd);
    }

    handleTouchStart(e) {
        this.touchStartX = e.changedTouches[0].screenX;
        this.touchStartY = e.changedTouches[0].screenY;
        this.isSwiping = false; // 重置滑动状态
    }

    handleTouchMove(e) {
        const deltaY = e.changedTouches[0].screenY - this.touchStartY;

        // 如果滑动主要是垂直方向，则标记为正在滑动并阻止页面滚动
        if (Math.abs(deltaY) > 10) {
            this.isSwiping = true;
            e.preventDefault();
        }
    }

    handleTouchEnd(e) {
        // 仅当在 touchmove 中检测到滑动时才继续
        if (!this.isSwiping) return;

        const touchEndY = e.changedTouches[0].screenY;
        const deltaY = touchEndY - this.touchStartY;

        // 检查滑动距离是否超过阈值
        if (Math.abs(deltaY) > this.threshold) {
            if (deltaY > 0) {
                // 如果 onSwipe 回调存在，则调用它并传入 'down'
                this.onSwipe?.('down'); // 向下滑动
            } else {
                this.onSwipe?.('up'); // 向上滑动
            }
        }
    }
}