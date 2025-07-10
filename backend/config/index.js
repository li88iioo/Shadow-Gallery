const path = require('path');

// --- 应用配置 ---
const PORT = process.env.PORT || 13001;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// --- 目录配置 ---
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.resolve(__dirname, '..', 'photos');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');
const THUMBS_DIR = path.resolve(DATA_DIR, 'thumbnails');
const PLACEHOLDER_DIR = path.resolve(__dirname, '..', 'assets');

// --- 占位符路径 ---
const THUMB_PLACEHOLDER_PATH = path.join(PLACEHOLDER_DIR, 'loading-placeholder.svg');
const BROKEN_IMAGE_PATH = path.join(PLACEHOLDER_DIR, 'broken-image.svg');

// --- Redis & BullMQ ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const AI_CAPTION_QUEUE_NAME = 'ai-caption-queue';

// --- AI 服务配置 ---
const ONEAPI_URL = process.env.ONEAPI_URL;
const ONEAPI_KEY = process.env.ONEAPI_KEY;

// --- API & 性能 ---
const API_BASE = '';
const NUM_WORKERS = Math.max(1, Math.floor(require('os').cpus().length / 2));
const MAX_THUMBNAIL_RETRIES = 5;
const INITIAL_RETRY_DELAY = 2000;

module.exports = {
    PORT,
    LOG_LEVEL,
    PHOTOS_DIR,
    DATA_DIR,
    DB_FILE,
    THUMBS_DIR,
    PLACEHOLDER_DIR,
    THUMB_PLACEHOLDER_PATH,
    BROKEN_IMAGE_PATH,
    REDIS_URL,
    AI_CAPTION_QUEUE_NAME,
    ONEAPI_URL,
    ONEAPI_KEY,
    API_BASE,
    NUM_WORKERS,
    MAX_THUMBNAIL_RETRIES,
    INITIAL_RETRY_DELAY,
};