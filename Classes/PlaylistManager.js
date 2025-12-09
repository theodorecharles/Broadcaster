const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const tag = 'PlaylistManager'
const { CACHE_DIR, HLS_SEGMENT_LENGTH_SECONDS } = process.env

class PlaylistManager {

    constructor(channel) {
        this.channel = channel
        // GuideGenerator is set by Channel after construction
        this.guideGenerator = null
    }

    /**
     * Set the guide generator reference
     */
    setGuideGenerator(guideGenerator) {
        this.guideGenerator = guideGenerator
    }

    /**
     * Generate a unique hash for a video file path
     */
    getVideoHash(filePath) {
        return crypto.createHash('md5').update(filePath).digest('hex')
    }

    /**
     * Get video metadata from database by hash
     */
    getVideoByHash(hash) {
        const db = Database()
        return db.getVideoByHash(this.channel.slug, hash)
    }

    /**
     * Generate segments for a video starting from a specific offset
     * Returns segments from offsetInVideo to offsetInVideo + bufferDuration
     */
    generateSegmentsForVideo(videoHash, offsetInVideo, video, bufferDuration = 30) {
        if (!video || !video.segment_count || !video.duration_seconds) {
            return []
        }

        const segments = []
        const numSegments = video.segment_count
        const avgSegmentDuration = video.duration_seconds / numSegments

        // Find the starting segment based on offset
        const startSegmentIndex = Math.floor(offsetInVideo / avgSegmentDuration)
        const endOffset = offsetInVideo + bufferDuration

        for (let i = startSegmentIndex; i < numSegments; i++) {
            const segStart = i * avgSegmentDuration
            const segDuration = (i === numSegments - 1)
                ? (video.duration_seconds - (i * avgSegmentDuration))
                : avgSegmentDuration
            const segEnd = segStart + segDuration

            // Stop if past our buffer window
            if (segStart >= endOffset) break

            segments.push({
                duration: segDuration,
                path: `channels/${this.channel.slug}/videos/${videoHash}/segment_${String(i).padStart(5, '0')}.ts`,
                segmentIndex: i
            })
        }

        return segments
    }

    /**
     * Create a rolling playlist based on what the guide says should be playing now
     * This is the core method that serves HLS playlists to clients
     */
    createRollingPlaylist() {
        if (!this.guideGenerator) {
            Log(tag, 'No guide generator available', this.channel)
            return this.getEmptyPlaylist()
        }

        const now = Date.now()

        // Find what should be playing right now according to the guide
        const currentEntry = this.guideGenerator.findEntryAtTime(now)

        if (!currentEntry) {
            Log(tag, 'No schedule entry for current time', this.channel)
            return this.getEmptyPlaylist()
        }

        // Get video metadata from database
        const video = this.getVideoByHash(currentEntry.hash)

        if (!video || !video.segment_count) {
            Log(tag, `Video not found or not transcoded: ${currentEntry.hash}`, this.channel)
            return this.getEmptyPlaylist()
        }

        // Calculate offset within the current video
        const offsetInVideo = (now - currentEntry.startTime) / 1000

        // Get segments for current position plus buffer ahead
        const segmentLength = parseFloat(HLS_SEGMENT_LENGTH_SECONDS) || 2
        const bufferAhead = 18 * segmentLength // ~18 segments ahead

        const currentSegments = this.generateSegmentsForVideo(
            currentEntry.hash,
            offsetInVideo,
            video,
            bufferAhead
        )

        // Check if we need segments from the next video too
        let nextSegments = []
        const timeUntilNextVideo = (currentEntry.endTime - now) / 1000

        if (timeUntilNextVideo < bufferAhead) {
            // Need to include segments from next video
            const guide = this.guideGenerator.getActiveGuide()
            if (guide && guide.schedule) {
                const currentIndex = guide.schedule.findIndex(e => e.hash === currentEntry.hash && e.startTime === currentEntry.startTime)
                if (currentIndex >= 0 && currentIndex < guide.schedule.length - 1) {
                    const nextEntry = guide.schedule[currentIndex + 1]
                    const nextVideo = this.getVideoByHash(nextEntry.hash)

                    if (nextVideo && nextVideo.segment_count) {
                        const remainingBuffer = bufferAhead - timeUntilNextVideo
                        nextSegments = this.generateSegmentsForVideo(
                            nextEntry.hash,
                            0,
                            nextVideo,
                            remainingBuffer
                        )
                    }
                }
            }
        }

        // Build the HLS playlist
        const allSegments = [...currentSegments, ...nextSegments]

        if (allSegments.length === 0) {
            return this.getEmptyPlaylist()
        }

        // Calculate media sequence (use timestamp-based sequence for consistency)
        const mediaSequence = Math.floor(now / 1000)

        // Find max segment duration for TARGETDURATION
        const maxDuration = Math.ceil(Math.max(...allSegments.map(s => s.duration), 2))

        let playlist = '#EXTM3U\n'
        playlist += '#EXT-X-VERSION:3\n'
        playlist += `#EXT-X-TARGETDURATION:${maxDuration}\n`
        playlist += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`

        // Add segments, with discontinuity tag between videos
        let lastPath = null
        allSegments.forEach((segment, index) => {
            // Add discontinuity if switching to next video's segments
            if (index === currentSegments.length && nextSegments.length > 0) {
                playlist += '#EXT-X-DISCONTINUITY\n'
            }
            playlist += `#EXTINF:${segment.duration.toFixed(6)},\n`
            playlist += `${segment.path}\n`
        })

        return playlist
    }

    /**
     * Return an empty/static playlist
     */
    getEmptyPlaylist() {
        return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-ENDLIST\n'
    }

    /**
     * Get the manifest path for storing video metadata
     */
    getManifestPath() {
        return path.join(CACHE_DIR, 'channels', this.channel.slug, 'manifest.json')
    }

    /**
     * Load or create the video manifest with original filenames
     */
    loadManifest() {
        const manifestPath = this.getManifestPath()
        try {
            if (fs.existsSync(manifestPath)) {
                return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            }
        } catch (err) {
            Log(tag, `Error loading manifest: ${err.message}`, this.channel)
        }
        return {}
    }

    /**
     * Save video metadata to manifest
     */
    saveManifest(manifest) {
        const manifestPath = this.getManifestPath()
        const dir = path.dirname(manifestPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    }

    /**
     * Update manifest with video metadata from database
     */
    updateManifest() {
        const manifest = this.loadManifest()
        const db = Database()
        const videos = db.getChannelVideos(this.channel.slug, false) // all videos

        videos.forEach(video => {
            const videoHash = this.getVideoHash(video.file_path)
            if (!manifest[videoHash]) {
                manifest[videoHash] = {
                    originalPath: video.file_path,
                    filename: path.basename(video.file_path, path.extname(video.file_path)),
                    addedAt: Date.now()
                }
            }
        })

        this.saveManifest(manifest)
        return manifest
    }

    /**
     * Get a friendly display name for a video
     */
    getVideoDisplayName(filePath) {
        if (this.channel.paths) {
            for (const configuredPath of this.channel.paths) {
                if (filePath.startsWith(configuredPath)) {
                    return path.basename(configuredPath)
                }
            }
        }
        return path.basename(path.dirname(filePath))
    }

    /**
     * Get schedule for the TV guide - delegates to GuideGenerator
     */
    getSchedule() {
        if (!this.guideGenerator) {
            return []
        }
        return this.guideGenerator.getScheduleForAPI()
    }

    /**
     * Get the day start for TV guide display
     */
    getDayStart() {
        if (!this.guideGenerator) {
            return Date.now()
        }
        const guide = this.guideGenerator.getActiveGuide()
        return guide ? guide.dayStart : Date.now()
    }

    /**
     * Start the playlist manager
     */
    start() {
        this.updateManifest()
        Log(tag, 'Playlist manager started', this.channel)
    }

    /**
     * Invalidate cache - now delegates to guide generator
     */
    invalidateCache() {
        if (this.guideGenerator) {
            this.guideGenerator.invalidateCache()
        }
    }
}

module.exports = {
    PlaylistManager: PlaylistManager
}
