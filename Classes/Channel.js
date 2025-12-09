const Format = require('../Utilities/FormatValidator.js')
const { PlaylistManager } = require('./PlaylistManager.js')
const { GuideGenerator } = require('../Utilities/GuideGenerator.js')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
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

  this.type = definition.type
  this.name = definition.name
  this.slug = definition.slug
  this.paths = definition.paths
  this.started = false

  // Scan filesystem for videos
  Log(tag, `Scanning filesystem...`, this)
  const allFiles = []

  definition.paths.forEach(dirPath => {
    let count = 0
    const files = findFiles(dirPath)

    files.forEach(file => {
      if (Format.isSupported(file)) {
        allFiles.push(file)
        count++
      }
    })
    Log(tag, `Found ${count} supported files in ${dirPath}`, this)
  })

  // Register channel and videos in database
  const db = Database()
  const channelId = db.upsertChannel(this.slug, this.name, this.type)

  // Add all videos to database
  let addedCount = 0
  allFiles.forEach(filePath => {
    const hash = crypto.createHash('md5').update(filePath).digest('hex')
    const filename = path.basename(filePath, path.extname(filePath))
    const result = db.insertVideo(channelId, filePath, hash, filename)
    if (result.changes > 0) {
      addedCount++
    }
  })

  // Clean up videos that are no longer on disk
  const deletedHashes = db.deleteRemovedVideos(this.slug, allFiles)
  if (deletedHashes.length > 0) {
    Log(tag, `Removed ${deletedHashes.length} videos from database that are no longer on disk`, this)
  }

  if (addedCount > 0) {
    Log(tag, `Added ${addedCount} new videos to database`, this)
  }

  // Initialize guide generator (handles schedule creation)
  this.guideGenerator = new GuideGenerator(this)

  // Initialize playlist manager (serves HLS playlists based on guide)
  this.playlistManager = new PlaylistManager(this)
  this.playlistManager.setGuideGenerator(this.guideGenerator)

  // Start method
  this.start = () => {
    this.started = true
    // Ensure guide exists for today (will load from history or generate new)
    this.guideGenerator.ensureGuideExists()
    this.playlistManager.start()
    Log(tag, 'Channel started', this)
  }

  // Get current playlist (delegates to PlaylistManager which uses GuideGenerator)
  this.getPlaylist = () => {
    if (!this.started) return null
    return this.playlistManager.createRollingPlaylist()
  }

  Log(tag, `Finished initializing ${definition.type} channel "${definition.name}" with ${allFiles.length} supported videos.`, this)

}

module.exports = {
  Channel: Channel
}
