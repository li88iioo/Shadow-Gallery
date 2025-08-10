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

// 游标式分页相册封面
// Query: limit (1..500, default 100), cursor (起始 id, 默认 0)
router.get(
  '/covers/cursor',
  validate({
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(500).default(100),
      cursor: Joi.number().integer().min(0).default(0)
    })
  }),
  albumController.getAlbumCoversCursor
);

// 导出相册路由模块
module.exports = router; 