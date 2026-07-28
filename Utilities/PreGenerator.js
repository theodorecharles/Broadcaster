const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('./Log.js')
const Database = require('./Database.js')
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

// Check if NVIDIA GPU is available
let hasNvidiaGPU = false
let gpuCheckDone = false

function checkNvidiaGPU() {
    if (gpuCheckDone) return hasNvidiaGPU

    try {
        // Run nvidia-smi and check if output contains GPU info
        // Note: nvidia-smi may return non-zero exit code (e.g., 14) for warnings
        // like corrupted infoROM, but still work fine for encoding
        const output = execSync('nvidia-smi', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
        if (output.includes('NVIDIA-SMI') && output.includes('Driver Version')) {
            hasNvidiaGPU = true
            Log(tag, 'NVIDIA GPU detected - hardware acceleration enabled')
        } else {
            hasNvidiaGPU = false
            Log(tag, 'No NVIDIA GPU detected - using software encoding')
        }
    } catch (error) {
        // Check if nvidia-smi ran but exited with non-zero (e.g., infoROM warning)
        if (error.stdout && error.stdout.includes('NVIDIA-SMI') && error.stdout.includes('Driver Version')) {
            hasNvidiaGPU = true
            Log(tag, 'NVIDIA GPU detected - hardware acceleration enabled')
        } else {
            hasNvidiaGPU = false
            Log(tag, 'No NVIDIA GPU detected - using software encoding')
        }
    }

    gpuCheckDone = true
    return hasNvidiaGPU
}

class PreGenerator {

    constructor() {
        this.generationQueue = []
        this.channelQueues = [] // Store separate queues per channel
        this.currentIndex = 0
        this.totalVideos = 0
        this.isGenerating = false
    }

    /**
     * Generate a unique hash for a video file path
     * The manifest.json maps these hashes back to original filenames
     */
    getVideoHash(filePath) {
        return crypto.createHash('md5').update(filePath).digest('hex')
    }

    /**
     * Delete a partial/incomplete HLS directory
     */
    deletePartialGeneration(outputDir, fileName) {
        try {
            const files = fs.readdirSync(outputDir)
            for (const file of files) {
                fs.unlinkSync(path.join(outputDir, file))
            }
            fs.rmdirSync(outputDir)
            Log(tag, `Deleted incomplete generation for ${fileName}`)
        } catch (e) {
            Log(tag, `Failed to delete incomplete generation: ${e.message}`)
        }
    }

    /**
     * Reset a database-positive video whose cached HLS output is incomplete
     */
    markGenerationIncomplete(db, video, outputDir, fileName, reason) {
        Log(tag, `${reason} for ${fileName} - marking as not transcoded`)
        try {
            // Use the channel-scoped row returned by getVideoByPath. The same
            // source file can belong to more than one channel.
            db.db.prepare(`
                UPDATE videos
                SET transcoded = 0, segment_count = NULL
                WHERE id = ?
            `).run(video.id)
        } catch (e) {
            Log(tag, `Failed to update database: ${e.message}`)
        }

        if (fs.existsSync(outputDir)) {
            this.deletePartialGeneration(outputDir, fileName)
        }

        return false
    }

    /**
     * Check if HLS files already exist for this video and are complete
     * OPTIMIZED: Check database first before filesystem
     */
    isAlreadyGenerated(filePath, channelSlug) {
        const videoHash = this.getVideoHash(filePath)
        const fileName = path.basename(filePath)

        // Fast check: query database first
        const db = Database()
        const video = db.getVideoByPath(channelSlug, filePath)

        // If not in database or not marked as transcoded, it's not generated
        if (!video || !video.transcoded) {
            return false
        }

        // Database says it's transcoded, but verify files actually exist
        const outputDir = path.join(CACHE_DIR, 'channels', channelSlug, 'videos', videoHash)
        const playlistPath = path.join(outputDir, 'index.m3u8')

        // Check if playlist exists
        if (!fs.existsSync(playlistPath)) {
            return this.markGenerationIncomplete(
                db,
                video,
                outputDir,
                fileName,
                'Database out of sync'
            )
        }

        // Check if there are actual segment files
        try {
            const files = fs.readdirSync(outputDir)
            const segmentFiles = files.filter(f => f.endsWith('.ts'))

            // If we have a playlist but no segments, it's incomplete
            if (segmentFiles.length === 0) {
                return this.markGenerationIncomplete(
                    db,
                    video,
                    outputDir,
                    fileName,
                    'Incomplete generation detected - no segments found'
                )
            }

            // Check if playlist is complete (has #EXT-X-ENDLIST)
            const playlistContent = fs.readFileSync(playlistPath, 'utf8')
            if (!playlistContent.includes('#EXT-X-ENDLIST')) {
                return this.markGenerationIncomplete(
                    db,
                    video,
                    outputDir,
                    fileName,
                    'Incomplete generation detected - playlist not finalized'
                )
            }

            // Verify all segments referenced in playlist exist
            const segmentRefs = playlistContent.match(/segment_\d+\.ts/g) || []
            for (const segmentRef of segmentRefs) {
                if (!fs.existsSync(path.join(outputDir, segmentRef))) {
                    return this.markGenerationIncomplete(
                        db,
                        video,
                        outputDir,
                        fileName,
                        `Incomplete generation detected - missing segment ${segmentRef}`
                    )
                }
            }

            // Verify metadata.json exists - it's only written after successful transcoding
            const metadataPath = path.join(outputDir, 'metadata.json')
            if (!fs.existsSync(metadataPath)) {
                return this.markGenerationIncomplete(
                    db,
                    video,
                    outputDir,
                    fileName,
                    'Incomplete generation detected - missing metadata.json'
                )
            }

            return true
        } catch (e) {
            return this.markGenerationIncomplete(
                db,
                video,
                outputDir,
                fileName,
                `Failed to verify cached generation - ${e.message}`
            )
        }
    }

    /**
     * Get the manifest path for a channel
     */
    getManifestPath(channelSlug) {
        return path.join(CACHE_DIR, 'channels', channelSlug, 'manifest.json')
    }

    /**
     * Update the channel manifest with video metadata
     * Also cleans up removed videos from manifest and deletes their HLS folders
     */
    updateChannelManifest(channel) {
        const manifestPath = this.getManifestPath(channel.slug)
        let manifest = {}

        // Load existing manifest
        try {
            if (fs.existsSync(manifestPath)) {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            }
        } catch (err) {
            Log(tag, `Error loading manifest: ${err.message}`, channel)
        }

        // Build set of current video hashes from database
        const db = Database()
        const allVideos = db.getChannelVideos(channel.slug, false)
        const currentHashes = new Set()
        allVideos.forEach(video => {
            currentHashes.add(this.getVideoHash(video.file_path))
        })

        // Find and remove videos that are no longer in the queue
        let removed = 0
        const videosDir = path.join(CACHE_DIR, 'channels', channel.slug, 'videos')
        for (const hash of Object.keys(manifest)) {
            if (!currentHashes.has(hash)) {
                const videoDir = path.join(videosDir, hash)
                const filename = manifest[hash].filename || hash

                // Delete the HLS folder
                if (fs.existsSync(videoDir)) {
                    try {
                        fs.rmSync(videoDir, { recursive: true })
                        Log(tag, `Deleted HLS folder for removed video: ${filename}`, channel)
                    } catch (err) {
                        Log(tag, `Failed to delete HLS folder for ${filename}: ${err.message}`, channel)
                    }
                }

                // Remove from manifest
                delete manifest[hash]
                removed++
            }
        }

        // Add new videos to manifest
        let added = 0
        allVideos.forEach(video => {
            const videoHash = this.getVideoHash(video.file_path)
            if (!manifest[videoHash]) {
                manifest[videoHash] = {
                    originalPath: video.file_path,
                    filename: path.basename(video.file_path, path.extname(video.file_path)),
                    addedAt: Date.now()
                }
                added++
            }
        })

        // Clean up orphaned HLS folders (exist on disk but not in manifest or queue)
        let orphansDeleted = 0
        if (fs.existsSync(videosDir)) {
            try {
                const existingFolders = fs.readdirSync(videosDir)
                for (const folder of existingFolders) {
                    if (!currentHashes.has(folder)) {
                        const orphanDir = path.join(videosDir, folder)
                        try {
                            fs.rmSync(orphanDir, { recursive: true })
                            Log(tag, `Deleted orphaned HLS folder: ${folder}`, channel)
                            orphansDeleted++
                        } catch (err) {
                            Log(tag, `Failed to delete orphaned folder ${folder}: ${err.message}`, channel)
                        }
                    }
                }
            } catch (err) {
                Log(tag, `Error scanning videos directory: ${err.message}`, channel)
            }
        }

        // Save manifest
        const dir = path.dirname(manifestPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

        if (added > 0 || removed > 0 || orphansDeleted > 0) {
            Log(tag, `Manifest updated: +${added} added, -${removed} removed, ${orphansDeleted} orphans deleted`, channel)
        }

        return manifest
    }

    /**
     * Add a channel's videos to the generation queue
     * OPTIMIZED: Single bulk database query instead of N individual queries
     * Manifest updates are deferred to avoid blocking startup
     */
    queueChannel(channel) {
        // Defer manifest update to background - don't block startup
        this.pendingManifestUpdates = this.pendingManifestUpdates || []
        this.pendingManifestUpdates.push(channel)

        // Get all videos from database - both transcoded and not
        const db = Database()
        const allVideos = db.getChannelVideos(channel.slug, false) // all videos
        const transcodedVideos = db.getChannelVideos(channel.slug, true) // transcoded only
        const transcodedPaths = new Set(transcodedVideos.map(v => v.file_path))

        const channelQueue = []
        let skippedCount = 0

        allVideos.forEach(video => {
            // Database-positive rows still need their cached files verified.
            if (
                transcodedPaths.has(video.file_path) &&
                this.isAlreadyGenerated(video.file_path, channel.slug)
            ) {
                skippedCount++
            } else {
                // Not transcoded or cache is incomplete, needs transcoding
                channelQueue.push({
                    videoId: video.id,
                    filePath: video.file_path,
                    channel
                })
            }
        })

        if (channelQueue.length > 0) {
            this.channelQueues.push(channelQueue)
        }

        const skippedMsg = skippedCount > 0 ? ` (${skippedCount} already generated)` : ''
        Log(tag, `Queued ${channelQueue.length} videos for generation${skippedMsg}`, channel)
    }

    /**
     * Build interleaved queue from all channels (round-robin)
     */
    buildInterleavedQueue() {
        this.generationQueue = []
        let hasMore = true

        while (hasMore) {
            hasMore = false
            for (const channelQueue of this.channelQueues) {
                if (channelQueue.length > 0) {
                    this.generationQueue.push(channelQueue.shift())
                    hasMore = true
                }
            }
        }

        this.totalVideos = this.generationQueue.length
    }

    /**
     * Get video file info using ffprobe
     */
    getVideoInfo(filePath) {
        try {
            // Get video stream info
            const videoResult = execSync(
                `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt,width,height,bit_depth -of csv=p=0 "${filePath}"`,
                { encoding: 'utf8', timeout: 10000 }
            )
            const videoParts = videoResult.trim().split(',')

            // Get audio stream info
            let audioCodec = 'unknown'
            try {
                const audioResult = execSync(
                    `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "${filePath}"`,
                    { encoding: 'utf8', timeout: 10000 }
                )
                audioCodec = audioResult.trim() || 'unknown'
            } catch (e) {
                audioCodec = 'none'
            }

            return {
                codec: videoParts[0] || 'unknown',
                width: videoParts[1] || 'unknown',
                height: videoParts[2] || 'unknown',
                pixFmt: videoParts[3] || 'unknown',
                bitDepth: videoParts[4] || '8',
                audioCodec: audioCodec
            }
        } catch (e) {
            return { codec: 'error', width: '?', height: '?', pixFmt: '?', bitDepth: '?', audioCodec: '?' }
        }
    }

    /**
     * Generate HLS files for a single video
     */
    generateVideo(videoId, filePath, channel) {
        return new Promise((resolve, reject) => {
            const videoHash = this.getVideoHash(filePath)
            const outputDir = path.join(CACHE_DIR, 'channels', channel.slug, 'videos', videoHash)
            const outputPath = path.join(outputDir, 'index.m3u8')

            // Create output directory
            fs.mkdirSync(outputDir, { recursive: true })

            // Log video info before transcoding
            const videoInfo = this.getVideoInfo(filePath)
            Log(tag, `Processing ${path.basename(filePath)} [${videoInfo.codec} ${videoInfo.width}x${videoInfo.height} ${videoInfo.pixFmt} ${videoInfo.bitDepth}bit | audio: ${videoInfo.audioCodec}]`, channel)

            const hasGPU = checkNvidiaGPU()
            const [width] = DIMENSIONS.split('x')

            // Check if this file can use GPU - 10-bit and some codecs don't work well with CUDA filters
            const is10Bit = videoInfo.pixFmt && (videoInfo.pixFmt.includes('10') || videoInfo.bitDepth === '10')
            const gpuCompatibleCodecs = ['h264', 'hevc', 'vp9', 'av1', 'mpeg2video', 'mpeg4']
            const canUseGPU = hasGPU &&
                              VIDEO_CODEC === 'h264_nvenc' &&
                              !is10Bit &&
                              gpuCompatibleCodecs.includes(videoInfo.codec)

            // Determine codec, filter, and settings
            let videoCodec, videoPreset, inputArgs, qualityArgs, fullVideoFilter

            if (canUseGPU) {
                // Full GPU path: NVDEC decode + CUDA filters + NVENC encode
                inputArgs = ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', filePath]
                videoCodec = 'h264_nvenc'
                videoPreset = VIDEO_PRESET || 'p4'
                qualityArgs = ['-cq', VIDEO_CRF || '23', '-rc', 'vbr', '-b:v', '0']
                // Scale to width, maintain aspect ratio (height = -2 ensures divisible by 2)
                const deinterlace = VIDEO_FILTER === 'yadif' ? 'yadif_cuda,' : ''
                fullVideoFilter = `${deinterlace}scale_cuda=${width}:-2,hwdownload,format=nv12`
            } else if (hasGPU && VIDEO_CODEC === 'h264_nvenc') {
                // Hybrid path: CPU decode + CPU filters + NVENC encode (for incompatible files)
                inputArgs = ['-i', filePath]
                videoCodec = 'h264_nvenc'
                videoPreset = VIDEO_PRESET || 'p4'
                qualityArgs = ['-cq', VIDEO_CRF || '23', '-rc', 'vbr', '-b:v', '0']
                const deinterlace = VIDEO_FILTER === 'yadif' ? 'yadif,' : ''
                fullVideoFilter = `${deinterlace}scale=${width}:-2`
                Log(tag, `Using CPU decode for ${path.basename(filePath)} (${is10Bit ? '10-bit' : 'incompatible codec'})`, channel)
            } else {
                // Full CPU path
                inputArgs = ['-i', filePath]
                videoCodec = 'libx264'
                videoPreset = VIDEO_PRESET || 'veryfast'
                qualityArgs = ['-crf', VIDEO_CRF || '23']
                const deinterlace = VIDEO_FILTER === 'yadif' ? 'yadif,' : ''
                fullVideoFilter = `${deinterlace}scale=${width}:-2`
            }

            // Determine audio handling - copy if already AAC, otherwise re-encode
            const canCopyAudio = videoInfo.audioCodec === 'aac'
            const audioArgs = canCopyAudio
                ? ['-c:a', 'copy']
                : ['-c:a', AUDIO_CODEC, '-b:a', AUDIO_BITRATE, '-ac', '2']

            const args = [
                ...inputArgs,
                '-vf', fullVideoFilter,
                '-c:v', videoCodec,
                '-preset', videoPreset,
                ...qualityArgs,
                '-profile:v', 'main',
                '-level', '3.1',
                '-pix_fmt', 'yuv420p',
                ...audioArgs,
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

                    // Get video duration and segment count from the generated playlist
                    let videoDuration = 0
                    let segmentCount = 0
                    try {
                        const playlistContent = fs.readFileSync(outputPath, 'utf8')
                        playlistContent.split('\n').forEach(line => {
                            if (line.startsWith('#EXTINF:')) {
                                const match = line.match(/#EXTINF:([\d.]+)/)
                                if (match) videoDuration += parseFloat(match[1])
                                segmentCount++
                            }
                        })
                    } catch (e) {
                        Log(tag, `Could not calculate video duration: ${e.message}`, channel)
                    }

                    // Store metadata
                    const metadata = {
                        originalPath: filePath,
                        videoHash: videoHash,
                        generatedAt: new Date().toISOString(),
                        duration: duration,
                        segmentCount: segmentCount
                    }
                    fs.writeFileSync(
                        path.join(outputDir, 'metadata.json'),
                        JSON.stringify(metadata, null, 2)
                    )

                    // Update database with transcoding status
                    try {
                        const db = Database()
                        db.markVideoTranscoded(
                            videoId,
                            videoDuration,
                            segmentCount,
                            videoInfo.codec,
                            videoInfo.audioCodec,
                            parseInt(videoInfo.width) || null,
                            parseInt(videoInfo.height) || null
                        )
                    } catch (dbErr) {
                        Log(tag, `Database update error: ${dbErr.message}`, channel)
                    }

                    // Invalidate playlist cache so newly transcoded video appears
                    if (channel.playlistManager) {
                        channel.playlistManager.invalidateCache()
                    }

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
     * Process deferred manifest updates (runs in background during generation)
     */
    async processPendingManifestUpdates() {
        if (!this.pendingManifestUpdates || this.pendingManifestUpdates.length === 0) {
            return
        }

        Log(tag, `Updating manifests for ${this.pendingManifestUpdates.length} channels...`)

        for (const channel of this.pendingManifestUpdates) {
            // Yield to event loop between channels
            await new Promise(resolve => setImmediate(resolve))
            this.updateChannelManifest(channel)
        }

        this.pendingManifestUpdates = []
        Log(tag, 'Manifest updates complete')
    }

    /**
     * Process the generation queue sequentially
     */
    async startGeneration() {
        if (this.isGenerating) {
            Log(tag, 'Generation already in progress')
            return
        }

        // Process deferred manifest updates first (in background)
        await this.processPendingManifestUpdates()

        // Build interleaved queue before starting
        this.buildInterleavedQueue()

        if (this.generationQueue.length === 0) {
            Log(tag, 'All videos already generated!')
            return
        }

        this.isGenerating = true
        this.currentIndex = 0

        Log(tag, `Starting generation of ${this.totalVideos} videos (round-robin across channels)...`)

        for (const item of this.generationQueue) {
            this.currentIndex++
            try {
                await this.generateVideo(item.videoId, item.filePath, item.channel)
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
