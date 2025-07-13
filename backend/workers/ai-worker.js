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
const aiAxios = axios.create();

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
    
    // 所有模型都压缩图片并转 base64
    let imageBuffer;
    try {
        imageBuffer = await sharp(imageAbsPath)
            .resize({ width: 1024 }) // 最大宽度 1024px
            .jpeg({ quality: 70 })   // JPEG 质量 70
            .toBuffer();
    } catch (e) {
        throw new Error('图片压缩失败: ' + imageAbsPath);
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
        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data?.error?.message || '无详细错误信息';
            throw new Error(`AI服务返回错误 (状态码: ${status}): ${errorData}`);
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

worker.on('completed', (job, result) => {
    logger.info(`任务 #${job.id} 已完成。结果: ${result.caption.substring(0, 30)}...`);
});

worker.on('failed', (job, err) => {
    logger.error(`任务 #${job.id} 最终失败。错误: ${err.message}`);
});