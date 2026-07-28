const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('channel type controls ordering across library repeats', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-guide-'))
  const previousCacheDir = process.env.CACHE_DIR
  process.env.CACHE_DIR = cacheDir

  const databasePath = require.resolve('../Utilities/Database.js')
  const guideGeneratorPath = require.resolve('../Utilities/GuideGenerator.js')
  const logPath = require.resolve('../Utilities/Log.js')
  const originalDatabaseModule = require.cache[databasePath]
  const originalGuideGeneratorModule = require.cache[guideGeneratorPath]
  const originalLogModule = require.cache[logPath]

  const videos = [
    { file_path: '/media/Episode 01.mkv', duration_seconds: 4 * 60 * 60 },
    { file_path: '/media/Episode 02.mkv', duration_seconds: 4 * 60 * 60 },
    { file_path: '/media/Episode 03.mkv', duration_seconds: 4 * 60 * 60 }
  ]

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: () => ({
      getChannelVideos: () => videos
    })
  }
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: () => {}
  }
  delete require.cache[guideGeneratorPath]

  t.after(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
    if (previousCacheDir === undefined) {
      delete process.env.CACHE_DIR
    } else {
      process.env.CACHE_DIR = previousCacheDir
    }

    if (originalDatabaseModule) {
      require.cache[databasePath] = originalDatabaseModule
    } else {
      delete require.cache[databasePath]
    }
    if (originalGuideGeneratorModule) {
      require.cache[guideGeneratorPath] = originalGuideGeneratorModule
    } else {
      delete require.cache[guideGeneratorPath]
    }
    if (originalLogModule) {
      require.cache[logPath] = originalLogModule
    } else {
      delete require.cache[logPath]
    }
  })

  t.mock.method(Math, 'random', () => 0)

  const { GuideGenerator } = require(guideGeneratorPath)
  const generator = new GuideGenerator({
    type: 'alphabetical',
    slug: 'alphabetical',
    name: 'Alphabetical',
    paths: ['/media']
  })
  const guide = generator.generateDailyGuide(Date.UTC(2026, 6, 28, 3))

  assert.deepEqual(
    guide.schedule.map(entry => entry.filePath),
    [
      '/media/Episode 01.mkv',
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv',
      '/media/Episode 01.mkv',
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv'
    ]
  )

  const shuffleGenerator = new GuideGenerator({
    type: 'shuffle',
    slug: 'shuffle',
    name: 'Shuffle',
    paths: ['/media']
  })
  const shuffleGuide = shuffleGenerator.generateDailyGuide(Date.UTC(2026, 6, 28, 3))

  assert.deepEqual(
    shuffleGuide.schedule.map(entry => entry.filePath),
    [
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv',
      '/media/Episode 01.mkv',
      '/media/Episode 02.mkv',
      '/media/Episode 03.mkv',
      '/media/Episode 01.mkv'
    ]
  )
})
