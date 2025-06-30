
// 引入所需模块
const express = require('express');
const { promises: fs } = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const winston = require('winston');
const chokidar = require('chokidar');
const sqlite3 = require('sqlite3').verbose();

// --- 配置 ---
const PORT = process.env.PORT || 13001;
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.resolve(__dirname, 'photos');
const DB_FILE = path.resolve(process.env.DATA_DIR || __dirname, 'gallery.db');

// --- AI 服务配置 ---
const ONEAPI_URL = process.env.ONEAPI_URL;
const ONEAPI_KEY = process.env.ONEAPI_KEY;
const ONEAPI_MODEL = process.env.ONEAPI_MODEL || 'gpt-4-vision-preview';
// --- 关键修改：从环境变量加载 AI 提示，并提供一个默认值 ---
const AI_PROMPT = process.env.AI_PROMPT || `
        你将完全代入照片中的人物角色，与正在凝视照片的“他”进行一场只有你们两人知道的私密对话。你的回应必须直接以对话内容开始，绝对禁止出现任何如“好的”、“当然”、“这是我的回应”等多余的开场白和前缀。语言风格必须极具诱惑力，充满喘息感和停顿，总字数控制在80字以内 `;
// --- Redis 配置 ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
    retryStrategy: times => {
        logger.warn(`Redis连接失败，第${times}次重试...`);
        return Math.min(times * 1000, 5000);
    },
    maxRetriesPerRequest: 5
});

// --- 日志配置 ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

redis.on('connect', () => logger.info('Redis 连接成功!'));
redis.on('error', err => logger.error('Redis错误:', err.code === 'ECONNREFUSED' ? '无法连接Redis，请检查服务状态' : err));

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        logger.error(`无法连接或创建 SQLite 数据库: ${err.message}.`);
        logger.error(`请确保后端容器对挂载的数据卷有写入权限。`);
    } else {
        logger.info('成功连接到 SQLite 数据库:', DB_FILE);
        db.run(`CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL,
            search_key TEXT NOT NULL
        )`);
    }
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
    });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

function isPathSafe(requestedPath) {
    const dangerousPatterns = [ /\.\./g, /[<>:"|?*]/g, /^\/+/, /\/{2,}/g ];
    for (const pattern of dangerousPatterns) {
        if (pattern.test(requestedPath)) {
            logger.warn(`检测到不安全的路径模式: ${requestedPath} (模式: ${pattern})`);
            return false;
        }
    }
    const normalizedPath = path.normalize(requestedPath);
    const fullPath = path.resolve(PHOTOS_DIR, normalizedPath);
    const relativePath = path.relative(PHOTOS_DIR, fullPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        logger.warn(`检测到路径遍历尝试: ${requestedPath} (解析后: ${fullPath})`);
        return false;
    }
    return true;
}

function sanitizePath(inputPath) {
    return inputPath.replace(/\.\./g, '').replace(/[<>:"|?*]/g, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

async function* walkDirStream(dir, relativePath = '') {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);
            if (entry.isDirectory()) {
                yield { key: entry.name.toLowerCase(), value: { type: 'album', path: entryRelativePath, name: entry.name } };
                yield* walkDirStream(fullPath, entryRelativePath);
            } else if (entry.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(entry.name)) { // 修改点：添加视频格式
                const type = /\.(jpe?g|png|webp|gif)$/i.test(entry.name) ? 'photo' : 'video';
                yield { key: path.parse(entry.name).name.toLowerCase(), value: { type: type, path: entryRelativePath, name: entry.name } };
            }
        }
    } catch(e) {
        logger.error(`遍历目录失败: ${dir}`, e);
    }
}

async function findCoverPhoto(directoryPath) {
    try {
        if (!directoryPath || typeof directoryPath !== 'string' || directoryPath.trim() === '') return null;
        const relativePath = path.relative(PHOTOS_DIR, directoryPath);
        if (!isPathSafe(relativePath)) return null;
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(entry.name)) {
                return path.join(directoryPath, entry.name);
            }
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const cover = await findCoverPhoto(path.join(directoryPath, entry.name));
                if (cover) return cover;
            }
        }
    } catch (e) {
        logger.debug(`查找封面失败: ${directoryPath}`, e);
    }
    return null;
}

async function streamDirectoryContents(directory, relativePathPrefix, res) {
    try {
        if (!isPathSafe(relativePathPrefix)) throw new Error('不安全的路径访问');
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const subAlbumEntries = (await Promise.all(
            entries.filter(e => e.isDirectory()).map(async e => {
                const fullPath = path.join(directory, e.name);
                const stat = await fs.stat(fullPath).catch(() => ({ mtimeMs: 0 }));
                return { entry: e, mtime: stat.mtimeMs };
            })
        )).sort((a, b) => b.mtime - a.mtime).map(obj => obj.entry);

        // 分别处理图片和视频
        const photoEntries = entries.filter(e => e.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        const videoEntries = entries.filter(e => e.isFile() && /\.(mp4|webm|mov)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));

        for (const entry of subAlbumEntries) {
            const entryRelativePath = path.join(relativePathPrefix, entry.name);
            const coverAbsPath = await findCoverPhoto(path.join(directory, entry.name));
            let coverUrl = 'data:image/svg+xml,...';
            if (coverAbsPath) {
                coverUrl = path.join('/static', path.relative(PHOTOS_DIR, coverAbsPath)).replace(/\\/g, '/');
            }
            res.write(JSON.stringify({ type: 'album', data: { name: entry.name, path: entryRelativePath.replace(/\\/g, '/'), coverUrl } }) + '\n');
        }

        for (const entry of photoEntries) {
            const entryRelativePath = path.join(relativePathPrefix, entry.name);
            res.write(JSON.stringify({ type: 'photo', data: path.join('/static', entryRelativePath).replace(/\\/g, '/') }) + '\n');
        }

        // 新增视频流式响应
        for (const entry of videoEntries) {
            const entryRelativePath = path.join(relativePathPrefix, entry.name);
            res.write(JSON.stringify({ type: 'video', data: path.join('/static', entryRelativePath).replace(/\\/g, '/') }) + '\n');
        }

    } catch (err) {
        logger.error(`流式处理目录 ${directory} 时出错:`, err);
        throw err;
    }
}


let rebuildTimeout;
let isIndexing = false; 

async function buildSearchIndex() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次请求被跳过。');
        return;
    }
    isIndexing = true;
    logger.info('开始使用 SQLite 构建搜索索引...');
    
    try {
        await dbRun("BEGIN TRANSACTION");
        await dbRun("DELETE FROM items");
        const stmt = db.prepare("INSERT OR IGNORE INTO items (name, path, type, search_key) VALUES (?, ?, ?, ?)");
        let count = 0;
        for await (const { key, value } of walkDirStream(PHOTOS_DIR)) {
            await new Promise((resolve, reject) => {
                stmt.run(value.name, value.path, value.type, key, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            count++;
        }
        await new Promise((resolve, reject) => {
            stmt.finalize(err => { if (err) reject(err); else resolve(); });
        });
        await dbRun("COMMIT");
        logger.info(`SQLite 搜索索引构建完成，共处理 ${count} 个条目`);
    } catch (error) {
        logger.error('构建 SQLite 搜索索引失败:', error.message);
        try {
            await dbRun("ROLLBACK");
            logger.info('数据库事务已回滚。');
        } catch (rollbackError) {
            logger.error('事务回滚失败:', rollbackError.message);
        }
    } finally {
        isIndexing = false;
        logger.info('索引任务结束。');
    }
}

function watchPhotosDir() {
    const watcher = chokidar.watch(PHOTOS_DIR, {
        ignoreInitial: true,
        persistent: true,
        depth: 10,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
    });

    const triggerRebuild = () => {
        clearTimeout(rebuildTimeout);
        rebuildTimeout = setTimeout(() => {
            logger.info('文件系统稳定，准备执行索引重建...');
            buildSearchIndex();
        }, 5000); // 5秒延迟
    };

    logger.info(`开始监控照片目录: ${PHOTOS_DIR}`);
    watcher
        .on('add', path => { logger.debug(`检测到新增文件: ${path}`); triggerRebuild(); })
        .on('unlink', path => { logger.debug(`检测到删除文件: ${path}`); triggerRebuild(); })
        .on('addDir', path => { logger.debug(`检测到新增目录: ${path}`); triggerRebuild(); })
        .on('unlinkDir', path => { logger.debug(`检测到删除目录: ${path}`); triggerRebuild(); })
        .on('error', error => logger.error('目录监控出错:', error));
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const apiLimiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW_MINUTES || 15) * 60 * 1000, // 从环境变量读取窗口时间，默认为15分钟
    max: process.env.RATE_LIMIT_MAX_REQUESTS || 100, // 从环境变量读取最大请求数，默认为100
    message: { error: '请求过于频繁，请稍后再试。' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);
app.use('/static', express.static(PHOTOS_DIR, {
    maxAge: '30d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath)) { // 修改点：为视频也添加缓存头
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        }
    }
}));

app.get('/api/browse', async (req, res) => {
    try {
        const queryPath = req.query.path || '';
        const sanitizedPath = sanitizePath(queryPath);
        if (!isPathSafe(sanitizedPath)) return res.status(403).json({ error: '路径访问被拒绝' });
        const currentPath = path.join(PHOTOS_DIR, sanitizedPath);
        const stats = await fs.stat(currentPath).catch(() => null);
        if (!stats || !stats.isDirectory()) return res.status(404).json({ error: '路径未找到或不是目录' });

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        await streamDirectoryContents(currentPath, sanitizedPath, res);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: '服务器内部错误', message: err.message });
    } finally {
        if (!res.writableEnded) res.end();
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const query = (req.query.q || '').toLowerCase().trim();
        if (!query) return res.status(400).json({ error: '搜索关键词不能为空' });
        const cacheKey = `search:sqlite:${query}`;
        const cachedResults = await redis.get(cacheKey);
        if (cachedResults) {
            logger.info(`从 Redis 缓存获取搜索结果: ${query}`);
            return res.json(JSON.parse(cachedResults));
        }

        const sql = `
            SELECT name, path, type FROM items 
            WHERE search_key LIKE ? 
            ORDER BY CASE type WHEN 'album' THEN 1 ELSE 2 END, name
        `;
        const rows = await dbAll(sql, [`%${query}%`]);
        const resultsWithCovers = await Promise.all(
            rows.map(async (result) => {
                if (result.type === 'album') {
                    const coverAbsPath = await findCoverPhoto(path.join(PHOTOS_DIR, result.path));
                    let coverUrl = 'data:image/svg+xml,...';
                    if (coverAbsPath) coverUrl = path.join('/static', path.relative(PHOTOS_DIR, coverAbsPath)).replace(/\\/g, '/');
                    return { ...result, coverUrl };
                }
                return { ...result, path: result.path.replace(/\\/g, '/') };
            })
        );
        const responseData = { query, results: resultsWithCovers, count: resultsWithCovers.length };
        await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 3600);
        logger.info(`搜索结果已存入 Redis 缓存: ${query}`);
        res.json(responseData);
    } catch (err) {
        logger.error("搜索 API 顶层出错:", err.message);
        res.status(500).json({ error: '搜索失败' });
    }
});

// --- AI 生成接口 ---
app.post('/api/ai/generate', async (req, res) => {
    if (!ONEAPI_URL || !ONEAPI_KEY) {
        return res.status(500).json({ error: 'AI服务未在后端配置' });
    }
    try {
        // 从请求体中只获取需要的部分，忽略前端可能发送的 prompt
        const { image_data, model, image_url } = req.body;

        // 检查必须的 image_data 是否存在
        if (!image_data) {
            return res.status(400).json({ error: '缺少必要的参数: image_data' });
        }
        
        // **使用从环境变量加载的 AI_PROMPT**
        const promptToUse = AI_PROMPT; 

        let payload, cacheKey = null;

        payload = {
            model: model || ONEAPI_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: promptToUse }, // 使用后端的提示词
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_data}` } }
                    ]
                }
            ],
            max_tokens: 300
        };

        if (image_url) {
            cacheKey = `ai_description:${image_url}`;
            const cachedDescription = await redis.get(cacheKey);
            if (cachedDescription) {
                logger.info(`从 Redis 缓存获取图片描述: ${image_url}`);
                return res.json({ description: cachedDescription });
            }
        }

        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ONEAPI_KEY}` };
        const aiResponse = await axios.post(ONEAPI_URL, payload, { headers });
        const description = aiResponse.data.choices?.[0]?.message?.content;

        if (description) {
            if (cacheKey) {
                await redis.set(cacheKey, description, 'EX', 3600 * 24 * 7);
            }
            res.json({ description });
        } else {
            res.status(500).json({ error: 'AI未能生成有效内容' });
        }
    } catch (error) {
        logger.error('调用AI服务失败:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: '调用AI服务时发生错误',
            message: error.response?.data?.error?.message || error.message
        });
    }
});


app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, async () => {
    logger.info(`后端服务已启动在 http://localhost:${PORT}`);
    logger.info(`照片目录: ${PHOTOS_DIR}`);
    if (!process.env.ONEAPI_URL || !process.env.ONEAPI_KEY) {
        logger.warn('警告: AI服务环境变量未设置，AI功能将不可用。');
    }
    await buildSearchIndex();
    watchPhotosDir();
});