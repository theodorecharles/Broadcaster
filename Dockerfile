# Use NVIDIA CUDA runtime base image
FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04

# Install system dependencies and ffmpeg with NVIDIA support
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy Webapp package files and install dependencies
COPY Webapp/package*.json ./Webapp/
RUN cd Webapp && npm ci --only=production && npm ci --only=dev

# Copy application code
COPY . .

# Copy Docker-specific config
COPY config.docker.txt ./config.txt

# Build the React frontend
RUN cd Webapp && npm run build

# Create broadcaster user with UID 99 (nobody) and GID 100 (users)
# These are standard Unraid user/group IDs
RUN groupadd -g 100 users || true && \
    useradd -u 99 -g 100 -m -s /bin/bash broadcaster

# Create directories for volumes with correct ownership
RUN mkdir -p /data /media && \
    chown -R 99:100 /data /media /app

# Environment variables (can be overridden by docker-compose or docker run)
ENV CACHE_DIR=/data
ENV CHANNEL_LIST=/data/channels.json
ENV NODE_ENV=production
ENV WEB_UI_PORT=12121

# Switch to broadcaster user
USER broadcaster

# Expose the web UI port
EXPOSE 12121

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:12121/ || exit 1

# Start the application
CMD ["node", "Broadcaster.js"]
