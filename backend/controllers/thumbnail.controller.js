const path = require('path');
const logger = require('../config/logger');
const { PHOTOS_DIR, THUMBS_DIR, THUMB_PLACEHOLDER_PATH, BROKEN_IMAGE_PATH } = require('../config');
const { ensureThumbnailExists } = require('../services/thumbnail.service');
const { isPathSafe } = require('../utils/path.utils');

exports.getThumbnail = async (req, res) => {
    try {
        const relativePath = req.query.path;
        if (!relativePath || !isPathSafe(relativePath)) {
            return res.status(400).send('Invalid or unsafe path');
        }

        const sourceAbsPath = path.join(PHOTOS_DIR, relativePath);
        const { status, path: thumbUrl } = await ensureThumbnailExists(sourceAbsPath, relativePath);

        switch (status) {
            case 'exists':
                res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
                res.sendFile(path.join(THUMBS_DIR, path.basename(thumbUrl)));
                break;
            case 'processing':
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.status(202).sendFile(THUMB_PLACEHOLDER_PATH);
                break;
            case 'failed':
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.status(500).sendFile(BROKEN_IMAGE_PATH);
                break;
        }
    } catch (error) {
        logger.error(`Error in /api/thumbnail: ${error.message}`);
        res.status(500).sendFile(BROKEN_IMAGE_PATH);
    }
};