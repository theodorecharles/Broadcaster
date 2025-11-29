const Log = require('./Log.js')
const tag = 'ChannelPool'

module.exports = () => {
  return pool
}

class ChannelPool {

  constructor() {
    this.queue = []
    Log(tag, 'Channel Pool created.')
  }

  addChannel(channel) {
    this.queue.push(channel)
    Log(tag, 'Added to channel pool.', channel)
  }

  startBroadcast() {
    this.queue.forEach((channel) => {
      channel.start()
    })
  }

}

var pool = new ChannelPool()