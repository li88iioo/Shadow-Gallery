const { Worker } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const winston = require('winston');

// --- 日志配置 ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [AI-WORKER] ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});

// --- Redis 连接配置 ---
// BullMQ 推荐为 Worker 和 Queue 使用独立的 Redis 连接实例
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null // BullMQ 推荐配置
});

// --- AI 服务配置 (与 server.js 保持一致) ---
const ONEAPI_URL = process.env.ONEAPI_URL;
const ONEAPI_KEY = process.env.ONEAPI_KEY;
const ONEAPI_MODEL = process.env.ONEAPI_MODEL || 'gpt-4-vision-preview';
const AI_PROMPT = process.env.AI_PROMPT || `你将完全代入照片中的人物角色，与正在凝视照片的“他”进行一场只有你们两人知道的私密对话。你的回应必须直接以对话内容开始，绝对禁止出现任何如“好的”、“当然”、“这是我的回应”等多余的开场白和前缀。语言风格必须极具诱惑力，充满喘息感和停顿，总字数控制在80字以内`;
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.resolve(__dirname, 'photos');

// 新增：后端服务在 Docker 网络中的地址，供 AI Worker 内部访问
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL || 'http://backend:13001'; // 默认使用 Docker 网络中的服务名和端口

// --- AI 调用逻辑  ---
const aiAxios = axios.create();
const axiosRetry = require('axios-retry');

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
 * @returns {Promise<string>} - 返回AI生成的描述
 */
async function generateCaptionForImage(relativeImagePath) {
    if (!ONEAPI_URL || !ONEAPI_KEY) {
        throw new Error('AI 服务未在环境变量中配置 (ONEAPI_URL, ONEAPI_KEY)');
    }

    // 构造 AI 服务可以直接访问的图片 URL
    const imageUrlForAI = `${BACKEND_INTERNAL_URL}/static/${encodeURIComponent(relativeImagePath).split('/').join('/')}`;
    logger.debug(`发送图片URL给AI服务: ${imageUrlForAI}`);

    const payload = {
        model: ONEAPI_MODEL,
        messages: [{
            role: "user",
            content: [
                { type: "text", text: AI_PROMPT },
                { type: "image_url", image_url: { url: imageUrlForAI } } // 直接使用图片 URL
            ]
        }],
        max_tokens: 300
    };

    const fullApiUrl = new URL('/v1/chat/completions', ONEAPI_URL).toString();
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ONEAPI_KEY}` };

    const aiResponse = await aiAxios.post(fullApiUrl, payload, { headers, timeout: 30000 });
    const description = aiResponse.data.choices?.[0]?.message?.content;

    if (!description) {
        throw new Error('AI 未能生成有效内容');
    }
    return description.trim();
}

// 'ai-caption-queue' 是队列名称，必须与 server.js 中创建队列时使用的名称一致
const worker = new Worker('ai-caption-queue', async job => {
    const { imagePath } = job.data;
    logger.info(`开始处理AI任务 #${job.id}，图片: ${imagePath}`);

    try {
        const caption = await generateCaptionForImage(imagePath);
        logger.info(`成功处理AI任务 #${job.id}，图片: ${imagePath}`);
        return { success: true, caption: caption }; // 任务成功，返回结果
    } catch (error) {
        logger.error(`AI任务 #${job.id} 处理失败: ${error.message}`);
        // 抛出错误，BullMQ会根据队列的默认配置进行重试
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