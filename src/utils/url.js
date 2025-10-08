export function buildRoomUrl(roomId) {
  try {
    const u = new URL(window.location.href)
    u.searchParams.set('room', roomId)
    return u.toString()
  } catch (e) {
    return window.location.origin + '?room=' + roomId
  }
}
