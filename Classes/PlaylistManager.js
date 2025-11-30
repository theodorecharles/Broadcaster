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
                Log(tag, `Missing HLS for: ${path.basename(filePath)}`, this.channel)
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

        // Include 30 seconds behind and 60 seconds ahead, wrapping around for loop
        const windowBehind = 30
        const windowAhead = 60
        const totalSegments = allSegments.length

        let segmentsInWindow = []

        // Gather segments, wrapping around if needed
        for (let i = -windowBehind; i < windowAhead; i++) {
            const idx = currentIndex + i
            if (idx >= 0 && idx < totalSegments) {
                segmentsInWindow.push(allSegments[idx])
            } else if (idx >= totalSegments) {
                // Wrap around to beginning for continuous loop
                const wrappedIdx = idx % totalSegments
                segmentsInWindow.push(allSegments[wrappedIdx])
            }
        }

        // Calculate sequence number - use loop count * totalSegments + position for monotonic increase
        const loopCount = Math.floor(offsetSeconds / totalDuration)
        const mediaSequence = loopCount * totalSegments + Math.max(0, currentIndex - windowBehind)

        // Build playlist for live streaming (no ENDLIST tag)
        let playlist = '#EXTM3U\n'
        playlist += '#EXT-X-VERSION:3\n'
        playlist += '#EXT-X-TARGETDURATION:2\n'
        playlist += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`

        // Add segments in window
        segmentsInWindow.forEach(segment => {
            playlist += `#EXTINF:${segment.duration.toFixed(6)},\n`
            playlist += `${segment.path}\n`
        })

        // Don't add EXT-X-ENDLIST or PLAYLIST-TYPE - this tells the player it's a live stream
        return playlist
    }

    /**
     * Start the playlist manager
     */
    start() {
        this.startTime = Date.now()
        Log(tag, 'Playlist manager started', this.channel)
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
