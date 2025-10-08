const admin = require('firebase-admin')

// Expect GOOGLE_APPLICATION_CREDENTIALS JSON to be provided via env var FIREBASE_ADMIN_SA
// or use the default application credentials available on GitHub Actions when configured.

async function main() {
  const serviceAccount = process.env.FIREBASE_ADMIN_SA
  if (!serviceAccount) {
    console.error('FIREBASE_ADMIN_SA env var not set (expected JSON string)')
    process.exit(2)
  }

  let sa
  try {
    sa = JSON.parse(serviceAccount)
  } catch (e) {
    console.error('Failed to parse FIREBASE_ADMIN_SA JSON', e)
    process.exit(2)
  }

  try {
    admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: process.env.FIREBASE_DB_URL })
  } catch (e) {
    // may already be initialized in CI re-use
  }

  const db = admin.database()
  const now = Date.now()
  const TTL = (process.env.EVICT_TTL_MS ? Number(process.env.EVICT_TTL_MS) : (20 * 60 * 1000))

  console.log('Running eviction; TTL(ms)=', TTL)

  const roomsSnap = await db.ref('/rooms').once('value')
  const rooms = roomsSnap.val() || {}

  const tasks = Object.keys(rooms).map(async roomId => {
    const room = rooms[roomId]
    if (!room || !room.players) return
    const players = room.players
    const updates = {}
    let hasUpdates = false

    Object.keys(players).forEach(pid => {
      const p = players[pid]
      if (!p) return
      // skip host
      if (room.hostId && pid === room.hostId) return
      // skip likely-authenticated players (best-effort)
      if (p.uid || p.authProvider || p.isAuthenticated) return
      const last = p.lastSeen ? Number(p.lastSeen) : 0
      if (!last || (now - last) > TTL) {
        updates[`players/${pid}`] = null
        hasUpdates = true
        console.log(`Evicting stale player ${pid} from room ${roomId}`)
      }
    })

    if (hasUpdates) {
      await db.ref(`/rooms/${roomId}`).update(updates)
      // check if any players remain; if none, remove the room
      const postSnap = await db.ref(`/rooms/${roomId}/players`).once('value')
      const postPlayers = postSnap.val() || {}
      if (!postPlayers || Object.keys(postPlayers).length === 0) {
        console.log(`Removing empty room ${roomId}`)
        await db.ref(`/rooms/${roomId}`).remove()
      }
    }
  })

  await Promise.all(tasks)
  console.log('Eviction complete')
  process.exit(0)
}

main().catch(e => {
  console.error('Eviction script error', e)
  process.exit(1)
})
