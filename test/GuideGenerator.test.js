const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-guide-'))
process.env.CACHE_DIR = cacheDir

const Database = require('../Utilities/Database.js')
const { GuideGenerator } = require('../Utilities/GuideGenerator.js')

const db = Database()

test.after(() => {
  db.close()
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

test('carries an entry that overlaps the 3am boundary into the new guide', () => {
  const dayStart = new Date(2026, 0, 15, 3, 0, 0, 0).getTime()
  const overlappingEntry = {
    hash: 'previous-video',
    title: 'Previous show',
    filePath: '/media/previous.mp4',
    startTime: dayStart - (2 * 60 * 60 * 1000),
    endTime: dayStart + (2 * 60 * 60 * 1000),
    duration: 4 * 60 * 60
  }
  const generator = new GuideGenerator({
    slug: 'test-channel',
    name: 'Test Channel',
    paths: ['/media']
  })

  db.getChannelVideos = () => [{
    file_path: '/media/next.mp4',
    duration_seconds: 60 * 60
  }]
  generator.loadGuideForDay = requestedDayStart => {
    assert.equal(requestedDayStart, dayStart - (24 * 60 * 60 * 1000))
    return { schedule: [overlappingEntry] }
  }
  generator.saveGuide = () => {}

  const guide = generator.generateDailyGuide(dayStart)

  assert.deepEqual(guide.schedule[0], overlappingEntry)
  assert.notStrictEqual(guide.schedule[0], overlappingEntry)
  assert.equal(guide.schedule[1].startTime, overlappingEntry.endTime)
})

test('finds a previous-guide overlap more than one hour after 3am', () => {
  const dayStart = new Date(2026, 0, 15, 3, 0, 0, 0).getTime()
  const lookupTime = dayStart + (2 * 60 * 60 * 1000)
  const overlappingEntry = {
    hash: 'long-video',
    startTime: dayStart - (30 * 60 * 1000),
    endTime: dayStart + (3 * 60 * 60 * 1000)
  }
  const generator = new GuideGenerator({ slug: 'test-channel' })

  generator.getActiveGuide = () => ({
    dayStart,
    schedule: [{
      hash: 'next-video',
      startTime: overlappingEntry.endTime,
      endTime: overlappingEntry.endTime + (60 * 60 * 1000)
    }]
  })
  generator.loadGuideForDay = requestedDayStart => {
    assert.equal(requestedDayStart, dayStart - (24 * 60 * 60 * 1000))
    return { schedule: [overlappingEntry] }
  }

  assert.equal(generator.findEntryAtTime(lookupTime), overlappingEntry)
})
