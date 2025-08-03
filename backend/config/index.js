const path = require('path');

/**
 * 后端全局配置模块
 * 统一管理端口、目录、数据库、缓存、AI服务等所有后端配置项
 */

// --- 应用配置 ---
const PORT = process.env.PORT || 13001;                // 服务端口
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';      // 日志级别

// --- 目录配置 ---
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.resolve(__dirname, '..', 'photos'); // 图片/视频主目录
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');       // 数据存储目录

// --- 多数据库配置 ---
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');         // 主数据库（图片/视频索引）
const SETTINGS_DB_FILE = path.resolve(DATA_DIR, 'settings.db'); // 设置数据库
const HISTORY_DB_FILE = path.resolve(DATA_DIR, 'history.db');   // 历史记录数据库
const INDEX_DB_FILE = path.resolve(DATA_DIR, 'index.db');       // 索引数据库

const THUMBS_DIR = path.resolve(DATA_DIR, 'thumbnails');        // 缩略图存储目录
const PLACEHOLDER_DIR = path.resolve(__dirname, '..', 'assets'); // 占位符图片目录

// --- 占位符路径 ---
const THUMB_PLACEHOLDER_PATH = path.join(PLACEHOLDER_DIR, 'loading-placeholder.svg'); // 加载中占位符
const BROKEN_IMAGE_PATH = path.join(PLACEHOLDER_DIR, 'broken-image.svg');             // 损坏图片占位符

// --- Redis & BullMQ ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'; // Redis连接地址
const AI_CAPTION_QUEUE_NAME = 'ai-caption-queue';                    // AI字幕任务队列名

// --- API & 性能 ---
const API_BASE = '';                                              // API基础路径（预留）
const NUM_WORKERS = Math.max(1, Math.floor(require('os').cpus().length / 2)); // 工作进程数
const MAX_THUMBNAIL_RETRIES = 5;                                  // 缩略图最大重试次数
const INITIAL_RETRY_DELAY = 2000;                                 // 缩略图初始重试延迟（毫秒）

module.exports = {
    PORT,                    // 服务端口
    LOG_LEVEL,               // 日志级别
    PHOTOS_DIR,              // 图片/视频主目录
    DATA_DIR,                // 数据存储目录
    DB_FILE,                 // 主数据库
    SETTINGS_DB_FILE,        // 设置数据库
    HISTORY_DB_FILE,         // 历史记录数据库
    INDEX_DB_FILE,           // 索引数据库
    THUMBS_DIR,              // 缩略图目录
    PLACEHOLDER_DIR,         // 占位符目录
    THUMB_PLACEHOLDER_PATH,  // 加载中占位符
    BROKEN_IMAGE_PATH,       // 损坏图片占位符
    REDIS_URL,               // Redis连接地址
    AI_CAPTION_QUEUE_NAME,   // AI字幕队列名
    API_BASE,                // API基础路径
    NUM_WORKERS,             // 工作进程数
    MAX_THUMBNAIL_RETRIES,   // 缩略图最大重试次数
    INITIAL_RETRY_DELAY,     // 缩略图初始重试延迟
};