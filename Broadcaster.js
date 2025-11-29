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

const cleanup = () => {
  Log(tag, 'Cleaning up ...')
  // Cleanup handled by process exit
  Log(tag, 'Bye now.')
}

process.on('SIGINT', _ => {
  cleanup()
  process.exit(0)
})

try {
  require('dotenv').config({ path: `./config.txt` })

  // Check if channels.json exists, create default if it doesn't
  const channelsPath = `.${CHANNEL_LIST}`
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

  var channels = fs.readFileSync(channelsPath)
} catch(e) {
  Log(tag, `Couldn't read the file you provided... ${e}`)
}

try {
  channels = JSON.parse(channels)
  Log(tag, `Found ${channels.length} channel definition${channels.length>1?'s':''}:`)
} catch(e) { 
  Log(tag, 'Unable to process channel list: ' + e) 
}

try {
  channels.forEach(definition => {
    const channel = new Channel(definition)
    ChannelPool().addChannel(channel)
  })
} catch (e) {
  Log(tag, 'Unable to create channels: ' + e)
}

// Pre-generate HLS streams
async function startup() {
  try {
    Log(tag, 'Checking for pre-generated HLS streams...')

    // Queue all channels for generation
    ChannelPool().queue.forEach(channel => {
      PreGenerator.queueChannel(channel)
    })

    // Generate any missing streams
    await PreGenerator.startGeneration()

    Log(tag, 'All HLS streams ready!')

  } catch (e) {
    Log(tag, 'Error during pre-generation: ' + e)
  }

  try {
    const ui = TelevisionUI().start(ChannelPool())
  } catch (e) {
    Log(tag, 'Unable to start the TV UI: ' + e)
  }

  try {
    ChannelPool().startBroadcast()
  } catch (e) {
    Log(tag, 'Unable to start the broadcast: ' + e)
  }
}

startup()
