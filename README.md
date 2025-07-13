# 光影画廊 | Shadow Gallery

一个极简、AI驱动的智能图片画廊，支持 PWA、流式加载、多数据库架构与高性能缓存。

## ✨ 主要特性

### 🎭 AI 智能交互
- **AI 画中密语**：AI 扮演照片人物，沉浸式对话体验
- **自定义提示词**：支持多种AI角色设定，从温馨对话到私密互动
- **异步任务处理**：AI内容生成采用队列机制，避免阻塞
- **智能缓存**：AI生成内容持久化缓存，降低成本

### 🖼️ 图片管理
- **流式图片加载**：大相册极速响应，懒加载优化
- **智能缩略图**：自动生成多尺寸缩略图，支持失败重试机制
- **视频处理**：自动视频优化，支持多种格式转码
- **瀑布流布局**：响应式瀑布流，自适应屏幕尺寸

### 🔒 安全防护
- **一键全局模糊**：键盘单击 ***B*** 全局模糊避免尴尬
- **密码保护**：可选密码访问，支持公开/私有模式切换
- **路径校验**：严格的文件路径安全检查
- **速率限制**：API访问频率控制，防止滥用

### 🚀 性能优化
- **多数据库架构**：主数据库、设置数据库、历史记录数据库、索引数据库分离
- **Redis 高性能缓存**：AI内容与搜索结果持久缓存
- **Worker 线程池**：缩略图生成、AI处理、索引重建多线程并发
- **智能索引**：SQLite FTS5全文搜索，支持模糊匹配

### 📱 用户体验
- **PWA 支持**：可安装、离线访问，移动端手势切换
- **响应式设计**：完美适配桌面端和移动端
- **触摸手势**：移动端滑动切换图片
- **键盘导航**：桌面端键盘快捷键操作

### 🛠️ 运维友好
- **Docker 部署**：一键部署，环境隔离
- **健康检查**：容器健康状态监控
- **日志系统**：结构化日志，便于问题排查
- **数据迁移**：自动数据库迁移，平滑升级

## 🚀 快速开始

### 1. 环境准备
```bash
# 必需环境
- Docker & Docker Compose（推荐）
- Node.js 20+（本地开发可选）
- 至少 2GB 可用内存
```

### 2. 克隆项目
```bash

cd Shadow-Gallery
```

### 3. 配置环境变量
```bash
# 复制并编辑环境变量文件
cp backend/.env.example backend/.env
nano backend/.env
```

### 4. 准备照片目录
```bash
# 创建照片目录（推荐挂载到宿主机）
mkdir -p /opt/photos
# 将你的照片放入此目录
```

### 5. 启动服务
```bash
# 构建并启动所有服务
docker-compose up --build -d

# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

### 6. 访问应用
- **前端界面**：[http://localhost:12080](http://localhost:12080)
- **后端API**：[http://localhost:13001](http://localhost:13001)
- **Redis管理**：[http://localhost:6379](http://localhost:6379)（可选）

## 📁 项目架构

```
Shadow-Gallery/
├── backend/                    # 后端服务 (Node.js Express)
│   ├── app.js                 # Express应用配置
│   ├── server.js              # 服务器启动入口
│   ├── config/                # 配置管理
│   │   ├── index.js           # 全局配置
│   │   ├── logger.js          # 日志配置
│   │   └── redis.js           # Redis配置
│   ├── controllers/           # 控制器层
│   │   ├── ai.controller.js   # AI功能控制器
│   │   ├── auth.controller.js # 认证控制器
│   │   ├── browse.controller.js # 浏览控制器
│   │   ├── search.controller.js # 搜索控制器
│   │   ├── settings.controller.js # 设置控制器
│   │   └── thumbnail.controller.js # 缩略图控制器
│   ├── routes/                # 路由层
│   │   ├── ai.routes.js       # AI功能路由
│   │   ├── auth.routes.js     # 认证路由
│   │   ├── browse.routes.js   # 浏览路由
│   │   ├── search.routes.js   # 搜索路由
│   │   ├── settings.routes.js # 设置路由
│   │   └── thumbnail.routes.js # 缩略图路由
│   ├── services/              # 服务层
│   │   ├── file.service.js    # 文件服务
│   │   ├── indexer.service.js # 索引服务
│   │   ├── settings.service.js # 设置服务
│   │   ├── thumbnail.service.js # 缩略图服务
│   │   └── worker.manager.js  # 工作线程管理
│   ├── workers/               # 工作线程
│   │   ├── ai-worker.js       # AI处理工作线程
│   │   ├── history-worker.js  # 历史记录工作线程
│   │   ├── indexing-worker.js # 索引工作线程
│   │   ├── settings-worker.js # 设置工作线程
│   │   ├── thumbnail-worker.js # 缩略图工作线程
│   │   └── video-processor.js # 视频处理工作线程
│   ├── db/                    # 数据库层
│   │   ├── multi-db.js        # 多数据库连接管理
│   │   ├── migrations.js      # 数据库迁移
│   │   └── migrate-to-multi-db.js # 数据迁移脚本
│   ├── middleware/            # 中间件
│   │   ├── auth.js            # 认证中间件
│   │   ├── cache.js           # 缓存中间件
│   │   └── rateLimiter.js     # 速率限制中间件
│   ├── utils/                 # 工具函数
│   │   ├── path.utils.js      # 路径工具
│   │   └── search.utils.js    # 搜索工具
│   ├── Dockerfile             # 后端Docker配置
│   ├── package.json           # Node.js依赖配置
│   └── .env                   # 环境变量配置
├── frontend/                  # 前端应用 (静态文件 + Nginx)
│   ├── index.html             # 主页面
│   ├── js/                    # JavaScript模块
│   │   ├── main.js            # 主逻辑入口
│   │   ├── api.js             # API接口封装
│   │   ├── auth.js            # 认证逻辑
│   │   ├── router.js          # 路由管理
│   │   ├── state.js           # 状态管理
│   │   ├── ui.js              # UI渲染
│   │   ├── modal.js           # 模态框管理
│   │   ├── masonry.js         # 瀑布流布局
│   │   ├── lazyload.js        # 懒加载
│   │   ├── touch.js           # 触摸手势
│   │   ├── settings.js        # 设置管理
│   │   ├── listeners.js       # 事件监听
│   │   └── utils.js           # 工具函数
│   ├── assets/                # 静态资源
│   │   ├── icon.svg           # 应用图标
│   │   ├── broken-image.svg   # 损坏图片占位符
│   │   └── loading-placeholder.svg # 加载占位符
│   ├── manifest.json          # PWA应用清单
│   ├── sw.js                  # Service Worker
│   ├── style.css              # 样式文件
│   ├── tailwind.config.js     # Tailwind配置
│   ├── package.json           # 前端依赖配置
│   ├── Dockerfile             # 前端Docker配置
│   └── default.conf           # Nginx配置
├── photos/                    # 照片目录（推荐挂载宿主机目录）
├── data/                      # 数据目录（自动创建）
├── docker-compose.yml         # Docker Compose编排配置
├── AIPROMPT.md               # AI提示词示例
└── README.md                 # 项目说明文档
```

## 🔧 配置说明

### 环境变量配置 (`backend/.env`)

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `ONEAPI_URL` | - | **必填**。您的 OneAPI 服务地址。 |
| `ONEAPI_KEY` | - | **必填**。您的 OneAPI 密钥。 |
| `ONEAPI_MODEL` | `gpt-4-vision-preview` | **必填**。用于图片识别的视觉模型名称。 |
| `AI_PROMP` | - | **非必填**。自定义 AI 提示词。 |
| `REDIS_URL` | `redis://redis:6379` | Redis 连接 URL。 |
| `PORT` | `13001` | 后端服务监听端口。 |
| `NODE_ENV` | `production` | Node.js 运行环境模式。 |
| `LOG_LEVEL` | `info` | 日志输出级别。 |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | API 速率限制的时间窗口（分钟）。 |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | 在一个时间窗口内，单个 IP 允许的最大请求数。 |

### Docker 服务配置

| 服务 | 容器端口 | 主机端口 | 说明 |
|------|----------|----------|------|
| `frontend` | `80` | `12080` | Web 界面访问端口 |
| `backend` | `13001` | `13001` | 后端 API 服务端口 |
| `ai-worker` | - | - | AI 处理工作线程 |
| `redis` | `6379` | `6379` | Redis 缓存服务端口 |

### 数据库架构

项目采用多数据库架构，提高并发性能：

- **主数据库** (`gallery.db`)：存储图片和视频索引信息
- **设置数据库** (`settings.db`)：存储应用配置设置
- **历史记录数据库** (`history.db`)：存储用户浏览历史
- **索引数据库** (`index.db`)：存储索引处理状态和队列

## 🛠️ 本地开发

### 后端开发
```bash
cd backend
npm install
npm start
```

### 前端开发
```bash
cd frontend
npm install
npm run build
# 或使用开发服务器
npx http-server -p 8000
```

### 数据库管理
```bash
# 查看数据库状态
sqlite3 data/gallery.db ".tables"

# 手动执行数据迁移
node backend/db/migrate-to-multi-db.js
```

## 🎯 功能详解

### AI 画中密语
- 支持多种AI角色设定，从温馨对话到私密互动
- 异步队列处理，避免阻塞用户界面
- Redis缓存机制，相同图片不重复生成
- 自定义提示词支持，可参考 `AIPROMPT.md`

### 智能索引系统
- SQLite FTS5全文搜索，支持中文分词
- 多线程索引重建，提高处理速度
- 文件监控自动更新索引
- 支持相册和视频的智能搜索

### 缩略图系统
- 多线程并发生成，提高处理速度
- 失败重试机制，确保生成成功率
- 多尺寸缩略图支持
- 智能缓存，避免重复生成

### 视频处理
- 自动视频优化和转码
- 支持多种视频格式
- 失败重试机制
- 处理状态监控

## 🐛 常见问题

### 部署问题
- **图片不显示**：检查照片目录挂载与权限
- **AI 无响应**：核查 `.env` 配置与 OneAPI 服务
- **Redis 缓存异常**：确认 Redis 服务与端口
- **端口冲突**：检查 12080/13001/6379 是否被占用

### 性能问题
- **429错误**：调整 `.env` 中的速率限制参数
- **索引重建慢**：检查照片数量，大相册需要更多时间
- **缩略图生成慢**：调整 `NUM_WORKERS` 参数
- **内存占用高**：减少并发工作线程数量

### 功能问题
- **搜索'500'或无结果**：等待索引重建完成
- **AI功能异常**：检查API密钥和模型配置
- **PWA安装失败**：确保HTTPS或localhost环境
- **移动端手势不工作**：检查触摸事件支持

## 📄 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 文件。

