const express = require('express');
const router = express.Router();

const browseRoutes = require('./browse.routes');
const searchRoutes = require('./search.routes');
const thumbnailRoutes = require('./thumbnail.routes');
const aiRoutes = require('./ai.routes');
const settingsRoutes = require('./settings.routes');
const albumRoutes = require('./album.routes');
const cacheRoutes = require('./cache.routes');


router.use('/browse', browseRoutes);
router.use('/search', searchRoutes);
router.use('/thumbnail', thumbnailRoutes);
router.use('/ai', aiRoutes);
router.use('/settings', settingsRoutes);
router.use('/albums', albumRoutes);
router.use('/cache', cacheRoutes);

module.exports = router;