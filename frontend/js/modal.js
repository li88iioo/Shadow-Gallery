// frontend/js/modal.js

import { state, elements, backdrops } from './state.js';
import { preloadNextImages, showNotification } from './utils.js';
import { generateImageCaption } from './api.js';

let activeLoader = null;

function updateModalContent(mediaSrc, index, originalPathForAI, thumbForBlur = null) {
    state.currentPhotoIndex = index;
    const { modalVideo, modalImg, toggleCaptionBtn, navigationHint, captionBubble, captionContainer, captionContainerMobile } = elements;
    
    modalVideo.pause();
    modalVideo.src = '';
    modalImg.src = ''; 
    if (state.currentObjectURL) {
        URL.revokeObjectURL(state.currentObjectURL);
        state.currentObjectURL = null;
    }

    const isVideo = /\.(mp4|webm|mov)$/i.test(originalPathForAI);
    
    const blurSource = thumbForBlur || mediaSrc;
    const inactiveBackdropKey = state.activeBackdrop === 'one' ? 'two' : 'one';
    const activeBackdropElem = backdrops[state.activeBackdrop];
    const inactiveBackdropElem = backdrops[inactiveBackdropKey];
    
    inactiveBackdropElem.style.backgroundImage = `url('${blurSource}')`;
    inactiveBackdropElem.classList.add('active-backdrop');
    activeBackdropElem.classList.remove('active-backdrop');
    state.activeBackdrop = inactiveBackdropKey;

    toggleCaptionBtn.style.display = isVideo ? 'none' : 'flex';
    modalVideo.classList.toggle('hidden', !isVideo);
    modalImg.classList.toggle('hidden', isVideo);
    
    if (isVideo) {
        navigationHint.classList.remove('show-hint');
        navigationHint.style.display = 'none';
        modalVideo.src = mediaSrc;
        modalVideo.play().catch(e => {
            console.error("Video playback failed:", e);
            showNotification('视频无法自动播放。', 'error');
        });
        captionBubble.classList.remove('show');
    } else {
        navigationHint.style.display = 'flex';
        modalImg.src = mediaSrc; 
        if (!modalImg._noContextMenuBound) {
            modalImg.addEventListener('contextmenu', e => e.preventDefault());
            modalImg._noContextMenuBound = true;
        }
        clearTimeout(state.captionDebounceTimer);
        state.captionDebounceTimer = setTimeout(() => generateImageCaption(originalPathForAI), 300);
        captionContainer.innerHTML = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">酝酿中...</p></div>';
        captionContainerMobile.innerHTML = '酝酿中...';
    }
    
    preloadNextImages(state.currentPhotos, index);
}


async function handleModalNavigationLoad(mediaSrc, index) {
    const originalPath = state.currentPhotos[index];
    const isVideo = /\.(mp4|webm|mov)$/i.test(originalPath);

    if (isVideo) {
        const gridItem = document.querySelector(`[onclick*="'${originalPath}'"]`);
        const thumbEl = gridItem ? gridItem.querySelector('img[data-src]') : null;
        const thumbUrl = thumbEl ? thumbEl.dataset.src : null;
        updateModalContent(originalPath, index, originalPath, thumbUrl);
        return;
    }

    if (state.isModalNavigating) return;
    state.isModalNavigating = true;

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

export function closeModal() {
    if (elements.modal.classList.contains('opacity-0')) {
        return;
    }

    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    elements.modal.classList.add('opacity-0', 'pointer-events-none');
    elements.modalImg.src = '';
    elements.modalVideo.pause();
    elements.modalVideo.src = '';
    backdrops.one.style.backgroundImage = 'none';
    backdrops.two.style.backgroundImage = 'none';
    if (state.currentObjectURL) {
        URL.revokeObjectURL(state.currentObjectURL);
        state.currentObjectURL = null;
    }
    elements.captionBubble.classList.remove('show');
    if (document.activeElement) {
        document.activeElement.blur();
    }

    // 恢复滚动位置和焦点
    if (state.scrollPositionBeforeModal !== null) {
        window.scrollTo({ top: state.scrollPositionBeforeModal, behavior: 'instant' });
        state.scrollPositionBeforeModal = null;
    }
    if (state.activeThumbnail) {
        state.activeThumbnail.focus({ preventScroll: true });
        state.activeThumbnail = null;
    }
}

export function navigateModal(direction) {
    if (document.activeElement) document.activeElement.blur();
    if (state.isModalNavigating) return;
    
    hideModalControls(); 
    clearTimeout(state.uiVisibilityTimer);
    state.uiVisibilityTimer = setTimeout(showModalControls, 500);
    
    const newIndex = direction === 'prev' ? state.currentPhotoIndex - 1 : state.currentPhotoIndex + 1;
    if (newIndex >= 0 && newIndex < state.currentPhotos.length) {
        const nextMediaSrc = state.currentPhotos[newIndex];
        handleModalNavigationLoad(nextMediaSrc, newIndex);
    }
}

export function _handleThumbnailClick(element, mediaSrc, index) {
    // 保存打开前的状态
    state.scrollPositionBeforeModal = window.scrollY;
    state.activeThumbnail = element;

    const photoItem = element.closest('.photo-item');
    if (photoItem.classList.contains('is-loading')) return;

    const isVideo = /\.(mp4|webm|mov)$/i.test(mediaSrc);

    if (isVideo) {
        const thumbEl = photoItem.querySelector('img[data-src]');
        const thumbUrl = thumbEl ? thumbEl.dataset.src : null;
        _openModal(mediaSrc, index, false, mediaSrc, thumbUrl);
        return;
    }
    
    if (activeLoader) activeLoader.abort();
    
    const progressCircle = photoItem.querySelector('.progress-circle-bar');
    const radius = progressCircle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    progressCircle.style.strokeDasharray = `${circumference} ${circumference}`;
    progressCircle.style.strokeDashoffset = circumference;
    
    photoItem.classList.add('is-loading');
    
    const controller = new AbortController();
    const { signal } = controller;
    activeLoader = controller;

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
                                if (contentLength) {
                                    const progress = receivedLength / contentLength;
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
        .then(response => response.blob())
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

export function _openModal(mediaSrc, index = 0, isObjectURL = false, originalPathForAI = null, thumbForBlur = null) {
    // 【最终修复】这里不需要再保存滚动位置，因为 handleHashChange 会统一处理
    
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    if (document.activeElement) document.activeElement.blur();
    
    if (!mediaSrc || typeof mediaSrc !== 'string' || mediaSrc.trim() === '') {
        console.error('Failed to open modal: Invalid media source:', mediaSrc);
        return;
    }

    elements.modal.classList.remove('opacity-0', 'pointer-events-none');
    
    const aiPath = originalPathForAI || mediaSrc;
    updateModalContent(mediaSrc, index, aiPath, thumbForBlur);
    
    if (isObjectURL) state.currentObjectURL = mediaSrc;

    if (!state.hasShownNavigationHint && window.innerWidth > 768) {
        elements.navigationHint.classList.add('show-hint');
        state.hasShownNavigationHint = true;
        setTimeout(() => elements.navigationHint.classList.remove('show-hint'), 4000);
    }

    if (!window.location.hash.endsWith('#modal')) {
        window.history.pushState({ modal: true }, '', window.location.href + '#modal');
    }
}

export function _navigateToAlbum(event, albumPath) {
    event.preventDefault();
    if (document.activeElement) document.activeElement.blur();
    
    // 【最终修复】这里不再需要保存滚动位置，交由 handleHashChange 处理
    
    // 【最终修复】彻底移除导致非预期滚动的“高亮”逻辑
    
    window.location.hash = `/${encodeURIComponent(albumPath)}`;
};

function hideModalControls() {
    elements.modalClose.classList.add('opacity-0');
    elements.captionBubbleWrapper.classList.add('opacity-0');
}

function showModalControls() {
    elements.modalClose.classList.remove('opacity-0');
    elements.captionBubbleWrapper.classList.remove('opacity-0');
}