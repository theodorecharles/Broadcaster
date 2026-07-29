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

    assert.deepEqual(queue, [{ videoId: db.video.id, filePath, channel }])
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

test('resolveEncodeSettings passes VIDEO_CODEC for videotoolbox, qsv, and libx264', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const resolve = preGenerator.resolveEncodeSettings

    for (const codec of ['h264_videotoolbox', 'h264_qsv', 'libx264']) {
        const settings = resolve({
            hasGPU: false,
            canUseGPU: false,
            is10Bit: false,
            width: '640',
            filePath: '/library/news.mkv',
            videoCodecConfig: codec,
            videoPreset: codec === 'libx264' ? 'faster' : 'medium',
            videoCrf: '20',
            videoFilter: 'yadif'
        })
        assert.equal(settings.videoCodec, codec)
        assert.equal(settings.videoPreset, codec === 'libx264' ? 'faster' : 'medium')
        assert.deepEqual(settings.qualityArgs, ['-crf', '20'])
        assert.equal(settings.inputArgs[0], '-i')
        assert.match(settings.fullVideoFilter, /yadif,scale=640:-2/)
    }
})

test('resolveEncodeSettings uses full NVENC path when canUseGPU', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: true,
        canUseGPU: true,
        is10Bit: false,
        width: '1280',
        filePath: '/library/news.mkv',
        videoCodecConfig: 'h264_nvenc',
        videoPreset: 'p5',
        videoCrf: '22',
        videoFilter: 'yadif'
    })
    assert.equal(settings.videoCodec, 'h264_nvenc')
    assert.equal(settings.videoPreset, 'p5')
    assert.deepEqual(settings.qualityArgs, ['-cq', '22', '-rc', 'vbr', '-b:v', '0'])
    assert.deepEqual(settings.inputArgs.slice(0, 4), [
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'
    ])
    assert.match(settings.fullVideoFilter, /yadif_cuda,scale_cuda=1280:-2/)
})

test('resolveEncodeSettings hybrid NVENC when GPU present but canUseGPU false', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: true,
        canUseGPU: false,
        is10Bit: true,
        width: '640',
        filePath: '/library/hdr.mkv',
        videoCodecConfig: 'h264_nvenc',
        videoPreset: undefined,
        videoCrf: undefined,
        videoFilter: 'yadif'
    })
    assert.equal(settings.videoCodec, 'h264_nvenc')
    assert.equal(settings.videoPreset, 'p4')
    assert.deepEqual(settings.qualityArgs, ['-cq', '23', '-rc', 'vbr', '-b:v', '0'])
    assert.deepEqual(settings.inputArgs, ['-i', '/library/hdr.mkv'])
})

test('resolveEncodeSettings falls back to libx264 when NVENC requested without GPU', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: false,
        canUseGPU: false,
        is10Bit: false,
        width: '640',
        filePath: '/library/news.mkv',
        videoCodecConfig: 'h264_nvenc',
        videoPreset: undefined,
        videoCrf: '23',
        videoFilter: 'yadif'
    })
    assert.equal(settings.videoCodec, 'libx264')
    assert.equal(settings.videoPreset, 'veryfast')
    assert.deepEqual(settings.qualityArgs, ['-crf', '23'])
})

test('resolveEncodeSettings does not force NVENC when another codec is configured on a GPU host', t => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))
    const settings = preGenerator.resolveEncodeSettings({
        hasGPU: true,
        canUseGPU: false,
        is10Bit: false,
        width: '640',
        filePath: '/library/news.mkv',
        videoCodecConfig: 'h264_videotoolbox',
        videoPreset: 'fast',
        videoCrf: '18',
        videoFilter: ''
    })
    assert.equal(settings.videoCodec, 'h264_videotoolbox')
    assert.equal(settings.videoPreset, 'fast')
    assert.deepEqual(settings.qualityArgs, ['-crf', '18'])
    assert.equal(settings.fullVideoFilter, 'scale=640:-2')
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

test('stopActiveWorkers SIGTERMs then SIGKILLs tracked ffmpeg children', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))

    const signals = []
    const fakeChild = {
        exitCode: null,
        signalCode: null,
        kill(sig) {
            signals.push(sig)
            if (sig === 'SIGKILL') {
                this.signalCode = 'SIGKILL'
            }
        }
    }

    preGenerator.activeProcesses.add(fakeChild)
    preGenerator.generationQueue = [{ videoId: 1, filePath: '/x', channel: { slug: 'news' } }]
    preGenerator.isGenerating = true

    preGenerator.stopActiveWorkers()

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(preGenerator.activeProcesses.size, 0)
    assert.deepEqual(preGenerator.generationQueue, [])
    assert.equal(preGenerator.isGenerating, false)
    assert.equal(preGenerator.shuttingDown, true)
})

test('stopActiveWorkers is a no-op when no workers are active', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))

    assert.doesNotThrow(() => preGenerator.stopActiveWorkers())
    assert.equal(preGenerator.activeProcesses.size, 0)
    assert.equal(preGenerator.shuttingDown, true)
})

test('stopActiveWorkers skips kill when process already exited', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-cache-'))
    const preGenerator = loadPreGenerator(cacheDir, createDatabase('/library/news.mkv', []))

    let killCalls = 0
    preGenerator.activeProcesses.add({
        exitCode: 0,
        signalCode: null,
        kill() {
            killCalls++
        }
    })

    preGenerator.stopActiveWorkers()

    assert.equal(killCalls, 0)
    assert.equal(preGenerator.activeProcesses.size, 0)
})
