# Build stage for FFmpeg with NVIDIA support
FROM nvidia/cuda:12.6.3-devel-ubuntu24.04 AS ffmpeg-builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    yasm \
    nasm \
    git \
    wget \
    ca-certificates \
    libass-dev \
    libfreetype6-dev \
    libgnutls28-dev \
    libmp3lame-dev \
    libopus-dev \
    libvorbis-dev \
    libvpx-dev \
    libx264-dev \
    libx265-dev \
    && rm -rf /var/lib/apt/lists/*

# Install nv-codec-headers (required for NVIDIA encoding/decoding)
WORKDIR /tmp
RUN git clone https://git.videolan.org/git/ffmpeg/nv-codec-headers.git && \
    cd nv-codec-headers && \
    make install && \
    cd .. && \
    rm -rf nv-codec-headers

# Build FFmpeg with NVIDIA support
RUN git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg && \
    cd ffmpeg && \
    ./configure \
    --enable-nonfree \
    --enable-cuda-nvcc \
    --enable-libnpp \
    --extra-cflags=-I/usr/local/cuda/include \
    --extra-ldflags=-L/usr/local/cuda/lib64 \
    --enable-gpl \
    --enable-gnutls \
    --enable-libass \
    --enable-libfreetype \
    --enable-libmp3lame \
    --enable-libopus \
    --enable-libvorbis \
    --enable-libvpx \
    --enable-libx264 \
    --enable-libx265 \
    --enable-nvenc \
    --enable-nvdec \
    --enable-cuvid \
    && make -j$(nproc) && \
    make install && \
    ldconfig

# Runtime stage
FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libass9 \
    libfreetype6 \
    libgnutls30t64 \
    libmp3lame0 \
    libopus0 \
    libvorbis0a \
    libvorbisenc2 \
    libvpx9 \
    libx264-164 \
    libx265-209 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Copy FFmpeg from builder
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-builder /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg-builder /usr/local/lib/lib*.so* /usr/local/lib/

# Update library cache
RUN ldconfig

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

# Build the React frontend
RUN cd Webapp && npm run build

# Create directories for volumes
RUN mkdir -p /data /media

# Environment variables (can be overridden by docker-compose or docker run)
ENV CACHE_DIR=/data
ENV CHANNEL_LIST=/data/channels.json
ENV NODE_ENV=production
ENV WEB_UI_PORT=12121

# Expose the web UI port
EXPOSE 12121

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:12121/ || exit 1

# Start the application
CMD ["node", "Broadcaster.js"]
