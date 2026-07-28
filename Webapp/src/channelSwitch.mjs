export function cancelChannelSwitch(timeoutRef) {
  if (timeoutRef.current === null) return

  clearTimeout(timeoutRef.current)
  timeoutRef.current = null
}

export function scheduleChannelSwitch(timeoutRef, callback, delay = 500) {
  cancelChannelSwitch(timeoutRef)

  const timeoutId = setTimeout(() => {
    if (timeoutRef.current !== timeoutId) return

    timeoutRef.current = null
    callback()
  }, delay)

  timeoutRef.current = timeoutId
}
