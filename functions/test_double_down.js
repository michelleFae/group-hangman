// Lightweight test harness to simulate full-word guess resolution for Double Down
// This uses the same resolution rules as functions/index.js (full-word branch) but
// runs purely in-process without requiring firebase-admin.

function simulateFullWordResolution({ from, targetId, guessWord, targetWord, guesser, target, room }) {
  const updates = {}
  const hangDeltas = {}
  const now = Date.now()

  // correct word: reveal all unique letters, award wordmoney, eliminate
  const uniqueLetters = Array.from(new Set((targetWord || '').split('')))
  updates[`players/${targetId}/revealed`] = uniqueLetters

  // correct word: award +5 as a delta.
  hangDeltas[from] = (hangDeltas[from] || 0) + 5

  
    const dd = guesser.doubleDown
    console.log('Double Down active?', dd)
    if (dd && dd.active) {
        const stake = Number(dd.stake) || 0
        if (stake > 0) {
        // add stake to their hang delta (they win their stake back)
        hangDeltas[from] = (hangDeltas[from] || 0) + stake
        // record a visible recent gain for the combined amount (+5 + stake)
        updates[`players/${from}/lastGain`] = { amount: (5 + stake), by: targetId, reason: 'doubleDownWord', ts: now }
        // write a private power-up reveal so the buyer sees the double-down resolution
        const ddKey = `double_down_word_${now}`
        updates[`players/${from}/privatePowerReveals/${from}/${ddKey}`] = { powerId: 'double_down', ts: now, from: from, to: from, result: { amount: stake, message: `Double Down: correctly guessed the whole word and earned your stake back (+$${stake}), with +5 for the correct word guess.` } }
        // clear the doubleDown so the DD badge is removed and they must buy again
        updates[`players/${from}/doubleDown`] = null
        }
    }
  
  // mark eliminated and add guessedBy for word
  updates[`players/${targetId}/eliminated`] = true
  updates[`players/${targetId}/eliminatedAt`] = now
  const prevWordGuessedBy = []
  updates[`players/${targetId}/guessedBy/__word`] = [from]

  // record private hit for guesser
  const prevHits = []
  prevHits.push({ type: 'word', word: guessWord, ts: now })
  updates[`players/${from}/privateHits/${targetId}`] = prevHits

  // remove from turnOrder and adjust currentTurnIndex (simulate simple behavior)
  const newTurnOrder = (room.turnOrder || []).filter(id => id !== targetId)
  updates[`turnOrder`] = newTurnOrder
  // adjust currentTurnIndex
  let adjustedIndex = room.currentTurnIndex || 0
  const removedIndex = (room.turnOrder || []).indexOf(targetId)
  if (removedIndex !== -1 && removedIndex <= (room.currentTurnIndex || 0)) adjustedIndex = Math.max(0, adjustedIndex - 1)
  updates[`currentTurnIndex`] = adjustedIndex

  return { updates, hangDeltas }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function runTests() {
  console.log('Running Double Down full-word resolution test...')

  const from = 'playerA'
  const targetId = 'playerB'
  const stake = 7
  const guessWord = 'apple'
  const targetWord = 'apple'
  const nowRoom = { turnOrder: ['playerA', 'playerB', 'playerC'], currentTurnIndex: 1 }

  const guesser = { id: from, doubleDown: { active: true, stake } }
  const target = { id: targetId, word: targetWord }

  const { updates, hangDeltas } = simulateFullWordResolution({ from, targetId, guessWord, targetWord, guesser, target, room: nowRoom })

  try {
    // hangDeltas[from] should be 5 + stake
    assert(typeof hangDeltas[from] === 'number', 'hangDeltas[from] missing')
    assert(hangDeltas[from] === 5 + stake, `Expected hangDeltas[${from}] === ${5 + stake}, got ${hangDeltas[from]}`)

    // updates should clear doubleDown
    assert(Object.prototype.hasOwnProperty.call(updates, `players/${from}/doubleDown`), 'doubleDown clear not present in updates')
    assert(updates[`players/${from}/doubleDown`] === null, 'doubleDown not cleared (should be null)')

    // updates should contain a privatePowerReveals entry for the buyer
    const pprPrefix = `players/${from}/privatePowerReveals/${from}/`
    const pprKeys = Object.keys(updates).filter(k => k.startsWith(pprPrefix))
    assert(pprKeys.length > 0, 'Expected privatePowerReveals entry for buyer')
    const ppr = updates[pprKeys[0]]
    assert(ppr && ppr.powerId === 'double_down', 'privatePowerReveals payload missing or wrong powerId')
    assert(ppr.result && ppr.result.amount === stake, `privatePowerReveals result.amount expected ${stake}, got ${ppr.result && ppr.result.amount}`)

    console.log('\x1b[32mPASS\x1b[0m: Double Down full-word stake awarded and cleared as expected.')
  } catch (err) {
    console.error('\x1b[31mFAIL\x1b[0m:', err.message)
    process.exitCode = 2
  }
}

runTests()
