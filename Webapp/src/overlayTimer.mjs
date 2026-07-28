export function showOverlay(setter, timeoutRef, duration = 2000) {
  setter(true)

  if (timeoutRef.current) {
    clearTimeout(timeoutRef.current)
  }

  timeoutRef.current = setTimeout(() => {
    setter(false)
    timeoutRef.current = null
  }, duration)
}
