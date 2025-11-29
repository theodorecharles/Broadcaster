import { useState, useEffect, useRef } from 'react'
import Hls from 'hls.js'
import './App.css'

function App() {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const overlayTimeoutRef = useRef(null)

  const [channels, setChannels] = useState([])
  const [currentChannelIndex, setCurrentChannelIndex] = useState(-1)
  const [isPoweredOn, setIsPoweredOn] = useState(false)
  const [currentVolume, setCurrentVolume] = useState(1.0)
  const [showStatic, setShowStatic] = useState(false)
  const [showChannelOverlay, setShowChannelOverlay] = useState(false)
  const [showVolumeOverlay, setShowVolumeOverlay] = useState(false)
  const [powerAnimation, setPowerAnimation] = useState(null)

  // Load channels
  useEffect(() => {
    fetch('/manifest.json')
      .then(res => res.json())
      .then(data => {
        setChannels(data.channels)
        console.log('Channels loaded:', data.channels)
      })
      .catch(err => console.error('Failed to load channels:', err))
  }, [])

  // Show overlay helper
  const showOverlay = (setter, duration = 2000) => {
    setter(true)
    if (overlayTimeoutRef.current) clearTimeout(overlayTimeoutRef.current)
    overlayTimeoutRef.current = setTimeout(() => setter(false), duration)
  }

  // Change channel
  const changeChannel = (index) => {
    if (index < 0 || index >= channels.length || !isPoweredOn) return

    setCurrentChannelIndex(index)
    const channel = channels[index]

    // Show static during channel change
    setShowStatic(true)

    // Stop current stream
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    // Update display
    showOverlay(setShowChannelOverlay)

    // Load new channel after brief delay
    setTimeout(() => {
      const playlistUrl = `/${channel.slug}.m3u8`

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          liveDurationInfinity: true
        })

        hls.loadSource(playlistUrl)
        hls.attachMedia(videoRef.current)

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoRef.current.play().catch(err => console.log('Autoplay blocked:', err))
          setShowStatic(false)
        })

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.error('HLS Error:', data)
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.log('Network error, trying to recover...')
                hls.startLoad()
                break
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.log('Media error, trying to recover...')
                hls.recoverMediaError()
                break
              default:
                setShowStatic(true)
                break
            }
          }
        })

        hlsRef.current = hls
      } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
        videoRef.current.src = playlistUrl
        videoRef.current.play().catch(err => console.log('Autoplay blocked:', err))
        setShowStatic(false)
      }

      videoRef.current.volume = currentVolume
    }, 500)
  }

  // Channel navigation
  const channelUp = () => {
    if (!isPoweredOn || channels.length === 0) return
    const nextIndex = (currentChannelIndex + 1) % channels.length
    changeChannel(nextIndex)
  }

  const channelDown = () => {
    if (!isPoweredOn || channels.length === 0) return
    const prevIndex = currentChannelIndex <= 0 ? channels.length - 1 : currentChannelIndex - 1
    changeChannel(prevIndex)
  }

  // Volume control
  const volumeUp = () => {
    if (!isPoweredOn) return
    const newVolume = Math.min(1.0, currentVolume + 0.1)
    setCurrentVolume(newVolume)
    if (videoRef.current) videoRef.current.volume = newVolume
    showOverlay(setShowVolumeOverlay, 1500)
  }

  const volumeDown = () => {
    if (!isPoweredOn) return
    const newVolume = Math.max(0, currentVolume - 0.1)
    setCurrentVolume(newVolume)
    if (videoRef.current) videoRef.current.volume = newVolume
    showOverlay(setShowVolumeOverlay, 1500)
  }

  // Play static channel
  const playStaticChannel = () => {
    const playlistUrl = '/channels/static/_.m3u8'

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90
      })

      hls.loadSource(playlistUrl)
      hls.attachMedia(videoRef.current)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoRef.current.play().catch(err => console.log('Autoplay blocked:', err))
        setShowStatic(false)
      })

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.error('HLS Error:', data)
          setShowStatic(true)
        }
      })

      hlsRef.current = hls
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.current.src = playlistUrl
      videoRef.current.play().catch(err => console.log('Autoplay blocked:', err))
      setShowStatic(false)
    }

    videoRef.current.volume = currentVolume
  }

  // Power toggle
  const togglePower = () => {
    if (isPoweredOn) {
      // Power off
      setIsPoweredOn(false)
      setPowerAnimation('power-off')

      setTimeout(() => {
        if (hlsRef.current) {
          hlsRef.current.destroy()
          hlsRef.current = null
        }
        if (videoRef.current) videoRef.current.pause()
        setShowStatic(false)
        setCurrentChannelIndex(-1)
      }, 500)
    } else {
      // Power on - play static channel first
      setIsPoweredOn(true)
      setPowerAnimation('power-on')

      setTimeout(() => {
        playStaticChannel()
      }, 500)
    }
  }

  // Fullscreen
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      videoRef.current?.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          channelUp()
          break
        case 'ArrowDown':
          e.preventDefault()
          channelDown()
          break
        case 'ArrowRight':
          e.preventDefault()
          volumeUp()
          break
        case 'ArrowLeft':
          e.preventDefault()
          volumeDown()
          break
        case 'f':
        case 'F':
          toggleFullscreen()
          break
        case 'p':
        case 'P':
          togglePower()
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isPoweredOn, channels, currentChannelIndex, currentVolume])

  const currentChannel = channels[currentChannelIndex]

  return (
    <div className="tv-container">
      <div className="video-wrapper">
        <div className={`video-content ${powerAnimation || ''}`}>
          <video
            ref={videoRef}
            onClick={() => videoRef.current.muted = false}
            style={{ display: showStatic ? 'none' : 'block' }}
          />
          <img
            src="static.gif"
            alt="Static"
            className="static-gif"
            style={{ display: showStatic ? 'block' : 'none' }}
          />

          <div className={`channel-overlay ${showChannelOverlay ? 'show' : ''}`}>
            CH {currentChannelIndex + 1}
          </div>

          <div className={`channel-name ${showChannelOverlay ? 'show' : ''}`}>
            {currentChannel?.name.toUpperCase() || 'LOADING...'}
          </div>

          <div className={`volume-overlay ${showVolumeOverlay ? 'show' : ''}`}>
            <span>VOL</span>
            <div className="volume-bar">
              <div
                className="volume-fill"
                style={{ width: `${Math.round(currentVolume * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="controls">
        <button
          className={`power-btn ${isPoweredOn ? 'on' : ''}`}
          onClick={togglePower}
          title="Power"
        >
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={channelDown} title="Channel Down">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M7 10l5 5 5-5z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={channelUp} title="Channel Up">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M7 14l5-5 5 5z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={volumeDown} title="Volume Down">
          <svg viewBox="0 0 28 24" width="28" height="24">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>
            <path d="M23 12h-6v-2h6v2z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={volumeUp} title="Volume Up">
          <svg viewBox="0 0 28 24" width="28" height="24">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>
            <path d="M23 11h-2V9h-2v2h-2v2h2v2h2v-2h2z" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={toggleFullscreen} title="Fullscreen">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

export default App
