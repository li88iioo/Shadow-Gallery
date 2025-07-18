# 多数据库架构说明

## 概述

本项目已从单一SQLite数据库架构升级为多数据库架构，以提高并发性能、减少锁冲突，并实现更好的数据分离。

## 数据库分布

### 1. 主数据库 (`gallery.db`)
- **用途**: 存储图片和视频的索引信息
- **表结构**:
  - `items`: 媒体文件索引
  - `items_fts`: 全文搜索索引
  - `migrations`: 数据库迁移记录

### 2. 设置数据库 (`settings.db`)
- **用途**: 存储应用配置设置
- **表结构**:
  - `settings`: 键值对配置存储
  - `migrations`: 数据库迁移记录

### 3. 历史记录数据库 (`history.db`)
- **用途**: 存储用户浏览历史
- **表结构**:
  - `view_history`: 用户查看历史记录
  - `migrations`: 数据库迁移记录

### 4. 索引数据库 (`index.db`)
- **用途**: 存储索引处理状态和队列
- **表结构**:
  - `index_status`: 索引处理状态
  - `index_queue`: 索引处理队列
  - `migrations`: 数据库迁移记录

## 架构优势

### 1. 并发性能提升
- 不同功能模块使用独立数据库，避免锁冲突
- 设置更新不再阻塞索引重建
- 历史记录更新不影响搜索功能

### 2. 数据隔离
- 配置数据与业务数据分离
- 历史记录独立存储，便于清理和维护
- 索引状态独立管理

### 3. 扩展性
- 每个数据库可以独立优化
- 便于未来功能扩展
- 支持不同数据库类型的选择

### 4. 维护性
- 数据库文件更小，备份更快
- 问题定位更精确
- 数据迁移更灵活

## 技术实现

### 数据库连接管理
- 使用 `multi-db.js` 统一管理所有数据库连接
- 支持连接池和连接复用
- 自动处理连接错误和重连

### 迁移系统
- 每个数据库独立的迁移记录
- 支持版本控制和回滚
- 自动执行未完成的迁移

### Worker架构
- 每个Worker使用对应的数据库
- 避免跨数据库事务
- 提高并发处理能力

## 数据迁移

### 自动迁移
系统启动时会自动检测并执行数据迁移：
1. 备份原数据库
2. 创建新的数据库文件
3. 迁移现有数据
4. 验证数据完整性

### 手动迁移
如需手动执行迁移，可运行：
```bash
node db/migrate-to-multi-db.js
```

## 配置说明

### 环境变量
```bash
# 数据目录
DATA_DIR=/path/to/data

# 数据库文件会自动创建在以下位置：
# - $DATA_DIR/gallery.db (主数据库)
# - $DATA_DIR/settings.db (设置数据库)
# - $DATA_DIR/history.db (历史记录数据库)
# - $DATA_DIR/index.db (索引数据库)
```

### 数据库配置
每个数据库都配置了以下优化参数：
- `PRAGMA journal_mode = WAL`: 写前日志模式
- `PRAGMA synchronous = NORMAL`: 同步级别
- `PRAGMA cache_size = -8000`: 8MB缓存
- `PRAGMA busy_timeout = 10000`: 10秒超时

## 监控和维护

### 日志监控
- 每个数据库操作都有详细日志
- 包含数据库类型标识
- 便于问题排查

### 性能监控
- 数据库连接状态监控
- 查询性能统计
- 锁等待时间监控

### 备份策略
- 每个数据库独立备份
- 支持增量备份
- 自动备份验证

## 故障处理

### 常见问题
1. **数据库锁定**: 增加超时时间，使用WAL模式
2. **连接失败**: 检查文件权限，重启服务
3. **数据不一致**: 使用迁移脚本重新同步

### 恢复步骤
1. 停止服务
2. 备份当前数据库
3. 运行迁移脚本
4. 重启服务
5. 验证数据完整性

## 未来规划

### 短期优化
- 添加数据库连接池
- 实现读写分离
- 优化查询性能

### 长期规划
- 支持PostgreSQL等关系型数据库
- 实现分布式数据库架构
- 添加数据压缩和加密

## 注意事项

1. **首次启动**: 系统会自动执行数据迁移，可能需要较长时间
2. **备份**: 建议定期备份所有数据库文件
3. **权限**: 确保应用对数据目录有读写权限
4. **磁盘空间**: 多数据库会占用更多磁盘空间
5. **兼容性**: 新架构向后兼容，但建议重新索引数据 