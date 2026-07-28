const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const tag = 'PlaylistManager'
const { CACHE_DIR, HLS_SEGMENT_LENGTH_SECONDS } = process.env
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000

class PlaylistManager {

    constructor(channel) {
        this.channel = channel
        // GuideGenerator is set by Channel after construction
        this.guideGenerator = null
        this.guideTimelineCache = new Map()
        this.segmentCountCache = new Map()
        this.segmentCache = new Map()
    }

    /**
     * Set the guide generator reference
     */
    setGuideGenerator(guideGenerator) {
        this.guideGenerator = guideGenerator
    }

    /**
     * Find an entry in a guide by its stable schedule identity
     */
    getEntryIndex(guide, entry) {
        if (!guide || !Array.isArray(guide.schedule)) {
            return -1
        }

        return guide.schedule.findIndex(
            candidate => candidate.hash === entry.hash && candidate.startTime === entry.startTime
        )
    }

    /**
     * Find the guide that owns an entry. Around the 3am boundary the active
     * entry can still belong to the previous day's guide.
     */
    getGuideContainingEntry(entry) {
        const activeGuide = this.guideGenerator.getActiveGuide()
        if (this.getEntryIndex(activeGuide, entry) >= 0) {
            return activeGuide
        }

        if (
            activeGuide
            && Number.isFinite(activeGuide.dayStart)
            && typeof this.guideGenerator.loadGuideForDay === 'function'
        ) {
            const previousGuide = this.guideGenerator.loadGuideForDay(
                activeGuide.dayStart - DAY_IN_MILLISECONDS
            )
            if (this.getEntryIndex(previousGuide, entry) >= 0) {
                return previousGuide
            }
        }

        return null
    }

    /**
     * Use exact transcoded segment counts when available. Historical guide
     * entries can outlive their database rows, so retain a duration fallback.
     */
    getSegmentCountForEntry(entry) {
        if (this.segmentCountCache.has(entry.hash)) {
            return this.segmentCountCache.get(entry.hash)
        }

        const video = this.getVideoByHash(entry.hash)
        if (video && Number.isInteger(video.segment_count) && video.segment_count > 0) {
            this.segmentCountCache.set(entry.hash, video.segment_count)
            return video.segment_count
        }

        const duration = Number(entry.duration)
            || ((Number(entry.endTime) - Number(entry.startTime)) / 1000)
        const segmentLength = parseFloat(HLS_SEGMENT_LENGTH_SECONDS) || 2

        return Number.isFinite(duration) && duration > 0
            ? Math.ceil(duration / segmentLength)
            : 0
    }

    /**
     * Calculate the channel-wide sequence offsets at the start of a guide.
     * Daily guides are persisted, so walking backward once gives stable,
     * exact offsets that survive program and day boundaries.
     */
    getGuideTimelineStart(guide) {
        const getCacheKey = candidate => Number.isFinite(candidate.dayStart)
            ? candidate.dayStart
            : candidate
        const requestedKey = getCacheKey(guide)
        const cachedStart = this.guideTimelineCache.get(requestedKey)
        if (cachedStart) {
            return cachedStart
        }

        const guidesToCalculate = []
        const visitedDayStarts = new Set()
        let cursor = guide
        let timelineStart = null

        while (cursor) {
            const cacheKey = getCacheKey(cursor)
            const cached = this.guideTimelineCache.get(cacheKey)
            if (cached) {
                const cachedSchedule = Array.isArray(cursor.schedule)
                    ? cursor.schedule
                    : []
                timelineStart = {
                    mediaSequence: cached.mediaSequence + cachedSchedule.reduce(
                        (total, entry) => total + this.getSegmentCountForEntry(entry),
                        0
                    ),
                    discontinuitySequence:
                        cached.discontinuitySequence + cachedSchedule.length
                }
                break
            }

            if (
                Number.isFinite(cursor.dayStart)
                && visitedDayStarts.has(cursor.dayStart)
            ) {
                timelineStart = { mediaSequence: 0, discontinuitySequence: 0 }
                break
            }

            if (Number.isFinite(cursor.dayStart)) {
                visitedDayStarts.add(cursor.dayStart)
            }
            guidesToCalculate.push(cursor)

            if (
                !Number.isFinite(cursor.dayStart)
                || typeof this.guideGenerator.loadGuideForDay !== 'function'
            ) {
                timelineStart = { mediaSequence: 0, discontinuitySequence: 0 }
                break
            }

            const previousGuide = this.guideGenerator.loadGuideForDay(
                cursor.dayStart - DAY_IN_MILLISECONDS
            )
            if (!previousGuide) {
                timelineStart = { mediaSequence: 0, discontinuitySequence: 0 }
                break
            }
            cursor = previousGuide
        }

        if (!timelineStart) {
            timelineStart = { mediaSequence: 0, discontinuitySequence: 0 }
        }

        for (let index = guidesToCalculate.length - 1; index >= 0; index--) {
            const currentGuide = guidesToCalculate[index]
            const currentStart = {
                mediaSequence: timelineStart.mediaSequence,
                discontinuitySequence: timelineStart.discontinuitySequence
            }
            this.guideTimelineCache.set(getCacheKey(currentGuide), currentStart)

            const schedule = Array.isArray(currentGuide.schedule)
                ? currentGuide.schedule
                : []
            timelineStart = {
                mediaSequence: currentStart.mediaSequence + schedule.reduce(
                    (total, entry) => total + this.getSegmentCountForEntry(entry),
                    0
                ),
                discontinuitySequence: currentStart.discontinuitySequence + schedule.length
            }
        }

        return this.guideTimelineCache.get(requestedKey)
    }

    /**
     * Resolve the sequence numbers assigned to the first segment of an entry.
     */
    getEntryTimelinePosition(entry) {
        const guide = this.getGuideContainingEntry(entry)
        const entryIndex = this.getEntryIndex(guide, entry)

        if (!guide || entryIndex < 0) {
            const segmentLength = parseFloat(HLS_SEGMENT_LENGTH_SECONDS) || 2
            return {
                mediaSequence: Math.floor(entry.startTime / (segmentLength * 1000)),
                discontinuitySequence: 0,
                guide: null,
                entryIndex: -1
            }
        }

        const guideStart = this.getGuideTimelineStart(guide)
        const precedingSegmentCount = guide.schedule
            .slice(0, entryIndex)
            .reduce(
                (total, scheduleEntry) => total + this.getSegmentCountForEntry(scheduleEntry),
                0
            )

        return {
            mediaSequence: guideStart.mediaSequence + precedingSegmentCount,
            discontinuitySequence: guideStart.discontinuitySequence + entryIndex,
            guide: guide,
            entryIndex: entryIndex
        }
    }

    /**
     * Find the next scheduled entry, including a daily guide boundary.
     */
    getNextEntry(timelinePosition) {
        const { guide, entryIndex } = timelinePosition
        if (!guide || entryIndex < 0) {
            return null
        }

        if (entryIndex < guide.schedule.length - 1) {
            return guide.schedule[entryIndex + 1]
        }

        if (
            !Number.isFinite(guide.dayStart)
            || typeof this.guideGenerator.loadGuideForDay !== 'function'
        ) {
            return null
        }

        const nextDayStart = guide.dayStart + DAY_IN_MILLISECONDS
        const activeGuide = this.guideGenerator.getActiveGuide()
        const nextGuide = activeGuide && activeGuide.dayStart === nextDayStart
            ? activeGuide
            : this.guideGenerator.loadGuideForDay(nextDayStart)

        return nextGuide && Array.isArray(nextGuide.schedule)
            ? nextGuide.schedule[0] || null
            : null
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
        this.segmentCountCache.set(currentEntry.hash, video.segment_count)

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
        const timelinePosition = this.getEntryTimelinePosition(currentEntry)

        // Check if we need segments from the next video too
        const currentSegmentsAhead = allCurrentSegments.length - currentSegmentIndex
        const nextSegmentsNeeded = segmentsAhead - currentSegmentsAhead

        if (nextSegmentsNeeded > 0) {
            // Need to include segments from next video
            const nextEntry = this.getNextEntry(timelinePosition)
            const nextVideo = nextEntry
                ? this.getVideoByHash(nextEntry.hash)
                : null

            if (nextVideo && nextVideo.segment_count) {
                this.segmentCountCache.set(nextEntry.hash, nextVideo.segment_count)
                const nextSegments = this.getAllSegmentsForVideo(nextEntry.hash, nextVideo)
                const nextWindow = nextSegments.slice(0, nextSegmentsNeeded)

                if (nextWindow.length > 0) {
                    nextWindow[0].startsDiscontinuity = true
                }

                segments = segments.concat(nextWindow)
            }
        }

        if (segments.length === 0) {
            return this.getEmptyPlaylist()
        }

        // Sequence the first segment on the channel-wide guide timeline
        const mediaSequence = timelinePosition.mediaSequence + startIndex

        // Find max segment duration for TARGETDURATION
        const maxDuration = Math.ceil(Math.max(...segments.map(s => s.duration), 2))

        let playlist = '#EXTM3U\n'
        playlist += '#EXT-X-VERSION:3\n'
        playlist += `#EXT-X-TARGETDURATION:${maxDuration}\n`
        playlist += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`
        playlist += `#EXT-X-DISCONTINUITY-SEQUENCE:${timelinePosition.discontinuitySequence}\n`

        // Add segments, with discontinuity tags at video transitions
        let lastVideoHash = null
        segments.forEach((segment) => {
            if (
                segment.startsDiscontinuity
                || (lastVideoHash && segment.videoHash !== lastVideoHash)
            ) {
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
        this.guideTimelineCache.clear()
        this.segmentCountCache.clear()
    }
}

module.exports = {
    PlaylistManager: PlaylistManager
}
