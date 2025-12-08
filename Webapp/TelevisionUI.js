const express = require('express')
const bodyParser = require('body-parser')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const tag = 'TelevisionUI'
const compression = require('compression')

const { WEB_UI_PORT,
        MANIFEST_UPCOMING_COUNT,
        M3U8_MAX_AGE,
        CACHE_DIR } = process.env

const fs = require('fs')
const path = require('path')
const ChannelPool = require('../Utilities/ChannelPool.js')

// express app that listens on specified port and handles GET requests for .m3u8 files
// Guide cache is regenerated once on startup and daily at 3am

var ui = null

// Guide cache - pre-generated and refreshed at 3am daily
let guideCache = null
let guideRegenerationTimer = null

// Function to regenerate guide cache (non-blocking)
function regenerateGuideCache() {
    // Use setImmediate to avoid blocking the event loop during HTTP requests
    setImmediate(() => {
        regenerateGuideCacheSync()
    })
}

// Save guide to history folder for analysis
function saveGuideToHistory(guide) {
    const historyDir = path.join(CACHE_DIR, 'history')
    fs.mkdirSync(historyDir, { recursive: true })

    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '-')
    const filename = `guide-${timestamp}.json`
    const filePath = path.join(historyDir, filename)

    fs.writeFileSync(filePath, JSON.stringify(guide, null, 2))
    Log('TelevisionUI', `Guide saved to history: ${filename}`)
}

// Load most recent guide from history if it's from the current day period (3am-3am)
function loadGuideFromHistory() {
    const historyDir = path.join(CACHE_DIR, 'history')

    if (!fs.existsSync(historyDir)) {
        return null
    }

    try {
        const files = fs.readdirSync(historyDir)
            .filter(f => f.startsWith('guide-') && f.endsWith('.json'))
            .sort()
            .reverse()

        if (files.length === 0) {
            return null
        }

        // Load most recent guide
        const latestFile = files[0]
        const filePath = path.join(historyDir, latestFile)
        const guide = JSON.parse(fs.readFileSync(filePath, 'utf8'))

        // Check if guide is from current day period (3am to 3am)
        // dayStart in guide should match current day's 3am boundary
        const now = new Date()
        const today3am = new Date(now)
        today3am.setHours(3, 0, 0, 0)
        if (now.getHours() < 3) {
            today3am.setDate(today3am.getDate() - 1)
        }

        if (guide.dayStart && guide.dayStart === today3am.getTime()) {
            Log('TelevisionUI', `Loaded guide from history: ${latestFile}`)
            return guide
        }

        Log('TelevisionUI', `Guide in history is from different day, will regenerate`)
        return null
    } catch (err) {
        Log('TelevisionUI', `Error loading guide from history: ${err.message}`)
        return null
    }
}

// Synchronous guide cache regeneration (called via setImmediate)
function regenerateGuideCacheSync() {
    const guide = {
        dayStart: null,
        channels: {}
    }

    ChannelPool().queue.forEach(channel => {
        if (channel.started && channel.playlistManager) {
            // Only include channels that have at least one transcoded video
            const schedule = channel.playlistManager.getSchedule()
            if (schedule.length === 0) {
                return // Skip channels with no content
            }

            if (!guide.dayStart) {
                guide.dayStart = channel.playlistManager.getDayStart()
            }
            guide.channels[channel.slug] = {
                name: channel.name,
                slug: channel.slug,
                schedule: schedule
            }
        }
    })

    guideCache = guide
    Log('TelevisionUI', `Guide cache regenerated with ${Object.keys(guide.channels).length} channels`)

    // Save to history for analysis
    if (Object.keys(guide.channels).length > 0) {
        saveGuideToHistory(guide)
    }
}

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

// Schedule daily guide regeneration at 3am
function scheduleDaily3amRegeneration() {
    if (guideRegenerationTimer) {
        clearTimeout(guideRegenerationTimer)
    }

    const msUntil3am = msUntilNext3am()
    const hoursUntil = (msUntil3am / (1000 * 60 * 60)).toFixed(1)
    Log('TelevisionUI', `Next guide regeneration scheduled in ${hoursUntil} hours (at 3am)`)

    guideRegenerationTimer = setTimeout(() => {
        regenerateGuideCache()
        // Schedule the next one
        scheduleDaily3amRegeneration()
    }, msUntil3am)
}

class TelevisionUI {

  constructor(app,port) {
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

    // Serve static files with no-cache for .ts segments
    this.app.use(express.static(CACHE_DIR, {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.ts')) {
                // Don't cache video segments in browser
                res.set('Cache-Control', 'no-store')
            }
        }
    }))
    this.app.use(compression())

    // Dynamic manifest - always reflects current channelPool state
    // Only includes channels that have at least one transcoded video
    // OPTIMIZED: Uses database query instead of generating master playlist
    this.app.get(`/manifest.json`, function(req,res){
        var manifest = {
          channels: [],
          upcoming: []
        }

        const db = Database()

        ChannelPool().queue.forEach(channel => {
          if (channel.started) {
            // Fast database query to check if channel has transcoded videos
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
    this.app.get(`/api/db-stats`, function(req,res){
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

    // Debug endpoint to check playlist stats and current playback
    this.app.get(`/:slug/debug`, function(req,res){
        const slug = req.params.slug
        const channel = ChannelPool().queue.find(c => c.slug === slug)
        if (!channel) {
            res.json({ error: 'Channel not found' })
            return
        }

        // Use cached video list (lightweight)
        const videoList = channel.playlistManager.cachedVideoList || channel.playlistManager.buildVideoList()
        const { videos, totalDuration } = videoList

        const offset = channel.playlistManager.getCurrentOffset()
        const normalizedOffset = totalDuration > 0 ? offset % totalDuration : 0

        // Find current video based on offset
        let currentVideo = null
        for (const video of videos) {
            if (video.startTime + video.duration > normalizedOffset) {
                currentVideo = video
                break
            }
        }

        const currentVideoPath = currentVideo ? channel.queue[currentVideo.videoIndex] : null
        const currentVideoName = currentVideoPath ? channel.playlistManager.getVideoDisplayName(currentVideoPath) : null
        const currentVideoHash = currentVideo ? currentVideo.hash : null

        // Try to read the metadata.json for the current video
        let transcodedFromPath = null
        if (currentVideoHash) {
            try {
                const metadataPath = path.join(CACHE_DIR, 'channels', slug, 'videos', currentVideoHash, 'metadata.json')
                if (fs.existsSync(metadataPath)) {
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
                    transcodedFromPath = metadata.originalPath
                }
            } catch (e) {
                transcodedFromPath = 'Error reading metadata: ' + e.message
            }
        }

        // Get schedule's "current" show
        const schedule = channel.playlistManager.getSchedule()
        const now = Date.now()
        const currentShow = schedule.find(s => s.startTime <= now && s.endTime > now)

        res.json({
            channelName: channel.name,
            serverTime: new Date().toISOString(),
            channelStartTime: new Date(channel.startTime).toISOString(),
            currentOffset: Math.round(offset),
            normalizedOffset: Math.round(normalizedOffset),
            totalDuration: Math.round(totalDuration),
            queueLength: channel.queue.length,
            transcodedVideos: videos.length,
            playlistSays: {
                videoIndex: currentVideo?.videoIndex,
                videoName: currentVideoName,
                videoPath: currentVideoPath,
                videoHash: currentVideoHash,
                transcodedFromPath: transcodedFromPath
            },
            scheduleSays: currentShow ? {
                title: currentShow.title,
                startTime: new Date(currentShow.startTime).toISOString(),
                endTime: new Date(currentShow.endTime).toISOString()
            } : null,
            pathMismatch: transcodedFromPath && currentVideoPath && transcodedFromPath !== currentVideoPath
        })
    })

    // Try to load guide from history first, only regenerate if needed
    const cachedGuide = loadGuideFromHistory()
    if (cachedGuide) {
        guideCache = cachedGuide
        Log('TelevisionUI', `Using cached guide with ${Object.keys(cachedGuide.channels).length} channels`)
    } else {
        // No valid cached guide, regenerate after channels start
        setTimeout(() => {
            regenerateGuideCache()
        }, 2000)
    }
    scheduleDaily3amRegeneration()

    // TV Guide API - returns pre-cached guide instantly
    this.app.get(`/api/guide`, function(req,res){
        // Prevent browser caching - guide changes on server restart
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
        res.set('Pragma', 'no-cache')

        if (!guideCache) {
            // Fallback: generate on first request if cache not ready
            regenerateGuideCache()
        }

        // Filter out any channels with empty schedules before sending
        const filteredGuide = {
            dayStart: guideCache.dayStart,
            channels: {}
        }
        for (const [slug, channel] of Object.entries(guideCache.channels)) {
            if (channel.schedule && channel.schedule.length > 0) {
                filteredGuide.channels[slug] = channel
            }
        }
        res.json(filteredGuide)
    })

    // Single channel schedule
    this.app.get(`/:slug/schedule`, function(req,res){
        const slug = req.params.slug
        const channel = ChannelPool().queue.find(c => c.slug === slug)

        if (!channel) {
            res.json({ error: 'Channel not found' })
            return
        }

        if (!channel.started || !channel.playlistManager) {
            res.json({ error: 'Channel not started' })
            return
        }

        res.json({
            name: channel.name,
            slug: channel.slug,
            dayStart: channel.playlistManager.getDayStart(),
            schedule: channel.playlistManager.getSchedule()
        })
    })

    // Manifest endpoint - shows hash to filename mapping for debugging
    this.app.get(`/:slug/manifest`, function(req,res){
        const slug = req.params.slug
        const manifestPath = path.join(CACHE_DIR, 'channels', slug, 'manifest.json')

        if (!fs.existsSync(manifestPath)) {
            res.json({ error: 'Manifest not found' })
            return
        }

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            // Return manifest with hash as key and readable info
            const result = {}
            for (const [hash, info] of Object.entries(manifest)) {
                result[hash] = {
                    filename: info.filename,
                    originalPath: info.originalPath,
                    addedAt: info.addedAt ? new Date(info.addedAt).toISOString() : null
                }
            }
            res.json(result)
        } catch (e) {
            res.json({ error: 'Failed to read manifest: ' + e.message })
        }
    })

    // Dynamic channel routes - matches any *.m3u8 and looks up channel by slug
    this.app.get(`/:slug.m3u8`, function(req,res){
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
                    'Cache-Control': `min-fresh=${M3U8_MAX_AGE}`,
                    'Strict-Transport-Security': `max-age=${Date.now() + M3U8_MAX_AGE*1000}; includeSubDomains;  preload`
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

// Export guide cache regeneration for use by PreGenerator
module.exports.regenerateGuideCache = regenerateGuideCache
