const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { GuideGenerator } = require('../Utilities/GuideGenerator.js')

test('uses the first folder beneath a configured root for nested media', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'tv')]
  })
  const filePath = path.join(
    path.sep,
    'media',
    'tv',
    'Star Trek Picard',
    'Season 1',
    'Episode 1.mkv'
  )

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'Star Trek Picard')
})

test('uses the filename for media directly beneath a configured root', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'movies')]
  })
  const filePath = path.join(path.sep, 'media', 'movies', 'Dune.mkv')

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'Dune.mkv')
})

test('does not treat a sibling path with the same prefix as configured content', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'tv')]
  })
  const filePath = path.join(
    path.sep,
    'media',
    'tv-archive',
    'Fringe',
    'Episode 1.mkv'
  )

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'Fringe')
})

test('keeps the parent-folder fallback outside configured roots', () => {
  const guideGenerator = new GuideGenerator({
    paths: [path.join(path.sep, 'media', 'tv')]
  })
  const filePath = path.join(
    path.sep,
    'other',
    'The Expanse',
    'Episode 1.mkv'
  )

  assert.equal(guideGenerator.getVideoDisplayName(filePath), 'The Expanse')
})
