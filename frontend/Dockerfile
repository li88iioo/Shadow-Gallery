# --- 阶段 1: 构建 CSS ---
# 使用一个轻量的 Node.js 镜像作为构建环境
FROM node:20-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json 并安装依赖
# 这样可以利用 Docker 的层缓存，只有在依赖变化时才重新安装
COPY package*.json ./
RUN npm install

# 复制所有项目文件
COPY . .

# 运行构建脚本 (生成 output.css)
RUN npm run build

# --- 阶段 2: 最终的 Nginx 服务器 ---
# 使用一个轻量的 Nginx 镜像
FROM nginx:1.25-alpine

# 设置 Nginx 的网站根目录
WORKDIR /usr/share/nginx/html

# --- 从构建阶段复制必要的文件 ---

# 复制根目录下的核心文件
COPY --from=builder /app/output.css .
COPY --from=builder /app/index.html .
COPY --from=builder /app/manifest.json .
COPY --from=builder /app/sw.js .

# 复制整个 js 目录及其中的所有文件
COPY --from=builder /app/js/ ./js/

# 复制整个 assets 目录及其中的所有文件
COPY --from=builder /app/assets/ ./assets/

# --- 复制 Nginx 配置文件 ---
# 这个文件直接从构建上下文复制，而不是从 builder 阶段
COPY default.conf /etc/nginx/conf.d/default.conf

# 暴露 80 端口
EXPOSE 80

# 启动 Nginx
CMD ["nginx", "-g", "daemon off;"]
