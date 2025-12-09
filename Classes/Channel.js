const Format = require('../Utilities/FormatValidator.js')
const { PlaylistManager } = require('./PlaylistManager.js')
const Log = require('../Utilities/Log.js')
const Database = require('../Utilities/Database.js')
const crypto = require('crypto')
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

// Fisher-Yates shuffle for uniform randomization
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

// Path to cache file for channel queues
function getQueueCachePath() {
  return path.join(CACHE_DIR, 'queue-cache.json')
}

// Load cached queues if channels.json hasn't changed
function loadQueueCache(channelsJsonHash) {
  try {
    const cachePath = getQueueCachePath()
    if (!fs.existsSync(cachePath)) return null

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (cache.channelsHash !== channelsJsonHash) {
      Log(tag, 'channels.json changed, will rescan filesystem')
      return null
    }

    Log(tag, 'Using cached queue data (channels.json unchanged)')
    return cache.queues
  } catch (e) {
    Log(tag, `Could not load queue cache: ${e.message}`)
    return null
  }
}

// Save queue cache with channels.json hash
function saveQueueCache(channelsJsonHash, queues) {
  try {
    const cachePath = getQueueCachePath()
    const cacheDir = path.dirname(cachePath)
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    fs.writeFileSync(cachePath, JSON.stringify({
      channelsHash: channelsJsonHash,
      queues: queues,
      savedAt: Date.now()
    }, null, 2))
  } catch (e) {
    Log(tag, `Could not save queue cache: ${e.message}`)
  }
}

// Compute hash of channels.json content
function hashChannelsJson(channelsPath) {
  try {
    const content = fs.readFileSync(channelsPath, 'utf8')
    return crypto.createHash('md5').update(content).digest('hex')
  } catch (e) {
    return null
  }
}

// Module-level cache for queue loading
let queueCacheLoaded = false
let queueCacheData = null
let channelsHash = null

// Initialize queue cache - call this once before creating channels
function initQueueCache(channelsPath) {
  if (queueCacheLoaded) return

  channelsHash = hashChannelsJson(channelsPath)
  if (channelsHash) {
    queueCacheData = loadQueueCache(channelsHash)
  }
  queueCacheLoaded = true
}

// Save all channel queues to cache - call after all channels are created
function saveAllQueues(channels) {
  if (!channelsHash) return

  const queues = {}
  channels.forEach(channel => {
    queues[channel.slug] = channel.queue
  })
  saveQueueCache(channelsHash, queues)
  Log(tag, `Saved queue cache for ${channels.length} channels`)
}

// Reset the cache state (for reloads)
function resetQueueCache() {
  queueCacheLoaded = false
  queueCacheData = null
  channelsHash = null
}

function Channel(definition) {

  this.type = definition.type
  this.name = definition.name
  this.slug = definition.slug
  this.paths = definition.paths
  this.queue = []
  this.playlistManager = null
  this.startTime = null
  this.started = false

  // Check if we have cached queue data for this channel
  if (queueCacheData && queueCacheData[this.slug]) {
    this.queue = queueCacheData[this.slug]
    Log(tag, `Loaded ${this.queue.length} files from cache`, this)
    // Queue cache exists - order is preserved, guide will match
  } else {
    // No cache - scan filesystem
    Log(tag, `Scanning filesystem...`, this)

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
    })

    // No queue cache means we need to shuffle (for shuffle channels)
    // Any existing guide is now invalid since queue order changed
    if (definition.type == 'shuffle') {
      shuffleArray(this.queue)
    }
  }

  // Register channel and videos in database
  const db = Database()
  const channelId = db.upsertChannel(this.slug, this.name, this.type)

  // Add all videos to database
  let addedCount = 0
  this.queue.forEach(filePath => {
    const hash = crypto.createHash('md5').update(filePath).digest('hex')
    const filename = path.basename(filePath, path.extname(filePath))
    const result = db.insertVideo(channelId, filePath, hash, filename)
    if (result.changes > 0) {
      addedCount++
    }
  })

  // Clean up videos that are no longer in the queue
  const deletedHashes = db.deleteRemovedVideos(this.slug, this.queue)
  if (deletedHashes.length > 0) {
    Log(tag, `Removed ${deletedHashes.length} videos from database that are no longer in queue`, this)
  }

  if (addedCount > 0) {
    Log(tag, `Added ${addedCount} new videos to database`, this)
  }

  // Initialize playlist manager
  this.playlistManager = new PlaylistManager(this)

  // Pre-warm the video list cache (lightweight metadata only, not all segments)
  this.playlistManager.cachedVideoList = this.playlistManager.buildVideoList()

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
  Channel: Channel,
  initQueueCache: initQueueCache,
  saveAllQueues: saveAllQueues,
  resetQueueCache: resetQueueCache
}
