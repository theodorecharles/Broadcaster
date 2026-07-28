const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const preGeneratorPath = require.resolve('../Utilities/PreGenerator.js')
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
        transcoded: 1
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
        db: {
            prepare(sql) {
                return {
                    run(...args) {
                        updates.push({ sql, args })
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
