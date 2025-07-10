const express = require('express');
const router = express.Router();

const browseRoutes = require('./browse.routes');
const searchRoutes = require('./search.routes');
const thumbnailRoutes = require('./thumbnail.routes');
const aiRoutes = require('./ai.routes');

router.use('/browse', browseRoutes);
router.use('/search', searchRoutes);
router.use('/thumbnail', thumbnailRoutes);
router.use('/ai', aiRoutes);

module.exports = router;