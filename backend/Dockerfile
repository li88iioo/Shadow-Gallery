# --- 阶段 1: 依赖构建器 ---
# 使用一个轻量的 Node.js 镜像作为构建环境，并命名为 'builder'
FROM node:20-alpine AS builder
WORKDIR /app

# 在安装 npm 包之前，先安装构建原生模块 (如 sharp, sqlite3) 所需的系统依赖
# build-base: 提供 C/C++ 编译器
# python3: node-gyp 运行需要
# py3-setuptools: 为 Python 提供被移除的 'distutils' 模块，解决 sqlite3 的构建错误
# vips-dev: sharp 库本身依赖的核心图像处理库
RUN apk add --no-cache build-base python3 py3-setuptools vips-dev

# 从 'backend' 子目录复制 package.json 和 package-lock.json
COPY backend/package*.json ./

# 安装生产环境所需的依赖，并从源码构建任何原生模块
RUN npm install --build-from-source --only=production

# --- 阶段 2: 生产环境 ---
# 这是最终运行应用的阶段
FROM node:20-alpine
WORKDIR /app

# 安装运行时依赖：
# gosu 用于在容器内切换用户，增强安全性
# ffmpeg 用于处理视频（例如生成缩略图）
# vips 是 sharp 运行所必需的，但我们不再需要开发头文件(-dev)
RUN apk add --no-cache gosu ffmpeg vips

# 从 'builder' 阶段复制预先构建好的 node_modules 目录
COPY --from=builder /app/node_modules ./node_modules

# 复制后端应用代码
COPY backend/ /app/

# 从 'frontend/assets' 目录复制所有静态资源文件到镜像的 /app/assets/ 目录
COPY frontend/assets/ /app/assets/

# 复制并设置入口点脚本
COPY backend/entrypoint.sh /usr/local/bin/
# 修复 Windows (CRLF) 换行符问题，并授予执行权限
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# 暴露后端应用运行的端口
EXPOSE 13001

# 此命令将作为默认指令传递给入口点脚本 (entrypoint.sh)
CMD [ "node", "server.js" ]
