import { useEffect, useState, useRef } from 'react'
import { db, auth } from '../firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { get, update, runTransaction } from 'firebase/database'
import {
  ref as dbRef,
  onValue as dbOnValue,
  set as dbSet,
  push as dbPush,
} from 'firebase/database'
import NOUNS from '../data/nouns'
import COLOURS from '../data/colours'
import ELEMENTS from '../data/elements'
import CPPTERMS from '../data/cppterms'
import ANIMALS from '../data/animals'
import INSTRUMENTS from '../data/instruments'
import BALLSPORTS from '../data/ballsports'
import OLYMPICSPORTS from '../data/olympicsports'
import GEMSTONES from '../data/gemstones'
import COUNTRIES from '../data/countries'
import FRUITS from '../data/fruits'
import VEGETABLES from '../data/vegetables'
import OCCUPATIONS from '../data/occupations'

// Palette shared for bot avatars
const BOT_PALETTE = [
  '#FFDC70','#64B5F6','#81C784','#F48FB1','#fff9e4ff','#BA68C8','#ffae35ff','#E57373','#d5ce81ff','#36f240ff','#cd75a1ff','#FF8A65','#7986CB','#DCE775','#4DB6AC','#F06292','#81D4FA','#A1887F','#90CAF9'
]

export default function useGameRoom(roomId, playerName) {
  const [state, setState] = useState(null)
  const playerIdRef = useRef(null)
  const heartbeatRef = useRef(null)
  const tabIdRef = useRef(null)
  const tabUnloadHandlerRef = useRef(null)
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
    const unsub = dbOnValue(roomRef, async snapshot => {
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

      // If we're in the lobby phase, ensure nobody is incorrectly marked stale.
      // This can happen if stale flags were set while the room was in another phase;
      // clear any lingering `stale` flags so lobby participants don't appear grey.
      try {
        const phaseNow = raw.phase || 'lobby'
        if (phaseNow === 'lobby') {
          const updates = {}
          Object.keys(playersObj || {}).forEach(k => {
            try {
              const p = playersObj[k] || {}
              if (p && p.stale) updates[`players/${k}/stale`] = null
            } catch (e) {}
          })
          if (Object.keys(updates).length > 0) {
            try { await update(roomRef, updates) } catch (e) { console.warn('Failed to clear stale flags in lobby', e) }
          }
        }
      } catch (e) {
        console.warn('lobby stale-clear check failed', e)
      }

      // If the room currently has only one player left while a game is active,
      // end the game and persist the final state. Only the host performs the
      // authoritative transition to avoid racey writes from multiple clients.
      try {
        const phaseNow = raw.phase || 'lobby'
        const activePhases = ['playing', 'submit', 'wordseeker_play', 'wordseeker_playing', 'wordseeker_play']
        const presentCount = Array.isArray(players) ? players.length : Object.keys(raw.players || {}).length
        if (presentCount <= 1 && phaseNow && phaseNow !== 'ended' && activePhases.includes(phaseNow)) {
          const myUid = (auth && auth.currentUser) ? auth.currentUser.uid : null
          if (raw.hostId && myUid && raw.hostId === myUid) {
            try {
              const roomRef = dbRef(db, `rooms/${roomId}`)
              const updates = { phase: 'ended' }
              if (presentCount === 1 && players && players[0] && players[0].id) updates['winnerId'] = players[0].id
              await update(roomRef, updates)
              console.log('Auto-ended room due to single remaining player', { roomId, winner: updates['winnerId'] })
            } catch (e) {
              console.warn('Could not auto-end room when only one player left', e)
            }
          }
        }
      } catch (e) { console.warn('single-player end check failed', e) }

      // Auto-start Word Seeker: if we're in the waiting phase and all players are marked ready,
      // let the host automatically begin the playing phase. Use a ref to avoid duplicate calls.
      try {
        const phase = raw.phase
        const ws = raw.wordSeeker || {}
        const playerIds = Object.keys(playersObj || {})
        if (phase === 'wordseeker_wait' && playerIds.length > 0) {
          const allReady = playerIds.every(pid => {
            try { return !!(playersObj[pid] && playersObj[pid].wordSeekerReady) } catch (e) { return false }
          })
          if (allReady && !lastAllReadyRef.current) {
            lastAllReadyRef.current = true
            const myId = playerIdRef.current
            // only the host should call beginWordSeekerPlaying(); the function itself double-checks host
            if (myId && raw.hostId === myId) {
              try { beginWordSeekerPlaying().catch(() => {}) } catch (e) {}
            }
          } else if (!allReady) {
            lastAllReadyRef.current = false
          }
        } else {
          lastAllReadyRef.current = false
        }
      } catch (e) { console.warn('auto-start wordSeeker check failed', e) }

      // Auto-end Word Seeker playing when timer expires: host should move to voting
      try {
        const phase = raw.phase
        const ws = raw.wordSeeker || {}
        if ((phase === 'wordseeker_play' || phase === 'wordseeker_playing' || ws.state === 'playing')) {
          const startedAt = (ws.playingStartedAt || ws.startedAt || raw.currentTurnStartedAt || 0)
          const totalMs = (ws.timerSeconds || 120) * 1000
          const now = Date.now()
          const expired = startedAt && (now >= (startedAt + totalMs))
          if (expired && !lastPlayingEndedRef.current) {
            lastPlayingEndedRef.current = true
            const myId = playerIdRef.current
            if (myId && raw.hostId === myId) {
              try { endWordSeekerPlaying().catch(() => {}) } catch (e) {}
            }
          } else if (!expired) {
            lastPlayingEndedRef.current = false
          }
        } else {
          lastPlayingEndedRef.current = false
        }
      } catch (e) { console.warn('auto-end wordSeeker check failed', e) }

      // Auto-tally Word Seeker votes when all players have voted
      try {
        const phase = raw.phase
        const ws = raw.wordSeeker || {}
        const playersObjLocal = raw.players || {}
        const playerIds = Object.keys(playersObjLocal || {})
        if ((phase === 'wordseeker_voting' || ws.state === 'voting') && playerIds.length > 0) {
          const allVoted = playerIds.every(pid => { try { return !!(playersObjLocal[pid] && playersObjLocal[pid].wordSeekerVote) } catch (e) { return false } })
          if (allVoted && !lastAllVotedRef.current) {
            lastAllVotedRef.current = true
            const myId = playerIdRef.current
            if (myId && raw.hostId === myId) {
              try { tallyWordSeekerVotes().catch(() => {}) } catch (e) {}
            }
          } else if (!allVoted) {
            lastAllVotedRef.current = false
          }
        } else {
          lastAllVotedRef.current = false
        }
      } catch (e) { console.warn('auto-tally wordSeeker check failed', e) }
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
        // stop any running heartbeat when the hook unmounts (also unregisters tab)
        try { stopHeartbeat() } catch (e) {}
      } catch (e) {}
    }
  }, [roomId])

  function getStartMoneyFromRoom(roomVal) {
    // Prefer an explicit room setting `startingWordmoney` when present; fall back to 2.
    try {
      if (roomVal && typeof roomVal.startingWordmoney !== 'undefined' && !Number.isNaN(Number(roomVal.startingWordmoney))) return Number(roomVal.startingWordmoney)
    } catch (e) {}
    return 2
  }

  // Centralized helper: credit a player or their team depending on gameMode.
  // Always records a per-player lastGain for UI. Keeps updates multi-path safe
  // by only writing the specific team or player path (not both ancestor & descendant).
  function applyAwardToUpdates(updates, room, pid, amount, { reason = null, by = null } = {}) {
    try {
      const playerNode = (room.players || {})[pid] || {}
      const gm = room && room.gameMode
      if (gm === 'lastTeamStanding') {
        const team = playerNode.team
        if (team) {
          const teamKey = `teams/${team}/wordmoney`
          const currTeam = (typeof updates[teamKey] !== 'undefined') ? Number(updates[teamKey]) : (room.teams && room.teams[team] && typeof room.teams[team].wordmoney === 'number' ? Number(room.teams[team].wordmoney) : 0)
          updates[teamKey] = Math.max(0, Number(currTeam) + Number(amount))
        } else {
          const prev = typeof playerNode.wordmoney === 'number' ? Number(playerNode.wordmoney) : 0
          updates[`players/${pid}/wordmoney`] = Math.max(0, Number(prev) + Number(amount))
        }
      } else {
        const prev = typeof playerNode.wordmoney === 'number' ? Number(playerNode.wordmoney) : 0
        updates[`players/${pid}/wordmoney`] = Math.max(0, Number(prev) + Number(amount))
      }
      // always record lastGain for UI
      try { updates[`players/${pid}/lastGain`] = { amount: Number(amount), by: by || null, reason: reason || null, ts: Date.now() } } catch (e) {}
    } catch (e) {
      // bubble up for callers if desired
      throw e
    }
  }

  function stopHeartbeat() {
    try {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
    } catch (e) {}
    try {
      // unregister this tab when stopping heartbeat (tab closed or cleanup)
      unregisterTab().catch(() => {})
    } catch (e) {}
  }

  function startHeartbeat() {
    stopHeartbeat()
    if (!db) return
    const pid = playerIdRef.current
    if (!pid) return
    const pRef = dbRef(db, `rooms/${roomId}/players/${pid}`)
    // Ensure this browser tab is registered so other tabs won't cause us to be
    // marked stale. registerTab writes an ephemeral node under players/<pid>/tabs/<tabId>.
    try { registerTab().catch(() => {}) } catch (e) {}
    // write immediate lastSeen then schedule periodic updates
    try { update(pRef, { lastSeen: Date.now(), stale: null }) } catch (e) {}
    heartbeatRef.current = setInterval(() => {
      try { update(pRef, { lastSeen: Date.now(), stale: null }) } catch (e) {}
    }, 30000)
  }

  // Register an ephemeral per-tab presence entry under players/<pid>/tabs/<tabId>
  async function registerTab() {
    try {
      if (!db) return
      const pid = playerIdRef.current
      if (!pid) return
      if (tabIdRef.current) return
      const tabId = `${Math.random().toString(36).slice(2)}_${Date.now()}`
      tabIdRef.current = tabId
      const tabRef = dbRef(db, `rooms/${roomId}/players/${pid}/tabs/${tabId}`)
      try { await dbSet(tabRef, Date.now()) } catch (e) {}
      // ensure we remove the tab node on unload
      const handler = async () => { try { await dbSet(tabRef, null) } catch (e) {} }
      tabUnloadHandlerRef.current = handler
      try { window.addEventListener('beforeunload', handler) } catch (e) {}
    } catch (e) {
      console.warn('registerTab failed', e)
    }
  }

  async function unregisterTab() {
    try {
      if (!db) return
      const pid = playerIdRef.current
      const tabId = tabIdRef.current
      if (!pid || !tabId) return
      const tabRef = dbRef(db, `rooms/${roomId}/players/${pid}/tabs/${tabId}`)
      try { await dbSet(tabRef, null) } catch (e) {}
      try {
        if (tabUnloadHandlerRef.current) {
          window.removeEventListener('beforeunload', tabUnloadHandlerRef.current)
          tabUnloadHandlerRef.current = null
        }
      } catch (e) {}
      tabIdRef.current = null
    } catch (e) {
      console.warn('unregisterTab failed', e)
    }
  }

    // --- Word Seeker mode helpers -------------------------------------------------
    // Start a Word Seeker game. Only host should call this. Options:
    // { timerSeconds: number, rounds: number }
    async function startWordSeeker(options = {}) {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
  // choose a word for Word Seeker. If the room has a secretWordTheme enabled,
  // pick from that theme's curated list (animals, colours, elements, cppterms).
  // If no theme is active, fall back to the generic NOUNS list.
  let word = null
  try {
    const theme = room && room.secretWordTheme && room.secretWordTheme.enabled ? (room.secretWordTheme.type || null) : null
    let pool = null
    if (theme === 'animals') pool = Array.isArray(ANIMALS) ? ANIMALS.slice() : null
  else if (theme === 'fruits') pool = Array.isArray(FRUITS) ? FRUITS.slice() : null
  else if (theme === 'vegetables') pool = Array.isArray(VEGETABLES) ? VEGETABLES.slice() : null
    else if (theme === 'occupations') pool = Array.isArray(OCCUPATIONS) ? OCCUPATIONS.slice() : null
    else if (theme === 'countries') pool = Array.isArray(COUNTRIES) ? COUNTRIES.slice() : null
    else if (theme === 'instruments') pool = Array.isArray(INSTRUMENTS) ? INSTRUMENTS.slice() : null
    else if (theme === 'colours') pool = Array.isArray(COLOURS) ? COLOURS.slice() : null
    else if (theme === 'elements') pool = Array.isArray(ELEMENTS) ? ELEMENTS.slice() : null
    else if (theme === 'cpp') pool = Array.isArray(CPPTERMS) ? CPPTERMS.slice() : null

    // When a theme is active prefer selecting from the theme pool. Use a strict
    // alphabetic filter first, then a relaxed filter if nothing passes. If no
    // theme is active, fall back to the generic NOUNS list below.
    if (theme && Array.isArray(pool) && pool.length > 0) {
      const filtered = pool.map(p => (p || '').toString().trim()).filter(p => /^[a-zA-Z]+$/.test(p) && p.length >= 2)
      if (filtered.length > 0) {
        word = filtered[Math.floor(Math.random() * filtered.length)]
      } else {
        // relaxed fallback: allow non-alpha but require length >= 2
        const relaxed = pool.map(p => (p || '').toString().trim()).filter(p => p && p.length >= 2)
        if (relaxed.length > 0) {
          word = relaxed[Math.floor(Math.random() * relaxed.length)]
        } else {
          console.warn('startWordSeeker: theme enabled but pool produced no usable entries for type', theme)
        }
      }
    }
    // If no theme is active, we'll pick from NOUNS below
  } catch (e) {
    word = null
  }
  // If no theme was selected, fallback to a generic noun list
  try {
    const themeActive = room && room.secretWordTheme && room.secretWordTheme.enabled
    if (!themeActive) {
      const nounsList = (NOUNS && NOUNS.default) ? NOUNS.default : NOUNS
      if (Array.isArray(nounsList) && nounsList.length > 0) {
        word = nounsList[Math.floor(Math.random() * nounsList.length)]
      }
    }
  } catch (e) {
    // last-resort hardcoded fallback
    const fallbackNouns = ['lamp','guitar','bottle','chair','camera','book','pillow','cup','window','bicycle']
    word = fallbackNouns[Math.floor(Math.random() * fallbackNouns.length)]
  }
      const timerSeconds = Math.max(10, Math.min(3600, Number(options.timerSeconds) || 120))
      const rounds = Math.max(1, Math.min(100, Number(options.rounds) || (Object.keys(room.players || {}).length || 4)))
      // pick one spy at random
      const playerIds = Object.keys(room.players || {})
      if (playerIds.length === 0) return
      const spyId = playerIds[Math.floor(Math.random() * playerIds.length)]
      const now = Date.now()
      const updates = {}
      updates['phase'] = 'wordseeker_wait'
      updates['open'] = false
      // include revealSequence null inside the wordSeeker object to avoid ancestor/descendant path conflict
      updates['wordSeeker'] = {
        word: word,
        spyId: spyId,
        timerSeconds: timerSeconds,
        roundsRemaining: rounds,
        currentRound: 1,
        startedAt: now,
        state: 'waiting', // waiting -> playing -> voting -> spyGuess -> reveal -> ended
        revealSequence: null,
        // ensure any prior-round reveal artifacts are cleared so the new spy
        // does not benefit from previous guesses
        revealed: null,
        lastReveal: null,
        lastRoundSummary: null
      }
      // clear player ready/votes/spyGuesses containers
      ;(playerIds || []).forEach(pid => {
        updates[`players/${pid}/wordSeekerReady`] = null
        updates[`players/${pid}/wordSeekerVote`] = null
        updates[`players/${pid}/wordSeekerGuesses`] = null
      })
      await update(roomRef, updates)
    }

    // Player marks ready in waiting phase (non-spy sees the word, spy sees "you are spy")
    async function markWordSeekerReady() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const pRef = dbRef(db, `rooms/${roomId}/players/${uid}`)
      try { await update(pRef, { wordSeekerReady: true }) } catch (e) { console.warn('markWordSeekerReady failed', e) }
    }

    // Host transitions waiting -> playing when all non-spies ready or when forced.
    async function beginWordSeekerPlaying() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
      const ws = room.wordSeeker || {}
      if (!ws) return
      const updates = {}
      updates['phase'] = 'wordseeker_playing'
      updates['wordSeeker/state'] = 'playing'
      updates['wordSeeker/playingStartedAt'] = Date.now()
      // clear previous votes
      Object.keys(room.players || {}).forEach(pid => { updates[`players/${pid}/wordSeekerVote`] = null })
      await update(roomRef, updates)
    }

    // End playing early (host) and move to voting phase
    async function endWordSeekerPlaying() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
      const updates = {}
      updates['phase'] = 'wordseeker_voting'
      updates['wordSeeker/state'] = 'voting'
      updates['wordSeeker/votingStartedAt'] = Date.now()
      await update(roomRef, updates)
    }

    // Player votes for who they think is the spy
    async function voteForPlayer(voterId, votedId) {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const target = votedId || null
      const pRef = dbRef(db, `rooms/${roomId}/players/${uid}`)
      try { await update(pRef, { wordSeekerVote: target }) } catch (e) { console.warn('voteForPlayer failed', e) }
    }

    // Host tallies votes and moves to spy guess phase. Returns tally object.
    async function tallyWordSeekerVotes() {
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
        const v = playersObj[pid] && playersObj[pid].wordSeekerVote ? playersObj[pid].wordSeekerVote : null
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
        // no clear majority : do not advance; return tally so caller can show UI
        await update(roomRef, { ['wordSeeker/lastTally']: tally })
        return { top, topCount, votes }
      }

      // We have a majority : resolve
      // If the majority picked the actual spy, award voters +4 and allow spy to guess
      const ws = room.wordSeeker || {}
  if (top === (ws && ws.spyId)) {
        // majority correctly identified the spy : move to spy-guess phase.
        // Do NOT write lastRoundSummary here; wait until the spy either guesses correctly
        // or exhausts all attempts, then submitSpyGuess will write the round summary and move to reveal.
        updates['phase'] = 'wordseeker_spyguess'
        updates['wordSeeker/state'] = 'spyGuess'
        updates['wordSeeker/lastTally'] = tally
        // award +4 to each voter who voted for spy
        const deltas = {}
        Object.keys(playersObj).forEach(pid => {
          try {
            const voted = playersObj[pid] && playersObj[pid].wordSeekerVote ? playersObj[pid].wordSeekerVote : null
            if (voted === top) {
              // team-aware credit: when in lastTeamStanding, credit team wallet; otherwise credit player
                applyAwardToUpdates(updates, room, pid, 4, { reason: 'wordSeeker_vote_correct', by: ws.spyId })
              deltas[pid] = (deltas[pid] || 0) + 4
            }
          } catch (e) {}
        })
        // attach roundResults entry with deltas
        try {
          const rrKey = `wordSeeker/roundResults/${Date.now()}`
          const rr = { ts: Date.now(), tally, deltas }
          updates[rrKey] = rr
        } catch (e) {}
      } else {
        // majority picked wrong person : award spy 5 and award +3 to any players who voted for the actual spy
        updates['phase'] = 'wordseeker_reveal'
        updates['wordSeeker/state'] = 'spyWonByWrongGuess'
        updates['wordSeeker/lastTally'] = tally
        // record last round summary so UI can reveal who the spy was and the word after tally
        try {
          updates['wordSeeker/lastRoundSummary'] = { spyId: ws.spyId, word: ws.word, ts: Date.now(), round: ws.currentRound || 1 }
        } catch (e) {}
        const deltas = {}
          try {
            const spyNode = (room.players || {})[ws.spyId] || {}
            // team-aware: credit team wallet in lastTeamStanding
            applyAwardToUpdates(updates, room, ws.spyId, 5, { reason: 'wordSeeker_room_wrong', by: null })
            deltas[ws.spyId] = (deltas[ws.spyId] || 0) + 5
          } catch (e) {}
        // also award +3 to any players who voted for the actual spy (even if minority)
        try {
                Object.keys(playersObj).forEach(pid => {
            try {
              const voted = playersObj[pid] && playersObj[pid].wordSeekerVote ? playersObj[pid].wordSeekerVote : null
              if (voted === (ws && ws.spyId)) {
                applyAwardToUpdates(updates, room, pid, 3, { reason: 'wordSeeker_vote_correct', by: ws.spyId })
                deltas[pid] = (deltas[pid] || 0) + 3
              }
            } catch (e) {}
          })
        } catch (e) {}
        try {
          const rrKey = `wordSeeker/roundResults/${Date.now()}`
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
      const ws = room.wordSeeker || {}
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
      const key = `players/${uid}/wordSeekerGuesses/${guessTs}`
      updates[key] = g

      // determine current attempt number (try to infer from existing stored guesses)
      let currentAttempts = 0
      try {
        const playerNode = (room.players || {})[uid] || {}
        const guessesNode = playerNode.wordSeekerGuesses || {}
        currentAttempts = Object.keys(guessesNode || {}).length
      } catch (e) { currentAttempts = (ws.spyGuessesCount || 0) }
      const attemptNumber = currentAttempts + 1

      if (correct) {
        // spy guessed correctly: award spy based on attempt number
        const awardMap = { 1: 5, 2: 3, 3: 2 }
        const award = awardMap[attemptNumber] || 2
        updates['wordSeeker/state'] = 'spyWon'
        // move to reveal/round-summary phase so UI can show scores and next-round controls
        updates['phase'] = 'wordseeker_reveal'
        updates[`wordSeeker/spyWinAtAttempt`] = attemptNumber
        // apply award to spy's wordmoney (team-aware)
        try {
          applyAwardToUpdates(updates, room, uid, award, { reason: 'spyGuess', by: null })
          // record delta for roundResults if a lastTally exists
          try {
            const lt = (ws && ws.lastTally && ws.lastTally.ts) ? ws.lastTally.ts : null
            const deltaObj = {}
            deltaObj[uid] = award
            if (lt) updates[`wordSeeker/roundResults/${lt}/deltas`] = deltaObj
            else updates[`wordSeeker/roundResults/${Date.now()}`] = { ts: Date.now(), tally: ws.lastTally || null, deltas: deltaObj }
          } catch (e) {}
        } catch (e) {
          // if award helper fails, fall back to a direct per-player award
          try {
            const spyNode = (room.players || {})[uid] || {}
            const prev = typeof spyNode.wordmoney === 'number' ? Number(spyNode.wordmoney) : 0
            updates[`players/${uid}/wordmoney`] = Math.max(0, Number(prev) + award)
            try { updates[`players/${uid}/lastGain`] = { amount: award, by: null, reason: 'spyGuess', ts: Date.now() } } catch (e) {}
          } catch (ee) {}
        }
        // write round summary so UI can show who the spy was and the word
        try {
          updates['wordSeeker/lastRoundSummary'] = { spyId: ws.spyId, word: ws.word, ts: Date.now(), round: ws.currentRound || 1 }
        } catch (e) {}
      } else {
        updates['wordSeeker/lastReveal'] = { ts: Date.now(), guess: g, revealed }
        // merge revealed letters into a persistent revealed map (letter -> count)
        try {
          const revealedMap = ws.revealed || {}
          const add = {}
          revealedLetters.forEach(ch => { if (ch) add[ch] = (add[ch] || 0) + 1 })
          Object.keys(add).forEach(ch => {
            const prev = typeof revealedMap[ch] === 'number' ? Number(revealedMap[ch]) : 0
            revealedMap[ch] = Math.max(0, prev + add[ch])
            updates[`wordSeeker/revealed/${ch}`] = revealedMap[ch]
          })
          // also persist reveal sequence entries so UI can render reveal-order (guess order)
          try {
            const seqKey = `wordSeeker/revealSequence/${guessTs}`
            // store letters array and timestamp
            updates[seqKey] = { ts: guessTs, letters: revealedLetters }
          } catch (e) {}
        } catch (e) {}
          // reveal mapping already set above; no auto-tally here : tally is handled by tallyWordSeekerVotes
          // If this was the spy's final attempt, end the spy-guess phase and show round summary
          try {
            if (attemptNumber >= 3) {
              updates['phase'] = 'wordseeker_reveal'
              updates['wordSeeker/state'] = 'spyFailed'
              updates['wordSeeker/lastRoundSummary'] = { spyId: ws.spyId, word: ws.word, ts: Date.now(), round: ws.currentRound || 1 }
            }
          } catch (e) {}
      }

      await update(roomRef, updates)
      return { correct, revealed }
    }

    // Host advances to next round or ends Word Seeker session; carries forward scores.
    async function playNextWordSeekerRound() {
      if (!db) return
      const uid = playerIdRef.current
      if (!uid) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      if (room.hostId !== uid) return
      const ws = room.wordSeeker || {}
      if (!ws) return
      const remaining = Math.max(0, (ws.roundsRemaining || 1) - 1)
      const updates = {}
      if (remaining <= 0) {
        updates['phase'] = 'ended'
        updates['wordSeeker/state'] = 'ended'
      } else {
        const nextRound = (ws.currentRound || 1) + 1
        // assemble a single nested wordSeeker object to avoid ancestor/descendant update conflicts
        const newWordSeeker = {
          ...(ws || {}),
          roundsRemaining: remaining,
          currentRound: nextRound,
          state: 'waiting'
        }
        // pick a new word and spy : prefer the room's secretWordTheme when enabled
        let word = null
        try {
          const theme = room && room.secretWordTheme && room.secretWordTheme.enabled ? (room.secretWordTheme.type || null) : null
          let pool = null
          if (theme === 'animals') pool = Array.isArray(ANIMALS) ? ANIMALS.slice() : null
          else if (theme === 'fruits') pool = Array.isArray(FRUITS) ? FRUITS.slice() : null
          else if (theme === 'vegetables') pool = Array.isArray(VEGETABLES) ? VEGETABLES.slice() : null
          else if (theme === 'occupations') pool = Array.isArray(OCCUPATIONS) ? OCCUPATIONS.slice() : null
          else if (theme === 'countries') pool = Array.isArray(COUNTRIES) ? COUNTRIES.slice() : null
          else if (theme === 'instruments') pool = Array.isArray(INSTRUMENTS) ? INSTRUMENTS.slice() : null
          else if (theme === 'colours') pool = Array.isArray(COLOURS) ? COLOURS.slice() : null
          else if (theme === 'elements') pool = Array.isArray(ELEMENTS) ? ELEMENTS.slice() : null
          else if (theme === 'cpp') pool = Array.isArray(CPPTERMS) ? CPPTERMS.slice() : null

          if (theme && Array.isArray(pool) && pool.length > 0) {
            const filtered = pool.map(p => (p || '').toString().trim()).filter(p => /^[a-zA-Z]+$/.test(p) && p.length >= 2)
            if (filtered.length > 0) word = filtered[Math.floor(Math.random() * filtered.length)]
            else {
              const relaxed = pool.map(p => (p || '').toString().trim()).filter(p => p && p.length >= 2)
              if (relaxed.length > 0) word = relaxed[Math.floor(Math.random() * relaxed.length)]
            }
          } else {
            // no theme active: pick from generic nouns
            const nounsList = (NOUNS && NOUNS.default) ? NOUNS.default : NOUNS
            if (Array.isArray(nounsList) && nounsList.length > 0) word = nounsList[Math.floor(Math.random() * nounsList.length)]
          }
        } catch (e) {
          // if anything fails, fall back to nouns
          const nounsList = (NOUNS && NOUNS.default) ? NOUNS.default : NOUNS
          if (Array.isArray(nounsList) && nounsList.length > 0) word = nounsList[Math.floor(Math.random() * nounsList.length)]
        }

        const playersList = Object.keys(room.players || {})
        const spyId = playersList[Math.floor(Math.random() * playersList.length)]
          newWordSeeker.word = word
          newWordSeeker.spyId = spyId
          newWordSeeker.revealSequence = null
          // clear revealed map and lastReveal carried over from previous round
          newWordSeeker.revealed = null
          newWordSeeker.lastReveal = null
          newWordSeeker.state = 'waiting'
          newWordSeeker.lastRoundSummary = null
          updates['wordSeeker'] = newWordSeeker
          // set the room phase to waiting so the host auto-start checker can detect all-ready
          updates['phase'] = 'wordseeker_wait'
        // clear ready/vote/guesses
        playersList.forEach(pid => { updates[`players/${pid}/wordSeekerReady`] = null; updates[`players/${pid}/wordSeekerVote`] = null; updates[`players/${pid}/wordSeekerGuesses`] = null })
      }
      await update(roomRef, updates)
    }

  async function joinRoom(password = '') {
    console.log('joinRoom called with password:', password)
    if (!db) {
      playerIdRef.current = 'local-' + Math.random().toString(36).slice(2, 8)
      // local fallback: use configured starting wordmoney if available in state (accept numeric strings)
  const startLocal = (state && typeof state.startingWordmoney !== 'undefined' && !Number.isNaN(Number(state.startingWordmoney))) ? Number(state.startingWordmoney) : 2
      setState(prev => ({
        ...prev,
        players: [...(prev?.players || []), { id: playerIdRef.current, name: playerName, wordmoney: startLocal, revealed: [] }]
      }))
      return
    }

    const uid = auth && auth.currentUser ? auth.currentUser.uid : null
    const playersRefPath = `rooms/${roomId}/players`

    // TTL for eviction when someone joins: 1 hour
    const EVICT_TTL_MS = 60 * 60 * 1000
  // Stale and kick thresholds for activity handling
  const STALE_MS = 60 * 1000 // mark stale after 60s of no heartbeat
  const KICK_MS = 3 * 60 * 1000 // kick after 3 minutes of no heartbeat

    // Remove stale (non-authenticated) players whose lastSeen is older than TTL.
    // This mirrors server-side eviction but runs opportunistically when a player joins.
    async function evictStale(roomRootRef) {
      try {
        const snap = await get(roomRootRef)
        const roomVal = snap.val() || {}
        const players = roomVal.players || {}
        const now = Date.now()
        const updates = {}
        let hasUpdates = false
        Object.keys(players).forEach(pid => {
          const p = players[pid]
          if (!p) return
          // best-effort: skip likely-authenticated players (do not evict authenticated accounts)
          if (p.uid || p.authProvider || p.isAuthenticated) return
          const last = p.lastSeen ? Number(p.lastSeen) : 0
          if (!last || (now - last) > EVICT_TTL_MS) {
            updates[`players/${pid}`] = null
            hasUpdates = true
            try { console.log(`Evicting stale player ${pid} from room ${roomId} (lastSeen=${last})`) } catch (e) {}
          }
        })
        if (hasUpdates) {
          try { await update(roomRootRef, updates) } catch (e) { console.warn('evictStale: update failed', e) }
          // If room became empty after eviction, remove the room root
          try {
            const postSnap = await get(dbRef(db, `rooms/${roomId}/players`))
            const postPlayers = postSnap.val() || {}
            if (!postPlayers || Object.keys(postPlayers).length === 0) {
              try { await dbSet(roomRootRef, null); console.log(`Removing empty room ${roomId} after eviction`) } catch (e) {}
            }
          } catch (e) { /* ignore post-check errors */ }
        }
      } catch (e) {
        console.warn('evictStale failed', e)
      }
    }

    // Ensure the room has a host; if not, assign the provided id as host.
    async function ensureHost(joiningId) {
      if (!joiningId) return
      try {
        const roomRootRef = dbRef(db, `rooms/${roomId}`)
        const snap = await get(roomRootRef)
        const roomVal = snap.val() || {}
        // Only assign a host when there is no host AND either there are no players,
        // or the only player is the joiningId (i.e. the first person to join after reset).
        const playersObj = roomVal.players || {}
        const playerKeys = Object.keys(playersObj)
        const onlyJoiningIsPresent = playerKeys.length === 1 && playerKeys[0] === joiningId
        const noPlayers = playerKeys.length === 0
        if (!roomVal.hostId && (noPlayers || onlyJoiningIsPresent)) {
          try {
            // If room-level defaults are missing, set them as part of the first host assignment
            const updates = { hostId: joiningId }
            if (!roomVal.gameMode) updates.gameMode = 'lastOneStanding'
            if (!roomVal.starterBonus) updates.starterBonus = { enabled: true, description: '' }
            if (!roomVal.secretWordTheme) updates.secretWordTheme = { enabled: true, type: 'animals' }
            await update(roomRootRef, updates)
            console.log('Assigned host to', joiningId, 'for room', roomId, 'with defaults')
          } catch (e) { console.warn('ensureHost update failed', e) }
        }
      } catch (e) {
        console.warn('ensureHost failed', e)
      }
    }

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
  // Use the helper so we accept numeric strings as well as numbers and provide a sane fallback
  const startMoney = getStartMoneyFromRoom(roomVal)
      await dbSet(pRef, { id: pKey, name: playerName, wordmoney: startMoney, revealed: [], hasWord: false, color: chosen, lastSeen: Date.now(), stale: null })
      return chosen
    }

    // If the room exists and all players have been inactive for longer than the TTL,
    // reset the room to lobby (clear players, teams, and winner metadata) so a new
    // join can create a fresh session. Returns true when a reset was applied.
    async function resetRoomIfAllPlayersStale(roomRootRef, roomSnapshotVal) {
      try {
        const now = Date.now()
        const roomVal = roomSnapshotVal || (await get(roomRootRef)).val() || {}
        const players = roomVal.players || {}
        const ids = Object.keys(players)
        if (ids.length === 0) return false
        // If any player has been active within the TTL, do not reset
        const anyActive = ids.some(pid => {
          const p = players[pid] || {}
          const last = p.lastSeen ? Number(p.lastSeen) : 0
          return last && (now - last) <= EVICT_TTL_MS
        })
        if (anyActive) return false

        // All players are stale: clear players and reset room metadata to lobby
        const updates = {
          players: null,
          phase: 'lobby',
          open: true,
          // clear ghost challenge and announcements when resetting stale room
          ghostChallenge: null,
          ghostAnnouncements: null,
          teams: null,
          winnerTeam: null,
          winnerId: null,
          winnerName: null,
          // Ensure next joiner will become host and the room defaults to Last One Standing
          hostId: null,
          gameMode: 'lastOneStanding'
        }
        try {
          await update(roomRootRef, updates)
          console.log(`resetRoomIfAllPlayersStale: reset room ${roomId} to lobby (all players stale)`)
          return true
        } catch (e) {
          console.warn('resetRoomIfAllPlayersStale: update failed', e)
          return false
        }
      } catch (e) {
        console.warn('resetRoomIfAllPlayersStale failed', e)
        return false
      }
    }

    // Mark players as stale when their lastSeen is older than STALE_MS. If they
    // remain unseen for longer than KICK_MS, remove them from the room.
    // This runs opportunistically from any client and performs best-effort writes.
    async function markStaleAndKick(roomRootRef) {
      try {
        const snap = await get(roomRootRef)
        const roomVal = snap.val() || {}
        // Do not mark players stale while the room is in the lobby phase; lobby
        // participants should not be greyed or auto-removed while waiting.
        const phaseNow = roomVal.phase || 'lobby'
        if (phaseNow === 'lobby') return false
        const players = roomVal.players || {}
        const now = Date.now()
        const updates = {}
        let removedAny = false

        const turnOrder = roomVal.turnOrder || []
        const curIdx = (typeof roomVal.currentTurnIndex === 'number') ? roomVal.currentTurnIndex : null
        const curPid = (curIdx !== null && Array.isArray(turnOrder) && turnOrder.length > curIdx) ? turnOrder[curIdx] : null

        Object.keys(players).forEach(pid => {
          try {
            const p = players[pid] || {}
            // do not auto-kick likely-authenticated players (best-effort check)
            if (p.uid || p.authProvider || p.isAuthenticated) return
            // If this player has one or more open tabs registered, do not mark stale or remove.
            if (p.tabs && Object.keys(p.tabs).length > 0) return
            const last = p.lastSeen ? Number(p.lastSeen) : 0
            const isStale = !!p.stale
            if (!last || (now - last) > KICK_MS) {
              // remove player entirely
              updates[`players/${pid}`] = null
              // add a timeouts entry so clients show a removal toast
              const key = `removed_inactivity_${pid}_${now}`
              updates[`timeouts/${key}`] = { player: pid, ts: now, action: 'removed_inactivity', name: p.name || pid }
              removedAny = true
              try { console.log(`Removing inactive player ${pid} from room ${roomId} (lastSeen=${last})`) } catch (e) {}
            } else if (!isStale && last && (now - last) > STALE_MS) {
              updates[`players/${pid}/stale`] = true
              try { console.log(`Marking player ${pid} stale in room ${roomId} (lastSeen=${last})`) } catch (e) {}
            }
          } catch (e) {}
        })

        // If the current turn belongs to a newly-stale player, advance to next active
        if (curPid && updates[`players/${curPid}/stale`] === true) {
          try {
            // find next index skipping players that would be stale or removed
            const effectiveOrder = turnOrder.slice()
            const len = effectiveOrder.length || 0
            if (len > 0) {
              let found = null
              for (let offset = 1; offset <= len; offset++) {
                const idx = (curIdx + offset) % len
                const pid = effectiveOrder[idx]
                const p = players[pid] || {}
                const last = p.lastSeen ? Number(p.lastSeen) : 0
                if (last && (now - last) <= STALE_MS) { found = idx; break }
              }
              if (found !== null) {
                updates['currentTurnIndex'] = found
                updates['currentTurnStartedAt'] = Date.now()
                const key = `skip_inactivity_${curPid}_${Date.now()}`
                updates[`timeouts/${key}`] = { player: curPid, ts: Date.now(), action: 'skip_due_inactivity', name: (players[curPid] && players[curPid].name) ? players[curPid].name : curPid }
              }
            }
          } catch (e) {}
        }

        if (Object.keys(updates).length > 0) {
          try { await update(roomRootRef, updates) } catch (e) { console.warn('markStaleAndKick: update failed', e) }
        }

        if (removedAny) {
          // Re-evaluate simple win conditions: if lastOneStanding and <=1 players remain -> end
          try {
            const postSnap = await get(roomRootRef)
            const postRoom = postSnap.val() || {}
            const playersNow = postRoom.players || {}
            const pKeys = Object.keys(playersNow || {})
            const gm = postRoom.gameMode || postRoom.winnerByWordmoney ? postRoom.gameMode : 'lastOneStanding'
            const phase = postRoom.phase || null
            const updates2 = {}
            if (phase === 'playing' || phase === 'submit' || phase === 'waiting') {
              if (gm === 'lastOneStanding') {
                if (pKeys.length <= 1) {
                  updates2['phase'] = 'ended'
                  if (pKeys.length === 1) updates2['winnerId'] = pKeys[0]
                }
              } else if (gm === 'lastTeamStanding') {
                const teams = {}
                pKeys.forEach(k => { try { const t = (playersNow[k] && playersNow[k].team) ? playersNow[k].team : null; if (t) teams[t] = teams[t] || 0; if (t) teams[t]++ } catch (e) {} })
                const teamNames = Object.keys(teams)
                if (teamNames.length === 1) {
                  updates2['phase'] = 'ended'
                  updates2['winnerTeam'] = teamNames[0]
                }
              }
            }
            if (Object.keys(updates2).length > 0) {
              try { await update(roomRootRef, updates2) } catch (e) { console.warn('markStaleAndKick: post-removal win update failed', e) }
            }
          } catch (e) { console.warn('markStaleAndKick: post removal processing failed', e) }
        }
      } catch (e) {
        console.warn('markStaleAndKick failed', e)
      }
    }

    if (uid) {
      playerIdRef.current = uid
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
  // opportunistically evict very-old anonymous players before processing this join
  // NOTE: automated marking/kicking of inactive players has been disabled.
  // Hosts should remove absent players manually using the UI (red × on player tiles).
  evictStale(roomRootRef).catch(() => {})

      get(roomRootRef).then(async snapshot => {
        let roomVal = snapshot.val() || {}
        console.log('Room data fetched:', roomVal)
        // If an authenticated player node already exists for this UID, reuse it instead of overwriting
        const playersObj = roomVal.players || {}
        if (playersObj && playersObj[uid]) {
          playerIdRef.current = uid
          const pRef = dbRef(db, `${playersRefPath}/${uid}`)
          try { update(pRef, { lastSeen: Date.now(), stale: null, ...(playerName && playerName.toString().trim() ? { name: playerName } : {}) }) } catch (e) {}
          try { startHeartbeat() } catch (e) {}
          setState(prev => ({ ...prev, password: roomVal?.password || password }))
          console.log('Reused existing authenticated player node for uid', uid)
          return
        }

        if (!snapshot.exists()) {
          // Create room with sensible defaults persisted so all clients observe them
          dbSet(roomRootRef, {
            hostId: uid,
            phase: 'lobby',
            open: true,
            players: {},
            password: password || '',
            // default game mode for new rooms
              gameMode: 'lastOneStanding',
            // enable starter bonus and secret-word theme by default for new rooms
            starterBonus: { enabled: true, description: '' },
            secretWordTheme: { enabled: true, type: 'animals' }
          })
          console.log('Room created with password and defaults:', password)
          // pick color and add player
          pickColorAndSetPlayer(uid).then(async chosen => {
            setState(prev => ({ ...prev, password: password }))
            console.log('Player joined new room with color:', chosen)
            try { startHeartbeat() } catch (e) {}
            try { await ensureHost(uid) } catch (e) {}
          })
          return
        }

        // room exists but no existing player node for this UID. Enforce open/password before creating a new node.
        if (roomVal && roomVal.open === false) {
          // Attempt to reset the room to lobby if all players are stale. If reset
          // succeeds, refresh roomVal and continue; otherwise reject the join.
          try {
            const didReset = await resetRoomIfAllPlayersStale(roomRootRef, roomVal)
            if (didReset) {
              const refreshed = (await get(roomRootRef)).val() || {}
              roomVal = refreshed
            } else {
              console.warn('Room is closed to new joins')
              return
            }
          } catch (e) {
            console.warn('Error while attempting stale-room reset', e)
            return
          }
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
        pickColorAndSetPlayer(uid).then(async chosen => {
          setState(prev => ({ ...prev, password: roomVal?.password || password }))
          console.log('Player joined room with color:', chosen)
          try { startHeartbeat() } catch (e) {}
          try { await ensureHost(uid) } catch (e) {}
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
          const upd = { lastSeen: Date.now(), stale: null }
          // if this is an authenticated user (uid path) don't overwrite name unless explicitly provided
          if (playerName && playerName.toString().trim()) upd.name = playerName
          await update(pRef, upd)
        } catch (e) {}
        try { startHeartbeat() } catch (e) {}
        console.log('Rejoined anonymous player id from localStorage', storedAnonId)
        return
      }
      // If localStorage has an anon id but the server node was removed (kicked/evicted),
      // attempt to recreate the node using the same id so the client retains its identity.
      try {
        console.log('Stored anon id found but server node missing; attempting recreate for', storedAnonId)
        playerIdRef.current = storedAnonId
        await pickColorAndSetPlayer(storedAnonId)
        try { startHeartbeat() } catch (e) {}
        try { await ensureHost(storedAnonId) } catch (e) {}
        try { window.localStorage && window.localStorage.setItem(`gh_anon_${roomId}`, storedAnonId) } catch (e) {}
        console.log('Recreated anonymous player node with stored id', storedAnonId)
        return
      } catch (e) {
        console.warn('Could not recreate stored anon id node, will create a new anon id instead', e)
      }
      // if stored id doesn't exist server-side, fall through and create a fresh one
    }

    // check max players before creating a new anonymous player
    const roomRootRef2 = dbRef(db, `rooms/${roomId}`)
    // opportunistically evict very-old anonymous players before creating new anon
    // NOTE: automated marking/kicking of inactive players has been disabled.
    // Hosts should remove absent players manually using the UI (red × on player tiles).
    await evictStale(roomRootRef2)
    const roomSnap = await get(roomRootRef2)
    let rv = roomSnap.val() || {}
    // If the room is closed to new joins, attempt to reset when all players are stale.
    if (rv && rv.open === false) {
      try {
        const didReset = await resetRoomIfAllPlayersStale(roomRootRef2, rv)
        if (didReset) {
          const refreshed = (await get(roomRootRef2)).val() || {}
          rv = refreshed
        } else {
          console.warn('Room is closed to new joins')
          return
        }
      } catch (e) {
        console.warn('Error while attempting stale-room reset', e)
        return
      }
    }
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
    pickColorAndSetPlayer(newPlayerRef.key).then(async chosen => {
      try {
        window.localStorage && window.localStorage.setItem(`gh_anon_${roomId}`, newPlayerRef.key)
      } catch (e) {}
      console.log('Anonymous player joined with color:', chosen)
      try { startHeartbeat() } catch (e) {}
      try { await ensureHost(newPlayerRef.key) } catch (e) {}
    })
  }

  // Periodic background mark/kick behavior disabled.
  // Historically the client ran a periodic tick that would mark players as stale,
  // advance turns, and remove players after timeouts. That behaviour is now
  // disabled in favor of manual host-controlled removal. Keep presence (heartbeats
  // and per-tab registration) active so hosts can see who is connected and choose
  // to remove absent players via the UI.

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
  // Clear any previous winner metadata to be safe on rematch/restart
  // This ensures stale `winnerTeam` or winner labels don't persist across games.
  try { updates['winnerTeam'] = null; updates['winnerId'] = null; updates['winnerName'] = null } catch (e) {}
  // Also clear per-team initial count and compensation markers so rematch starts fresh
  try {
    const teamNames = (room && room.teams) ? Object.keys(room.teams || {}) : []
    teamNames.forEach(t => {
      try { updates[`teams/${t}/initialCount`] = null } catch (e) {}
      try { updates[`teams/${t}/compensationApplied`] = null } catch (e) {}
    })
  } catch (e) {}
    if (options && options.timed) {
      updates.timed = true
      updates.turnTimeoutSeconds = Math.max(10, Math.min(300, Number(options.turnSeconds) || 30))
    } else {
      updates.timed = false
      updates.turnTimeoutSeconds = null
    }
    // handle starter bonus option: only modify starterBonus when the caller
    // explicitly provided the starterEnabled flag. If omitted, preserve the
    // room's existing starterBonus setting so resets/rematches don't toggle it.
    if (options && typeof options.starterEnabled !== 'undefined') {
      if (options.starterEnabled) {
        try {
          const letters = 'abcdefghijklmnopqrstuvwxyz'
          const letter = letters[Math.floor(Math.random() * letters.length)]
          updates.starterBonus = { enabled: true, type: 'contains', value: letter, description: `Your word contains the letter "${letter.toLowerCase()}".`, applied: false }
        } catch (e) {
          // ignore
        }
      } else {
        // explicitly requested to disable starter bonus
        updates.starterBonus = null
      }
    } else {
      // no explicit instruction from caller: leave starterBonus unchanged
    }

    // Ensure every player has an explicit starting wordmoney set. Do not overwrite
    // existing numeric values : only initialize missing entries so the first-player
    // +1 award is always computed relative to the room-configured starting value.
    try {
      // Prefer an explicit startingWordmoney passed in options (host UI) so
      // rapid host actions respect the locally-entered value even if the DB
      // hasn't fully propagated yet. Otherwise fall back to the room value.
      let startMoney = null
      try {
        if (options && typeof options.startingWordmoney !== 'undefined' && !Number.isNaN(Number(options.startingWordmoney))) {
          startMoney = Number(options.startingWordmoney)
        }
      } catch (e) {}
      if (startMoney === null) startMoney = getStartMoneyFromRoom(room)
      const playersObj = room.players || {}
      // Respect lastTeamStanding: do not initialize per-player canonical balances when using team mode.
      const gm = (room && room.gameMode) ? room.gameMode : (options && options.gameMode)
      if (gm !== 'lastTeamStanding') {
        // Apply the resolved starting money to every player explicitly so the
        // host-configured `startingWordmoney` is honored when a game starts.
        // Previously we only initialized missing entries; that could leave
        // players with stale balances from lobby interactions. Overwrite here
        // so every participant begins the round with the configured amount.
        Object.keys(playersObj).forEach(pid => {
          try { updates[`players/${pid}/wordmoney`] = startMoney } catch (e) {}
        })
      }
      // Debug: log resolved starting money and what will be written for players
      try {
        console.log('startGame debug: resolved startMoney=', startMoney)
        try { console.log('startGame debug: player ids=', Object.keys(playersObj)) } catch (e) {}
        try { console.log('startGame debug: updates sample=', Object.keys(updates).slice(0,20)) } catch (e) {}
      } catch (e) {}

      // If the room is configured to use the Last Theme Standing mode, assign
      // players to two teams (red/blue), initialize a shared team wallet and
      // a single-active freeze slot per team. Require minimum 3 players.
  if ((room && room.gameMode ? room.gameMode : (options && options.gameMode)) === 'lastTeamStanding') {
        const playerIds = Object.keys(playersObj || {})
        if ((playerIds || []).length < 3) {
          // show a UI-visible warning instead of console log; clear it when mode changes or enough players join
          setState(prev => ({ ...(prev || {}), ltsWarning: 'Last Team Standing requires at least 3 players' }))
          // watch the room root and clear the warning when conditions change
          let warnUnsub = null
          const warnCb = (snap) => {
            try {
              const rv = snap.val() || {}
              const countNow = Object.keys(rv.players || {}).length
              const gmNow = rv.gameMode
              if (gmNow !== 'lastTeamStanding' || countNow >= 3) {
                setState(prev => {
                  if (!prev) return prev
                  const copy = { ...prev }
                  delete copy.ltsWarning
                  return copy
                })
                try { if (warnUnsub) warnUnsub() } catch (e) {}
              }
            } catch (e) {}
          }
          warnUnsub = dbOnValue(dbRef(db, `rooms/${roomId}`), warnCb)
          return
        }
        // shuffle player ids and split into two teams alternately
        const shuffled = playerIds.slice().sort(() => Math.random() - 0.5)
        const teams = { red: [], blue: [] }
        shuffled.forEach((pid, idx) => {
          const team = (idx % 2 === 0) ? 'red' : 'blue'
          teams[team].push(pid)
          updates[`players/${pid}/team`] = team
        })
        // initialize team wallets to sum of individual starting money for each team
        try {
          const redCount = teams.red.length || 0
          const blueCount = teams.blue.length || 0
          updates[`teams/red/wordmoney`] = redCount * startMoney
          updates[`teams/blue/wordmoney`] = blueCount * startMoney
          updates[`teamFreeze`] = { red: null, blue: null }
          // persist initial team sizes so server-side logic can compute balanced win
          updates[`teams/red/initialCount`] = redCount
          updates[`teams/blue/initialCount`] = blueCount
          // if teams are uneven, compensate the smaller team so they are balanced
          try {
            if (redCount !== blueCount) {
              const smaller = redCount < blueCount ? 'red' : 'blue'
              // compensation: at least startingWordmoney; if starterEnabled for this game, include +10
              const compBase = startMoney
              const compExtra = (options && options.starterEnabled) ? 10 : 0
              const comp = compBase + compExtra
              updates[`teams/${smaller}/wordmoney`] = (updates[`teams/${smaller}/wordmoney`] || 0) + comp
              // record what compensation was applied so UI or rematch logic can inspect it
              updates[`teams/${smaller}/compensationApplied`] = comp
            }
          } catch (e) {}
        } catch (e) {}
      }
    } catch (e) {}

    await update(roomRef, updates)
  }

  // Create a bot player in the room. Only host should call this (UI enforces),
  // but we perform best-effort checks here as well.
  async function addBot({ difficulty = 'medium', delayMs = 4000 } = {}) {
    if (!db) return null
    const uid = playerIdRef.current
    if (!uid) return null
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.hostId !== uid) return null

    // build a unique bot id
    const botId = `bot_${Math.random().toString(36).slice(2,8)}_${Date.now()}`
    // choose a color not already used (best-effort)
    const used = new Set(Object.keys(room.players || {}).map(k => (room.players[k] && room.players[k].color) ? room.players[k].color : null).filter(Boolean))
    let chosen = BOT_PALETTE.find(c => !used.has(c))
    if (!chosen) {
      const hash = Array.from(botId).reduce((acc,ch)=>acc + ch.charCodeAt(0), 0)
      chosen = BOT_PALETTE[hash % BOT_PALETTE.length]
    }

    const startMoney = getStartMoneyFromRoom(room)
    // Short, friendly bot names (keep overall length < 10 when prefixed with "Bot ")
    const SHORT_BOT_NAMES = [
      'Sam','Fae','Zoe','Max','Ava','Mia','Lia','Ben','Leo','Ivy','Eli','Kai','Bit','Noa','Ada','Amy','Ray','Tia','Bo','Lux','Jax','Liv','Sky','Ash','Jay','Cia','Ren','Nia','Dax','Zia','Cy','Rue','Sol','Pax','Alex','Rex','Jude','Cleo','Ezra','Finn','Nova','Sage','Toby','Vera','Lex','Zara','Leaf','Wren','Orin','Indy', 'Quin', 'Rory', 'Seth', 'Tess', 'Zane','Bea','Harry','Luna','Nina','Ollie','Rita','Theo','Vivi','Wade','Zeke','Cody','Demi', 'Gus','Hale','Joni','Kira','Lyle','Mara','Nico','Opal','Rey','Skye','Tara','Vail', 'Zuri','Rumi','Toast','Butter','Mochi','Pixel','Bingo','Jinx','Pip','Doodle','Snickers','Bubbles','Clover','Peanut','Gizmo','Nibbles','Sprout','Widget','Ziggy','Muffin','Cupcake','Pumpkin','Peaches','Pickles','Fox','Poppy','Daisy','Maple','Coco','Sunny','Basil','Pebble','Pogo','Toto','Yuki','Miso','Koko','Suki','Aya','Kiki','Lulu','Mimi','Nana','Rara','Sasa','Titi','Zaza','Bibi','Didi','Fifi','Gigi','Jojo','Kaka','Lala','Nene','Pipi','Riri','Titi','Vivi','Zuzu','Sleepy','Happy','Sparky','Buddy','Shadow','Smokey','Midnight','Tiger','Bear','Rocky','Bandit','Rusty','Scout','Ace','Chief','Duke','King','Prince','Ranger','Sarge','Tank','Thor','Zeus','Blaze','Comet','Flash','Hawk','Jett','Nova','Rocket','Storm','Dash','Frost','Ghost','Hurricane','Lightning','Phantom','Razor','Vortex','Whisper','Wolf','Cheetah','Eagle','Falcon','Jaguar','Lynx','Puma','Raven','Shark','Tiger','Viper','Wolverine','Taylor','Swift','Jordan','Morgan','Casey','Riley','Avery','Parker','Quinn','Reese','Sawyer','Emery','Finley','Hayden','Kendall','Logan','Madison','Peyton','Rowan','Skyler','Tatum','Blair','Drew','Elliot','Frankie','Harper','Jesse','Karter','Lee','Micah','Nolan','Oakley','Phoenix','Reagan','Sloane','Terry','Winter', 'Zion', 'Arlo','Bodhi','Cruz','Enzo','Hugo','Ira','Jax','Kian','Leif','Milo','Nico','Otis','Rafe','Soren','Taj','Viggo','Wynn','Bot','Zig','Neo','Rio','Jap','Hunger'
    ]
    const pick = SHORT_BOT_NAMES[Math.floor(Math.random() * SHORT_BOT_NAMES.length)]
    const botName = `${pick} Bot 🤖`
    const botNode = {
      id: botId,
      name: botName,
      wordmoney: startMoney,
      revealed: [],
      hasWord: false,
      color: chosen,
      // Ensure bots are considered ready in lobby/word-seeker waiting so hosts
      // can start games that require all players to be 'ready'.
      wordSeekerReady: true,
      // Mark bot as ready in the general lobby ready indicator as well.
      ready: true,
      isBot: true,
      botSettings: { difficulty: (''+difficulty).toString(), delayMs: Number(delayMs) || 4000 },
      lastSeen: Date.now(),
    }
    try {
      const updates = {}
      // If the room is currently in the submit phase, have the bot pick a word
      // immediately and mark hasWord=true so it doesn't block game start.
      try {
        if (room && room.phase === 'submit') {
          // Decide candidate pool based on secretWordTheme when enabled
          let pool = null
          try {
            const theme = room && room.secretWordTheme && room.secretWordTheme.enabled ? (room.secretWordTheme.type || null) : null
            if (theme === 'animals') pool = Array.isArray(ANIMALS) ? ANIMALS.slice() : null
            else if (theme === 'fruits') pool = Array.isArray(FRUITS) ? FRUITS.slice() : null
            else if (theme === 'vegetables') pool = Array.isArray(VEGETABLES) ? VEGETABLES.slice() : null
            else if (theme === 'occupations') pool = Array.isArray(OCCUPATIONS) ? OCCUPATIONS.slice() : null
            else if (theme === 'countries') pool = Array.isArray(COUNTRIES) ? COUNTRIES.slice() : null
            else if (theme === 'instruments') pool = Array.isArray(INSTRUMENTS) ? INSTRUMENTS.slice() : null
            else if (theme === 'colours') pool = Array.isArray(COLOURS) ? COLOURS.slice() : null
            else if (theme === 'elements') pool = Array.isArray(ELEMENTS) ? ELEMENTS.slice() : null
            else if (theme === 'cpp') pool = Array.isArray(CPPTERMS) ? CPPTERMS.slice() : null
          } catch (e) { pool = null }

          // fallback to generic NOUNS when no theme pool is available
          if (!pool || !Array.isArray(pool) || pool.length === 0) {
            const nounsList = (NOUNS && NOUNS.default) ? NOUNS.default : NOUNS
            pool = Array.isArray(nounsList) ? nounsList.slice() : []
          }

          // sanitize pool: alphabetic-only, lowercased, length >= 2
          const sanitizedPool = (pool || []).map(p => (p||'').toString().trim().toLowerCase()).filter(p => /^[a-zA-Z]+$/.test(p) && p.length >= 2)

          // determine sample size X by difficulty (easy/medium/hard)
          const diff = ('' + difficulty).toLowerCase()
          let sampleCount = 6
          if (diff === 'easy') sampleCount = 3
          else if (diff === 'medium') sampleCount = 8
          else if (diff === 'hard') sampleCount = 24

          // helper: get N random unique samples from array
          const sample = (arr, n) => {
            const set = new Set()
            const max = Math.min(arr.length, n || arr.length)
            let attempts = 0
            while (set.size < max && attempts < 1000) {
              const i = Math.floor(Math.random() * arr.length)
              set.add(arr[i])
              attempts++
            }
            return Array.from(set)
          }

          const candidates = sample(sanitizedPool, sampleCount)

          // If starter bonus is enabled and expects a containing letter, prefer a candidate that contains it
          let chosenWord = null
          try {
            const sb = room && room.starterBonus ? room.starterBonus : null
            const letterReq = (sb && sb.enabled && sb.type === 'contains' && sb.value) ? String(sb.value).toLowerCase() : null
            if (letterReq) {
              const found = candidates.find(c => c && c.indexOf(letterReq) !== -1)
              if (found) chosenWord = found
            }
          } catch (e) {}

          // fallback: pick any candidate
          if (!chosenWord) {
            if (candidates.length > 0) chosenWord = candidates[Math.floor(Math.random() * candidates.length)]
            else chosenWord = sanitizedPool.length > 0 ? sanitizedPool[Math.floor(Math.random() * sanitizedPool.length)] : null
          }

          if (chosenWord) {
            // prepare updates for bot's submitted word and hasWord marker
            updates[`players/${botId}/word`] = chosenWord
            updates[`players/${botId}/hasWord`] = true
            // if starter bonus applies, award it using helper (team-aware)
            try {
              const sb = room && room.starterBonus ? room.starterBonus : null
              const letterReq = (sb && sb.enabled && sb.type === 'contains' && sb.value) ? String(sb.value).toLowerCase() : null
              if (letterReq && chosenWord.indexOf(letterReq) !== -1) {
                // mark starterBonusAwarded so other logic doesn't double-award
                updates[`players/${botId}/starterBonusAwarded`] = true
                // award +10 (match submitWord logic)
                try { applyAwardToUpdates(updates, room, botId, 10, { reason: 'starterBonus', by: null }) } catch (e) {}
                // reveal the starter letter on the bot's tile (merge with existing revealed)
                try {
                  const existing = Array.isArray(botNode.revealed) ? botNode.revealed.slice() : []
                  if (!existing.map(x => (x||'').toString().toLowerCase()).includes(letterReq)) {
                    const next = Array.from(new Set([...(existing || []), letterReq]))
                    updates[`players/${botId}/revealed`] = next
                  }
                } catch (e) {}
              }
            } catch (e) {}
            // also set the botNode locally so the full node write below includes these fields
            botNode.word = chosenWord
            botNode.hasWord = true
            if (!botNode.revealed) botNode.revealed = []
          }
        }
      } catch (e) {
        console.warn('addBot: bot submit-phase word selection failed', e)
      }

      updates[`players/${botId}`] = botNode
      await update(roomRef, updates)
      return botId
    } catch (e) {
      console.warn('addBot failed', e)
      return null
    }
  }

  // When a submit phase starts, the host should auto-assign words to any bots
  // that haven't submitted yet so they don't block game start. We run this
  // once per submit-phase transition (host-only) to avoid duplicate writes.
  const lastAssignedSubmitRef = useRef(false)
  useEffect(() => {
    if (!db) return
    try {
      const phase = state && state.phase
      if (phase !== 'submit') {
        lastAssignedSubmitRef.current = false
        return
      }
      if (lastAssignedSubmitRef.current) return
      // Only the host should perform assignments
      const myId = playerIdRef.current
      if (!myId) return
      if (!state || state.hostId !== myId) return
      // perform assignment asynchronously, don't block render
      (async () => {
        try {
          await assignWordsToBots()
          lastAssignedSubmitRef.current = true
        } catch (e) {
          console.warn('assignWordsToBots failed', e)
        }
      })()
    } catch (e) { console.warn('submit-phase assign effect failed', e) }
  }, [state && state.phase])

  async function assignWordsToBots() {
    if (!db) return
    const uid = playerIdRef.current
    if (!uid) return
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.phase !== 'submit') return
    if (room.hostId !== uid) return
    const playersObj = room.players || {}
    const updates = {}
    try {
      for (const pid of Object.keys(playersObj || {})) {
        try {
          const p = playersObj[pid] || {}
          if (!p || !p.isBot) continue
          if (p.hasWord) continue
          // build pool based on theme
          let pool = null
          try {
            const theme = room && room.secretWordTheme && room.secretWordTheme.enabled ? (room.secretWordTheme.type || null) : null
            if (theme === 'animals') pool = Array.isArray(ANIMALS) ? ANIMALS.slice() : null
            else if (theme === 'fruits') pool = Array.isArray(FRUITS) ? FRUITS.slice() : null
            else if (theme === 'vegetables') pool = Array.isArray(VEGETABLES) ? VEGETABLES.slice() : null
            else if (theme === 'occupations') pool = Array.isArray(OCCUPATIONS) ? OCCUPATIONS.slice() : null
            else if (theme === 'countries') pool = Array.isArray(COUNTRIES) ? COUNTRIES.slice() : null
            else if (theme === 'instruments') pool = Array.isArray(INSTRUMENTS) ? INSTRUMENTS.slice() : null
            else if (theme === 'colours') pool = Array.isArray(COLOURS) ? COLOURS.slice() : null
            else if (theme === 'elements') pool = Array.isArray(ELEMENTS) ? ELEMENTS.slice() : null
            else if (theme === 'cpp') pool = Array.isArray(CPPTERMS) ? CPPTERMS.slice() : null
          } catch (e) { pool = null }
          if (!pool || !Array.isArray(pool) || pool.length === 0) {
            const nounsList = (NOUNS && NOUNS.default) ? NOUNS.default : NOUNS
            pool = Array.isArray(nounsList) ? nounsList.slice() : []
          }
          const sanitizedPool = (pool || []).map(x => (x||'').toString().trim().toLowerCase()).filter(x => /^[a-zA-Z]+$/.test(x) && x.length >= 2)

          // difficulty-based sampling
          const diff = (p.botSettings && p.botSettings.difficulty) ? (''+p.botSettings.difficulty).toLowerCase() : 'medium'
          let sampleCount = 6
          if (diff === 'easy') sampleCount = 3
          else if (diff === 'medium') sampleCount = 8
          else if (diff === 'hard') sampleCount = 24

          const sample = (arr, n) => {
            const set = new Set()
            const max = Math.min(arr.length, n || arr.length)
            let attempts = 0
            while (set.size < max && attempts < 2000) {
              const i = Math.floor(Math.random() * arr.length)
              set.add(arr[i])
              attempts++
            }
            return Array.from(set)
          }

          const candidates = sample(sanitizedPool, sampleCount)
          let chosenWord = null
          try {
            const sb = room && room.starterBonus ? room.starterBonus : null
            const letterReq = (sb && sb.enabled && sb.type === 'contains' && sb.value) ? String(sb.value).toLowerCase() : null
            if (letterReq) {
              const found = candidates.find(c => c && c.indexOf(letterReq) !== -1)
              if (found) chosenWord = found
            }
          } catch (e) {}
          if (!chosenWord) {
            if (candidates.length > 0) chosenWord = candidates[Math.floor(Math.random() * candidates.length)]
            else chosenWord = sanitizedPool.length > 0 ? sanitizedPool[Math.floor(Math.random() * sanitizedPool.length)] : null
          }
          if (chosenWord) {
            updates[`players/${pid}/word`] = chosenWord
            updates[`players/${pid}/hasWord`] = true
            // apply starter bonus if needed
            try {
              const sb = room && room.starterBonus ? room.starterBonus : null
              const letterReq = (sb && sb.enabled && sb.type === 'contains' && sb.value) ? String(sb.value).toLowerCase() : null
              if (letterReq && chosenWord.indexOf(letterReq) !== -1) {
                updates[`players/${pid}/starterBonusAwarded`] = true
                try { applyAwardToUpdates(updates, room, pid, 10, { reason: 'starterBonus', by: null }) } catch (e) {}
                try {
                  const existing = Array.isArray(playersObj[pid].revealed) ? playersObj[pid].revealed.slice() : []
                  if (!existing.map(x => (x||'').toString().toLowerCase()).includes(letterReq)) {
                    const next = Array.from(new Set([...(existing || []), letterReq]))
                    updates[`players/${pid}/revealed`] = next
                  }
                } catch (e) {}
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      if (Object.keys(updates).length > 0) {
        try { await update(roomRef, updates) } catch (e) { console.warn('assignWordsToBots update failed', e) }
      }
    } catch (e) { console.warn('assignWordsToBots failed', e) }
  }

  // Remove a bot player created previously. Only the host should perform this.
  async function removeBot(botId) {
    if (!db) return false
    const uid = playerIdRef.current
    if (!uid) return false
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.hostId !== uid) return false
    try {
      const updates = {}
      updates[`players/${botId}`] = null
      await update(roomRef, updates)
      return true
    } catch (e) {
      console.warn('removeBot failed', e)
      return false
    }
  }

  // Helper: pick a letter to guess using a frequency-biased distribution
  const LETTER_FREQ = 'etaoinshrdlcumwfgypbvkjxqz'
  function weightedRandomLetter() {
    // bias towards earlier letters by randomly sampling an index with squared weight
    const r = Math.random()
    const idx = Math.floor(Math.pow(r, 0.7) * LETTER_FREQ.length)
    return LETTER_FREQ[Math.max(0, Math.min(LETTER_FREQ.length - 1, idx))]
  }

  // Push a guess into the room queue as if the bot made it (from botId)
  async function botPushGuess(botId, botName, targetId, payload) {
    if (!db) return
    try {
      const qRef = dbRef(db, `rooms/${roomId}/queue`)
      await dbPush(qRef, {
        from: botId,
        fromName: botName || (`Bot`),
        target: targetId,
        payload,
        ts: Date.now(),
      })
    } catch (e) {
      console.warn('botPushGuess failed', e)
    }
  }

  // High-level bot move: choose target, choose action (letter or word) and submit.
  // Difficulty influences how often a bot attempts full-word guesses and whether
  // it prefers target-specific unrevealed letters.
  async function botMakeMove(botId) {
    if (!db) return
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      const playersObj = room.players || {}
      const botNode = playersObj[botId]
      if (!botNode) return
      if (room.phase !== 'playing') return

      // Ensure we only act when it is this bot's actual turn. This guards against
      // accidental calls or race conditions where the host-scheduler invoked botMakeMove
      // but the turn advanced before the bot acted.
      try {
        const order = room.turnOrder || []
        const idx = (typeof room.currentTurnIndex === 'number') ? room.currentTurnIndex : 0
        const currentPlayerId = (idx !== null && Array.isArray(order) && order.length > idx) ? order[idx] : null
        // Also consult the in-memory `state` snapshot as a fallback for timing/race cases
        const localOrder = (state && Array.isArray(state.turnOrder)) ? state.turnOrder : null
        const localIdx = (state && typeof state.currentTurnIndex === 'number') ? state.currentTurnIndex : null
        const localCurrent = (localOrder && localIdx !== null && localOrder.length > localIdx) ? localOrder[localIdx] : null
        try { console.log('botMakeMove: turn check', { botId, currentPlayerId, idx, localCurrent, localIdx }) } catch (e) {}
        if (currentPlayerId !== botId && localCurrent !== botId) {
          try { console.log('botMakeMove: skipped because not bot turn (both snapshot & local)', { botId, currentPlayerId, localCurrent, idx, localIdx }) } catch (e) {}
          return
        }
      } catch (e) {}

      // choose an alive non-bot target: prefer the player with the most wordmoney
      const aliveKeys = Object.keys(playersObj).filter(k => {
        try { const p = playersObj[k] || {}; return p && !p.eliminated && p.id !== botId && !p.isBot } catch (e) { return false }
      })
      if (!aliveKeys || aliveKeys.length === 0) return
      // compute numeric wordmoney (fallback to 0)
      const scored = aliveKeys.map(k => {
        try { const p = playersObj[k] || {}; return { id: k, score: Number(p.wordmoney) || 0 } } catch (e) { return { id: k, score: 0 } }
      })
      // find max score
      let maxScore = -Infinity
      scored.forEach(s => { if (typeof s.score === 'number' && s.score > maxScore) maxScore = s.score })
      // pick among ties at random
      const topCandidates = scored.filter(s => s.score === maxScore).map(s => s.id)
  const targetId = topCandidates.length > 0 ? topCandidates[Math.floor(Math.random() * topCandidates.length)] : (scored.length > 0 ? scored[Math.floor(Math.random() * scored.length)].id : aliveKeys[0])
      const targetNode = playersObj[targetId] || {}

  try { console.log('botMakeMove: selected target', { botId, targetId, targetMoney: Number(targetNode.wordmoney) || 0, myMoney: Number(botNode.wordmoney) || 0 }) } catch (e) {}

      const bs = (botNode.botSettings || {})
      const difficulty = (bs.difficulty || (room.botSettings && room.botSettings.difficulty) || 'medium')

      // Strategic power-up usage before guessing. Bots prefer to
      // - reveal an unrevealed letter from the richest player's word
      // - freeze a richer rival to slow them down
      // - occasionally trigger a price surge
      try {
        const affordable = (botNode && typeof botNode.wordmoney === 'number') ? Number(botNode.wordmoney) : getStartMoneyFromRoom(room)
        const buyRoll = Math.random()
        try { console.log('botMakeMove: affordability check', { botId, affordable, buyRoll, difficulty }) } catch (e) {}
        // prefer purchases on medium+ difficulty (probabilistic)
        if ((difficulty === 'hard' && buyRoll < 0.22) || (difficulty === 'medium' && buyRoll < 0.12)) {
          // 1) If target has a word and unrevealed letters, prefer The Unseen when affordable
          try {
            const targetWord = (targetNode && targetNode.word) ? String(targetNode.word).toLowerCase() : null
            const revealed = Array.isArray(targetNode.revealed) ? targetNode.revealed.map(x => (x||'').toString().toLowerCase()) : []
            if (targetWord) {
              const unrevealed = Array.from(new Set(targetWord.split('').filter(ch => /^[a-z]$/.test(ch) && !revealed.includes(ch))))
                  if (unrevealed.length > 0 && affordable >= 6) {
                // Hard bots strongly prefer revealing; medium bots sometimes do
                if (difficulty === 'hard' || (difficulty === 'medium' && Math.random() < 0.7)) {
                  // debug log
                  try { console.log('botMakeMove: attempting the_unseen', { botId, targetId, affordable, unrevealedCount: unrevealed.length }) } catch (e) {}
                  try {
                    const ok = await botPurchasePowerUp(botId, 'the_unseen', targetId)
                    if (ok) {
                      // End the bot's turn after playing a non-double-down power-up
                      try {
                        const order = room.turnOrder || []
                        const curIdx = (typeof room.currentTurnIndex === 'number') ? room.currentTurnIndex : 0
                        const len = (order && order.length) || 1
                        const nextIndex = (curIdx + 1) % len
                        const upd = { currentTurnIndex: nextIndex, currentTurnStartedAt: Date.now() }
                        const nextPlayer = order[nextIndex]
                        if (nextPlayer) {
                          upd[`players/${nextPlayer}/frozen`] = null
                          upd[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
                          upd[`priceSurge/${nextPlayer}`] = null
                        }
                        await update(roomRef, upd)
                      } catch (err) { console.warn('botMakeMove: could not advance turn after the_unseen', err) }
                      return
                    }
                  } catch (e) {}
                }
              }
            }
          } catch (e) {}

          // 2) If the target is richer than the bot by a margin, consider Word Freeze to stop them
          try {
            const targetMoney = Number(targetNode.wordmoney) || 0
            const myMoney = Number(botNode.wordmoney) || 0
            const targetFrozen = !!targetNode.frozen
              if (!targetFrozen && affordable >= 3 && targetMoney > myMoney + 2) {
              // Hard bots will freeze more aggressively; medium bots with some probability
              if (difficulty === 'hard' || (difficulty === 'medium' && Math.random() < 0.5)) {
                try { console.log('botMakeMove: attempting word_freeze', { botId, targetId, affordable, targetMoney, myMoney }) } catch (e) {}
                try {
                  const ok = await botPurchasePowerUp(botId, 'word_freeze', targetId)
                  if (ok) {
                    try {
                      const order = room.turnOrder || []
                      const curIdx = (typeof room.currentTurnIndex === 'number') ? room.currentTurnIndex : 0
                      const len = (order && order.length) || 1
                      const nextIndex = (curIdx + 1) % len
                      const upd = { currentTurnIndex: nextIndex, currentTurnStartedAt: Date.now() }
                      const nextPlayer = order[nextIndex]
                      if (nextPlayer) {
                        upd[`players/${nextPlayer}/frozen`] = null
                        upd[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
                        upd[`priceSurge/${nextPlayer}`] = null
                      }
                      await update(roomRef, upd)
                    } catch (err) { console.warn('botMakeMove: could not advance turn after word_freeze', err) }
                    return
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}

          // 3) Occasional price surge to annoy others
          try {
            if (affordable >= 2 && ((difficulty === 'hard' && Math.random() < 0.08) || (difficulty === 'medium' && Math.random() < 0.03))) {
              try { console.log('botMakeMove: attempting price_surge', { botId, affordable }) } catch (e) {}
              try {
                const ok = await botPurchasePowerUp(botId, 'price_surge', null)
                if (ok) {
                  try {
                    const order = room.turnOrder || []
                    const curIdx = (typeof room.currentTurnIndex === 'number') ? room.currentTurnIndex : 0
                    const len = (order && order.length) || 1
                    const nextIndex = (curIdx + 1) % len
                    const upd = { currentTurnIndex: nextIndex, currentTurnStartedAt: Date.now() }
                    const nextPlayer = order[nextIndex]
                    if (nextPlayer) {
                      upd[`players/${nextPlayer}/frozen`] = null
                      upd[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
                      upd[`priceSurge/${nextPlayer}`] = null
                    }
                    await update(roomRef, upd)
                  } catch (err) { console.warn('botMakeMove: could not advance turn after price_surge', err) }
                  return
                }
              } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}

  // difficulty -> chance of full-word guess
      const wordGuessChance = difficulty === 'hard' ? 0.22 : (difficulty === 'medium' ? 0.12 : 0.05)
      let tryWord = Math.random() < wordGuessChance

      // If blanks are shown or the bot has a private length reveal (letter_scope) and the bot
      // (public reveals + its private knowledge) effectively knows every letter of the target
      // word, force a full-word attempt. Also allow assembling candidate lists when the bot
      // has private info about the target (so bots who buy letter_scope can attempt words).
      try {
        const hasPrivatePPR = !!(botNode.privatePowerReveals && botNode.privatePowerReveals[targetId])
        const ownerWord = (targetNode && targetNode.word) ? String(targetNode.word).toLowerCase() : null
        // gather public revealed letters
        const pub = Array.isArray(targetNode && targetNode.revealed) ? targetNode.revealed.map(x => (x||'').toString().toLowerCase()) : []
        const known = new Set()
        pub.forEach(ch => { if (ch) known.add(ch) })
        // include bot's privateHits against this target
        try { (botNode.privateHits && botNode.privateHits[targetId] || []).forEach(h => { if (h && h.letter) known.add((h.letter||'').toString().toLowerCase()) }) } catch (e) {}
        // include any privatePowerReveals the bot has for this target
        try { const ppr = hasPrivatePPR ? Object.values(botNode.privatePowerReveals[targetId]) : []; ppr.forEach(r => { try { if (!r || !r.result) return; const res = r.result || {}; if (res.letter) known.add((res.letter||'').toString().toLowerCase()); if (res.last) known.add((res.last||'').toString().toLowerCase()); if (Array.isArray(res.letters)) res.letters.forEach(ch => ch && known.add((ch||'').toString().toLowerCase())); if (Array.isArray(res.found)) res.found.forEach(f => f && f.letter && known.add((f.letter||'').toString().toLowerCase())) } catch (e) {} }) } catch (e) {}
        if (ownerWord) {
          const allKnown = ownerWord.split('').every(ch => known.has(ch))
          if (allKnown) {
            tryWord = true
          }
        }
        // If we have private length info (from letter_scope) or blanks are shown, assemble candidate list
        // so the bot can decide on a confident full-word guess even when server doesn't show blanks.
        const hasBlankView = !!(room && room.revealShowBlanks)
        // detect numeric 'letters' entries in privatePowerReveals
        let privateLen = null
        try {
          if (hasPrivatePPR) {
            const pvals = Object.values(botNode.privatePowerReveals[targetId] || {})
            for (const r of pvals) {
              try {
                if (!r || !r.result) continue
                const res = r.result || {}
                if (typeof res.letters === 'number') { privateLen = Number(res.letters); break }
                if (typeof res.letters === 'string' && !Number.isNaN(Number(res.letters))) { privateLen = Number(res.letters); break }
              } catch (e) {}
            }
          }
        } catch (e) {}
        // make length usable if blanks visible or private length exists
        const usableLen = hasBlankView ? ( (targetNode && targetNode.word) ? String(targetNode.word).length : (typeof targetNode.wordLength === 'number' ? Number(targetNode.wordLength) : null) ) : (privateLen || null)
        // if privateLen exists and bot doesn't already plan to guess a word, be willing to assemble candidates
        if (usableLen !== null || hasBlankView) {
          // allow later logic to build a candidate list based on usableLen and known letters
        }
      } catch (e) { /* non-fatal */ }

        if (tryWord) {
          try { console.log('botMakeMove: decided to attempt full-word guess', { botId, targetId, difficulty }) } catch (e) {}
        // attempt to assemble a candidate list when we can derive length info either
        // from blanks or from a private Letter Scope result so bots that purchased
        // letter_scope can narrow to a single candidate and guess confidently.
        try {
          const hasPrivatePPR = !!(botNode.privatePowerReveals && botNode.privatePowerReveals[targetId])
          // determine usable length: prefer explicit word, then room blanks, then private letter_scope
          let explicitLen = null
          try { explicitLen = (targetNode && targetNode.word) ? String(targetNode.word).length : (typeof targetNode.wordLength === 'number' ? Number(targetNode.wordLength) : null) } catch (e) { explicitLen = null }
          let privateLen = null
          try {
            if (hasPrivatePPR) {
              const pvals = Object.values(botNode.privatePowerReveals[targetId] || {})
              for (const r of pvals) {
                try { if (!r || !r.result) continue; const res = r.result || {}; if (typeof res.letters === 'number') { privateLen = Number(res.letters); break } if (typeof res.letters === 'string' && !Number.isNaN(Number(res.letters))) { privateLen = Number(res.letters); break } } catch (e) {}
              }
            }
          } catch (e) {}
          const len = explicitLen || (room && room.revealShowBlanks ? explicitLen : null) || privateLen || null
          if (!candidate && len && typeof NOUNS !== 'undefined') {
            const nounsList = (NOUNS && NOUNS.default) ? NOUNS.default : NOUNS
            // gather letters the bot already knows about this target
            const knownLetters = new Set()
            try {
              const pub = Array.isArray(targetNode.revealed) ? targetNode.revealed.map(x => (x||'').toString().toLowerCase()) : []
              pub.forEach(ch => { if (ch) knownLetters.add(ch) })
              try { Object.keys(botNode.guessedBy || {}).forEach(k => { if (k && k !== '__word') knownLetters.add(k.toString().toLowerCase()) }) } catch (e) {}
              try { (botNode.privateHits && botNode.privateHits[targetId] || []).forEach(h => { if (h && h.letter) knownLetters.add((h.letter||'').toString().toLowerCase()) }) } catch (e) {}
              try { const ppr = (botNode.privatePowerReveals && botNode.privatePowerReveals[targetId]) ? Object.values(botNode.privatePowerReveals[targetId]) : []; ppr.forEach(r => { try { if (!r || !r.result) return; const res = r.result || {}; if (res.letter) knownLetters.add((res.letter||'').toString().toLowerCase()); if (res.last) knownLetters.add((res.last||'').toString().toLowerCase()); if (Array.isArray(res.letters)) res.letters.forEach(ch => ch && knownLetters.add((ch||'').toString().toLowerCase())); if (Array.isArray(res.found)) res.found.forEach(f => f && f.letter && knownLetters.add((f.letter||'').toString().toLowerCase())) } catch (e) {} }) } catch (e) {}
            } catch (e) {}
            // filter noun list by length and known letters
            const lowered = Array.isArray(nounsList) ? nounsList.map(w => (w||'').toString().toLowerCase()) : []
            const candidatesList = lowered.filter(w => (w && w.length === Number(len)) && Array.from(knownLetters).every(l => w.includes(l)))
            // If only one candidate fits length+known letters, it's high confidence
            if (candidatesList.length === 1) {
              candidate = candidatesList[0]
              // a unique candidate is sufficient cause for the bot to attempt a full-word guess
              tryWord = true
            } else if (candidatesList.length > 1) {
              // score by number of known letters matched, prefer higher overlap
              let best = candidatesList[0]
              let bestScore = -1
              candidatesList.forEach(w => {
                let score = 0
                knownLetters.forEach(l => { if (w.indexOf(l) !== -1) score++ })
                if (score > bestScore) { bestScore = score; best = w }
              })
              // compute a lightweight confidence metric so bots only guess when very likely
              const wordLen = best ? best.length : Number(len)
              const matchCount = bestScore || 0
              const baseConfidence = wordLen > 0 ? (matchCount / wordLen) : 0
              const poolPenalty = candidatesList.length <= 2 ? 1 : (candidatesList.length <= 5 ? 0.85 : 0.7)
              const confidence = baseConfidence * poolPenalty
              const thresholds = { hard: 0.65, medium: 0.8, easy: 0.95 }
              const thr = thresholds[((''+difficulty).toLowerCase())] || 0.8
              const minMatches = Math.max(1, Math.floor(wordLen / 2))
              if ((matchCount >= minMatches && confidence >= thr) || candidatesList.length === 1) {
                candidate = best
              } else {
                // not confident enough: do not set candidate so the bot falls back to letter guessing
              }
            }
          }
        } catch (e) {
          // non-fatal: fall back to existing behavior
        }

        if (candidate) {
          try { console.log('botMakeMove: attempting full-word push', { botId, candidate, targetId }) } catch (e) {}
          await botPushGuess(botId, botNode.name, targetId, { value: String(candidate) })
              try { console.log('botMakeMove: pushed full-word guess', { botId, candidate, targetId }) } catch (e) {}
              // Fallback: if server-side processor doesn't run (e.g., local dev without functions),
              // detect after a short delay and apply minimal local updates so the UI and turn advance.
              (async () => {
                try {
                  await new Promise(r => setTimeout(r, 800))
                  const fresh = await get(roomRef)
                  const freshRoom = fresh.val() || {}
                  const freshPlayers = (freshRoom.players || {})
                  const freshTarget = freshPlayers[targetId] || {}
                  const curIdx = (typeof freshRoom.currentTurnIndex === 'number') ? freshRoom.currentTurnIndex : 0
                  const order = freshRoom.turnOrder || []
                  const currentPlayerId = (order && order.length > curIdx) ? order[curIdx] : null
                  // if still the bot's turn, apply a local resolution
                  if (currentPlayerId === botId) {
                    const updates = {}
                    // if candidate matches the target's word, reveal and eliminate
                    const targetWord = (freshTarget.word || '').toString().toLowerCase()
                    if (candidate && targetWord && candidate.toString().toLowerCase() === targetWord) {
                      const unique = Array.from(new Set((targetWord || '').split('')))
                      updates[`players/${targetId}/revealed`] = unique
                      updates[`players/${targetId}/eliminated`] = true
                      updates[`players/${targetId}/eliminatedAt`] = Date.now()
                      // remove from turnOrder
                      const newOrder = (freshRoom.turnOrder || []).filter(id => id !== targetId)
                      updates['turnOrder'] = newOrder
                      // adjust currentTurnIndex safely
                      let adjustedIndex = curIdx
                      const removedIndex = (freshRoom.turnOrder || []).indexOf(targetId)
                      if (removedIndex !== -1 && removedIndex <= curIdx) adjustedIndex = Math.max(0, adjustedIndex - 1)
                      updates['currentTurnIndex'] = adjustedIndex
                    } else {
                      // nothing changed server-side for full-word guess; just advance the turn
                      const effOrder = freshRoom.turnOrder || []
                      if (effOrder.length > 0) {
                        const nextIndex = (curIdx + 1) % effOrder.length
                        updates['currentTurnIndex'] = nextIndex
                        updates['currentTurnStartedAt'] = Date.now()
                        const nextPlayer = effOrder[nextIndex]
                        if (nextPlayer) {
                          updates[`players/${nextPlayer}/frozen`] = null
                          updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
                          updates[`priceSurge/${nextPlayer}`] = null
                        }
                      }
                    }
                    try {
                      // If local fallback is applying an elimination or other change, detect
                      // whether only one non-eliminated player will remain and finalize the game.
                      try {
                        const simulatedPlayers = Object.assign({}, freshPlayers)
                        // apply per-player elimination if present in updates
                        const elimKey = `players/${targetId}/eliminated`
                        if (Object.prototype.hasOwnProperty.call(updates, elimKey) && updates[elimKey] === true) {
                          if (!simulatedPlayers[targetId]) simulatedPlayers[targetId] = {}
                          simulatedPlayers[targetId].eliminated = true
                        }
                        // apply any explicit per-player revealed changes (not needed for count)
                        // compute alive list
                        const alive = Object.keys(simulatedPlayers || {}).filter(pid => { try { const p = simulatedPlayers[pid] || {}; return !p.eliminated } catch (e) { return false } })
                        if (alive.length <= 1) {
                          // finalize locally
                          updates['phase'] = 'ended'
                          updates['endedAt'] = Date.now()
                          if (alive.length === 1) {
                            const winner = alive[0]
                            updates['winnerId'] = winner
                            try { updates['winnerName'] = (simulatedPlayers[winner] && simulatedPlayers[winner].name) ? simulatedPlayers[winner].name : winner } catch (e) { updates['winnerName'] = winner }
                            try { if (simulatedPlayers[winner] && simulatedPlayers[winner].team) updates['winnerTeam'] = simulatedPlayers[winner].team } catch (e) {}
                          } else {
                            updates['winnerId'] = null
                            updates['winnerName'] = null
                            updates['winnerTeam'] = null
                          }
                        }
                      } catch (e) { /* non-fatal */ }
                      if (Object.keys(updates).length > 0) await update(roomRef, updates)
                    } catch (e) { console.warn('botMakeMove: fallback full-word update failed', e) }
                  }
                } catch (e) { /* swallow fallback errors */ }
              })()
              return
        } else {
          try { console.log('botMakeMove: no candidate word known, will fall back to letter guess', { botId, targetId }) } catch (e) {}
        }
        // otherwise fall back to a high-confidence assembled guess by revealing common letters
      }

      // Letter guess strategy: prefer unrevealed letters from the target word when possible
      // Avoid guessing letters already revealed publicly or privately for that specific target
      let letter = null
      try {
        const targetWord = (targetNode && targetNode.word) ? String(targetNode.word).toLowerCase() : null
        // Build known letters for this target from public reveals and the bot's private knowledge
        const revealed = Array.isArray(targetNode.revealed) ? targetNode.revealed.map(x => (x||'').toString().toLowerCase()) : []
        const known = new Set()
        revealed.forEach(ch => { if (ch) known.add(ch) })
        // letters the bot itself has tried/recorded (guessedBy on bot node)
        try { Object.keys(botNode.guessedBy || {}).forEach(k => { if (k && k !== '__word') known.add(k.toString().toLowerCase()) }) } catch (e) {}
        // bot's privateHits against this target
        try { (botNode.privateHits && botNode.privateHits[targetId] || []).forEach(h => { if (h && h.letter) known.add((h.letter||'').toString().toLowerCase()) }) } catch (e) {}
        // bot's privatePowerReveals that targeted this player (may include letters/letters arrays/found)
        try { const ppr = (botNode.privatePowerReveals && botNode.privatePowerReveals[targetId]) ? Object.values(botNode.privatePowerReveals[targetId]) : []; ppr.forEach(r => { try { if (!r || !r.result) return; const res = r.result || {}; if (res.letter) known.add((res.letter||'').toString().toLowerCase()); if (res.last) known.add((res.last||'').toString().toLowerCase()); if (Array.isArray(res.letters)) res.letters.forEach(ch => ch && known.add((ch||'').toString().toLowerCase())); if (Array.isArray(res.found)) res.found.forEach(f => f && f.letter && known.add((f.letter||'').toString().toLowerCase())) } catch (e) {} }) } catch (e) {}

        if (targetWord) {
          const candidates = Array.from(new Set(targetWord.split('').filter(ch => /^[a-z]$/.test(ch) && !known.has(ch))))
          if (candidates.length > 0) {
            // choose an unrevealed/un-known letter from the target (bots always prefer target letters)
            letter = candidates[Math.floor(Math.random() * candidates.length)]
          }
        }
      } catch (e) { letter = null }

      if (!letter) {
        letter = weightedRandomLetter()
        try { console.log('botMakeMove: picked weighted random letter', { botId, letter }) } catch (e) {}
      } else {
        try { console.log('botMakeMove: picked target-specific letter', { botId, letter, targetId }) } catch (e) {}
      }
      try { console.log('botMakeMove: pushing letter guess to queue', { botId, targetId, letter }) } catch (e) {}
      await botPushGuess(botId, botNode.name, targetId, { value: letter })
      try { console.log('botMakeMove: pushed letter guess', { botId, targetId, letter }) } catch (e) {}

      // Fallback: wait briefly for server-side processing; if no change, apply minimal local updates
      (async () => {
        try {
          await new Promise(r => setTimeout(r, 600))
          const freshSnap = await get(roomRef)
          const freshRoom = freshSnap.val() || {}
          const freshPlayers = (freshRoom.players || {})
          const freshTarget = freshPlayers[targetId] || {}
          const curIdx = (typeof freshRoom.currentTurnIndex === 'number') ? freshRoom.currentTurnIndex : 0
          const order = freshRoom.turnOrder || []
          const currentPlayerId = (order && order.length > curIdx) ? order[curIdx] : null
          // Check if the revealed changed for this target (letter was processed)
          const revealedNow = Array.isArray(freshTarget.revealed) ? freshTarget.revealed.map(x => (x||'').toString().toLowerCase()) : []
          const letterLower = (letter || '').toString().toLowerCase()
          if (currentPlayerId === botId) {
            // If the server hasn't processed the guess and the letter is in the target word,
            // apply a local minimal update: reveal letter(s) and advance the turn.
            const targetWord = (freshTarget.word || '').toString().toLowerCase()
            if (targetWord && targetWord.indexOf(letterLower) !== -1 && !revealedNow.includes(letterLower)) {
              const occurrences = Array.from(targetWord).filter(ch => ch === letterLower).length
              const nextRevealed = Array.isArray(freshTarget.revealed) ? freshTarget.revealed.slice() : []
              for (let i = 0; i < occurrences; i++) nextRevealed.push(letterLower)
              const updates = {}
              updates[`players/${targetId}/revealed`] = nextRevealed
              // award simple +2 per occurrence to guesser (best-effort)
              const award = 2 * occurrences
              const prev = (freshPlayers && freshPlayers[botId] && typeof freshPlayers[botId].wordmoney === 'number') ? freshPlayers[botId].wordmoney : 0
              updates[`players/${botId}/wordmoney`] = prev + award
              updates[`players/${botId}/lastGain`] = { amount: award, by: targetId, reason: 'hang', ts: Date.now() }
              // advance turn
              const len = (order && order.length) || 1
              const nextIndex = (curIdx + 1) % len
              updates['currentTurnIndex'] = nextIndex
              updates['currentTurnStartedAt'] = Date.now()
              const nextPlayer = order[nextIndex]
              if (nextPlayer) {
                updates[`players/${nextPlayer}/frozen`] = null
                updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
                updates[`priceSurge/${nextPlayer}`] = null
              }
              try {
                // Local fallback end-of-game check similar to full-word fallback
                try {
                  const simulatedPlayers = Object.assign({}, freshPlayers)
                  // if we updated elimination for any player, reflect that (letter fallback rarely eliminates)
                  // detect eliminated flag in updates by scanning keys
                  Object.keys(updates || {}).forEach(k => {
                    try {
                      if (k.startsWith('players/') && k.endsWith('/eliminated') && updates[k] === true) {
                        const parts = k.split('/')
                        const pid = parts[1]
                        if (!simulatedPlayers[pid]) simulatedPlayers[pid] = {}
                        simulatedPlayers[pid].eliminated = true
                      }
                    } catch (e) {}
                  })
                  const alive = Object.keys(simulatedPlayers || {}).filter(pid => { try { const p = simulatedPlayers[pid] || {}; return !p.eliminated } catch (e) { return false } })
                  if (alive.length <= 1) {
                    updates['phase'] = 'ended'
                    updates['endedAt'] = Date.now()
                    if (alive.length === 1) {
                      const winner = alive[0]
                      updates['winnerId'] = winner
                      try { updates['winnerName'] = (simulatedPlayers[winner] && simulatedPlayers[winner].name) ? simulatedPlayers[winner].name : winner } catch (e) { updates['winnerName'] = winner }
                      try { if (simulatedPlayers[winner] && simulatedPlayers[winner].team) updates['winnerTeam'] = simulatedPlayers[winner].team } catch (e) {}
                    } else {
                      updates['winnerId'] = null
                      updates['winnerName'] = null
                      updates['winnerTeam'] = null
                    }
                  }
                } catch (e) { /* non-fatal */ }
                await update(roomRef, updates)
              } catch (e) { console.warn('botMakeMove: fallback letter update failed', e) }
            } else {
              // No reveal or already processed: advance turn to avoid repeated bot activity
              const updates = {}
              const len = (order && order.length) || 1
              const nextIndex = (curIdx + 1) % len
              updates['currentTurnIndex'] = nextIndex
              updates['currentTurnStartedAt'] = Date.now()
              const nextPlayer = order[nextIndex]
              if (nextPlayer) {
                updates[`players/${nextPlayer}/frozen`] = null
                updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
                updates[`priceSurge/${nextPlayer}`] = null
              }
              try { await update(roomRef, updates) } catch (e) { console.warn('botMakeMove: fallback advance after letter failed', e) }
            }
          }
        } catch (e) { /* swallow fallback errors */ }
      })()
    } catch (e) {
      console.warn('botMakeMove failed', e)
    }
  }

  // Allow bots to purchase a small, safe set of power-ups programmatically.
  // Supported (safe) power-ups: 'the_unseen' (reveal one unrevealed letter),
  // 'word_freeze' (freeze a player's word for one round), 'price_surge' (raise prices).
  async function botPurchasePowerUp(botId, powerId, targetId = null, opts = {}) {
    if (!db) return false
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const snap = await get(roomRef)
      const room = snap.val() || {}
      const playersObj = room.players || {}
      const botNode = playersObj[botId]
      if (!botNode) return false
      // Ensure it's playing phase (safe guard)
      if (room.phase !== 'playing') return false

      // Only allow bots to purchase power-ups on their own turn.
      try {
        const order = room.turnOrder || []
        const idx = (typeof room.currentTurnIndex === 'number') ? room.currentTurnIndex : 0
        const currentPlayerId = (idx !== null && Array.isArray(order) && order.length > idx) ? order[idx] : null
        if (currentPlayerId !== botId) {
          try { console.warn('botPurchasePowerUp: blocked, not bot turn', { botId, powerId, currentPlayerId }) } catch (e) {}
          return false
        }
      } catch (e) {}

      // Minimal price map for supported power-ups (kept small & safe)
      const PRICE_MAP = { the_unseen: 6, word_freeze: 3, price_surge: 2 }
      const baseCost = PRICE_MAP[powerId]
      if (typeof baseCost === 'undefined') return false

      // compute active price surge amount (sum entries not authored by buyer nor buyer's teammates)
      let totalSurgeAmount = 0
      const ps = room.priceSurge || {}
      try {
        Object.keys(ps || {}).forEach(k => {
          try {
            const entry = ps[k]
            if (!entry || !entry.amount) return
            if (entry.by === botId) return
            // ignore teammate authored surges in lastTeamStanding
            if (room.gameMode === 'lastTeamStanding' && botNode.team && entry.by) {
              const auth = playersObj[entry.by] || {}
              if (auth.team && auth.team === botNode.team) return
            }
            const expires = typeof entry.expiresAtTurnIndex === 'number' ? entry.expiresAtTurnIndex : null
            const active = expires === null || (typeof room.currentTurnIndex === 'number' ? room.currentTurnIndex < expires : true)
            if (active) totalSurgeAmount += Number(entry.amount || 0)
          } catch (e) {}
        })
      } catch (e) {}

      const cost = baseCost + (totalSurgeAmount || 0)

      // Determine buyer balance (team-aware)
      let buyerBalance = typeof botNode.wordmoney === 'number' ? Number(botNode.wordmoney) : getStartMoneyFromRoom(room)
      if (room.gameMode === 'lastTeamStanding' && botNode.team) {
        buyerBalance = Number(room.teams && room.teams[botNode.team] && room.teams[botNode.team].wordmoney) || buyerBalance
      }
      if (buyerBalance < cost) return false

      const updates = {}
      // Deduct cost via helper so team-mode is respected
      applyAwardToUpdates(updates, room, botId, -cost, { reason: 'purchase', by: targetId })

      const key = `pu_${Date.now()}_${Math.random().toString(36).slice(2,6)}`

      // Helper payload constructors
      const buyerBase = { powerId, ts: Date.now(), from: botId, to: targetId }
      try {
        if (powerId === 'the_unseen') {
          if (!targetId) return false
          const targetNode = playersObj[targetId] || {}
          const word = (targetNode.word || '').toString().toLowerCase()
          if (!word) return false
          const revealed = Array.isArray(targetNode.revealed) ? targetNode.revealed.map(x => (x||'').toString().toLowerCase()) : []
          const candidates = Array.from(new Set(word.split('').filter(ch => /^[a-z]$/.test(ch) && !revealed.includes(ch))))
          if (candidates.length === 0) return false
          const letter = candidates[Math.floor(Math.random() * candidates.length)]
          // add letter to target's revealed set
          const existing = Array.isArray(targetNode.revealed) ? targetNode.revealed.slice() : []
          const next = Array.from(new Set([...(existing || []), letter]))
          updates[`players/${targetId}/revealed`] = next
          const buyerMsg = { message: `Revealed '${letter.toUpperCase()}' from ${targetNode.name || targetId}`, messageHtml: `<strong class="power-name">The Unseen</strong>: revealed <strong class="revealed-letter">'${letter.toUpperCase()}'</strong>` }
          updates[`players/${botId}/privatePowerReveals/${targetId}/${key}`] = { ...buyerBase, result: buyerMsg }
          updates[`players/${targetId}/privatePowerReveals/${botId}/${key}`] = { ...buyerBase, result: { message: `${botNode.name || botId} used The Unseen on you`, messageHtml: `<strong class="power-name">The Unseen</strong>: ${botNode.name || botId} revealed one of your letters` } }
        } else if (powerId === 'word_freeze') {
          if (!targetId) return false
          const expires = (typeof room.currentTurnIndex === 'number') ? room.currentTurnIndex + 1 : null
          updates[`players/${targetId}/frozen`] = true
          updates[`players/${targetId}/frozenUntilTurnIndex`] = expires
          updates[`players/${botId}/privatePowerReveals/${targetId}/${key}`] = { ...buyerBase, result: { message: `Word Freeze applied to ${targetId}`, messageHtml: `<strong class="power-name">Word Freeze</strong>: frozen for one round` } }
          updates[`players/${targetId}/privatePowerReveals/${botId}/${key}`] = { ...buyerBase, result: { message: `${botNode.name || botId} used Word Freeze on you`, messageHtml: `<strong class="power-name">Word Freeze</strong>: your word is frozen` } }
        } else if (powerId === 'price_surge') {
          // Represent surge as a keyed entry so it affects others. Expires will be cleared in turn-advance logic.
          updates[`priceSurge/${botId}`] = { amount: 2, by: botId, expiresAtTurnIndex: null }
          updates[`players/${botId}/privatePowerReveals/${botId}/${key}`] = { ...buyerBase, result: { message: `Price Surge: others' shop prices increased by +2 until your next turn`, messageHtml: `<strong class="power-name">Price Surge</strong>: +2 prices until your next turn` } }
        }
      } catch (e) {
        console.warn('botPurchasePowerUp: payload construction failed', e)
      }

      // perform update
      try {
        await update(roomRef, updates)
        return true
      } catch (e) {
        console.warn('botPurchasePowerUp update failed', e)
        return false
      }
    } catch (e) {
      console.warn('botPurchasePowerUp failed', e)
      return false
    }
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

  // enforce secret-word theme server-side when configured on the room
  try {
    const theme = room && room.secretWordTheme ? room.secretWordTheme : null
    if (theme && theme.enabled) {
      const type = theme.type || 'animals'
      if (type === 'colours') {
        // use local colours list (imported) to validate
        try {
          const list = (COLOURS && COLOURS.default) ? COLOURS.default : COLOURS
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in colours list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord colour validation failed', e)
          return false
        }
      } else if (type === 'animals') {
          // Prefer local deterministic list (ANIMALS imported at top)
          const list = (ANIMALS && ANIMALS.default) ? ANIMALS.default : ANIMALS
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in animals list', stored)
            return false
          }
      } else if (type === 'elements') {
        try {
          const list = (ELEMENTS && ELEMENTS.default) ? ELEMENTS.default : ELEMENTS
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in elements list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord element validation failed', e)
          return false
        }
      }
      else if (type === 'fruits' || type === 'vegetables') {
        try {
          const list = (type === 'fruits') ? ((FRUITS && FRUITS.default) ? FRUITS.default : FRUITS) : ((VEGETABLES && VEGETABLES.default) ? VEGETABLES.default : VEGETABLES)
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in themed list', type, stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord themed validation failed', e)
          return false
        }
      }
      else if (type === 'occupations') {
        try {
          const list = (OCCUPATIONS && OCCUPATIONS.default) ? OCCUPATIONS.default : OCCUPATIONS
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in occupations list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord occupations validation failed', e)
          return false
        }
      }
      else if (type === 'countries') {
        try {
          const list = (COUNTRIES && COUNTRIES.default) ? COUNTRIES.default : COUNTRIES
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in countries list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord countries validation failed', e)
          return false
        }
      }
      else if (type === 'cpp') {
        try {
          const list = (CPPTERMS && CPPTERMS.default) ? CPPTERMS.default : CPPTERMS
          // plain lowercase alphabetic match
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in cpp terms list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord cpp validation failed', e)
          return false
        }
      }
      else if (type === 'ballsports') {
        try {
          const list = (BALLSPORTS && BALLSPORTS.default) ? BALLSPORTS.default : BALLSPORTS
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in ballsports list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord ballsports validation failed', e)
          return false
        }
      }
      else if (type === 'olympicsports') {
        try {
          const list = (OLYMPICSPORTS && OLYMPICSPORTS.default) ? OLYMPICSPORTS.default : OLYMPICSPORTS
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in olympicsports list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord olympicsports validation failed', e)
          return false
        }
      }
      else if (type === 'gemstones') {
        try {
          const list = (GEMSTONES && GEMSTONES.default) ? GEMSTONES.default : GEMSTONES
          if (!Array.isArray(list) || !list.includes(stored.toLowerCase())) {
            console.warn('submitWord rejected: not in gemstones list', stored)
            return false
          }
        } catch (e) {
          console.warn('submitWord gemstones validation failed', e)
          return false
        }
      }
    }
  } catch (e) {
    console.warn('submitWord theme validation unexpected error', e)
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
            const ups = {}
            try {
              // If we're in team mode and the player has a team, increment the team's
              // wallet using a transaction to avoid lost updates when multiple players
              // submit concurrently. Fall back to the old helper on error.
              // Resolve gameMode; some older rooms used `winnerByWordmoney` instead of
              // `gameMode` so treat that legacy flag as equivalent to `money` when
              // `gameMode` is missing. This prevents gm being null and ensures starter
              // bonus reveal logic runs for `money` rooms.
              const gm = roomRoot && roomRoot.gameMode ? roomRoot.gameMode : (roomRoot && roomRoot.winnerByWordmoney ? 'money' : null)
              const team = pVal && pVal.team ? pVal.team : null
              if (gm === 'lastTeamStanding' && team) {
                try {
                  const teamKeyRef = dbRef(db, `rooms/${roomId}/teams/${team}/wordmoney`)
                  await runTransaction(teamKeyRef, (curr) => {
                    return (Number(curr) || 0) + 10
                  })
                  try { ups[`players/${uid}/lastGain`] = { amount: 10, by: null, reason: 'starterBonus', ts: Date.now() } } catch (e) {}
                } catch (e) {
                  console.warn('Starter bonus team wallet transaction failed, falling back to helper', e)
                  // transaction failed : fall back to existing helper
                  applyAwardToUpdates(ups, roomRoot, uid, 10, { reason: 'starterBonus', by: null })
                }
              } else {
                // non-team mode: increment player's wordmoney transactionally to avoid races
                console.log('Awarding starter bonus transactionally to player', uid)
                  const playerMoneyRef = dbRef(db, `rooms/${roomId}/players/${uid}/wordmoney`)
                  await runTransaction(playerMoneyRef, (curr) => {
                    return (Number(curr) || 0) + 10
                  })
                  try { ups[`players/${uid}/lastGain`] = { amount: 10, by: null, reason: 'starterBonus', ts: Date.now() } } catch (e) {}
                
              }
            } catch (e) {
              console.warn('Starter bonus transaction failed :( ), applying via helper', e)
              // fallback to direct per-player write in case helper/transaction fails
              
                const prev = (typeof pVal.wordmoney === 'number') ? pVal.wordmoney : 2
                ups[`players/${uid}/wordmoney`] = prev + 10
                try { ups[`players/${uid}/lastGain`] = { amount: 10, by: null, reason: 'starterBonus', ts: Date.now() } } catch (ee) {}
              
            }
            // If room mode is one of the public modes, reveal the starter letter publicly on this player's tile
          
              const gm = roomRoot && roomRoot.gameMode ? roomRoot.gameMode : (roomRoot && roomRoot.winnerByWordmoney ? 'money' : null)
              console.log("Game mode for starter bonus reveal check:", gm)
              console.log("roomRoot:", roomRoot)
              if (gm === 'money' || gm === 'lastOneStanding' || gm === 'lastTeamStanding') {
                console.log("In the phases for starter bonus reveal") 
                
                  const existing = Array.isArray(pVal.revealed) ? pVal.revealed.map(x => (x||'').toString().toLowerCase()) : []
                  if (!existing.includes(req)) {
                    console.log("Revealing starter letter:", req)
                    const next = Array.from(new Set([...(existing || []), req]))
                    ups[`players/${uid}/revealed`] = next
                  }
                
              }
            
            ups[`players/${uid}/starterBonusAwarded`] = true
            await update(roomRootRef, ups)
          }
        }
      }

      if (allSubmitted) {
        // Build a turn order. For team mode (lastTeamStanding) prefer an alternating
        // sequence across teams so consecutive turns belong to different teams where possible.
        const buildAlternatingOrder = (playersObj, prevLastTeam = null) => {
          try {
            const keys = Object.keys(playersObj || {})
            // group players by team preserving original join order
            const teams = {}
            const unteamed = []
            keys.forEach(k => {
              try {
                const p = playersObj[k] || {}
                const t = p.team || null
                if (t) {
                  teams[t] = teams[t] || []
                  teams[t].push(k)
                } else {
                  unteamed.push(k)
                }
              } catch (e) {}
            })
            const teamNames = Object.keys(teams)

            // If exactly two teams (lastTeamStanding) use deterministic two-list alternation:
            // produce sequence by taking red[0], blue[0], red[1], blue[1], ... and skipping
            // any duplicates until every player has been included. This preserves alternation
            // and wraps shorter lists so both teams remain interleaved fairly.
            if (teamNames.length === 2) {
              // Prefer a stable interleaving that repeats members of the smaller
              // team so teams alternate on every turn. This builds sequences like
              // A,C,B,C (for red=[A,B], blue=[C]) so the lone blue player acts
              // between every red player.
              const a = teams[teamNames[0]].slice()
              const b = teams[teamNames[1]].slice()
              const maxLen = Math.max(a.length, b.length)
              const res = []
              for (let i = 0; i < maxLen; i++) {
                if (a.length > 0) {
                  const cand = a[i % a.length]
                  if (cand) res.push(cand)
                }
                if (b.length > 0) {
                  const cand2 = b[i % b.length]
                  if (cand2) res.push(cand2)
                }
              }
              // append any unteamed players at end (preserve their order)
              return res.concat(unteamed)
            }

            // Fallback: for other team counts, use previous round-robin strategy
            if (teamNames.length <= 1) {
              if (teamNames.length === 1 && unteamed.length > 0) {
                const teamQueue = teams[teamNames[0]].slice()
                const uQueue = unteamed.slice()
                const res = []
                let takeFromTeam = true
                while (teamQueue.length || uQueue.length) {
                  if (takeFromTeam && teamQueue.length) res.push(teamQueue.shift())
                  else if (!takeFromTeam && uQueue.length) res.push(uQueue.shift())
                  else if (teamQueue.length) res.push(teamQueue.shift())
                  else if (uQueue.length) res.push(uQueue.shift())
                  takeFromTeam = !takeFromTeam
                }
                return res
              }
              return keys // nothing to alternate meaningfully
            }

            // preserve prior behavior for 3+ teams: round-robin across teams preferring alternation
            const firstPid = keys[0]
            let firstTeam = null
            if (prevLastTeam) {
              firstTeam = teamNames.find(t => t !== prevLastTeam) || teamNames[0]
            } else {
              firstTeam = (playersObj[firstPid] && playersObj[firstPid].team) ? playersObj[firstPid].team : teamNames[0]
            }
            const orderedTeams = [firstTeam].concat(teamNames.filter(t => t !== firstTeam))
            const queues = {}
            orderedTeams.forEach(t => { queues[t] = teams[t] ? teams[t].slice() : [] })
            const result = []
            let idx = 0
            while (Object.keys(queues).some(k => queues[k].length > 0)) {
              let found = null
              for (let offset = 0; offset < orderedTeams.length; offset++) {
                const cand = orderedTeams[(idx + offset) % orderedTeams.length]
                if (queues[cand] && queues[cand].length > 0) {
                  found = cand
                  idx = idx + offset
                  break
                }
              }
              if (!found) break
              result.push(queues[found].shift())
              idx++
            }
            return result.concat(unteamed)
          } catch (e) {
            return Object.keys(playersObj || {})
          }
        }

        // Determine which team had the last turn in the previous round (if available)
        let prevLastTeam = null
        try {
          if (roomRoot && Array.isArray(roomRoot.turnOrder) && typeof roomRoot.currentTurnIndex === 'number') {
            const prevIdxRaw = (roomRoot.currentTurnIndex - 1)
            const prevIdx = ((prevIdxRaw % roomRoot.turnOrder.length) + roomRoot.turnOrder.length) % roomRoot.turnOrder.length
            const prevPid = roomRoot.turnOrder[prevIdx]
            if (prevPid && playersObj && playersObj[prevPid] && playersObj[prevPid].team) prevLastTeam = playersObj[prevPid].team
          }
        } catch (e) {}

        const turnOrder = (roomRoot && roomRoot.gameMode === 'lastTeamStanding') ? buildAlternatingOrder(playersObj, prevLastTeam) : Object.keys(playersObj)
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
          // Ensure a ghostChallenge exists at the start of playing phase so eliminated
          // players can attempt re-entry immediately. If absent, pick a random word
          // from the room's secret theme or fallback noun list.
          try {
            const nowTs = Date.now()
            if (!roomRoot.ghostChallenge || !roomRoot.ghostChallenge.word) {
              let gw = null
              try {
                const theme = roomRoot && roomRoot.secretWordTheme && roomRoot.secretWordTheme.enabled ? (roomRoot.secretWordTheme.type || null) : null
                let pool = null
                if (theme === 'animals') pool = (ANIMALS && ANIMALS.default) ? ANIMALS.default : ANIMALS
                else if (theme === 'fruits') pool = (FRUITS && FRUITS.default) ? FRUITS.default : FRUITS
                else if (theme === 'vegetables') pool = (VEGETABLES && VEGETABLES.default) ? VEGETABLES.default : VEGETABLES
                else if (theme === 'occupations') pool = (OCCUPATIONS && OCCUPATIONS.default) ? OCCUPATIONS.default : OCCUPATIONS
                else if (theme === 'countries') pool = (COUNTRIES && COUNTRIES.default) ? COUNTRIES.default : COUNTRIES
                else if (theme === 'instruments') pool = (INSTRUMENTS && INSTRUMENTS.default) ? INSTRUMENTS.default : INSTRUMENTS
                else if (theme === 'colours') pool = (COLOURS && COLOURS.default) ? COLOURS.default : COLOURS
                else if (theme === 'elements') pool = (ELEMENTS && ELEMENTS.default) ? ELEMENTS.default : ELEMENTS
                else if (theme === 'cpp') pool = (CPPTERMS && CPPTERMS.default) ? CPPTERMS.default : CPPTERMS
                if (pool && Array.isArray(pool) && pool.length > 0) {
                  const filtered = pool.map(p => (p || '').toString().trim()).filter(p => /^[a-zA-Z]+$/.test(p) && p.length >= 2)
                  if (filtered.length > 0) gw = filtered[Math.floor(Math.random() * filtered.length)]
                  else {
                    const relaxed = pool.map(p => (p || '').toString().trim()).filter(p => p && p.length >= 2)
                    if (relaxed.length > 0) gw = relaxed[Math.floor(Math.random() * relaxed.length)]
                  }
                }
              } catch (e) {}
              if (!gw) {
                try {
                  const nounsList = (NOUNS && NOUNS.default) ? NOUNS.default : NOUNS
                  if (Array.isArray(nounsList) && nounsList.length > 0) gw = nounsList[Math.floor(Math.random() * nounsList.length)]
                } catch (e) {}
              }
              if (!gw) gw = 'apple'
              updates['ghostChallenge'] = { key: `ghost_${nowTs}`, word: (gw || 'apple').toString().toLowerCase(), ts: nowTs }
              try {
                // Helpful log for debugging: surface when we auto-create the ghostChallenge
                console.info(`Auto-created ghostChallenge for room ${roomId}:`, updates['ghostChallenge'])
              } catch (e) {}
            }
          } catch (e) { console.warn('Could not initialize ghostChallenge at round start', e) }
            // Auto-reveal the starter bonus letter for public modes at round start.
            // Historically this was only done for lastTeamStanding; extend to money and lastOneStanding.
            
              const sb = roomRoot.starterBonus || null
              // game mode may be stored as `gameMode` or the legacy `winnerByWordmoney` flag
              const gmNow = roomRoot && roomRoot.gameMode ? roomRoot.gameMode : (roomRoot && roomRoot.winnerByWordmoney ? 'money' : null)
              if (sb && sb.enabled && sb.type === 'contains' && sb.value && (gmNow === 'money' || gmNow === 'lastOneStanding' || gmNow === 'lastTeamStanding')) {
                const req = (sb.value || '').toString().toLowerCase()
                Object.keys(playersObj || {}).forEach(pid => {
                 
                    const p = playersObj[pid] || {}
                    const w = (p.word || '').toString().toLowerCase()
                    const existing = Array.isArray(p.revealed) ? p.revealed.map(x => (x||'').toString().toLowerCase()) : []
                    if (w && w.indexOf(req) !== -1 && !existing.includes(req)) {
                      const next = Array.from(new Set([...(existing || []), req]))
                      updates[`players/${pid}/revealed`] = next
                    }
                  
                })
              }
            
        // mark starterBonus as applied so we don't attempt to re-award later
        if (roomRoot.starterBonus && roomRoot.starterBonus.enabled) updates['starterBonus/applied'] = true
        // Award +1 to the first player in turnOrder as a starting bonus; be additive to any existing staged value
        try {
          const first = (turnOrder && turnOrder.length > 0) ? turnOrder[0] : null
          if (first) {
            const pSnap = await get(dbRef(db, `rooms/${roomId}/players/${first}`))
            const pVal = pSnap.val() || {}
            const prev = (typeof pVal.wordmoney === 'number') ? Number(pVal.wordmoney) : 2
            try {
              const gmNow = roomRoot && roomRoot.gameMode ? roomRoot.gameMode : (roomRoot && roomRoot.winnerByWordmoney ? 'money' : null)
              const team = pVal && pVal.team ? pVal.team : null
              if (gmNow === 'lastTeamStanding' && team) {
                // Use transaction to increment team wallet atomically so earlier
                // transactional starter bonuses are not lost by this batch update.
                try {
                  const teamKeyRef = dbRef(db, `rooms/${roomId}/teams/${team}/wordmoney`)
                  await runTransaction(teamKeyRef, (curr) => {
                    return (Number(curr) || 0) + 1
                  })
                  try { updates[`players/${first}/lastGain`] = { amount: 1, by: 'startBonus', reason: 'startTurn', ts: Date.now() } } catch (e) {}
                } catch (e) {
                  // fallback: include team increment in the updates object (old behavior)
                  applyAwardToUpdates(updates, roomRoot, first, 1, { reason: 'startTurn', by: 'startBonus' })
                }
              } else {
                // non-team mode: increment player's wordmoney transactionally to avoid overwriting
                // any concurrent starter-bonus transactions that may already have applied.
                try {
                  const playerMoneyRef = dbRef(db, `rooms/${roomId}/players/${first}/wordmoney`)
                  await runTransaction(playerMoneyRef, (curr) => {
                    return (Number(curr) || 0) + 1
                  })
                  try { updates[`players/${first}/lastGain`] = { amount: 1, by: 'startBonus', reason: 'startTurn', ts: Date.now() } } catch (e) {}
                } catch (e) {
                  // fallback to old behavior if transaction fails
                  applyAwardToUpdates(updates, roomRoot, first, 1, { reason: 'startTurn', by: 'startBonus' })
                }
              }
            } catch (ee) {
              // conservative fallback: bump player entry directly
              updates[`players/${first}/wordmoney`] = Number(prev) + 1
            }
          }
        } catch (e) {
          console.warn('Could not award start +1 bonus', e)
        }
        // Ensure any per-player transient effects (frozen flags and per-player price surges)
        // are cleared when the first player's turn begins so surges expire on the author's
        // next turn as intended.
        try {
          const first = (turnOrder && turnOrder.length > 0) ? turnOrder[0] : null
          if (first) {
            updates[`players/${first}/frozen`] = null
            updates[`players/${first}/frozenUntilTurnIndex`] = null
            updates[`priceSurge/${first}`] = null
          }
        } catch (e) {}
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
            console.log('leaveRoom: host leaving during ended phase : preserving room and host node to allow refresh/rejoin')
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
            // no other players : remove room entirely
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

    // Block guesses locally when it's not this player's turn. This prevents
    // sending to the serverless endpoint which validates the currentTurn owner
    // and returns a 500 when the auth token doesn't match (e.g., guessing while
    // it's a bot's turn). Return a blocking object so callers can show a toast.
    try {
      const curIdx = (state && typeof state.currentTurnIndex === 'number') ? state.currentTurnIndex : null
      const curOrder = (state && Array.isArray(state.turnOrder)) ? state.turnOrder : []
      const curPid = (curIdx !== null && curOrder && curOrder.length > 0) ? curOrder[curIdx] : null
      if (curPid && playerIdRef.current && curPid !== playerIdRef.current) {
        return { blocked: true, message: `It's not your turn` }
      }
    } catch (e) {}

    // Client-side duplicate-guess prevention (best-effort).
    // If we detect the viewer already guessed this letter/word for this target
    // (publicly or privately), short-circuit and return a blocking object so
    // callers can show a red error toast instead of sending the guess to server.
    try {
      const me = (state?.players || []).find(p => p.id === playerIdRef.current) || {}
      const targetNode = (state?.players || []).find(p => p.id === targetId) || {}
      const val = payloadVal.toString().toLowerCase()
      const isLetter = val.length === 1

      if (isLetter) {
        const letter = val
        // public: already revealed on target
        if (Array.isArray(targetNode.revealed) && targetNode.revealed.map(x => (x || '').toString().toLowerCase()).includes(letter)) {
          return { blocked: true, message: `That letter '${letter.toUpperCase()}' is already revealed for ${targetNode.name || 'this player'}.` }
        }
        // private wrong guesses
        if (me.privateWrong && Array.isArray(me.privateWrong[targetId]) && me.privateWrong[targetId].map(x => (x||'').toString().toLowerCase()).includes(letter)) {
          return { blocked: true, message: `You already guessed '${letter.toUpperCase()}' for ${targetNode.name || 'this player'}.` }
        }
        // private hits
        try {
          const ph = (me.privateHits && me.privateHits[targetId]) ? me.privateHits[targetId] : []
          if (Array.isArray(ph) && ph.some(h => h && h.type === 'letter' && ((h.letter || '').toString().toLowerCase() === letter))) {
            return { blocked: true, message: `You've already found '${letter.toUpperCase()}' from ${targetNode.name || 'this player'}.` }
          }
        } catch (e) {}
        // private power-up reveals
        try {
          const ppr = (me.privatePowerReveals && me.privatePowerReveals[targetId]) ? Object.values(me.privatePowerReveals[targetId]) : []
          if (Array.isArray(ppr) && ppr.some(r => {
            try {
              if (!r || !r.result) return false
              const res = r.result
              const check = s => (s || '').toString().toLowerCase() === letter
              if (check(res.letterFromTarget)) return true
              if (check(res.letterFromBuyer)) return true
              if (check(res.letter)) return true
              if (res.last && check(res.last)) return true
              if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x||'').toString().toLowerCase()).includes(letter)) return true
              return false
            } catch (e) { return false }
          })) {
            return { blocked: true, message: `That letter '${letter.toUpperCase()}' was already revealed for ${targetNode.name || 'this player'}.` }
          }
        } catch (e) {}
      } else {
        // full-word duplicate checks
        const word = val
        if (me.privateWrongWords && Array.isArray(me.privateWrongWords[targetId]) && me.privateWrongWords[targetId].map(x => (x||'').toString().toLowerCase()).includes(word)) {
          return { blocked: true, message: `You already tried that word for ${targetNode.name || 'this player'}.` }
        }
        try {
          const ph = (me.privateHits && me.privateHits[targetId]) ? me.privateHits[targetId] : []
          if (Array.isArray(ph) && ph.some(h => h && h.type === 'word' && ((h.word || '').toString().toLowerCase() === word))) {
            return { blocked: true, message: `You already correctly guessed that word for ${targetNode.name || 'this player'}.` }
          }
        } catch (e) {}

      }
    } catch (e) {
      // best-effort only; ignore errors and continue to submit the guess
    }

    // Block normal guesses while Word Seeker is actively in the playing phase
    try {
      const roomSnapCheck = await get(dbRef(db, `rooms/${roomId}`))
      const roomCheck = roomSnapCheck.val() || {}
      if (roomCheck && roomCheck.phase === 'wordseeker_playing') {
        console.warn('sendGuess blocked: Word Seeker playing phase')
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
        console.warn('Not authenticated for serverless call : falling back to DB queue')
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
    // Bot helper
    addBot, removeBot, botMakeMove, botPurchasePowerUp,
    // Word Seeker helpers
    startWordSeeker, markWordSeekerReady, beginWordSeekerPlaying, endWordSeekerPlaying, voteForPlayer, tallyWordSeekerVotes, submitSpyGuess, playNextWordSeekerRound }
}

