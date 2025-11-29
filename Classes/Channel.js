const Format = require('../Utilities/FormatValidator.js')
const Bash = require('child_process').execSync
const { PlaylistManager } = require('./PlaylistManager.js')
const Log = require('../Utilities/Log.js')
const fs = require('fs')
const { CACHE_DIR } = process.env
const tag = 'Channel'

function Channel(definition) {

  Log(tag, `Building the queue...`, definition)

  this.type = definition.type
  this.name = definition.name
  this.slug = definition.slug
  this.queue = []
  this.playlistManager = null
  this.startTime = null
  this.started = false

  definition.paths.forEach(path => {
    
    var x = 0
    Bash(`find "${path}" -type f`).toString().split('\n').forEach(file => {
      const array = file.split('.')
      const last = array.pop()
      if (Format.isSupported(file)) {
        this.queue.push(file)
        x++
      }
    })
    Log(tag, `Found ${x} supported files in ${path}`, this)

    if (definition.type == 'shuffle') this.queue.sort(() => Math.random() - 0.5)

  })

  // Initialize playlist manager
  this.playlistManager = new PlaylistManager(this)

  // Start method
  this.start = () => {
    this.started = true
    this.startTime = Date.now()
    this.playlistManager.start()
    Log(tag, 'Channel started', this)
  }

  // Get current playlist
  this.getPlaylist = () => {
    if (!this.started) return null
    const offset = (Date.now() - this.startTime) / 1000
    return this.playlistManager.createRollingPlaylist(offset)
  }

  Log(tag, `Finished initializing ${definition.type} channel "${definition.name}" with ${this.queue.length} supported videos.`, this)

}

module.exports = {
  Channel: Channel
}
