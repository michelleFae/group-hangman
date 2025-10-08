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

    const isLetter = value.length === 1

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
      const already = prevRevealed.includes(letter)

      if (count > 0 && !already) {
        // correct letter
        prevRevealed.push(letter)
        updates[`players/${targetId}/revealed`] = prevRevealed

        const prevHang = typeof guesser.hangmoney === 'number' ? guesser.hangmoney : 0
        updates[`players/${from}/hangmoney`] = prevHang + 2

        // update guessedBy for owner visibility
        const prevGuessedByForLetter = (target.guessedBy && target.guessedBy[letter]) ? target.guessedBy[letter].slice() : []
        if (!prevGuessedByForLetter.includes(from)) prevGuessedByForLetter.push(from)
        updates[`players/${targetId}/guessedBy/${letter}`] = prevGuessedByForLetter

        // record private hit for guesser
        const prevHits = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId].slice() : []
        prevHits.push({ type: 'letter', letter, count, ts: Date.now() })
        updates[`players/${from}/privateHits/${targetId}`] = prevHits
      } else {
        // wrong or already guessed
        const prevWrong = (guesser.privateWrong && guesser.privateWrong[targetId]) ? guesser.privateWrong[targetId].slice() : []
        if (!prevWrong.includes(letter)) {
          prevWrong.push(letter)
          updates[`players/${from}/privateWrong/${targetId}`] = prevWrong
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

        const prevHang = typeof guesser.hangmoney === 'number' ? guesser.hangmoney : 0
        updates[`players/${from}/hangmoney`] = prevHang + 5

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
      }
    }

    // advance turn
    const activeTurnOrder = room.turnOrder || []
    if (activeTurnOrder.length > 0) {
      const nextIndex = (currentIndex + 1) % activeTurnOrder.length
      updates[`currentTurnIndex`] = nextIndex
    }

    // write updates atomically at /rooms/{roomId}
    if (Object.keys(updates).length > 0) {
      await roomRef.update(updates)
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

        // optionally log timeout event
        if (!curr.timeouts) curr.timeouts = {}
        const tkey = `t_${Date.now()}`
        curr.timeouts[tkey] = { player: timedOutPlayerId, deducted: 2, ts: Date.now() }

        return curr
      })
    } catch (e) {
      console.error('advanceTimedTurns error for', roomId, e)
    }
  })

  await Promise.all(promises)
  return null
})
