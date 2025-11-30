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
  const [showMenu, setShowMenu] = useState(false)
  const [aspectRatio, setAspectRatio] = useState(() => {
    return localStorage.getItem('tv-aspectRatio') || '16:9'
  })
  const [scanlines, setScanlines] = useState(() => {
    return localStorage.getItem('tv-scanlines') === 'on'
  })
  const [tvSize, setTvSize] = useState({ width: 0, height: 0 })

  // Calculate TV size based on window and aspect ratio
  useEffect(() => {
    const calculateSize = () => {
      const padding = 16 * 2 // 1rem = 16px on each side
      const controlsHeight = 80 // approximate height of controls + gap
      const borderWidth = 40 // 20px border on each side

      const availableWidth = window.innerWidth - padding - borderWidth
      const availableHeight = window.innerHeight - padding - controlsHeight - borderWidth

      const ratio = aspectRatio === '4:3' ? 4 / 3 : 16 / 9

      // Calculate dimensions that fit within available space
      let width = availableWidth
      let height = width / ratio

      if (height > availableHeight) {
        height = availableHeight
        width = height * ratio
      }

      // Cap max width
      if (width > 1200) {
        width = 1200
        height = width / ratio
      }

      setTvSize({ width: Math.floor(width), height: Math.floor(height) })
    }

    calculateSize()
    window.addEventListener('resize', calculateSize)
    return () => window.removeEventListener('resize', calculateSize)
  }, [aspectRatio])

  // Persist settings to localStorage
  useEffect(() => {
    localStorage.setItem('tv-aspectRatio', aspectRatio)
  }, [aspectRatio])

  useEffect(() => {
    localStorage.setItem('tv-scanlines', scanlines ? 'on' : 'off')
  }, [scanlines])

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
          liveDurationInfinity: true,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          maxBufferSize: 60 * 1000 * 1000,
          maxBufferHole: 0.5
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

        // Handle buffer stalls - keep trying to load more content
        hls.on(Hls.Events.BUFFER_EOS, () => {
          console.log('Buffer reached end of stream, reloading...')
          hls.startLoad()
        })

        hlsRef.current = hls

        // Auto-resume if video stalls or pauses unexpectedly
        const video = videoRef.current
        const handleWaiting = () => {
          console.log('Video waiting for data...')
          // Try to resume after a brief moment
          setTimeout(() => {
            if (video.paused) {
              video.play().catch(() => {})
            }
          }, 500)
        }
        const handleStalled = () => {
          console.log('Video stalled, attempting recovery...')
          hls.startLoad()
          video.play().catch(() => {})
        }
        const handleEnded = () => {
          // Live streams shouldn't end - force reload if this happens
          console.log('Video ended unexpectedly, restarting stream...')
          hls.startLoad()
          video.play().catch(() => {})
        }
        const handlePause = () => {
          // Auto-resume if paused unexpectedly (not by user interaction)
          console.log('Video paused, auto-resuming...')
          setTimeout(() => {
            video.play().catch(() => {})
          }, 100)
        }

        video.addEventListener('waiting', handleWaiting)
        video.addEventListener('stalled', handleStalled)
        video.addEventListener('ended', handleEnded)
        video.addEventListener('pause', handlePause)
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
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5
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
    const video = videoRef.current
    if (!video) return

    // iOS Safari uses webkitEnterFullscreen on video element
    if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen()
    } else if (!document.fullscreenElement) {
      video.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  // Menu toggle
  const toggleMenu = () => {
    if (isPoweredOn) {
      setShowMenu(!showMenu)
    }
  }

  // Handle fullscreen changes - prevent pause on iOS when exiting fullscreen
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleFullscreenChange = () => {
      // When exiting fullscreen, resume playback if it was paused
      if (!document.fullscreenElement && !document.webkitFullscreenElement && isPoweredOn) {
        setTimeout(() => {
          if (video.paused) {
            video.play().catch(err => console.log('Resume after fullscreen blocked:', err))
          }
        }, 100)
      }
    }

    const handleWebkitFullscreenChange = () => {
      // iOS Safari specific - resume when exiting fullscreen
      if (!video.webkitDisplayingFullscreen && isPoweredOn) {
        setTimeout(() => {
          if (video.paused) {
            video.play().catch(err => console.log('Resume after fullscreen blocked:', err))
          }
        }, 100)
      }
    }

    // Listen for fullscreen changes
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    video.addEventListener('webkitendfullscreen', handleWebkitFullscreenChange)
    video.addEventListener('webkitbeginfullscreen', handleWebkitFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
      video.removeEventListener('webkitendfullscreen', handleWebkitFullscreenChange)
      video.removeEventListener('webkitbeginfullscreen', handleWebkitFullscreenChange)
    }
  }, [isPoweredOn])

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
        case 'm':
        case 'M':
          toggleMenu()
          break
        case 'Escape':
          setShowMenu(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isPoweredOn, channels, currentChannelIndex, currentVolume, showMenu])

  const currentChannel = channels[currentChannelIndex]

  return (
    <div className="tv-container">
      <div className="video-wrapper">
        <div
          className={`video-content ${powerAnimation || ''}`}
          style={{ width: tvSize.width, height: tvSize.height }}
        >
          <video
            ref={videoRef}
            playsInline
            webkit-playsinline="true"
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

          {showMenu && (
            <div className="tv-menu">
              <h2>SETTINGS</h2>
              <div className="menu-option">
                <span className="menu-label">ASPECT</span>
                <div className="menu-toggle">
                  <button
                    className={aspectRatio === '16:9' ? 'active' : ''}
                    onClick={() => setAspectRatio('16:9')}
                  >
                    16:9
                  </button>
                  <button
                    className={aspectRatio === '4:3' ? 'active' : ''}
                    onClick={() => setAspectRatio('4:3')}
                  >
                    4:3
                  </button>
                </div>
              </div>
              <div className="menu-option">
                <span className="menu-label">SCANLINES</span>
                <div className="menu-toggle">
                  <button
                    className={!scanlines ? 'active' : ''}
                    onClick={() => setScanlines(false)}
                  >
                    OFF
                  </button>
                  <button
                    className={scanlines ? 'active' : ''}
                    onClick={() => setScanlines(true)}
                  >
                    ON
                  </button>
                </div>
              </div>
              <button className="menu-close" onClick={() => setShowMenu(false)}>
                CLOSE
              </button>
            </div>
          )}

          {scanlines && <div className="scanlines-overlay"></div>}
        </div>
      </div>

      <div className="controls">
        <div className={`power-led ${isPoweredOn ? 'on' : ''}`}></div>
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
        <button onClick={toggleMenu} title="Menu">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

export default App
