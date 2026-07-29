import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHANNEL_ENTRY_COMMIT_MS,
  CHANNEL_ENTRY_MAX_DIGITS,
  appendDigit,
  cancelChannelEntry,
  parseChannelNumber,
  resolveChannelIndex,
  scheduleChannelEntryCommit
} from './channelEntry.mjs'

test('appendDigit builds multi-digit buffer and rejects non-digits', () => {
  assert.equal(appendDigit('', '1'), '1')
  assert.equal(appendDigit('1', '2'), '12')
  assert.equal(appendDigit('12', '0'), '120')
  assert.equal(appendDigit('12', 'a'), '12')
  assert.equal(appendDigit('12', '10'), '12')
})

test('appendDigit respects max digits', () => {
  assert.equal(appendDigit('123', '4'), '123')
  assert.equal(appendDigit('12', '3', 2), '12')
  assert.equal(appendDigit('', '9', CHANNEL_ENTRY_MAX_DIGITS), '9')
})

test('parseChannelNumber and resolveChannelIndex map 1-based channels', () => {
  assert.equal(parseChannelNumber(''), null)
  assert.equal(parseChannelNumber('05'), 5)
  assert.equal(parseChannelNumber('12'), 12)

  assert.equal(resolveChannelIndex(1, 5), 0)
  assert.equal(resolveChannelIndex(5, 5), 4)
  assert.equal(resolveChannelIndex(6, 5), null)
  assert.equal(resolveChannelIndex(0, 5), null)
  assert.equal(resolveChannelIndex(null, 5), null)
  assert.equal(resolveChannelIndex(1, 0), null)
})

test('scheduleChannelEntryCommit only latest callback runs', () => {
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
    const commits = []

    scheduleChannelEntryCommit(timeoutRef, () => commits.push('first'))
    const stale = timers.get(timeoutRef.current)

    scheduleChannelEntryCommit(timeoutRef, () => commits.push('second'))
    const latestId = timeoutRef.current

    stale()
    assert.deepEqual(commits, [])
    assert.equal(timeoutRef.current, latestId)

    timers.get(latestId)()
    assert.deepEqual(commits, ['second'])
    assert.equal(timeoutRef.current, null)

    scheduleChannelEntryCommit(timeoutRef, () => commits.push('cancelled'))
    const cancelled = timers.get(timeoutRef.current)
    cancelChannelEntry(timeoutRef)
    cancelled()
    assert.deepEqual(commits, ['second'])
    assert.equal(timeoutRef.current, null)

    assert.equal(CHANNEL_ENTRY_COMMIT_MS, 1500)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
