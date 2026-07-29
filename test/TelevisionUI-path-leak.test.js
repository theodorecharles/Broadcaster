const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildDebugVideoPayload,
  buildManifestEntryPayload
} = require('../Webapp/TelevisionUI.js')

test('debug video payload omits absolute file paths', () => {
  const payload = buildDebugVideoPayload({
    file_path: '/var/media/library/shows/episode.mkv',
    transcoded: 1,
    duration_seconds: 1800,
    segment_count: 120
  })

  assert.deepEqual(payload, {
    transcoded: true,
    duration: 1800,
    segmentCount: 120
  })
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'filePath'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'file_path'), false)
  assert.equal(JSON.stringify(payload).includes('/var/media'), false)
})

test('debug video payload returns null when video is missing', () => {
  assert.equal(buildDebugVideoPayload(null), null)
  assert.equal(buildDebugVideoPayload(undefined), null)
})

test('manifest entry payload omits originalPath', () => {
  const payload = buildManifestEntryPayload({
    filename: 'episode',
    originalPath: '/home/user/videos/library/episode.mkv',
    addedAt: 1700000000000
  })

  assert.equal(payload.filename, 'episode')
  assert.equal(payload.addedAt, new Date(1700000000000).toISOString())
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'originalPath'), false)
  assert.equal(JSON.stringify(payload).includes('/home/user'), false)
})

test('manifest entry payload handles missing addedAt', () => {
  const payload = buildManifestEntryPayload({
    filename: 'clip',
    originalPath: '/secret/path/clip.mp4'
  })

  assert.deepEqual(payload, {
    filename: 'clip',
    addedAt: null
  })
})
