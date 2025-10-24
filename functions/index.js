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
    const prevHang = typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0
    let hangIncrement = 1

    // we'll write wordmoney once into updates at the end of processing

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

        // If this letter was marked as a no-score reveal (e.g., from a power-up), do not award wordmoney
        let noScore = target.noScoreReveals && target.noScoreReveals[letter]
        // Also treat as no-score if the guesser already had this letter privately recorded
        try {
          const prevHitsForTarget = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId] : []
          if (Array.isArray(prevHitsForTarget) && prevHitsForTarget.some(h => h && h.type === 'letter' && ((h.letter || '').toLowerCase() === letter))) {
            noScore = true
          }
        } catch (e) {}
        // Also treat as no-score if the guesser previously received this letter via a privatePowerReveals entry
        try {
          const pphr = (guesser.privatePowerReveals && guesser.privatePowerReveals[targetId]) ? Object.values(guesser.privatePowerReveals[targetId]) : []
          if (Array.isArray(pphr) && pphr.some(r => {
            try {
              if (!r || !r.result) return false
              const res = r.result
              const check = s => (s || '').toString().toLowerCase() === letter
              if (check(res.letterFromTarget)) return true
              if (check(res.letterFromBuyer)) return true
              if (check(res.letter)) return true
              if (res.last && check(res.last)) return true
              if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(letter)) return true
              return false
            } catch (e) { return false }
          })) {
            noScore = true
          }
        } catch (e) {}

        if (!noScore) {
          // award 2 wordmoney per newly revealed occurrence (as a delta)
          // include any doubleDown extra if active
          const dd = guesser.doubleDown
          // normalize some vars for use in payloads/messages
          const letterStr = letter
          let stake = 0
          let award = (2 * toAdd)
          if (dd && dd.active) {
            stake = Number(dd.stake) || 0
            if (stake > 0) {
              // award the stake per newly revealed occurrence
              const extra = stake * toAdd
              award += extra
              // consume the doubleDown entry after use
              updates[`players/${from}/doubleDown`] = null
            }
          }
          // apply net delta
          hangDeltas[from] = (hangDeltas[from] || 0) + award
          // record a visible recent gain so clients show the correct wordmoney delta (net)
          updates[`players/${from}/lastGain`] = { amount: award, by: targetId, reason: 'doubleDown', ts: Date.now() }

          // write a private power-up result entry for the guesser so only they see the double-down result
          try {
            const ddKey = `double_down_${Date.now()}`
            const ddPayload = {
              powerId: 'double_down',
              ts: Date.now(),
              from: from,
              to: from,
              result: {
                letter: letterStr,
                amount: award,
                stake: stake,
                message: `Double Down: guessed '${letterStr}' with stake $${stake} and netted +$${award} (includes +2 per letter and +$${stake}×occurrences).`
              }
            }
            updates[`players/${from}/privatePowerReveals/${from}/${ddKey}`] = ddPayload
          } catch (e) {}

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
          // still reveal publicly but don't award points; add a private note for the guesser
          const prevHits = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId].slice() : []
          prevHits.push({ type: 'letter', letter, count: toAdd, ts: Date.now(), note: 'no-score' })
          updates[`players/${from}/privateHits/${targetId}`] = prevHits
          // Inform the guesser privately about the no-score result for double-down
          try {
            const ddKey2 = `double_down_noscore_${Date.now()}`
            const ddPayload2 = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: { letter, amount: 0, message: `Double Down: guessed '${letter}', no points awarded (no-score)` } }
            updates[`players/${from}/privatePowerReveals/${from}/${ddKey2}`] = ddPayload2
          } catch (e) {}
        }
      } else {
        // letter was already fully revealed : treat this as a wrong guess
        const prevWrong = (guesser.privateWrong && guesser.privateWrong[targetId]) ? guesser.privateWrong[targetId].slice() : []
        if (!prevWrong.includes(letter)) {
          prevWrong.push(letter)
          updates[`players/${from}/privateWrong/${targetId}`] = prevWrong
          // reward the target for a wrong guess against them (delta)
          hangDeltas[targetId] = (hangDeltas[targetId] || 0) + 2
          // write a visible recent gain event so the target client can show a toast
          updates[`players/${targetId}/lastGain`] = { amount: 2, by: from, reason: 'wrongGuess', value: letter, ts: Date.now() }
          // If the guesser had an active doubleDown, they lose their stake on a wrong guess; record private loss entry
          try {
            const ddFail = guesser.doubleDown
            if (ddFail && ddFail.active) {
              const stake = Number(ddFail.stake) || 0
              if (stake > 0) {
                // indicate loss privately to guesser
                const ddKey3 = `double_down_loss_${Date.now()}`
                const ddPayload3 = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: { letter, amount: -stake, message: `Double Down: guessed '${letter}' and lost -$${stake}` } }
                updates[`players/${from}/privatePowerReveals/${from}/${ddKey3}`] = ddPayload3
                // deduct the stake from the guesser as a hang delta so it's applied in the same transaction
                hangDeltas[from] = (hangDeltas[from] || 0) - stake
                // consume/clear the doubleDown entry so the DD badge is removed
                updates[`players/${from}/doubleDown`] = null
              }
            }
          } catch (e) {}
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
          updates[`players/${targetId}/lastGain`] = { amount: 2, by: from, reason: 'wrongGuess', value: letter, ts: Date.now() }
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
        // correct word: reveal all unique letters, award wordmoney, eliminate
        const uniqueLetters = Array.from(new Set(targetWord.split('')))
        updates[`players/${targetId}/revealed`] = uniqueLetters

  // correct word: award +5 as a delta.
  hangDeltas[from] = (hangDeltas[from] || 0) + 5

        // If the guesser had an active Double Down, also award their stake back on a correct full-word guess
        try {
          const dd = guesser.doubleDown
          if (dd && dd.active) {
            const stake = Number(dd.stake) || 0
            if (stake > 0) {
              // add stake to their hang delta (they win their stake back)
              hangDeltas[from] = (hangDeltas[from] || 0) + stake
              // record a visible recent gain for the combined amount (+5 + stake)
              try {
                // compute net gain (may be adjusted later when other deltas apply)
                const netGain = (hangDeltas[from] || 0)
                updates[`players/${from}/lastGain`] = { amount: netGain, by: targetId, reason: 'doubleDownWord', ts: Date.now() }
              } catch (e) {}
              // write a private power-up reveal so the buyer sees the double-down resolution
              try {
                const ddKey = `double_down_word_${Date.now()}`
                updates[`players/${from}/privatePowerReveals/${from}/${ddKey}`] = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: { amount: stake, message: `Double Down: correctly guessed the whole word and earned your stake back (+$${stake})` } }
              } catch (e) {}
              // clear the doubleDown so the DD badge is removed and they must buy again
              try { updates[`players/${from}/doubleDown`] = null } catch (e) {}
            }
          }
        } catch (e) {}

  // mark eliminated and add guessedBy for word
  updates[`players/${targetId}/eliminated`] = true
  // record elimination timestamp so clients can order final standings by elimination order
  updates[`players/${targetId}/eliminatedAt`] = Date.now()
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
          const prev = typeof curr.players[pid].wordmoney === 'number' ? curr.players[pid].wordmoney : 0
          curr.players[pid].wordmoney = Math.max(0, prev + (hangDeltas[pid] || 0))
        })

        return curr
      })
    }

    // remove processed queue item
    await snapshot.ref.remove()

    return null
  });

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

        // Logging: surface existing timeouts for debugging
        try {
          const existingTimeouts = curr.timeouts || {}
          const keys = Object.keys(existingTimeouts)
          if (keys.length > 0) {
            console.log(`advanceTimedTurns: room=${roomId} existingTimeouts=${keys.length}`, keys.map(k => ({ key: k, val: existingTimeouts[k] })))
          }

          // stricter duplicate checks:
          // 1) if any existing timeout for this player has the same turnStartedAt, skip
          // 2) if any existing timeout for this player has a ts within 10s, skip (recent duplicate)
          const alreadyRecordedForTurn = keys.some(k => {
            try {
              const te = existingTimeouts[k]
              if (!te || te.player !== timedOutPlayerId) return false
              if (te.turnStartedAt && curr.currentTurnStartedAt && te.turnStartedAt === curr.currentTurnStartedAt) {
                console.log(`advanceTimedTurns: skipping room=${roomId} player=${timedOutPlayerId} because existing timeout ${k} matches turnStartedAt`)
                return true
              }
              if (te.ts && Math.abs((te.ts || 0) - Date.now()) < 10000) {
                console.log(`advanceTimedTurns: skipping room=${roomId} player=${timedOutPlayerId} because existing timeout ${k} ts is recent (${te.ts})`)
                return true
              }
              return false
            } catch (e) { return false }
          })
          if (alreadyRecordedForTurn) return curr
        } catch (logErr) { console.warn('advanceTimedTurns: logging/dedupe check failed', logErr) }

        // deduct penalty of 2 wordmoney from timed out player (min 0)
        const playerNode = (curr.players && curr.players[timedOutPlayerId]) || {}
        const prevHang = typeof playerNode.wordmoney === 'number' ? playerNode.wordmoney : 0
        const newHang = Math.max(0, prevHang - 2)

    // apply updates: deduct wordmoney and advance
    if (!curr.players) curr.players = {}
    if (!curr.players[timedOutPlayerId]) curr.players[timedOutPlayerId] = {}
    curr.players[timedOutPlayerId].wordmoney = newHang
    curr.currentTurnIndex = nextIndex
    // preserve the expired turn's start so consumers can dedupe precisely; record oldTurnStartedAt before moving it forward
  const expiredTurnStartedAt = curr.currentTurnStartedAt || null
  curr.currentTurnStartedAt = Date.now()

  // optionally log timeout event and include the originating turn start timestamp (expiredTurnStartedAt)
  if (!curr.timeouts) curr.timeouts = {}
  const tkey = `t_${Date.now()}`
        curr.timeouts[tkey] = { player: timedOutPlayerId, deducted: 2, ts: Date.now(), turnStartedAt: expiredTurnStartedAt }
        // award +1 to the player who will now act (nextIndex)
        const nextPlayerId = curr.turnOrder && curr.turnOrder[nextIndex]
        if (nextPlayerId) {
          if (!curr.players[nextPlayerId]) curr.players[nextPlayerId] = {}
          const prev = typeof curr.players[nextPlayerId].wordmoney === 'number' ? curr.players[nextPlayerId].wordmoney : 0
          curr.players[nextPlayerId].wordmoney = prev + 1
          // mark a small visible gain so they see the +1 (optional)
          curr.players[nextPlayerId].lastGain = { amount: 1, by: 'system', reason: 'turnStart', ts: Date.now() }
          // Clear any transient effects that should expire when this player's turn begins
          try {
            if (!curr.players[nextPlayerId]) curr.players[nextPlayerId] = {}
            curr.players[nextPlayerId].frozen = null
            curr.players[nextPlayerId].frozenUntilTurnIndex = null
          } catch (e) {}
          try { if (curr.priceSurge) curr.priceSurge[nextPlayerId] = null } catch (e) {}
        }

  console.log(`advanceTimedTurns: applied timeout room=${roomId} key=${tkey} player=${timedOutPlayerId} expiredTurnStartedAt=${expiredTurnStartedAt} newHang=${newHang}`)

        return curr
      })
    } catch (e) {
      console.error('advanceTimedTurns error for', roomId, e)
    }
  })

  await Promise.all(promises)
  return null
});

