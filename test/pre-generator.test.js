const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const preGeneratorPath = require.resolve('../Utilities/PreGenerator.js')
const guideGeneratorPath = require.resolve('../Utilities/GuideGenerator.js')
const playlistManagerPath = require.resolve('../Classes/PlaylistManager.js')
const databasePath = require.resolve('../Utilities/Database.js')
const logPath = require.resolve('../Utilities/Log.js')

function loadPreGenerator(cacheDir, db) {
    process.env.CACHE_DIR = cacheDir
    delete require.cache[preGeneratorPath]
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: () => db
    }
    require.cache[logPath] = {
        id: logPath,
        filename: logPath,
        loaded: true,
        exports: () => {}
    }

    return require(preGeneratorPath)
}

function createDatabase(filePath, updates) {
    const video = {
        id: 41,
        file_path: filePath,
        hash: crypto.createHash('md5').update(filePath).digest('hex'),
        transcoded: 1,
        duration_seconds: 20,
        segment_count: 2
    }

    return {
        video,
        getChannelVideos(channelSlug, transcodedOnly) {
            assert.equal(channelSlug, 'news')
            return !transcodedOnly || video.transcoded ? [video] : []
        },
        getVideoByPath(channelSlug, requestedPath) {
            assert.equal(channelSlug, 'news')
            assert.equal(requestedPath, filePath)
            return video
        },
        getVideoByHash(channelSlug, requestedHash) {
            assert.equal(channelSlug, 'news')
            assert.equal(requestedHash, video.hash)
            return video
        },
        db: {
            prepare(sql) {
                return {
                    run(...args) {
                        updates.push({ sql, args })
                        if (/transcoded\s*=\s*0/i.test(sql)) {
                            video.transcoded = 0
                        }
                        if (/segment_count\s*=\s*NULL/i.test(sql)) {
                            video.segment_count = null
                        }
                    }
                }
            }
        }
    }
}

function createCacheDir(cacheDir, video, files) {
    const outputDir = path.join(
        cacheDir,
        'channels',
        'news',
        'videos',
        video.hash
    )
    fs.mkdirSync(outputDir, { recursive: true })

    for (const [fileName, contents] of Object.entries(files)) {
        fs.writeFileSync(path.join(outputDir, fileName), contents)
    }

    return outputDir
}

function queueSingleVideo(preGenerator) {
    const channel = { slug: 'news' }
    preGenerator.queueChannel(channel)
    return { channel, queue: preGenerator.channelQueues[0] }
}

test('queues a database-positive video when its cache directory is missing', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    const preGenerator = loadPreGenerator(cacheDir, db)

    const { channel, queue } = queueSingleVideo(preGenerator)

    assert.deepEqual(queue, [{ filePath, channel }])
    assert.equal(updates.length, 1)
    assert.match(updates[0].sql, /segment_count\s*=\s*NULL/i)
    assert.match(updates[0].sql, /WHERE id = \?/)
    assert.deepEqual(updates[0].args, [db.video.id])
})

test('queues a database-positive video when a referenced segment is missing', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    const outputDir = createCacheDir(cacheDir, db.video, {
        'index.m3u8': [
            '#EXTM3U',
            '#EXTINF:10.0,',
            'segment_00000.ts',
            '#EXTINF:10.0,',
            'segment_00001.ts',
            '#EXT-X-ENDLIST'
        ].join('\n'),
        'segment_00000.ts': 'segment',
        'metadata.json': '{}'
    })
    const preGenerator = loadPreGenerator(cacheDir, db)

    const { queue } = queueSingleVideo(preGenerator)

    assert.equal(queue.length, 1)
    assert.deepEqual(updates[0].args, [db.video.id])
    assert.equal(fs.existsSync(outputDir), false)
})

test('skips a database-positive video when the cached generation is complete', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    createCacheDir(cacheDir, db.video, {
        'index.m3u8': [
            '#EXTM3U',
            '#EXTINF:10.0,',
            'segment_00000.ts',
            '#EXT-X-ENDLIST'
        ].join('\n'),
        'segment_00000.ts': 'segment',
        'metadata.json': '{}'
    })
    const preGenerator = loadPreGenerator(cacheDir, db)

    queueSingleVideo(preGenerator)

    assert.deepEqual(preGenerator.channelQueues, [])
    assert.deepEqual(updates, [])
})

test('persisted guide cannot emit deleted segment URLs after restart', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const updates = []
    const filePath = '/library/news.mkv'
    const db = createDatabase(filePath, updates)
    const preGenerator = loadPreGenerator(cacheDir, db)

    queueSingleVideo(preGenerator)

    assert.equal(db.video.transcoded, 0)
    assert.equal(db.video.segment_count, null)

    delete require.cache[guideGeneratorPath]
    delete require.cache[playlistManagerPath]
    const { GuideGenerator, getPrevious3am } = require(guideGeneratorPath)
    const { PlaylistManager } = require(playlistManagerPath)
    const channel = { slug: 'news', name: 'News' }
    const now = Date.now()
    const persistedGuide = {
        dayStart: getPrevious3am(now),
        schedule: [{
            hash: db.video.hash,
            startTime: now - 1000,
            endTime: now + 19000
        }]
    }
    new GuideGenerator(channel).saveGuide(persistedGuide)

    delete require.cache[guideGeneratorPath]
    delete require.cache[playlistManagerPath]
    const { GuideGenerator: RestartedGuideGenerator } = require(guideGeneratorPath)
    const { PlaylistManager: RestartedPlaylistManager } = require(playlistManagerPath)
    const restartedGuideGenerator = new RestartedGuideGenerator(channel)
    const restartedPlaylistManager = new RestartedPlaylistManager(channel)
    restartedPlaylistManager.setGuideGenerator(restartedGuideGenerator)

    const reloadedGuide = restartedGuideGenerator.getActiveGuide()
    const playlist = restartedPlaylistManager.createRollingPlaylist()

    assert.equal(reloadedGuide.schedule[0].hash, db.video.hash)
    assert.match(playlist, /#EXT-X-ENDLIST/)
    assert.doesNotMatch(playlist, /segment_\d+\.ts/)
})
