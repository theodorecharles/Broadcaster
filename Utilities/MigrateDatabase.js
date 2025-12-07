const Database = require('./Database.js')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('./Log.js')
const tag = 'Migration'

const { CACHE_DIR } = process.env

/**
 * Migrate existing transcoded videos to the database
 * Scans the cache directory and marks videos as transcoded if HLS files exist
 */
function migrateExistingVideos(channelSlug) {
    const db = Database()
    const channel = db.getChannelBySlug(channelSlug)

    if (!channel) {
        Log(tag, `Channel ${channelSlug} not found in database`)
        return
    }

    const videos = db.getChannelVideos(channelSlug, false)
    let migratedCount = 0

    videos.forEach(video => {
        // Skip if already marked as transcoded
        if (video.transcoded) {
            return
        }

        const videoDir = path.join(CACHE_DIR, 'channels', channelSlug, 'videos', video.hash)
        const playlistPath = path.join(videoDir, 'index.m3u8')
        const metadataPath = path.join(videoDir, 'metadata.json')

        // Check if video is fully transcoded
        if (fs.existsSync(playlistPath) && fs.existsSync(metadataPath)) {
            try {
                const playlistContent = fs.readFileSync(playlistPath, 'utf8')

                // Must have ENDLIST marker to be considered complete
                if (playlistContent.includes('#EXT-X-ENDLIST')) {
                    // Calculate duration from playlist
                    let duration = 0
                    playlistContent.split('\n').forEach(line => {
                        if (line.startsWith('#EXTINF:')) {
                            const match = line.match(/#EXTINF:([\d.]+)/)
                            if (match) duration += parseFloat(match[1])
                        }
                    })

                    // Read metadata if available
                    let videoCodec = null
                    let audioCodec = null
                    let width = null
                    let height = null

                    try {
                        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
                        // Metadata might not have codec info, that's okay
                    } catch (e) {
                        // Ignore metadata read errors
                    }

                    // Mark as transcoded
                    db.markVideoTranscoded(video.hash, duration, videoCodec, audioCodec, width, height)
                    migratedCount++
                }
            } catch (err) {
                Log(tag, `Error migrating ${video.filename}: ${err.message}`)
            }
        }
    })

    Log(tag, `Migrated ${migratedCount} existing transcoded videos for channel ${channelSlug}`)
    return migratedCount
}

/**
 * Migrate all channels
 */
function migrateAll() {
    const db = Database()
    const channels = db.getAllChannels()

    Log(tag, `Starting migration for ${channels.length} channels...`)

    let totalMigrated = 0
    channels.forEach(channel => {
        const count = migrateExistingVideos(channel.slug)
        totalMigrated += count
    })

    Log(tag, `Migration complete! ${totalMigrated} videos marked as transcoded`)
}

module.exports = {
    migrateExistingVideos,
    migrateAll
}
