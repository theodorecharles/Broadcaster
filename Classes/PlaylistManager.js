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

        // Include segments behind current position
        const windowBehind = 30
        const totalSegments = allSegments.length

        let segmentsInWindow = []

        // Add segments behind current position
        for (let i = windowBehind; i > 0; i--) {
            const idx = currentIndex - i
            if (idx >= 0) {
                segmentsInWindow.push(allSegments[idx])
            }
        }

        // Find current video index
        const currentVideoIndex = allSegments[currentIndex].videoIndex

        // Add all remaining segments from current video + at least 2 more complete videos
        // This ensures smooth transitions - player always has future content buffered
        let videosIncluded = 0
        let lastVideoSeen = currentVideoIndex

        for (let i = currentIndex; i < totalSegments && videosIncluded < 3; i++) {
            segmentsInWindow.push(allSegments[i])
            if (allSegments[i].videoIndex !== lastVideoSeen) {
                videosIncluded++
                lastVideoSeen = allSegments[i].videoIndex
            }
        }

        // If we hit the end, wrap around to include more videos
        if (videosIncluded < 3) {
            for (let i = 0; i < totalSegments && videosIncluded < 3; i++) {
                const segment = allSegments[i]
                // Don't duplicate segments we already added
                if (segment.videoIndex <= currentVideoIndex) {
                    segmentsInWindow.push(segment)
                    if (segment.videoIndex !== lastVideoSeen) {
                        videosIncluded++
                        lastVideoSeen = segment.videoIndex
                    }
                } else {
                    break
                }
            }
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
