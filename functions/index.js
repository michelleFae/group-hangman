const functions = require('firebase-functions')
const admin = require('firebase-admin')

// Initialize app if not already
try {
  admin.initializeApp()
} catch (e) {
  // already initialized
}

const db = admin.database()

// Helper: safe lowercase string
function lc(s) {
  return (s || '').toString().toLowerCase()
}

exports.processGuess = functions.database
  .ref('/rooms/{roomId}/queue/{pushId}')
  .onCreate(async (snapshot, context) => {
    const { roomId, pushId } = context.params
    const entry = snapshot.val()
    if (!entry) return null

    const from = entry.from
    const targetId = entry.target
    const payload = entry.payload || {}
    const value = (payload.value || '').toString().trim()
    if (!from || !targetId || !value) {
      // remove the queue entry and exit
      await snapshot.ref.remove()
      return null
    }

    const roomRef = db.ref(`/rooms/${roomId}`)
    const [roomSnap, playersSnap] = await Promise.all([
      roomRef.once('value'),
      roomRef.child('players').once('value')
    ])

    const room = roomSnap.val() || {}
    const players = playersSnap.val() || {}

    // Basic validation: room should be in playing phase
    if (room.phase !== 'playing') {
      await snapshot.ref.remove()
      return null
    }

    const turnOrder = room.turnOrder || []
    const currentIndex = typeof room.currentTurnIndex === 'number' ? room.currentTurnIndex : 0
    const currentPlayerId = turnOrder[currentIndex]

    if (currentPlayerId !== from) {
      // Not the guesser's turn anymore; drop the entry
      await snapshot.ref.remove()
      return null
    }

    if (targetId === from) {
      await snapshot.ref.remove()
      return null
    }

    const target = players[targetId]
    const guesser = players[from]
    if (!target || !guesser) {
      await snapshot.ref.remove()
      return null
    }

  const updates = {}
  const hangDeltas = {}
    const isLetter = value.length === 1

  // baseline: give a small reward for taking a turn; may be overridden for correct actions
  const prevHang = typeof guesser.hangmoney === 'number' ? guesser.hangmoney : 0
  let hangIncrement = 1

  // we'll write hangmoney once into updates at the end of processing

      if (isLetter) {
      const letter = lc(value)
      const word = lc(target.word || '')
      if (!word) {
        await snapshot.ref.remove()
        return null
      }

      let count = 0
      for (let ch of word) if (ch === letter) count++

      const prevRevealed = Array.isArray(target.revealed) ? target.revealed.slice() : []

      if (count > 0) {
        const existing = prevRevealed.filter(x => x === letter).length
        const toAdd = Math.max(0, count - existing)

        if (toAdd > 0) {
          // reveal newly found occurrences only
          for (let i = 0; i < toAdd; i++) prevRevealed.push(letter)
          updates[`players/${targetId}/revealed`] = prevRevealed

          // award 2 hangmoney per newly revealed occurrence (as a delta)
          hangDeltas[from] = (hangDeltas[from] || 0) + (2 * toAdd)

          // record or aggregate private hit for guesser
          const prevHits = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId].slice() : []
          let merged = false
          for (let i = 0; i < prevHits.length; i++) {
            const h = prevHits[i]
            if (h && h.type === 'letter' && h.letter === letter) {
              prevHits[i] = { ...h, count: (Number(h.count) || 0) + toAdd, ts: Date.now() }
              merged = true
              break
            }
          }
          if (!merged) prevHits.push({ type: 'letter', letter, count: toAdd, ts: Date.now() })
          updates[`players/${from}/privateHits/${targetId}`] = prevHits
        } else {
          // letter was already fully revealed — treat this as a wrong guess
          const prevWrong = (guesser.privateWrong && guesser.privateWrong[targetId]) ? guesser.privateWrong[targetId].slice() : []
          if (!prevWrong.includes(letter)) {
            prevWrong.push(letter)
            updates[`players/${from}/privateWrong/${targetId}`] = prevWrong
            // reward the target for a wrong guess against them (delta)
            hangDeltas[targetId] = (hangDeltas[targetId] || 0) + 2
          }
        }
        // update guessedBy for owner visibility (only add guesser once)
        const prevGuessedByForLetter = (target.guessedBy && target.guessedBy[letter]) ? target.guessedBy[letter].slice() : []
        if (!prevGuessedByForLetter.includes(from)) prevGuessedByForLetter.push(from)
        updates[`players/${targetId}/guessedBy/${letter}`] = prevGuessedByForLetter
      } else {
        // letter not in word: wrong guess
        const prevWrong = (guesser.privateWrong && guesser.privateWrong[targetId]) ? guesser.privateWrong[targetId].slice() : []
        if (!prevWrong.includes(letter)) {
          prevWrong.push(letter)
          updates[`players/${from}/privateWrong/${targetId}`] = prevWrong
          // reward the target for a wrong guess against them
          hangDeltas[targetId] = (hangDeltas[targetId] || 0) + 2
        }
      }
    } else {
      const guessWord = lc(value)
      const targetWord = lc(target.word || '')
      if (!targetWord) {
        await snapshot.ref.remove()
        return null
      }

      if (guessWord === targetWord) {
        // correct word: reveal all unique letters, award hangmoney, eliminate
        const uniqueLetters = Array.from(new Set(targetWord.split('')))
        updates[`players/${targetId}/revealed`] = uniqueLetters

  // correct word: award +5 as a delta
  hangDeltas[from] = (hangDeltas[from] || 0) + 5

        // mark eliminated and add guessedBy for word
        updates[`players/${targetId}/eliminated`] = true
        const prevWordGuessedBy = (target.guessedBy && target.guessedBy['__word']) ? target.guessedBy['__word'].slice() : []
        if (!prevWordGuessedBy.includes(from)) prevWordGuessedBy.push(from)
        updates[`players/${targetId}/guessedBy/__word`] = prevWordGuessedBy

        // record private hit for guesser
  const prevHits = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId].slice() : []
        prevHits.push({ type: 'word', word: guessWord, ts: Date.now() })
        updates[`players/${from}/privateHits/${targetId}`] = prevHits

        // remove from turnOrder and adjust currentTurnIndex
        const newTurnOrder = (room.turnOrder || []).filter(id => id !== targetId)
        updates[`turnOrder`] = newTurnOrder
        // adjust currentTurnIndex to safe value
        let adjustedIndex = currentIndex
        const removedIndex = (room.turnOrder || []).indexOf(targetId)
        if (removedIndex !== -1 && removedIndex <= currentIndex) adjustedIndex = Math.max(0, adjustedIndex - 1)
        updates[`currentTurnIndex`] = adjustedIndex
      } else {
        // wrong word guess: record private wrong word
        const prevWrongWords = (guesser.privateWrongWords && guesser.privateWrongWords[targetId]) ? guesser.privateWrongWords[targetId].slice() : []
        prevWrongWords.push(value)
        updates[`players/${from}/privateWrongWords/${targetId}`] = prevWrongWords
        // reward the target for a wrong full-word guess
        // reward the target for a wrong full-word guess (delta)
        hangDeltas[targetId] = (hangDeltas[targetId] || 0) + 2
      }
    }

    // advance turn. If we modified turnOrder above (e.g., removed an eliminated player) prefer that.
    const activeTurnOrder = updates.turnOrder || room.turnOrder || []
    if (activeTurnOrder.length > 0) {
      const nextIndex = (currentIndex + 1) % activeTurnOrder.length
      updates[`currentTurnIndex`] = nextIndex
      updates[`currentTurnStartedAt`] = Date.now()
    }

    // if we still have the baseline hangIncrement for the guesser, apply it as a delta
    if ((hangDeltas[from] || 0) === 0 && hangIncrement) {
      hangDeltas[from] = (hangDeltas[from] || 0) + hangIncrement
    }

    // write updates and hangDeltas atomically in a transaction to avoid races with timeouts
    if (Object.keys(updates).length > 0 || Object.keys(hangDeltas).length > 0) {
      await roomRef.transaction(curr => {
        if (!curr) return curr
        // apply path-based updates (keys like 'players/<id>/revealed' or 'turnOrder')
        Object.keys(updates).forEach(path => {
          try {
            const parts = path.split('/')
            let node = curr
            for (let i = 0; i < parts.length - 1; i++) {
              const p = parts[i]
              if (!node[p]) node[p] = {}
              node = node[p]
            }
            const last = parts[parts.length - 1]
            node[last] = updates[path]
          } catch (e) {
            // ignore path set errors
          }
        })

        // apply hangDeltas safely
        if (!curr.players) curr.players = {}
        Object.keys(hangDeltas).forEach(pid => {
          if (!curr.players[pid]) curr.players[pid] = {}
          const prev = typeof curr.players[pid].hangmoney === 'number' ? curr.players[pid].hangmoney : 0
          curr.players[pid].hangmoney = Math.max(0, prev + (hangDeltas[pid] || 0))
        })

        return curr
      })
    }

    // remove processed queue item
    await snapshot.ref.remove()

    return null
  })


// Scheduled safety: every minute, advance any timed-out turns and apply penalty
exports.advanceTimedTurns = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
  console.log('advanceTimedTurns tick', new Date().toISOString())
  const roomsSnap = await db.ref('/rooms').once('value')
  const rooms = roomsSnap.val() || {}
  const now = Date.now()

  const promises = Object.keys(rooms).map(async roomId => {
    const room = rooms[roomId]
    try {
      if (!room) return
      if (room.phase !== 'playing') return
      if (!room.timed || !room.turnTimeoutSeconds || !room.currentTurnStartedAt) return
      const expireAt = (room.currentTurnStartedAt || 0) + (room.turnTimeoutSeconds * 1000)
      if (expireAt > now) return // not expired yet

      // run a transaction to advance turn atomically and deduct penalty
      const roomRef = db.ref(`/rooms/${roomId}`)
      await roomRef.transaction(curr => {
        if (!curr) return curr
        if (curr.phase !== 'playing') return curr
        if (!curr.timed || !curr.turnTimeoutSeconds || !curr.currentTurnStartedAt) return curr
        const exp = (curr.currentTurnStartedAt || 0) + (curr.turnTimeoutSeconds * 1000)
        if (exp > Date.now()) return curr // already updated by someone else

        const turnOrder = curr.turnOrder || []
        if (!turnOrder || turnOrder.length === 0) return curr
        const currentIndex = typeof curr.currentTurnIndex === 'number' ? curr.currentTurnIndex : 0
        const timedOutPlayerId = turnOrder[currentIndex]

        // advance index
        const nextIndex = (currentIndex + 1) % turnOrder.length

        // if a timeout for this same turn already exists, skip to avoid duplicate penalties
        const existingTimeouts = curr.timeouts || {}
        const alreadyRecordedForTurn = Object.keys(existingTimeouts).some(k => {
          try {
            const te = existingTimeouts[k]
            // if the existing timeout records the originating turn start, compare to avoid double-applying
            return te && te.player === timedOutPlayerId && te.turnStartedAt && te.turnStartedAt === curr.currentTurnStartedAt
          } catch (e) { return false }
        })
        if (alreadyRecordedForTurn) return curr

        // deduct penalty of 2 hangmoney from timed out player (min 0)
        const playerNode = (curr.players && curr.players[timedOutPlayerId]) || {}
        const prevHang = typeof playerNode.hangmoney === 'number' ? playerNode.hangmoney : 0
        const newHang = Math.max(0, prevHang - 2)

        // apply updates
        if (!curr.players) curr.players = {}
        if (!curr.players[timedOutPlayerId]) curr.players[timedOutPlayerId] = {}
        curr.players[timedOutPlayerId].hangmoney = newHang
        curr.currentTurnIndex = nextIndex
        curr.currentTurnStartedAt = Date.now()

  // optionally log timeout event and include the originating turn start timestamp
  if (!curr.timeouts) curr.timeouts = {}
  const tkey = `t_${Date.now()}`
  curr.timeouts[tkey] = { player: timedOutPlayerId, deducted: 2, ts: Date.now(), turnStartedAt: curr.currentTurnStartedAt }

        return curr
      })
    } catch (e) {
      console.error('advanceTimedTurns error for', roomId, e)
    }
  })

  await Promise.all(promises)
  return null
})


// Scheduled cleanup: remove anonymous players that haven't been seen for 20 minutes
exports.evictStalePlayers = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
  console.log('evictStalePlayers tick', new Date().toISOString())
  const roomsSnap = await db.ref('/rooms').once('value')
  const rooms = roomsSnap.val() || {}
  const now = Date.now()
  const TTL = 20 * 60 * 1000 // 20 minutes

  const tasks = Object.keys(rooms).map(async roomId => {
    const room = rooms[roomId]
    if (!room || !room.players) return
    const players = room.players
    const updates = {}
    let hasUpdates = false

    Object.keys(players).forEach(pid => {
      const p = players[pid]
      // skip host
      if (room.hostId && pid === room.hostId) return
      // prefer to skip authenticated users: if there's a uid/auth marker, don't evict
      // best-effort: many authenticated users will have an id that matches a Firebase UID
      // and may have additional metadata; if the node contains a field like `authProvider` or `uid` we avoid deleting.
      if (p && (p.uid || p.authProvider || p.isAuthenticated)) return

      const last = (p && p.lastSeen) ? Number(p.lastSeen) : 0
      if (!last || (now - last) > TTL) {
        // mark for deletion
        updates[`players/${pid}`] = null
        hasUpdates = true
        console.log(`Evicting stale player ${pid} from room ${roomId}`)
      }
    })

    if (hasUpdates) {
      try {
        await db.ref(`/rooms/${roomId}`).update(updates)
        // after applying deletions, check if any players remain; if none, remove the room
        const postSnap = await db.ref(`/rooms/${roomId}/players`).once('value')
        const postPlayers = postSnap.val() || {}
        if (!postPlayers || Object.keys(postPlayers).length === 0) {
          console.log(`Removing empty room ${roomId}`)
          await db.ref(`/rooms/${roomId}`).remove()
        } else {
          // if host was removed and current hostId is missing, pick a new host
          const rootSnap = await db.ref(`/rooms/${roomId}`).once('value')
          const root = rootSnap.val() || {}
          if (root && root.hostId && !postPlayers[root.hostId]) {
            const candidate = Object.keys(postPlayers)[0]
            console.log(`Transferring host for room ${roomId} to ${candidate}`)
            await db.ref(`/rooms/${roomId}`).update({ hostId: candidate })
          }
        }
      } catch (e) {
        console.error('Failed to evict stale players for', roomId, e)
      }
    }
  })

  await Promise.all(tasks)
  return null
})
