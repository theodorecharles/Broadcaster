/** Classic remote-style multi-digit channel entry helpers. */

export const CHANNEL_ENTRY_COMMIT_MS = 1500
export const CHANNEL_ENTRY_INVALID_MS = 800
export const CHANNEL_ENTRY_MAX_DIGITS = 3

/**
 * Append a single digit character to the entry buffer.
 * @param {string} buffer
 * @param {string} digit - '0'..'9'
 * @param {number} [maxDigits]
 * @returns {string}
 */
export function appendDigit(buffer, digit, maxDigits = CHANNEL_ENTRY_MAX_DIGITS) {
  if (!/^[0-9]$/.test(digit)) return buffer
  if (buffer.length >= maxDigits) return buffer
  return buffer + digit
}

/**
 * Parse buffer to a 1-based channel number, or null if empty.
 * @param {string} buffer
 * @returns {number|null}
 */
export function parseChannelNumber(buffer) {
  if (!buffer || buffer.length === 0) return null
  return parseInt(buffer, 10)
}

/**
 * Map 1-based channel number to 0-based index, or null if invalid/out of range.
 * @param {number|null} channelNumber
 * @param {number} channelCount
 * @returns {number|null}
 */
export function resolveChannelIndex(channelNumber, channelCount) {
  if (channelNumber == null || channelCount <= 0) return null
  if (!Number.isInteger(channelNumber) || channelNumber < 1) return null
  const index = channelNumber - 1
  if (index >= channelCount) return null
  return index
}

/**
 * @param {{ current: ReturnType<typeof setTimeout>|null }} timeoutRef
 */
export function cancelChannelEntry(timeoutRef) {
  if (timeoutRef.current === null) return
  clearTimeout(timeoutRef.current)
  timeoutRef.current = null
}

/**
 * Schedule (or re-schedule) a commit after classic multi-digit delay.
 * @param {{ current: ReturnType<typeof setTimeout>|null }} timeoutRef
 * @param {() => void} callback
 * @param {number} [delay]
 */
export function scheduleChannelEntryCommit(
  timeoutRef,
  callback,
  delay = CHANNEL_ENTRY_COMMIT_MS
) {
  cancelChannelEntry(timeoutRef)

  const timeoutId = setTimeout(() => {
    if (timeoutRef.current !== timeoutId) return
    timeoutRef.current = null
    callback()
  }, delay)

  timeoutRef.current = timeoutId
}
