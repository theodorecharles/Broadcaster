const Format = require('../Utilities/FormatValidator.js')
const { PlaylistManager } = require('./PlaylistManager.js')
const Log = require('../Utilities/Log.js')
const fs = require('fs')
const path = require('path')
const { CACHE_DIR } = process.env
const tag = 'Channel'

// Recursively find all files in a directory
function findFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir)

  files.forEach(file => {
    const filePath = path.join(dir, file)
    if (fs.statSync(filePath).isDirectory()) {
      findFiles(filePath, fileList)
    } else {
      fileList.push(filePath)
    }
  })

  return fileList
}

function Channel(definition) {

  Log(tag, `Building the queue...`, definition)

  this.type = definition.type
  this.name = definition.name
  this.slug = definition.slug
  this.paths = definition.paths
  this.queue = []
  this.playlistManager = null
  this.startTime = null
  this.started = false

  definition.paths.forEach(dirPath => {

    var x = 0
    const files = findFiles(dirPath)

    files.forEach(file => {
      if (Format.isSupported(file)) {
        this.queue.push(file)
        x++
      }
    })
    Log(tag, `Found ${x} supported files in ${dirPath}`, this)

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
