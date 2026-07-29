const express = require('express')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const { getPrevious3am } = require('../Utilities/GuideGenerator.js')
const tag = 'TelevisionUI'
const compression = require('compression')

const { WEB_UI_PORT,
        M3U8_MAX_AGE,
        CACHE_DIR } = process.env

const fs = require('fs')
const path = require('path')
const ChannelPool = require('../Utilities/ChannelPool.js')

var ui = null

let guideRegenerationTimer = null

// Calculate milliseconds until next 3am
function msUntilNext3am() {
    const now = new Date()
    const next3am = new Date(now)
    next3am.setHours(3, 0, 0, 0)
    if (next3am <= now) {
        next3am.setDate(next3am.getDate() + 1)
    }
    return next3am.getTime() - now.getTime()
}

// Generate new guides for all channels at 3am
function regenerateAllGuides() {
    Log(tag, 'Regenerating guides for all channels (3am)')

    ChannelPool().queue.forEach(channel => {
        if (channel.started && channel.guideGenerator) {
            const dayStart = getPrevious3am()
            channel.guideGenerator.generateDailyGuide(dayStart)
        }
    })

    Log(tag, 'Guide regeneration complete')
}

// Schedule daily guide regeneration at 3am
function scheduleDaily3amRegeneration() {
    if (guideRegenerationTimer) {
        clearTimeout(guideRegenerationTimer)
    }

    const msUntil3am = msUntilNext3am()
    const hoursUntil = (msUntil3am / (1000 * 60 * 60)).toFixed(1)
    Log(tag, `Next guide regeneration scheduled in ${hoursUntil} hours (at 3am)`)

    guideRegenerationTimer = setTimeout(() => {
        regenerateAllGuides()
        scheduleDaily3amRegeneration()
    }, msUntil3am)
}

// Client-facing payloads must never include absolute host filesystem paths.
function buildDebugVideoPayload(videoInfo) {
    if (!videoInfo) return null
    return {
        transcoded: videoInfo.transcoded === 1,
        duration: videoInfo.duration_seconds,
        segmentCount: videoInfo.segment_count
    }
}

function buildManifestEntryPayload(info) {
    return {
        filename: info.filename,
        addedAt: info.addedAt ? new Date(info.addedAt).toISOString() : null
    }
}

// Build combined guide from all channels for API response
function buildCombinedGuide() {
    const guide = {
        dayStart: null,
        channels: {}
    }

    ChannelPool().queue.forEach(channel => {
        if (channel.started && channel.guideGenerator) {
            const channelGuide = channel.guideGenerator.getActiveGuide()
            if (channelGuide && channelGuide.schedule && channelGuide.schedule.length > 0) {
                if (!guide.dayStart) {
                    guide.dayStart = channelGuide.dayStart
                }
                guide.channels[channel.slug] = {
                    name: channel.name,
                    slug: channel.slug,
                    schedule: channel.guideGenerator.getScheduleForAPI()
                }
            }
        }
    })

    return guide
}

class TelevisionUI {

  constructor(app, port) {
    this.app = express()
    this.port = WEB_UI_PORT
  }

  start(channelPool) {

    // Create directories and copy static files
    const channelsDir = path.join(CACHE_DIR, 'channels')

    fs.mkdirSync(channelsDir, { recursive: true })

    // Copy static directories (16:9 and 4:3 versions)
    fs.cpSync(path.join(__dirname, 'static'), path.join(channelsDir, 'static'), { recursive: true })
    fs.cpSync(path.join(__dirname, 'static-4x3'), path.join(channelsDir, 'static-4x3'), { recursive: true })

    // Copy built React app (dist folder)
    fs.cpSync(path.join(__dirname, 'dist'), CACHE_DIR, { recursive: true, force: true })

    // Copy static.gif
    fs.copyFileSync(path.join(__dirname, 'static.gif'), path.join(CACHE_DIR, 'static.gif'))

    // Report background startup failures without taking down the web UI
    this.app.get('/healthz', function(req, res) {
        const startup = channelPool.getStartupStatus()
        const degraded = startup.state === 'degraded'

        res.status(degraded ? 503 : 200).json({
            ok: !degraded,
            service: 'broadcaster',
            timestamp: new Date().toISOString(),
            deploy_id: process.env.DEPLOY_ID || null,
            status: startup.state
        })
    })

    // Serve static files with no-cache for .ts segments
    this.app.use(express.static(CACHE_DIR, {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.ts')) {
                res.set('Cache-Control', 'no-store')
            }
        }
    }))
    this.app.use(compression())

    // Dynamic manifest - always reflects current channelPool state
    this.app.get(`/manifest.json`, function(req, res) {
        const manifest = {
          channels: [],
          upcoming: []
        }

        const db = Database()

        ChannelPool().queue.forEach(channel => {
          if (channel.started) {
            const stats = db.getChannelStats(channel.slug)
            if (stats && stats.transcoded > 0) {
              manifest.channels.push({
                name: channel.name,
                slug: channel.slug
              })
            }
          }
        })
        res.send(JSON.stringify(manifest))
    })

    // Database stats endpoint
    this.app.get(`/api/db-stats`, function(req, res) {
        const db = Database()
        const channels = db.getAllChannels()
        const stats = channels.map(channel => {
            const channelStats = db.getChannelStats(channel.slug)
            return {
                name: channel.name,
                slug: channel.slug,
                totalVideos: channelStats.total,
                transcodedVideos: channelStats.transcoded,
                pendingVideos: channelStats.total - channelStats.transcoded,
                percentComplete: channelStats.total > 0
                    ? Math.round((channelStats.transcoded / channelStats.total) * 100)
                    : 0
            }
        })
        res.json({
            channels: stats,
            totals: {
                totalVideos: stats.reduce((sum, s) => sum + s.totalVideos, 0),
                transcodedVideos: stats.reduce((sum, s) => sum + s.transcodedVideos, 0),
                pendingVideos: stats.reduce((sum, s) => sum + s.pendingVideos, 0)
            }
        })
    })

    // Debug endpoint to check current playback state
    this.app.get(`/:slug/debug`, function(req, res) {
        const slug = req.params.slug
        const channel = ChannelPool().queue.find(c => c.slug === slug)
        if (!channel) {
            res.json({ error: 'Channel not found' })
            return
        }

        if (!channel.guideGenerator) {
            res.json({ error: 'Guide generator not initialized' })
            return
        }

        const now = Date.now()
        const guide = channel.guideGenerator.getActiveGuide()
        const currentEntry = channel.guideGenerator.findEntryAtTime(now)

        // Get video info from database if we have a current entry
        let videoInfo = null
        if (currentEntry) {
            const db = Database()
            videoInfo = db.getVideoByHash(slug, currentEntry.hash)
        }

        res.json({
            channelName: channel.name,
            serverTime: new Date().toISOString(),
            guideInfo: guide ? {
                dayStart: new Date(guide.dayStart).toISOString(),
                scheduleLength: guide.schedule?.length || 0,
                generatedAt: guide.generatedAt ? new Date(guide.generatedAt).toISOString() : null
            } : null,
            currentEntry: currentEntry ? {
                title: currentEntry.title,
                hash: currentEntry.hash,
                startTime: new Date(currentEntry.startTime).toISOString(),
                endTime: new Date(currentEntry.endTime).toISOString(),
                offsetInVideo: Math.round((now - currentEntry.startTime) / 1000),
                duration: currentEntry.duration
            } : null,
            videoInDatabase: buildDebugVideoPayload(videoInfo)
        })
    })

    // Schedule daily 3am regeneration
    scheduleDaily3amRegeneration()

    // TV Guide API - builds guide from all channel GuideGenerators
    this.app.get(`/api/guide`, function(req, res) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
        res.set('Pragma', 'no-cache')

        const guide = buildCombinedGuide()
        res.json(guide)
    })

    // Single channel schedule
    this.app.get(`/:slug/schedule`, function(req, res) {
        const slug = req.params.slug
        const channel = ChannelPool().queue.find(c => c.slug === slug)

        if (!channel) {
            res.json({ error: 'Channel not found' })
            return
        }

        if (!channel.started || !channel.guideGenerator) {
            res.json({ error: 'Channel not started' })
            return
        }

        const guide = channel.guideGenerator.getActiveGuide()

        res.json({
            name: channel.name,
            slug: channel.slug,
            dayStart: guide ? guide.dayStart : null,
            schedule: channel.guideGenerator.getScheduleForAPI()
        })
    })

    // Manifest endpoint - shows hash to filename mapping for debugging
    this.app.get(`/:slug/manifest`, function(req, res) {
        const slug = req.params.slug
        const manifestPath = path.join(CACHE_DIR, 'channels', slug, 'manifest.json')

        if (!fs.existsSync(manifestPath)) {
            res.json({ error: 'Manifest not found' })
            return
        }

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            const result = {}
            for (const [hash, info] of Object.entries(manifest)) {
                result[hash] = buildManifestEntryPayload(info)
            }
            res.json(result)
        } catch (e) {
            res.json({ error: 'Failed to read manifest: ' + e.message })
        }
    })

    // Dynamic channel routes - matches any *.m3u8 and looks up channel by slug
    this.app.get(`/:slug.m3u8`, function(req, res) {
        const slug = req.params.slug
        const channel = ChannelPool().queue.find(c => c.slug === slug)

        if (!channel) {
            res.statusCode = 404
            res.send('Channel not found')
            return
        }

        if (channel.started) {
            try {
                const playlist = channel.getPlaylist()

                if (!playlist) {
                    res.statusCode = 500
                    res.send('Playlist not available')
                    return
                }

                res.set({
                    'Content-Type': 'application/x-mpegURL',
                    'Cache-Control': `max-age=${M3U8_MAX_AGE}`,
                    'Strict-Transport-Security': `max-age=${Date.now() + M3U8_MAX_AGE*1000}; includeSubDomains; preload`
                })
                res.send(playlist)

            } catch(e) {
                Log(tag, `Couldn't return m3u8:\n` + e, channel)
                res.statusCode = 500
                res.send('')
            }
        } else {
            res.statusCode = 500
            res.send('Broadcaster HLS channel not started yet.')
        }
    })

    this.app.listen(WEB_UI_PORT, async () => {
        Log(tag, `Webapp is live at http://localhost:${WEB_UI_PORT}`)
    })

  }

}

module.exports = () => {
  return ui ? ui : ui = new TelevisionUI()
}

// Export for external use
module.exports.regenerateAllGuides = regenerateAllGuides
module.exports.buildDebugVideoPayload = buildDebugVideoPayload
module.exports.buildManifestEntryPayload = buildManifestEntryPayload
