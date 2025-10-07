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
    if (currentPlayerId !== from) return res.status(403).json({ error: 'Not your turn' })
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

      let count = 0
      for (let ch of word) if (ch === letter) count++

      const prevRevealed = Array.isArray(target.revealed) ? target.revealed.slice() : []
      const already = prevRevealed.includes(letter)

      if (count > 0 && !already) {
        prevRevealed.push(letter)
        updates[`players/${targetId}/revealed`] = prevRevealed
        const prevHang = typeof guesser.hangmoney === 'number' ? guesser.hangmoney : 0
        updates[`players/${from}/hangmoney`] = prevHang + 2
        const prevGuessedByForLetter = (target.guessedBy && target.guessedBy[letter]) ? target.guessedBy[letter].slice() : []
        if (!prevGuessedByForLetter.includes(from)) prevGuessedByForLetter.push(from)
        updates[`players/${targetId}/guessedBy/${letter}`] = prevGuessedByForLetter
        const prevHits = (guesser.privateHits && guesser.privateHits[targetId]) ? guesser.privateHits[targetId].slice() : []
        prevHits.push({ type: 'letter', letter, count, ts: Date.now() })
        updates[`players/${from}/privateHits/${targetId}`] = prevHits
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

      if (guessWord === targetWord) {
        const uniqueLetters = Array.from(new Set(targetWord.split('')))
        updates[`players/${targetId}/revealed`] = uniqueLetters
        const prevHang = typeof guesser.hangmoney === 'number' ? guesser.hangmoney : 0
        updates[`players/${from}/hangmoney`] = prevHang + 5
        updates[`players/${targetId}/eliminated`] = true
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
      } else {
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

    if (Object.keys(updates).length > 0) await roomRef.update(updates)

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('processGuess error', err)
    return res.status(500).json({ error: err.message })
  }
}
