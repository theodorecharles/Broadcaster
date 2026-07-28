import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelChannelSwitch, scheduleChannelSwitch } from './channelSwitch.mjs'

test('only the latest scheduled channel switch can run', { concurrency: false }, () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers = new Map()
  let nextTimerId = 1

  globalThis.setTimeout = (callback) => {
    const timerId = nextTimerId++
    timers.set(timerId, callback)
    return timerId
  }
  globalThis.clearTimeout = (timerId) => {
    timers.delete(timerId)
  }

  try {
    const timeoutRef = { current: null }
    const loadedChannels = []

    scheduleChannelSwitch(timeoutRef, () => loadedChannels.push('first'))
    const staleCallback = timers.get(timeoutRef.current)

    scheduleChannelSwitch(timeoutRef, () => loadedChannels.push('second'))
    const latestTimerId = timeoutRef.current

    staleCallback()
    assert.deepEqual(loadedChannels, [])
    assert.equal(timeoutRef.current, latestTimerId)

    timers.get(latestTimerId)()
    assert.deepEqual(loadedChannels, ['second'])
    assert.equal(timeoutRef.current, null)

    scheduleChannelSwitch(timeoutRef, () => loadedChannels.push('cancelled'))
    const cancelledCallback = timers.get(timeoutRef.current)
    cancelChannelSwitch(timeoutRef)
    cancelledCallback()

    assert.deepEqual(loadedChannels, ['second'])
    assert.equal(timeoutRef.current, null)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
