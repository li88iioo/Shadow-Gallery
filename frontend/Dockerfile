# --- 阶段 1: 构建 CSS ---
FROM node:20-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# --- 阶段 2: 最终的 Nginx 服务器 ---
FROM nginx:1.25-alpine
WORKDIR /usr/share/nginx/html
COPY --from=builder /app/output.css .
COPY --from=builder /app/index.html .
COPY --from=builder /app/main.js .
COPY --from=builder /app/manifest.json .
COPY --from=builder /app/sw.js .
COPY --from=builder /app/icon.svg .
COPY --from=builder /app/loading-placeholder.svg .
COPY --from=builder /app/broken-image.svg .
COPY default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]