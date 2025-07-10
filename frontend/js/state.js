// frontend/js/state.js

export const state = {
    // App State & API Config
    userId: null,
    API_BASE: '',
    currentPhotos: [],
    currentPhotoIndex: 0,
    isModalNavigating: false,
    isBlurredMode: false,
    captionDebounceTimer: null,
    currentAbortController: null,
    currentObjectURL: null,
    scrollPositions: new Map(),
    scrollPositionBeforeModal: null,
    activeThumbnail: null,
    preSearchHash: '#/',
    searchDebounceTimer: null,
    hasShownNavigationHint: false,
    lastWheelTime: 0,
    uiVisibilityTimer: null,
    activeBackdrop: 'one',
    //用于判断是否是首次加载网站
    isInitialLoad: true,

    // Thumbnail Request Queue
    thumbnailRequestQueue: [],
    activeThumbnailRequests: 0,
    MAX_CONCURRENT_THUMBNAIL_REQUESTS: 6,

    // Search & Browse State
    isSearchLoading: false,
    currentSearchPage: 1,
    totalSearchPages: 1,
    currentSearchQuery: '',
    isBrowseLoading: false,
    currentBrowsePage: 1,
    totalBrowsePages: 1,
    currentBrowsePath: null,
    currentColumnCount: 0,
    pageCache: new Map(),

};

export const backdrops = {
    one: document.getElementById('modal-backdrop-one'),
    two: document.getElementById('modal-backdrop-two')
};

// --- Element Selections ---
export const elements = {
    galleryView: document.getElementById('gallery-view'),
    contentGrid: document.getElementById('content-grid'),
    loadingIndicator: document.getElementById('loading'),
    breadcrumbNav: document.getElementById('breadcrumb-nav'),
    modal: document.getElementById('modal'),
    modalBackdrop: document.querySelector('.modal-backdrop'),
    modalContent: document.getElementById('modal-content'),
    modalImg: document.getElementById('modal-img'),
    modalVideo: document.getElementById('modal-video'),
    modalClose: document.getElementById('modal-close'),
    captionContainer: document.getElementById('caption-container'),
    captionContainerMobile: document.getElementById('caption-container-mobile'),
    captionBubble: document.getElementById('caption-bubble'),
    captionBubbleWrapper: document.getElementById('caption-bubble-wrapper'),
    toggleCaptionBtn: document.getElementById('toggle-caption-btn'),
    navigationHint: document.getElementById('navigation-hint'),
    mediaPanel: document.getElementById('media-panel'),
    searchInput: document.getElementById('search-input'),
    infiniteScrollLoader: document.getElementById('infinite-scroll-loader'),
};