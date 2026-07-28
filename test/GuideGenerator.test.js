const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

process.env.TZ = 'America/New_York'
process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-guide-test-'))

const databasePath = require.resolve('../Utilities/Database.js')
let videos = []
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: () => ({
    getChannelVideos: () => videos
  })
}

const {
  GuideGenerator,
  getNext3am
} = require('../Utilities/GuideGenerator.js')

test.after(() => {
  fs.rmSync(process.env.CACHE_DIR, { recursive: true, force: true })
})

function local3am(year, month, day) {
  return new Date(year, month, day, 3, 0, 0, 0).getTime()
}

test('next 3am follows the local calendar across DST transitions', () => {
  const cases = [
    {
      name: 'regular day',
      start: local3am(2025, 0, 15),
      end: local3am(2025, 0, 16),
      hours: 24
    },
    {
      name: 'fall-back day',
      start: local3am(2025, 10, 1),
      end: local3am(2025, 10, 2),
      hours: 25
    },
    {
      name: 'spring-forward day',
      start: local3am(2025, 2, 8),
      end: local3am(2025, 2, 9),
      hours: 23
    }
  ]

  for (const { name, start, end, hours } of cases) {
    assert.equal(getNext3am(start), end, name)
    assert.equal((end - start) / (60 * 60 * 1000), hours, name)
  }
})

test('generated and empty guides end at the next local 3am', () => {
  const dayStart = local3am(2025, 10, 1)
  const expectedDayEnd = local3am(2025, 10, 2)
  const generator = new GuideGenerator({ slug: 'test', name: 'Test' })

  videos = []
  const emptyGuide = generator.generateDailyGuide(dayStart)
  assert.equal(emptyGuide.dayEnd, expectedDayEnd)

  videos = [{ file_path: '/shows/example.mp4', duration_seconds: 60 * 60 }]
  generator.loadGuideForDay = () => null
  generator.saveGuide = () => {}
  const generatedGuide = generator.generateDailyGuide(dayStart)

  assert.equal(generatedGuide.dayEnd, expectedDayEnd)
  assert.ok(generatedGuide.schedule.at(-1).endTime >= expectedDayEnd)
  assert.ok(generatedGuide.schedule.some(entry =>
    entry.startTime <= expectedDayEnd - (30 * 60 * 1000) &&
    entry.endTime > expectedDayEnd - (30 * 60 * 1000)
  ))
})

test('generation loads the previous local-calendar guide', () => {
  const dayStart = local3am(2025, 10, 2)
  const expectedPreviousStart = local3am(2025, 10, 1)
  const generator = new GuideGenerator({ slug: 'test', name: 'Test' })
  let loadedDayStart

  videos = [{ file_path: '/shows/example.mp4', duration_seconds: 60 * 60 }]
  generator.loadGuideForDay = candidate => {
    loadedDayStart = candidate
    return null
  }
  generator.saveGuide = () => {}
  generator.generateDailyGuide(dayStart)

  assert.equal(loadedDayStart, expectedPreviousStart)
})

test('entry lookup checks the previous local-calendar guide', () => {
  const todayStart = local3am(2025, 10, 2)
  const expectedPreviousStart = local3am(2025, 10, 1)
  const generator = new GuideGenerator({ slug: 'test', name: 'Test' })
  let loadedDayStart

  generator.getActiveGuide = () => ({ schedule: [] })
  generator.loadGuideForDay = candidate => {
    loadedDayStart = candidate
    return { schedule: [] }
  }

  assert.equal(generator.findEntryAtTime(todayStart + (15 * 60 * 1000)), null)
  assert.equal(loadedDayStart, expectedPreviousStart)
})
