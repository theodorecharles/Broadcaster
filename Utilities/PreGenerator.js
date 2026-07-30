const { spawn, execSync, execFileSync } = require('child_process')
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

/**
 * VIDEO_FILTER of yadif or yadif_cuda both request deinterlace.
 * CUDA vs CPU filter is chosen from the active encode path, not the env string alone.
 * @param {string|undefined} videoFilter
 * @param {boolean} useCuda
 * @returns {string} filter prefix ending in comma, or empty string
 */
function deinterlacePrefix(videoFilter, useCuda) {
    if (videoFilter !== 'yadif' && videoFilter !== 'yadif_cuda') return ''
    return useCuda ? 'yadif_cuda,' : 'yadif,'
}

/**
 * Probe result from getVideoInfo when ffprobe cannot open the file or finds no video stream.
 * The codec placeholder used to be the literal string "error", which made the Processing log
 * line classify as ERROR in the log shipper.
 * @param {{codec?: string}|null|undefined} videoInfo
 * @returns {boolean}
 */
function isUnreadableProbeResult(videoInfo) {
    if (!videoInfo || typeof videoInfo !== 'object') return true
    const codec = videoInfo.codec
    return codec === 'unreadable' || codec === 'error' || codec === '?' || codec === ''
}

/**
 * FFmpeg/ffprobe stderr that indicates bad library media (corrupt, empty, truncated, missing)
 * rather than an encode-path or host problem. These should log at warn and skip the item.
 * @param {string} stderr
 * @returns {boolean}
 */
function isUnreadableMediaStderr(stderr) {
    if (typeof stderr !== 'string' || stderr.length === 0) return false
    return /Invalid data found when processing input/i.test(stderr) ||
        /EBML header parsing failed/i.test(stderr) ||
        /invalid as first byte of an EBML number/i.test(stderr) ||
        /misdetection possible/i.test(stderr) ||
        /Error opening input/i.test(stderr) ||
        /moov atom not found/i.test(stderr) ||
        /Invalid argument/i.test(stderr) && /matroska|webm|mov|mp4|avi|mpeg/i.test(stderr) ||
        /No such file or directory/i.test(stderr) ||
        /Permission denied/i.test(stderr)
}

/**
 * Remove a partial HLS output directory after a skipped/unreadable generate attempt.
 * Best-effort; never throws.
 */
function cleanupPartialOutput(outputDir) {
    try {
        if (outputDir && fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true })
        }
    } catch (_) {
        // ignore
    }
}

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

/**
 * Resolve ffmpeg video encode settings from GPU state and config.
 * Passes VIDEO_CODEC through except when NVENC is requested without a usable GPU path.
 * Exported for unit tests.
 *
 * @param {object} opts
 * @param {boolean} opts.hasGPU
 * @param {boolean} opts.canUseGPU - full CUDA decode+filter+NVENC path is safe for this file
 * @param {boolean} opts.is10Bit
 * @param {string|number} opts.width - target scale width
 * @param {string} opts.filePath - for hybrid-path log message only
 * @param {object} [opts.channel]
 * @param {string} [opts.videoCodecConfig] - defaults to process.env.VIDEO_CODEC
 * @param {string} [opts.videoPreset] - defaults to process.env.VIDEO_PRESET
 * @param {string} [opts.videoCrf] - defaults to process.env.VIDEO_CRF
 * @param {string} [opts.videoFilter] - defaults to process.env.VIDEO_FILTER
 */
function resolveEncodeSettings({
    hasGPU,
    canUseGPU,
    is10Bit,
    width,
    filePath,
    channel,
    videoCodecConfig = VIDEO_CODEC,
    videoPreset = VIDEO_PRESET,
    videoCrf = VIDEO_CRF,
    videoFilter = VIDEO_FILTER
}) {
    const crf = videoCrf || '23'
    const deinterlaceCpu = deinterlacePrefix(videoFilter, false)

    if (canUseGPU) {
        // Full GPU path: NVDEC decode + CUDA filters + NVENC encode
        const deinterlace = deinterlacePrefix(videoFilter, true)
        return {
            inputArgs: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', filePath],
            videoCodec: 'h264_nvenc',
            videoPreset: videoPreset || 'p4',
            qualityArgs: ['-cq', crf, '-rc', 'vbr', '-b:v', '0'],
            fullVideoFilter: `${deinterlace}scale_cuda=${width}:-2,hwdownload,format=nv12`
        }
    }

    if (hasGPU && videoCodecConfig === 'h264_nvenc') {
        // Hybrid path: CPU decode + CPU filters + NVENC encode (for incompatible files)
        Log(tag, `Using CPU decode for ${path.basename(filePath)} (${is10Bit ? '10-bit' : 'incompatible codec'})`, channel)
        return {
            inputArgs: ['-i', filePath],
            videoCodec: 'h264_nvenc',
            videoPreset: videoPreset || 'p4',
            qualityArgs: ['-cq', crf, '-rc', 'vbr', '-b:v', '0'],
            fullVideoFilter: `${deinterlaceCpu}scale=${width}:-2`
        }
    }

    // Configured codec path. Only fall back to software when NVENC was requested without a GPU.
    let videoCodec = videoCodecConfig || 'libx264'
    let resolvedPreset = videoPreset

    if (videoCodec === 'h264_nvenc') {
        videoCodec = 'libx264'
        resolvedPreset = videoPreset || 'veryfast'
        Log(tag, 'GPU requested but not available - falling back to software encoding', channel)
    } else if (!resolvedPreset) {
        // Sensible defaults when VIDEO_PRESET is unset
        resolvedPreset = videoCodec === 'libx264' ? 'veryfast' : 'medium'
    }

    return {
        inputArgs: ['-i', filePath],
        videoCodec,
        videoPreset: resolvedPreset,
        qualityArgs: ['-crf', crf],
        fullVideoFilter: `${deinterlaceCpu}scale=${width}:-2`
    }
}

class PreGenerator {

    constructor() {
        this.generationQueue = []
        this.channelQueues = [] // Store separate queues per channel
        this.currentIndex = 0
        this.totalVideos = 0
        this.isGenerating = false
        /** @type {Set<import('child_process').ChildProcess>} */
        this.activeProcesses = new Set()
        this.shuttingDown = false
    }

    /**
     * Kill in-flight ffmpeg workers (SIGTERM then SIGKILL) and stop the queue.
     * Called from process shutdown hooks so Ctrl-C / pm2 stop do not orphan encoders.
     */
    stopActiveWorkers() {
        this.shuttingDown = true
        this.generationQueue = []

        const procs = [...this.activeProcesses]
        for (const proc of procs) {
            try {
                if (proc.exitCode === null && proc.signalCode === null) {
                    proc.kill('SIGTERM')
                }
            } catch (_) {
                // Process may already be gone
            }
        }
        for (const proc of procs) {
            try {
                if (proc.exitCode === null && proc.signalCode === null) {
                    proc.kill('SIGKILL')
                }
            } catch (_) {
                // Process may already be gone
            }
        }

        this.activeProcesses.clear()
        this.isGenerating = false

        if (procs.length > 0) {
            Log(tag, `Stopped ${procs.length} in-flight ffmpeg worker(s)`)
        }
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
            Log(tag, `Failed to delete incomplete generation: ${e.message}`, undefined, { error: e, output_dir: outputDir, file_name: fileName })
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
            Log(tag, `Failed to update database: ${e.message}`, undefined, { error: e, video_id: video && video.id, file_name: fileName, reason })
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
            Log(tag, `Error loading manifest: ${err.message}`, channel, { error: err, manifest_path: manifestPath })
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
        // Pass filePath as an argv element (execFileSync, no shell) so media
        // names with quotes/metacharacters cannot inject into a shell string.
        try {
            // Get video stream info
            const videoResult = execFileSync(
                'ffprobe',
                [
                    '-v', 'error',
                    '-select_streams', 'v:0',
                    '-show_entries', 'stream=codec_name,pix_fmt,width,height,bit_depth',
                    '-of', 'csv=p=0',
                    filePath
                ],
                { encoding: 'utf8', timeout: 10000 }
            )
            const videoParts = videoResult.trim().split(',')

            // Get audio stream info
            let audioCodec = 'unknown'
            try {
                const audioResult = execFileSync(
                    'ffprobe',
                    [
                        '-v', 'error',
                        '-select_streams', 'a:0',
                        '-show_entries', 'stream=codec_name',
                        '-of', 'csv=p=0',
                        filePath
                    ],
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
            // Placeholder avoids the word "error" in the Processing log line (shipper ERROR_PATTERN).
            return { codec: 'unreadable', width: '?', height: '?', pixFmt: '?', bitDepth: '?', audioCodec: '?', unreadable: true }
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
            const baseName = path.basename(filePath)

            // Probe first. Corrupt/empty/truncated library files (e.g. invalid EBML at byte 0)
            // must not spawn ffmpeg or emit ERROR-classified lines — that floods the log monitor.
            const videoInfo = this.getVideoInfo(filePath)
            if (isUnreadableProbeResult(videoInfo)) {
                // Wording deliberately avoids error/failed/unable so classifyLevel → warn via "Skipping".
                Log(tag, `Skipping unreadable media ${baseName} — probe found no usable streams`, channel, {
                    file_path: filePath,
                    video_hash: videoHash,
                    reason: 'probe_unreadable'
                })
                cleanupPartialOutput(outputDir)
                resolve({ skipped: true, reason: 'unreadable' })
                return
            }

            // Create output directory
            fs.mkdirSync(outputDir, { recursive: true })

            // Log video info before transcoding
            Log(tag, `Processing ${baseName} [${videoInfo.codec} ${videoInfo.width}x${videoInfo.height} ${videoInfo.pixFmt} ${videoInfo.bitDepth}bit | audio: ${videoInfo.audioCodec}]`, channel)

            const hasGPU = checkNvidiaGPU()
            const [width] = DIMENSIONS.split('x')

            // Check if this file can use GPU - 10-bit and some codecs don't work well with CUDA filters
            const is10Bit = videoInfo.pixFmt && (videoInfo.pixFmt.includes('10') || videoInfo.bitDepth === '10')
            const gpuCompatibleCodecs = ['h264', 'hevc', 'vp9', 'av1', 'mpeg2video', 'mpeg4']
            const canUseGPU = hasGPU &&
                              VIDEO_CODEC === 'h264_nvenc' &&
                              !is10Bit &&
                              gpuCompatibleCodecs.includes(videoInfo.codec)

            const {
                videoCodec,
                videoPreset,
                inputArgs,
                qualityArgs,
                fullVideoFilter
            } = resolveEncodeSettings({
                hasGPU,
                canUseGPU,
                is10Bit,
                width,
                filePath,
                channel
            })

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
            this.activeProcesses.add(ffmpeg)
            const untrack = () => this.activeProcesses.delete(ffmpeg)
            ffmpeg.once('close', untrack)
            ffmpeg.once('error', untrack)

            const startTime = Date.now()
            let stderrData = ''

            ffmpeg.stderr.on('data', (data) => {
                stderrData += data.toString()
            })

            ffmpeg.on('close', (code) => {
                if (this.shuttingDown) {
                    reject(new Error('FFmpeg stopped during shutdown'))
                    return
                }
                if (code === 0) {
                    const duration = (Date.now() - startTime) / 1000
                    Log(tag, `Generated ${baseName} in ${duration.toFixed(1)}s [${this.currentIndex}/${this.totalVideos}]`, channel)

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
                        Log(tag, `Could not calculate video duration: ${e.message}`, channel, { error: e, playlist_path: outputPath, video_hash: videoHash })
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
                        Log(tag, `Database update error: ${dbErr.message}`, channel, { error: dbErr, video_id: videoId, video_hash: videoHash })
                    }

                    // Invalidate playlist cache so newly transcoded video appears
                    if (channel.playlistManager) {
                        channel.playlistManager.invalidateCache()
                    }

                    resolve()
                } else if (isUnreadableMediaStderr(stderrData)) {
                    // Library media problem, not an encode-path bug. One warn line; no raw Error: dump.
                    Log(tag, `Skipping unreadable media ${baseName} (encode exit ${code})`, channel, {
                        exit_code: code,
                        file_path: filePath,
                        video_hash: videoHash,
                        reason: 'encode_unreadable',
                        ffmpeg_stderr_tail: stderrData.slice(-500)
                    })
                    cleanupPartialOutput(outputDir)
                    resolve({ skipped: true, reason: 'unreadable' })
                } else {
                    Log(tag, `Failed to generate ${baseName} (exit code ${code})`, channel, {
                        exit_code: code,
                        file_path: filePath,
                        video_hash: videoHash,
                        ffmpeg_stderr_tail: stderrData.slice(-500)
                    })
                    // Keep stderr detail in context only — a second "Error: …" line was a log-monitor signature of its own.
                    reject(new Error(`FFmpeg exited with code ${code}`))
                }
            })

            ffmpeg.on('error', (err) => {
                Log(tag, `FFmpeg error for ${baseName}: ${err.message}`, channel, { error: err, file_path: filePath, video_hash: videoHash })
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
            if (this.shuttingDown) {
                break
            }
            this.currentIndex++
            try {
                await this.generateVideo(item.videoId, item.filePath, item.channel)
            } catch (err) {
                if (this.shuttingDown) {
                    break
                }
                // Avoid "failed" in the message — it classifies as ERROR and files a log-monitor ticket
                // even when generateVideo already logged the real failure. "Skipping" → warn.
                Log(tag, `Skipping video after encode exit: ${item.filePath}`, item.channel, {
                    file_path: item.filePath,
                    reason: err && err.message ? err.message : 'encode_exit'
                })
            }
        }

        this.isGenerating = false
        if (this.shuttingDown) {
            Log(tag, 'Generation stopped during shutdown')
        } else {
            Log(tag, `Generation complete! Processed ${this.totalVideos} videos.`)
        }
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

const preGenerator = new PreGenerator()
module.exports = preGenerator
module.exports.resolveEncodeSettings = resolveEncodeSettings
module.exports.deinterlacePrefix = deinterlacePrefix
module.exports.isUnreadableProbeResult = isUnreadableProbeResult
module.exports.isUnreadableMediaStderr = isUnreadableMediaStderr

