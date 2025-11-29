# GitHub Actions Docker Setup

This document explains how to set up automated Docker image builds and publishing to Docker Hub.

## Prerequisites

1. A Docker Hub account
2. Access to your GitHub repository settings

## Setup Instructions

### 1. Create Docker Hub Access Token

1. Log in to [Docker Hub](https://hub.docker.com/)
2. Click on your username in the top right → **Account Settings**
3. Go to **Security** → **New Access Token**
4. Name it something like `github-actions-broadcaster`
5. Copy the token (you won't be able to see it again!)

### 2. Add Secrets to GitHub

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add two secrets:

   **Secret 1:**
   - Name: `DOCKERHUB_USERNAME`
   - Value: Your Docker Hub username

   **Secret 2:**
   - Name: `DOCKERHUB_TOKEN`
   - Value: The access token you created in step 1

### 3. Update Docker Image Name (if needed)

If your Docker Hub username is different from `theodoreroddy`, update the workflow:

Edit [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml):

```yaml
env:
  DOCKER_IMAGE: YOUR_USERNAME/broadcaster  # Change this line
```

## How It Works

The GitHub Action automatically:

- **On push to master/main**: Builds and pushes with `latest` tag
- **On version tags** (e.g., `v1.0.0`): Builds and pushes with version tags
- **On pull requests**: Builds (but doesn't push) to verify the build works

### Tagging Strategy

The workflow creates multiple tags automatically:

- `latest` - Always points to the latest master/main build
- `v1.2.3` - Full version tag
- `v1.2` - Minor version tag
- `v1` - Major version tag

### Example: Creating a Release

```bash
# Tag a new version
git tag v1.0.0

# Push the tag
git push origin v1.0.0
```

This will trigger the workflow and push the image with tags:
- `theodoreroddy/broadcaster:latest`
- `theodoreroddy/broadcaster:v1.0.0`
- `theodoreroddy/broadcaster:v1.0`
- `theodoreroddy/broadcaster:v1`

## Workflow Details

The workflow:
1. Checks out the code
2. Sets up Docker Buildx for efficient builds
3. Logs in to Docker Hub (only for pushes, not PRs)
4. Extracts metadata for tags and labels
5. Builds the multi-stage Docker image
6. Pushes to Docker Hub (only for pushes, not PRs)
7. Updates the Docker Hub repository description with DOCKER.md

## Build Cache

The workflow uses GitHub Actions cache to speed up builds:
- Layers are cached between builds
- Significantly reduces build time for subsequent runs
- Cache is automatically managed by GitHub

## Troubleshooting

### Build fails with "permission denied"

Make sure your secrets are set correctly:
```bash
# Check if secrets are set (they won't show values)
Settings → Secrets and variables → Actions
```

### Image not appearing on Docker Hub

1. Check the Actions tab in your GitHub repository
2. Look for errors in the workflow run
3. Verify your Docker Hub credentials are correct

### Want to trigger a manual build?

1. Go to **Actions** tab in GitHub
2. Select **Build and Push Docker Image**
3. Click **Run workflow**
4. Select the branch and click **Run workflow**

## Updating the Unraid Template

After the image is pushed to Docker Hub, update the Unraid template to use Docker Hub:

Edit [`unraid-template.xml`](../unraid-template.xml):

```xml
<Repository>theodoreroddy/broadcaster:latest</Repository>
<Registry>https://hub.docker.com/</Registry>
```

## Using the Image

Once published, users can pull your image:

```bash
# Pull latest
docker pull theodoreroddy/broadcaster:latest

# Pull specific version
docker pull theodoreroddy/broadcaster:v1.0.0

# Use with docker-compose
# The docker-compose.yml is already configured
docker-compose pull
docker-compose up -d
```
