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

class TelevisionUI {

  constructor(app,port) {
    this.app = express()
    this.port = WEB_UI_PORT
  }

  start(channelPool) {

    // Create directories and copy static files
    const broadcasterDir = path.join(CACHE_DIR, 'broadcaster')
    const channelsDir = path.join(broadcasterDir, 'channels')

    fs.mkdirSync(channelsDir, { recursive: true })

    // Copy static directory
    fs.cpSync(path.join(__dirname, 'static'), path.join(channelsDir, 'static'), { recursive: true })

    // Copy built React app (dist folder)
    fs.cpSync(path.join(__dirname, 'dist'), broadcasterDir, { recursive: true, force: true })

    // Copy static.gif
    fs.copyFileSync(path.join(__dirname, 'static.gif'), path.join(broadcasterDir, 'static.gif'))

    this.app.use(express.static(`${CACHE_DIR}/broadcaster`))
    this.app.use(compression())
    this.app.get(`/manifest.json`, function(req,res){

        var manifest = {
          channels: [],
          upcoming: []
        }

        channelPool.queue.forEach(channel => {
          if (channel.started) {
            manifest.channels.push({
              name: channel.name,
              slug: channel.slug
            })
          }
        })
        res.send(JSON.stringify(manifest))

    })

    channelPool.queue.forEach((channel) => {

      this.app.get(`/${channel.slug}.m3u8`, function(req,res){

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

    })

    this.app.listen(WEB_UI_PORT, async () => {
        Log(tag, `Webapp is live at http://tv:${WEB_UI_PORT}`)
    })

  }

}

module.exports = () => {
  return ui ? ui : ui = new TelevisionUI()
}
