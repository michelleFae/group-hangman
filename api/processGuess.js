const admin = require('firebase-admin')

// Initialize admin with service account provided via env var FIREBASE_SERVICE_ACCOUNT
function initAdmin() {
  if (admin.apps && admin.apps.length > 0) return
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.SERVICE_ACCOUNT
  if (!svc) {
    console.error('Missing FIREBASE_SERVICE_ACCOUNT env var')
    return
  }
  let parsed = null
  try {
    // support base64-encoded JSON or raw JSON
    if (svc.trim().startsWith('{')) parsed = JSON.parse(svc)
    else parsed = JSON.parse(Buffer.from(svc, 'base64').toString('utf8'))
  } catch (e) {
    console.error('Failed to parse service account JSON', e)
    return
  }
  admin.initializeApp({ credential: admin.credential.cert(parsed), databaseURL: process.env.FIREBASE_DATABASE_URL })
}

initAdmin()

const db = admin.database()

const lc = s => (s || '').toString().toLowerCase()

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

  if (!admin.apps || admin.apps.length === 0) {
    return res.status(500).json({ error: 'Server not configured. Set FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL.' })
  }

  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace(/^Bearer\s*/i, '')
  if (!token) return res.status(401).json({ error: 'Missing auth token' })

  let decoded
  try {
    decoded = await admin.auth().verifyIdToken(token)
  } catch (e) {
    return res.status(401).json({ error: 'Invalid auth token', detail: e.message })
  }

  const body = req.body || {}
  const roomId = body.roomId
  const targetId = body.targetId
  const value = (body.value || '').toString().trim()
  if (!roomId || !targetId || !value) return res.status(400).json({ error: 'Missing roomId, targetId or value' })

  const from = decoded.uid

  try {
    const roomRef = db.ref(`/rooms/${roomId}`)
    const [roomSnap, playersSnap] = await Promise.all([roomRef.once('value'), roomRef.child('players').once('value')])
    const room = roomSnap.val() || {}
    const players = playersSnap.val() || {}

    if (room.phase !== 'playing') return res.status(400).json({ error: 'Room not in playing phase' })

    const turnOrder = room.turnOrder || []
    const currentIndex = typeof room.currentTurnIndex === 'number' ? room.currentTurnIndex : 0
    const currentPlayerId = turnOrder[currentIndex]
    console.log("Turn check:", { currentPlayerId, from, turnOrder, currentIndex })
    if (currentPlayerId !== from) return res.status(500).json({ error: 'sell' })
    if (targetId === from) return res.status(400).json({ error: 'Cannot guess your own word' })

    const target = players[targetId]
    const guesser = players[from]
    if (!target || !guesser) return res.status(400).json({ error: 'Target or guesser not found' })

    const updates = {}
    const isLetter = value.length === 1

    if (isLetter) {
      const letter = lc(value)
      const word = lc(target.word || '')
      if (!word) return res.status(400).json({ error: 'Target has no word yet' })

      // Block guesses against frozen targets
      if (target && (target.frozen || (typeof target.frozenUntilTurnIndex !== 'undefined' && target.frozenUntilTurnIndex !== null))) {
        return res.status(400).json({ error: 'Target is frozen and cannot be guessed right now' })
      }

      let count = 0
      for (let ch of word) if (ch === letter) count++

      const prevRevealed = Array.isArray(target.revealed) ? target.revealed.slice() : []

      if (count > 0) {
        const existing = prevRevealed.filter(x => x === letter).length
        const toAdd = Math.max(0, count - existing)

        if (toAdd > 0) {
          // reveal newly found occurrences only and award for those
          for (let i = 0; i < toAdd; i++) prevRevealed.push(letter)
          updates[`players/${targetId}/revealed`] = prevRevealed
          // If this letter was marked as a no-score reveal (e.g., from a power-up), do not award wordmoney
          let noScore = target.noScoreReveals && target.noScoreReveals[letter]
          // Also treat as no-score if the guesser already had this letter privately recorded
          try {
            const prevHitsForTarget = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId] : []
            if (Array.isArray(prevHitsForTarget) && prevHitsForTarget.some(h => h && h.type === 'letter' && ((h.letter || '').toLowerCase() === letter))) {
              noScore = true
            }
          } catch (e) {}
          if (!noScore) {
            // Base award for correct letter(s)
            const prevHang = typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0
            let award = (2 * toAdd)

            // Apply double-down bonus if the guesser staked
            const dd = guesser.doubleDown
            if (dd && dd.active) {
              const stake = Number(dd.stake) || 0
              if (stake > 0) {
                const extraMultiplier = (toAdd >= 4) ? 4 : 2
                const extra = stake * extraMultiplier
                award += extra
                // consume the doubleDown entry after use
                updates[`players/${from}/doubleDown`] = null
              }
            }
            updates[`players/${from}/wordmoney`] = prevHang + award

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
            // still reveal publicly but don't award points; add a private note for the guesser
            const prevHits = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId].slice() : []
            prevHits.push({ type: 'letter', letter, count: toAdd, ts: Date.now(), note: 'no-score' })
            updates[`players/${from}/privateHits/${targetId}`] = prevHits
          }
        } else {
          // letter was already fully revealed — treat this as a wrong guess
          const prevWrong = (guesser.privateWrong && guesser.privateWrong[targetId]) ? guesser.privateWrong[targetId].slice() : []
          if (!prevWrong.includes(letter)) {
            prevWrong.push(letter)
            updates[`players/${from}/privateWrong/${targetId}`] = prevWrong
            // reward the target for a wrong guess against them — unless they have an active hang shield
            const prevTargetHang = typeof target.wordmoney === 'number' ? target.wordmoney : 0
            const shield = target.hangShield
            if (shield && shield.active) {
              // consume the shield but do not award wordmoney
              updates[`players/${targetId}/hangShield`] = null
            } else {
              updates[`players/${targetId}/wordmoney`] = prevTargetHang + 2
            }

            // If the guesser had an active doubleDown, they lose their stake on a wrong guess
            const ddFail = guesser.doubleDown
            if (ddFail && ddFail.active) {
              const stake = Number(ddFail.stake) || 0
              if (stake > 0) {
                const prevGHang = typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0
                updates[`players/${from}/wordmoney`] = Math.max(0, prevGHang - stake)
              }
              updates[`players/${from}/doubleDown`] = null
            }
          }
        }

        const prevGuessedByForLetter = (target.guessedBy && target.guessedBy[letter]) ? target.guessedBy[letter].slice() : []
        if (!prevGuessedByForLetter.includes(from)) prevGuessedByForLetter.push(from)
        updates[`players/${targetId}/guessedBy/${letter}`] = prevGuessedByForLetter
      } else {
        const prevWrong = (guesser.privateWrong && guesser.privateWrong[targetId]) ? guesser.privateWrong[targetId].slice() : []
        if (!prevWrong.includes(letter)) {
          prevWrong.push(letter)
          updates[`players/${from}/privateWrong/${targetId}`] = prevWrong
        }
      }
      } else {
      const guessWord = lc(value)
      const targetWord = lc(target.word || '')
      if (!targetWord) return res.status(400).json({ error: 'Target has no word yet' })

        // Block guesses against frozen targets
        if (target && (target.frozen || (typeof target.frozenUntilTurnIndex !== 'undefined' && target.frozenUntilTurnIndex !== null))) {
          return res.status(400).json({ error: 'Target is frozen and cannot be guessed right now' })
        }

      if (guessWord === targetWord) {
        const uniqueLetters = Array.from(new Set(targetWord.split('')))
        updates[`players/${targetId}/revealed`] = uniqueLetters
        const prevHang = typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0
        updates[`players/${from}/wordmoney`] = prevHang + 5
  updates[`players/${targetId}/eliminated`] = true
  // record elimination timestamp for client ordering
  updates[`players/${targetId}/eliminatedAt`] = Date.now()
        const prevWordGuessedBy = (target.guessedBy && target.guessedBy['__word']) ? target.guessedBy['__word'].slice() : []
        if (!prevWordGuessedBy.includes(from)) prevWordGuessedBy.push(from)
        updates[`players/${targetId}/guessedBy/__word`] = prevWordGuessedBy
        const prevHits = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId].slice() : []
        prevHits.push({ type: 'word', word: guessWord, ts: Date.now() })
        updates[`players/${from}/privateHits/${targetId}`] = prevHits

        const newTurnOrder = (room.turnOrder || []).filter(id => id !== targetId)
        updates[`turnOrder`] = newTurnOrder
        let adjustedIndex = currentIndex
        const removedIndex = (room.turnOrder || []).indexOf(targetId)
        if (removedIndex !== -1 && removedIndex <= currentIndex) adjustedIndex = Math.max(0, adjustedIndex - 1)
  updates[`currentTurnIndex`] = adjustedIndex
  updates[`currentTurnStartedAt`] = Date.now()
      } else {
        const prevWrongWords = (guesser.privateWrongWords && guesser.privateWrongWords[targetId]) ? guesser.privateWrongWords[targetId].slice() : []
        prevWrongWords.push(value)
        updates[`players/${from}/privateWrongWords/${targetId}`] = prevWrongWords

        // If the guesser had an active doubleDown, they lose their stake on a wrong guess
        const ddFailWord = guesser.doubleDown
        if (ddFailWord && ddFailWord.active) {
          const stake = Number(ddFailWord.stake) || 0
          if (stake > 0) {
            const prevGHang = typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0
            updates[`players/${from}/wordmoney`] = Math.max(0, prevGHang - stake)
          }
          updates[`players/${from}/doubleDown`] = null
        }
      }
    }

    // advance turn only if we haven't already set currentTurnIndex above
    // if we modified the turnOrder (e.g. eliminated a player) prefer that new order
    if (!Object.prototype.hasOwnProperty.call(updates, 'currentTurnIndex')) {
      const effectiveTurnOrder = updates.hasOwnProperty('turnOrder') ? updates['turnOrder'] : (room.turnOrder || [])
      if (effectiveTurnOrder.length > 0) {
        const nextIndex = (currentIndex + 1) % effectiveTurnOrder.length
        updates[`currentTurnIndex`] = nextIndex
        updates[`currentTurnStartedAt`] = Date.now()
        // award +1 wordmoney to the player whose turn just started
        try {
          const nextPlayer = effectiveTurnOrder[nextIndex]
          const prevNextHang = (players && players[nextPlayer] && typeof players[nextPlayer].wordmoney === 'number') ? players[nextPlayer].wordmoney : 0
          updates[`players/${nextPlayer}/wordmoney`] = prevNextHang + 1
        } catch (e) {}
      }
    }

    if (Object.keys(updates).length > 0) await roomRef.update(updates)

    // Check if only one player remains uneliminated
    const freshPlayersSnap = await roomRef.child('players').once('value')
    const freshPlayers = freshPlayersSnap.val() || {}
    const alive = Object.values(freshPlayers).filter(p => !p.eliminated)
  if (alive.length === 1) {
    let winner = alive[0]
    // if the room prefers winner by wordmoney, pick the richest player among all players
    if (room && room.winnerByWordmoney) {
      const all = Object.values(freshPlayers)
      all.sort((a,b) => (b.wordmoney || 0) - (a.wordmoney || 0))
      winner = all[0] || winner
    }
    const gameOverUpdates = {
      phase: 'ended',
      winnerId: winner.id || null,
      winnerName: winner.name || 'Unknown',
      endedAt: Date.now()
    }
    await roomRef.update(gameOverUpdates)
    console.log("Game over — winner:", winner.name)

    return res.status(200).json({ ok: true })
  }
  } catch (err) {
    console.error('processGuess error', err)
    return res.status(500).json({ error: err.message })
  }
}
