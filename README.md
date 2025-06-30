# 光影画廊 | Shadow Gallery

一个极简、AI驱动的图片画廊，支持 PWA、流式加载与高性能缓存。

## ✨ 主要特性

- **AI 画中密语**：AI 扮演照片人物，沉浸式对话体验 (支持自定义提示词)
- **一键全局模糊**：键盘单击 ***B*** 全局模糊避免尴尬
- **流式图片加载**：大相册极速响应，懒加载优化
- **Redis 高性能缓存**：AI内容与搜索结果持久缓存，降低成本
- **PWA 支持**：可安装、离线访问，移动端手势切换
- **安全防护**：路径校验、速率限制、非 root 运行
- **一键部署**：Docker Compose 集成，环境隔离，易维护

## 🚀 快速开始

1. **环境准备**  
   - Docker & Docker Compose（推荐）
   - Node.js 20+（本地开发可选）

2. **克隆项目并配置环境变量**
   ```bash
   git clone <repository-url>
   cd Shadow-Gallery
   nano backend/.env    # 按需填写AI,提示词和Redis配置
   ```

3. **准备照片目录**  
   创建本地照片文件夹，并在 `docker-compose.yml` 的 `volumes` 中映射到 `/app/photos`。

4. **启动服务**
   ```bash
   docker-compose up --build -d
   ```
   访问 [http://localhost:12080](http://localhost:12080)

## 📁 项目结构

```
Shadow-Gallery/
├── backend/                 # 后端服务 (Node.js Express)
│   ├── server.js           # 主服务文件
│   ├── Dockerfile          # 后端Docker配置
│   ├── .dockerignore       # Docker构建忽略文件
│   ├── package.json        # Node.js 依赖配置
│   └── .env                # 环境变量 (本地配置)
├── frontend/               # 前端应用 (静态文件 + Nginx)
│   ├── index.html          # 主页面
│   ├── main.js             # 主逻辑文件
│   ├── manifest.json       # PWA 应用清单
│   ├── sw.js               # PWA Service Worker
│   ├── icon.svg            # PWA/Favicon 动态图标
│   ├── Dockerfile          # 前端Docker配置
│   ├── .dockerignore       # Docker构建忽略文件
│   └── default.conf        # Nginx 配置
├── photos/                 # (可选) 示例照片目录，推荐挂载宿主机目录
├── docker-compose.yml      # Docker Compose 容器编排配置
└── README.md              # 项目说明文档
```

## 🔧 配置说明

### 环境变量 (`backend/.env`)

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

### Docker 端口映射

| 服务 | 容器端口 | 主机端口 | 说明 |
|------|----------|----------|------|
| `frontend` | `80` | `12080` | Web 界面访问端口。 |
| `backend` | `13001` | `13001` | 后端 API 服务端口。 |
| `redis` | `6379` | `6379` | Redis 缓存服务端口 (方便调试)。 |


## 🛠️ 本地开发

- 后端：`cd backend && npm install && npm start`
- 前端：`cd frontend && python -m http.server 8000` 或 `npx http-server -p 8000`

## 🐛 常见问题

- **图片不显示**：检查照片目录挂载与权限
- **AI 无响应**：核查 `.env` 配置与 OneAPI 服务
- **Redis 缓存异常**：确认 Redis 服务与端口
- **端口冲突**：检查 12080/13001/6379 是否被占用
- **429错误**：更改.env 中的速率限制

