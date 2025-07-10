const express = require('express');
const router = express.Router();
const searchController = require('../controllers/search.controller');
const cache = require('../middleware/cache');

// 为搜索结果应用1小时的缓存
router.get('/', cache(3600), searchController.searchItems);

module.exports = router;