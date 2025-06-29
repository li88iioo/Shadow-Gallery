# --- Stage 1: Build ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# --- Stage 2: Production ---
FROM node:20-alpine
WORKDIR /app

# 安装 gosu，这是一个更安全的用于切换用户的工具
RUN apk add --no-cache gosu

# 从“构建器”阶段复制依赖和代码
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# [最终修复] 复制并设置入口脚本
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]

# 注意：我们不再需要在这里运行 chown 或者 USER 命令，
# 因为所有权和用户切换都由 entrypoint.sh 在运行时处理。

EXPOSE 13001
# 这个 CMD 会作为参数传递给上面的 ENTRYPOINT
CMD [ "node", "server.js" ]