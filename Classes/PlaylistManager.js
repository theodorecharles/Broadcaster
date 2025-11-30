const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('../Utilities/Log.js')
const tag = 'PlaylistManager'
const { CACHE_DIR } = process.env

class PlaylistManager {

    constructor(channel) {
        this.channel = channel
        this.currentIndex = 0
        this.startTime = null
    }

    /**
     * Generate a unique hash for a video file
     */
    getVideoHash(filePath) {
        return crypto.createHash('md5').update(filePath).digest('hex')
    }

    /**
     * Get the path to a video's pre-generated HLS playlist
     */
    getVideoPlaylistPath(filePath) {
        const videoHash = this.getVideoHash(filePath)
        return path.join(CACHE_DIR, 'channels', this.channel.slug, 'videos', videoHash, 'index.m3u8')
    }

    /**
     * Parse segment duration from a playlist line
     */
    parseSegmentDuration(line) {
        const match = line.match(/#EXTINF:([\d.]+)/)
        return match ? parseFloat(match[1]) : 0
    }

    /**
     * Get total duration of a video's playlist in seconds
     */
    getPlaylistDuration(playlistPath) {
        try {
            const content = fs.readFileSync(playlistPath, 'utf8')
            let totalDuration = 0

            content.split('\n').forEach(line => {
                if (line.startsWith('#EXTINF:')) {
                    totalDuration += this.parseSegmentDuration(line)
                }
            })

            return totalDuration
        } catch (err) {
            Log(tag, `Error reading playlist ${playlistPath}: ${err.message}`, this.channel)
            return 0
        }
    }

    /**
     * Generate a master playlist that combines all videos in sequence
     */
    generateMasterPlaylist() {
        const segments = []
        let totalDuration = 0

        this.channel.queue.forEach((filePath, index) => {
            const videoHash = this.getVideoHash(filePath)
            const playlistPath = this.getVideoPlaylistPath(filePath)

            if (!fs.existsSync(playlistPath)) {
                return
            }

            try {
                const content = fs.readFileSync(playlistPath, 'utf8')
                const lines = content.split('\n')

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim()

                    if (line.startsWith('#EXTINF:')) {
                        const duration = this.parseSegmentDuration(line)
                        totalDuration += duration

                        // Next line should be the segment filename
                        const segmentFile = lines[i + 1]?.trim()
                        if (segmentFile && !segmentFile.startsWith('#')) {
                            segments.push({
                                duration: duration,
                                path: `channels/${this.channel.slug}/videos/${videoHash}/${segmentFile}`,
                                videoIndex: index,
                                timestamp: totalDuration
                            })
                        }
                    }
                }
            } catch (err) {
                Log(tag, `Error processing ${filePath}: ${err.message}`, this.channel)
            }
        })

        return segments
    }

    /**
     * Create a rolling playlist that shows only segments within a time window
     * Handles looping by wrapping around to the beginning when near the end
     */
    createRollingPlaylist(offsetSeconds = 0) {
        const allSegments = this.generateMasterPlaylist()

        if (allSegments.length === 0) {
            return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n'
        }

        // Find total duration for looping
        const totalDuration = allSegments[allSegments.length - 1].timestamp

        // Normalize offset to loop within total duration
        const normalizedOffset = offsetSeconds % totalDuration

        // Find current position in the stream
        let currentIndex = 0
        for (let i = 0; i < allSegments.length; i++) {
            if (allSegments[i].timestamp > normalizedOffset) {
                currentIndex = i
                break
            }
        }

        // Include segments behind and ahead of current position
        // Use large windows to ensure smooth playback across video transitions
        const windowBehind = 30
        const windowAhead = 2000  // ~30+ minutes at 1 sec/segment
        const totalSegments = allSegments.length

        let segmentsInWindow = []

        // Gather segments with wrap-around support
        for (let i = -windowBehind; i < windowAhead; i++) {
            let idx = currentIndex + i
            if (idx < 0) continue
            if (idx >= totalSegments) {
                idx = idx % totalSegments  // Wrap around for continuous loop
            }
            segmentsInWindow.push(allSegments[idx])
        }

        // Calculate sequence number - use loop count * totalSegments + position for monotonic increase
        const loopCount = Math.floor(offsetSeconds / totalDuration)
        const mediaSequence = loopCount * totalSegments + Math.max(0, currentIndex - windowBehind)

        // Find max segment duration for TARGETDURATION (HLS spec requires it >= max segment)
        const maxDuration = Math.ceil(Math.max(...segmentsInWindow.map(s => s.duration), 2))

        // Build playlist for live streaming (no ENDLIST tag)
        let playlist = '#EXTM3U\n'
        playlist += '#EXT-X-VERSION:3\n'
        playlist += `#EXT-X-TARGETDURATION:${maxDuration}\n`
        playlist += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`

        // Add segments in window, with discontinuity tags at video transitions
        let lastVideoIndex = null
        segmentsInWindow.forEach(segment => {
            // Add discontinuity tag when transitioning to a different video
            if (lastVideoIndex !== null && segment.videoIndex !== lastVideoIndex) {
                playlist += '#EXT-X-DISCONTINUITY\n'
            }
            lastVideoIndex = segment.videoIndex
            playlist += `#EXTINF:${segment.duration.toFixed(6)},\n`
            playlist += `${segment.path}\n`
        })

        // Don't add EXT-X-ENDLIST or PLAYLIST-TYPE - this tells the player it's a live stream
        return playlist
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
     * Update manifest with current queue's video metadata
     */
    updateManifest() {
        const manifest = this.loadManifest()

        this.channel.queue.forEach(filePath => {
            const videoHash = this.getVideoHash(filePath)
            if (!manifest[videoHash]) {
                manifest[videoHash] = {
                    originalPath: filePath,
                    filename: path.basename(filePath, path.extname(filePath)),
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
        const manifest = this.loadManifest()
        const videoHash = this.getVideoHash(filePath)

        if (manifest[videoHash]) {
            return manifest[videoHash].filename
        }

        // Fallback to parsing the filename
        return path.basename(filePath, path.extname(filePath))
    }

    /**
     * Get schedule for the TV guide - shows what's playing when
     */
    getSchedule(hoursAhead = 24) {
        const allSegments = this.generateMasterPlaylist()
        if (allSegments.length === 0) return []

        const manifest = this.loadManifest()
        const totalDuration = allSegments[allSegments.length - 1].timestamp
        const currentOffset = this.getCurrentOffset()
        const normalizedOffset = currentOffset % totalDuration

        // Build a list of videos with their start times
        const videos = []
        let lastVideoIndex = -1
        let videoStartTime = 0

        allSegments.forEach((segment, idx) => {
            if (segment.videoIndex !== lastVideoIndex) {
                const filePath = this.channel.queue[segment.videoIndex]
                const videoHash = this.getVideoHash(filePath)
                const displayName = manifest[videoHash]?.filename || path.basename(filePath, path.extname(filePath))

                videos.push({
                    videoIndex: segment.videoIndex,
                    displayName: displayName,
                    startTime: videoStartTime,
                    duration: 0,
                    hash: videoHash
                })
                lastVideoIndex = segment.videoIndex
            }
            // Track duration
            if (videos.length > 0) {
                videos[videos.length - 1].duration += segment.duration
            }
            videoStartTime = segment.timestamp
        })

        // Find current video and calculate actual times
        const now = Date.now()
        const schedule = []

        // Calculate how far into the loop we are
        const loopStartTime = now - (normalizedOffset * 1000)

        videos.forEach(video => {
            const videoStartMs = loopStartTime + (video.startTime * 1000)
            const videoEndMs = videoStartMs + (video.duration * 1000)

            // Include videos that end after now and start before our window
            const windowEnd = now + (hoursAhead * 60 * 60 * 1000)

            if (videoEndMs > now && videoStartMs < windowEnd) {
                schedule.push({
                    title: video.displayName,
                    startTime: videoStartMs,
                    endTime: videoEndMs,
                    duration: video.duration,
                    isCurrent: videoStartMs <= now && videoEndMs > now
                })
            }
        })

        // If we need more items (loop wraps), add from beginning
        if (schedule.length < 10 && videos.length > 0) {
            const loopDuration = totalDuration * 1000
            let nextLoopStart = loopStartTime + loopDuration

            for (let loop = 0; loop < 3 && schedule.length < 20; loop++) {
                videos.forEach(video => {
                    const videoStartMs = nextLoopStart + (video.startTime * 1000)
                    const videoEndMs = videoStartMs + (video.duration * 1000)
                    const windowEnd = now + (hoursAhead * 60 * 60 * 1000)

                    if (videoStartMs < windowEnd) {
                        schedule.push({
                            title: video.displayName,
                            startTime: videoStartMs,
                            endTime: videoEndMs,
                            duration: video.duration,
                            isCurrent: false
                        })
                    }
                })
                nextLoopStart += loopDuration
            }
        }

        return schedule
    }

    /**
     * Get midnight of the current day (used to anchor schedule)
     */
    getMidnightToday() {
        const now = new Date()
        now.setHours(0, 0, 0, 0)
        return now.getTime()
    }

    /**
     * Start the playlist manager
     * Anchors schedule to midnight so it's consistent throughout the day
     */
    start() {
        // Anchor to midnight so schedule is consistent all day
        this.startTime = this.getMidnightToday()
        this.updateManifest()
        Log(tag, 'Playlist manager started (anchored to midnight)', this.channel)
    }

    /**
     * Get current time offset in seconds
     */
    getCurrentOffset() {
        if (!this.startTime) return 0
        return (Date.now() - this.startTime) / 1000
    }
}

module.exports = {
    PlaylistManager: PlaylistManager
}
