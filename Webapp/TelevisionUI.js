const express = require('express')
const bodyParser = require('body-parser')
const Log = require('../Utilities/Log.js')
const tag = 'TelevisionUI'
const compression = require('compression')

const { WEB_UI_PORT, 
        MANIFEST_UPCOMING_COUNT, 
        M3U8_MAX_AGE,
        CACHE_DIR } = process.env
        
const Bash = require('child_process').execSync
const fs = require('fs')
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
    
    Bash(`cp -r ${__dirname}/static ${CACHE_DIR}/broadcaster/channels/\n` +
         `cp ${__dirname}/index.html ${CACHE_DIR}/broadcaster/\n` +
         `cp ${__dirname}/favicon.ico ${CACHE_DIR}/broadcaster/\n` +
         `cp ${__dirname}/static.gif ${CACHE_DIR}/broadcaster/ &`)

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
