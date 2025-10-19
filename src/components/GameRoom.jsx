import React, { useEffect, useState, useMemo, useRef, useLayoutEffect } from 'react'
import PlayerCircle from './PlayerCircle'
import useGameRoom from '../hooks/useGameRoom'
import useUserActivation from '../hooks/useUserActivation'
import COLOURS from '../data/colours'
import ANIMALS from '../data/animals'
import INSTRUMENTS from '../data/instruments'
import ELEMENTS from '../data/elements'
import CPPTERMS from '../data/cppterms'
import { db } from '../firebase'
import { ref as dbRef, get as dbGet, update as dbUpdate } from 'firebase/database'
import { buildRoomUrl } from '../utils/url'

export default function GameRoom({ roomId, playerName, password }) { // Added password as a prop
  const { state, joinRoom, leaveRoom, sendGuess, startGame, submitWord, playerId,
    // Word Spy hooks
    startWordSpy, markWordSpyReady, beginWordSpyPlaying, endWordSpyPlaying, voteForPlayer, tallyWordSpyVotes, submitSpyGuess, playNextWordSpyRound
  } = useGameRoom(roomId, playerName)
  const [word, setWord] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [wordError, setWordError] = useState('')
  const [isCheckingDictionary, setIsCheckingDictionary] = useState(false)
  const [timedMode, setTimedMode] = useState(false)
  const [turnSeconds, setTurnSeconds] = useState(30)
  const [starterEnabled, setStarterEnabled] = useState(true)
  const [revealPreserveOrder, setRevealPreserveOrder] = useState(false)
  const [revealShowBlanks, setRevealShowBlanks] = useState(false)
  const [winnerByWordmoney, setWinnerByWordmoney] = useState(false)
  // multi-mode support: 'money' | 'lastOneStanding' | 'wordSpy'
  const [gameMode, setGameMode] = useState('lastOneStanding')
  const [wordSpyTimerSeconds, setWordSpyTimerSeconds] = useState(120)
  const [wordSpyRounds, setWordSpyRounds] = useState(3)
  const [powerUpsEnabled, setPowerUpsEnabled] = useState(true)
  const [showWordsOnEnd, setShowWordsOnEnd] = useState(true)
  const [minWordSize, setMinWordSize] = useState(2)
  const [minWordSizeInput, setMinWordSizeInput] = useState(String(2))
  // starting wordmoney is hard-coded to 2; no local state needed
  const [startingWordmoney, setStartingWordmoney] = useState(2)
  const [showSettings, setShowSettings] = useState(false)
  const [secretThemeEnabled, setSecretThemeEnabled] = useState(true)
  const [secretThemeType, setSecretThemeType] = useState('animals')
  // Host-provided custom theme inputs (title + comma-separated list)
  const [customTitle, setCustomTitle] = useState('')
  const [customCsv, setCustomCsv] = useState('')
  const [customError, setCustomError] = useState('')
  const prevCustomSerializedRef = useRef(null)
  const customTitleRef = useRef(null)
  const customCsvRef = useRef(null)
  const [timeLeft, setTimeLeft] = useState(null)
  const [tick, setTick] = useState(0)
  const [toasts, setToasts] = useState([])
  const [powerUpOpen, setPowerUpOpen] = useState(false)
  const [powerUpTarget, setPowerUpTarget] = useState(null)
  // separate inputs: one for generic choice (e.g. letter position) and one for double-down stake
  const [powerUpChoiceValue, setPowerUpChoiceValue] = useState('')
  const [powerUpStakeValue, setPowerUpStakeValue] = useState('')
  const [powerUpLoading, setPowerUpLoading] = useState(false)
  // Locally lock the power-up shop for the viewer after buying Double Down until they make a guess
  const [ddShopLocked, setDdShopLocked] = useState(false)
  const powerUpChoiceRef = useRef(null)
  const powerupListRef = useRef(null)
  const powerupScrollRef = useRef(0)
  const multiHitSeenRef = useRef({})
  const [recentPenalty, setRecentPenalty] = useState({})
  const [pendingDeducts, setPendingDeducts] = useState({})
  const [showConfirmReset, setShowConfirmReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [forcedLobbyView, setForcedLobbyView] = useState(false)
  // ensure audio/vibration unlock on first user gesture (no UI toast)
  useUserActivation()

  // Global capture: log unhandled promise rejections and window errors to help debug
  // intermittent extension-related failures that show as "A listener indicated an asynchronous response..."
  useEffect(() => {
    const onRejection = (ev) => {
      try {
        console.error('Global unhandledrejection caught in GameRoom:', ev)
        // some browsers put the actual error in ev.reason
        if (ev && ev.reason) console.error('Rejection reason:', ev.reason)
        // rethrow a bit later so it's also visible in dev tools stack if desired
      } catch (e) {}
    }
    const onError = (ev) => {
      try {
        console.error('Global error caught in GameRoom:', ev)
      } catch (e) {}
    }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [])

  useEffect(() => {
    joinRoom(password) // Pass the password to joinRoom
    return () => leaveRoom()
  }, [password])

  // local tick to refresh timers on screen
  // Pause the tick when the power-up modal is open to avoid frequent re-renders that
  // can interfere with modal scroll position.
  useEffect(() => {
    // Also pause the tick while the settings modal is open so dropdowns inside
    // the modal (e.g. the gameMode <select>) aren't closed by rapid re-renders.
    if (powerUpOpen || showSettings) return undefined
    const id = setInterval(() => setTick(t => t + 1), 300)
    return () => clearInterval(id)
  }, [powerUpOpen, showSettings])

  // keep local timed UI in sync with room state (so non-hosts can see current selection)
  useEffect(() => {
    // If room explicitly sets timed, respect it; otherwise, when Word Spy is active
    // default timed mode ON and compute seconds = 60 * number of players (clamped)
    if (state?.timed !== undefined) setTimedMode(!!state.timed);
    if (state?.turnTimeoutSeconds !== undefined) setTurnSeconds(state.turnTimeoutSeconds || 30);
    if (state?.gameMode === 'wordSpy') {
      try {
        setTimedMode(true)
        const playersCount = (state && state.players && Array.isArray(state.players)) ? state.players.length : 1
        const computed = Math.max(10, Math.min(600, 60 * Math.max(1, playersCount)))
        // prefer explicit room value if present, otherwise use computed
        if (typeof state?.turnTimeoutSeconds !== 'number') {
          setTurnSeconds(computed)
        }
        // keep legacy wordSpyTimerSeconds in sync for compatibility
        setWordSpyTimerSeconds(prev => (typeof state?.wordSpyTimerSeconds === 'number' ? Math.max(10, Math.min(600, Number(state.wordSpyTimerSeconds))) : computed))
      } catch (e) {}
    }
    // legacy support: if gameMode exists, prefer it; otherwise derive from winnerByWordmoney
    if (state?.gameMode) setGameMode(state.gameMode)
    else setWinnerByWordmoney(!!state?.winnerByWordmoney);
  // sync new gameMode and Word Spy settings when present
  if (state?.gameMode) setGameMode(state.gameMode)
  if (typeof state?.wordSpyTimerSeconds === 'number') setWordSpyTimerSeconds(Math.max(10, Math.min(600, Number(state.wordSpyTimerSeconds))))
  if (typeof state?.wordSpyRounds === 'number') setWordSpyRounds(Math.max(1, Math.min(20, Number(state.wordSpyRounds))))
  setStarterEnabled(!!state?.starterBonus?.enabled);
  // default power-ups to enabled unless the room explicitly sets it to false
  setPowerUpsEnabled(state?.powerUpsEnabled ?? true);
    // showWordsOnEnd controls whether players' secret words are displayed on final standings
    if (typeof state?.showWordsOnEnd === 'boolean') setShowWordsOnEnd(!!state.showWordsOnEnd)

    // ✅ update min word size only if that specific field changes
    const syncedMin = typeof state?.minWordSize === 'number'
      ? Math.max(2, Math.min(10, state.minWordSize))
      : 2;

    setMinWordSize(prev => {
      if (prev !== syncedMin) {
        setMinWordSizeInput(String(syncedMin));
        return syncedMin;
      }
      return prev;
    });

    // sync configured starting wordmoney when present (accept numeric strings too)
    try {
      if (typeof state?.startingWordmoney !== 'undefined' && !Number.isNaN(Number(state.startingWordmoney))) {
        setStartingWordmoney(Math.max(0, Number(state.startingWordmoney)))
      }
    } catch (e) {}

    // startingWordmoney is fixed to 2 (hard-coded); do not sync from room settings
    // sync reveal settings
    if (typeof state?.revealPreserveOrder === 'boolean') setRevealPreserveOrder(!!state.revealPreserveOrder)
    if (typeof state?.revealShowBlanks === 'boolean') setRevealShowBlanks(!!state.revealShowBlanks)
    // sync secret word theme settings if present (run whenever the authoritative room setting changes)
    if (typeof state?.secretWordTheme === 'object') {
      const st = state.secretWordTheme || {}
      // Update local UI state so all players see the current host-selected theme immediately
      setSecretThemeEnabled(!!st.enabled)
      setSecretThemeType(st.type || 'animals')
      // Pre-fill host custom inputs when present and when the theme is 'custom'.
      // Only overwrite uncontrolled inputs when the settings modal is open so an actively-typing host doesn't lose focus.
      try {
        if (showSettings && (st.type === 'custom') && st.custom && Array.isArray(st.custom.words)) {
          const ser = JSON.stringify({ title: st.custom.title || '', words: (st.custom.words || []) })
          if (prevCustomSerializedRef.current !== ser) {
            prevCustomSerializedRef.current = ser
            try { if (customTitleRef.current) customTitleRef.current.value = st.custom.title || '' } catch (e) {}
            try { if (customCsvRef.current) customCsvRef.current.value = (st.custom.words || []).join(',') } catch (e) {}
            setCustomTitle(st.custom.title || '')
            setCustomCsv((st.custom.words || []).join(','))
          }
        }
      } catch (e) {}
    }

  // sync Word Spy settings if present
  if (typeof state?.wordSpyTimerSeconds === 'number') setWordSpyTimerSeconds(Math.max(10, Math.min(600, Number(state.wordSpyTimerSeconds))))
  if (typeof state?.wordSpyRounds === 'number') setWordSpyRounds(Math.max(1, Math.min(20, Number(state.wordSpyRounds))))

  }, [
    state?.timed,
    state?.turnTimeoutSeconds,
    state?.winnerByWordmoney,
    state?.starterBonus?.enabled,
    state?.powerUpsEnabled,
    state?.minWordSize,
    // ensure we re-run when the authoritative secretWordTheme changes so UI updates for all players
    state?.secretWordTheme,
    // ensure we re-run when the configured starting balance changes
    state?.startingWordmoney,
    // startingWordmoney removed
  ]);

  // toggle a body-level class so the background becomes green when money-mode is active
  useEffect(() => {
    try {
      if (state?.winnerByWordmoney) document.body.classList.add('money-theme-body')
      else document.body.classList.remove('money-theme-body')
    } catch (e) {}
    return () => {}
  }, [state?.winnerByWordmoney])

  // Toggle Word Spy theme (pink/black) when the room's gameMode is 'wordSpy'
  useEffect(() => {
    try {
      if (state?.gameMode === 'wordSpy') {
        document.body.classList.add('wordspy-theme-body')
      } else {
        document.body.classList.remove('wordspy-theme-body')
      }
    } catch (e) {}
    return () => {}
  }, [state?.gameMode])

  // Small badge component to display the active secret-word theme with emoji + gradient
  function ThemeBadge({ type }) {
    const infoMap = {
  animals: { emoji: '🐾', label: 'Animals', bg: 'linear-gradient(90deg,#34d399,#059669)' },
  colours: { emoji: '🎨', label: 'Colours', bg: 'linear-gradient(90deg,#7c3aed,#ec4899)' },
  instruments: { emoji: '🎵', label: 'Instruments', bg: 'linear-gradient(90deg,#f97316,#ef4444)' },
  elements: { emoji: '⚛️', label: 'Elements', bg: 'linear-gradient(90deg,#9ca3af,#6b7280)' },
  cpp: { emoji: '💻', label: 'C++ terms', bg: 'linear-gradient(90deg,#0ea5e9,#0369a1)' },
  custom: { emoji: '📝', label: 'Custom', bg: 'linear-gradient(90deg,#f59e0b,#ef4444)' },
      default: { emoji: '🔖', label: type || 'Theme', bg: 'linear-gradient(90deg,#2b8cff,#0b63d6)' }
    }
    const info = infoMap[type] || infoMap.default
    return (
      <div style={{ marginTop: 8 }}>
        <span title={`Secret word theme: ${info.label}`} style={{ background: info.bg, color: '#fff', padding: '6px 10px', borderRadius: 12, fontSize: 13, fontWeight: 700, display: 'inline-block', textTransform: 'none' }}>
          <span style={{ marginRight: 8 }}>{info.emoji}</span>
          {info.label}
        </span>
      </div>
    )
  }

  // highlight when it's the viewer's turn by adding/removing a body-level class
  useEffect(() => {
    try {
      const myIdLocal = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
      const isMyTurnNow = state && state.turnOrder && state.currentTurnIndex != null && state.turnOrder[state.currentTurnIndex] === myIdLocal
      if (isMyTurnNow) document.body.classList.add('my-turn-body')
      else document.body.classList.remove('my-turn-body')
    } catch (e) {}
    return () => {}
  }, [state?.turnOrder, state?.currentTurnIndex])

  // write timing preview to room so all players (including non-hosts) can see before start
  async function updateRoomTiming(timed, seconds) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      await dbUpdate(roomRef, { timed: !!timed, turnTimeoutSeconds: timed ? Math.max(10, Math.min(600, Number(seconds) || 30)) : null })
    } catch (e) {
      console.warn('Could not update room timing preview', e)
    }
  }

  async function updateRoomGameMode(mode, opts = {}) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const safeMode = (mode === 'money' || mode === 'lastOneStanding' || mode === 'wordSpy') ? mode : 'lastOneStanding'
      const updates = { gameMode: safeMode }
      // keep legacy boolean in sync
      updates['winnerByWordmoney'] = safeMode === 'money'
      if (safeMode === 'wordSpy') {
        if (opts.timerSeconds) updates['wordSpyTimerSeconds'] = Math.max(10, Math.min(600, Number(opts.timerSeconds)))
        if (opts.rounds) updates['wordSpyRounds'] = Math.max(1, Math.min(20, Number(opts.rounds)))
      }
      await dbUpdate(roomRef, updates)
    } catch (e) {
      console.warn('Could not update room game mode', e)
    }
  }

  // Helper to attempt resetting the room using a REST-first fallback, returns boolean
  async function attemptReset(updates) {
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const errors = []
    console.log('attemptReset: diagnostic info (ordered checks):', {
      typeof_dbUpdate: typeof dbUpdate,
      hasRoomRefUpdate: !!(roomRef && typeof roomRef.update === 'function'),
      hasFetch: typeof fetch === 'function',
      runtimeDBURL: !!window.__firebaseDatabaseURL,
      hasAuth: !!(window && window.__firebaseAuth && window.__firebaseAuth.currentUser)
    })
    // Preferred strategy: use SDK update helpers first (most reliable in normal clients)
    try {
      if (typeof dbUpdate === 'function') {
        await dbUpdate(roomRef, updates)
        console.log('attemptReset: named dbUpdate succeeded')
        return true
      }
    } catch (errA) {
      console.warn('attemptReset: named dbUpdate failed', errA && (errA.stack || errA.message || String(errA)))
      errors.push({ step: 'named dbUpdate', err: errA && (errA.stack || errA.message || String(errA)) })
    }

    // Next fallback: roomRef.update
    try {
      if (roomRef && typeof roomRef.update === 'function') {
        await roomRef.update(updates)
        console.log('attemptReset: roomRef.update succeeded')
        return true
      }
    } catch (errB) {
      console.warn('attemptReset: roomRef.update failed', errB && (errB.stack || errB.message || String(errB)))
      errors.push({ step: 'ref.update', err: errB && (errB.stack || errB.message || String(errB)) })
    }

    // REST PATCH fallback (useful for environments where SDK update isn't available)
    try {
      const authToken = (window.__firebaseAuth && window.__firebaseAuth.currentUser) ? await window.__firebaseAuth.currentUser.getIdToken() : null
      const dbUrl = window.__firebaseDatabaseURL || (typeof process !== 'undefined' && process.env && (process.env.VITE_FIREBASE_DATABASE_URL || process.env.FIREBASE_DATABASE_URL)) || null
      if (!dbUrl) throw new Error('No database URL available for REST fallback')
      const url = `${dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}.json${authToken ? `?auth=${authToken}` : ''}`
      const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
      if (!res.ok) throw new Error('REST fallback failed: ' + res.status + ' ' + (await res.text()))
      console.log('attemptReset: REST PATCH succeeded')
      return true
    } catch (errRest) {
      console.warn('attemptReset: REST PATCH failed or unavailable', errRest && (errRest.stack || errRest.message || String(errRest)))
      errors.push({ step: 'rest-patch', err: errRest && (errRest.stack || errRest.message || String(errRest)) })
    }

    // Final fallback: dynamic import of firebase update function
    try {
      const mod = await import('firebase/database')
      const updateFn = (mod && typeof mod.update === 'function') ? mod.update : (mod && mod.default && typeof mod.default.update === 'function') ? mod.default.update : null
      if (typeof updateFn === 'function') {
        await updateFn(roomRef, updates)
        console.log('attemptReset: dynamic import update succeeded')
        return true
      } else {
        throw new Error('dynamic import did not expose a callable update()')
      }
    } catch (errC) {
      console.warn('attemptReset: dynamic import approach failed', errC && (errC.stack || errC.message || String(errC)))
      errors.push({ step: 'dynamic import', err: errC && (errC.stack || errC.message || String(errC)) })
    }

    console.error('attemptReset: all update strategies failed', errors)
    return false
  }

  // write winner mode to the room so all clients see it immediately
  async function updateRoomWinnerMode(enabled) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      // preserve backwards compatibility by setting winnerByWordmoney, but also set gameMode when toggled
      const updates = { winnerByWordmoney: !!enabled }
      // if enabled, set mode to 'money'
      updates['gameMode'] = enabled ? 'money' : (state?.gameMode || 'lastOneStanding')
      await dbUpdate(roomRef, updates)
    } catch (e) {
      console.warn('Could not update winner mode', e)
    }
  }

  // watch for timeout logs in state.timeouts to show toast and flash player
  // dedupe timeouts per player to avoid duplicate toasts when both client and server
  const processedTimeoutPlayersRef = useRef({})
  // also dedupe by timeout key so the same timeout entry doesn't re-trigger repeatedly
  const processedTimeoutKeysRef = useRef({})
  // track previous wordmoney values so we can show gain toasts when anyone receives points
  const prevHangRef = useRef({})
  // track expected wordmoney values after a pending deduction so the UI can wait for DB confirmation
  const expectedHangRef = useRef({})
  const prevHostRef = useRef(null)

  // viewer id (derived from hook or firebase auth) — declare early to avoid TDZ in effects
  const myId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)

  // Track whether we've observed the current player in the room previously so we only
  // redirect when we detect their removal after having been present.
  const wasPresentRef = useRef(false)

  // If the current viewer's player entry disappears from state.players after
  // previously being present, assume they were removed and redirect them to '/'.
  useEffect(() => {
    try {
      if (!state || !Array.isArray(state.players) || !myId) return
      const present = state.players.some(p => p && p.id === myId)
      if (present) {
        wasPresentRef.current = true
        return
      }
      if (!present && wasPresentRef.current) {
        // we were present before and now we aren't — redirect to main page
        try {
          // attempt a replace so back button doesn't return to removed room
          window.location.replace('/')
        } catch (e) {
          try { window.location.href = '/' } catch (ee) {}
        }
      }
    } catch (e) {}
  }, [state && state.players, myId])

  // Notify players when host changes
  useEffect(() => {
  if (!state) return
  const prev = prevHostRef.current
  const current = state?.hostId
    // initialize on first run
    if (prev === null) {
      prevHostRef.current = current
      return
    }
    if (prev !== current) {
      const newHostObj = (state.players || []).find(p => p.id === current) || {}
      const newHostName = newHostObj.name || current || 'Unknown'
      const toastId = `host_${Date.now()}`
      const text = (current === myId) ? 'You are now the host' : `Host changed: ${newHostName}`
      setToasts(t => [...t, { id: toastId, text }])
      setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 4000)
      prevHostRef.current = current
    }
  }, [state?.hostId])
  useEffect(() => {
    const players = state?.players || []
    const timeouts = state?.timeouts || {}

    // scan for privateHits where the current viewer (myId) has an entry with count >= 2
    try {
      const me = players.find(p => p.id === myId) || {}
      const privateHits = me.privateHits || {}
      Object.keys(privateHits).forEach(targetId => {
        const entries = privateHits[targetId] || []
        entries.forEach(e => {
          if (e && e.type === 'letter' && (Number(e.count) || 0) >= 2) {
            const key = `${targetId}:${e.letter}:${e.count}`
            if (!multiHitSeenRef.current[key]) {
              multiHitSeenRef.current[key] = true
              const toastId = `mh_${Date.now()}`
              setToasts(t => [...t, { id: toastId, text: `Nice! ${e.count}× "${e.letter.toUpperCase()}" found — +${2*e.count}`, multi: true }])
              setTimeout(() => {
                setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x))
              }, 7000)
              setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 8000)
            }
          }
        })
      })
    } catch (e) {}

    // handle timeouts
    try {
      const keys = Object.keys(timeouts)
      keys.forEach(k => {
        const e = timeouts[k]
        if (!e || !e.player) return

        const playerIdTimed = e.player
        const ts = e.ts || Date.now()
        const playerObj = players.find(p => p.id === playerIdTimed)
        const playerName = (playerObj && playerObj.name) ? playerObj.name : playerIdTimed

        // dedupe per-player, prefer turnStartedAt when present
        const seen = processedTimeoutPlayersRef.current[playerIdTimed] || {}
        const seenTurn = seen.turnStartedAt
        if (e.turnStartedAt && seenTurn && e.turnStartedAt === seenTurn) return
        const last = seen.ts || 0
        if (!e.turnStartedAt && Math.abs(ts - last) < 5000) return
        processedTimeoutPlayersRef.current[playerIdTimed] = { ts, turnStartedAt: e.turnStartedAt || null }

        // don't re-show the same timeout entry's toast repeatedly
        if (processedTimeoutKeysRef.current[k]) return
        processedTimeoutKeysRef.current[k] = true

        const toastId = `${k}`
        setToasts(t => [...t, { id: toastId, text: `-2 wordmoney for ${playerName} (timed out)` }])
        setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 4000)

        // pending deduction UI + expected wordmoney
        if (e && typeof e.deducted === 'number') {
          const playerNow = players.find(p => p.id === playerIdTimed) || {}
          const currentHang = Number(playerNow.wordmoney) || 0
          const expectedAfter = currentHang - e.deducted
          expectedHangRef.current[playerIdTimed] = expectedAfter
          setPendingDeducts(prev => ({ ...prev, [playerIdTimed]: (prev[playerIdTimed] || 0) - e.deducted }))
          // Also persist a local hang-history entry and dispatch a local event so
          // PlayerCircle tooltips update immediately to show the -2 deduction.
          try {
            const entry = { ts: Number(e.ts || Date.now()), delta: -Math.abs(Number(e.deducted || 0)), reason: 'timeout', prev: Math.max(0, currentHang) }
            const key = `gh_hang_history_${playerIdTimed}`
            try {
              const existingRaw = localStorage.getItem(key)
              const existing = existingRaw ? JSON.parse(existingRaw) : []
              const next = [entry].concat(Array.isArray(existing) ? existing : []).slice(0,3)
              try { localStorage.setItem(key, JSON.stringify(next)) } catch (e2) {}
            } catch (e2) {}
            try {
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                try { window.dispatchEvent(new CustomEvent('gh_hang_history_update', { detail: { playerId: playerIdTimed, entry } })) } catch (e3) {}
              }
            } catch (e3) {}
          } catch (e3) {}
        }
      })
    } catch (e) {}

    // recent gain events (lastGain) — show once per (player,ts)
    try {
      players.forEach(p => {
        const lg = p.lastGain
        if (lg && lg.amount && lg.ts) {
          const key = `lg_${p.id}_${lg.ts}`
          if (!multiHitSeenRef.current[key]) {
            multiHitSeenRef.current[key] = true
            // Use a deterministic id based on player and lastGain timestamp to avoid duplicate keys
            const toastId = key
            setToasts(t => [...t, { id: toastId, text: `${p.name} gained +${lg.amount} (${lg.reason === 'wrongGuess' ? 'from wrong guess' : 'bonus'})`, fade: true }])
            setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 2500)
            setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3500)
          }
        }
      })
    } catch (e) {}

    // generic positive wordmoney deltas (uses prevHangRef to avoid initial-load noise)
    try {
      players.forEach(p => {
        const pid = p.id
        const prev = typeof prevHangRef.current[pid] === 'number' ? prevHangRef.current[pid] : null
        const nowVal = typeof p.wordmoney === 'number' ? p.wordmoney : 0
        if (prev !== null && nowVal > prev) {
          const delta = nowVal - prev
          const toastId = `gain_${pid}_${Date.now()}`
          setToasts(t => [...t, { id: toastId, text: `${p.name} gained +${delta}`, fade: true }])
          setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 2500)
          setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3500)
        }
        prevHangRef.current[pid] = nowVal
      })
    } catch (e) {}
  }, [state?.players, state?.timeouts])

  // clear pending deductions when we observe the DB has applied the wordmoney change
  useEffect(() => {
    if (!state || !state.players) return
    const updated = { ...pendingDeducts }
    let changed = false
    Object.keys(expectedHangRef.current || {}).forEach(pid => {
      const expected = expectedHangRef.current[pid]
      const p = (state.players || []).find(x => x.id === pid)
      if (!p) return
      const actual = Number(p.wordmoney) || 0
      // once actual is less-than-or-equal-to expected, consider the deduction persisted
      if (actual <= expected) {
        if (typeof updated[pid] !== 'undefined') {
          delete updated[pid]
          changed = true
        }
        delete expectedHangRef.current[pid]
      }
    })
    if (changed) setPendingDeducts(updated)
  }, [state?.players])

  const phase = state?.phase || 'lobby'
  const hostId = state?.hostId
  const players = state?.players || []
  const playerIdToName = {}
  players.forEach(p => { playerIdToName[p.id] = p.name })
  const submittedCount = players.filter(p => p.hasWord).length

  const isHost = hostId && window.__firebaseAuth && window.__firebaseAuth.currentUser && window.__firebaseAuth.currentUser.uid === hostId
  const currentTurnIndex = state?.currentTurnIndex || 0
  const currentTurnId = (state?.turnOrder || [])[currentTurnIndex]
  // whether the viewer is the current turn player
  const isMyTurnNow = state && state.turnOrder && typeof state.currentTurnIndex === 'number' && state.turnOrder[state.currentTurnIndex] === myId
  // derive some end-of-game values and visual pieces at top-level so hooks are not called conditionally
  // derive viewer name from server state if available (covers refresh cases)
  const myNode = (state?.players || []).find(p => p.id === myId) || {}
  const myName = myNode.name || playerName
  // consider the viewer a winner if the room's winnerId matches their id
  const isWinner = (state?.winnerId && myId && state.winnerId === myId) 
  // compute standings:
  // - if winnerByWordmoney is true, sort by wordmoney desc
  // - otherwise (last-one-standing), order by elimination: winner first, then players
  //   who were eliminated most recently, with the earliest-eliminated placed last.
  let standings = (state?.players || []).slice()
  try {
    if (state && state.winnerByWordmoney) {
      standings.sort((a,b) => (b.wordmoney || 0) - (a.wordmoney || 0))
    } else {
      // last-one-standing: derive order using eliminatedAt timestamps
      // winner should be first
      const winnerIdLocal = state && state.winnerId ? state.winnerId : null
      standings.sort((a,b) => {
        // winner first
        if (a.id === winnerIdLocal && b.id !== winnerIdLocal) return -1
        if (b.id === winnerIdLocal && a.id !== winnerIdLocal) return 1
        // survivors (not eliminated) come before eliminated players (but winner handling above)
        const aElim = !!a.eliminated
        const bElim = !!b.eliminated
        if (aElim !== bElim) return aElim ? 1 : -1
        // both eliminated or both active: sort by eliminatedAt desc so that most recently eliminated appears higher
        const aTs = a.eliminatedAt ? Number(a.eliminatedAt) : 0
        const bTs = b.eliminatedAt ? Number(b.eliminatedAt) : 0
        // newer timestamps first
        return bTs - aTs
      })
    }
  } catch (e) {
    // fallback: wordmoney desc
    standings.sort((a,b) => (b.wordmoney || 0) - (a.wordmoney || 0))
  }

  // defensive: ensure standings are valid objects before rendering (prevents invalid element type errors)
  const sanitizedStandings = (standings || []).filter(p => p && typeof p === 'object' && (p.id || p.name))
  if (sanitizedStandings.length !== (standings || []).length) {
    try { console.warn('GameRoom: filtered invalid entries from standings before rendering end screen', { rawStandings: standings, stateSnapshot: state }) } catch (e) {}
  }

  const confettiPieces = useMemo(() => {
    if (!isWinner) return []
    const colors = ['#FFABAB','#FFD54F','#B39DDB','#81D4FA','#C5E1A5','#F8BBD0','#B2EBF2']
    return new Array(48).fill(0).map(() => ({
      left: Math.random() * 100,
      // stagger delays up to ~1.6s so pieces reach bottom at different times
      delay: Math.random() * 1.6,
      size: 6 + Math.random() * 12,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotate: Math.random() * 360
    }))
  }, [isWinner])

  const cashPieces = useMemo(() => {
    if (!state?.winnerByWordmoney) return []
    return new Array(28).fill(0).map(() => ({
      left: Math.random() * 100,
      // stagger delays up to ~1.6s like confetti
      delay: Math.random() * 1.6,
      rotate: Math.random() * 360,
      // start slightly above the top using vh so viewport-relative
      topVh: -2 - (Math.random() * 6)
    }))
  }, [state?.winnerByWordmoney])

  

  const modeBadge = (
    // make the outer container pointer-events:none so it does not block clicks on underlying player tiles
    // but keep the inner card interactive by re-enabling pointer-events on it
    <div style={{ position: 'fixed', right: 18, top: 18, zIndex: 9999, pointerEvents: 'none' }}>
      <div className="mode-badge card" style={{ pointerEvents: 'auto', padding: '6px 10px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid rgba(34,139,34,0.12)' }}>
  <span style={{ fontSize: 16 }}>{state?.winnerByWordmoney ? '💸' : '🛡️'}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: '1' }}>
            <strong style={{ fontSize: 13 }}>{(state?.gameMode === 'wordSpy') ? 'Word Spy' : (state?.gameMode === 'money' || state?.winnerByWordmoney) ? 'Winner: Most wordmoney' : 'Winner: Last one standing'}</strong>
            <small style={{ color: '#B4A3A3', fontSize: 12 }}>{(state?.gameMode === 'wordSpy') ? 'Word Spy mode' : (state?.gameMode === 'money' || state?.winnerByWordmoney) ? 'Money wins' : 'Elimination wins'}</small>
          </div>
          {/* show a rocket badge when power-ups are enabled (defaults to true) and visible to all players in the lobby */}
          {powerUpsEnabled && phase === 'lobby' && (
            <div title="Power-ups are enabled" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="powerup-rocket" style={{ fontSize: 18 }}>🚀</span>
              <small style={{ color: '#B4A3A3', fontSize: 12 }}>Power-ups</small>
            </div>
          )}
          {isHost && phase === 'lobby' && (
            <button title="Room settings" onClick={() => setShowSettings(true)} style={{ background: 'transparent', border: 'none', fontSize: 18, cursor: 'pointer' }}>⚙️</button>
          )}
        </div>
      </div>
    </div>
  )

  // Persist various room-level settings
  async function updateRoomSettings(changes) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      // Ensure startingWordmoney is persisted as a Number (avoid storing numeric strings)
      const safe = { ...changes }
      try {
        if (typeof safe.startingWordmoney !== 'undefined') {
          const n = Number(safe.startingWordmoney)
          safe.startingWordmoney = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
        }
      } catch (e) {}
      await dbUpdate(roomRef, safe)
    } catch (e) {
      console.warn('Could not update room settings', e)
    }
  }

  // (Settings gear moved into the modeBadge) helper removed

  function SettingsModal({ open, onClose }) {
    if (!open) return null
    // immediate update: write minWordSize on change to avoid spinner revert issues

    return (
      <div className="settings-modal" style={{ position: 'fixed', right: 18, top: 64, width: 360, zIndex: 10001 }} onMouseDown={e => { try { e.stopPropagation() } catch (er) {} }} onClick={e => { try { e.stopPropagation() } catch (er) {} }}>
        <div className="card" style={{ padding: 12, maxHeight: '70vh', overflow: 'auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Room settings</strong>
            {/* fixed-size close button to avoid jitter when hovered/focused */}
            <button onClick={onClose} aria-label="Close settings" style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              width: 36,
              height: 36,
              padding: 6,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'none',
              outline: 'none'
            }}>✖</button>
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="timedMode">
              <input id="timedMode" name="timedMode" type="checkbox" checked={timedMode} onChange={e => { const nv = e.target.checked; setTimedMode(nv); updateRoomTiming(nv, turnSeconds); updateRoomSettings({ timed: !!nv, turnTimeoutSeconds: nv ? turnSeconds : null }) }} /> Timed game
            </label>
            {timedMode && (
              <label htmlFor="turnSeconds">
                Seconds per turn:
                <input id="turnSeconds" name="turnSeconds" type="number" min={10} max={600} value={turnSeconds} onChange={e => { const v = Math.max(10, Math.min(600, Number(e.target.value || 30))); setTurnSeconds(v); updateRoomTiming(timedMode, v); updateRoomSettings({ turnTimeoutSeconds: v }) }} style={{ width: 100, marginLeft: 8 }} />
              </label>
            )}
            <label htmlFor="starterEnabled" title="When enabled, a single random word requirement will be chosen when the game starts. Players whose submitted word meets the requirement receive +10 bonus wordmoney.">
              <input id="starterEnabled" name="starterEnabled" type="checkbox" checked={starterEnabled} onChange={e => { const nv = e.target.checked; setStarterEnabled(nv); updateRoomSettings({ starterBonus: { enabled: !!nv, description: state?.starterBonus?.description || '' } }) }} /> Word selection bonus
            </label>
            <div style={{ marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input id="secretThemeEnabled" type="checkbox" checked={secretThemeEnabled} onChange={e => { const nv = e.target.checked; setSecretThemeEnabled(nv); updateRoomSettings({ secretWordTheme: { enabled: !!nv, type: secretThemeType } }) }} /> Enforce secret word theme
                </label>
                {secretThemeEnabled && (
                  <label style={{ marginTop: 6 }} htmlFor="secretThemeType">Theme:
                    <select id="secretThemeType" value={secretThemeType} onChange={e => { const nv = e.target.value; setSecretThemeType(nv); updateRoomSettings({ secretWordTheme: { enabled: !!secretThemeEnabled, type: nv } }) }} style={{ marginLeft: 8 }}>
                      <option value="animals">Animals</option>
                      <option value="colours">Colours</option>
                      <option value="instruments">Instruments</option>
                      <option value="elements">Periodic elements</option>
                      <option value="cpp">C++ terms</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                )}
                {/* Host-only custom theme upload */}
                {secretThemeEnabled && isHost && secretThemeType === 'custom' && (
                  <div style={{ marginTop: 10, padding: 8, border: '1px dashed #eee', borderRadius: 8 }}>
                    <strong style={{ fontSize: 13 }}>Upload custom word set (host only)</strong>
                    <div style={{ marginTop: 8 }}>
                      <label style={{ display: 'block', fontSize: 13 }}>Title (optional):
                        <input id="custom_title" ref={customTitleRef} defaultValue={customTitle} onChange={e => { try { setCustomError('') } catch (er) {} }} placeholder="e.g. Party words" style={{ width: '100%', marginTop: 6 }} />
                      </label>
                      <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>Words (comma-separated):
                        <input id="custom_csv" ref={customCsvRef} defaultValue={customCsv} onChange={e => { try { setCustomError('') } catch (er) {} }} placeholder="ribbon,candy,cake,balloon,balloons" style={{ width: '100%', marginTop: 6 }} />
                      </label>
                      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                        <button onClick={async () => {
                          // validate CSV: lower-case, split, ensure each token is letters-only and single-word
                          try {
                            const raw = (customCsvRef.current ? (customCsvRef.current.value || '') : (customCsv || '')).toString().trim()
                            // allow empty raw: means any word permitted (no validation)
                            const parts = raw ? raw.split(',').map(s => (s || '').toString().trim().toLowerCase()).filter(Boolean) : []
                            // if provided some tokens, validate them
                            if (parts.length > 0) {
                              const invalid = parts.filter(w => !/^[a-z]+$/.test(w) || /\s/.test(w))
                              if (invalid.length > 0) {
                                // Preserve whatever the user has typed in the input — do NOT clear or overwrite
                                // the ref or local state so they can fix the comma-separated list in-place.
                                setCustomError(`Invalid words: ${invalid.slice(0,6).join(', ')}${invalid.length > 6 ? ', …' : ''}. Words must be single words with letters only.`)
                                // Do not touch prevCustomSerializedRef, customTitleRef, or customCsvRef here.
                                return
                              }
                            }
                            // Save to room settings (persist title and array). Empty array means "allow any word".
                            const titleVal = (customTitleRef.current ? (customTitleRef.current.value || '') : (customTitle || '')).toString().trim() || null
                            await updateRoomSettings({ secretWordTheme: { enabled: true, type: secretThemeType, custom: { title: titleVal, words: parts } } })
                            // remember serialized value so we don't overwrite local edits unnecessarily
                            const serNow = JSON.stringify({ title: titleVal || '', words: parts })
                            prevCustomSerializedRef.current = serNow
                            // Ensure the inputs reflect the confirmed saved set so the host can edit it further
                            try { if (customTitleRef.current) customTitleRef.current.value = titleVal || '' } catch (e) {}
                            try { if (customCsvRef.current) customCsvRef.current.value = (parts || []).join(',') } catch (e) {}
                            // keep local state in sync for compatibility
                            setCustomTitle(titleVal || '')
                            setCustomCsv((parts || []).join(','))
                            setCustomError('')
                            const savedToastId = `custom_ok_${Date.now()}`
                            setToasts(t => [...t, { id: savedToastId, text: 'Custom word set saved' }])
                            setTimeout(() => setToasts(t => t.filter(x => x.id !== savedToastId)), 4000)
                          } catch (e) {
                            console.warn('Could not save custom set', e)
                            setCustomError('Could not save custom set. Try again.')
                          }
                        }}>Save custom set</button>
                        <button onClick={async () => {
                          try {
                            // clear custom set from room
                            await updateRoomSettings({ secretWordTheme: { enabled: !!secretThemeEnabled, type: secretThemeType, custom: null } })
                            // clear local inputs and prev serialized marker
                            prevCustomSerializedRef.current = null
                            try { if (customCsvRef.current) customCsvRef.current.value = '' } catch (e) {}
                            try { if (customTitleRef.current) customTitleRef.current.value = '' } catch (e) {}
                            setCustomCsv('')
                            setCustomTitle('')
                            setCustomError('')
                            const clearedToastId = `custom_cleared_${Date.now()}`
                            setToasts(t => [...t, { id: clearedToastId, text: 'Custom word set cleared' }])
                            setTimeout(() => setToasts(t => t.filter(x => x.id !== clearedToastId)), 4000)
                          } catch (e) {
                            setCustomError('Could not clear custom set')
                          }
                        }}>Clear</button>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                        Example: ribbon,candy,cake,balloon,balloons — leave blank to allow any word (no validation)
                      </div>
                      {customError && <div style={{ marginTop: 8, color: '#900', fontSize: 13 }}>{customError}</div>}
                    </div>
                  </div>
                )}
              </div>
            <label htmlFor="gameMode" title="Choose the game mode for this room">
              Mode:
              <select id="gameMode" name="gameMode" value={gameMode} onChange={e => {
                const nv = e.target.value
                // when switching to Word Spy, default timed mode ON and set seconds = 60 * players
                if (nv === 'wordSpy') {
                  const playersCount = (state && state.players && Array.isArray(state.players)) ? state.players.length : ((players && Array.isArray(players)) ? players.length : 1)
                  const computed = Math.max(10, Math.min(600, 60 * Math.max(1, playersCount)))
                  setGameMode(nv)
                  setTimedMode(true)
                  setTurnSeconds(computed)
                  // persist mode and timing to room
                  updateRoomTiming(true, computed)
                  updateRoomGameMode(nv, { timerSeconds: computed, rounds: wordSpyRounds })
                  updateRoomSettings({ gameMode: nv, timed: true, turnTimeoutSeconds: computed })
                } else {
                  setGameMode(nv)
                  updateRoomGameMode(nv, { timerSeconds: turnSeconds, rounds: wordSpyRounds })
                  updateRoomSettings({ gameMode: nv })
                }
              }} style={{ marginLeft: 8 }}>
                <option value="lastOneStanding">Last One Standing</option>
                <option value="money">Money Wins</option>
                <option value="wordSpy">Word Spy</option>
              </select>
            </label>
            {gameMode === 'wordSpy' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                {/* Word Spy uses the global Timed game seconds (computed as 60 * players by default). Do not show a separate Word Spy timer input. */}
                <label htmlFor="wordSpyRounds">Rounds:
                  <input id="wordSpyRounds" type="number" min={1} max={20} value={wordSpyRounds} onChange={e => { const v = Math.max(1, Math.min(20, Number(e.target.value || 1))); setWordSpyRounds(v); updateRoomGameMode('wordSpy', { timerSeconds: turnSeconds, rounds: v }); updateRoomSettings({ wordSpyRounds: v }) }} style={{ width: 120, marginLeft: 8 }} />
                </label>
              </div>
            )}
            <label htmlFor="powerUpsEnabled" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title="Enable in-game power ups such as revealing letter counts or the starting letter.">
              <input id="powerUpsEnabled" name="powerUpsEnabled" type="checkbox" checked={powerUpsEnabled} onChange={e => { const nv = e.target.checked; setPowerUpsEnabled(nv); updateRoomSettings({ powerUpsEnabled: !!nv }) }} /> Power-ups enabled
            </label>
            <label htmlFor="showWordsOnEnd" title="When enabled, each player's submitted secret word is shown on the final standings screen">
              <input id="showWordsOnEnd" name="showWordsOnEnd" type="checkbox" checked={showWordsOnEnd} onChange={e => { const nv = e.target.checked; setShowWordsOnEnd(nv); updateRoomSettings({ showWordsOnEnd: !!nv }) }} /> Show words on end screen
            </label>
                <label htmlFor="revealPreserveOrder" title="When on, revealed letters are shown in their positions within the word (helps when combined with blanks).">
                  <input id="revealPreserveOrder" name="revealPreserveOrder" type="checkbox" checked={revealPreserveOrder} onChange={e => { const nv = e.target.checked; setRevealPreserveOrder(nv); updateRoomSettings({ revealPreserveOrder: !!nv }) }} /> Preserve reveal order
                </label>
                <label htmlFor="revealShowBlanks" title="Show blanks (underscores) for unrevealed letters. Enabling this will also enable Preserve reveal order.">
                  <input id="revealShowBlanks" name="revealShowBlanks" type="checkbox" checked={revealShowBlanks} onChange={e => { const nv = e.target.checked; setRevealShowBlanks(nv); if (nv) { setRevealPreserveOrder(true); updateRoomSettings({ revealShowBlanks: !!nv, revealPreserveOrder: true }) } else { updateRoomSettings({ revealShowBlanks: !!nv }) } }} /> Show blanks
                </label>
              <label htmlFor="minWordSize" title="Minimum allowed word length for submissions (2-10)">
                Min word length:
                <input
                  id="minWordSize"
                  name="minWordSize"
                  type="number"
                  min={2}
                  max={10}
                  value={minWordSizeInput}
                  onChange={e => setMinWordSizeInput(e.target.value)}
                  onBlur={() => {
                    // parse and persist a clamped numeric value when the user finishes editing
                    const parsed = Number(minWordSizeInput)
                    const v = Number.isFinite(parsed) ? Math.max(2, Math.min(10, parsed)) : 2
                    setMinWordSize(v)
                    setMinWordSizeInput(String(v))
                    updateRoomSettings({ minWordSize: v })
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur()
                    }
                  }}
                  style={{ width: 80, marginLeft: 8 }}
                />
              </label>
              <label htmlFor="startingWordmoney" title="Starting wordmoney assigned to each player when they join or when the room is reset">
                Starting balance:
                <input
                  id="startingWordmoney"
                  name="startingWordmoney"
                  type="number"
                  min={0}
                  step={1}
                  value={String(startingWordmoney || 0)}
                  onChange={e => setStartingWordmoney(e.target.value)}
                  onBlur={async (e) => {
                    try {
                      const parsed = Number(e.currentTarget.value)
                      const v = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
                      setStartingWordmoney(v)
                      await updateRoomSettings({ startingWordmoney: v })
                    } catch (err) {
                      console.warn('Could not update startingWordmoney', err)
                    }
                  }}
                  style={{ width: 100, marginLeft: 8 }}
                />
              </label>
          </div>
        </div>
      </div>
    )
  }

  // Power-up definitions
  const POWER_UPS = [
    { id: 'letter_for_letter', updateType:"not important", name: 'Letter for a Letter', price: 2, desc: "Reveals a random letter from your word and your opponent's word. Both players get points unless the letter has already been revealed privately (though power ups played by other players or by you) or publicly before. Reveals all occurrences of the letter.", powerupType: 'singleOpponentPowerup' },
    { id: 'vowel_vision', updateType:"important", name: 'Vowel Vision', price: 3, desc: 'Tells you how many vowels the word contains.', powerupType: 'singleOpponentPowerup' },
    { id: 'letter_scope', updateType:"important", name: 'Letter Scope', price: 3, desc: 'Find out how many letters the word has.', powerupType: 'singleOpponentPowerup' },
    { id: 'one_random', updateType:"not important", name: 'One Random Letter', price: 3, desc: 'Reveal one random letter. It may be a letter that is already revealed, in which case, you won\'t get points for it!', powerupType: 'singleOpponentPowerup' },
    { id: 'mind_leech', updateType:"not important", name: 'Mind Leech', price: 3, desc: "The letters that are revealed from your word will be used to guess your opponent's word. You can guess these letter to get points next turn, if it is not already revealed!", powerupType: 'singleOpponentPowerup' },
    { id: 'zeta_drop', updateType:"important", name: 'Zeta Drop', price: 5, desc: 'Reveal the last letter of the word, and all occurrences of it. You can\'t guess this letter to get points next turn.', powerupType: 'singleOpponentPowerup' },
    { id: 'letter_peek', updateType:"important", name: 'Letter Peek', price: 5, desc: 'Pick a position and reveal that specific letter.', powerupType: 'singleOpponentPowerup' },
  { id: 'related_word', updateType:"important", name: 'Related Word', price: 5, desc: 'Get a related word.', powerupType: 'singleOpponentPowerup' },
    { id: 'sound_check', updateType:"important", name: 'Sound Check', price: 6, desc: 'Suggests a word that sounds like the target word.', powerupType: 'singleOpponentPowerup' },
    { id: 'dice_of_doom', updateType:"not important", name: 'Dice of Doom', price: 7, desc: 'Rolls a dice and reveals that many letters at random from the target\'s word. It may be a letter that is already revealed!', powerupType: 'singleOpponentPowerup' },
  { id: 'split_15', updateType:"not important", name: 'Split 15', price: 6, desc: 'If the target word has 15 or more letters, reveal the first half of the word publicly. Buyer earns points for any previously unrevealed letters.', powerupType: 'singleOpponentPowerup' },
    { id: 'what_do_you_mean', updateType:"important", name: 'What Do You Mean', price: 7, desc: 'Suggests words with similar meaning.', powerupType: 'singleOpponentPowerup' },
    { id: 'all_letter_reveal', updateType:"not important", name: 'All The Letters', price: 8, desc: 'Reveal all letters in shuffled order.', powerupType: 'singleOpponentPowerup' },
    { id: 'full_reveal', updateType:"important", name: 'Full Reveal', price: 9, desc: 'Reveal the entire word instantly, in order.', powerupType: 'singleOpponentPowerup' },
    { id: 'word_freeze', updateType:"not important", name: 'Word Freeze', price: 1, desc: 'Put your word on ice: no one can guess it until your turn comes back around. You will also not gain +1 at the start of your turn.', powerupType: 'selfPowerup' },
    { id: 'double_down', updateType:"not important", name: 'Double Down', price: 1, desc: 'Stake some wordmoney; next correct guess yields double the stake you put down, for each correct letter. In addition to the stake, you will also get the default +2 when a letter is correctly guessed. Beware: you will lose the stake on a wrong guess.', powerupType: 'selfPowerup' },
    { id: 'price_surge', updateType:"not important", name: 'Price Surge', price: 5, desc: 'Increase everyone else\'s shop prices by +2 for the rest of the game.', powerupType: 'selfPowerup' },
    { id: 'crowd_hint', updateType:"not important", name: 'Crowd Hint', price: 5, desc: 'Reveal one random letter from everyone\'s word, including yours. Letters are revealed publicly and are no-score.', powerupType: 'selfPowerup' },
    { id: 'longest_word_bonus', updateType:"important", name: 'Longest Word Bonus', price: 5, desc: 'Grant +10 coins to the player with the longest word. Visible to others when played. One-time per player, per game.', powerupType: 'selfPowerup' },
    { id: 'rare_trace', updateType:"important", name: 'Rare Trace', price: 2, desc: 'Reports how many rare letters (Q, X, Z, J, K, V) appear in the target\'s word.', powerupType: 'singleOpponentPowerup' }
  ]

  // Ensure the UI shows power-ups ordered by price (ascending)
  try { POWER_UPS.sort((a,b) => (Number(a.price) || 0) - (Number(b.price) || 0)) } catch (e) {}

  // helper to perform a power-up purchase; writes to DB private entries and deducts wordmoney
  async function purchasePowerUp(powerId, opts = {}) {
    if (!powerUpTarget) return
    if (!myId) return
    // ensure it's the player's turn
    if (currentTurnId !== myId) {
      setToasts(t => [...t, { id: `pup_err_turn_${Date.now()}`, text: 'You can only play power-ups on your turn.' }])
      return
    }
    const pu = POWER_UPS.find(p => p.id === powerId)
    if (!pu) return
    const baseCost = pu.price
    // compute effective cost (account for global price surge(s) set by other player(s)).
    // Support both legacy single-object shape and new per-player map shape.
    let cost = baseCost
    try {
      let totalSurgeAmount = 0
      const ps = state && state.priceSurge
      if (ps && typeof ps === 'object') {
        // legacy single-object shape: { amount, by, expiresAtTurnIndex }
        if (typeof ps.amount !== 'undefined' && (typeof ps.by !== 'undefined' || typeof ps.expiresAtTurnIndex !== 'undefined')) {
          const surge = ps
          if (surge && surge.amount && surge.by !== myId) {
            const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
            const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
            if (active) totalSurgeAmount += Number(surge.amount || 0)
          }
        } else {
          // new map shape: { [playerId]: { amount, by, expiresAtTurnIndex }, ... }
          Object.keys(ps || {}).forEach(k => {
            try {
              const entry = ps[k]
              if (!entry || !entry.amount) return
              if (entry.by === myId) return // buyer's own surge does not affect them
              const expires = typeof entry.expiresAtTurnIndex === 'number' ? entry.expiresAtTurnIndex : null
              const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
              if (active) totalSurgeAmount += Number(entry.amount || 0)
            } catch (e) {}
          })
        }
      }
      if (totalSurgeAmount) cost = baseCost + totalSurgeAmount
    } catch (e) {}
    // check buyer wordmoney
    const me = (state?.players || []).find(p => p.id === myId) || {}
    const myHang = Number(me.wordmoney) || 0
    if (myHang - cost < 0) {
      setToasts(t => [...t, { id: `pup_err_money_${Date.now()}`, text: 'Not enough wordmoney to buy that power-up.' }])
      return
    }

    // Guard: only allow longest_word_bonus once per buyer
    if (powerId === 'longest_word_bonus') {
      try {
        if (state && state.usedLongestWordBonus && state.usedLongestWordBonus[myId]) {
          setToasts(t => [...t, { id: `pup_err_used_${Date.now()}`, text: 'Longest Word Bonus already used.' }])
          return
        }
      } catch (e) {}
    }
    setPowerUpLoading(true)
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const updates = {}
      // deduct buyer wordmoney
      updates[`players/${myId}/wordmoney`] = myHang - cost
      // if buying Double Down, record the stake and keep turn active so the buyer can guess
      if (powerId === 'double_down') {
        try {
          const stake = Number(opts && opts.stake) || 0
          // server/client guard: do not allow staking more than (current wordmoney - 1)
          // e.g. if wordmoney is 3, max stake is 2
          const maxStake = Math.max(0, (Number(me.wordmoney) || 0) - 1)
          if (stake > maxStake) {
            setToasts(t => [...t, { id: `pup_err_stake_${Date.now()}`, text: `Stake cannot exceed $${maxStake} (your current wordmoney - 1)` }])
            setPowerUpLoading(false)
            return
          }
          updates[`players/${myId}/doubleDown`] = { active: true, stake }
        } catch (e) {}
      }
      // write a private entry for buyer and target so only they see the result
      const key = `pu_${Date.now()}`
      // store under players/{buyer}/privatePowerReveals/{targetId}/{key} = { powerId, data }
      const data = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  // accumulate any wordmoney awards for the target here and apply once
  let stagedTargetAwardDelta = 0
  // flag to avoid double-awarding buyer when a power-up-specific award was already applied
  let skipBuyerLetterAward = false
      // attach additional results after computing
  // perform server-side or client-side compute for power-up results
  let resultPayload = null
  // tracker for one_random award so we can write a friendly message into the
  // buyer/target privatePowerReveals after we compute awards below
  let oneRandomAward = 0
  // compute some client-side results for immediate write when possible
  const targetNode = (state?.players || []).find(p => p.id === powerUpTarget) || {}
  const targetWord = targetNode.word || ''
  
  const buyerName = playerIdToName[myId] || myId
  const targetName = playerIdToName[powerUpTarget] || powerUpTarget
  const buyerBase = { powerId: 'vowel_vision', ts: Date.now(), from: myId, by: myId, to: powerUpTarget }
  const targetBase = { powerId: 'vowel_vision', ts: Date.now(), from: myId, by: myId, to: powerUpTarget }
  
      if (powerId === 'letter_scope') {
        const letters = (targetWord || '').length
        resultPayload = { letters, message: `Letter Scope: there are ${letters} letter${letters === 1 ? '' : 's'} in the word` }
        
        const buyerMsg = `Letter Scope: Including duplicates, there are ${letters} letter${letters === 1 ? '' : 's'} in the word`
        const targetMsg = `${buyerName} used Letter Scope on you`
        const buyerData = { ...buyerBase, result: { letters, message: buyerMsg } }
        const targetData = { ...targetBase, result: { letters, message: targetMsg } }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData

      } else if (powerId === 'zeta_drop') {
        const last = targetWord ? targetWord.slice(-1) : null
        // Zeta Drop now publicly reveals the last letter (added to target.revealed).
        // Set resultPayload so downstream reveal handling adds it to the public revealed
        // set and awards the buyer if appropriate.
        resultPayload = { last }

        const buyerMsg = `Zeta Drop: last letter is ${last}`
        const targetMsg = `${buyerName} used Zeta Drop on you to find out the last letter is ${last}`
        // write privatePowerReveals entries for buyer and target so UI can show the results
        const buyerBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
        const targetBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
        const buyerData = { ...buyerBase, result: { last, message: buyerMsg } }
        const targetData = { ...targetBase, result: { last, message: targetMsg } }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData

      } else if (powerId === 'one_random') {
        const letters = (targetWord || '').split('')
        // letters.length > 0 guaranteed since minWordSize >= 2
        const ch = letters[Math.floor(Math.random() * letters.length)]
        resultPayload = { letter: ch }
        const buyerMsg = `One Random Letter: ${ch} in ${targetName}'s word`
        const targetMsg = `${buyerName} used One Random Letter on you; they revealed ${ch}`
        const buyerData = { ...buyerBase, result: { letter: ch, message: buyerMsg } }
        const targetData = { ...targetBase, result: { letter: ch, message: targetMsg } }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
      } else if (powerId === 'letter_peek') {
        const pos = Number(opts.pos) || 0
        // shared variables need to be in outer scope so we can reference them below
        let letter = null
        let buyerMsg = null
        let targetMsg = null

        // human-readable short messages; explicitly report no letter at position when invalid
        if (!pos || pos < 1) {
          buyerMsg = `Letter peek: no letter at position ${opts.pos || pos}`
          targetMsg = `${buyerName} used Letter Peek on you; they revealed no letter at position ${opts.pos || pos}`
          resultPayload = { message: `Letter peek: no letter at position ${opts.pos || pos}`, pos }
        } else {
          letter = (targetWord && targetWord[pos-1]) ? targetWord[pos-1] : null
          if (!letter) {
            resultPayload = { message: `Letter peek: no letter at position ${pos}`, pos }
            buyerMsg = `Letter peek: no letter at position ${pos}`
            targetMsg = `${buyerName} used Letter Peek on you; they revealed no letter at position ${pos}`
          } else {
            resultPayload = { message: `Letter peek: '${letter}' at position ${pos}`, letter, pos }
            buyerMsg = `Letter peek: '${letter}' at position ${pos}`
            targetMsg = `${buyerName} used Letter Peek on you; they revealed '${letter}' letter at position ${pos}`
          }
        }

        const buyerData = { ...buyerBase, result: { letter: letter, message: buyerMsg } }
        const targetData = { ...targetBase, result: { letter: letter, message: targetMsg } }

        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
      } else if (powerId === 'related_word') {
        // Related word: use Datamuse rel_trg (related target words) and return a short word word
        let buyerMsg = `Related Word: no result found`
        let targetMsg = `${buyerName} used Related Word on you; they revealed no related word`
        try {
          const q = encodeURIComponent(targetWord || '')
          const url = `https://api.datamuse.com/words?rel_trg=${q}&max=6`
          const res = await fetch(url)
          if (res && res.ok) {
            const list = await res.json()
            const words = Array.isArray(list) ? list.map(i => i.word).filter(Boolean) : []
            const candidate = words.find(w => w.toLowerCase() !== (targetWord || '').toLowerCase())
            
            if (candidate) {
              buyerMsg = `Related Word: '${candidate}'`
              targetMsg = `${buyerName} used Related Word on you; they revealed '${candidate}' as a related word`
            }
          }
        } catch (e) {
          // resultPayload = { message: 'Related word: no result' }
        }

        resultPayload = { message: buyerMsg }


        const buyerData = { ...buyerBase, result: { message: buyerMsg } }
        const targetData = { ...targetBase, result: { message: targetMsg } }

        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
      } else if (powerId === 'dice_of_doom') {
        const roll = Math.floor(Math.random() * 6) + 1
        const letters = (targetWord || '').split('')
        const revealCount = Math.min(letters.length, roll)
        // pick revealCount random indices
        const indices = []
        const available = Array.from({ length: letters.length }, (_,i) => i)
        while (indices.length < revealCount && available.length > 0) {
          const idx = Math.floor(Math.random() * available.length)
          indices.push(available.splice(idx,1)[0])
        }
        // convert indices to the actual letters so payload exposes letters instead of numeric indices
        const revealedLetters = indices.map(i => (targetWord[i] || '').toLowerCase()).filter(Boolean)
        resultPayload = { roll, letters: revealedLetters }
        // write explicit buyer/target privatePowerReveals so buyer always sees result
        try {
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = (revealedLetters && revealedLetters.length > 0) ? `Dice of Doom: revealed ${revealedLetters.join(', ')}` : `Dice of Doom: no letters could be revealed`
          const targetMsgLocal = (revealedLetters && revealedLetters.length > 0) ? `${buyerName} used Dice of Doom on you; they revealed ${revealedLetters.join(', ')}` : `${buyerName} used Dice of Doom on you; no letters were revealed`
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal } }
        } catch (e) {}
      } else if (powerId === 'all_letter_reveal') {
        resultPayload = { letters: (targetWord || '').split('').sort(() => Math.random()-0.5) }
        // also reveal all letters publicly (but shuffled order is kept in private payload)
        const existingAll = targetNode.revealed || []
        const allLetters = Array.from(new Set(((targetWord || '').toLowerCase().split('').filter(Boolean))))
        updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existingAll || []), ...allLetters]))
        // buyer/target private messages for all_letter_reveal
        try {
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = `All Letters: revealed all letters from ${targetName}'s word`
          const targetMsgLocal = `${buyerName} revealed all letters of your word publicly`
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal } }
        } catch (e) {}
        } else if (powerId === 'split_15') {
          // If the target word has 15+ letters, reveal the first half publicly and
          // award the buyer for any newly-unrevealed occurrences in that half.
          try {
            const w = (targetWord || '')
            if (w && w.length >= 15) {
              const half = Math.floor(w.length / 2)
              const firstHalf = w.slice(0, half).toLowerCase().split('').filter(Boolean)
              // prepare resultPayload exposing the letters (unique)
              const letters = Array.from(new Set(firstHalf))
              resultPayload = { letters }

              // write buyer/target privatePowerReveals
              const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              const buyerMsgLocal = `Split 15: revealed first ${half} letters of ${targetName}'s word`
              const targetMsgLocal = `${buyerName} used Split 15 on you; the first ${half} letters were revealed publicly`
              updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { letters, message: buyerMsgLocal } }
              updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { letters, message: targetMsgLocal } }

              // add letters to revealed set (preserve any existing revealed letters)
              const existing = targetNode.revealed || []
              const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
              const toAdd = letters.map(ch => (ch || '').toLowerCase()).filter(Boolean)
              const newRevealed = Array.from(new Set([...(existing || []), ...toAdd]))
              updates[`players/${powerUpTarget}/revealed`] = newRevealed

              // Award buyer for newly revealed occurrences (2 per occurrence)
              try {
                const meNow = (state?.players || []).find(p => p.id === myId) || {}
                const baseAfterCostNow = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined') ? updates[`players/${myId}/wordmoney`] : (Number(meNow.wordmoney) || 0) - cost
                let awardTotal = 0
                const prevHitsNow = (meNow.privateHits && meNow.privateHits[powerUpTarget]) ? meNow.privateHits[powerUpTarget].slice() : []
                toAdd.forEach(letter => {
                  try {
                    if (!existingSet.has(letter)) {
                      const count = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === letter).length
                      if (count > 0) {
                        awardTotal += 2 * count
                        // merge into privateHits
                        let merged = false
                        for (let i = 0; i < prevHitsNow.length; i++) {
                          const h = prevHitsNow[i]
                          if (h && h.type === 'letter' && h.letter === letter) {
                            prevHitsNow[i] = { ...h, count: (Number(h.count) || 0) + count, ts: Date.now() }
                            merged = true
                            break
                          }
                        }
                        if (!merged) prevHitsNow.push({ type: 'letter', letter, count, ts: Date.now() })
                      }
                    }
                  } catch (e) {}
                })
                if (awardTotal > 0) {
                  updates[`players/${myId}/wordmoney`] = Math.max(0, Number(baseAfterCostNow) + awardTotal)
                  updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHitsNow
                  updates[`players/${myId}/lastGain`] = { amount: awardTotal, by: powerUpTarget, reason: powerId, ts: Date.now() }
                }
              } catch (e) {}
            } else {
              // word too short: write buyer/target messages indicating nothing happened
              const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { message: `Split 15: target word is shorter than 15 letters; no effect` } }
              updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { message: `${buyerName} used Split 15 on you; word is too short` } }
            }
          } catch (e) {}
      } else if (powerId === 'full_reveal') {
        resultPayload = { full: targetWord }
        // reveal whole word publicly
        const existingFull = targetNode.revealed || []
        const allLettersFull = Array.from(new Set(((targetWord || '').toLowerCase().split('').filter(Boolean))))
        updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existingFull || []), ...allLettersFull]))
        // buyer/target private messages for full_reveal
        try {
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = `Full Reveal: revealed ${targetName}'s word: ${targetWord}`
          const targetMsgLocal = `${buyerName} used Full Reveal on you; your word was revealed publicly`
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal } }
        } catch (e) {}
      } else if (powerId === 'sound_check' || powerId === 'what_do_you_mean') {
        // sound_check: return exactly one rhyming word (Datamuse rel_rhy) that isn't the exact target
        // what_do_you_mean: return similar-meaning suggestions (ml) as before
        try {
          const q = encodeURIComponent(targetWord || '')
          if (powerId === 'sound_check') {
            // use RhymeBrain for rhymes; return a single rhyme that's not identical
            try {
              const url = `https://rhymebrain.com/talk?function=getRhymes&word=${q}`
              const res2 = await fetch(url)
              if (res2 && res2.ok) {
                const list2 = await res2.json()
                const words2 = Array.isArray(list2) ? list2.map(i => i.word).filter(Boolean) : []
                const candidate = words2.find(w => w.toLowerCase() !== (targetWord || '').toLowerCase())
                resultPayload = { suggestions: candidate ? [candidate] : [] }
              } else resultPayload = { suggestions: [] }
            } catch (e) {
              // fallback to empty
              resultPayload = { suggestions: [] }
            }
            } else {
            // what_do_you_mean: fetch a single English definition (dictionaryapi.dev). Do NOT include the word itself in the response.
            try {
              const raw = (targetWord || '').toString().trim()
              if (!raw) {
                resultPayload = { message: "I don't know the definition!" }
              } else {
                // Attempt dictionary lookup. Try the local proxy first (/api/dictionary).
                // If that fails, try the upstream Free Dictionary API directly as a fallback.
                // Prefer a definition that does NOT contain the target word; otherwise sanitize it.
                async function fetchDefinitions(url) {
                  try {
                    const r = await fetch(url)
                    if (r && r.ok) {
                      const j = await r.json()
                      return Array.isArray(j) ? j : null
                    }
                  } catch (e) {
                    // swallow and return null so caller can try fallback
                  }
                  return null
                }


                const response = await fetch(
                  `https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(raw)}?`
                );
                console.log('FreeDictionaryAPI response status:', response.status);

                if (!response.ok && response.status !== 404) {
                  freeDictDown = true
                }

                const data = await response.json();
                console.log('FreeDictionaryAPI response data:', data);

                // Check if we got a valid entry with definitions
                const isValid = data.entries.length > 0;

                if (isValid) {
                  console.log(`Found definitions for "${raw}":`, data);
                  data.entries.some(entry =>
                      entry.senses.some(sense =>
                        sense.definitions.some(def => {
                          if (!def.includes(raw)) {
                            resultPayload = { message: def };
                            return true; // stops all the way up
                          }
                          return false;
                        })
                      )
                    );
                } else {
                  // try api/dicitonary

                try {
                  const proxyUrl = `/api/dictionary?word=${encodeURIComponent(raw)}`
                  let ddata = await fetchDefinitions(proxyUrl)

                  // extract candidate definitions (strings) from the response
                  let candidates = []
                  if (Array.isArray(ddata) && ddata.length > 0) {
                    for (const entry of ddata) {
                      if (!entry || !entry.meanings) continue
                      for (const meaning of entry.meanings || []) {
                        if (!meaning || !Array.isArray(meaning.definitions)) continue
                        for (const d of meaning.definitions) {
                          if (d && d.definition && typeof d.definition === 'string' && d.definition.trim().length > 0) {
                            candidates.push(d.definition.trim())
                          }
                        }
                      }
                    }
                  }

                  if (candidates.length === 0) {
                    resultPayload = { message: "I don't know the definition." }
                  } else {
                    // prefer a definition that does not include the target word (as a whole word, case-insensitive)
                    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    const wholeRe = new RegExp(`\\b${escaped}\\b`, 'i')
                    let pick = candidates.find(c => !wholeRe.test(c)) || candidates[0]
                    // If pick contains the word, sanitize exact whole-word occurrences by replacing with a neutral token
                    try {
                      const sanitizeRe = new RegExp(`\\b${escaped}\\b`, 'ig')
                      if (sanitizeRe.test(pick)) {
                        pick = pick.replace(sanitizeRe, 'the word')
                      }
                    } catch (e) {}
                    // keep message concise: single sentence if possible
                    const oneSentence = (pick || '').split(/[\.\!\?]\s/)[0]
                    resultPayload = { message: oneSentence || pick }
                  }
                } catch (e) {
                  console.warn(e);
                  resultPayload = { message: "I don't know the definition." }
                }
              }
              }
            } catch (e) {
              console.warn(e);
              resultPayload = { message: "I don't know the definition :(" }
            }
          }
        } catch (e) {
          resultPayload = { suggestions: [] }
        }
        // Write buyer/target messages for sound_check / definition lookup so buyer sees a friendly result
        try {
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = (powerId === 'sound_check')
            ? `Sound Check: sounds similar to ${((resultPayload && resultPayload.suggestions) || []).slice(0,3).join(', ') || 'none'}`
            : `Definition: ${((resultPayload && resultPayload.message) || "I don't know the definition.")}`
          const targetMsgLocal = (powerId === 'sound_check')
            ? `${buyerName} used Sound Check on you` : `${buyerName} used What Do You Mean on you`
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal } }
        } catch (e) {}
      } else if (powerId === 'mind_leech') {
        // Mind leech: use letters others have guessed for the buyer's own word
        // (buyerNode.guessedBy keys) to simulate those same guesses against the target's word.
        
          const buyerNode = (state?.players || []).find(p => p.id === myId) || {}
          const guessedBy = buyerNode.guessedBy || {}
          // keys in guessedBy map are letters (or '__word'); ignore '__word'
          const attemptedSet = new Set(Object.keys(guessedBy || {}).filter(k => k && k !== '__word').map(k => k.toLowerCase()))

          // ALSO include any letters revealed to the buyer via power-ups recorded in
          // buyerNode.privateHits. These entries can include single-letter
          // fields (letter, last, letterFromBuyer, letterFromTarget), arrays (letters),
          // or found arrays (objects with .letter). Add all discovered letters to the
          // attempted set so Mind Leech uses them when probing the target word.
          try {
            const ppr = buyerNode.privateHits || {}
            Object.keys(ppr || {}).forEach(bucket => {
              const entries = ppr[bucket] || {}
              Object.values(entries || {}).forEach(entry => {
                try {
                  if (!entry || !entry.result) return
                  const res = entry.result || {}
                  const push = (v) => { try { if (v) attemptedSet.add(String(v).toLowerCase()) } catch (e) {} }
                  if (res.letter) push(res.letter)
                  if (res.last) push(res.last)
                  if (res.letterFromBuyer) push(res.letterFromBuyer)
                  if (res.letterFromTarget) push(res.letterFromTarget)
                  if (Array.isArray(res.letters)) res.letters.forEach(ch => push(ch))
                  if (Array.isArray(res.found)) res.found.forEach(f => { if (f && f.letter) push(f.letter) })
                } catch (e) {}
              })
            })
          } catch (e) {}

          // ALSO include any letters already publicly revealed on the buyer's own word
          // (buyerNode.revealed). These should be considered attempted as the buyer
          // effectively 'knows' these letters and wants to probe whether they exist
          // in the target's word as well.
          try {
            const revealedLetters = buyerNode.revealed || []
            if (Array.isArray(revealedLetters)) {
              revealedLetters.forEach(ch => { try { if (ch) attemptedSet.add(String(ch).toLowerCase()) } catch (e) {} })
            }
          } catch (e) {}
          const letters = (targetWord || '').toLowerCase().split('')
          // Build a stable, sorted attempted array for display and deterministic behavior
          const attemptedArray = Array.from(attemptedSet).filter(Boolean).map(x => (x || '').toString().toLowerCase())
          attemptedArray.sort()
          const found = []
          attemptedArray.forEach(l => {
            const count = letters.filter(ch => ch === l).length
            if (count > 0) found.push({ letter: l, count })
          })

          // Build human-friendly messages that explicitly state which letters were tried
          const triedDisplay = attemptedArray.length > 0 ? attemptedArray.join(', ') : 'none'
          const buyerMsg = (found && found.length > 0)
            ? `Mind Leech: tried ${triedDisplay}; found ${found.map(f => `${f.letter} (${f.count})`).join(', ')} in ${targetName}'s word`
            : `Mind Leech: tried ${triedDisplay}; no letters from your word matched ${targetName}'s word`
          const targetMsg = (found && found.length > 0)
            ? `${buyerName} used Mind Leech on you; they tried ${triedDisplay} and found ${found.map(f => `${f.letter} (${f.count})`).join(', ')}`
            : `${buyerName} used Mind Leech on you; they tried ${triedDisplay} and found no matching letters`

          // write privatePowerReveals entries for buyer and target so UI can show the results
          const buyerBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerData = { ...buyerBase, result: { found, attempted: attemptedArray, message: buyerMsg } }
          const targetData = { ...targetBase, result: { found, attempted: attemptedArray, message: targetMsg } }
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData

          // Award buyer points for any newly-revealed occurrences (2 per occurrence) that were not
          // already publicly revealed or privately revealed to this buyer previously.
          try {
            const targetExisting = (targetNode && targetNode.revealed) ? targetNode.revealed : []
            const targetExistingSet = new Set((targetExisting || []).map(x => (x || '').toLowerCase()))

            // check buyer's previous private reveals sent to this target
            const buyerPrivateBucket = (buyerNode.privatePowerReveals && buyerNode.privatePowerReveals[powerUpTarget]) ? Object.values(buyerNode.privatePowerReveals[powerUpTarget]) : []
            const wasPrivatelyRevealed = (letterLower) => {
              try {
                for (const r of buyerPrivateBucket) {
                  if (!r || !r.result) continue
                  const res = r.result
                  const check = (s) => (s || '').toString().toLowerCase() === letterLower
                  if (res.letterFromTarget && check(res.letterFromTarget)) return true
                  if (res.letterFromBuyer && check(res.letterFromBuyer)) return true
                  if (res.letter && check(res.letter)) return true
                  if (res.last && check(res.last)) return true
                  if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(letterLower)) return true
                  if (res.found && Array.isArray(res.found) && res.found.map(x => (x && x.letter || '').toString().toLowerCase()).includes(letterLower)) return true
                }
              } catch (e) {}
              return false
            }

            let awardTotal = 0
            const meNow = (state?.players || []).find(p => p.id === myId) || {}
            const prevHitsNow = (meNow.privateHits && meNow.privateHits[powerUpTarget]) ? meNow.privateHits[powerUpTarget].slice() : []
            for (const f of (found || [])) {
              try {
                const letter = (f && f.letter) ? (f.letter || '').toString() : null
                if (!letter) continue
                const lower = letter.toLowerCase()
                if (targetExistingSet.has(lower)) continue
                if (wasPrivatelyRevealed(lower)) continue
                const count = Number(f.count) || 0
                if (count <= 0) continue
                const add = 2 * count
                awardTotal += add
                // merge into privateHits for buyer
                let mergedNow = false
                for (let i = 0; i < prevHitsNow.length; i++) {
                  const h = prevHitsNow[i]
                  if (h && h.type === 'letter' && h.letter === lower) {
                    prevHitsNow[i] = { ...h, count: (Number(h.count) || 0) + count, ts: Date.now() }
                    mergedNow = true
                    break
                  }
                }
                if (!mergedNow) prevHitsNow.push({ type: 'letter', letter: lower, count, ts: Date.now() })
              } catch (e) {}
            }

            if (awardTotal > 0) {
              const myHangCurrentNow = Number(meNow.wordmoney) || 0
              const baseAfterCostNow = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined') ? updates[`players/${myId}/wordmoney`] : (myHangCurrentNow - cost)
              updates[`players/${myId}/wordmoney`] = Math.max(0, Number(baseAfterCostNow) + awardTotal)
              updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHitsNow
              updates[`players/${myId}/lastGain`] = { amount: awardTotal, by: powerUpTarget, reason: powerId, ts: Date.now() }
            }
          } catch (e) {}
       

      } else if (powerId === 'vowel_vision') {
    // Include a human-readable message for buyer and target, visible only to them.
    // Explicitly include powerId, from and by fields so PlayerCircle's visiblePrivatePowerReveals
    // recognizes the entry as a power-up result (same pattern as letter_for_letter).
    const vowels = (targetWord.match(/[aeiou]/ig) || []).length
    resultPayload = { vowels }
    const buyerMsg = `Vowel Vision: There are ${vowels} vowel${vowels === 1 ? '' : 's'} in ${targetName}'s word`
    const targetMsg = `${buyerName} used Vowel Vision on you; they saw ${vowels} vowel${vowels === 1 ? '' : 's'}`
    const buyerData = { ...buyerBase, result: { vowels, message: buyerMsg } }
    const targetData = { ...targetBase, result: { vowels, message: targetMsg } }
    updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
    updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
  } else if (powerId === 'letter_for_letter') {
        // reveal one random letter from the target's word publicly,
        // AND privately reveal one random letter from the buyer's own word to the target.
        // Award points to both players for any newly revealed occurrences (2 wordmoney per occurrence).
  const targetLetters = (targetWord || '').split('')
  const tletter = targetLetters.length > 0 ? targetLetters[Math.floor(Math.random() * targetLetters.length)] : null
  // pick a random letter from the buyer's own word to privately reveal to the target
  const buyerNodeForPick = (state?.players || []).find(p => p.id === myId) || {}
  const buyerLetters = (buyerNodeForPick.word || '').split('')
  const bletter = buyerLetters.length > 0 ? buyerLetters[Math.floor(Math.random() * buyerLetters.length)] : null
  // prepare asymmetric payloads
  let buyerResultPayload = null // what buyer (myId) will see about the target
  let targetResultPayload = null // what target will see about the buyer
  // public reveal payload for the target (so downstream code that handles resultPayload.letter applies awards)
  let resultPayload = null
  if (tletter) resultPayload = { letter: tletter }
  if (tletter) buyerResultPayload = { letterFromTarget: tletter }
  if (bletter) targetResultPayload = { letterFromBuyer: bletter }
        // determine awards (they were applied earlier into updates[].wordmoney when applicable)
        // For buyer: if buyerResultPayload.letterFromTarget exists, compute how many occurrences in targetWord
        let buyerAward = 0
        let buyerLetter = null
        if (buyerResultPayload && buyerResultPayload.letterFromTarget) {
          buyerLetter = (buyerResultPayload.letterFromTarget || '').toString()
          const lower = buyerLetter.toLowerCase()
          const count = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === lower).length
          // Only count award if the target did not already have this letter publicly revealed
          // and the buyer hasn't already privately revealed this same letter to the target.
          const targetExisting = (targetNode && targetNode.revealed) ? targetNode.revealed : []
          const targetExistingSet = new Set((targetExisting || []).map(x => (x || '').toLowerCase()))
          // check buyer's previous private reveals sent to this target
          const buyerNodeForCheck = (state?.players || []).find(p => p.id === myId) || {}
          const buyerPrivateBucket = (buyerNodeForCheck.privatePowerReveals && buyerNodeForCheck.privatePowerReveals[powerUpTarget]) ? Object.values(buyerNodeForCheck.privatePowerReveals[powerUpTarget]) : []
          const letterWasPrivatelyRevealedByBuyer = (function() {
            try {
              for (const r of buyerPrivateBucket) {
                if (!r || !r.result) continue
                const res = r.result
                const check = (s) => (s || '').toString().toLowerCase() === lower
                if (res.letterFromTarget && check(res.letterFromTarget)) return true
                if (res.letterFromBuyer && check(res.letterFromBuyer)) return true
                if (res.letter && check(res.letter)) return true
                if (res.last && check(res.last)) return true
                if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(lower)) return true
              }
            } catch (e) {}
            return false
          })()

          buyerAward = (count > 0 && !targetExistingSet.has(lower) && !letterWasPrivatelyRevealedByBuyer) ? 2 * count : 0
        }
        // For target: if targetResult.letterFromBuyer exists, compute occurrences in buyer's word
        let targetAward = 0
        let targetLetter = null
        if (targetResultPayload && targetResultPayload.letterFromBuyer) {
          targetLetter = (targetResultPayload.letterFromBuyer || '').toString()
          const lowerB = targetLetter.toLowerCase()
          const buyerNode = (state?.players || []).find(p => p.id === myId) || {}
          const buyerWord = buyerNode.word || ''
          const countB = (buyerWord || '').split('').filter(ch => (ch || '').toLowerCase() === lowerB).length
          // Only award target if the buyer's letter wasn't already publicly revealed
          // and the target hasn't already privately revealed this same letter (in any way) to the buyer.
          const buyerExisting = (buyerNode && buyerNode.revealed) ? buyerNode.revealed : []
          const buyerExistingSet = new Set((buyerExisting || []).map(x => (x || '').toLowerCase()))
          const targetNodeForCheck = (state?.players || []).find(p => p.id === powerUpTarget) || {}
          const targetPrivateBucket = (targetNodeForCheck.privatePowerReveals && targetNodeForCheck.privatePowerReveals[myId]) ? Object.values(targetNodeForCheck.privatePowerReveals[myId]) : []
          const letterWasPrivatelyRevealedByTarget = (function() {
            try {
              for (const r of targetPrivateBucket) {
                if (!r || !r.result) continue
                const res = r.result
                const check = (s) => (s || '').toString().toLowerCase() === lowerB
                if (res.letterFromTarget && check(res.letterFromTarget)) return true
                if (res.letterFromBuyer && check(res.letterFromBuyer)) return true
                if (res.letter && check(res.letter)) return true
                if (res.last && check(res.last)) return true
                if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(lowerB)) return true
              }
            } catch (e) {}
            return false
          })()

          targetAward = (countB > 0 && !buyerExistingSet.has(lowerB) && !letterWasPrivatelyRevealedByTarget) ? 2 * countB : 0
        }

  // Build messages according to user's requested phrasing.
        // Buyer sees in opponent's div: either "letter for letter: revealed, + points" or "no points awarded since the letter is already revealed"
  let buyerMsg = null
        if (buyerLetter) {
          if (buyerAward > 0) buyerMsg = { message: `letter for letter: you revealed '${buyerLetter}', +${buyerAward} points`, letterFromTarget: buyerLetter }
          else buyerMsg = { message: `letter for letter: you revealed '${buyerLetter}', no points awarded since the letter is already revealed`, letterFromTarget: buyerLetter }
        }

        // Target-side effect message (what the buyer should see in the opponent's div)
        let targetMsg = null
        if (targetLetter) {
          const targetDisplay = playerIdToName[powerUpTarget] || powerUpTarget
          if (targetAward > 0) {
            targetMsg = {
              message: `letter for letter: ${targetDisplay} had letter '${targetLetter}' revealed; they earned +${targetAward} points`,
              letterFromBuyer: targetLetter
            }
          } else {
            targetMsg = {
              message: `letter for letter: ${targetDisplay} had letter '${targetLetter}' revealed; no points were awarded`,
              letterFromBuyer: targetLetter
            }
          }
        }

  // Buyer-facing summary: show the buyer which letter was revealed on them (if any)
  // and how many points the opponent earned. Fall back to the original buyerMsg if target info not present.
  let buyerResultForSelf = buyerMsg
  // Show buyer which letter they revealed on the opponent and how much they earned
  if (buyerLetter) {
    if (buyerAward > 0) {
      buyerResultForSelf = {
        message: `letter for letter: you revealed '${buyerLetter}' and earned +${buyerAward} points`,
        letterFromTarget: buyerLetter
      }
    } else {
      buyerResultForSelf = {
        message: `letter for letter: you revealed '${buyerLetter}', which was already revealed; no points were awarded`,
        letterFromTarget: buyerLetter
      }
    }
  }
  // base payloads for buyer/target privatePowerReveals entries
  const buyerBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  const targetBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  // include both the human-friendly message for the buyer and the raw private letter reveal so PlayerCircle can color it
  const buyerData = { ...buyerBase, result: { ...(buyerResultForSelf || {}), ...(buyerResultPayload || {}) } }
  updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData

  // Special-case: for letter_for_letter, write a clear, target-facing message so the target
  // sees exactly: "B used letter for letter on you to reveal letter x" as requested.
  try {
    if (powerId === 'letter_for_letter') {
      const letterDisplay = (buyerLetter || (resultPayload && (resultPayload.letter || resultPayload.last || (Array.isArray(resultPayload.letters) && resultPayload.letters[0])))) || ''
      const msg = `${playerIdToName[myId] || myId} used letter for letter on you to reveal letter ${letterDisplay}`
      updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: { message: msg, letterFromBuyer: letterDisplay } }
    }
  } catch (e) {}

  // Immediately apply buyer award here to ensure their wordmoney reflects the +2 per newly revealed occurrence
  if (buyerAward && buyerAward > 0) {
      const meNow = (state?.players || []).find(p => p.id === myId) || {}
      const myHangCurrentNow = Number(meNow.wordmoney) || 0
      const baseAfterCostNow = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined') ? updates[`players/${myId}/wordmoney`] : (myHangCurrentNow - cost)
      updates[`players/${myId}/wordmoney`] = Math.max(0, Number(baseAfterCostNow) + buyerAward)
      // merge into privateHits for buyer similar to other award flows
      try {
        const prevHitsNow = (meNow.privateHits && meNow.privateHits[powerUpTarget]) ? meNow.privateHits[powerUpTarget].slice() : []
        const letter = (buyerLetter || '').toLowerCase()
        if (letter) {
          let mergedNow = false
          const countInWord = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === letter).length
          for (let i = 0; i < prevHitsNow.length; i++) {
            const h = prevHitsNow[i]
            if (h && h.type === 'letter' && h.letter === letter) {
              prevHitsNow[i] = { ...h, count: (Number(h.count) || 0) + countInWord, ts: Date.now() }
              mergedNow = true
              break
            }
          }
          if (!mergedNow) prevHitsNow.push({ type: 'letter', letter, count: countInWord, ts: Date.now() })
        }
        updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHitsNow
      } catch (e) {}
      updates[`players/${myId}/lastGain`] = { amount: buyerAward, by: powerUpTarget, reason: powerId, ts: Date.now() }
      // mark that we've already applied the buyer award so generic reveal branches skip awarding again
      skipBuyerLetterAward = true
    }

  // (buyer-side message will be written below together with the target-side payload so we avoid overwriting buyer's
  // view of the opponent's div. See consolidated write later that includes letterFromBuyer for coloring.)
        // (removed writing a buyer-phrased message into the target's own privatePowerReveals)
        // Also store the side-effect message under the target's node keyed by buyer so the target will see
        // both: (A) a message in their own div saying they earned points, and (B) a message appearing in
        // the buyer's div on the target's screen describing that the target had a letter revealed.
        if (targetMsg || targetResultPayload) {
          // (B) Buyer div on target's screen: the target (viewer) should also see a message in the BUYER's tile
          // indicating the target had a letter revealed (actor is the target, and 'to' is the buyer id so it
          // renders inside the buyer's div when the target is viewing)
          const buyerDivKey = `${key}_buyer_${Date.now()}`
          const buyerDivMsg = (typeof targetAward === 'number' && targetAward > 0)
            ? { message: `letter for letter: ${playerIdToName[powerUpTarget] || powerUpTarget} had letter '${targetLetter}' revealed; they earned +${targetAward} points`, letterFromBuyer: targetLetter }
            : { message: `letter for letter: ${playerIdToName[powerUpTarget] || powerUpTarget} had letter '${targetLetter}' revealed; no points were awarded`, letterFromBuyer: targetLetter }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${buyerDivKey}`] = { powerId, ts: Date.now(), from: powerUpTarget, to: myId, result: { ...(buyerDivMsg || {}), ...(targetResultPayload || {}) } }

          // Also store the side-effect payload under the BUYER's own node so the buyer can see the summary
          // in their own view (unchanged behavior)
          const buyerSideKey2 = `pu_side_from_${powerUpTarget}_${Date.now()}_${myId}`
          const buyerSidePayload = { powerId, ts: Date.now(), from: powerUpTarget, to: myId, result: { ...(targetMsg || {}), ...(targetResultPayload || {}) } }
          updates[`players/${myId}/privatePowerReveals/${myId}/${buyerSideKey2}`] = buyerSidePayload

          // Instead of writing a personalized "you earned" message into the target's own div (which made the
          // target's tile show that sentence), write a tiny color-override private reveal entry so that
          // newly-public letters revealed by letter_for_letter render in the buyer's color on the target's own word.
          // Only do this when the buyer actually revealed a new letter (buyerAward > 0) — if the letter was
          // already revealed, keep the normal public/red rendering.
          try {
            if (buyerLetter && typeof buyerAward === 'number' && buyerAward > 0) {
              const colorKey = `pu_color_${Date.now()}_${myId}_${powerUpTarget}`
              updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${colorKey}`] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: { letterFromTarget: buyerLetter, overridePublicColor: true } }
            }
          } catch (e) {}
        }
        // if the target earned an award from the private reveal, add it to stagedTargetAwardDelta so it applies once
        try {
          if (typeof targetAward === 'number' && targetAward > 0) stagedTargetAwardDelta = (stagedTargetAwardDelta || 0) + targetAward
        } catch (e) {}
        // If any target awards were staged, apply them once to avoid multiple incremental writes
        try {
            if (typeof stagedTargetAwardDelta === 'number' && stagedTargetAwardDelta > 0) {
            const targetNodeStateFinal = (state?.players || []).find(p => p.id === powerUpTarget) || {}
            const prevTargetHangFinal = Number(targetNodeStateFinal.wordmoney) || 0
            const baseTargetFinal = (typeof updates[`players/${powerUpTarget}/wordmoney`] !== 'undefined') ? Number(updates[`players/${powerUpTarget}/wordmoney`]) : prevTargetHangFinal
            updates[`players/${powerUpTarget}/wordmoney`] = Math.max(0, Number(baseTargetFinal) + stagedTargetAwardDelta)
            // Explicitly mark this lastGain as a letter-for-letter award so clients can render a clear message
            updates[`players/${powerUpTarget}/lastGain`] = { amount: stagedTargetAwardDelta, by: myId, reason: 'letter_for_letter', ts: Date.now() }
          }
        } catch (e) {}
      } else {
        data.result = resultPayload
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = data
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = data
      }

      // Ensure buyer/target privatePowerReveals entries exist for this purchase so the
      // "Power-up results" UI always updates. Some branches write explicit buyer/target
      // entries (e.g. vowel_vision, letter_for_letter); for branches that didn't, write
      // a generic entry here without overwriting any explicit payloads.
      try {
        const buyerKey = `players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`
        const targetKey = `players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`
        if (!updates[buyerKey]) {
          updates[buyerKey] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: (resultPayload || {}) }
        }
        if (!updates[targetKey]) {
          // For the target's view prefer a short message if resultPayload is complex
          const targetResult = (resultPayload && typeof resultPayload === 'object') ? { ...(resultPayload || {}), message: (resultPayload && resultPayload.message) ? resultPayload.message : `${playerIdToName[myId] || myId} used ${powerId}` } : { message: (resultPayload || '') }
          updates[targetKey] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: targetResult }
        }
      } catch (e) {}

      // Additional explicit per-power handling for some self power-ups and effects
      try {
        if (powerId === 'crowd_hint') {
          // Reveal one random letter from everyone's word, mark as no-score, and notify buyer
          try {
            const picks = {}
            ;(state?.players || []).forEach(pp => {
              try {
                const w = (pp && pp.word) ? pp.word.toLowerCase().split('') : []
                if (w && w.length > 0) {
                  const ch = w[Math.floor(Math.random() * w.length)]
                  if (ch) {
                    const existing = pp.revealed || []
                    updates[`players/${pp.id}/revealed`] = Array.from(new Set([...(existing || []), ch]))
                    updates[`players/${pp.id}/noScoreReveals/${ch}`] = true
                    picks[pp.id] = picks[pp.id] || []
                    picks[pp.id].push(ch)
                  }
                }
              } catch (e) {}
            })
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const summary = Object.keys(picks).map(pid => `${playerIdToName[pid] || pid}: ${picks[pid].join(', ')}`).join('; ')
            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { message: `Crowd Hint: revealed ${summary || 'no letters'}`, picks } }
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { message: `${buyerName} used Crowd Hint` } }
          } catch (e) {}
        }

        if (powerId === 'longest_word_bonus') {
          try {
            const playersArr = (state?.players || [])
            let winner = null
            let best = -1
            playersArr.forEach(pp => { try { const l = (pp.word || '').toString().length || 0; if (l > best) { best = l; winner = pp.id } } catch (e) {} })
            const amount = 10
            if (winner) {
              const prev = (state?.players || []).find(p => p.id === winner) || {}
              const prevHang = Number(prev.wordmoney) || 0
              const baseNow = (typeof updates[`players/${winner}/wordmoney`] !== 'undefined') ? Number(updates[`players/${winner}/wordmoney`]) : prevHang
              updates[`players/${winner}/wordmoney`] = Math.max(0, Number(baseNow) + amount)
              updates[`players/${winner}/lastGain`] = { amount, by: myId, reason: powerId, ts: Date.now() }
            }
            updates[`usedLongestWordBonus/${myId}`] = true
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { winner, amount, message: `Longest Word Bonus: ${playerIdToName[winner] || winner} received +${amount}` } }
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { winner, amount, message: `${buyerName} used Longest Word Bonus` } }
          } catch (e) {}
        }

        if (powerId === 'word_freeze') {
          try {
            // Word Freeze is a self-targeted power-up: ensure it freezes the buyer's own word
            const expires = (typeof state.currentTurnIndex === 'number') ? state.currentTurnIndex + 1 : null
            const freezeTarget = myId
            updates[`players/${freezeTarget}/frozen`] = true
            updates[`players/${freezeTarget}/frozenUntilTurnIndex`] = expires
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: freezeTarget }
            const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: freezeTarget }
            // Inform the buyer that their word is frozen and add a message for the buyer's own private reveals
            updates[`players/${myId}/privatePowerReveals/${freezeTarget}/${key}`] = { ...buyerBaseLocal, result: { message: `Word Freeze: your word is frozen for one round` } }
            // Also add an entry under the frozen player's privatePowerReveals for consistency (buyer = target here)
            updates[`players/${freezeTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { message: `${buyerName} used Word Freeze` } }
          } catch (e) {}
        }
        if (powerId === 'price_surge') {
          try {
            // Represent the surge as an entry keyed by the buyer so it globally affects everyone except the buyer.
            // The surge will be cleared when the buyer's turn begins (turn-advance logic clears priceSurge/{playerId}).
            try {
              const expiresAt = null
              updates[`priceSurge/${myId}`] = { amount: 2, by: myId, expiresAtTurnIndex: expiresAt }
            } catch (e) {}
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: null }
            updates[`players/${myId}/privatePowerReveals/${myId}/${key}`] = { ...buyerBaseLocal, result: { message: `Price Surge: everyone else's shop prices increased by +2 until your next turn` } }
          } catch (e) {}
        }
        // Rare Trace: tell buyer how many occurrences of very-rare letters exist in the target's word
        if (powerId === 'rare_trace') {
          try {
            const rareLetters = ['q','x','z','j','k','v']
            const wordLower = (targetWord || '').toLowerCase()
            let count = 0
            for (let i = 0; i < (wordLower || '').length; i++) {
              try { if (rareLetters.includes(wordLower[i])) count++ } catch (e) {}
            }
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { message: `Rare Trace: there are ${count} occurrence${count === 1 ? '' : 's'} of Q,X,Z,J,K,or V`, count } }
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { message: `Rare Trace was used on you by ${playerIdToName[myId] || myId}` } }
          } catch (e) {}
        }
      } catch (e) {}

      // For some reveal types we should also update the target's revealed array so letters are visible to both
      if (resultPayload && resultPayload.letters && Array.isArray(resultPayload.letters)) {
        // add those letters to target's revealed set
        const existing = targetNode.revealed || []
        const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
        const toAdd = resultPayload.letters.map(ch => (ch || '').toLowerCase()).filter(Boolean)
        const newRevealed = Array.from(new Set([...(existing || []), ...toAdd]))
        updates[`players/${powerUpTarget}/revealed`] = newRevealed

        // Award points to the buyer for newly revealed letters (2 wordmoney per newly revealed occurrence)
        try {
          const me = (state?.players || []).find(p => p.id === myId) || {}
          const myHangCurrent = Number(me.wordmoney) || 0
          // base wordmoney after paying cost was set earlier; compute fresh base here in case
          const baseAfterCost = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined')
            ? updates[`players/${myId}/wordmoney`]
            : (myHangCurrent - cost)

          let awardTotal = 0
          const prevHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget].slice() : []
          // Build a quick set of letters the buyer already has privately for this target
          const prevHitsSet = new Set((prevHits || []).filter(h => h && h.type === 'letter').map(h => (h.letter || '').toString().toLowerCase()))
          toAdd.forEach(letter => {
            try {
              // Skip any letters already publicly revealed
              if (existingSet.has(letter)) return
              // Also skip awarding if buyer already privately has this letter for the same target
              if (prevHitsSet.has(letter)) return
              // reveal all occurrences of this letter in the target's word and award for each
              const countInWord = (targetWord.toLowerCase().match(new RegExp(letter, 'g')) || []).length
              if (countInWord > 0) {
                awardTotal += 2 * countInWord
                // merge into privateHits for buyer
                let merged = false
                for (let i = 0; i < prevHits.length; i++) {
                  const h = prevHits[i]
                  if (h && h.type === 'letter' && String(h.letter).toLowerCase() === letter) {
                    prevHits[i] = { ...h, count: (Number(h.count) || 0) + countInWord, ts: Date.now() }
                    merged = true
                    break
                  }
                }
                if (!merged) prevHits.push({ type: 'letter', letter, count: countInWord, ts: Date.now() })
              }
            } catch (e) {}
          })

          if (awardTotal > 0) {
            updates[`players/${myId}/wordmoney`] = Math.max(0, Number(baseAfterCost) + awardTotal)
            updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
            // record a small visible gain on buyer so UI toasts show the award
            updates[`players/${myId}/lastGain`] = { amount: awardTotal, by: powerUpTarget, reason: powerId, ts: Date.now() }
          }
        } catch (e) {}
      }

  // For zeta_drop, letter_peek, one_random, all_letter_reveal, full_reveal we may want to reveal to target.revealed
      if (resultPayload && resultPayload.last) {
        const existing = targetNode.revealed || []
        const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
        const add = (resultPayload.last || '').toLowerCase()
        if (add) {
          updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existing || []), add]))
          // Award buyer points for newly revealed occurrences of the letter (2 per occurrence)
          try {
            if (!existingSet.has(add)) {
              const count = (targetWord || '').split('').filter(ch => ch.toLowerCase() === add).length
              if (count > 0) {
                const me = (state?.players || []).find(p => p.id === myId) || {}
                // Determine whether the buyer already received this letter privately earlier
                const buyerPrivateReveals = (me.privatePowerReveals && me.privatePowerReveals[powerUpTarget]) ? Object.values(me.privatePowerReveals[powerUpTarget]) : []
                const buyerPrivateHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget] : []
                let wasPrivatelyRevealedByBuyer = false
                try {
                  for (const r of buyerPrivateReveals) {
                    if (!r || !r.result) continue
                    const res = r.result || {}
                    const check = (s) => (s || '').toString().toLowerCase() === add
                    if (res.letterFromTarget && check(res.letterFromTarget)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.letterFromBuyer && check(res.letterFromBuyer)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.letter && check(res.letter)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.last && check(res.last)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(add)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.found && Array.isArray(res.found) && res.found.map(x => (x && x.letter || '').toString().toLowerCase()).includes(add)) { wasPrivatelyRevealedByBuyer = true; break }
                  }
                } catch (e) {}
                try {
                  if (!wasPrivatelyRevealedByBuyer && Array.isArray(buyerPrivateHits)) {
                    for (const h of buyerPrivateHits) {
                      if (!h) continue
                      if (h.type === 'letter' && ((h.letter || '').toString().toLowerCase() === add)) { wasPrivatelyRevealedByBuyer = true; break }
                    }
                  }
                } catch (e) {}

                // Only award buyer if it wasn't already revealed publicly or privately by them
                if (!wasPrivatelyRevealedByBuyer) {
                  const myHangCurrent = Number(me.wordmoney) || 0
                  const baseAfterCost = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined')
                    ? updates[`players/${myId}/wordmoney`]
                    : (myHangCurrent - cost)
                  const award = 2 * count
                  updates[`players/${myId}/wordmoney`] = Math.max(0, Number(baseAfterCost) + award)
                  const prevHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget].slice() : []
                  let merged = false
                  for (let i = 0; i < prevHits.length; i++) {
                    const h = prevHits[i]
                    if (h && h.type === 'letter' && h.letter === add) {
                      prevHits[i] = { ...h, count: (Number(h.count) || 0) + count, ts: Date.now() }
                      merged = true
                      break
                    }
                  }
                  if (!merged) prevHits.push({ type: 'letter', letter: add, count, ts: Date.now() })
                  updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
                  // zeta_drop special-case: if only one occurrence, still mark no-score per rules
                  if (powerId === 'zeta_drop') {
                    if (count === 1) updates[`players/${powerUpTarget}/noScoreReveals/${add}`] = true
                  }
                  // mark visible gain
                  updates[`players/${myId}/lastGain`] = { amount: 2 * count, by: powerUpTarget, reason: powerId, ts: Date.now() }
                }
              }
            }
          } catch (e) {}
        }
      }
      // handle single-letter payloads (one_random, letter_peek, letter_for_letter) where resultPayload.letter is set
      if (resultPayload && resultPayload.letter) {
        try {
          const add = (resultPayload.letter || '').toLowerCase()
          if (add) {
            const existing = Array.isArray(targetNode.revealed) ? targetNode.revealed.slice() : []
            // count how many of this letter are already in revealed (keeps duplicates)
            const existingCount = existing.filter(x => (x || '').toLowerCase() === add).length
            // total occurrences in the target word
            const totalCount = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === add).length
            // number of new occurrences to add to revealed array
            const toAdd = Math.max(0, totalCount - existingCount)
            if (toAdd > 0) {
              // append the letter to the revealed array for each newly discovered occurrence
              for (let i = 0; i < toAdd; i++) existing.push(add)
              updates[`players/${powerUpTarget}/revealed`] = existing

              // Award buyer for newly revealed occurrences (2 per occurrence)
              try {
                const me = (state?.players || []).find(p => p.id === myId) || {}
                const myHangCurrent = Number(me.wordmoney) || 0
                const baseAfterCost = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined') ? updates[`players/${myId}/wordmoney`] : (myHangCurrent - cost)
                // Determine if buyer already has this letter recorded for this target.
                const prevHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget].slice() : []
                const alreadyHasLetter = prevHits.some(h => h && h.type === 'letter' && String(h.letter).toLowerCase() === add)
                // Per rule: if this purchase is letter_peek and the buyer already has this letter in privateHits
                // for the target, do not award points (but still apply the revealed change to the target).
                const award = (powerId === 'letter_peek' && alreadyHasLetter) ? 0 : 2 * toAdd
                if (award > 0) {
                  updates[`players/${myId}/wordmoney`] = Math.max(0, Number(baseAfterCost) + award)
                  let merged = false
                  for (let i = 0; i < prevHits.length; i++) {
                    const h = prevHits[i]
                    if (h && h.type === 'letter' && String(h.letter).toLowerCase() === add) {
                      prevHits[i] = { ...h, count: (Number(h.count) || 0) + toAdd, ts: Date.now() }
                      merged = true
                      break
                    }
                  }
                  if (!merged) prevHits.push({ type: 'letter', letter: add, count: toAdd, ts: Date.now() })
                  updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
                  updates[`players/${myId}/lastGain`] = { amount: award, by: powerUpTarget, reason: powerId, ts: Date.now() }
                  // remember award so we can include it in the buyer/target privatePowerReveals message
                  if (powerId === 'one_random') oneRandomAward = award
                }
              } catch (e) {}
            } else {
              // nothing new to reveal; still ensure revealed array is set (no-op)
              updates[`players/${powerUpTarget}/revealed`] = existing
            }
          }
        } catch (e) {}
      }

      // If this was a one_random reveal, ensure the privatePowerReveals entries include
      // a human-readable message that indicates what letter was revealed and whether
      // the buyer earned points. Overwrite the earlier generic payload with an enriched
      // one so PlayerCircle shows a friendly sentence (and buyer sees the amount).
      if (powerId === 'one_random') {
        try {
          const ch = (resultPayload && resultPayload.letter) ? String(resultPayload.letter) : null
          const letterDisplay = ch ? String(ch).slice(0,1) : null
          const base = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          let buyerMsg = null
          if (letterDisplay) {
            if (oneRandomAward && oneRandomAward > 0) {
              buyerMsg = { message: `One Random Letter: revealed '${letterDisplay}' — you earned +${oneRandomAward}`, letter }
            } else {
              buyerMsg = { message: `One Random Letter: revealed '${letterDisplay}', no points awarded (already revealed)`, letter }
            }
          } else {
            buyerMsg = { message: `One Random Letter: no letter could be revealed`, letter: null }
          }
          const buyerData = { ...base, result: { ...(resultPayload || {}), ...(buyerMsg || {}) } }
          const targetData = { ...base, result: { ...(resultPayload || {}), message: `One Random Letter was used on you by ${playerIdToName[myId] || myId}` } }
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
        } catch (e) {}
      }

      // handle full reveal (full word) awarding buyer for all unique letters occurrences
      if (resultPayload && resultPayload.full) {
        try {
          const full = (resultPayload.full || '').toLowerCase()
          if (full) {
            // reveal all letters (already set on updates earlier)
            // award buyer for every letter occurrence in the target's word
            const letters = full.split('')
            let total = 0
            const counts = {}
            letters.forEach(ch => { if (ch) counts[ch] = (counts[ch] || 0) + 1 })
            Object.keys(counts).forEach(l => { total += 2 * counts[l] })
              if (total > 0) {
              const me = (state?.players || []).find(p => p.id === myId) || {}
              const myHangCurrent = Number(me.wordmoney) || 0
              const baseAfterCost = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined') ? updates[`players/${myId}/wordmoney`] : (myHangCurrent - cost)
              updates[`players/${myId}/wordmoney`] = Math.max(0, Number(baseAfterCost) + total)
              updates[`players/${myId}/lastGain`] = { amount: total, by: powerUpTarget, reason: powerId, ts: Date.now() }
              // record aggregated privateHits for buyer
              const mePrev = (state?.players || []).find(p => p.id === myId) || {}
              const prevHits = (mePrev.privateHits && mePrev.privateHits[powerUpTarget]) ? mePrev.privateHits[powerUpTarget].slice() : []
              Object.keys(counts).forEach(l => {
                prevHits.push({ type: 'letter', letter: l, count: counts[l], ts: Date.now() })
              })
              updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
            }
          }
        } catch (e) {}
      }

      // Also advance the turn immediately after a power-up is applied (end the buyer's turn)
      // Exception: when the buyer purchases 'double_down' we intentionally DO NOT advance the turn
      // so the buyer can make their guess while the doubleDown is active.
      try {
        if (powerId !== 'double_down') {
          // determine effective turn order (prefer any turnOrder we already modified)
          const effectiveTurnOrder = updates.hasOwnProperty('turnOrder') ? updates['turnOrder'] : (state.turnOrder || [])
          const currentIndexLocal = typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex : 0
          if (effectiveTurnOrder && effectiveTurnOrder.length > 0) {
            const nextIndex = (currentIndexLocal + 1) % effectiveTurnOrder.length
            updates[`currentTurnIndex`] = nextIndex
            updates[`currentTurnStartedAt`] = Date.now()
            try {
              const nextPlayer = effectiveTurnOrder[nextIndex]
              const nextNode = (state.players || []).find(p => p.id === nextPlayer) || {}
              const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : 0
              // If a previous staged update already adjusted this player's wordmoney (e.g. from a power-up), add to it
              const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
              updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
              // clear any frozen flags when their turn begins
              updates[`players/${nextPlayer}/frozen`] = null
              updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
              // clear any per-player price surge authored by the player whose turn is beginning
              updates[`priceSurge/${nextPlayer}`] = null
              // Add a lastGain entry to indicate the +1 starter award (clients will show this in tooltip)
              try {
                // only add when starter bonus is enabled in room state
                if (state && state.starterBonus && state.starterBonus.enabled) {
                  updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
                }
              } catch (e) {}
            } catch (e) {}
          }
        }
      } catch (e) {}

      // Finally perform the update
      // (debug logging removed)
      await dbUpdate(roomRef, updates)
      try {
    // debug toast removed
        // Persist any lastGain updates to localStorage so the UI tooltip can show immediately for affected players
        try {
          Object.keys(updates || {}).forEach(k => {
            const m = k.match(/^players\/([^/]+)\/lastGain$/)
            if (m) {
              const pid = m[1]
              try {
                  const lg = updates[k]
                if (lg && typeof lg.ts !== 'undefined') {
                  // Avoid persisting a local history entry for letter-for-letter here because
                  // the DB write will arrive and PlayerCircle will also add the same entry,
                  // producing a duplicate visible line in the wordmoney tooltip.
                  if ((lg.reason === 'letter_for_letter' || lg.reason === 'letter-for-letter')) return
                  // write a small array entry for tooltip fallback
                  const key = `gh_hang_history_${pid}`
                  const existing = (function() { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null } catch (e) { return null } })()
                  const reasonMap = (r) => {
                    const s = (r || '').toString()
                    if (s === 'powerupReveal') return 'from power-up reveal'
                    if (s === 'letter_for_letter' || s === 'letter-for-letter') return 'from letter-for-letter'
                    if (s === 'startTurn' || s === 'turnStart' || s === 'startBonus') return 'from start of turn'
                    if (s === 'wrongGuess' || s === 'correctGuess') return 'from guessing'
                    return s || 'Adjustment'
                  }
                  const entry = { ts: Number(lg.ts || Date.now()), delta: Number(lg.amount || 0), reason: reasonMap(lg.reason), prev: null }
                  const next = [entry].concat(existing || []).slice(0,3)
                  try { localStorage.setItem(key, JSON.stringify(next)) } catch (e) {}
                  try {
                    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                      try { window.dispatchEvent(new CustomEvent('gh_hang_history_update', { detail: { playerId: pid, entry } })) } catch (e) {}
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
          })
        } catch (e) {}
      } catch (e) {}
      // add a dismissible success toast for power-up application
      const pupToastId = `pup_ok_${Date.now()}`
      // For longest_word_bonus, show the winner's display name; otherwise show the target
      const pupText = (powerId === 'longest_word_bonus' && resultPayload && resultPayload.winner)
        ? `${pu.name}: ${playerIdToName[resultPayload.winner] || resultPayload.winner} +${resultPayload.amount}`
        : `${pu.name} applied to ${playerIdToName[powerUpTarget] || powerUpTarget}`
      setToasts(t => [...t, { id: pupToastId, text: pupText }])
      if (powerId === 'double_down') {
        // remind the buyer they can still guess while the double-down is active
        const tipId = `pup_tip_double_${Date.now()}`
        // remove any existing double-down tips first to avoid duplicates
        setToasts(t => (t || []).filter(x => !(x && typeof x.text === 'string' && x.text.startsWith && x.text.startsWith('Double Down active'))))
        // add the new tip
        setToasts(t => [...t, { id: tipId, text: `Double Down active — make a guess now to earn your stake per occurrence.` }])
        // auto-hide the tip after the same interval as other toasts (fade then remove)
        setTimeout(() => setToasts(t => t.map(x => x.id === tipId ? { ...x, removing: true } : x)), 3200)
        setTimeout(() => setToasts(t => t.filter(x => x.id !== tipId)), 4200)
        // lock the shop UI for this viewer until they make their guess
        try { setDdShopLocked(true) } catch (e) {}
      }
      // schedule fade + removal after a short interval
      setTimeout(() => {
        setToasts(t => t.map(x => x.id === pupToastId ? { ...x, removing: true } : x))
      }, 3200)
      setTimeout(() => {
        setToasts(t => t.filter(x => x.id !== pupToastId))
      }, 4200)
      setPowerUpOpen(false)
    } catch (e) {
      console.error('Power-up purchase failed', e)
      setToasts(t => [...t, { id: `pup_err_${Date.now()}`, text: 'Could not perform power-up. Try again.' }])
    } finally {
      setPowerUpLoading(false)
    }
  }

  // Keep the letter_peek input focused while the power-up modal is open so typing isn't interrupted
  const prevPowerUpOpenRef = useRef(false)
  useEffect(() => {
    // only autofocus when the modal transitions from closed -> open to avoid repeated scroll resets
    if (!powerUpOpen || prevPowerUpOpenRef.current) {
      prevPowerUpOpenRef.current = powerUpOpen
      return
    }
    prevPowerUpOpenRef.current = true
    // small next-tick focus to ensure the input exists in the DOM
    const t = setTimeout(() => {
      try {
        const el = powerUpChoiceRef.current
        if (el && typeof el.focus === 'function') {
          // prefer preventing scroll when focusing so modal doesn't jump
          // Only call focus once and prefer the options object when supported.
          try {
            el.focus({ preventScroll: true })
          } catch (e) {
            // If options not supported, attempt to set selection without calling focus again
            try {
              const len = (el.value || '').length
              if (typeof el.setSelectionRange === 'function') el.setSelectionRange(len, len)
            } catch (ee) {}
          }
          // move caret to end where possible (no extra focus call)
          try {
            const len = (el.value || '').length
            if (typeof el.setSelectionRange === 'function') el.setSelectionRange(len, len)
          } catch (e) {}
        }
      } catch (e) {}
    }, 0)
    return () => clearTimeout(t)
  }, [powerUpOpen])

  // Preserve the scroll position of the power-up list while the modal is open.
  // Some room state updates re-render the list and can reset scrollTop; remember
  // the scrollTop on user scroll and restore it when the modal remains open.
  useEffect(() => {
    const el = powerupListRef.current
    if (!el) return () => {}
    const onScroll = () => {
      try { powerupScrollRef.current = el.scrollTop } catch (e) {}
    }
    try { el.addEventListener('scroll', onScroll, { passive: true }) } catch (e) { el.onscroll = onScroll }
    // when the modal opens, restore previous scroll position (next tick)
    if (powerUpOpen) {
      const t = setTimeout(() => {
        try { if (typeof powerupScrollRef.current === 'number') el.scrollTop = powerupScrollRef.current } catch (e) {}
      }, 0)
      return () => {
        clearTimeout(t)
        try { el.removeEventListener && el.removeEventListener('scroll', onScroll) } catch (e) { el.onscroll = null }
      }
    }
    return () => { try { el.removeEventListener && el.removeEventListener('scroll', onScroll) } catch (e) { el.onscroll = null } }
  }, [powerUpOpen])

  // Ensure scrollTop is restored immediately after any state changes while the modal
  // remains open. Using useLayoutEffect prevents a visible jump by restoring before
  // the browser paints the updated DOM.
  useLayoutEffect(() => {
    if (!powerUpOpen) return
    const el = powerupListRef.current
    if (!el) return
    try {
      const v = Number(powerupScrollRef.current) || 0
      // apply immediately
      try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
      // reapply across a couple animation frames and a short timeout to handle
      // later style/transition-driven layout changes that may reset scrollTop.
      try {
        let raf1 = null, raf2 = null, to = null
        raf1 = requestAnimationFrame(() => {
          try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
          raf2 = requestAnimationFrame(() => {
            try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
            to = setTimeout(() => { try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {} }, 50)
          })
        })
        return () => { try { if (raf1) cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); if (to) clearTimeout(to) } catch (e) {} }
      } catch (e) {}
    } catch (e) {}
  }, [state, powerUpOpen])

  // When the power-up modal is open, add a body-level class to pause site animations
  useEffect(() => {
    try {
      if (powerUpOpen) document.body.classList.add('modal-open')
      else document.body.classList.remove('modal-open')
      // prevent background scrolling while modal is open so modal scrolling is smooth
      try { document.body.style.overflow = powerUpOpen ? 'hidden' : '' } catch (e) {}
    } catch (e) {}
    return () => { try { document.body.classList.remove('modal-open') } catch (e) {} }
  }, [powerUpOpen])

  function PowerUpModal({ open, targetId, onClose }) {
    if (!open || !targetId) return null
    const targetName = playerIdToName[targetId] || targetId
  const me = (state?.players || []).find(p => p.id === myId) || {}
    const myHang = Number(me.wordmoney) || 0
  const isLobby = phase === 'lobby'
    return (
      <div className={`modal-overlay shop-modal ${powerUpOpen ? 'open' : 'closed'}`} role="dialog" aria-modal="true">
        <div className="modal-dialog card no-anim shop-modal-dialog shop-modal-dialog">
          <div className="shop-modal-header">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <strong>Power-ups for {targetName}</strong>
              <small>Use these to influence the round</small>
            </div>
            <button className="shop-modal-close" onClick={onClose}>✖</button>
          </div>
          <div className="powerup-list" ref={powerupListRef}>
            {(POWER_UPS || []).map(p => {
              // compute effective price for display (show surge applied if it affects buyer)
              let displayPrice = p.price
              try {
                // compute sum of active surges (skip any surge authored by viewer)
                let totalSurgeAmount = 0
                const ps = state && state.priceSurge
                if (ps && typeof ps === 'object') {
                  if (typeof ps.amount !== 'undefined' && (typeof ps.by !== 'undefined' || typeof ps.expiresAtTurnIndex !== 'undefined')) {
                    const surge = ps
                    if (surge && surge.amount && surge.by !== myId) {
                      const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
                      const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
                      if (active) totalSurgeAmount += Number(surge.amount || 0)
                    }
                  } else {
                    Object.keys(ps || {}).forEach(k => {
                      try {
                        const entry = ps[k]
                        if (!entry || !entry.amount) return
                        if (entry.by === myId) return
                        const expires = typeof entry.expiresAtTurnIndex === 'number' ? entry.expiresAtTurnIndex : null
                        const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
                        if (active) totalSurgeAmount += Number(entry.amount || 0)
                      } catch (e) {}
                    })
                  }
                }
                if (totalSurgeAmount) displayPrice = p.price + totalSurgeAmount
              } catch (e) { }

              // compute a visual style/class to distinguish power-up types
              const isSelfType = p.powerupType === 'selfPowerup'
              const isSingleOpponent = p.powerupType === 'singleOpponentPowerup'
              const rowClass = `powerup-row ${isSelfType ? 'powerup-type-self' : isSingleOpponent ? 'powerup-type-opponent' : ''} ${(isSelfType && powerUpTarget === myId) ? 'self-powerup' : ''}`
              const rowStyle = isSelfType ? { background: '#fff9e6', border: '1px solid rgba(204,170,60,0.12)' } : (isSingleOpponent ? { background: '#f0f7ff', border: '1px solid rgba(30,120,220,0.08)' } : {})
                      return (
                <div key={p.id} className={rowClass} style={rowStyle}>
                  <div className="powerup-meta">
                    <div className="title">{p.name} <small className="desc">{p.desc}</small></div>
                    <div className="powerup-price">{displayPrice} 🪙{displayPrice !== p.price ? <small className="surge">(+ surge)</small> : null}</div>
                  </div>
                  <div className="powerup-actions">
                        {p.id === 'letter_peek' ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input className="powerup-input" ref={powerUpChoiceRef} id={`powerup_${p.id}_choice`} name={`powerup_${p.id}_choice`} placeholder="position" value={powerUpChoiceValue} onChange={e => setPowerUpChoiceValue(e.target.value)} disabled={isLobby || state?.phase === 'wordspy_playing'} />
                        {/* stable button width and no transition to avoid layout shift when label changes */}
                        <button className="powerup-buy" disabled={isLobby || powerUpLoading || myHang < displayPrice || state?.phase === 'wordspy_playing'} onClick={() => purchasePowerUp(p.id, { pos: powerUpChoiceValue })}>{powerUpLoading ? '...' : 'Buy'}</button>
                      </div>
                    ) : p.id === 'double_down' ? (
                      (() => {
                        // Double Down should use the stake input, not the letter_peek choice
                        const stakeVal = (powerUpStakeValue || '').toString().trim()
                        const stakeNum = Number(stakeVal)
                        const stakeInvalid = !stakeVal || Number.isNaN(stakeNum) || stakeNum <= 0
                        // Max stake is your current wordmoney - 1 (you may stake up to your current balance minus the base price)
                        const maxStake = (Number(me.wordmoney) || 0) - 1
                        const stakeTooLarge = !stakeInvalid && stakeNum > maxStake
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <input className="powerup-input" id={`powerup_${p.id}_stake`} name={`powerup_${p.id}_stake`} placeholder="stake" value={powerUpStakeValue} onChange={e => setPowerUpStakeValue(e.target.value)} disabled={isLobby || state?.phase === 'wordspy_playing'} />
                              <button className="powerup-buy" disabled={isLobby || powerUpLoading || myHang < displayPrice || stakeInvalid || stakeTooLarge || state?.phase === 'wordspy_playing'} onClick={() => purchasePowerUp(p.id, { stake: powerUpStakeValue })}>{powerUpLoading ? '...' : 'Buy'}</button>
                            </div>
                            {stakeInvalid && (
                              <div style={{ color: '#900', fontSize: 12 }}>Please enter a valid stake greater than 0</div>
                            )}
                            {stakeTooLarge && (
                              <div style={{ color: '#900', fontSize: 12, maxWidth: 220, wordBreak: 'break-word', whiteSpace: 'normal' }}>
                                Stake cannot exceed ${maxStake} (your current wordmoney - 1 (cost of this power up))
                              </div>
                            )}
                          </div>
                        )
                      })()
                      ) : (
                      <button className="powerup-buy" disabled={isLobby || powerUpLoading || myHang < displayPrice} onClick={() => purchasePowerUp(p.id)}>{powerUpLoading ? '...' : 'Buy'}</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

// inject small styling for power-up types if not present
try {
  const styleId = 'gh-powerup-type-style'
  if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    const s = document.createElement('style')
    s.id = styleId
    s.innerHTML = `
      .powerup-row { padding: 10px; border-radius: 8px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center }
      .powerup-type-self { background: #fff9e6; border: 1px solid rgba(204,170,60,0.12) }
      .powerup-type-opponent { background: #f0f7ff; border: 1px solid rgba(30,120,220,0.08) }
      .powerup-row .title { font-weight: 700 }
      .powerup-row.self-powerup { box-shadow: 0 2px 8px rgba(0,0,0,0.03) }
    `
    document.head.appendChild(s)
  }
} catch (e) {}

  

  // Component: host-only Play Again / Restart controls
  function PlayAgainControls({ isHost, myId, players }) {
    const [submitting, setSubmitting] = useState(false)

    // Only the host should see these controls
    if (!isHost) return null
    // Host-only restart: reset per-player words, wordmoney, submission flags, clear wantsRematch, and set phase to 'waiting'
    async function restartForAll() {
      if (!isHost) return
      try {
        setSubmitting(true)
        setIsResetting(true)

  const updates = { phase: 'lobby', open: true, turnOrder: [], currentTurnIndex: null, currentTurnStartedAt: null }
  // clear winner state when restarting so the victory screen doesn't persist
  updates['winnerId'] = null
  // determine starting wordmoney to apply for resets — prefer room setting, fallback to 2
  const resetStart = (state && typeof state.startingWordmoney !== 'undefined' && !Number.isNaN(Number(state.startingWordmoney))) ? Number(state.startingWordmoney) : 2
    ;(players || []).forEach(p => {
          updates[`players/${p.id}/wantsRematch`] = null
          updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          updates[`players/${p.id}/eliminatedAt`] = null
          updates[`players/${p.id}/eliminatedAt`] = null
          // apply configured starting wordmoney
          updates[`players/${p.id}/wordmoney`] = resetStart
          // allow starter bonus to be re-awarded after a restart
          updates[`players/${p.id}/starterBonusAwarded`] = null
          // Clear viewer-specific guess tracking so old guesses don't persist
          updates[`players/${p.id}/privateHits`] = null
          updates[`players/${p.id}/privateWrong`] = null
          updates[`players/${p.id}/privateWrongWords`] = null
          // Clear any power-up results and markers (private reveals, tracked powerups, and no-score flags)
          updates[`players/${p.id}/privatePowerReveals`] = null
          updates[`players/${p.id}/privatePowerUps`] = null
          updates[`players/${p.id}/noScoreReveals`] = null
        })

  const ok = await attemptReset(updates)
        if (ok) {
          const idOk = `rematch_host_ok_${Date.now()}`
          setToasts(t => [...t, { id: idOk, text: 'Room restarted — waiting for players to rejoin.' }])
          // auto-dismiss: fade then remove after short delay
          setTimeout(() => { setToasts(t => t.map(x => x.id === idOk ? { ...x, removing: true } : x)) }, 3200)
          setTimeout(() => { setToasts(t => t.filter(x => x.id !== idOk)) }, 4200)
        } else {
          const idErr = `rematch_host_err_${Date.now()}`
          setToasts(t => [...t, { id: idErr, text: 'Could not restart room for all players. Check console for details.' }])
          setTimeout(() => { setToasts(t => t.map(x => x.id === idErr ? { ...x, removing: true } : x)) }, 4200)
          setTimeout(() => { setToasts(t => t.filter(x => x.id !== idErr)) }, 5200)
        }
      } catch (e) {
        console.error('Host restart failed', e)
        setToasts(t => [...t, { id: `rematch_host_err_${Date.now()}`, text: 'Could not restart room for all players. Check console for details.' }])
      } finally {
        setSubmitting(false)
        setIsResetting(false)
      }
    }
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={restartForAll} disabled={submitting || isResetting}>{submitting || isResetting ? 'Restarting…' : 'Play again (restart)'} </button>
        <div style={{ fontSize: 13 }}>{players.length} players</div>
      </div>
    )
  }

  // Clear forcedLobbyView if the room phase moves away from 'ended' (i.e., next game started)
  useEffect(() => {
    if (state?.phase && state.phase !== 'ended' && forcedLobbyView) {
      setForcedLobbyView(false)
    }
  }, [state?.phase])

  // If we're the host and everyone has opted into rematch (wantsRematch=true), perform a room reset.
  const resetAttemptRef = useRef(0)
  useEffect(() => {
    if (!state) return
    if (!isHost) return
    if (state.phase !== 'ended') return
    const playersArr = state.players || []
    if (playersArr.length === 0) return
    const allReady = playersArr.every(p => !!p.wantsRematch)
    if (!allReady) return
    // debounce: avoid running multiple times within a short window
    const now = Date.now()
    if (now - (resetAttemptRef.current || 0) < 3000) return
    resetAttemptRef.current = now
    ;(async () => {
      try {
        setIsResetting(true)
        // Build a multi-path update: reset room phase and clear per-player wantsRematch and submissions
  const startMoney = (state && typeof state.startingWordmoney !== 'undefined' && !Number.isNaN(Number(state.startingWordmoney))) ? Number(state.startingWordmoney) : 2
  const updates = { phase: 'lobby', open: true, turnOrder: [], currentTurnIndex: null, currentTurnStartedAt: null }
  // ensure winnerId is cleared when performing an automatic rematch reset
  updates['winnerId'] = null
        playersArr.forEach(p => {
          updates[`players/${p.id}/wantsRematch`] = null
          updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          updates[`players/${p.id}/wordmoney`] = startMoney
          // allow starter bonus to be re-awarded on automatic rematch resets
          updates[`players/${p.id}/starterBonusAwarded`] = null
          // Clear power-up state as part of rematch reset so old results don't persist
          updates[`players/${p.id}/privatePowerReveals`] = null
          updates[`players/${p.id}/privatePowerUps`] = null
          updates[`players/${p.id}/noScoreReveals`] = null
        })
        const ok = await attemptReset(updates)
        if (!ok) console.warn('Host reset attempted but failed; players may still be opted in')
      } catch (e) {
        console.error('Host attempted rematch reset failed', e)
      } finally {
        setIsResetting(false)
      }
    })()
  }, [state?.phase, state?.players, isHost])

  async function isEnglishWord(w) {
    console.log('isEnglishWord check for word:', w)
    const candidate = (w || '').toString().trim().toLowerCase()
    if (!/^[a-z]+$/.test(candidate)) return false


    let dictDown = false
    let datamuseDown = false
    let freeDictDown = false

    try {
      // === FreeDictionary API ===
    const response = await fetch(
      `https://freedictionaryapi.com/api/v1/entries/en/${word}?translations=true&pretty=true`
    );
    console.log('FreeDictionaryAPI response status:', response.status);

    if (!response.ok && response.status !== 404) {
      freeDictDown = true
    }

    const data = await response.json();
    console.log('FreeDictionaryAPI response data:', data);

    // Check if we got a valid entry with definitions
    const isValid = data.entries.length > 0;

      if (isValid) {
        // word found
        return true;
      }

      // === Datamuse fallback ===
      try {
        console.log('Checking Datamuse for word:', candidate);
        const dm = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(candidate)}&max=1`)
        if (dm.ok) {
          const ddata = await dm.json()
          if (
            Array.isArray(ddata) &&
            ddata.length > 0 &&
            ddata[0].word &&
            ddata[0].word.toLowerCase() === candidate
          ) {
            return true
          }
        } else if (dm.status !== 404) {
          datamuseDown = true
          console.warn('Datamuse lookup non-ok response', dm.status)
        }
      } catch (e2) {
        datamuseDown = true
        console.warn('Datamuse lookup failed', e2)
      }
      // === DictionaryAPI.dev check via Vercel proxy ===
      //not going to work because cors
      console.log('Checking DictionaryAPI.dev for word:', candidate);
      let res = null;
      try {
        res = await fetch(`/api/dictionary?word=${encodeURIComponent(candidate)}`);
      } catch (err) {
        console.warn('DictionaryAPI.dev lookup failed', err);
        dictDown = true;
      }

      if (res && res.ok) {
        try {
          const data = await res.json();
          // dictionaryapi.dev returns an array of entries for valid words
          if (Array.isArray(data) && data.length > 0) return true;
        } catch (err) {
          console.warn('DictionaryAPI.dev returned invalid JSON', err);
          dictDown = true;
        }
      } else if (res && res.status !== 404) {
        // treat non-404 errors as API being down
        dictDown = true;
      }

      

      // === Allow if all external APIs are down ===
      if (dictDown && datamuseDown && freeDictDown) return true

      return false
    } catch (e) {
      console.warn('isEnglishWord unexpected error — permitting word', e)
      return true
    }
  }


  function TimerWatcher({ roomId, timed, turnTimeoutSeconds, currentTurnStartedAt, currentTurnIndex }) {
    const [tick, setTick] = useState(0)
    useEffect(() => {
      const id = setInterval(() => setTick(t => t + 1), 300)
      return () => clearInterval(id)
    }, [])

    useEffect(() => {
      if (!timed || !turnTimeoutSeconds || !currentTurnStartedAt) return
      const msLeft = currentTurnStartedAt + (turnTimeoutSeconds*1000) - Date.now()
      if (msLeft <= 0) {
        const roomRef = dbRef(db, `rooms/${roomId}`)
        dbGet(roomRef).then(async snap => {
          const r = snap.val() || {}
          const debug = (() => { try { return !!localStorage.getItem('gh_debug_timeouts') } catch (e) { return false } })()
          if (debug) console.log('TimerWatcher: expired check', { roomId, msLeft, localHostId: r.hostId, currentTurnIndex: r.currentTurnIndex, now: Date.now() })
          const order = r.turnOrder || []
          if (!order || order.length === 0) return

          // only the host should write authoritative timeout advances to avoid races
          const localMyId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
          if (!r.hostId || r.hostId !== localMyId) {
            if (debug) console.log('TimerWatcher: not host, skipping authoritative timeout write', { roomId, rHost: r.hostId, localMyId })
            return
          }

          const timedOutPlayer = order[r.currentTurnIndex || 0]
          // check if a timeout for this exact turn (same turn start) already exists
          const timeouts = r.timeouts || {}
          const recent = Object.keys(timeouts || {}).find(k => {
            try {
              const te = timeouts[k]
              // prefer dedupe by turnStartedAt when available (prevents duplicates even if ts differs)
              return te && te.player === timedOutPlayer && te.turnStartedAt && r.currentTurnStartedAt && te.turnStartedAt === r.currentTurnStartedAt
            } catch (e) { return false }
          })
          if (recent) {
            if (debug) console.log('TimerWatcher: skipping timeout write because recent entry exists', { roomId, recentKey: recent, recentEntry: timeouts[recent] })
            return
          }

          const nextIdx = ((r.currentTurnIndex || 0) + 1) % order.length
          // write an authoritative timeout entry for auditing and to notify other clients
          const tkey = `t_${Date.now()}`
          const updates = { currentTurnIndex: nextIdx, currentTurnStartedAt: Date.now() }
          // include the expired turn's start timestamp so consumers can dedupe by turn
          updates[`timeouts/${tkey}`] = { player: timedOutPlayer, deducted: 2, ts: Date.now(), turnStartedAt: r.currentTurnStartedAt || null }
          // clear frozen flags for the player whose turn will start
          try {
            const nextPlayer = order[nextIdx]
            if (nextPlayer) {
              updates[`players/${nextPlayer}/frozen`] = null
              updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
              // clear per-player price surge for the player whose turn is starting (surge expires)
              updates[`priceSurge/${nextPlayer}`] = null
            }
          } catch (e) {}
          if (debug) console.log('TimerWatcher: writing timeout', { roomId, tkey, timedOutPlayer, expiredTurnStartedAt: r.currentTurnStartedAt || null })
          await dbUpdate(roomRef, updates)
        }).catch(e => console.warn('Could not advance turn on timeout', e))
      }
  }, [tick, timed, turnTimeoutSeconds, currentTurnStartedAt, currentTurnIndex, roomId])

    return null
  }

  // Allow the current player to voluntarily end their turn and advance to the next player.
  async function skipTurn() {
    try {
      if (!myId) return
      if (currentTurnId !== myId) {
        setToasts(t => [...t, { id: `skip_err_${Date.now()}`, text: 'You can only skip on your turn.' }])
        return
      }
      const order = state && state.turnOrder ? state.turnOrder : []
      if (!order || order.length === 0) return
      const currentIndexLocal = (typeof state.currentTurnIndex === 'number') ? state.currentTurnIndex : 0
      const nextIndex = (currentIndexLocal + 1) % order.length
      const nextPlayer = order[nextIndex]
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const updates = {
        currentTurnIndex: nextIndex,
        currentTurnStartedAt: Date.now()
      }
      // Clear any frozen flags for the player whose turn will begin
      try {
        if (nextPlayer) {
          updates[`players/${nextPlayer}/frozen`] = null
          updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
          // clear per-player price surge for the player whose turn is starting (surge expires)
          updates[`priceSurge/${nextPlayer}`] = null
        }
      } catch (e) {}
      // Award the starter +1 to the player whose turn will begin (respect room starterBonus)
      try {
        if (nextPlayer) {
          const nextNode = (state && state.players || []).find(p => p.id === nextPlayer) || {}
          const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : Number(nextNode.wordmoney) || 0
          const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
          updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
          try {
            if (state && state.starterBonus && state.starterBonus.enabled) {
              updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
            }
          } catch (e) {}
        }
      } catch (e) {}
      await dbUpdate(roomRef, updates)
      const toastId = `skip_ok_${Date.now()}`
      setToasts(t => [...t, { id: toastId, text: 'Turn skipped' }])
      // auto-dismiss after a short time
      setTimeout(() => {
        // mark removing to allow CSS fade if supported
        setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x))
      }, 3000)
      setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3500)
    } catch (e) {
      console.error('skipTurn failed', e)
      setToasts(t => [...t, { id: `skip_err_${Date.now()}`, text: 'Could not skip turn. Try again.' }])
    }
  }

  async function handleSubmitWord() {
    const candidate = (word || '').toString().trim()
    // client-side safety checks (length and characters)
    if (!candidate) {
      setWordError('Please enter a word')
      return
    }
    // enforce minimum word size from room setting (clamped 2-10)
    const minAllowed = Math.max(2, Math.min(10, Number(minWordSize) || 2))
    if (candidate.length < minAllowed) {
      setWordError(`Please pick a word that is at least ${minAllowed} letters long.`)
      return
    }
    if (!/^[a-zA-Z]+$/.test(candidate)) {
      setWordError('Words may only contain letters. No spaces or punctuation.')
      return
    }
    setWordError('')
    // If a host custom set is present, respect its semantics:
    // - If custom.words is an empty array => host permits any word (skip dictionary checks)
    // - If custom.words is a non-empty array => membership is enforced (checked later) and skip dictionary checks
  const custom = (secretThemeType === 'custom') && state?.secretWordTheme && state.secretWordTheme.custom
    // If any secret-word theme is enforced by the host, skip the English dictionary check.
    // Theme-specific validation (colours/animals/elements/cpp/custom) runs later.
    if (!secretThemeEnabled) {
      // perform dictionary check (may be slow) and show a small spinner state
      setIsCheckingDictionary(true)
      const ok = await isEnglishWord(candidate)
      setIsCheckingDictionary(false)
      if (!ok) {
        setWordError("That doesn't look like an English word. Please pick another.")
        return
      }
    } else {
      // theme is enabled: skip general dictionary checks; theme validation follows below
    }
    // If the host enabled a secret-word theme, validate according to selected type
      if (secretThemeEnabled) {
        try {
          // If the selected theme is 'custom' and the host provided a custom set, it overrides theme validation entirely.
          if (secretThemeType === 'custom' && state?.secretWordTheme && state.secretWordTheme.custom) {
            const wordsArr = Array.isArray(state.secretWordTheme.custom.words) ? state.secretWordTheme.custom.words : null
            // wordsArr === null means host did not save words (treat as no custom list) — fall through to theme checks
            if (Array.isArray(wordsArr)) {
              // If the array has length > 0, enforce membership in that array.
              if (wordsArr.length > 0) {
                const allowed = (wordsArr || []).map(s => (s || '').toString().toLowerCase())
                if (!allowed.includes(candidate.toLowerCase())) {
                  setWordError('Word must be from the host-provided custom list.')
                  return
                }
              }
              // If array is empty, host means "allow any word" — treat as valid and continue
              // Do not return here; allow flow to proceed to submitWord
            }
          }
        // No host custom set: fall back to built-in theme validations
        if (secretThemeType === 'colours') {
          const found = COLOURS && Array.isArray(COLOURS) && COLOURS.includes(candidate.toLowerCase())
          if (!found) {
            setWordError('Word must be a colour from the selected theme (no spaces).')
            return
          }
            } else if (secretThemeType === 'animals') {
          // Validate against the bundled ANIMALS list (offline-safe, deterministic)
          try {
            const localList = Array.isArray(ANIMALS) ? ANIMALS : (ANIMALS && ANIMALS.default ? ANIMALS.default : [])
            if (!Array.isArray(localList) || !localList.includes(candidate.toLowerCase())) {
              setWordError('Word must be an animal from the selected theme (no spaces).')
              return
            }
          } catch (e) {
            setWordError('Could not validate animal — try again')
            return
          }
        } else if (secretThemeType === 'instruments') {
          // Built-in instruments validation (local list lookup)
          try {
            const arr = Array.isArray(INSTRUMENTS) ? INSTRUMENTS : (INSTRUMENTS && INSTRUMENTS.default ? INSTRUMENTS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              setWordError('Word must be an instrument from the selected theme (no spaces).')
              return
            }
          } catch (e) {
            setWordError('Could not validate instrument — try again')
            return
          }
        } else if (secretThemeType === 'elements') {
          // Built-in periodic elements validation — use list
          try {
            const arr = Array.isArray(ELEMENTS) ? ELEMENTS : (ELEMENTS && ELEMENTS.default ? ELEMENTS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              setWordError('Word must be a periodic element from the selected theme (use element name, no spaces).')
              return
            }
          } catch (e) {
            setWordError('Could not validate element — try again')
            return
          }
        } else if (secretThemeType === 'cpp') {
          // Built-in C++ terms validation — use list
          try {
            const arr = Array.isArray(CPPTERMS) ? CPPTERMS : (CPPTERMS && CPPTERMS.default ? CPPTERMS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              setWordError('Word must be a C++ related term from the selected theme (no spaces).')
              return
            }
          } catch (e) {
            setWordError('Could not validate C++ term — try again')
            return
          }
        }
      } catch (e) {
        setWordError('Theme validation failed — try again')
        return
      }
    }
    // call submitWord and only mark submitted when it succeeds
    try {
      const success = await submitWord(candidate)
      if (success) setSubmitted(true)
      else setWordError('Submission rejected by server')
    } catch (e) {
      setWordError('Submission failed — please try again')
    }
  }
  // If the game has ended, render only the victory screen. This return comes after all hooks
  // and derived values so it won't upset hook ordering.
  if ( phase === 'ended') { // true) {
    return (
      <>
        <div className={`victory-screen ${isWinner ? 'confetti' : 'sad'}`}>
          {isWinner && confettiPieces.map((c, i) => (
            <span key={i} className="confetti-piece" style={{ left: `${c.left}%`, width: c.size, height: c.size * 1.6, background: c.color, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s` }} />
          ))}
          {state?.winnerByWordmoney && cashPieces.map((c, i) => (
            <span key={`cash-${i}`} className="cash-piece" style={{ left: `${c.left}%`, top: `${c.top}px`, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s`, position: 'absolute' }} />
          ))}

          <h1>{isWinner ? '🎉 You Win! 🎉' : `😢 ${playerIdToName[state?.winnerId] || state?.winnerName || state?.winnerId || '—'} Wins`}</h1>
          <p>{isWinner ? 'All words guessed. Nice work!' : 'Game over — better luck next time.'}</p>

          <div className="standings card" style={{ marginTop: 12 }}>
            <h4>Final standings</h4>
            <ol>
              {sanitizedStandings.map((p, idx) => {
                const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null
                const accent = idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : idx === 2 ? '#CD7F32' : undefined
                return (
                  <li key={p.id} style={{ margin: '8px 0', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ alignItems: 'center', gap: 8 }}>
                      {medal && <span style={{ fontSize: 22 }}>{medal}</span>}
                      <strong style={{ color: accent || 'inherit' }}>{idx+1}. {p.name}</strong>
                      {showWordsOnEnd && p.word && (
                        <span style={{
                          marginLeft: 8,
                          background: '#eef5ee',
                          padding: '4px 8px',
                          borderRadius: 8,
                          fontSize: 12,
                          color: '#234',
                          display: 'inline-block',
                          maxWidth: '40vw',
                          overflow: 'visible',
                          whiteSpace: 'nowrap'
                        }}>{p.word}</span>
                      )}
                    </div>
                    <div style={{ fontWeight: 800 }}>
                      <span style={{ background: '#f3f3f3', color: p.id === state?.winnerId ? '#b8860b' : '#222', padding: '6px 10px', borderRadius: 16, display: 'inline-block', minWidth: 48, textAlign: 'center' }}>
                        ${p.wordmoney || 0}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ marginBottom: 8 }}>
              <PlayAgainControls isHost={isHost} myId={myId} players={players} />
            </div>
            <div style={{ color: '#ddd' }}>If the host clicks Play again, the room will reset automatically.</div>
          </div>
        </div>
      </>
    )
  }

  // Ensure top-right fixed overlays (modeBadge + turn indicator) do not obscure content
  const appContentStyle = Object.assign(
    { paddingTop: 110, paddingRight: 160 },
    powerUpOpen ? { pointerEvents: 'none', userSelect: 'none' } : {}
  )

  return (
    <div className={`game-room ${state && state.winnerByWordmoney ? 'money-theme' : ''}`}>
      {/* Render the mode badge as a fixed overlay (keeps consistent single source) */}
      {modeBadge}
      {/* Fixed turn indicator placed below the mode badge so it doesn't overlap other content */}
      <div style={{ position: 'fixed', right: 18, top: 74, zIndex: 1 }} className="turn-indicator fixed-turn-indicator">
        {phase === 'playing' ? `Current turn: ${players.find(p => p.id === currentTurnId)?.name || '—'}` : null}
      </div>
      {/* Fixed timer overlay placed below the turn indicator so it doesn't move with the player circle */}
      {phase === 'playing' && state?.timed && state?.turnTimeoutSeconds && state?.currentTurnStartedAt && (
        <div style={{ right: 18, zIndex: 1 }} className="turn-timer">
          <div className="bar"><div className="fill" style={{ width: `${Math.max(0, (state?.currentTurnStartedAt + (state?.turnTimeoutSeconds*1000) - Date.now()) / (state?.turnTimeoutSeconds*1000) * 100)}%` }} /></div>
          <div className="time">{(() => {
            const msLeft = Math.max(0, (state?.currentTurnStartedAt || 0) + ((state?.turnTimeoutSeconds || 0)*1000) - Date.now())
            const s = Math.ceil(msLeft / 1000)
            return `${s}s`
          })()}</div>
        </div>
      )}
      <div className="app-content" style={appContentStyle}>
  {phase === 'lobby' && <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />}
  {phase === 'lobby' && <h2>Room: {roomId}</h2>}
  {phase === 'lobby' && secretThemeEnabled && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <ThemeBadge type={secretThemeType} />
      {secretThemeType === 'custom' && state && state.secretWordTheme && state.secretWordTheme.custom && state.secretWordTheme.custom.title ? (
        <div style={{ fontSize: 13, color: '#666', marginLeft: 6 }} title={state.secretWordTheme.custom.title}>
          {state.secretWordTheme.custom.title}{Array.isArray(state.secretWordTheme.custom.words) && state.secretWordTheme.custom.words.length === 0 ? ' (any word allowed)' : ''}
        </div>
      ) : null}
    </div>
  )}
      {phase === 'lobby' && (
        <div style={{ display: 'inline-block' }}>
          <div style={{ marginBottom: 8 }}>
            {isHost ? (
              <>
              </>
              ) : (
              <div style={{ color: '#555' }}>
                Timed mode: <strong>{state?.timed ? 'On' : 'Off'}</strong>
                {state?.timed && <span style={{ marginLeft: 12 }}>Seconds per turn: <strong>{state?.turnTimeoutSeconds}</strong></span>}
              </div>
            )}
          </div>
          {isHost ? (
            <>
              <button
                onClick={() => {
                  if (gameMode === 'wordSpy') {
                    // Word Spy requires at least 3 players
                    if ((players || []).length < 3) {
                      try { setToasts(t => [...t, { id: `ws_minplayers_${Date.now()}`, text: 'Word Spy requires at least 3 players to start' }]) } catch (e) {}
                      setTimeout(() => setToasts(t => t.filter(x => !(x.id && String(x.id).startsWith('ws_minplayers_')))), 3500)
                      return
                    }
                    try { startWordSpy({ timerSeconds: wordSpyTimerSeconds, rounds: wordSpyRounds }) } catch (e) { console.warn('startWordSpy failed', e) }
                  } else {
                    const opts = timedMode ? { timed: true, turnSeconds, starterEnabled, winnerByWordmoney } : { starterEnabled, winnerByWordmoney }
                    // include the local UI startingWordmoney so startGame can prefer it
                    opts.startingWordmoney = startingWordmoney
                    startGame(opts)
                  }
                }}
                disabled={players.length < 2}
                title={players.length < 2 ? 'Need at least 2 players to start' : ''}
                className={players.length >= 2 ? 'start-ready' : ''}
              >Start game</button>
              {players.length < 2 && <div style={{ fontSize: 13, color: '#7b6f8a', marginTop: 6 }}>Waiting for more players to join (need 2+ players)</div>}
            </>
          ) : null}
        </div>
      )}

      {/* Word Spy specific UI flows */}
      {state && state.gameMode === 'wordSpy' && state.wordSpy && (
        (() => {
          const ws = state.wordSpy || {}
          const myId = playerId()
          const isSpy = ws.spyId === myId
          // waiting phase
          if ((state.phase === 'wordspy_wait' || ws.state === 'waiting')) {
            return (
              <div className="notice card">
                <h4>Word Spy — Round {ws.currentRound} / {ws.roundsRemaining + ws.currentRound - 1}</h4>
                <div>
                  {!isSpy ? (
                    <>
                      <p>The secret word is: <strong style={{ letterSpacing: 2 }}>{ws.word}</strong></p>
                      <p>When you're ready, click Ready.</p>
                    </>
                  ) : (
                    <>
                      <p>You are the spy — keep the word secret. Your goal is to guess the word later.</p>
                      <p>When others are ready, the host will start the playing phase.</p>
                    </>
                  )}

                  {/* Ready button shown to everyone (including spy) */}
                  <button onClick={() => { try { markWordSpyReady() } catch (e) { console.warn(e) } }}>Ready</button>
                  {isHost && <button style={{ marginLeft: 8 }} onClick={() => { try { beginWordSpyPlaying() } catch (e) { console.warn('beginWordSpyPlaying failed', e) } }}>Force start</button>}
                  {/* removed redundant Start playing button; Ready is sufficient and host can Force start */}
                </div>
              </div>
            )
          }

          // playing phase
          if (state.phase === 'wordspy_playing' || ws.state === 'playing') {
            const startedAt = ws.playingStartedAt || ws.startedAt || state.currentTurnStartedAt || Date.now()
            const totalMs = (ws.timerSeconds || 120) * 1000
            const msLeft = Math.max(0, (startedAt + totalMs) - Date.now())
            const sLeft = Math.ceil(msLeft / 1000)
            return (
              <div className="notice card">
                <h4>Word Spy — Playing</h4>
                {!isSpy ? (
                  <div>
                    <p>Word: <strong style={{ letterSpacing: 2 }}>{ws.word}</strong></p>
                    <p>Time left: <strong>{sLeft}s</strong></p>
                  </div>
                ) : (
                  <div>
                    <p>You are the spy — you don't see the word. Watch the discussion and try to blend in.</p>
                    <p>Time left: <strong>{sLeft}s</strong></p>
                  </div>
                )}
                {/* Host can end playing early and move to voting regardless of whether they are the spy */}
                {isHost && <div style={{ marginTop: 8 }}><button onClick={() => { try { endWordSpyPlaying() } catch (e) { console.warn(e) } }}>End playing / move to voting</button></div>}
              </div>
            )
          }

          // voting phase
          if (state.phase === 'wordspy_voting' || ws.state === 'voting') {
            // players can click a person to vote
            const roundResults = (ws && ws.roundResults) ? Object.values(ws.roundResults).sort((a,b) => b.ts - a.ts) : []
            const myNodeLocal = (players || []).find(p => p.id === myId) || {}
            const myVoteLocal = myNodeLocal.wordSpyVote || null
            const votersList = (players || []).filter(p => p.wordSpyVote).map(p => ({ id: p.id, name: p.name, votedFor: p.wordSpyVote }))
            return (
              <div className="notice card">
                <h4>Vote for the spy</h4>
                <p>Click a player you think is the spy. You may change your vote until the host tallies.</p>

                {votersList.length > 0 && (
                  <div style={{ marginBottom: 8, fontSize: 13 }}>
                    <strong>Players who have voted:</strong> {votersList.map(v => v.name).join(', ')}
                  </div>
                )}

                {/* If a tally was attempted and there's no clear majority, show an error so players can change votes */}
                {ws && ws.lastTally && (() => {
                  try {
                    const totalPlayers = (players || []).length || 0
                    const majorityNeeded = Math.floor(totalPlayers / 2) + 1
                    const lt = ws.lastTally || {}
                    if (lt && lt.top && lt.topCount < majorityNeeded) {
                      return (
                        <div style={{ marginTop: 8, color: '#fff', background: '#b02a37', padding: 8, borderRadius: 6 }}>
                          No clear majority — change your vote until there is a clear majority (need {majorityNeeded} of {totalPlayers}).
                        </div>
                      )
                    }
                  } catch (e) {}
                  return null
                })()}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {players.map(p => {
                    const selected = myVoteLocal === p.id
                    return (
                      <button key={p.id}
                              disabled={p.id === myId}
                              onClick={() => { try { voteForPlayer(playerId(), p.id) } catch (e) { console.warn(e) } }
                              }
                              style={{ background: selected ? '#DFF0D8' : undefined, border: selected ? '2px solid #4CAF50' : undefined }}>
                        {p.name}{p.wordSpyVote ? ' ✓' : ''}
                      </button>
                    )
                  })}
                </div>

                <div style={{ marginTop: 8 }}>
                  {myVoteLocal ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 13 }}>Your vote: <strong>{playerIdToName[myVoteLocal] || myVoteLocal}</strong></div>
                      <button onClick={() => { try { voteForPlayer(playerId(), null) } catch (e) { console.warn(e) } }}>Clear vote</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13 }}>You haven't voted yet.</div>
                  )}
                </div>

                {isHost && <div style={{ marginTop: 8 }}><button onClick={async () => { try { await tallyWordSpyVotes() } catch (e) { console.warn('tally failed', e) } }}>Tally votes</button></div>}

    
              </div>
            )
          }

          // spy guess phase
          if (state.phase === 'wordspy_spyguess' || ws.state === 'spyGuess') {
            const me = players.find(p => p.id === playerId()) || {}
            const guessesObj = me.wordSpyGuesses || {}
            const attempts = Object.keys(guessesObj || {}).length
            const maxAttempts = 3
            const lastReveal = ws.lastReveal || null
            // build masked word view based on ws.revealed map
            const revealedMap = ws.revealed || {}
            const ownerWord = (ws.word || '')
            const preserve = !!revealPreserveOrder
            const masked = (() => {
              try {
                const arr = (ownerWord || '').split('')
                // when preserve order is enabled, reveal letters according to word order
                if (preserve) {
                  const counts = {}
                  Object.keys(revealedMap || {}).forEach(k => { counts[k] = Number(revealedMap[k] || 0) })
                  return arr.map(ch => {
                    const lower = (ch || '').toLowerCase()
                    if (counts[lower] && counts[lower] > 0) {
                      counts[lower] = counts[lower] - 1
                      return ch
                    }
                    return '_'
                  }).join('')
                }
                // otherwise, build masked view from revealSequence entries (guess-order)
                const seq = ws.revealSequence || {}
                // flatten sequence entries by timestamp order
                const seqKeys = Object.keys(seq || {}).sort((a,b) => Number(a) - Number(b))
                const counts = {}
                seqKeys.forEach(k => {
                  try { (seq[k].letters || []).forEach(ch => { counts[ch] = (counts[ch] || 0) + 1 }) } catch (e) {}
                })
                // fallback: also include any letters from revealed map
                Object.keys(revealedMap || {}).forEach(k => { counts[k] = (counts[k] || 0) + Number(revealedMap[k] || 0) })
                return arr.map(ch => {
                  const lower = (ch || '').toLowerCase()
                  if (counts[lower] && counts[lower] > 0) {
                    counts[lower] = counts[lower] - 1
                    return ch
                  }
                  return '_'
                }).join('')
              } catch (e) { return (ownerWord || '').split('').map(_ => '_').join('') }
            })()

            return (
              <div className="notice card">
                <h4>Spy Guess — Round {ws.currentRound || ws.current || 1}</h4>
                <div style={{ marginBottom: 8 }}>
                  <strong>Word length:</strong> {(ws.word || '').length} letters
                </div>
                <div style={{ marginBottom: 8 }}>
                  <strong>Revealed so far:</strong> <span style={{ letterSpacing: 2 }}>{masked}</span>
                </div>
                {isSpy ? (
                  <div>
                    <p>Guess the word. Attempts: {attempts} / {maxAttempts}</p>
                    <input id="spy_guess_input" placeholder="exact-length guess" maxLength={(ws.word||'').length} />
                    <button onClick={async () => {
                      try {
                        const el = document.getElementById('spy_guess_input')
                        const val = el ? el.value.trim() : ''
                        if (!val) return
                        const res = await submitSpyGuess(val)
                        if (res && res.correct) {
                          setToasts(t => [...t, { id: `spy_win_${Date.now()}`, text: 'Spy guessed the word!' }])
                        } else if (res && res.revealed) {
                          setToasts(t => [...t, { id: `spy_reveal_${Date.now()}`, text: `Revealed letters: ${res.revealed}` }])
                        }
                      } catch (e) { console.warn('submitSpyGuess err', e) }
                    }}>Submit guess</button>
                    {lastReveal && <div style={{ marginTop: 8 }}>Last reveal: {lastReveal.revealed || lastReveal.guess}</div>}
                  </div>
                ) : (
                  <div>
                    <p>{ws.spyId ? `Discuss and then vote for who you think the spy is.` : 'Waiting...'}</p>
                    <div style={{ marginTop: 8 }}>{isHost && <button onClick={() => { try { playNextWordSpyRound() } catch (e) { console.warn(e) } }}>Next round</button>}</div>
                  </div>
                )}
              </div>
            )
          }

          return null
        })()
      )}

      {/* Word Spy round summary popup after tally */}
      {state && state.wordSpy && state.wordSpy.lastRoundSummary && ((state.wordSpy.roundsRemaining || 0) > 0) && (
        <div className="modal-backdrop">
          <div className="modal card" style={{ maxWidth: 520 }}>
            <h3>Round {state.wordSpy.lastRoundSummary.round || '?'} summary</h3>
            <p>The spy for that round was: <strong>{playerIdToName[state.wordSpy.lastRoundSummary.spyId] || state.wordSpy.lastRoundSummary.spyId}</strong></p>
            <p>The word was: <strong>{state.wordSpy.lastRoundSummary.word || '—'}</strong></p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {isHost ? (
                <button onClick={async () => { try { await playNextWordSpyRound(); } catch (e) { console.warn(e) } }}>Next round</button>
              ) : (
                <strong onClick={() => { /* non-host just dismiss */ }}>Wait for host</strong>
              )}
            </div>
          </div>
        </div>
      )}

      {/* non-host waiting message */}
      {phase === 'lobby' && !isHost && (
        <div className="notice card">
          <h4>Waiting for the host to start the game</h4>
          <p>The host <strong>{playerIdToName[hostId] || '—'}</strong> can start the game when ready.</p>
        </div>
      )}

      {phase === 'lobby' && (
        <div className="share-room">
          <small>Share this link to invite:</small>
            <div>
              {/* Build the share link string using buildRoomUrl so it's consistent */}
              {(() => {
                try {
                  const u = new URL(window.location.href)
                  u.searchParams.set('room', roomId)
                  return (
                    <>
                      <input id="share_link" name="share_link" readOnly value={u.toString()} style={{ width: 360 }} />
                  <button onClick={async () => { await navigator.clipboard.writeText(u.toString()); setToasts(t => [...t, { id: Date.now(), text: 'Room link copied' }]); setTimeout(() => setToasts(t => t.slice(1)), 3000) }}>Copy</button>
                    </>
                  )
                } catch (e) {
                  const fallback = window.location.origin + '?room=' + roomId
                  return (
                    <>
                      <input id="share_link_fallback" name="share_link_fallback" readOnly value={fallback} style={{ width: 360 }} />
                      <button onClick={async () => { await navigator.clipboard.writeText(fallback); setToasts(t => [...t, { id: Date.now(), text: 'Room link copied' }]); setTimeout(() => setToasts(t => t.slice(1)), 3000) }}>Copy</button>
                    </>
                  )
                }
              })()}
            </div>
        </div>
      )}

  <div className={`circle ${isMyTurnNow ? 'my-turn' : ''}`}>
    {players.length === 0 && <div>No players yet — wait for others to join.</div>}
        {/* Timer moved to fixed overlay near turn indicator */}
        {(() => {
          // defensive: ensure players is an array of objects (some DB writes may briefly produce non-object entries)
          const sanitized = (players || []).filter(x => x && typeof x === 'object')
          if (sanitized.length !== (players || []).length) {
            try { console.warn('GameRoom: filtered invalid player entries from state.players', { rawPlayers: players, stateSnapshot: state }) } catch (e) {}
          }
          return sanitized.map(p => {
          // host-only remove API for player tiles
          const removePlayer = async (pid) => {
            if (!isHost) return false
            try {
              const playerRef = dbRef(db, `rooms/${roomId}/players/${pid}`)
              // attempt SDK delete via update to null
              try {
                await dbUpdate(playerRef, null)
                try { setToasts(t => [...t, { id: `remove_ok_${pid}_${Date.now()}`, text: `Removed player ${playerIdToName[pid] || pid}` }]) } catch (e) {}
                setTimeout(() => setToasts(t => t.map(x => x.id && x.id.startsWith(`remove_ok_${pid}_`) ? { ...x, removing: true } : x)), 2200)
                setTimeout(() => setToasts(t => t.filter(x => !(x.id && x.id.startsWith(`remove_ok_${pid}_`)))), 3000)
                return true
              } catch (e) {
                try {
                  const roomRef = dbRef(db, `rooms/${roomId}`)
                  await dbUpdate(roomRef, { [`players/${pid}`]: null })
                  try { setToasts(t => [...t, { id: `remove_ok_${pid}_${Date.now()}`, text: `Removed player ${playerIdToName[pid] || pid}` }]) } catch (e2) {}
                  setTimeout(() => setToasts(t => t.map(x => x.id && x.id.startsWith(`remove_ok_${pid}_`) ? { ...x, removing: true } : x)), 2200)
                  setTimeout(() => setToasts(t => t.filter(x => !(x.id && x.id.startsWith(`remove_ok_${pid}_`)))), 3000)
                  return true
                } catch (e2) {
                  console.warn('removePlayer: fallback failed', e2)
                }
              }
            } catch (err) { console.error('removePlayer failed', err) }
            try { setToasts(t => [...t, { id: `remove_err_${pid}_${Date.now()}`, text: `Could not remove ${playerIdToName[pid] || pid}`, removing: false }]) } catch (e) {}
            setTimeout(() => setToasts(t => t.map(x => x.id && x.id.startsWith(`remove_err_${pid}_`) ? { ...x, removing: true } : x)), 4200)
            setTimeout(() => setToasts(t => t.filter(x => !(x.id && x.id.startsWith(`remove_err_${pid}_`)))), 5200)
            return false
          }
          // derive viewer-specific private data. viewer's node lives under state.players keyed by id — we need to find viewer's full object
          const viewerNode = players.find(x => x.id === myId) || {}
          // viewerNode may contain privateWrong, privateHits, privateWrongWords and private powerup data
          const viewerPrivate = {
            privateWrong: viewerNode.privateWrong || {},
            privateHits: viewerNode.privateHits || {},
            privateWrongWords: viewerNode.privateWrongWords || {},
            privatePowerUps: viewerNode.privatePowerUps || {},
            privatePowerReveals: viewerNode.privatePowerReveals || {},
            // include a map of player id -> color so child components can color private reveals by player
            playerColors: (players || []).reduce((acc, pp) => { if (pp && pp.id) acc[pp.id] = pp.color || null; return acc }, {})
          }

          // clone player and attach viewer's private data under _viewer so child can render it
          // compute ms left for the current player
          const msLeftForPlayer = (state?.currentTurnStartedAt && state?.turnTimeoutSeconds && state?.timed && currentTurnId === p.id)
            ? Math.max(0, (state?.currentTurnStartedAt || 0) + ((state?.turnTimeoutSeconds || 0)*1000) - Date.now())
            : null

          const playerWithViewer = { ...p, _viewer: viewerPrivate }

          // If the viewer has an active Double Down, only allow guessing the target they doubled-down on.
          // The purchase flow writes a privatePowerReveals entry under the buyer's node keyed by targetId.
          // Find the most-recent double_down entry to determine the intended target.
          const viewerDDActive = !!(viewerNode && viewerNode.doubleDown && viewerNode.doubleDown.active)
          let viewerDDTarget = null
          try {
            if (viewerDDActive) {
              const ppr = viewerNode.privatePowerReveals || {}
              let latestTs = 0
              Object.keys(ppr).forEach(tid => {
                const bucket = ppr[tid] || {}
                Object.values(bucket).forEach(entry => {
                  if (!entry) return
                  // accept either top-level ts or nested result.ts
                  const isDD = entry && (entry.powerId === 'double_down' || (entry.result && entry.result.powerId === 'double_down'))
                  if (!isDD) return
                  const ts = Number(entry.ts || (entry.result && entry.result.ts) || 0)
                  if (ts >= latestTs) {
                    latestTs = ts
                    viewerDDTarget = tid
                  }
                })
              })
            }
          } catch (e) { viewerDDTarget = null }

          const baseCanGuess = phase === 'playing' && myId === currentTurnId && p.id !== myId
          // if viewer has an active DD and a known target, only that target is guessable.
          // additionally, respect 'frozen' state on the target: if the target is frozen, other
          // players (not the target themselves) should not be able to guess them.
          const targetFrozen = !!(p && (p.frozen || (typeof p.frozenUntilTurnIndex !== 'undefined' && p.frozenUntilTurnIndex !== null)))
          const canGuessComputed = baseCanGuess && (!viewerDDActive || !viewerDDTarget || viewerDDTarget === p.id) && !(targetFrozen && p.id !== myId)

          const wasPenalized = Object.keys(state?.timeouts || {}).some(k => (state?.timeouts && state.timeouts[k] && state.timeouts[k].player) === p.id && recentPenalty[k])
          // determine why the power-up button should be disabled (if anything)
          const powerUpActive = powerUpsEnabled && (myId === currentTurnId) && p.id !== myId && !p.eliminated
          let pupReason = null
          if (!powerUpsEnabled) pupReason = 'Power-ups are disabled'
          else if (p.id === myId) pupReason = 'Cannot target yourself'
          else if (p.eliminated) pupReason = 'Player is eliminated'
          else if (myId !== currentTurnId) pupReason = 'Not your turn'
          else if (ddShopLocked) pupReason = 'Double Down placed — make your guess first'
          else {
            const me = (state?.players || []).find(x => x.id === myId) || {}
            const cheapest = Math.min(...(POWER_UPS || []).map(x => x.price))
            const myHang = Number(me.wordmoney) || 0
            if (myHang < cheapest) pupReason = `Need at least ${cheapest} 🪙 to buy power-ups`
          }

          return (
            <PlayerCircle key={p.id}
                          player={playerWithViewer}
                          gameMode={state?.gameMode}
                          viewerIsSpy={state && state.wordSpy && state.wordSpy.spyId === myId}
                          isSelf={p.id === myId}
                          hostId={hostId}
                          isHost={isHost}
                          onRemove={removePlayer}
                          viewerId={myId}
                          phase={phase}
                          hasSubmitted={!!p.hasWord}
                          canGuess={canGuessComputed}
                          ddActive={viewerDDActive}
                          ddTarget={viewerDDTarget}
                          onGuess={(targetId, guess) => { try { setDdShopLocked(false) } catch (e) {} ; sendGuess(targetId, guess) }} 
                          showPowerUpButton={powerUpsEnabled && (myId === currentTurnId) && p.id !== myId}
                          onOpenPowerUps={(targetId) => { setPowerUpTarget(targetId); setPowerUpOpen(true); setPowerUpChoiceValue(''); setPowerUpStakeValue('') }}
                          onSkip={skipTurn}
                          playerIdToName={playerIdToName}
                          timeLeftMs={msLeftForPlayer} currentTurnId={currentTurnId}
                          starterApplied={!!state?.starterBonus?.applied}
                          flashPenalty={wasPenalized}
                          pendingDeduct={pendingDeducts[p.id] || 0}
                          isWinner={p.id === state?.winnerId}
                          powerUpDisabledReason={pupReason}
                          revealPreserveOrder={revealPreserveOrder}
                          revealShowBlanks={revealShowBlanks} />
          )
          })
        })()}
      </div>

      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.multi ? 'multi-hit-toast' : ''} ${t.removing ? 'removing' : ''}`}>
            {t.multi && (
              <>
                <span className="confetti-like" />
                <span className="confetti-like" />
                <span className="confetti-like" />
              </>
            )}
            {t.text}
          </div>
        ))}
      </div>

  </div>{/* end app-content */}
  {/* Power-up modal rendered when requested */}
  {powerUpOpen && <PowerUpModal open={powerUpOpen} targetId={powerUpTarget} onClose={() => setPowerUpOpen(false)} />}

      {/* Timer tick: client watches for timeout and advances turn if needed (best-effort) */}
        {phase === 'playing' && state?.timed && state?.turnTimeoutSeconds && state?.currentTurnStartedAt && (
        <TimerWatcher roomId={roomId} timed={state?.timed} turnTimeoutSeconds={state?.turnTimeoutSeconds} currentTurnStartedAt={state?.currentTurnStartedAt} currentTurnIndex={state?.currentTurnIndex} />
      )}

      {/* Submit bar moved to bottom so it can be reused for power-ups later */}

      {phase === 'lobby' && state?.password && (
        <div className="room-password">
          <strong>Room Password:</strong> {state?.password}
          {isHost && <span> (You are the host)</span>}
        </div>
      )}

      <div className="controls">
        {/* Controls for guesses and power-ups will go here during playing phase */}
      </div>
      {/* Bottom-fixed submit bar (shown during submit phase). This contains the secret-word entry and submit button
          and is intentionally separated so it can be reused later for power-ups. */}
  {phase === 'submit' && (() => {
        const me = players.find(p => p.id === myId) || {}
        const myHasSubmitted = !!me.hasWord
        const candidateInput = (word || '').toString().trim()
        const localInvalid = !candidateInput || candidateInput.length === 1 || !/^[a-zA-Z]+$/.test(candidateInput)
        return (
          <div className="submit-bar card">
            <div className="submit-left">
              <h4 style={{ margin: 0 }}>Submit your secret word</h4>
              {secretThemeEnabled && (
                <ThemeBadge type={secretThemeType} />
              )}
              {state?.starterBonus?.enabled && (
                <div style={{ marginTop: 6, fontSize: 13, color: '#B4A3A3' }} title={state?.starterBonus?.description}>
                  Word bonus if: <strong>{state?.starterBonus?.description}</strong>
                </div>
              )}
              <div className="progress" style={{ marginTop: 8, width: 220 }}>
                <div className="progress-bar" style={{ width: `${(players.length ? (submittedCount / players.length) * 100 : 0)}%`, background: '#4caf50', height: 10, borderRadius: 6 }} />
                <div style={{ marginTop: 6, fontSize: 13 }}>{submittedCount} / {players.length} players submitted</div>
              </div>
            </div>
            <div className="submit-controls">
              {!myHasSubmitted ? (
                <>
                  <input id="submit_word" name="submit_word" placeholder="your word" value={word} onChange={e => { setWord(e.target.value); setWordError('') }} />
                  <button onClick={handleSubmitWord} disabled={isCheckingDictionary || localInvalid}>{isCheckingDictionary ? 'Checking…' : 'Submit'}</button>
                  {/* inline helper / error */}
                  {(wordError || (!isCheckingDictionary && localInvalid && candidateInput)) && (
                    <div className="small-error" style={{ marginLeft: 12 }}>
                      {wordError || (candidateInput && candidateInput.length === 1 ? 'Please pick a word that is at least 2 letters long.' : 'Words may only contain letters. No spaces or punctuation.')}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ padding: '8px 12px' }}>Submitted — waiting for others</div>
              )}
            </div>
            <div className="submit-waiting">
              {players.filter(p => !p.hasWord).length > 0 && (
                <div className="notice" style={{ marginLeft: 12 }}>
                  <strong>Waiting for:</strong>
                  <div style={{ marginTop: 8 }}>{players.filter(p => !p.hasWord).map(p => (
                    <div key={p.id} style={{ marginBottom: 6 }}>
                      <span className="waiting-dot" style={{ background: p.color || '#FFABAB' }} />{p.name}
                    </div>
                  ))}</div>
                </div>
              )}
            </div>
          </div>
        )
      })()}
        {/* Render ended/victory screen after hooks have been declared to avoid skipping hooks */}
        {phase === 'ended' && (
          <>
          <div className={`victory-screen ${isWinner ? 'confetti' : 'sad'}`}>
            {isWinner && confettiPieces.map((c, i) => (
              <span key={i} className="confetti-piece" style={{ left: `${c.left}%`, width: c.size, height: c.size * 1.6, background: c.color, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s` }} />
            ))}
            {state?.winnerByWordmoney && cashPieces.map((c, i) => (
              <span key={`cash-${i}`} className="cash-piece" style={{ left: `${c.left}%`, top: `${c.top}px`, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s`, position: 'absolute' }} />
            ))}

            <h1>{isWinner ? '🎉 You Win! 🎉' : `😢 ${playerIdToName[state?.winnerId] || state?.winnerName || state?.winnerId || '—'} Wins`}</h1>
            <p>{isWinner ? 'All words guessed. Nice work!' : 'Game over — better luck next time.'}</p>

            <div className="standings card" style={{ marginTop: 12 }}>
              <h4>Final standings</h4>
              <ol>
                {sanitizedStandings.map((p, idx) => {
                  const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null
                  const accent = idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : idx === 2 ? '#CD7F32' : undefined
                  return (
                    <li key={p.id} style={{ margin: '8px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {medal && <span style={{ fontSize: 22 }}>{medal}</span>}
                        <strong style={{ color: accent || 'inherit' }}>{idx+1}. {p.name}</strong>
                        {showWordsOnEnd && p.word && (
                          <span style={{
                            marginLeft: 8,
                            background: '#eef5ee',
                            padding: '4px 8px',
                            borderRadius: 8,
                            fontSize: 12,
                            color: '#234',
                            display: 'inline-block',
                            maxWidth: '40vw',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>{p.word}</span>
                        )}
                      </div>
                      <div style={{ fontWeight: 800 }}>
                        <span style={{
                          background: '#f3f3f3',
                          color: p.id === state?.winnerId ? '#b8860b' : '#222',
                          padding: '6px 10px',
                          borderRadius: 16,
                          display: 'inline-block',
                          minWidth: 48,
                          maxWidth: 120,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          textAlign: 'center'
                        }}>
                          ${p.wordmoney || 0}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ marginBottom: 8 }}>
                <PlayAgainControls isHost={isHost} myId={myId} players={players} />
              </div>
              <div style={{ color: '#ddd' }}>If the host clicks Play again, the room will reset automatically.</div>
            </div>
          </div>
          </>
        )}
      
    </div>
  )
}
