require('dotenv').config({ path: `./config.txt` })
const ChannelPool = require('./Utilities/ChannelPool.js')
const { Channel, initQueueCache, saveAllQueues } = require('./Classes/Channel.js')
const PreGenerator = require('./Utilities/PreGenerator.js')
const { migrateAll, backfillDurations } = require('./Utilities/MigrateDatabase.js')
const Log = require('./Utilities/Log.js')
const tag = "Main"
const fs = require('fs')
const path = require('path')
const TelevisionUI = require('./Webapp/TelevisionUI.js')
const { CACHE_DIR, CHANNEL_LIST } = process.env

// Support both absolute paths (/data/channels.json) and relative paths (./channels.json)
const channelsPath = CHANNEL_LIST.startsWith('/') ? CHANNEL_LIST : `.${CHANNEL_LIST}`

let uiStarted = false

const cleanup = () => {
  Log(tag, 'Cleaning up ...')
  Log(tag, 'Bye now.')
}

process.on('SIGINT', _ => {
  cleanup()
  process.exit(0)
})

// Load and parse channels.json
function loadChannels() {
  try {
    if (!fs.existsSync(channelsPath)) {
      Log(tag, `No channels.json found at ${channelsPath}, creating default...`)
      const defaultChannels = [
        {
          "type": "shuffle",
          "name": "Example Channel",
          "slug": "example",
          "paths": [
            "/media"
          ]
        }
      ]
      fs.mkdirSync(path.dirname(channelsPath), { recursive: true })
      fs.writeFileSync(channelsPath, JSON.stringify(defaultChannels, null, 2))
      Log(tag, `Created default channels.json. Edit ${CHANNEL_LIST} to configure your channels.`)
    }

    const data = fs.readFileSync(channelsPath)
    const channels = JSON.parse(data)
    Log(tag, `Found ${channels.length} channel definition${channels.length > 1 ? 's' : ''}:`)
    return channels
  } catch (e) {
    Log(tag, `Error loading channels.json: ${e}`)
    return []
  }
}

// Initialize channels from config
function initializeChannels(channelDefinitions, useCache = true) {
  try {
    // Initialize queue cache before creating channels
    if (useCache) {
      initQueueCache(channelsPath)
    }

    channelDefinitions.forEach(definition => {
      const channel = new Channel(definition)
      ChannelPool().addChannel(channel)
    })

    // Save queue cache after all channels are created (if we scanned filesystem)
    if (useCache) {
      saveAllQueues(ChannelPool().queue)
    }
  } catch (e) {
    Log(tag, 'Unable to create channels: ' + e)
  }
}

// Startup sequence
async function startup() {
  // Load initial channels
  const channelDefinitions = loadChannels()
  initializeChannels(channelDefinitions)

  // Start UI immediately - don't block on migration!
  try {
    TelevisionUI().start(ChannelPool())
    uiStarted = true
    Log(tag, 'Web UI started and ready')
  } catch (e) {
    Log(tag, 'Unable to start the TV UI: ' + e)
  }

  // Run migration in background (don't await)
  Log(tag, 'Migrating existing transcoded videos to database (background)...')
  setImmediate(async () => {
    migrateAll()
    backfillDurations()

    // After migration, queue channels asynchronously (don't block event loop!)
    Log(tag, 'Checking for pre-generated HLS streams...')

    // Queue channels one at a time with setImmediate between each
    // This allows the event loop to process web requests between channels
    for (const channel of ChannelPool().queue) {
      await new Promise(resolve => setImmediate(() => {
        PreGenerator.queueChannel(channel)
        resolve()
      }))
    }

    // Start broadcast immediately - channels will play whatever content is ready
    // Guide and playlist automatically exclude videos that aren't transcoded yet
    ChannelPool().startBroadcast()
    Log(tag, 'Broadcast started - transcoding continues in background')

    // Generate remaining streams in background
    PreGenerator.startGeneration().then(() => {
      Log(tag, 'All HLS streams ready!')
    }).catch(e => {
      Log(tag, 'Error during pre-generation: ' + e)
    })
  })
}

startup()
