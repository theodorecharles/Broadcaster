const Log = require('../Utilities/Log.js')
const { spawn, execSync } = require('child_process')
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

// Check if NVIDIA GPU is available
let hasNvidiaGPU = false
let gpuCheckDone = false

function checkNvidiaGPU() {
    if (gpuCheckDone) return hasNvidiaGPU

    try {
        // Try to run nvidia-smi to detect NVIDIA GPU
        execSync('nvidia-smi', { stdio: 'ignore' })
        hasNvidiaGPU = true
        Log(tag, 'NVIDIA GPU detected - hardware acceleration enabled')
    } catch (error) {
        hasNvidiaGPU = false
        Log(tag, 'No NVIDIA GPU detected - using software encoding')
    }

    gpuCheckDone = true
    return hasNvidiaGPU
}

function buildFFmpegArgs(file, output, channel) {
    const useGPU = checkNvidiaGPU()

    // Base input args with GPU decoding if available
    const inputArgs = useGPU
        ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', file]
        : ['-i', file]

    // Determine video codec and preset based on GPU availability
    let videoCodec = VIDEO_CODEC
    let videoPreset = VIDEO_PRESET
    let videoFilter = VIDEO_FILTER

    if (useGPU && VIDEO_CODEC === 'h264_nvenc') {
        // NVIDIA GPU encoding settings
        videoCodec = 'h264_nvenc'
        // NVENC presets: p1 (fastest) to p7 (slowest/best quality)
        videoPreset = VIDEO_PRESET || 'p4'
        // Use CUDA-accelerated deinterlacing if yadif is specified
        videoFilter = VIDEO_FILTER === 'yadif' ? 'yadif_cuda' : VIDEO_FILTER
    } else if (!useGPU && VIDEO_CODEC === 'h264_nvenc') {
        // Fallback to software encoding if NVENC requested but GPU not available
        videoCodec = 'libx264'
        videoPreset = 'veryfast'
        videoFilter = 'yadif'
        Log(tag, 'GPU requested but not available - falling back to software encoding', channel)
    }

    // Build encoding args
    const encodingArgs = [
        '-vf', `${videoFilter},scale=${DIMENSIONS}`,
        '-c:v', videoCodec,
        '-preset', videoPreset
    ]

    // Add CRF or quality settings based on codec
    if (videoCodec === 'h264_nvenc') {
        encodingArgs.push('-cq', VIDEO_CRF || '23')
        encodingArgs.push('-rc', 'vbr')
        encodingArgs.push('-rc-lookahead', '20')
        encodingArgs.push('-b:v', '0')  // Use CQ mode
    } else {
        encodingArgs.push('-crf', VIDEO_CRF || '23')
    }

    // Common encoding settings
    encodingArgs.push(
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
    )

    return [...inputArgs, ...encodingArgs]
}

function FFMpegSession(channel) {
    const file = channel.queue[channel.currentPlaylistIndex]
    const slug = channel.slug
    const start = Date.now()
    const output = `${CACHE_DIR}/channels/${slug}/_.m3u8`

    const args = buildFFmpegArgs(file, output, channel)

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
