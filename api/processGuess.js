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
    // Track whether this guess resulted in a correct reveal/elimination for the guesser
    let guessWasCorrect = false
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

    // In lastTeamStanding mode, disallow guessing members of your own team
    try {
      if ((room && room.gameMode) === 'lastTeamStanding') {
        const gTeam = (guesser && guesser.team) ? guesser.team : null
        const tTeam = (target && target.team) ? target.team : null
        if (gTeam && tTeam && gTeam === tTeam) {
          return res.status(400).json({ error: 'Cannot guess a player on your own team' })
        }
      }
    } catch (e) { /* ignore */ }

    const updates = {}
  const hangDeltas = {}
    // Helper to write the ephemeral lastDoubleDown and also append a permanent
    // entry under doubleDownHistory so events are preserved for debugging.
    const addLastDoubleDown = (payload) => {
      try {
        updates['lastDoubleDown'] = payload
        const key = `doubleDownHistory/${Date.now()}_${Math.random().toString(36).slice(2,8)}`
        updates[key] = payload
      } catch (e) { /* ignore */ }
    }
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
            // Base award for correct letter(s)
            const prevHang = typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0
            let award = (2 * toAdd)

            // Make stake available in this scope so we can reference it even if no DD is active
            let stake = 0

            // Apply double-down bonus if the guesser staked
            const dd = guesser.doubleDown
            if (dd && dd.active) {
              stake = Number(dd.stake) || 0
              if (stake > 0) {
                // award the stake per newly revealed occurrence
                const extra = stake * toAdd
                award += extra
                // consume the doubleDown entry after use
                updates[`players/${from}/doubleDown`] = null
                // subtract the original stake once (buyer pays the stake on resolution)
                if (toAdd == 0) {
                  // nothing guessed
                  award = award - stake
                }
              }
            }
            // For letter guesses accumulate award into hangDeltas for folding later
            hangDeltas[from] = (hangDeltas[from] || 0) + award
            // mark that this guess produced a correct reveal and award
            guessWasCorrect = true
            // record a visible recent gain so clients show the correct wordmoney delta
            updates[`players/${from}/lastGain`] = { amount: award, by: targetId, reason: 'doubleDown', ts: Date.now() }

            // Also write a private power-up result entry so only the guesser sees the double-down result
            try {
              const ddKey = `double_down_${Date.now()}`
              const letterStr = letter
              // message reflects netted amount (award already reduced by original stake if applicable)
              const ddPayload = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: {
                letter: letterStr,
                amount: award,
                stake: stake,
                message: `Double Down: guessed '${letterStr}' with stake ${stake} and netted +$${award}`,
                messageHtml: `<strong class="power-name">Double Down</strong>: guessed '<strong class="revealed-letter">${letterStr}</strong>' with stake ${stake} and netted <strong class="revealed-letter">+$${award}</strong> (+2 per previously unrevealed letter, + (2*${stake}))`
              } }
              updates[`players/${from}/privatePowerReveals/${from}/${ddKey}`] = ddPayload
              // Also add a buyer-visible entry under the buyer's privatePowerReveals keyed by the target
              try {
                const ddKeyTarget = `double_down_target_${Date.now()}`
                updates[`players/${from}/privatePowerReveals/${targetId}/${ddKeyTarget}`] = { powerId: 'double_down', ts: Date.now(), from: from, to: targetId, result: {
                  letter: letterStr,
                  amount: award,
                  stake: stake,
                  message: `Double Down: guessed '${letterStr}' and netted +$${award}`,
                  messageHtml: `<strong class="power-name">Double Down</strong>: guessed '<strong class="revealed-letter">${letterStr}</strong>' and netted <strong class="revealed-letter">+$${award}</strong>`
                } }
              } catch (e) {}
              // announcement for all clients: brief double-down summary (ephemeral)
              try {
                addLastDoubleDown({ buyerId: from, buyerName: (guesser && guesser.name) ? guesser.name : from, targetId: targetId, targetName: (target && target.name) ? target.name : targetId, letter: letterStr, amount: award, stake: stake, success: true, ts: Date.now() })
              } catch (e) {}
            } catch (e) {}

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
            // Inform the guesser that no points were awarded due to no-score
            try {
              const ddKey2 = `double_down_noscore_${Date.now()}`
              const letterStr2 = letter
              const ddPayload2 = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: {
                letter: letterStr2,
                amount: 0,
                stake: stake,
                message: `Double Down: guessed '${letterStr2}', no points awarded since it was already revealed`,
                messageHtml: `<strong class="power-name">Double Down</strong>: guessed '<strong class="revealed-letter">${letterStr2}</strong>', no points awarded since it was already privately/publicly revealed.`
              } }
              updates[`players/${from}/privatePowerReveals/${from}/${ddKey2}`] = ddPayload2
              try {
                const ddKey2Target = `double_down_noscore_target_${Date.now()}`
                updates[`players/${from}/privatePowerReveals/${targetId}/${ddKey2Target}`] = { powerId: 'double_down', ts: Date.now(), from: from, to: targetId, result: {
                  letter: letterStr2,
                  amount: 0,
                  stake: stake,
                  message: `Double Down: guessed '${letterStr2}', no points awarded since it was already revealed`,
                  messageHtml: `<strong class="power-name">Double Down</strong>: guessed '<strong class="revealed-letter">${letterStr2}</strong>', no points awarded since it was already privately/publicly revealed.`
                } }
              } catch (e) {}
            } catch (e) {}
          }
        } else {
          // letter was already fully revealed : treat this as a wrong guess
          const prevWrong = (guesser.privateWrong && guesser.privateWrong[targetId]) ? guesser.privateWrong[targetId].slice() : []
          if (!prevWrong.includes(letter)) {
            prevWrong.push(letter)
            updates[`players/${from}/privateWrong/${targetId}`] = prevWrong
            // reward the target for a wrong guess against them : unless they have an active hang shield
            const prevTargetHang = typeof target.wordmoney === 'number' ? target.wordmoney : 0
            const shield = target.hangShield
            if (shield && shield.active) {
              // consume the shield but do not award wordmoney
              updates[`players/${targetId}/hangShield`] = null
            } else {
              // accumulate target award into hangDeltas to be folded later
              hangDeltas[targetId] = (hangDeltas[targetId] || 0) + 2
            }

            // If the guesser had an active doubleDown, they lose their stake on a wrong guess
            const ddFail = guesser.doubleDown
            if (ddFail && ddFail.active) {
              const stake = Number(ddFail.stake) || 0
                if (stake > 0) {
                const prevGHang = typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0
                // deduct stake via hangDeltas so it's applied when we fold updates
                hangDeltas[from] = (hangDeltas[from] || 0) - stake
                // write a private power-up result entry indicating the loss
                try {
                  const ddKey3 = `double_down_loss_${Date.now()}`
                  const letterStr3 = letter
                  const ddPayload3 = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: {
                    letter: letterStr3,
                    amount: -stake,
                    stake: stake,
                    message: `Double Down: guessed '${letterStr3}' and lost -$${stake}`,
                    messageHtml: `<strong class="power-name">Double Down</strong>: guessed '<strong class="revealed-letter">${letterStr3}</strong>' and lost <strong class="revealed-letter">-$${stake}</strong>`
                  } }
                  // Write the loss into the buyer's own privatePowerReveals under their own id
                  // so the loss message appears only in the buyer's tile (not the target's tile).
                  try {
                    updates[`players/${from}/privatePowerReveals/${from}/${ddKey3}`] = ddPayload3
                  } catch (e) {}
                  try {
                    addLastDoubleDown({ buyerId: from, buyerName: (guesser && guesser.name) ? guesser.name : from, targetId: targetId, targetName: (target && target.name) ? target.name : targetId, letter: letterStr3, amount: -stake, stake: stake, success: false, ts: Date.now() })
                  } catch (e) {}
                } catch (e) {}
                // consume/clear the doubleDown entry so the DD badge is removed
                updates[`players/${from}/doubleDown`] = null
              }
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
        // correct word: reveal all unique letters, award wordmoney, eliminate
        const uniqueLetters = Array.from(new Set(targetWord.split('')))
        updates[`players/${targetId}/revealed`] = uniqueLetters

        // correct word: award +5 as a delta.
        hangDeltas[from] = (hangDeltas[from] || 0) + 5

        // If the guesser had an active Double Down, also award their stake back on a correct full-word guess
        const dd = guesser.doubleDown
        console.log('Double Down active?', dd)
        if (dd && dd.active) {
          const stake = Number(dd.stake) || 0
          if (stake > 0) {
            // add stake to their hang delta (they win their stake back)
            hangDeltas[from] = (hangDeltas[from] || 0) + stake
            // record a visible recent gain for the combined amount (+5 + stake)

            // compute net gain (hangDeltas already includes stake)
            const netGain = (hangDeltas[from] || 0)
            console.log('Double Down net gain:', netGain)
            updates[`players/${from}/lastGain`] = { amount: netGain, by: targetId, reason: 'doubleDownWord', ts: Date.now() }

            // write a private power-up reveal so the buyer sees the double-down resolution
            const ddKey = `double_down_word_${Date.now()}`
            updates[`players/${from}/privatePowerReveals/${from}/${ddKey}`] = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: {
              amount: stake,
              message: `Double Down: correctly guessed the whole word and earned your stake back (+$${stake}), with +5 for the correct word guess.`,
              messageHtml: `<strong class="power-name">Double Down</strong>: correctly guessed the whole word and earned your stake back <strong class="revealed-letter">(+$${stake})</strong>, with +5 for the correct word guess.`
            } }

            // clear the doubleDown so the DD badge is removed and they must buy again
            updates[`players/${from}/doubleDown`] = null
          }
        }
        

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
          // In team mode, credit the team's wallet; otherwise credit the player
          const nextPlayerObj = players && players[nextPlayer] ? players[nextPlayer] : null
          if ((room && room.gameMode) === 'lastTeamStanding' && nextPlayerObj && nextPlayerObj.team) {
            const t = nextPlayerObj.team
            const prevTeamHang = (room.teams && room.teams[t] && typeof room.teams[t].wordmoney === 'number') ? room.teams[t].wordmoney : 0
            updates[`teams/${t}/wordmoney`] = Math.max(0, Number(prevTeamHang) + 1)
            // still write a per-player lastGain so clients show the visible delta
            updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
          } else {
            const prevNextHang = (players && players[nextPlayer] && typeof players[nextPlayer].wordmoney === 'number') ? players[nextPlayer].wordmoney : 0
            updates[`players/${nextPlayer}/wordmoney`] = prevNextHang + 1
            updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
          }
          // Clear transient effects that should expire when this player's turn begins
          updates[`players/${nextPlayer}/frozen`] = null
          updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
          updates[`priceSurge/${nextPlayer}`] = null
        } catch (e) {}
      }
    }

    // If we have any hangDeltas, fold them into the updates using the snapshot we read earlier
    try {
      if (Object.keys(hangDeltas).length > 0) {
        // If we're in lastTeamStanding, aggregate per-team deltas and apply to teams/<team>/wordmoney.
        // Also: always record a per-player `lastGain` for UI visibility even when canonical funds
        // are applied to the team's wallet. Do not overwrite an existing lastGain written earlier.
        const teamDeltas = {}
        Object.keys(hangDeltas).forEach(pid => {
          try {
            const delta = Number(hangDeltas[pid] || 0)
            const p = players && players[pid] ? players[pid] : null

            // Ensure a per-player lastGain is present so UI shows the visible delta for the actor.
            const lastGainKey = `players/${pid}/lastGain`
            if (!Object.prototype.hasOwnProperty.call(updates, lastGainKey)) {
              try {
                updates[lastGainKey] = { amount: delta, by: null, reason: 'hang', ts: Date.now() }
              } catch (e) {}
            }

            if ((room && room.gameMode) === 'lastTeamStanding' && p && p.team) {
              teamDeltas[p.team] = (teamDeltas[p.team] || 0) + delta
            } else {
              const prev = (players && players[pid] && typeof players[pid].wordmoney === 'number') ? players[pid].wordmoney : 0
              updates[`players/${pid}/wordmoney`] = Math.max(0, prev + delta)
            }
          } catch (e) {}
        })
        // Apply aggregated team deltas
        Object.keys(teamDeltas).forEach(t => {
          try {
            const prevTeam = (room.teams && room.teams[t] && typeof room.teams[t].wordmoney === 'number') ? room.teams[t].wordmoney : 0
            updates[`teams/${t}/wordmoney`] = Math.max(0, Number(prevTeam) + Number(teamDeltas[t] || 0))
          } catch (e) {}
        })
      }
    } catch (e) {
      console.warn('Failed to fold hangDeltas into updates', e)
    }

    if (Object.keys(updates).length > 0) await roomRef.update(updates)

    // Fallback safety: if the guess ultimately was wrong but an active doubleDown remains on the
    // guesser's record (for any reason the earlier branches missed clearing it), consume it now
    // and deduct the original stake. This ensures the DD badge and stake don't persist incorrectly.
    try {
      const ddStillActive = guesser && guesser.doubleDown && guesser.doubleDown.active
      if (!guessWasCorrect && ddStillActive) {
        const stake = Number((guesser.doubleDown && guesser.doubleDown.stake) || 0)
        if (stake > 0) {
          // Only apply if we haven't already scheduled a deduction for this guesser
            // Determine whether deduction should target the team wallet or player wallet
            const deductionIsTeam = (room && room.gameMode) === 'lastTeamStanding' && guesser && guesser.team
            const deductionKey = deductionIsTeam ? `teams/${guesser.team}/wordmoney` : `players/${from}/wordmoney`
            const ddKeyBase = `players/${from}/privatePowerReveals/${from}`
            if (!Object.prototype.hasOwnProperty.call(updates, deductionKey)) {
              const prevGHang = deductionIsTeam ? ((room.teams && room.teams[guesser.team] && typeof room.teams[guesser.team].wordmoney === 'number') ? room.teams[guesser.team].wordmoney : 0) : (typeof guesser.wordmoney === 'number' ? guesser.wordmoney : 0)
              const fix = {}
              fix[deductionKey] = Math.max(0, prevGHang - stake)
              const lossKey = `double_down_loss_fallback_${Date.now()}`
              const ddPayload = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: {
                letter: null,
                amount: -stake,
                message: `Double Down wrong guess! Lost $${stake}`,
                messageHtml: `<strong class="power-name">Double Down</strong> wrong guess! Lost <strong class="revealed-letter"> $${stake}</strong>`
              } }
              fix[`${ddKeyBase}/${lossKey}`] = ddPayload
                try {
                  // also add a buyer-local fallback entry so buyer sees this loss message in their own tile
                  const lossKeyTarget = `double_down_loss_fallback_target_${Date.now()}`
                  fix[`players/${from}/privatePowerReveals/${from}/${lossKeyTarget}`] = { powerId: 'double_down', ts: Date.now(), from: from, to: from, result: {
                    letter: null,
                    amount: -stake,
                    message: `Double Down wrong guess! Lost $${stake}`,
                    messageHtml: `<strong class="power-name">Double Down</strong> wrong guess! Lost <strong class="revealed-letter"> $${stake}</strong>`
                  } }
                } catch (e) {}
                  try {
                  fix['lastDoubleDown'] = { buyerId: from, buyerName: (guesser && guesser.name) ? guesser.name : from, targetId: targetId, targetName: (target && target.name) ? target.name : targetId, letter: null, amount: -stake, stake: stake, success: false, ts: Date.now() }
                  const key = `doubleDownHistory/${Date.now()}_${Math.random().toString(36).slice(2,8)}`
                  fix[key] = fix['lastDoubleDown']
                } catch (e) {}
              fix[`players/${from}/doubleDown`] = null
              await roomRef.update(fix)
            } else if (!Object.prototype.hasOwnProperty.call(updates, `players/${from}/doubleDown`)) {
              // If we already adjusted wordmoney but didn't clear doubleDown, just clear it
              await roomRef.update({ [`players/${from}/doubleDown`]: null })
            }
        } else {
          // If stake is zero, just clear the flag to remove the badge
          if (!Object.prototype.hasOwnProperty.call(updates, `players/${from}/doubleDown`)) {
            await roomRef.update({ [`players/${from}/doubleDown`]: null })
          }
        }
      }
    } catch (e) {
      console.warn('doubleDown fallback cleanup failed', e && (e.stack || e.message || String(e)))
    }

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
    console.log("Game over : winner:", winner.name)

    return res.status(200).json({ ok: true })
  }
    // If we get here the guess was processed and the game continues : return success
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('processGuess error', err)
    return res.status(500).json({ error: err.message })
  }
}
