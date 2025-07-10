const Redis = require('ioredis');
const { Queue } = require('bullmq');
const { REDIS_URL, AI_CAPTION_QUEUE_NAME } = require('./index');
const logger = require('./logger');

const redisConnectionOptions = {
    retryStrategy: times => Math.min(times * 1000, 5000),
    maxRetriesPerRequest: 5,
};

const redis = new Redis(REDIS_URL, redisConnectionOptions);

redis.on('connect', () => logger.info('Redis 连接成功!'));
redis.on('error', err => logger.error('Redis错误:', err.code === 'ECONNREFUSED' ? '无法连接Redis' : err));

const aiCaptionQueue = new Queue(AI_CAPTION_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
    },
});

logger.info(`AI 任务队列 (${AI_CAPTION_QUEUE_NAME}) 初始化成功。`);

module.exports = {
    redis,
    aiCaptionQueue,
};