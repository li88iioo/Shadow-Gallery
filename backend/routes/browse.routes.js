const express = require('express');
const router = express.Router();
const browseController = require('../controllers/browse.controller');
const cache = require('../middleware/cache');

// A dedicated, non-cached route to update the last viewed time.
router.post('/viewed', browseController.updateViewTime);

// Cache for 10 minutes. The `*` captures the rest of the path.
router.get('/*', cache(600), browseController.browseDirectory);

module.exports = router;