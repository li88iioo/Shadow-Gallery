/**
 * 相册路由模块
 * 处理相册相关的API请求，包括相册封面获取
 */
const express = require('express');
const router = express.Router();
const albumController = require('../controllers/album.controller');
const { validate, Joi } = require('../middleware/validation');

// 获取所有相册封面路由
// 递归遍历照片目录，获取所有相册的封面图片URL
// 目前接口无用户输入；若后续增加筛选/分页参数，可在此扩展 Joi 校验
router.get('/covers', albumController.getAllAlbumCovers);

// 导出相册路由模块
module.exports = router; 