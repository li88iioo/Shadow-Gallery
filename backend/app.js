const express = require('express');
const cors = require('cors');
const path = require('path');
const { PHOTOS_DIR, THUMBS_DIR } = require('./config');
const apiLimiter = require('./middleware/rateLimiter');
const mainRouter = require('./routes');
const logger = require('./config/logger');

const app = express();

// --- 中间件设置 ---
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- 静态文件服务 ---
app.use('/static', express.static(PHOTOS_DIR, {
    maxAge: '30d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        }
    }
}));
app.use('/thumbs', express.static(THUMBS_DIR, {
    maxAge: '30d',
    immutable: true
}));

// --- API 路由 ---
app.use('/api', apiLimiter, mainRouter);

// --- 健康检查 ---
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// --- 错误处理 (示例) ---
// 可以在这里添加更复杂的错误处理中间件
app.use((err, req, res, next) => {
    logger.error('未捕获的服务器错误:', err);
    res.status(500).send('服务器发生内部错误');
});


module.exports = app;