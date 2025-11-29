require('dotenv').config({ path: `./config.txt` })
const ChannelPool = require('./Utilities/ChannelPool.js')
const { Channel } = require('./Classes/Channel.js')
const PreGenerator = require('./Utilities/PreGenerator.js')
const Bash = require('child_process').execSync
const Log = require('./Utilities/Log.js')
const tag = "Main"
const fs = require('fs')
const TelevisionUI = require('./Webapp/TelevisionUI.js')
const { CACHE_DIR, CHANNEL_LIST } = process.env

const cleanup = () => {
  Log(tag, 'Cleaning up ...')
  try {
    Bash('rm -r ./Webapp/channels/* 2> /dev/null &')
  } catch (e) {
    Log(tag, 'Bash emitted an error: ' + e)
  }
  Log(tag, 'Bye now.')
}

process.on('SIGINT', _ => {
  cleanup()
  process.exit(0)
})

try {
  require('dotenv').config({ path: `./config.txt` })
  var channels = fs.readFileSync(`.${CHANNEL_LIST}`)
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
