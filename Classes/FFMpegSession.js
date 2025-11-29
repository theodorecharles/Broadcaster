const Log = require('../Utilities/Log.js')
const { spawn } = require('child_process')
const { CACHE_DIR } = process.env
const tag = 'FFMpegSession'

const { VIDEO_CODEC,
        VIDEO_CRF,
        VIDEO_PRESET,
        VIDEO_FILTER,
        AUDIO_CODEC,
        AUDIO_BITRATE,
        HLS_SEGMENT_LENGTH_SECONDS,
        DIMENSIONS } = process.env

function FFMpegSession(channel) {
    const file = channel.queue[channel.currentPlaylistIndex]
    const slug = channel.slug
    const start = Date.now()
    const output = `${CACHE_DIR}/broadcaster/channels/${slug}/_.m3u8`

    const args = [
        '-i', file,
        '-vf', VIDEO_FILTER,
        '-s', DIMENSIONS,
        '-c:v', VIDEO_CODEC,
        '-preset', VIDEO_PRESET,
        '-crf', VIDEO_CRF,
        '-profile:v', 'main',
        '-level', '3.1',
        '-pix_fmt', 'yuv420p',
        '-c:a', AUDIO_CODEC,
        '-b:a', AUDIO_BITRATE,
        '-ac', '2',
        '-hls_time', HLS_SEGMENT_LENGTH_SECONDS,
        '-hls_flags', 'append_list',
        '-hls_start_number_source', 'datetime',
        '-hls_playlist_type', 'event',
        '-f', 'hls',
        output
    ]

    const ffmpeg = spawn('ffmpeg', args)

    // Log start
    if (channel.currentPlaylistIndex == 0) channel.startTime = Date.now()
    Log(tag, `FFMpeg started encoding ${file}.`, channel)

    let stderrData = ''

    ffmpeg.stdout.on('data', (data) => {
        // FFmpeg outputs to stderr, not stdout
    })

    ffmpeg.stderr.on('data', (data) => {
        stderrData += data.toString()
    })

    ffmpeg.on('close', (code) => {
        if (code === 0) {
            channel.currentPlaylistIndex++
            Log(tag, `FFMpeg finished encoding ${file} in ${(Date.now() - start)/1000} seconds.`, channel)
        } else {
            Log(tag, `FFMpeg produced an error (exit code ${code}), so we're skipping to next file.`, channel)
            Log(tag, `Error output: ${stderrData}`, channel)
            channel.currentPlaylistIndex++
            if (channel.segmenter) {
                channel.segmenter.advance()
            }
        }
    })

    ffmpeg.on('error', (err) => {
        Log(tag, `Failed to start FFMpeg: ${err.message}`, channel)
        channel.currentPlaylistIndex++
        if (channel.segmenter) {
            channel.segmenter.advance()
        }
    })
}

module.exports = {
    FFMpegSession: FFMpegSession
}
