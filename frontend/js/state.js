// frontend/js/state.js

/**
 * 应用程序全局状态管理
 * 包含应用状态、API配置、UI状态等所有全局变量
 */
export const state = {
    // 应用状态和API配置
    userId: null,                                    // 用户ID
    API_BASE: '',                                   // API基础URL
    currentPhotos: [],                              // 当前照片数组
    currentPhotoIndex: 0,                           // 当前照片索引
    isModalNavigating: false,                       // 模态框导航状态
    isBlurredMode: false,                           // 模糊模式状态
    captionDebounceTimer: null,                     // 标题防抖定时器
    currentAbortController: null,                   // 当前中止控制器
    currentObjectURL: null,                         // 当前对象URL
    scrollPositions: new Map(),                     // 滚动位置缓存
    scrollPositionBeforeModal: null,                // 模态框打开前的滚动位置
    activeThumbnail: null,                          // 活动缩略图
    preSearchHash: '#/',                            // 搜索前的哈希值
    searchDebounceTimer: null,                      // 搜索防抖定时器
    hasShownNavigationHint: false,                  // 是否已显示导航提示
    lastWheelTime: 0,                               // 最后滚轮事件时间
    uiVisibilityTimer: null,                        // UI可见性定时器
    activeBackdrop: 'one',                          // 活动背景
    isInitialLoad: true,                            // 是否初始加载
    aiEnabled: false,                               // 全局AI开关状态
    passwordEnabled: false,                         // 全局密码开关状态

    // 缩略图请求队列
    thumbnailRequestQueue: [],                      // 缩略图请求队列
    activeThumbnailRequests: 0,                     // 活跃的缩略图请求数量
    MAX_CONCURRENT_THUMBNAIL_REQUESTS: 6,           // 最大并发缩略图请求数

    // 搜索和浏览状态
    isSearchLoading: false,                         // 搜索加载状态
    currentSearchPage: 1,                           // 当前搜索页码
    totalSearchPages: 1,                            // 搜索总页数
    currentSearchQuery: '',                         // 当前搜索查询
    isBrowseLoading: false,                         // 浏览加载状态
    currentBrowsePage: 1,                           // 当前浏览页码
    totalBrowsePages: 1,                            // 浏览总页数
    currentBrowsePath: null,                        // 当前浏览路径
    currentColumnCount: 0,                          // 当前列数
    pageCache: new Map(),                           // 页面缓存
};

/**
 * 模态框背景元素
 * 用于模态框的背景切换效果
 */
export const backdrops = {
    one: document.getElementById('modal-backdrop-one'),    // 背景一
    two: document.getElementById('modal-backdrop-two')     // 背景二
};

/**
 * DOM元素选择器
 * 集中管理所有需要操作的DOM元素引用
 */
export const elements = {
    // 主要视图元素
    galleryView: document.getElementById('gallery-view'),           // 画廊视图
    contentGrid: document.getElementById('content-grid'),           // 内容网格
    loadingIndicator: document.getElementById('loading'),           // 加载指示器
    breadcrumbNav: document.getElementById('breadcrumb-nav'),       // 面包屑导航
    
    // 模态框相关元素
    modal: document.getElementById('modal'),                        // 模态框容器
    modalContent: document.getElementById('modal-content'),         // 模态框内容
    modalImg: document.getElementById('modal-img'),                 // 模态框图片
    modalVideo: document.getElementById('modal-video'),             // 模态框视频
    modalClose: document.getElementById('modal-close'),             // 模态框关闭按钮
    
    // AI控制容器
    aiControlsContainer: document.getElementById('ai-controls-container'),  // AI控制容器
    
    // 标题相关元素
    captionContainer: document.getElementById('caption-container'),         // 标题容器
    captionContainerMobile: document.getElementById('caption-container-mobile'), // 移动端标题容器
    captionBubble: document.getElementById('caption-bubble'),               // 标题气泡
    captionBubbleWrapper: document.getElementById('caption-bubble-wrapper'), // 标题气泡包装器
    toggleCaptionBtn: document.getElementById('toggle-caption-btn'),        // 切换标题按钮
    
    // 其他UI元素
    navigationHint: document.getElementById('navigation-hint'),             // 导航提示
    mediaPanel: document.getElementById('media-panel'),                     // 媒体面板
    searchInput: document.getElementById('search-input'),                   // 搜索输入框
    infiniteScrollLoader: document.getElementById('infinite-scroll-loader'), // 无限滚动加载器
};