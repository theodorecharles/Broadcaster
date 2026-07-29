const { shipLogRecord } = require('./OrchLogShipper.js')

module.exports = async (tag, message, channel) => {
  const time = new Date().toUTCString()
  if (process.env.LOG_LEVEL == 'verbose') {
    channel != undefined ?
      console.log(`${time}: ${channel.name} - ${tag} - ${message}`)
      : console.log(`${time}: Info - ${tag} - ${message}`)
  }
  // Remote shipping is independent of console verbosity and is a no-op unless the
  // ingest URL + secret are present in the environment.
  shipLogRecord(tag, message, channel)
}
