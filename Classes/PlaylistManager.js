const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const tag = 'PlaylistManager'
const { CACHE_DIR } = process.env

class PlaylistManager {

    constructor(channel) {
        this.channel = channel
        // GuideGenerator is set by Channel after construction
        this.guideGenerator = null
        this.segmentCache = new Map()
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
     * Generate all segments for a video
     */
    getAllSegmentsForVideo(videoHash, video) {
        if (!video || !video.segment_count) {
            return []
        }

        if (this.segmentCache.has(videoHash)) {
            return this.segmentCache.get(videoHash)
        }

        const playlistPath = path.join(
            CACHE_DIR,
            'channels',
            this.channel.slug,
            'videos',
            videoHash,
            'index.m3u8'
        )

        try {
            const playlist = fs.readFileSync(playlistPath, 'utf8')
            const durations = playlist
                .split(/\r?\n/)
                .filter(line => line.startsWith('#EXTINF:'))
                .map(line => Number(line.slice('#EXTINF:'.length).split(',')[0]))

            if (durations.length === 0 || durations.some(duration => !Number.isFinite(duration) || duration <= 0)) {
                throw new Error('playlist contains invalid segment durations')
            }

            const segments = durations.map((duration, segmentIndex) => ({
                duration: duration,
                path: `channels/${this.channel.slug}/videos/${videoHash}/segment_${String(segmentIndex).padStart(5, '0')}.ts`,
                segmentIndex: segmentIndex,
                videoHash: videoHash
            }))

            this.segmentCache.set(videoHash, segments)
            return segments
        } catch (err) {
            Log(tag, `Could not read segment durations for ${videoHash}: ${err.message}`, this.channel)
            return []
        }
    }

    /**
     * Find the segment containing an offset using the playlist's cumulative durations
     */
    getSegmentIndexForOffset(segments, offsetSeconds) {
        let segmentEnd = 0

        for (let i = 0; i < segments.length; i++) {
            segmentEnd += segments[i].duration
            if (offsetSeconds < segmentEnd) {
                return i
            }
        }

        return Math.max(segments.length - 1, 0)
    }

    /**
     * Create a rolling playlist based on what the guide says should be playing now
     * This is the core method that serves HLS playlists to clients
     *
     * Strategy: Include all segments from start of video up to current position + buffer.
     * This gives players enough context to sync properly.
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

        // Calculate offset within the current video (in seconds)
        const offsetInVideo = (now - currentEntry.startTime) / 1000

        // Get ALL segments for current video
        const allCurrentSegments = this.getAllSegmentsForVideo(currentEntry.hash, video)

        if (allCurrentSegments.length === 0) {
            return this.getEmptyPlaylist()
        }

        // Calculate which segment we're currently on
        const currentSegmentIndex = this.getSegmentIndexForOffset(allCurrentSegments, offsetInVideo)

        // Buffer configuration
        const segmentsAhead = 18  // Buffer ahead
        const segmentsBehind = 3  // Keep a few behind for seeking

        // Calculate window of segments to include
        const startIndex = Math.max(0, currentSegmentIndex - segmentsBehind)
        const endIndex = Math.min(allCurrentSegments.length, currentSegmentIndex + segmentsAhead)

        // Get segments within our window
        let segments = allCurrentSegments.slice(startIndex, endIndex)

        // Check if we need segments from the next video too
        const currentSegmentsAhead = allCurrentSegments.length - currentSegmentIndex
        const nextSegmentsNeeded = segmentsAhead - currentSegmentsAhead

        if (nextSegmentsNeeded > 0) {
            // Need to include segments from next video
            const guide = this.guideGenerator.getActiveGuide()
            if (guide && guide.schedule) {
                const currentIndex = guide.schedule.findIndex(
                    e => e.hash === currentEntry.hash && e.startTime === currentEntry.startTime
                )
                if (currentIndex >= 0 && currentIndex < guide.schedule.length - 1) {
                    const nextEntry = guide.schedule[currentIndex + 1]
                    const nextVideo = this.getVideoByHash(nextEntry.hash)

                    if (nextVideo && nextVideo.segment_count) {
                        const nextSegments = this.getAllSegmentsForVideo(nextEntry.hash, nextVideo)
                        segments = segments.concat(nextSegments.slice(0, nextSegmentsNeeded))
                    }
                }
            }
        }

        if (segments.length === 0) {
            return this.getEmptyPlaylist()
        }

        // Calculate media sequence based on the first segment we're showing
        // This ensures sequence numbers are consistent as segments roll off
        const mediaSequence = startIndex

        // Find max segment duration for TARGETDURATION
        const maxDuration = Math.ceil(Math.max(...segments.map(s => s.duration), 2))

        let playlist = '#EXTM3U\n'
        playlist += '#EXT-X-VERSION:3\n'
        playlist += `#EXT-X-TARGETDURATION:${maxDuration}\n`
        playlist += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`

        // Add segments, with discontinuity tags at video transitions
        let lastVideoHash = null
        segments.forEach((segment) => {
            if (lastVideoHash && segment.videoHash !== lastVideoHash) {
                playlist += '#EXT-X-DISCONTINUITY\n'
            }
            lastVideoHash = segment.videoHash
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
        this.segmentCache.clear()
        if (this.guideGenerator) {
            this.guideGenerator.invalidateCache()
        }
    }
}

module.exports = {
    PlaylistManager: PlaylistManager
}
