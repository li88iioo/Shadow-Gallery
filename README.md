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

## 📁 目录结构

```
backend/   # Node.js/Express 后端，AI与缓存
frontend/  # 静态前端+Nginx，PWA 支持
photos/    # 挂载的照片目录
docker-compose.yml
```

## 🛠️ 本地开发

- 后端：`cd backend && npm install && npm start`
- 前端：`cd frontend && python -m http.server 8000` 或 `npx http-server -p 8000`

## 🐛 常见问题

- **图片不显示**：检查照片目录挂载与权限
- **AI 无响应**：核查 `.env` 配置与 OneAPI 服务
- **Redis 缓存异常**：确认 Redis 服务与端口
- **端口冲突**：检查 12080/13001/6379 是否被占用

