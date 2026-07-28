export function removeEndedListener(listenerRef) {
  const listener = listenerRef.current
  if (!listener) return

  listener.video.removeEventListener('ended', listener.handler)
  listenerRef.current = null
}

export function replaceEndedListener(listenerRef, video, handler) {
  removeEndedListener(listenerRef)
  video.addEventListener('ended', handler)
  listenerRef.current = { video, handler }
}
