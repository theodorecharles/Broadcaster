require('dotenv').config({ path: `./config.txt` })
const ChannelPool = require('./Utilities/ChannelPool.js')
const { Channel } = require('./Classes/Channel.js')
const PreGenerator = require('./Utilities/PreGenerator.js')
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
function initializeChannels(channelDefinitions) {
  try {
    channelDefinitions.forEach(definition => {
      const channel = new Channel(definition)
      ChannelPool().addChannel(channel)
    })
  } catch (e) {
    Log(tag, 'Unable to create channels: ' + e)
  }
}

// Reload channels when channels.json changes
async function reloadChannels() {
  Log(tag, 'Reloading channels...')

  // Clear existing channels
  ChannelPool().clearChannels()

  // Reset PreGenerator queue
  PreGenerator.generationQueue = []
  PreGenerator.currentIndex = 0
  PreGenerator.totalVideos = 0

  // Load and initialize new channels
  const channelDefinitions = loadChannels()
  initializeChannels(channelDefinitions)

  // Queue and generate any missing streams (runs in background)
  ChannelPool().queue.forEach(channel => {
    PreGenerator.queueChannel(channel)
  })

  // Start generation in background - don't await
  PreGenerator.startGeneration().then(() => {
    Log(tag, 'All HLS streams ready after reload!')
  })

  // Start broadcasting on channels that have content ready
  ChannelPool().startBroadcast()

  Log(tag, 'Channels reloaded - pre-generation running in background')
}

// Watch channels.json for changes using polling (more reliable across systems)
function watchChannelsFile() {
  let lastMtime = null

  // Get initial mtime
  try {
    lastMtime = fs.statSync(channelsPath).mtimeMs
  } catch (e) {
    Log(tag, `Could not stat ${channelsPath}: ${e.message}`)
  }

  // Poll every 5 minutes
  setInterval(() => {
    try {
      const currentMtime = fs.statSync(channelsPath).mtimeMs
      if (lastMtime && currentMtime !== lastMtime) {
        Log(tag, 'channels.json changed, reloading...')
        lastMtime = currentMtime
        reloadChannels()
      } else if (!lastMtime) {
        lastMtime = currentMtime
      }
    } catch (e) {
      // File might be temporarily unavailable during write
    }
  }, 5 * 60 * 1000)

  Log(tag, `Watching ${channelsPath} for changes (polling every 5 minutes)`)
}

// Startup sequence
async function startup() {
  // Load initial channels
  const channelDefinitions = loadChannels()
  initializeChannels(channelDefinitions)

  // Start UI immediately (before pre-generation)
  try {
    TelevisionUI().start(ChannelPool())
    uiStarted = true
    Log(tag, 'Web UI started')
  } catch (e) {
    Log(tag, 'Unable to start the TV UI: ' + e)
  }

  // Start watching for channel config changes
  watchChannelsFile()

  // Start broadcast (channels will show as available once they have content)
  try {
    ChannelPool().startBroadcast()
  } catch (e) {
    Log(tag, 'Unable to start the broadcast: ' + e)
  }

  // Queue all channels for generation
  try {
    Log(tag, 'Checking for pre-generated HLS streams...')

    ChannelPool().queue.forEach(channel => {
      PreGenerator.queueChannel(channel)
    })

    // Generate any missing streams (runs in background, UI is already up)
    await PreGenerator.startGeneration()

    Log(tag, 'All HLS streams ready!')

  } catch (e) {
    Log(tag, 'Error during pre-generation: ' + e)
  }
}

startup()
