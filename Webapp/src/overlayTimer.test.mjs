import assert from 'node:assert/strict'
import test from 'node:test'

import { showOverlay } from './overlayTimer.mjs'

const wait = duration => new Promise(resolve => setTimeout(resolve, duration))

test('channel and volume overlays expire independently', async () => {
  const channelTimeoutRef = { current: null }
  const volumeTimeoutRef = { current: null }
  let channelVisible = false
  let volumeVisible = false

  showOverlay(value => {
    channelVisible = value
  }, channelTimeoutRef, 20)
  showOverlay(value => {
    volumeVisible = value
  }, volumeTimeoutRef, 80)

  await wait(40)

  assert.equal(channelVisible, false)
  assert.equal(volumeVisible, true)

  await wait(60)

  assert.equal(volumeVisible, false)
})
