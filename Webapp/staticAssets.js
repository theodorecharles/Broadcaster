const express = require('express')
const fs = require('fs')
const path = require('path')

/**
 * HLS under /channels may only expose media segments/playlists.
 * Blocks path manifests, metadata, DB files, and other non-media paths.
 * Mounted at /channels so req.path is relative to that prefix.
 */
function allowHlsStaticPath(req, res, next) {
    const requestPath = req.path || ''
    const base = path.basename(requestPath)

    if (
        base === 'manifest.json' ||
        base === 'metadata.json' ||
        base.endsWith('.db') ||
        base.endsWith('.db-wal') ||
        base.endsWith('.db-shm')
    ) {
        return res.status(404).end()
    }

    if (!/\.(m3u8|ts)$/i.test(requestPath)) {
        return res.status(404).end()
    }

    return next()
}

function setHlsStaticHeaders(res, filePath) {
    if (filePath.endsWith('.ts')) {
        res.set('Cache-Control', 'no-store')
    }
}

/**
 * Serve only public UI assets + filtered channel HLS.
 * Never mounts CACHE_DIR root (DB, history, manifests stay off the static tree).
 *
 * @param {import('express').Application} app
 * @param {string} cacheDir
 * @param {string} webappDir absolute path to Webapp/ (for dist/static copies)
 */
function mountPublicStatic(app, cacheDir, webappDir) {
    const publicDir = path.join(cacheDir, 'public')
    const channelsDir = path.join(cacheDir, 'channels')

    fs.mkdirSync(publicDir, { recursive: true })
    fs.mkdirSync(channelsDir, { recursive: true })

    // Copy static directories (16:9 and 4:3 versions)
    fs.cpSync(path.join(webappDir, 'static'), path.join(channelsDir, 'static'), { recursive: true })
    fs.cpSync(path.join(webappDir, 'static-4x3'), path.join(channelsDir, 'static-4x3'), { recursive: true })

    // UI lives under public/ so it is not co-mingled with DB/history
    fs.cpSync(path.join(webappDir, 'dist'), publicDir, { recursive: true, force: true })
    fs.copyFileSync(path.join(webappDir, 'static.gif'), path.join(publicDir, 'static.gif'))

    app.use(express.static(publicDir, {
        setHeaders: setHlsStaticHeaders
    }))

    app.use('/channels', allowHlsStaticPath, express.static(channelsDir, {
        setHeaders: setHlsStaticHeaders
    }))
}

module.exports = {
    allowHlsStaticPath,
    mountPublicStatic,
    setHlsStaticHeaders
}
