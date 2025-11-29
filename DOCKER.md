# Docker Deployment Guide

This guide explains how to run Broadcaster in Docker with NVIDIA GPU support for hardware-accelerated video encoding.

## Prerequisites

### Required
- Docker Engine 20.10+ or Docker Desktop
- Docker Compose v2.0+

### For GPU Acceleration (Optional but Recommended)
- NVIDIA GPU (GTX 900 series or newer)
- NVIDIA Driver 470.57.02+ (Linux) or latest drivers (Windows)
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

## Quick Start

### 1. Install NVIDIA Container Toolkit (Linux)

```bash
# Add the package repository
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list

# Install nvidia-container-toolkit
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

# Restart Docker
sudo systemctl restart docker

# Verify GPU access
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

### 2. Set Up Directory Structure

```bash
# Create required directories
mkdir -p data config media

# Copy example configuration files
cp config/config.example.txt config/config.txt
cp config/channels.example.json config/channels.json

# Copy environment file
cp .env.example .env
```

### 3. Configure Your Setup

#### Edit `config/channels.json`

Define your channels and media paths:

```json
[
  {
    "type": "shuffle",
    "name": "Movies",
    "slug": "movies",
    "paths": [
      "/media/movies"
    ]
  },
  {
    "type": "shuffle",
    "name": "TV Shows",
    "slug": "tv",
    "paths": [
      "/media/tv"
    ]
  }
]
```

#### Edit `.env`

Set your media directory path:

```bash
# Use relative path
MEDIA_PATH=./media

# Or absolute path
MEDIA_PATH=/mnt/storage/media
```

#### Edit `config/config.txt` (Optional)

Customize encoding settings. Defaults are optimized for NVIDIA GPU:

```bash
VIDEO_CODEC=h264_nvenc     # NVIDIA GPU encoding
VIDEO_CRF=23               # Quality (18-28)
VIDEO_PRESET=p4            # Speed vs quality (p1-p7)
DIMENSIONS=640x480         # Output resolution
```

### 4. Place Your Media

Copy or symlink your video files into the media directory:

```bash
# Copy files
cp -r ~/Videos/Movies ./media/movies
cp -r ~/Videos/TV ./media/tv

# Or create symlinks
ln -s /mnt/storage/movies ./media/movies
ln -s /mnt/storage/tv ./media/tv
```

### 5. Build and Run

```bash
# Build the image
docker-compose build

# Start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Check GPU usage (if using NVIDIA)
nvidia-smi
```

### 6. Access the Web UI

Open your browser to: http://localhost:12121

## Directory Structure

```
.
├── config/              # Configuration files (mounted to /config)
│   ├── config.txt       # Main configuration
│   └── channels.json    # Channel definitions
├── data/                # HLS data (persistent, mounted to /data/hls)
│   └── hls/
│       └── broadcaster/
│           └── channels/
├── media/               # Your video files (mounted to /media)
│   ├── movies/
│   ├── tv/
│   └── ...
└── logs/                # Application logs (mounted to /app/logs)
```

## GPU vs CPU Encoding

### With NVIDIA GPU (Recommended)
- **Codec**: `h264_nvenc`
- **Preset**: `p1` (fast) to `p7` (slow/quality)
- **Performance**: 5-10x faster than CPU
- **Quality**: Excellent at `p4` or higher

### Without GPU (CPU Fallback)
- **Codec**: `libx264` (automatic fallback)
- **Preset**: `ultrafast`, `veryfast`, `fast`, `medium`, etc.
- **Performance**: Slower but works on any system
- **Quality**: Excellent at `medium` or slower

The system automatically detects GPU availability and falls back to CPU encoding if no NVIDIA GPU is found.

## Docker Compose Configuration

### GPU Support

The `docker-compose.yml` includes GPU support:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu, video, compute, utility]
```

### Volume Mounts

Three main volumes:
- `./data:/data/hls` - Persistent HLS streams
- `./config:/config` - Configuration files
- `${MEDIA_PATH}:/media:ro` - Media files (read-only)

### Environment Variables

Override in `docker-compose.yml` or `.env`:

```yaml
environment:
  - VIDEO_CODEC=h264_nvenc
  - VIDEO_PRESET=p4
  - DIMENSIONS=1280x720
```

## Common Commands

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# Restart
docker-compose restart

# View logs
docker-compose logs -f

# Rebuild after code changes
docker-compose build --no-cache

# Shell access
docker-compose exec broadcaster bash

# Check FFmpeg capabilities
docker-compose exec broadcaster ffmpeg -encoders | grep nvenc

# Monitor GPU usage
watch -n 1 nvidia-smi
```

## Troubleshooting

### GPU Not Detected

1. Verify NVIDIA driver:
```bash
nvidia-smi
```

2. Check Docker GPU access:
```bash
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

3. Check container logs:
```bash
docker-compose logs -f | grep "NVIDIA GPU"
```

Should see: "NVIDIA GPU detected - hardware acceleration enabled"

### Permission Issues

If you get permission errors accessing media:

```bash
# Check file permissions
ls -la media/

# Fix permissions
chmod -R 755 media/
```

### FFmpeg Errors

View detailed FFmpeg output:

```bash
docker-compose logs -f | grep FFMpeg
```

### Container Won't Start

Check logs for errors:

```bash
docker-compose logs
```

Common issues:
- Missing config files in `config/` directory
- Invalid paths in `channels.json`
- Port 12121 already in use

## Performance Optimization

### For NVIDIA GPUs

Higher quality, slower encoding:
```bash
VIDEO_PRESET=p7
VIDEO_CRF=18
```

Faster encoding, lower quality:
```bash
VIDEO_PRESET=p1
VIDEO_CRF=28
```

### For CPU Encoding

Faster encoding:
```bash
VIDEO_CODEC=libx264
VIDEO_PRESET=veryfast
```

Better quality:
```bash
VIDEO_CODEC=libx264
VIDEO_PRESET=medium
```

## Updating

```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Cleanup

```bash
# Stop and remove container
docker-compose down

# Remove image
docker rmi broadcaster:latest

# Clean up HLS cache (optional)
rm -rf data/hls/*

# Remove all data (CAUTION: Deletes everything)
rm -rf data/
```

## Advanced Configuration

### Custom FFmpeg Arguments

Edit `Classes/FFMpegSession.js` to modify FFmpeg arguments.

### Multiple GPUs

To use a specific GPU:

```yaml
environment:
  - NVIDIA_VISIBLE_DEVICES=0  # Use first GPU only
```

### Resource Limits

Add resource limits in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '4'
      memory: 8G
    reservations:
      memory: 4G
```

## Support

For issues, please check:
1. Docker logs: `docker-compose logs`
2. Application logs: `./logs/`
3. GitHub Issues: https://github.com/theodoreroddy/Broadcaster/issues
