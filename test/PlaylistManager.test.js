const assert = require('node:assert/strict')
const test = require('node:test')

const databasePath = require.resolve('../Utilities/Database.js')
const logPath = require.resolve('../Utilities/Log.js')

require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: () => ({})
}
require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: () => {}
}

const { PlaylistManager } = require('../Classes/PlaylistManager.js')

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000

function createEntry(hash, startTime, duration, title = hash) {
    return {
        hash,
        title,
        startTime,
        endTime: startTime + (duration * 1000),
        duration
    }
}

function createGuide(dayStart, schedule) {
    return {
        version: 2,
        dayStart,
        dayEnd: dayStart + DAY_IN_MILLISECONDS,
        schedule
    }
}

function createPlaylistManager({ activeGuide, historicalGuides = [], videos }) {
    const guidesByDay = new Map(
        [activeGuide, ...historicalGuides].map(guide => [guide.dayStart, guide])
    )
    const guideGenerator = {
        getActiveGuide: () => activeGuide,
        loadGuideForDay: dayStart => guidesByDay.get(dayStart) || null,
        findEntryAtTime: time => {
            const activeEntry = activeGuide.schedule.find(
                entry => entry.startTime <= time && entry.endTime > time
            )
            if (activeEntry) {
                return activeEntry
            }

            const previousGuide = guidesByDay.get(
                activeGuide.dayStart - DAY_IN_MILLISECONDS
            )
            return previousGuide
                ? previousGuide.schedule.find(
                    entry => entry.startTime <= time && entry.endTime > time
                ) || null
                : null
        },
        invalidateCache: () => {}
    }
    const manager = new PlaylistManager({ slug: 'test-channel' })
    manager.setGuideGenerator(guideGenerator)
    manager.getVideoByHash = hash => videos[hash] || null

    return manager
}

function getTagValue(playlist, tag) {
    const match = playlist.match(new RegExp(`^#${tag}:(\\d+)$`, 'm'))
    return match ? Number(match[1]) : null
}

function getSegmentPaths(playlist) {
    return playlist
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
}

test('keeps media and discontinuity sequences continuous at a program transition', (t) => {
    const dayStart = 100 * DAY_IN_MILLISECONDS
    const firstEntry = createEntry('first', dayStart, 10)
    const secondEntry = createEntry('second', firstEntry.endTime, 12)
    const guide = createGuide(dayStart, [firstEntry, secondEntry])
    const manager = createPlaylistManager({
        activeGuide: guide,
        videos: {
            first: { duration_seconds: 10, segment_count: 5 },
            second: { duration_seconds: 12, segment_count: 6 }
        }
    })

    t.mock.method(Date, 'now', () => firstEntry.startTime + 9000)
    const transitionPlaylist = manager.createRollingPlaylist()
    const transitionPaths = getSegmentPaths(transitionPlaylist)
    const firstSecondSegment = transitionPaths.findIndex(
        segmentPath => segmentPath.includes('/second/')
    )
    const secondEntrySequence = getTagValue(
        transitionPlaylist,
        'EXT-X-MEDIA-SEQUENCE'
    ) + firstSecondSegment

    assert.equal(getTagValue(transitionPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 1)
    assert.equal(
        getTagValue(transitionPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        0
    )
    assert.match(
        transitionPlaylist,
        /segment_00004\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:/
    )

    Date.now.mock.mockImplementation(() => secondEntry.startTime + 1000)
    const nextPlaylist = manager.createRollingPlaylist()

    assert.equal(getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 5)
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        1
    )
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'),
        secondEntrySequence
    )
})

test('emits a discontinuity when consecutive entries repeat the same video', (t) => {
    const dayStart = 200 * DAY_IN_MILLISECONDS
    const firstEntry = createEntry('repeat', dayStart, 10)
    const secondEntry = createEntry('repeat', firstEntry.endTime, 10)
    const guide = createGuide(dayStart, [firstEntry, secondEntry])
    const manager = createPlaylistManager({
        activeGuide: guide,
        videos: {
            repeat: { duration_seconds: 10, segment_count: 5 }
        }
    })

    t.mock.method(Date, 'now', () => firstEntry.startTime + 9000)
    const playlist = manager.createRollingPlaylist()

    assert.equal(
        playlist.match(/^#EXT-X-DISCONTINUITY$/gm)?.length,
        1
    )

    Date.now.mock.mockImplementation(() => secondEntry.startTime + 1000)
    const nextPlaylist = manager.createRollingPlaylist()

    assert.equal(getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 5)
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        1
    )
})

test('carries sequence offsets across daily guide boundaries', (t) => {
    const previousDayStart = 300 * DAY_IN_MILLISECONDS
    const activeDayStart = previousDayStart + DAY_IN_MILLISECONDS
    const earlyEntry = createEntry('early', previousDayStart, 6)
    const crossingEntry = createEntry('crossing', activeDayStart - 4000, 8)
    const nextEntry = createEntry('next', crossingEntry.endTime, 10)
    const previousGuide = createGuide(
        previousDayStart,
        [earlyEntry, crossingEntry]
    )
    const activeGuide = createGuide(activeDayStart, [nextEntry])
    const manager = createPlaylistManager({
        activeGuide,
        historicalGuides: [previousGuide],
        videos: {
            early: { duration_seconds: 6, segment_count: 3 },
            crossing: { duration_seconds: 8, segment_count: 4 },
            next: { duration_seconds: 10, segment_count: 5 }
        }
    })

    t.mock.method(Date, 'now', () => crossingEntry.endTime - 1000)
    const transitionPlaylist = manager.createRollingPlaylist()
    const transitionPaths = getSegmentPaths(transitionPlaylist)
    const firstNextSegment = transitionPaths.findIndex(
        segmentPath => segmentPath.includes('/next/')
    )
    const nextEntrySequence = getTagValue(
        transitionPlaylist,
        'EXT-X-MEDIA-SEQUENCE'
    ) + firstNextSegment

    assert.equal(
        getTagValue(transitionPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        1
    )

    Date.now.mock.mockImplementation(() => nextEntry.startTime + 1000)
    const nextPlaylist = manager.createRollingPlaylist()

    assert.equal(getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'), 7)
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-DISCONTINUITY-SEQUENCE'),
        2
    )
    assert.equal(
        getTagValue(nextPlaylist, 'EXT-X-MEDIA-SEQUENCE'),
        nextEntrySequence
    )
})
