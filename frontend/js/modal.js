// frontend/js/modal.js

import { state, elements, backdrops } from './state.js';
import { preloadNextImages, showNotification } from './utils.js';
import { generateImageCaption } from './api.js';

/**
 * 模态框管理模块
 * 负责处理图片/视频模态框的显示、导航、加载和交互功能
 */

let activeLoader = null;  // 当前活跃的加载器

/**
 * 隐藏模态框控制元素
 * 包括关闭按钮和AI控制容器
 */
function hideModalControls() {
    elements.modalClose.classList.add('opacity-0');
    if (elements.aiControlsContainer) {
        elements.aiControlsContainer.classList.add('opacity-0');
    }
}

/**
 * 显示模态框控制元素
 * 包括关闭按钮和AI控制容器
 */
function showModalControls() {
    elements.modalClose.classList.remove('opacity-0');
    if (elements.aiControlsContainer) {
        elements.aiControlsContainer.classList.remove('opacity-0');
    }
}

/**
 * 创建视频加载指示器
 * @returns {HTMLElement} 视频加载器DOM元素
 */
function createVideoSpinner() {
    const spinnerWrapper = document.createElement('div');
    spinnerWrapper.id = 'video-spinner';
    spinnerWrapper.className = 'absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 z-10 pointer-events-none';
    spinnerWrapper.innerHTML = '<div class="spinner" style="width: 3rem; height: 3rem;"></div>';
    return spinnerWrapper;
}

/**
 * 更新模态框内容
 * @param {string} mediaSrc - 媒体源URL
 * @param {number} index - 当前媒体索引
 * @param {string} originalPathForAI - 用于AI的原始路径
 * @param {string} thumbForBlur - 用于模糊背景的缩略图URL
 */
function updateModalContent(mediaSrc, index, originalPathForAI, thumbForBlur = null) {
    state.currentPhotoIndex = index;
    const { modalVideo, modalImg, navigationHint, captionContainer, captionContainerMobile, mediaPanel } = elements;
    
    // 移除旧的视频加载器
    const oldSpinner = mediaPanel.querySelector('#video-spinner');
    if (oldSpinner) oldSpinner.remove();

    // 清理之前的媒体内容
    modalVideo.pause();
    modalVideo.src = ''; 
    modalImg.src = ''; 
    if (state.currentObjectURL) {
        URL.revokeObjectURL(state.currentObjectURL);
        state.currentObjectURL = null;
    }

    const isVideo = /\.(mp4|webm|mov)$/i.test(originalPathForAI);
    
    // 更新背景模糊效果
    const blurSource = thumbForBlur || mediaSrc;
    const inactiveBackdropKey = state.activeBackdrop === 'one' ? 'two' : 'one';
    const activeBackdropElem = backdrops[state.activeBackdrop];
    const inactiveBackdropElem = backdrops[inactiveBackdropKey];
    
    inactiveBackdropElem.style.backgroundImage = `url('${blurSource}')`;
    activeBackdropElem.classList.remove('active-backdrop');
    inactiveBackdropElem.classList.add('active-backdrop');
    state.activeBackdrop = inactiveBackdropKey;

    // 根据媒体类型和AI状态显示相应元素
    // 实时检查AI是否启用，而不是依赖可能过期的state
    const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    const isAIEnabled = localAI.AI_ENABLED === 'true' || state.aiEnabled;
    const showAiElements = !isVideo && isAIEnabled;
    elements.aiControlsContainer.classList.toggle('hidden', !showAiElements);
    
    modalVideo.classList.toggle('hidden', !isVideo);
    modalImg.classList.toggle('hidden', isVideo);
    
    if (isVideo) {
        // 视频处理逻辑
        navigationHint.classList.remove('show-hint');
        navigationHint.style.display = 'none';

        // 显示视频加载器
        const videoSpinner = createVideoSpinner();
        mediaPanel.appendChild(videoSpinner);

        modalVideo.src = mediaSrc;
        
        // 视频播放成功回调
        const onPlaying = () => {
            if(videoSpinner) videoSpinner.remove();
            modalVideo.removeEventListener('playing', onPlaying);
            modalVideo.removeEventListener('error', onError);
        };
        
        // 视频播放错误回调
        const onError = (e) => {
            if(videoSpinner) videoSpinner.remove();
            if (e.target.error) {
                showNotification(`视频错误: ${e.target.error.message}`, 'error');
            } else {
                showNotification('视频加载或播放失败。', 'error');
            }
            modalVideo.removeEventListener('playing', onPlaying);
            modalVideo.removeEventListener('error', onError);
        }

        modalVideo.addEventListener('playing', onPlaying);
        modalVideo.addEventListener('error', onError);

        // 尝试自动播放视频
        modalVideo.play().catch(e => {
            if(videoSpinner) videoSpinner.remove();
            console.error("Video playback failed:", e);
            if(e.name !== 'AbortError') {
                 showNotification('视频无法自动播放，请手动点击播放。', 'warning');
            }
        });

        if(elements.captionBubble) elements.captionBubble.classList.remove('show');
    } else {
        // 图片处理逻辑
        navigationHint.style.display = 'flex';
        modalImg.src = mediaSrc; 
        
        // 禁用右键菜单
        if (!modalImg._noContextMenuBound) {
            modalImg.addEventListener('contextmenu', e => e.preventDefault());
            modalImg._noContextMenuBound = true;
        }
        
        // AI标题生成
        if (showAiElements) {
            clearTimeout(state.captionDebounceTimer);
            state.captionDebounceTimer = setTimeout(() => generateImageCaption(originalPathForAI), 300);
            captionContainer.innerHTML = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">酝酿中...</p></div>';
            captionContainerMobile.innerHTML = '酝酿中...';
        }
    }
    
    // 预加载下一批图片
    preloadNextImages(state.currentPhotos, index);
}

/**
 * 处理模态框导航时的媒体加载
 * @param {string} mediaSrc - 媒体源URL
 * @param {number} index - 媒体索引
 */
async function handleModalNavigationLoad(mediaSrc, index) {
    const originalPath = state.currentPhotos[index];
    const isVideo = /\.(mp4|webm|mov)$/i.test(originalPath);

    if (isVideo) {
        // 视频直接加载，使用缩略图作为背景
        const gridItem = document.querySelector(`[data-url="${originalPath}"]`);
        const thumbEl = gridItem ? gridItem.querySelector('img[data-src]') : null;
        const thumbUrl = thumbEl ? thumbEl.dataset.src : null;
        updateModalContent(originalPath, index, originalPath, thumbUrl);
        return;
    }

    // 防止重复导航
    if (state.isModalNavigating) return;
    state.isModalNavigating = true;

    // 预加载图片
    const tempImg = new Image();
    tempImg.onload = () => {
        updateModalContent(tempImg.src, index, originalPath);
        state.isModalNavigating = false;
    };
    tempImg.onerror = () => {
        showNotification('图片加载或解码失败', 'error');
        state.isModalNavigating = false;
    };
    tempImg.src = mediaSrc;
}

/**
 * 关闭模态框
 * 清理所有状态和DOM元素
 */
export function closeModal() {
    if (elements.modal.classList.contains('opacity-0')) return;

    // 移除模态框相关类
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    elements.modal.classList.add('opacity-0', 'pointer-events-none');
    
    // 清理媒体内容
    elements.modalImg.src = '';
    elements.modalVideo.pause();
    elements.modalVideo.src = '';
    
    // 清理背景
    backdrops.one.style.backgroundImage = 'none';
    backdrops.two.style.backgroundImage = 'none';
    
    // 清理对象URL
    if (state.currentObjectURL) {
        URL.revokeObjectURL(state.currentObjectURL);
        state.currentObjectURL = null;
    }
    
    // 隐藏AI气泡
    if (elements.captionBubble) elements.captionBubble.classList.remove('show');
    if (document.activeElement) document.activeElement.blur();

    // 恢复滚动位置
    if (state.scrollPositionBeforeModal !== null) {
        window.scrollTo({ top: state.scrollPositionBeforeModal, behavior: 'instant' });
        state.scrollPositionBeforeModal = null;
    }
    
    // 恢复焦点到缩略图
    if (state.activeThumbnail) {
        state.activeThumbnail.focus({ preventScroll: true });
        state.activeThumbnail = null;
    }
}

/**
 * 模态框导航（上一张/下一张）
 * @param {string} direction - 导航方向 ('prev' 或 'next')
 */
export function navigateModal(direction) {
    if (document.activeElement) document.activeElement.blur();
    if (state.isModalNavigating) return;
    
    // 隐藏控制元素并设置定时器重新显示
    hideModalControls(); 
    clearTimeout(state.uiVisibilityTimer);
    state.uiVisibilityTimer = setTimeout(showModalControls, 500);
    
    // 计算新的索引
    const newIndex = direction === 'prev' ? state.currentPhotoIndex - 1 : state.currentPhotoIndex + 1;
    if (newIndex >= 0 && newIndex < state.currentPhotos.length) {
        const nextMediaSrc = state.currentPhotos[newIndex];
        handleModalNavigationLoad(nextMediaSrc, newIndex);
    }
}

/**
 * 处理缩略图点击事件
 * @param {HTMLElement} element - 被点击的缩略图元素
 * @param {string} mediaSrc - 媒体源URL
 * @param {number} index - 媒体索引
 */
export function _handleThumbnailClick(element, mediaSrc, index) {
    // 保存当前状态
    state.scrollPositionBeforeModal = window.scrollY;
    state.activeThumbnail = element;
    
    const photoItem = element.querySelector('.photo-item');
    if (!photoItem || photoItem.classList.contains('is-loading')) return;

    const isVideo = /\.(mp4|webm|mov)$/i.test(mediaSrc);

    if (isVideo) {
        // 视频直接打开模态框
        const thumbEl = photoItem.querySelector('img[data-src]');
        const thumbUrl = thumbEl ? thumbEl.dataset.src : null;
        _openModal(mediaSrc, index, false, mediaSrc, thumbUrl);
        return;
    }
    
    // 中止之前的加载器
    if (activeLoader) activeLoader.abort();
    
    // 初始化进度圆环
    const progressCircle = photoItem.querySelector('.progress-circle-bar');
    if (progressCircle) {
        const radius = progressCircle.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        progressCircle.style.strokeDasharray = `${circumference} ${circumference}`;
        progressCircle.style.strokeDashoffset = circumference;
    }
    
    photoItem.classList.add('is-loading');
    
    // 创建新的加载控制器
    const controller = new AbortController();
    const { signal } = controller;
    activeLoader = controller;

    // 流式加载图片
    fetch(mediaSrc, { signal })
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length');
            let receivedLength = 0;
            
            return new Response(
                new ReadableStream({
                    start(controller) {
                        function push() {
                            reader.read().then(({ done, value }) => {
                                if (done) {
                                    controller.close();
                                    return;
                                }
                                receivedLength += value.length;
                                // 更新进度圆环
                                if (contentLength && progressCircle) {
                                    const progress = receivedLength / contentLength;
                                    const circumference = 2 * Math.PI * progressCircle.r.baseVal.value;
                                    const offset = circumference - progress * circumference;
                                    progressCircle.style.strokeDashoffset = offset;
                                }
                                controller.enqueue(value);
                                push();
                            }).catch(error => {
                                console.error('Stream reading error:', error);
                                controller.error(error);
                            })
                        }
                        push();
                    }
                })
            );
        })
        .then(response => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            return response.blob();
        })
        .then(blob => {
            const objectURL = URL.createObjectURL(blob);
            if (activeLoader === controller) {
                _openModal(objectURL, index, true, mediaSrc);
                state.currentObjectURL = objectURL; 
            } else {
                URL.revokeObjectURL(objectURL);
            }
        })
        .catch(error => {
            if (error.name !== 'AbortError') showNotification('图片加载失败', 'error');
        })
        .finally(() => {
            photoItem.classList.remove('is-loading');
            if (activeLoader === controller) activeLoader = null;
        });
}

/**
 * 打开模态框
 * @param {string} mediaSrc - 媒体源URL
 * @param {number} index - 媒体索引
 * @param {boolean} isObjectURL - 是否为对象URL
 * @param {string} originalPathForAI - 用于AI的原始路径
 * @param {string} thumbForBlur - 用于模糊背景的缩略图URL
 */
export function _openModal(mediaSrc, index = 0, isObjectURL = false, originalPathForAI = null, thumbForBlur = null) {
    // 添加模态框相关类
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    if (document.activeElement) document.activeElement.blur();
    
    // 验证媒体源
    if (!mediaSrc || typeof mediaSrc !== 'string' || mediaSrc.trim() === '') {
        console.error('Failed to open modal: Invalid media source:', mediaSrc);
        return;
    }

    elements.modal.classList.remove('opacity-0', 'pointer-events-none');
    
    // 更新模态框内容
    const aiPath = originalPathForAI || mediaSrc;
    updateModalContent(mediaSrc, index, aiPath, thumbForBlur);
    
    if (isObjectURL) state.currentObjectURL = mediaSrc;

    // 显示导航提示（仅首次）
    if (!state.hasShownNavigationHint && window.innerWidth > 768) {
        elements.navigationHint.classList.add('show-hint');
        state.hasShownNavigationHint = true;
        setTimeout(() => elements.navigationHint.classList.remove('show-hint'), 4000);
    }

    // 更新URL哈希
    if (!window.location.hash.endsWith('#modal')) {
        window.history.pushState({ modal: true }, '', window.location.href + '#modal');
    }
}

/**
 * 导航到相册
 * @param {Event} event - 点击事件
 * @param {string} albumPath - 相册路径
 */
export function _navigateToAlbum(event, albumPath) {
    event.preventDefault();
    if (document.activeElement) document.activeElement.blur();
    
    window.location.hash = `/${encodeURIComponent(albumPath)}`;
};

// =======================================================
// 【新增代码】快速导航功能
// =======================================================

let fastNavInterval = null;
let fastNavDirection = null;

/**
 * 启动智能快速导航。
 * 它会以固定间隔尝试翻页，但会自动等待上一张图片切换完成后再继续。
 * @param {string} direction - 导航方向 ('prev' 或 'next')
 */
export function startFastNavigate(direction) {
    // 如果已经有一个在运行且方向相同，则不重复启动
    if (fastNavInterval && fastNavDirection === direction) {
        return;
    }

    // 如果已经有一个在运行，则先停止
    if (fastNavInterval) {
        stopFastNavigate();
    }

    fastNavDirection = direction;

    // 立即执行第一次翻页
    if (!state.isModalNavigating) {
        navigateModal(direction);
    }

    // 设置一个定时器，周期性地尝试翻页
    fastNavInterval = setInterval(() => {
        // 只有当 state.isModalNavigating 为 false (即上一张图片已加载且动画完成) 时，
        // 并且模态框是可见的，才进行翻页
        if (!state.isModalNavigating && !elements.modal.classList.contains('opacity-0')) {
            navigateModal(fastNavDirection);
        }
    }, 300); // 每 0.3秒 检查一次是否可以翻页
}

/**
 * 停止快速导航。
 * 在用户手指离开屏幕时调用。
 */
export function stopFastNavigate() {
    clearInterval(fastNavInterval);
    fastNavInterval = null;
    fastNavDirection = null;
}