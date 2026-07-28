const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const guideGeneratorPath = path.join(projectRoot, 'Utilities', 'GuideGenerator.js')
const databasePath = path.join(projectRoot, 'Utilities', 'Database.js')
const logPath = path.join(projectRoot, 'Utilities', 'Log.js')
const dayStart = Date.UTC(2026, 0, 1, 3)

function generateGuide(videos) {
  const cacheDir = mkdtempSync(path.join(projectRoot, '.guide-test-cache-'))
  const script = `
    const databasePath = ${JSON.stringify(databasePath)}
    const logPath = ${JSON.stringify(logPath)}

    require.cache[databasePath] = {
      id: databasePath,
      filename: databasePath,
      loaded: true,
      exports: () => ({
        getChannelVideos: () => ${JSON.stringify(videos)}
      })
    }
    require.cache[logPath] = {
      id: logPath,
      filename: logPath,
      loaded: true,
      exports: () => {}
    }

    const { GuideGenerator } = require(${JSON.stringify(guideGeneratorPath)})
    const generator = new GuideGenerator({
      slug: 'test-channel',
      name: 'Test Channel',
      paths: ['/library']
    })
    const guide = generator.generateDailyGuide(${dayStart})
    process.stdout.write(JSON.stringify(guide))
  `

  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CACHE_DIR: cacheDir },
      timeout: 2000
    })

    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
}

test('returns an empty guide when every transcoded video has an unusable duration', () => {
  const guide = generateGuide([
    { file_path: '/library/null.mp4', duration_seconds: null },
    { file_path: '/library/zero.mp4', duration_seconds: 0 },
    { file_path: '/library/negative.mp4', duration_seconds: -1 }
  ])

  assert.deepEqual(guide.schedule, [])
  assert.deepEqual(guide.shuffleState, { remaining: [], videoCount: 0 })
})

test('excludes unusable durations before scheduling a mixed library', () => {
  const guide = generateGuide([
    { file_path: '/library/valid.mp4', duration_seconds: 86400 },
    { file_path: '/library/null.mp4', duration_seconds: null },
    { file_path: '/library/zero.mp4', duration_seconds: 0 }
  ])

  assert.equal(guide.schedule.length, 1)
  assert.equal(guide.schedule[0].filePath, '/library/valid.mp4')
  assert.equal(guide.schedule[0].duration, 86400)
  assert.deepEqual(guide.shuffleState, { remaining: [], videoCount: 1 })
})
