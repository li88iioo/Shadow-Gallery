const { Worker } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const path = require('path');
const winston = require('winston');
const axiosRetry = require('axios-retry');
const fs = require('fs');
const sharp = require('sharp');

// --- 日志配置 ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [AI-WORKER] ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});

// --- Redis 连接配置 ---
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null // BullMQ 推荐配置
});

// --- 从环境变量读取通用配置 ---
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL || 'http://backend:13001';

// --- AI 调用逻辑 ---
const aiAxios = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    // 连接池优化
    httpAgent: new (require('http').Agent)({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 10,
        maxFreeSockets: 5
    }),
    httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 10,
        maxFreeSockets: 5
    })
});

axiosRetry(aiAxios, {
    retries: 3,
    retryDelay: (retryCount, error) => {
        logger.warn(`AI服务请求失败 (状态: ${error.response?.status})，第 ${retryCount} 次重试...`);
        return retryCount * 2000;
    },
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && error.response.status >= 500);
    },
});

// 图片处理缓存 - 修复内存泄漏问题
class LRUCache {
    constructor(maxSize = 50) {
        this.maxSize = maxSize;
        this.cache = new Map();
        this.accessOrder = []; // 记录访问顺序
    }

    has(key) {
        return this.cache.has(key);
    }

    get(key) {
        if (this.cache.has(key)) {
            // 更新访问顺序
            this.updateAccessOrder(key);
            return this.cache.get(key);
        }
        return null;
    }

    set(key, value) {
        // 如果已存在，先删除旧的
        if (this.cache.has(key)) {
            this.cache.delete(key);
            this.removeFromAccessOrder(key);
        }

        // 如果达到最大大小，删除最久未使用的项
        if (this.cache.size >= this.maxSize) {
            this.evictOldest();
        }

        // 添加新项
        this.cache.set(key, value);
        this.accessOrder.push(key);
    }

    delete(key) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
            this.removeFromAccessOrder(key);
        }
    }

    clear() {
        this.cache.clear();
        this.accessOrder = [];
    }

    size() {
        return this.cache.size;
    }

    // 更新访问顺序
    updateAccessOrder(key) {
        this.removeFromAccessOrder(key);
        this.accessOrder.push(key);
    }

    // 从访问顺序中移除
    removeFromAccessOrder(key) {
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
        }
    }

    // 删除最久未使用的项
    evictOldest() {
        if (this.accessOrder.length > 0) {
            const oldestKey = this.accessOrder.shift();
            this.cache.delete(oldestKey);
            logger.debug(`LRU缓存清理: 删除最久未使用的缓存项: ${oldestKey}`);
        }
    }

    // 获取缓存统计信息
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            usage: Math.round((this.cache.size / this.maxSize) * 100)
        };
    }
}

// 创建LRU缓存实例
const imageCache = new LRUCache(50);

// 定期清理缓存（每10分钟检查一次）
const CACHE_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10分钟
setInterval(() => {
    const stats = imageCache.getStats();
    if (stats.usage > 80) {
        logger.info(`缓存使用率较高 (${stats.usage}%)，执行清理...`);
        // 清理一半的缓存
        const keysToRemove = Math.floor(stats.size / 2);
        for (let i = 0; i < keysToRemove; i++) {
            if (imageCache.accessOrder.length > 0) {
                const oldestKey = imageCache.accessOrder.shift();
                imageCache.cache.delete(oldestKey);
            }
        }
        logger.info(`缓存清理完成，清理了 ${keysToRemove} 个项目`);
    }
}, CACHE_CLEANUP_INTERVAL);

/**
 * 核心处理函数：接收一个任务，调用AI，并返回结果
 * @param {string} relativeImagePath - 图片相对于照片根目录的路径
 * @param {object} aiConfig - 从数据库读取的AI配置
 * @returns {Promise<string>} - 返回AI生成的描述
 */
async function generateCaptionForImage(relativeImagePath, aiConfig) {
    if (!aiConfig || !aiConfig.url || !aiConfig.key) {
        throw new Error('AI 服务配置不完整或未提供');
    }

    const imageAbsPath = path.join(process.env.PHOTOS_DIR || '/app/photos', relativeImagePath);
    
    // 检查图片处理缓存
    const cacheKey = `${imageAbsPath}_1024_70`;
    let imageBuffer;
    
    if (imageCache.has(cacheKey)) {
        imageBuffer = imageCache.get(cacheKey);
        logger.debug(`使用缓存的图片处理结果: ${relativeImagePath}`);
    } else {
        // 所有模型都压缩图片并转 base64
        try {
            imageBuffer = await sharp(imageAbsPath)
                .resize({ width: 1024 }) // 最大宽度 1024px
                .jpeg({ quality: 70 })   // JPEG 质量 70
                .toBuffer();
            
            // 使用LRU缓存存储处理结果
            imageCache.set(cacheKey, imageBuffer);
            logger.debug(`图片处理结果已缓存: ${relativeImagePath} (缓存大小: ${imageCache.size()})`);
        } catch (e) {
            throw new Error('图片压缩失败: ' + imageAbsPath);
        }
    }
    
    const base64Image = imageBuffer.toString('base64');

    // --- FIX: 使用标准的 OpenAI 兼容格式 ---
    const payload = {
        model: aiConfig.model,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: aiConfig.prompt },
                { 
                    type: 'image_url', 
                    image_url: {
                        "url": `data:image/jpeg;base64,${base64Image}`
                    }
                }
            ]
        }],
        max_tokens: 300
    };

    const fullApiUrl = new URL('/v1/chat/completions', aiConfig.url).toString();
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.key}` };

    try {
        const aiResponse = await aiAxios.post(fullApiUrl, payload, { headers, timeout: 30000 });
        const description = aiResponse.data.choices?.[0]?.message?.content;

        if (!description) {
            throw new Error('AI 未能生成有效内容');
        }
        return description.trim();
    } catch (error) {
        // 清理缓存中的失败项
        if (imageCache.has(cacheKey)) {
            imageCache.delete(cacheKey);
            logger.debug(`清理失败的缓存项: ${cacheKey}`);
        }
        
        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data?.error?.message || '无详细错误信息';
            
            // 根据错误类型提供更具体的错误信息
            if (status === 401) {
                throw new Error('AI服务认证失败，请检查API密钥');
            } else if (status === 429) {
                throw new Error('AI服务请求频率过高，请稍后重试');
            } else if (status >= 500) {
                throw new Error(`AI服务内部错误 (${status}): ${errorData}`);
            } else {
                throw new Error(`AI服务返回错误 (状态码: ${status}): ${errorData}`);
            }
        } else if (error.request) {
            throw new Error('无法连接到AI服务，请检查网络或AI URL配置');
        } else {
            throw new Error(`调用AI服务时发生未知错误: ${error.message}`);
        }
    }
}

const worker = new Worker('ai-caption-queue', async job => {
    // 从 job.data 中获取图片路径和 AI 配置
    const { imagePath, aiConfig } = job.data;
    logger.info(`开始处理AI任务 #${job.id}，图片: ${imagePath}`);

    try {
        const caption = await generateCaptionForImage(imagePath, aiConfig);
        logger.info(`成功处理AI任务 #${job.id}，图片: ${imagePath}`);
        return { success: true, caption: caption };
    } catch (error) {
        logger.error(`AI任务 #${job.id} 处理失败: ${error.message}`);
        throw error;
    }
}, { connection: redisConnection });

logger.info('AI Worker 已启动，正在等待任务...');

// 定期输出缓存统计信息（每5分钟）
setInterval(() => {
    const stats = imageCache.getStats();
    logger.info(`AI Worker 缓存统计: ${stats.size}/${stats.maxSize} (${stats.usage}% 使用率)`);
}, 5 * 60 * 1000);

worker.on('completed', (job, result) => {
    logger.info(`任务 #${job.id} 已完成。结果: ${result.caption.substring(0, 30)}...`);
});

worker.on('failed', (job, err) => {
    logger.error(`任务 #${job.id} 最终失败。错误: ${err.message}`);
});