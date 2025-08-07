#!/bin/sh
#
# 这个脚本会在容器启动时，以 root 权限运行，
# 在 Node.js 应用启动前，确保所有权和目录结构正确。

# 设置 -e 选项，如果任何命令失败，脚本将立即退出
set -e

echo "🚀 容器启动脚本开始执行..."

# 确保 /app/data 目录存在
mkdir -p /app/data/thumbnails

# 强制将 /app/data 目录的所有权递归地更改为 node 用户和 node 用户组。
# 解决权限问题的核心步骤。
echo "📁 正在配置数据目录权限..."
chown -R node:node /app/data

echo "🗄️ 正在检查数据库迁移..."
node /app/db/migrate-to-multi-db.js || echo "数据库迁移脚本执行失败或无需执行，继续启动..."

# 设置定期数据库维护任务（每周执行一次）
echo "⏰ 正在设置数据库维护计划..."
(crontab -l 2>/dev/null; echo "0 2 * * 0 cd /app && node scripts/maintenance.js >> /app/data/maintenance.log 2>&1") | crontab - || echo "维护计划设置失败，继续启动..."

# 启动 cron 服务
echo "🕒 正在启动定时任务服务..."
crond -f &

echo "✅ 环境配置完成，正在启动应用程序..."

# 使用 gosu 切换到 node 用户，并执行 Dockerfile 中的 CMD 命令。
# 这样可以确保 Node.js 进程是以非 root 用户身份运行的。
# exec "$@" 会执行 CMD ["node", "server.js"]
exec gosu node "$@"