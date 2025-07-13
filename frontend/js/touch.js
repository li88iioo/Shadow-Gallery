// frontend/js/touch.js
/**
 * 一个帮助类，用于管理 DOM 元素上的滑动收拾。
 */
export class SwipeHandler {
    /**
     * @param {HTMLElement} element 要监听滑动的元素。
     * @param {object} [options]
     * @param {number} [options.threshold=50] 识别为有效滑动的最小像素距离。
     * @param {function(string): void} [options.onSwipe] 成功滑动后的回调函数，它会接收方向参数 ('left', 'right')。
     */
    constructor(element, options = {}) {
        this.element = element;
        this.threshold = options.threshold || 50; // 最小滑动距离
        this.onSwipe = options.onSwipe;

        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;

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
        this.element.addEventListener('touchmove', this.handleTouchMove, { passive: true });
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
    }

    handleTouchMove(e) {
        // 记录移动中的最后位置，用于 touchend
        this.touchEndX = e.changedTouches[0].screenX;
        this.touchEndY = e.changedTouches[0].screenY;
    }

    handleTouchEnd() {
        const deltaX = this.touchEndX - this.touchStartX;
        const deltaY = this.touchEndY - this.touchStartY;

        // 只有当横向滑动距离大于纵向距离时，才认为是有效的左右滑动
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            // 检查横向滑动距离是否超过阈值
            if (Math.abs(deltaX) > this.threshold) {
                if (deltaX > 0) {
                    this.onSwipe?.('right'); // 向右滑动
                } else {
                    this.onSwipe?.('left'); // 向左滑动
                }
            }
        }
        
        // 重置坐标
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;
    }
}