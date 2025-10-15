import { useEffect, useState, useRef } from 'react'
import { db, auth } from '../firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { get, update } from 'firebase/database'
import {
  ref as dbRef,
  onValue as dbOnValue,
  set as dbSet,
  push as dbPush,
} from 'firebase/database'
import NOUNS from '../data/nouns'

export default function useGameRoom(roomId, playerName) {
  const [state, setState] = useState(null)
  const playerIdRef = useRef(null)
  const heartbeatRef = useRef(null)
  // track whether we've already triggered an auto-start for the current waiting round
  const lastAllReadyRef = useRef(false)
  // track whether we've already triggered an auto-end for the current playing round
  const lastPlayingEndedRef = useRef(false)
  // track whether we've already triggered an auto-tally for the current voting round
  const lastAllVotedRef = useRef(false)

  useEffect(() => {
    if (!db) {
      setState({ players: [], password: '' }) // Ensure default structure includes password
      return
    }

    // Subscribe to room data regardless of authentication state so anonymous users
    // can rejoin after refresh.
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const unsub = dbOnValue(roomRef, snapshot => {
      const raw = snapshot.val() || {}
      console.log('Room data updated:', raw)
      const playersObj = raw.players || {}
      // build a sanitized array of player objects with id preserved
      const players = Object.keys(playersObj).map(k => {
        const val = playersObj[k]
        if (val && typeof val === 'object') return { id: k, ...val }
        return null
      }).filter(x => x && typeof x === 'object')
      if (Object.keys(playersObj).length !== players.length) {
        try { console.warn('useGameRoom: filtered invalid entries from playersObj', { playersObj }) } catch (e) {}
      }
      setState({ ...raw, players, password: raw.password || '' })
      console.log('State updated with room data:', { ...raw, players, password: raw.password || '' })

      // Auto-start Word Spy: if we're in the waiting phase and all players are marked ready,
      // let the host automatically begin the playing phase. Use a ref to avoid duplicate calls.
      try {
        const phase = raw.phase
        const ws = raw.wordSpy || {}
        const playerIds = Object.keys(playersObj || {})
        if (phase === 'wordspy_wait' && playerIds.length > 0) {
          const allReady = playerIds.every(pid => {
            try { return !!(playersObj[pid] && playersObj[pid].wordSpyReady) } catch (e) { return false }
          })
          if (allReady && !lastAllReadyRef.current) {
            lastAllReadyRef.current = true
            const myId = playerIdRef.current
            // only the host should call beginWordSpyPlaying(); the function itself double-checks host
            if (myId && raw.hostId === myId) {
              try { beginWordSpyPlaying().catch(() => {}) } catch (e) {}
            }
          } else if (!allReady) {
            lastAllReadyRef.current = false
          }
        } else {
          lastAllReadyRef.current = false
        }
      } catch (e) { console.warn('auto-start wordSpy check failed', e) }

      // Auto-end Word Spy playing when timer expires: host should move to voting
      try {
        const phase = raw.phase
        const ws = raw.wordSpy || {}
        if ((phase === 'wordspy_play' || phase === 'wordspy_playing' || ws.state === 'playing')) {
          const startedAt = (ws.playingStartedAt || ws.startedAt || raw.currentTurnStartedAt || 0)
          const totalMs = (ws.timerSeconds || 120) * 1000
          const now = Date.now()
          const expired = startedAt && (now >= (startedAt + totalMs))
          if (expired && !lastPlayingEndedRef.current) {
            lastPlayingEndedRef.current = true
            const myId = playerIdRef.current
            if (myId && raw.hostId === myId) {
              try { endWordSpyPlaying().catch(() => {}) } catch (e) {}
            }
          } else if (!expired) {
            lastPlayingEndedRef.current = false
          }
        } else {
          lastPlayingEndedRef.current = false
        }
      } catch (e) { console.warn('auto-end wordSpy check failed', e) }

      // Auto-tally Word Spy votes when all players have voted
      try {
        const phase = raw.phase
        const ws = raw.wordSpy || {}
        const playersObjLocal = raw.players || {}
        const playerIds = Object.keys(playersObjLocal || {})
        if ((phase === 'wordspy_voting' || ws.state === 'voting') && playerIds.length > 0) {
          const allVoted = playerIds.every(pid => { try { return !!(playersObjLocal[pid] && playersObjLocal[pid].wordSpyVote) } catch (e) { return false } })
          if (allVoted && !lastAllVotedRef.current) {
            lastAllVotedRef.current = true
            const myId = playerIdRef.current
            if (myId && raw.hostId === myId) {
              try { tallyWordSpyVotes().catch(() => {}) } catch (e) {}
            }
          } else if (!allVoted) {
            lastAllVotedRef.current = false
          }
        } else {
          lastAllVotedRef.current = false
        }
      } catch (e) { console.warn('auto-tally wordSpy check failed', e) }
    })

    // Keep an auth listener around (optional) but do not gate the DB subscription on it.
    let unsubscribeAuth = null
    try {
      unsubscribeAuth = onAuthStateChanged(auth, (user) => {
        // no-op: we don't need to block room subscription based on auth here
        if (!user) return
      })
    } catch (e) {
      unsubscribeAuth = null
    }

    return () => {
      try {
        if (unsub) unsub()
        if (unsubscribeAuth && typeof unsubscribeAuth === 'function') unsubscribeAuth()
        // stop any running heartbeat when the hook unmounts
        try { if (heartbeatRef.current) clearInterval(heartbeatRef.current) } catch (e) {}
      } catch (e) {}
    }
  }, [roomId])

  function getStartMoneyFromRoom(roomVal) {
    try {
      if (roomVal && typeof roomVal.startingWordmoney === 'number') return Math.max(0, Number(roomVal.startingWordmoney))
    } catch (e) {}
    return 2
  }

  function stopHeartbeat() {
    try {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
    } catch (e) {}
  }

  function startHeartbeat() {
    stopHeartbeat()
    if (!db) return
    const pid = playerIdRef.current
    if (!pid) return
    const pRef = dbRef(db, `rooms/${roomId}/players/${pid}`)
    // write immediate lastSeen then schedule periodic updates
    try { update(pRef, { lastSeen: Date.now() }) } catch (e) {}
    heartbeatRef.current = setInterval(() => {
      try { update(pRef, { lastSeen: Date.now() }) } catch (e) {}
    }, 30000)
  }

    // --- Word Spy mode helpers -------------------------------------------------
    // Start a Word Spy game. Only host should call this. Options:
    // { timerSeconds: number, rounds: number }
    async function startWordSpy(options = {}) {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
  // generate a noun from the curated noun list
  const word = NOUNS[Math.floor(Math.random() * NOUNS.length)]
      const timerSeconds = Math.max(10, Math.min(3600, Number(options.timerSeconds) || 120))
      const rounds = Math.max(1, Math.min(100, Number(options.rounds) || (Object.keys(room.players || {}).length || 4)))
      // pick one spy at random
      const playerIds = Object.keys(room.players || {})
      if (playerIds.length === 0) return
      const spyId = playerIds[Math.floor(Math.random() * playerIds.length)]
      const now = Date.now()
      const updates = {}
      updates['phase'] = 'wordspy_wait'
      updates['open'] = false
      // include revealSequence null inside the wordSpy object to avoid ancestor/descendant path conflict
      updates['wordSpy'] = {
        word: word,
        spyId: spyId,
        timerSeconds: timerSeconds,
        roundsRemaining: rounds,
        currentRound: 1,
        startedAt: now,
        state: 'waiting', // waiting -> playing -> voting -> spyGuess -> reveal -> ended
        revealSequence: null,
        lastRoundSummary: null
      }
      // clear player ready/votes/spyGuesses containers
      ;(playerIds || []).forEach(pid => {
        updates[`players/${pid}/wordSpyReady`] = null
        updates[`players/${pid}/wordSpyVote`] = null
        updates[`players/${pid}/wordSpyGuesses`] = null
      })
      await update(roomRef, updates)
    }

    // Player marks ready in waiting phase (non-spy sees the word, spy sees "you are spy")
    async function markWordSpyReady() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const pRef = dbRef(db, `rooms/${roomId}/players/${uid}`)
      try { await update(pRef, { wordSpyReady: true }) } catch (e) { console.warn('markWordSpyReady failed', e) }
    }

    // Host transitions waiting -> playing when all non-spies ready or when forced.
    async function beginWordSpyPlaying() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
      const ws = room.wordSpy || {}
      if (!ws) return
      const updates = {}
      updates['phase'] = 'wordspy_playing'
      updates['wordSpy/state'] = 'playing'
      updates['wordSpy/playingStartedAt'] = Date.now()
      // clear previous votes
      Object.keys(room.players || {}).forEach(pid => { updates[`players/${pid}/wordSpyVote`] = null })
      await update(roomRef, updates)
    }

    // End playing early (host) and move to voting phase
    async function endWordSpyPlaying() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
      const updates = {}
      updates['phase'] = 'wordspy_voting'
      updates['wordSpy/state'] = 'voting'
      updates['wordSpy/votingStartedAt'] = Date.now()
      await update(roomRef, updates)
    }

    // Player votes for who they think is the spy
    async function voteForPlayer(voterId, votedId) {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const target = votedId || null
      const pRef = dbRef(db, `rooms/${roomId}/players/${uid}`)
      try { await update(pRef, { wordSpyVote: target }) } catch (e) { console.warn('voteForPlayer failed', e) }
    }

    // Host tallies votes and moves to spy guess phase. Returns tally object.
    async function tallyWordSpyVotes() {
      if (!db) return null
      const uid = playerIdRef.current
      if (!uid) return null
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return null
      const playersObj = room.players || {}
      const votes = {}
      Object.keys(playersObj).forEach(pid => {
        const v = playersObj[pid] && playersObj[pid].wordSpyVote ? playersObj[pid].wordSpyVote : null
        if (v) votes[v] = (votes[v] || 0) + 1
      })
      // find top vote
      let top = null
      let topCount = 0
      Object.keys(votes).forEach(k => { if (votes[k] > topCount) { top = k; topCount = votes[k] } })
      const totalPlayers = Object.keys(playersObj).length || 0
      const majorityNeeded = Math.floor(totalPlayers / 2) + 1
      const updates = {}

      const tally = { by: uid, ts: Date.now(), top, topCount, votes }

      // require a clear majority before resolving votes
      if (!top || topCount < majorityNeeded) {
        // no clear majority — do not advance; return tally so caller can show UI
        await update(roomRef, { ['wordSpy/lastTally']: tally })
        return { top, topCount, votes }
      }

      // We have a majority — resolve
      // If the majority picked the actual spy, award voters +4 and allow spy to guess
      const ws = room.wordSpy || {}
      if (top === (ws && ws.spyId)) {
        // majority correctly identified the spy — move to spy-guess phase.
        // Do NOT write lastRoundSummary here; wait until the spy either guesses correctly
        // or exhausts all attempts, then submitSpyGuess will write the round summary and move to reveal.
        updates['phase'] = 'wordspy_spyguess'
        updates['wordSpy/state'] = 'spyGuess'
        updates['wordSpy/lastTally'] = tally
        // award +4 to each voter who voted for spy
        const deltas = {}
        Object.keys(playersObj).forEach(pid => {
          try {
            const voted = playersObj[pid] && playersObj[pid].wordSpyVote ? playersObj[pid].wordSpyVote : null
            if (voted === top) {
              const prev = typeof playersObj[pid].wordmoney === 'number' ? Number(playersObj[pid].wordmoney) : 0
              updates[`players/${pid}/wordmoney`] = Math.max(0, Number(prev) + 4)
              updates[`players/${pid}/lastGain`] = { amount: 4, by: ws.spyId, reason: 'wordSpy_vote_correct', ts: Date.now() }
              deltas[pid] = (deltas[pid] || 0) + 4
            }
          } catch (e) {}
        })
        // attach roundResults entry with deltas
        try {
          const rrKey = `wordSpy/roundResults/${Date.now()}`
          const rr = { ts: Date.now(), tally, deltas }
          updates[rrKey] = rr
        } catch (e) {}
      } else {
        // majority picked wrong person — award spy 5 and award +3 to any players who voted for the actual spy
        updates['phase'] = 'wordspy_reveal'
        updates['wordSpy/state'] = 'spyWonByWrongGuess'
        updates['wordSpy/lastTally'] = tally
        // record last round summary so UI can reveal who the spy was and the word after tally
        try {
          updates['wordSpy/lastRoundSummary'] = { spyId: ws.spyId, word: ws.word, ts: Date.now(), round: ws.currentRound || 1 }
        } catch (e) {}
        const deltas = {}
        try {
          const spyNode = (room.players || {})[ws.spyId] || {}
          const prev = typeof spyNode.wordmoney === 'number' ? Number(spyNode.wordmoney) : 0
          updates[`players/${ws.spyId}/wordmoney`] = Math.max(0, Number(prev) + 5)
          updates[`players/${ws.spyId}/lastGain`] = { amount: 5, by: null, reason: 'wordSpy_room_wrong', ts: Date.now() }
          deltas[ws.spyId] = (deltas[ws.spyId] || 0) + 5
        } catch (e) {}
        // also award +3 to any players who voted for the actual spy (even if minority)
        try {
          Object.keys(playersObj).forEach(pid => {
            try {
              const voted = playersObj[pid] && playersObj[pid].wordSpyVote ? playersObj[pid].wordSpyVote : null
              if (voted === (ws && ws.spyId)) {
                const prev2 = typeof playersObj[pid].wordmoney === 'number' ? Number(playersObj[pid].wordmoney) : 0
                updates[`players/${pid}/wordmoney`] = Math.max(0, Number(prev2) + 3)
                updates[`players/${pid}/lastGain`] = { amount: 3, by: ws.spyId, reason: 'wordSpy_vote_correct', ts: Date.now() }
                deltas[pid] = (deltas[pid] || 0) + 3
              }
            } catch (e) {}
          })
        } catch (e) {}
        try {
          const rrKey = `wordSpy/roundResults/${Date.now()}`
          const rr = { ts: Date.now(), tally, deltas }
          updates[rrKey] = rr
        } catch (e) {}
      }

      await update(roomRef, updates)
      return { top, topCount, votes }
    }

    // Spy submits a guess (one of up to 3). guesses should be exact-length words.
    // Returns { correct: bool, revealed: string } where revealed are letters revealed from guess.
    async function submitSpyGuess(guess) {
      if (!db) return { correct: false }
      const uid = playerIdRef.current
      if (!uid) return { correct: false }
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      const ws = room.wordSpy || {}
      if (!ws) return { correct: false }
      if (ws.spyId !== uid) return { correct: false }
      const real = (ws.word || '').toString()
      const len = (real || '').length
      const g = (guess || '').toString()
      if (!g || g.length !== len) return { correct: false, error: 'length' }
      // compute letters in common (multiset intersection)
      const realArr = real.toLowerCase().split('')
      const guessArr = g.toLowerCase().split('')
      const realCount = {}
      realArr.forEach(ch => { realCount[ch] = (realCount[ch] || 0) + 1 })
      const revealedLetters = []
      guessArr.forEach(ch => {
        if (realCount[ch] && realCount[ch] > 0) {
          revealedLetters.push(ch)
          realCount[ch] = realCount[ch] - 1
        }
      })
      const revealed = revealedLetters.join('')
      const correct = g.toLowerCase() === real.toLowerCase()
      const updates = {}
      // append guess to spy's guesses list
      const guessTs = Date.now()
      const key = `players/${uid}/wordSpyGuesses/${guessTs}`
      updates[key] = g

      // determine current attempt number (try to infer from existing stored guesses)
      let currentAttempts = 0
      try {
        const playerNode = (room.players || {})[uid] || {}
        const guessesNode = playerNode.wordSpyGuesses || {}
        currentAttempts = Object.keys(guessesNode || {}).length
      } catch (e) { currentAttempts = (ws.spyGuessesCount || 0) }
      const attemptNumber = currentAttempts + 1

      if (correct) {
        // spy guessed correctly: award spy based on attempt number
        const awardMap = { 1: 5, 2: 3, 3: 2 }
        const award = awardMap[attemptNumber] || 2
        updates['wordSpy/state'] = 'spyWon'
        // move to reveal/round-summary phase so UI can show scores and next-round controls
        updates['phase'] = 'wordspy_reveal'
        updates[`wordSpy/spyWinAtAttempt`] = attemptNumber
        // apply award to spy's wordmoney
        try {
          const spyNode = (room.players || {})[uid] || {}
          const prev = typeof spyNode.wordmoney === 'number' ? Number(spyNode.wordmoney) : 0
          updates[`players/${uid}/wordmoney`] = Math.max(0, Number(prev) + award)
          updates[`players/${uid}/lastGain`] = { amount: award, by: null, reason: 'spyGuess', ts: Date.now() }
          // record delta for roundResults if a lastTally exists
          try {
            const lt = (ws && ws.lastTally && ws.lastTally.ts) ? ws.lastTally.ts : null
            const deltaObj = {}
            deltaObj[uid] = award
            if (lt) updates[`wordSpy/roundResults/${lt}/deltas`] = deltaObj
            else updates[`wordSpy/roundResults/${Date.now()}`] = { ts: Date.now(), tally: ws.lastTally || null, deltas: deltaObj }
          } catch (e) {}
        } catch (e) {}
        // write round summary so UI can show who the spy was and the word
        try {
          updates['wordSpy/lastRoundSummary'] = { spyId: ws.spyId, word: ws.word, ts: Date.now(), round: ws.currentRound || 1 }
        } catch (e) {}
      } else {
        updates['wordSpy/lastReveal'] = { ts: Date.now(), guess: g, revealed }
        // merge revealed letters into a persistent revealed map (letter -> count)
        try {
          const revealedMap = ws.revealed || {}
          const add = {}
          revealedLetters.forEach(ch => { if (ch) add[ch] = (add[ch] || 0) + 1 })
          Object.keys(add).forEach(ch => {
            const prev = typeof revealedMap[ch] === 'number' ? Number(revealedMap[ch]) : 0
            revealedMap[ch] = Math.max(0, prev + add[ch])
            updates[`wordSpy/revealed/${ch}`] = revealedMap[ch]
          })
          // also persist reveal sequence entries so UI can render reveal-order (guess order)
          try {
            const seqKey = `wordSpy/revealSequence/${guessTs}`
            // store letters array and timestamp
            updates[seqKey] = { ts: guessTs, letters: revealedLetters }
          } catch (e) {}
        } catch (e) {}
          // reveal mapping already set above; no auto-tally here — tally is handled by tallyWordSpyVotes
          // If this was the spy's final attempt, end the spy-guess phase and show round summary
          try {
            if (attemptNumber >= 3) {
              updates['phase'] = 'wordspy_reveal'
              updates['wordSpy/state'] = 'spyFailed'
              updates['wordSpy/lastRoundSummary'] = { spyId: ws.spyId, word: ws.word, ts: Date.now(), round: ws.currentRound || 1 }
            }
          } catch (e) {}
      }

      await update(roomRef, updates)
      return { correct, revealed }
    }

    // Host advances to next round or ends Word Spy session; carries forward scores.
    async function playNextWordSpyRound() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
      const ws = room.wordSpy || {}
      if (!ws) return
      const remaining = Math.max(0, (ws.roundsRemaining || 1) - 1)
      const updates = {}
      if (remaining <= 0) {
        updates['phase'] = 'ended'
        updates['wordSpy/state'] = 'ended'
      } else {
        const nextRound = (ws.currentRound || 1) + 1
        // assemble a single nested wordSpy object to avoid ancestor/descendant update conflicts
        const newWordSpy = {
          ...(ws || {}),
          roundsRemaining: remaining,
          currentRound: nextRound,
          state: 'waiting'
        }
        // pick a new word and spy
        const NOUNS = ['lamp','guitar','bottle','chair','camera','book','pillow','cup','window','bicycle','backpack','clock','wallet','shoe','bottle','pen','table','spoon','bottlecap','lantern']
        const word = NOUNS[Math.floor(Math.random() * NOUNS.length)]
        const playersList = Object.keys(room.players || {})
        const spyId = playersList[Math.floor(Math.random() * playersList.length)]
          newWordSpy.word = word
          newWordSpy.spyId = spyId
          newWordSpy.revealSequence = null
          newWordSpy.state = 'waiting'
          newWordSpy.lastRoundSummary = null
          updates['wordSpy'] = newWordSpy
          // set the room phase to waiting so the host auto-start checker can detect all-ready
          updates['phase'] = 'wordspy_wait'
        // clear ready/vote/guesses
        playersList.forEach(pid => { updates[`players/${pid}/wordSpyReady`] = null; updates[`players/${pid}/wordSpyVote`] = null; updates[`players/${pid}/wordSpyGuesses`] = null })
      }
      await update(roomRef, updates)
    }

  async function joinRoom(password = '') {
    console.log('joinRoom called with password:', password)
    if (!db) {
      playerIdRef.current = 'local-' + Math.random().toString(36).slice(2, 8)
      // local fallback: use configured starting wordmoney if available in state
      const startLocal = (state && typeof state.startingWordmoney === 'number') ? Math.max(0, Number(state.startingWordmoney)) : 2
      setState(prev => ({
        ...prev,
        players: [...(prev?.players || []), { id: playerIdRef.current, name: playerName, wordmoney: startLocal, revealed: [] }]
      }))
      return
    }

    const uid = auth && auth.currentUser ? auth.currentUser.uid : null
    const playersRefPath = `rooms/${roomId}/players`

    const palette = [
      '#FFDC70', // soft yellow
      '#64B5F6', // clear sky blue
      '#81C784', // fresh green
      '#F48FB1', // soft pink
      '#fff9e4ff', // white
      '#BA68C8', // gentle purple
      '#ffae35ff', // mellow orange
      '#E57373', // coral red
      '#d5ce81ff', // light olive green
      '#36f240ff', // fresh green
      '#cd75a1ff', // violet lavender
      '#FF8A65', // warm tangerine
      '#7986CB', // periwinkle blue
      '#DCE775', // lime yellow-green
      '#4DB6AC', // soft turquoise
      '#F06292', // rose pink
      '#81D4FA', // baby blue
      '#A1887F', // muted mocha
      '#90CAF9'  // powder blue
    ];

    async function pickColorAndSetPlayer(pKey) {
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      const roomSnap = await get(roomRootRef)
      const roomVal = roomSnap.val() || {}
      const playersObj = roomVal.players || {}
      const used = new Set(Object.keys(playersObj).map(k => playersObj[k] && playersObj[k].color).filter(Boolean))
      let chosen = palette.find(c => !used.has(c))
      if (!chosen) {
        // deterministic fallback based on player key
        const hash = Array.from((pKey || '').toString()).reduce((acc,ch)=>acc + ch.charCodeAt(0), 0)
        chosen = palette[hash % palette.length]
      }
      const pRef = dbRef(db, `${playersRefPath}/${pKey}`)
      // include lastSeen so server-side cleaners can evict stale anonymous players
      const startMoney = getStartMoneyFromRoom(roomVal)
      await dbSet(pRef, { id: pKey, name: playerName, wordmoney: startMoney, revealed: [], hasWord: false, color: chosen, lastSeen: Date.now() })
      return chosen
    }

    if (uid) {
      playerIdRef.current = uid
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      get(roomRootRef).then(snapshot => {
        const roomVal = snapshot.val() || {}
        console.log('Room data fetched:', roomVal)
        // If an authenticated player node already exists for this UID, reuse it instead of overwriting
        const playersObj = roomVal.players || {}
        if (playersObj && playersObj[uid]) {
          playerIdRef.current = uid
          const pRef = dbRef(db, `${playersRefPath}/${uid}`)
          try { update(pRef, { lastSeen: Date.now(), ...(playerName && playerName.toString().trim() ? { name: playerName } : {}) }) } catch (e) {}
          try { startHeartbeat() } catch (e) {}
          setState(prev => ({ ...prev, password: roomVal?.password || password }))
          console.log('Reused existing authenticated player node for uid', uid)
          return
        }

        if (!snapshot.exists()) {
          dbSet(roomRootRef, { hostId: uid, phase: 'lobby', open: true, players: {}, password: password || '' })
          console.log('Room created with password:', password)
          // pick color and add player
          pickColorAndSetPlayer(uid).then(chosen => {
            setState(prev => ({ ...prev, password: password }))
            console.log('Player joined new room with color:', chosen)
            try { startHeartbeat() } catch (e) {}
          })
          return
        }

        // room exists but no existing player node for this UID. Enforce open/password before creating a new node.
        if (roomVal && roomVal.open === false) {
          console.warn('Room is closed to new joins')
          return
        }
        if (roomVal.password && roomVal.password !== password) {
          console.warn('Incorrect password')
          // Do not show an alert here; let the caller (Lobby) show inline feedback
          return
        }

        // enforce max players
        const count = Object.keys(playersObj).length
        if (count >= 20) {
          alert('Room is full (20 players max)')
          return
        }

        // pick color and add player
        pickColorAndSetPlayer(uid).then(chosen => {
          setState(prev => ({ ...prev, password: roomVal?.password || password }))
          console.log('Player joined room with color:', chosen)
          try { startHeartbeat() } catch (e) {}
        })
      })
      return
    }

    const playersRef = dbRef(db, playersRefPath)
    // try to reuse a locally stored anonymous id for this room
    let storedAnonId = null
    try {
      storedAnonId = window.localStorage && window.localStorage.getItem(`gh_anon_${roomId}`)
    } catch (e) {
      storedAnonId = null
    }
    console.log('joinRoom: storedAnonId for', roomId, '=>', storedAnonId)

    if (storedAnonId) {
      // attempt to reuse existing player node
      const pRef = dbRef(db, `rooms/${roomId}/players/${storedAnonId}`)
      const snap = await get(pRef)
      if (snap && snap.exists()) {
        // rejoin existing anonymous player: preserve wordmoney/word/etc, update lastSeen
        // only update name if a non-empty playerName was provided (so refresh doesn't wipe server name)
        playerIdRef.current = storedAnonId
        try {
          const existing = snap.val() || {}
          const upd = { lastSeen: Date.now() }
          // if this is an authenticated user (uid path) don't overwrite name unless explicitly provided
          if (playerName && playerName.toString().trim()) upd.name = playerName
          await update(pRef, upd)
        } catch (e) {}
        try { startHeartbeat() } catch (e) {}
        console.log('Rejoined anonymous player id from localStorage', storedAnonId)
        return
      }
      // if stored id doesn't exist server-side, fall through and create a fresh one
    }

    // check max players before creating a new anonymous player
    const roomSnap = await get(dbRef(db, `rooms/${roomId}`))
    const rv = roomSnap.val() || {}
    const count = Object.keys(rv.players || {}).length
    if (count >= 20) {
      alert('Room is full (20 players max)')
      return
    }

    const newPlayerRef = dbPush(playersRef)
    // ensure we have a display name before creating an anonymous player
    if (!playerName || !playerName.toString().trim()) {
      console.warn('joinRoom aborted: display name required to create anonymous player')
      return
    }
    playerIdRef.current = newPlayerRef.key
    // pick color and set player using the pushed key
    pickColorAndSetPlayer(newPlayerRef.key).then(chosen => {
      try {
        window.localStorage && window.localStorage.setItem(`gh_anon_${roomId}`, newPlayerRef.key)
      } catch (e) {}
      console.log('Anonymous player joined with color:', chosen)
      try { startHeartbeat() } catch (e) {}
    })
  }

  // Attempt automatic rejoin on refresh: if we have a stored anonymous id for this room
  // and the room is already in 'playing' phase, call joinRoom to reattach the player.
  const autoRejoinTriedRef = useRef(false)
  useEffect(() => {
    if (autoRejoinTriedRef.current) return
    autoRejoinTriedRef.current = true
    if (!db) return

    let mounted = true
    ;(async () => {
      try {
        let stored = null
        try { stored = window.localStorage && window.localStorage.getItem(`gh_anon_${roomId}`) } catch (e) { stored = null }
        console.log('useGameRoom: autoRejoin check for', roomId, 'storedAnon?', !!stored)
        if (!stored) return
        const roomSnap = await get(dbRef(db, `rooms/${roomId}`))
        const room = roomSnap.val() || {}
        console.log('useGameRoom: fetched room for autoRejoin', room)
        if (!mounted) return
        // allow auto-rejoin for stored anon id or when current auth uid matches a player node
        const uid = auth && auth.currentUser && auth.currentUser.uid
        const hasAuthPlayer = uid && room.players && room.players[uid]
        // Previously we only auto-rejoined when room.phase === 'playing'. That prevented non-hosts
        // from reattaching after refresh when the host was active. Attempt rejoin whenever we have
        // a stored anon id or an authenticated player node (this is a best-effort reattach).
        if ((stored || hasAuthPlayer)) {
          console.log('useGameRoom: attempting auto rejoin via joinRoom for', roomId, 'stored?', !!stored, 'hasAuthPlayer?', !!hasAuthPlayer, 'phase', room.phase)
          try { await joinRoom(room.password || '') } catch (e) { console.warn('useGameRoom: joinRoom autoRejoin failed', e) }
        }
      } catch (e) {
        console.warn('useGameRoom: autoRejoin encountered error', e)
      }
    })()

    return () => { mounted = false }
  }, [roomId])

  async function startGame(options = {}) {
    if (!db) return
    const uid = playerIdRef.current
    if (!uid) return
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.hostId !== uid) return
    // options: { timed: boolean, turnSeconds: number }
    const updates = { phase: 'submit', open: false }
    if (options && options.timed) {
      updates.timed = true
      updates.turnTimeoutSeconds = Math.max(10, Math.min(300, Number(options.turnSeconds) || 30))
    } else {
      updates.timed = false
      updates.turnTimeoutSeconds = null
    }
    // handle starter bonus option: generate a simple rule (require containing a letter)
    if (options && options.starterEnabled) {
      try {
        const letters = 'abcdefghijklmnopqrstuvwxyz'
        const letter = letters[Math.floor(Math.random() * letters.length)]
        updates.starterBonus = { enabled: true, type: 'contains', value: letter, description: `Contains the letter "${letter.toUpperCase()}"`, applied: false }
      } catch (e) {
        // ignore
      }
    } else {
      // ensure no stale starterBonus remains
      updates.starterBonus = null
    }

    await update(roomRef, updates)
  }

  async function submitWord(word) {
    if (!db) return
    const uid = playerIdRef.current
    if (!uid) return
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.phase !== 'submit') {
      console.warn('Cannot submit word: room not in submit phase')
      return
    }
  const playerRef = dbRef(db, `rooms/${roomId}/players/${uid}`)
  const stored = (word || '').toString().trim().toLowerCase()
  // disallow one-letter words (extra safeguard server-side)
  if (stored.length === 1) {
    console.warn('submitWord rejected: single-letter words are not allowed')
    return false
  }
  // Use update() so we don't overwrite existing fields like color or private lists
  await update(playerRef, { hasWord: true, word: stored, name: playerName })
    const playersSnap = await get(dbRef(db, `rooms/${roomId}/players`))
    const playersObj = playersSnap.val() || {}
    const allSubmitted = Object.values(playersObj).every(p => p.hasWord)
    // Award starter bonus immediately on submission so the UI can show the +10 badge during submit phase.
    // This avoids a double-award by not applying the bonus again when allSubmitted is processed.
    try {
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      const rootSnap = await get(roomRootRef)
      const roomRoot = rootSnap.val() || {}
      const sb = roomRoot.starterBonus || null
      if (sb && sb.enabled && sb.type === 'contains' && sb.value) {
        const req = (sb.value || '').toString().toLowerCase()
        if (stored && stored.indexOf(req) !== -1) {
          // award to this player if not already awarded
          const pSnap = await get(playerRef)
          const pVal = pSnap.val() || {}
          if (!pVal.starterBonusAwarded) {
            const prev = (typeof pVal.wordmoney === 'number')
              ? pVal.wordmoney
              : ((roomRoot && typeof roomRoot.startingWordmoney === 'number') ? Number(roomRoot.startingWordmoney) : 2)
            const ups = {}
            ups[`players/${uid}/wordmoney`] = prev + 10
            ups[`players/${uid}/starterBonusAwarded`] = true
            await update(roomRootRef, ups)
          }
        }
      }

      if (allSubmitted) {
        const turnOrder = Object.keys(playersObj)
        const turnTimeout = roomRoot.turnTimeoutSeconds || null
        const timed = !!roomRoot.timed
        const updates = {
          phase: 'playing',
          turnOrder,
          currentTurnIndex: 0,
          currentTurnStartedAt: Date.now(),
          turnTimeoutSeconds: turnTimeout,
          timed
        }
        // mark starterBonus as applied so we don't attempt to re-award later
        if (roomRoot.starterBonus && roomRoot.starterBonus.enabled) updates['starterBonus/applied'] = true
        // Award +1 to the first player in turnOrder as a starting bonus; be additive to any existing staged value
        try {
          const first = (turnOrder && turnOrder.length > 0) ? turnOrder[0] : null
          if (first) {
            const pSnap = await get(dbRef(db, `rooms/${roomId}/players/${first}`))
            const pVal = pSnap.val() || {}
            const prev = (typeof pVal.wordmoney === 'number') ? Number(pVal.wordmoney) : getStartMoneyFromRoom(roomRoot)
            updates[`players/${first}/wordmoney`] = Number(prev) + 1
            updates[`players/${first}/lastGain`] = { amount: 1, by: 'startBonus', reason: 'startTurn', ts: Date.now() }
          }
        } catch (e) {
          console.warn('Could not award start +1 bonus', e)
        }
        await update(roomRootRef, updates)
      }
    } catch (e) {
      console.warn('submitWord post-processing failed', e)
    }
    return true
  }

  function leaveRoom() {
    if (!playerIdRef.current) return
    if (!db) {
      setState(prev => ({ players: (prev?.players || []).filter(p => p.id !== playerIdRef.current) }))
      return
    }
    // stop heartbeat before removing node
    stopHeartbeat()
    const pid = playerIdRef.current
    const roomRef = dbRef(db, `rooms/${roomId}`)
    ;(async () => {
      try {
        const snap = await get(roomRef)
        const room = snap.val() || {}
        const playersObj = room.players || {}
        // if this player is the host, pick a replacement if one exists
        if (room.hostId && room.hostId === pid) {
          // If the game has ended, prefer to keep the room and host node so the host
          // can refresh and see the same end screen. Only transfer or delete the room
          // when the game is not in the 'ended' phase.
          if (room.phase === 'ended') {
            console.log('leaveRoom: host leaving during ended phase — preserving room and host node to allow refresh/rejoin')
            // stop heartbeat but do not remove the host node or room
            try { stopHeartbeat() } catch (e) {}
            return
          }
          const other = Object.keys(playersObj).find(k => k !== pid)
          if (other) {
            // atomically remove player and set new host
            const ups = {}
            ups[`players/${pid}`] = null
            ups['hostId'] = other
            try { await update(roomRef, ups) } catch (e) { console.warn('Could not transfer host on leave', e) }
            return
          } else {
            // no other players — remove room entirely
            try { await dbSet(roomRef, null) } catch (e) { console.warn('Could not remove empty room on host leave', e) }
            return
          }
        }
        // not host: mark the player as left (don't remove immediately) so their avatar
        // remains visible and guessable for a short grace period. Eviction will remove
        // them after the configured TTL (server-side).
        const pRef = dbRef(db, `rooms/${roomId}/players/${pid}`)
        try {
          await update(pRef, { leftAt: Date.now(), lastSeen: Date.now(), present: false })
        } catch (e) { console.warn('Could not mark player as left on leave', e) }
      } catch (e) {
        // best-effort: attempt direct remove
        try { const pRef = dbRef(db, `rooms/${roomId}/players/${playerIdRef.current}`); await update(pRef, { leftAt: Date.now(), lastSeen: Date.now(), present: false }) } catch (err) { console.warn('leaveRoom fallback mark-left failed', err) }
      }
    })()
  }

  async function sendGuess(targetId, payload) {
    const useServer = import.meta.env.VITE_USE_SERVERLESS === '1' || import.meta.env.VITE_USE_SERVERLESS === 'true'
    const payloadVal = (payload && payload.value) ? String(payload.value).trim() : ''
    if (!payloadVal) return

    // Block normal guesses while Word Spy is actively in the playing phase
    try {
      const roomSnapCheck = await get(dbRef(db, `rooms/${roomId}`))
      const roomCheck = roomSnapCheck.val() || {}
      if (roomCheck && roomCheck.phase === 'wordspy_playing') {
        console.warn('sendGuess blocked: Word Spy playing phase')
        return
      }
    } catch (e) { /* ignore check errors and proceed */ }

    if (useServer) {
      // If running in serverless mode prefer the serverless endpoint when possible.
      // However, if the client is not authenticated (no id token available) we should
      // fall back to the DB queue so local/unauthed testing still works.
      if (auth && auth.currentUser) {
        try {
          const token = await auth.currentUser.getIdToken()
          const res = await fetch('/api/processGuess', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ roomId, targetId, value: payloadVal })
          })
          if (!res.ok) {
            // fallback to DB queue if serverless endpoint not reachable or returned error
            console.warn('Serverless endpoint returned non-ok, falling back to DB queue')
          } else {
            return
          }
        } catch (e) {
          console.error('Serverless guess failed, falling back to DB queue', e)
          // fall through to DB queue push
        }
      } else {
        console.warn('Not authenticated for serverless call — falling back to DB queue')
      }
    }

    if (!db) {
      console.log('guess (local):', { from: playerIdRef.current, target: targetId, payload })
      return
    }

    const qRef = dbRef(db, `rooms/${roomId}/queue`)
    await dbPush(qRef, {
      from: playerIdRef.current,
      fromName: playerName || 'Unknown',
      target: targetId,
      payload,
      ts: Date.now(),
    })
  }

  return { state, joinRoom, leaveRoom, sendGuess, startGame, submitWord, playerId: () => playerIdRef.current,
    // Word Spy helpers
    startWordSpy, markWordSpyReady, beginWordSpyPlaying, endWordSpyPlaying, voteForPlayer, tallyWordSpyVotes, submitSpyGuess, playNextWordSpyRound }
}
