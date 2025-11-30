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
    }

    /**
     * Generate a unique hash for a video file path
     * The manifest.json maps these hashes back to original filenames
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
            const metadataPath = path.join(path.dirname(playlistPath), 'metadata.json')

            if (!fs.existsSync(playlistPath)) {
                return
            }

            // Require metadata.json to exist - it's only written after successful transcoding
            if (!fs.existsSync(metadataPath)) {
                return
            }

            try {
                const content = fs.readFileSync(playlistPath, 'utf8')

                // Only include fully transcoded videos (must have ENDLIST marker)
                if (!content.includes('#EXT-X-ENDLIST')) {
                    return
                }

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

        // For live TV simulation: playlist should only include "aired" content
        // HLS.js will seek to the live edge (end of playlist), so we only include
        // segments from the beginning up to current position + small buffer
        const bufferAhead = 18  // ~3 minutes buffer ahead of "now"
        const totalSegments = allSegments.length

        let segmentsInWindow = []

        // Include segments from start of current loop up to current position + buffer
        const endIndex = Math.min(currentIndex + bufferAhead, totalSegments)
        for (let i = 0; i < endIndex; i++) {
            segmentsInWindow.push(allSegments[i])
        }

        // Calculate sequence number - increases monotonically across loops
        const loopCount = Math.floor(offsetSeconds / totalDuration)
        const mediaSequence = loopCount * totalSegments

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
     * Parse a filename to extract just the episode/movie title
     * Handles patterns like:
     * - "Show Name - S01E01 - Episode Title"
     * - "Show Name S01E01 Episode Title"
     * - "Movie Name (2024)"
     */
    parseTitle(filename) {
        // Try to extract episode title after "S01E01 - " pattern
        const episodeMatch = filename.match(/[Ss]\d+[Ee]\d+\s*[-–]\s*(.+)$/)
        if (episodeMatch) {
            return episodeMatch[1].trim()
        }

        // Try pattern with just episode number like "Show - 01 - Title"
        const numMatch = filename.match(/[-–]\s*\d+\s*[-–]\s*(.+)$/)
        if (numMatch) {
            return numMatch[1].trim()
        }

        // Try to get text after last " - " for "Show Name - Episode Title"
        const dashParts = filename.split(/\s*[-–]\s*/)
        if (dashParts.length >= 2) {
            // Return the last part if it's not just numbers
            const lastPart = dashParts[dashParts.length - 1]
            if (!/^\d+$/.test(lastPart)) {
                return lastPart.trim()
            }
        }

        // For movies, try to remove year like "(2024)" or "[2024]"
        const movieClean = filename.replace(/\s*[\(\[]\d{4}[\)\]]\s*$/, '').trim()
        if (movieClean !== filename) {
            return movieClean
        }

        // Return original filename if no pattern matched
        return filename
    }

    /**
     * Get a friendly display name for a video
     * Finds which configured path contains this file and returns that folder name
     */
    getVideoDisplayName(filePath) {
        const manifest = this.loadManifest()
        const videoHash = this.getVideoHash(filePath)

        // Get the original path from manifest, or use the provided path
        let originalPath = filePath
        if (manifest[videoHash] && manifest[videoHash].originalPath) {
            originalPath = manifest[videoHash].originalPath
        }

        // Find which configured path contains this file
        if (this.channel.paths) {
            for (const configuredPath of this.channel.paths) {
                if (originalPath.startsWith(configuredPath)) {
                    // Return the basename of the configured path (show/movie name)
                    return path.basename(configuredPath)
                }
            }
        }

        // Fallback: return parent folder name
        return path.basename(path.dirname(originalPath))
    }

    /**
     * Get schedule for the TV guide - shows from previous 3am to next 3am
     * Playback is continuous and never resets at 3am boundaries
     */
    getSchedule() {
        const allSegments = this.generateMasterPlaylist()
        if (allSegments.length === 0) return []

        const totalDuration = allSegments[allSegments.length - 1].timestamp

        // Build a list of videos with their start times (relative to loop start)
        const videos = []
        let lastVideoIndex = -1
        let videoStartTime = 0

        allSegments.forEach((segment, idx) => {
            if (segment.videoIndex !== lastVideoIndex) {
                const filePath = this.channel.queue[segment.videoIndex]
                const videoHash = this.getVideoHash(filePath)
                const displayName = this.getVideoDisplayName(filePath)

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

        const now = Date.now()
        const dayStart = this.getPrevious3am()
        const dayEnd = this.getNext3am()

        // Use actual playback offset (same calculation as createRollingPlaylist)
        const currentOffset = this.getCurrentOffset()
        const normalizedOffset = currentOffset % totalDuration

        // Calculate buffer offset to match what the player actually shows
        // The playlist includes bufferAhead segments past "now", and HLS.js seeks to live edge
        // So the player is actually showing content from ~bufferAhead segments in the future
        const bufferAheadSegments = 18 // Must match createRollingPlaylist
        const avgSegmentDuration = totalDuration / allSegments.length
        const bufferOffsetMs = bufferAheadSegments * avgSegmentDuration * 1000
        const playerTime = now + bufferOffsetMs

        // Calculate the loop start time (when the current loop began)
        const loopStartTime = now - (normalizedOffset * 1000)

        // Work backwards to find the loop that covers dayStart
        const loopDuration = totalDuration * 1000
        let scheduleLoopStart = loopStartTime

        while (scheduleLoopStart > dayStart) {
            scheduleLoopStart -= loopDuration
        }

        const schedule = []

        // Generate schedule from dayStart to dayEnd
        // May need multiple loops if playlist is shorter than 24 hours
        let currentLoopStart = scheduleLoopStart

        while (currentLoopStart < dayEnd) {
            videos.forEach(video => {
                // Skip videos not fully pre-generated (0 duration)
                if (video.duration <= 0) return

                const videoStartMs = currentLoopStart + (video.startTime * 1000)
                const videoEndMs = videoStartMs + (video.duration * 1000)

                // Include videos that overlap with our display window
                if (videoEndMs > dayStart && videoStartMs < dayEnd) {
                    schedule.push({
                        title: video.displayName,
                        startTime: videoStartMs,
                        endTime: videoEndMs,
                        duration: video.duration,
                        // Use playerTime (now + buffer) to match what the player is actually showing
                        isCurrent: videoStartMs <= playerTime && videoEndMs > playerTime
                    })
                }
            })
            currentLoopStart += loopDuration
        }

        // Sort by start time
        schedule.sort((a, b) => a.startTime - b.startTime)

        // Merge consecutive short videos (< 20 min) from the same show
        const SHORT_THRESHOLD = 20 * 60 // 20 minutes in seconds
        const mergedSchedule = []

        for (let i = 0; i < schedule.length; i++) {
            const current = schedule[i]

            // If this is a short video, try to merge with following short videos of same title
            if (current.duration < SHORT_THRESHOLD) {
                let merged = { ...current }
                let j = i + 1

                // Keep merging consecutive short videos with same title
                while (j < schedule.length &&
                       schedule[j].title === merged.title &&
                       schedule[j].duration < SHORT_THRESHOLD) {
                    merged.endTime = schedule[j].endTime
                    merged.duration += schedule[j].duration
                    // isCurrent if any merged video is current
                    merged.isCurrent = merged.isCurrent || schedule[j].isCurrent
                    j++
                }

                mergedSchedule.push(merged)
                i = j - 1 // Skip merged entries
            } else {
                mergedSchedule.push(current)
            }
        }

        return mergedSchedule
    }

    /**
     * Get the day start for TV guide display (previous 3am)
     */
    getDayStart() {
        return this.getPrevious3am()
    }

    /**
     * Get the next 3am boundary (for schedule end)
     */
    getNext3am() {
        const now = new Date()
        const next3am = new Date(now)
        next3am.setHours(3, 0, 0, 0)

        // If it's past 3am today, get tomorrow's 3am
        if (now.getHours() >= 3) {
            next3am.setDate(next3am.getDate() + 1)
        }

        return next3am.getTime()
    }

    /**
     * Get the previous 3am boundary (for schedule start display)
     */
    getPrevious3am() {
        const now = new Date()
        const prev3am = new Date(now)
        prev3am.setHours(3, 0, 0, 0)

        // If it's before 3am, get yesterday's 3am
        if (now.getHours() < 3) {
            prev3am.setDate(prev3am.getDate() - 1)
        }

        return prev3am.getTime()
    }

    /**
     * Start the playlist manager
     */
    start() {
        this.updateManifest()
        Log(tag, 'Playlist manager started', this.channel)
    }

    /**
     * Get current time offset in seconds
     * Uses Channel's startTime to stay in sync with actual playback
     */
    getCurrentOffset() {
        if (!this.channel.startTime) return 0
        return (Date.now() - this.channel.startTime) / 1000
    }
}

module.exports = {
    PlaylistManager: PlaylistManager
}
