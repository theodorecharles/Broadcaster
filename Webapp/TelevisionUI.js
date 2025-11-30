const express = require('express')
const bodyParser = require('body-parser')
const Log = require('../Utilities/Log.js')
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
// asynchronously 'caches the ffmpeg .m3u8 files every X seconds

var ui = null

// Guide cache - pre-generated and refreshed in background
let guideCache = null
const GUIDE_REFRESH_INTERVAL = 60 * 1000

// Function to regenerate guide cache
function regenerateGuideCache() {
    const guide = {
        dayStart: null,
        channels: {}
    }

    ChannelPool().queue.forEach(channel => {
        if (channel.started && channel.playlistManager) {
            if (!guide.dayStart) {
                guide.dayStart = channel.playlistManager.getDayStart()
            }
            guide.channels[channel.slug] = {
                name: channel.name,
                slug: channel.slug,
                schedule: channel.playlistManager.getSchedule()
            }
        }
    })

    guideCache = guide
    Log('TelevisionUI', `Guide cache regenerated with ${Object.keys(guide.channels).length} channels`)
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
    this.app.get(`/manifest.json`, function(req,res){
        var manifest = {
          channels: [],
          upcoming: []
        }

        ChannelPool().queue.forEach(channel => {
          if (channel.started) {
            manifest.channels.push({
              name: channel.name,
              slug: channel.slug
            })
          }
        })
        res.send(JSON.stringify(manifest))
    })

    // Debug endpoint to check playlist stats
    this.app.get(`/:slug/debug`, function(req,res){
        const slug = req.params.slug
        const channel = ChannelPool().queue.find(c => c.slug === slug)
        if (!channel) {
            res.json({ error: 'Channel not found' })
            return
        }
        const allSegments = channel.playlistManager.generateMasterPlaylist()
        const videoHashes = [...new Set(allSegments.map(s => s.path.split('/')[3]))]
        const offset = channel.playlistManager.getCurrentOffset()
        res.json({
            channelName: channel.name,
            queueLength: channel.queue.length,
            totalSegments: allSegments.length,
            uniqueVideos: videoHashes.length,
            currentOffset: offset,
            totalDuration: allSegments.length > 0 ? allSegments[allSegments.length - 1].timestamp : 0
        })
    })

    // Pre-generate guide cache and refresh every 60 seconds
    setTimeout(() => {
        regenerateGuideCache()
        setInterval(regenerateGuideCache, GUIDE_REFRESH_INTERVAL)
    }, 2000) // Wait 2 seconds for channels to be fully started

    // TV Guide API - returns pre-cached guide instantly
    this.app.get(`/api/guide`, function(req,res){
        if (guideCache) {
            res.json(guideCache)
        } else {
            // Fallback: generate on first request if cache not ready
            regenerateGuideCache()
            res.json(guideCache)
        }
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
        Log(tag, `Webapp is live at http://tv:${WEB_UI_PORT}`)
    })

  }

}

module.exports = () => {
  return ui ? ui : ui = new TelevisionUI()
}
