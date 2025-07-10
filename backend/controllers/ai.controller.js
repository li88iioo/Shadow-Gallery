const logger = require('../config/logger');
const { aiCaptionQueue, redis } = require('../config/redis');
const { isPathSafe, sanitizePath } = require('../utils/path.utils');
const { ONEAPI_URL, ONEAPI_KEY } = require('../config');

exports.generateCaption = async (req, res) => {
    if (!ONEAPI_URL || !ONEAPI_KEY) {
        return res.status(500).json({ error: 'AI服务未在后端配置' });
    }

    try {
        const { image_path } = req.body;
        if (!image_path) {
            return res.status(400).json({ error: '缺少必要的参数: image_path' });
        }

        let cleanPath = image_path.startsWith('/static/') ? image_path.substring(7) : image_path;
        const sanitizedPath = sanitizePath(cleanPath);
        if (!isPathSafe(sanitizedPath)) {
            return res.status(403).json({ error: '不安全的图片路径' });
        }

        const cacheKey = `ai_description:${sanitizedPath}`;
        const cachedDescription = await redis.get(cacheKey);
        if (cachedDescription) {
            logger.info(`从 Redis 缓存获取图片描述: ${sanitizedPath}`);
            return res.json({ description: cachedDescription, source: 'cache' });
        }

        // 检查队列中是否已有同一图片路径的未完成 job
        const jobTypes = ['active', 'waiting', 'delayed'];
        let existingJob = null;
        for (const type of jobTypes) {
            const jobs = await aiCaptionQueue.getJobs([type]);
            existingJob = jobs.find(j => j.data && j.data.imagePath === sanitizedPath);
            if (existingJob) break;
        }
        if (existingJob) {
            logger.info(`发现已有未完成的AI任务，直接返回 jobId: ${existingJob.id}`);
            return res.status(202).json({
                message: 'AI caption generation already in progress.',
                jobId: existingJob.id,
            });
        }

        const job = await aiCaptionQueue.add('generate-caption', { imagePath: sanitizedPath });

        res.status(202).json({
            message: 'AI caption generation has been queued.',
            jobId: job.id,
        });
    } catch (error) {
        logger.error('派发AI任务时出错:', error.message);
        res.status(500).json({ error: '派发AI任务时发生内部错误' });
    }
};

exports.getJobStatus = async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await aiCaptionQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const state = await job.getState();
        const result = job.returnvalue;
        const failedReason = job.failedReason;

        if (state === 'completed' && result?.success) {
            const imagePath = job.data.imagePath;
            const cacheKey = `ai_description:${imagePath}`;
            await redis.set(cacheKey, result.caption, 'EX', 3600 * 24 * 7);
            logger.info(`任务 #${jobId} 结果已写入缓存。`);
        }

        res.json({ jobId, state, result, failedReason });
    } catch (error) {
        logger.error(`获取AI任务状态时出错: ${error.message}`);
        res.status(500).json({ error: '获取AI任务状态时发生内部错误' });
    }
};