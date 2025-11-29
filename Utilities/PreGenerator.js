const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const Log = require('./Log.js')
const crypto = require('crypto')
const tag = 'PreGenerator'

const { CACHE_DIR,
        VIDEO_CODEC,
        VIDEO_CRF,
        VIDEO_PRESET,
        VIDEO_FILTER,
        AUDIO_CODEC,
        AUDIO_BITRATE,
        HLS_SEGMENT_LENGTH_SECONDS,
        DIMENSIONS } = process.env

class PreGenerator {

    constructor() {
        this.generationQueue = []
        this.currentIndex = 0
        this.totalVideos = 0
        this.isGenerating = false
    }

    /**
     * Generate a unique hash for a video file to use as its HLS directory name
     */
    getVideoHash(filePath) {
        return crypto.createHash('md5').update(filePath).digest('hex')
    }

    /**
     * Check if HLS files already exist for this video and are complete
     */
    isAlreadyGenerated(filePath, channelSlug) {
        const videoHash = this.getVideoHash(filePath)
        const outputDir = path.join(CACHE_DIR, 'channels', channelSlug, 'videos', videoHash)
        const playlistPath = path.join(outputDir, 'index.m3u8')

        // Check if playlist exists
        if (!fs.existsSync(playlistPath)) {
            return false
        }

        // Check if there are actual segment files
        try {
            const files = fs.readdirSync(outputDir)
            const segmentFiles = files.filter(f => f.endsWith('.ts'))

            // If we have a playlist but no segments, it's incomplete
            if (segmentFiles.length === 0) {
                Log(tag, `Incomplete generation detected for ${path.basename(filePath)} - no segments found`)
                return false
            }

            return true
        } catch (e) {
            return false
        }
    }

    /**
     * Add a channel's videos to the generation queue
     */
    queueChannel(channel) {
        channel.queue.forEach(filePath => {
            if (!this.isAlreadyGenerated(filePath, channel.slug)) {
                this.generationQueue.push({
                    filePath,
                    channel
                })
            } else {
                Log(tag, `Skipping ${path.basename(filePath)} (already generated)`, channel)
            }
        })

        this.totalVideos = this.generationQueue.length
        Log(tag, `Queued ${this.generationQueue.length} videos for generation`, channel)
    }

    /**
     * Generate HLS files for a single video
     */
    generateVideo(filePath, channel) {
        return new Promise((resolve, reject) => {
            const videoHash = this.getVideoHash(filePath)
            const outputDir = path.join(CACHE_DIR, 'channels', channel.slug, 'videos', videoHash)
            const outputPath = path.join(outputDir, 'index.m3u8')

            // Create output directory
            fs.mkdirSync(outputDir, { recursive: true })

            // Build video filter with scale that maintains aspect ratio
            const [width, height] = DIMENSIONS.split('x')
            const videoFilter = `${VIDEO_FILTER},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`

            const args = [
                '-i', filePath,
                '-vf', videoFilter,
                '-c:v', VIDEO_CODEC,
                '-preset', VIDEO_PRESET,
                '-crf', VIDEO_CRF,
                '-profile:v', 'main',
                '-level', '3.1',
                '-pix_fmt', 'yuv420p',
                '-c:a', AUDIO_CODEC,
                '-b:a', AUDIO_BITRATE,
                '-ac', '2',
                '-hls_time', HLS_SEGMENT_LENGTH_SECONDS,
                '-hls_list_size', '0',
                '-hls_segment_filename', path.join(outputDir, 'segment_%05d.ts'),
                '-f', 'hls',
                outputPath
            ]

            const ffmpeg = spawn('ffmpeg', args)
            const startTime = Date.now()
            let stderrData = ''

            ffmpeg.stderr.on('data', (data) => {
                stderrData += data.toString()
            })

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    const duration = (Date.now() - startTime) / 1000
                    Log(tag, `Generated ${path.basename(filePath)} in ${duration.toFixed(1)}s [${this.currentIndex}/${this.totalVideos}]`, channel)

                    // Store metadata
                    const metadata = {
                        originalPath: filePath,
                        videoHash: videoHash,
                        generatedAt: new Date().toISOString(),
                        duration: duration
                    }
                    fs.writeFileSync(
                        path.join(outputDir, 'metadata.json'),
                        JSON.stringify(metadata, null, 2)
                    )

                    resolve()
                } else {
                    Log(tag, `Failed to generate ${path.basename(filePath)} (exit code ${code})`, channel)
                    Log(tag, `Error: ${stderrData.slice(-500)}`, channel)
                    reject(new Error(`FFmpeg exited with code ${code}`))
                }
            })

            ffmpeg.on('error', (err) => {
                Log(tag, `FFmpeg error for ${path.basename(filePath)}: ${err.message}`, channel)
                reject(err)
            })
        })
    }

    /**
     * Process the generation queue sequentially
     */
    async startGeneration() {
        if (this.isGenerating) {
            Log(tag, 'Generation already in progress')
            return
        }

        if (this.generationQueue.length === 0) {
            Log(tag, 'All videos already generated!')
            return
        }

        this.isGenerating = true
        this.currentIndex = 0

        Log(tag, `Starting generation of ${this.totalVideos} videos...`)

        for (const item of this.generationQueue) {
            this.currentIndex++
            try {
                await this.generateVideo(item.filePath, item.channel)
            } catch (err) {
                Log(tag, `Skipping failed video: ${item.filePath}`)
            }
        }

        this.isGenerating = false
        Log(tag, `Generation complete! Processed ${this.totalVideos} videos.`)
    }

    /**
     * Get progress information
     */
    getProgress() {
        return {
            current: this.currentIndex,
            total: this.totalVideos,
            isGenerating: this.isGenerating,
            percentComplete: this.totalVideos > 0
                ? Math.round((this.currentIndex / this.totalVideos) * 100)
                : 100
        }
    }
}

module.exports = new PreGenerator()
