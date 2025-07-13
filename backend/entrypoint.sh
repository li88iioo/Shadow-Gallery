#!/bin/sh
#
# 这个脚本会在容器启动时，以 root 权限运行，
# 在 Node.js 应用启动前，确保所有权和目录结构正确。

# 设置 -e 选项，如果任何命令失败，脚本将立即退出
set -e

echo "Entrypoint script started..."

# 确保 /app/data 目录存在
mkdir -p /app/data/thumbnails

# 强制将 /app/data 目录的所有权递归地更改为 node 用户和 node 用户组。
# 这是解决权限问题的核心步骤。
echo "Updating ownership of /app/data and its contents..."
chown -R node:node /app/data

echo "Running database migrations..."
node /app/db/migrate-to-multi-db.js || echo "Migration script failed or not needed, continuing..."

echo "Permissions and directory structure are ready. Starting application..."

# 使用 gosu 切换到 node 用户，并执行 Dockerfile 中的 CMD 命令。
# 这样可以确保 Node.js 进程是以非 root 用户身份运行的。
# exec "$@" 会执行 CMD ["node", "server.js"]
exec gosu node "$@"