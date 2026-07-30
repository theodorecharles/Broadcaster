const { shipLogRecord } = require('./OrchLogShipper.js')
const { isError, normalizeContext, formatContextForConsole } = require('./LogContext.js')

/**
 * Log(tag, message[, channel][, context])
 *
 * `context` is an optional object of structured fields — pass the caught error under `error` and any
 * key inputs (paths, hashes, ids) alongside it, plus `correlation_id` / `request_id` when the call
 * site has one. They ship as record fields and are appended to the verbose console line, so an ERROR
 * is triageable from the log alone. `Log(tag, message, err)` is accepted as shorthand: an Error in
 * the channel slot is treated as context. Plain objects in that slot are always the channel.
 *
 * Optional `context.level` (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) overrides message-based
 * level inference in the shipper. Use it for expected library problems (corrupt media) that should
 * not page as ERROR. `level` is envelope-only — it is stripped from shipped fields.
 */
module.exports = async (tag, message, channel, context) => {
  const time = new Date().toUTCString()
  if (context === undefined && isError(channel)) {
    context = channel
    channel = undefined
  }
  let explicitLevel
  if (context && typeof context === 'object' && !isError(context) && !Array.isArray(context)) {
    if (typeof context.level === 'string') explicitLevel = context.level
  }
  const normalized = normalizeContext(context)
  if (process.env.LOG_LEVEL == 'verbose') {
    const detail = formatContextForConsole(normalized)
    channel != undefined ?
      console.log(`${time}: ${channel.name} - ${tag} - ${message}${detail}`)
      : console.log(`${time}: Info - ${tag} - ${message}${detail}`)
  }
  // Remote shipping is independent of console verbosity and is a no-op unless the
  // ingest URL + secret are present in the environment.
  shipLogRecord(tag, message, channel, normalized, explicitLevel)
}
