# --- Stage 1: Build ---
# This stage is for installing and compiling NPM dependencies
FROM node:20-alpine AS builder
WORKDIR /app

# Install system dependencies required for compiling sharp
RUN apk add --no-cache vips-dev fftw-dev build-base gcc autoconf automake zlib-dev libtool nasm py3-setuptools

# Copy package files from the 'backend' subdirectory
COPY backend/package*.json ./

# Install dependencies, building native modules from source
RUN npm install --build-from-source --only=production

# --- Stage 2: Production ---
# This is the final running stage
FROM node:20-alpine
WORKDIR /app

# Install runtime dependencies: gosu for user switching and ffmpeg for video processing
RUN apk add --no-cache gosu ffmpeg

# Copy the pre-built node_modules from the 'builder' stage
COPY --from=builder /app/node_modules ./node_modules

# Copy the backend application code
COPY backend/ /app/

# Copy the SVG assets from the 'frontend' subdirectory
RUN mkdir -p /app/assets
COPY frontend/loading-placeholder.svg /app/assets/
COPY frontend/broken-image.svg /app/assets/

# Copy and set up the entrypoint script
COPY backend/entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]

# Expose the application port
EXPOSE 13001

# This command is passed to the ENTRYPOINT
CMD [ "node", "server.js" ]