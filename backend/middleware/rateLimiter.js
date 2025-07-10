const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW_MINUTES || 15) * 60 * 1000,
    max: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
    message: {
        error: '请求过于频繁，请稍后再试。'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = apiLimiter;