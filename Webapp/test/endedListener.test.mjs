import assert from 'node:assert/strict'
import test from 'node:test'

import {
  removeEndedListener,
  replaceEndedListener
} from '../src/endedListener.mjs'

class ListenerCountingVideo {
  constructor() {
    this.listeners = new Map()
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? new Set()
    handlers.add(handler)
    this.listeners.set(type, handlers)
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler)
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0
  }
}

test('channel changes and static reloads keep one ended listener', () => {
  const listenerRef = { current: null }
  const video = new ListenerCountingVideo()
  const channelOneHandler = () => {}
  const channelTwoHandler = () => {}
  const staticHandler = () => {}

  replaceEndedListener(listenerRef, video, channelOneHandler)
  assert.equal(video.listenerCount('ended'), 1)

  replaceEndedListener(listenerRef, video, channelTwoHandler)
  assert.equal(video.listenerCount('ended'), 1)

  replaceEndedListener(listenerRef, video, staticHandler)
  assert.equal(video.listenerCount('ended'), 1)
  assert.equal(listenerRef.current.handler, staticHandler)
})

test('replacement removes the listener from its original video element', () => {
  const listenerRef = { current: null }
  const originalVideo = new ListenerCountingVideo()
  const replacementVideo = new ListenerCountingVideo()

  replaceEndedListener(listenerRef, originalVideo, () => {})
  replaceEndedListener(listenerRef, replacementVideo, () => {})

  assert.equal(originalVideo.listenerCount('ended'), 0)
  assert.equal(replacementVideo.listenerCount('ended'), 1)
})

test('power-off and unmount cleanup leave zero ended listeners', () => {
  const listenerRef = { current: null }
  const video = new ListenerCountingVideo()

  replaceEndedListener(listenerRef, video, () => {})
  assert.equal(video.listenerCount('ended'), 1)

  removeEndedListener(listenerRef)
  assert.equal(video.listenerCount('ended'), 0)
  assert.equal(listenerRef.current, null)

  removeEndedListener(listenerRef)
  assert.equal(video.listenerCount('ended'), 0)
})
