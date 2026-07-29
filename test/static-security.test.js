const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const express = require('express')

const { allowHlsStaticPath } = require('../Webapp/staticAssets.js')

function mockReqRes(urlPath) {
    const req = { path: urlPath, url: urlPath }
    let statusCode = 200
    let ended = false
    const res = {
        status(code) {
            statusCode = code
            return this
        },
        end() {
            ended = true
        }
    }
    let nextCalled = false
    const next = () => {
        nextCalled = true
    }
    return { req, res, next, get statusCode() { return statusCode }, get ended() { return ended }, get nextCalled() { return nextCalled } }
}

test('allowHlsStaticPath allows m3u8 and ts only', () => {
    for (const p of [
        '/static/_.m3u8',
        '/ch1/videos/abc/segment_00000.ts',
        '/ch1/videos/abc/index.m3u8'
    ]) {
        const m = mockReqRes(p)
        allowHlsStaticPath(m.req, m.res, m.next)
        assert.equal(m.nextCalled, true, `should allow ${p}`)
        assert.equal(m.ended, false)
    }
})

test('allowHlsStaticPath blocks manifests, metadata, db, and other files', () => {
    for (const p of [
        '/ch1/manifest.json',
        '/ch1/videos/abc/metadata.json',
        '/ch1/notes.txt',
        '/ch1/videos/abc/secret.db',
        '/ch1/videos/abc/secret.db-wal'
    ]) {
        const m = mockReqRes(p)
        allowHlsStaticPath(m.req, m.res, m.next)
        assert.equal(m.nextCalled, false, `should deny ${p}`)
        assert.equal(m.statusCode, 404)
        assert.equal(m.ended, true)
    }
})

function request(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf8')
                })
            })
        }).on('error', reject)
    })
}

test('static tree does not expose DB, history, or path manifests', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-static-sec-'))
    const publicDir = path.join(cacheDir, 'public')
    const channelDir = path.join(cacheDir, 'channels', 'movies')
    const videoDir = path.join(channelDir, 'videos', 'deadbeef')

    fs.mkdirSync(publicDir, { recursive: true })
    fs.mkdirSync(videoDir, { recursive: true })
    fs.mkdirSync(path.join(cacheDir, 'history'), { recursive: true })

    fs.writeFileSync(path.join(cacheDir, 'broadcaster.db'), 'SECRET_DB')
    fs.writeFileSync(path.join(cacheDir, 'history', 'guide.json'), 'SECRET_HISTORY')
    fs.writeFileSync(
        path.join(channelDir, 'manifest.json'),
        JSON.stringify({ deadbeef: { originalPath: '/media/secret.mkv', filename: 'secret.mkv' } })
    )
    fs.writeFileSync(
        path.join(videoDir, 'metadata.json'),
        JSON.stringify({ originalPath: '/media/secret.mkv' })
    )
    fs.writeFileSync(path.join(videoDir, 'segment_00000.ts'), 'FAKE_TS')
    fs.writeFileSync(path.join(videoDir, 'index.m3u8'), '#EXTM3U\n')
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html>ui</html>')

    // Mirror production mount: public UI + filtered /channels — never CACHE_DIR root
    const app = express()
    app.use(express.static(publicDir))
    app.use('/channels', allowHlsStaticPath, express.static(path.join(cacheDir, 'channels')))

    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = server.address().port

    try {
        const ui = await request(port, '/index.html')
        assert.equal(ui.status, 200)
        assert.match(ui.body, /ui/)

        const segment = await request(port, '/channels/movies/videos/deadbeef/segment_00000.ts')
        assert.equal(segment.status, 200)
        assert.equal(segment.body, 'FAKE_TS')

        const playlist = await request(port, '/channels/movies/videos/deadbeef/index.m3u8')
        assert.equal(playlist.status, 200)

        const db = await request(port, '/broadcaster.db')
        assert.equal(db.status, 404)
        assert.doesNotMatch(db.body, /SECRET_DB/)

        const history = await request(port, '/history/guide.json')
        assert.equal(history.status, 404)
        assert.doesNotMatch(history.body, /SECRET_HISTORY/)

        const manifest = await request(port, '/channels/movies/manifest.json')
        assert.equal(manifest.status, 404)
        assert.doesNotMatch(manifest.body, /originalPath/)
        assert.doesNotMatch(manifest.body, /secret\.mkv/)

        const metadata = await request(port, '/channels/movies/videos/deadbeef/metadata.json')
        assert.equal(metadata.status, 404)
        assert.doesNotMatch(metadata.body, /originalPath/)
    } finally {
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(cacheDir, { recursive: true, force: true })
    }
})
