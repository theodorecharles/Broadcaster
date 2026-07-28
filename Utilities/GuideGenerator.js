const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Log = require('./Log.js')
const Database = require('./Database.js')
const tag = 'GuideGenerator'
const { CACHE_DIR } = process.env

// Fisher-Yates shuffle for uniform randomization
function shuffleArray(array) {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// Get the previous 3am boundary
function getPrevious3am(fromTime = Date.now()) {
  const date = new Date(fromTime)
  date.setHours(3, 0, 0, 0)
  if (new Date(fromTime).getHours() < 3) {
    date.setDate(date.getDate() - 1)
  }
  return date.getTime()
}

// Get the next 3am boundary
function getNext3am(fromTime = Date.now()) {
  const date = new Date(fromTime)
  date.setHours(3, 0, 0, 0)
  if (new Date(fromTime).getHours() >= 3) {
    date.setDate(date.getDate() + 1)
  }
  return date.getTime()
}

class GuideGenerator {

  constructor(channel) {
    this.channel = channel
    this.cachedGuide = null
  }

  // Get path to history folder
  getHistoryDir() {
    return path.join(CACHE_DIR, 'history')
  }

  // Get guide filename for a specific day
  getGuideFilename(dayStart) {
    const date = new Date(dayStart)
    const dateStr = date.toISOString().split('T')[0]
    return `guide-${this.channel.slug}-${dateStr}.json`
  }

  // Load guide from history for a specific day
  loadGuideForDay(dayStart) {
    const historyDir = this.getHistoryDir()
    const filename = this.getGuideFilename(dayStart)
    const filePath = path.join(historyDir, filename)

    try {
      if (fs.existsSync(filePath)) {
        const guide = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        Log(tag, `Loaded guide from ${filename}`, this.channel)
        return guide
      }
    } catch (err) {
      Log(tag, `Error loading guide: ${err.message}`, this.channel)
    }
    return null
  }

  // Save guide to history folder
  saveGuide(guide) {
    const historyDir = this.getHistoryDir()
    fs.mkdirSync(historyDir, { recursive: true })

    const filename = this.getGuideFilename(guide.dayStart)
    const filePath = path.join(historyDir, filename)

    fs.writeFileSync(filePath, JSON.stringify(guide, null, 2))
    Log(tag, `Saved guide to ${filename}`, this.channel)
  }

  // Get video display name (show/movie folder name)
  getVideoDisplayName(filePath) {
    if (this.channel.paths) {
      for (const configuredPath of this.channel.paths) {
        const relativePath = path.relative(configuredPath, filePath)
        const isWithinConfiguredPath = relativePath &&
          relativePath !== '..' &&
          !relativePath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativePath)

        if (isWithinConfiguredPath) {
          return relativePath.split(path.sep)[0]
        }
      }
    }
    return path.basename(path.dirname(filePath))
  }

  // Generate a new daily guide
  generateDailyGuide(dayStart = null) {
    if (!dayStart) {
      dayStart = getPrevious3am()
    }

    const dayEnd = dayStart + (24 * 60 * 60 * 1000) // 24 hours

    // Get all transcoded videos from database
    const db = Database()
    const videos = db.getChannelVideos(this.channel.slug, true)

    if (videos.length === 0) {
      Log(tag, `No transcoded videos available`, this.channel)
      return this.createEmptyGuide(dayStart)
    }

    // Calculate total library duration
    const totalLibraryDuration = videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0)
    const dayDurationSeconds = 24 * 60 * 60

    Log(tag, `Generating guide: ${videos.length} videos, ${Math.round(totalLibraryDuration / 3600)}h library for 24h day`, this.channel)

    // Check if previous day's last video extends past dayStart
    let scheduleStart = dayStart
    const prevDayStart = dayStart - (24 * 60 * 60 * 1000)
    const prevGuide = this.loadGuideForDay(prevDayStart)

    if (prevGuide && prevGuide.schedule && prevGuide.schedule.length > 0) {
      const lastEntry = prevGuide.schedule[prevGuide.schedule.length - 1]
      if (lastEntry.endTime > dayStart) {
        scheduleStart = lastEntry.endTime
        Log(tag, `Previous video extends ${Math.round((lastEntry.endTime - dayStart) / 1000)}s past 3am`, this.channel)
      }
    }

    // Build schedule
    const schedule = []
    let currentTime = scheduleStart
    let shuffledVideos = shuffleArray(videos)
    let videoIndex = 0

    while (currentTime < dayEnd) {
      // If we've used all videos, reshuffle (for channels with < 24h content)
      if (videoIndex >= shuffledVideos.length) {
        if (totalLibraryDuration >= dayDurationSeconds) {
          // Library is big enough, shouldn't need repeats - but just in case
          Log(tag, `Reshuffling (unexpected - library should cover 24h)`, this.channel)
        }
        shuffledVideos = shuffleArray(videos)
        videoIndex = 0
      }

      const video = shuffledVideos[videoIndex]
      const duration = video.duration_seconds || 0

      if (duration <= 0) {
        videoIndex++
        continue
      }

      const hash = crypto.createHash('md5').update(video.file_path).digest('hex')

      schedule.push({
        hash: hash,
        title: this.getVideoDisplayName(video.file_path),
        filePath: video.file_path,
        startTime: currentTime,
        endTime: currentTime + (duration * 1000),
        duration: duration
      })

      currentTime += duration * 1000
      videoIndex++
    }

    // Store remaining shuffle state for next day's continuity
    const remainingHashes = shuffledVideos.slice(videoIndex).map(v =>
      crypto.createHash('md5').update(v.file_path).digest('hex')
    )

    const guide = {
      version: 2,
      generatedAt: Date.now(),
      dayStart: dayStart,
      dayEnd: dayEnd,
      channelSlug: this.channel.slug,
      channelName: this.channel.name,
      schedule: schedule,
      shuffleState: {
        remaining: remainingHashes,
        videoCount: videos.length
      }
    }

    this.saveGuide(guide)
    this.cachedGuide = guide

    Log(tag, `Generated guide with ${schedule.length} entries`, this.channel)
    return guide
  }

  // Create empty guide for channels with no content
  createEmptyGuide(dayStart) {
    return {
      version: 2,
      generatedAt: Date.now(),
      dayStart: dayStart,
      dayEnd: dayStart + (24 * 60 * 60 * 1000),
      channelSlug: this.channel.slug,
      channelName: this.channel.name,
      schedule: [],
      shuffleState: { remaining: [], videoCount: 0 }
    }
  }

  // Get the currently active guide (handles day boundaries)
  getActiveGuide() {
    const now = Date.now()
    const todayStart = getPrevious3am(now)

    // Check cache first
    if (this.cachedGuide && this.cachedGuide.dayStart === todayStart) {
      return this.cachedGuide
    }

    // Try to load today's guide
    let guide = this.loadGuideForDay(todayStart)

    if (guide) {
      this.cachedGuide = guide
      return guide
    }

    // No guide exists, generate one
    Log(tag, `No guide for today, generating...`, this.channel)
    guide = this.generateDailyGuide(todayStart)
    return guide
  }

  // Ensure a guide exists for today (called on channel start)
  ensureGuideExists() {
    return this.getActiveGuide()
  }

  // Find the schedule entry for a specific time
  findEntryAtTime(time = Date.now()) {
    const guide = this.getActiveGuide()
    if (!guide || !guide.schedule) return null

    // First check today's guide
    let entry = guide.schedule.find(e => e.startTime <= time && e.endTime > time)
    if (entry) return entry

    // If not found and we're near the start of the day, check previous day
    // (in case previous video extends past 3am)
    const todayStart = getPrevious3am(time)
    if (time - todayStart < 60 * 60 * 1000) { // Within first hour
      const prevDayStart = todayStart - (24 * 60 * 60 * 1000)
      const prevGuide = this.loadGuideForDay(prevDayStart)
      if (prevGuide && prevGuide.schedule) {
        entry = prevGuide.schedule.find(e => e.startTime <= time && e.endTime > time)
        if (entry) return entry
      }
    }

    return null
  }

  // Get schedule for API (returns schedule array with isCurrent flag)
  getScheduleForAPI() {
    const guide = this.getActiveGuide()
    if (!guide || !guide.schedule) return []

    const now = Date.now()

    return guide.schedule.map(entry => ({
      hash: entry.hash,
      title: entry.title,
      startTime: entry.startTime,
      endTime: entry.endTime,
      duration: entry.duration,
      isCurrent: entry.startTime <= now && entry.endTime > now
    }))
  }

  // Invalidate cached guide (call when videos are added/removed)
  invalidateCache() {
    this.cachedGuide = null
  }
}

module.exports = {
  GuideGenerator,
  getPrevious3am,
  getNext3am
}
