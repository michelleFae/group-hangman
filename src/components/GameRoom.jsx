import React, { useEffect, useState, useMemo, useRef } from 'react'
import PlayerCircle from './PlayerCircle'
import useGameRoom from '../hooks/useGameRoom'
import useUserActivation from '../hooks/useUserActivation'
import { db } from '../firebase'
import { ref as dbRef, get as dbGet, update as dbUpdate } from 'firebase/database'
import { buildRoomUrl } from '../utils/url'

export default function GameRoom({ roomId, playerName, password }) { // Added password as a prop
  const { state, joinRoom, leaveRoom, sendGuess, startGame, submitWord, playerId } = useGameRoom(roomId, playerName)
  const [word, setWord] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [wordError, setWordError] = useState('')
  const [isCheckingDictionary, setIsCheckingDictionary] = useState(false)
  const [timedMode, setTimedMode] = useState(false)
  const [turnSeconds, setTurnSeconds] = useState(30)
  const [starterEnabled, setStarterEnabled] = useState(false)
  const [winnerByHangmoney, setWinnerByHangmoney] = useState(false)
  const [powerUpsEnabled, setPowerUpsEnabled] = useState(false)
  const [minWordSize, setMinWordSize] = useState(2)
  const [showSettings, setShowSettings] = useState(false)
  const [timeLeft, setTimeLeft] = useState(null)
  const [tick, setTick] = useState(0)
  const [toasts, setToasts] = useState([])
  const [powerUpOpen, setPowerUpOpen] = useState(false)
  const [powerUpTarget, setPowerUpTarget] = useState(null)
  const [powerUpChoiceValue, setPowerUpChoiceValue] = useState('')
  const [powerUpLoading, setPowerUpLoading] = useState(false)
  const powerUpChoiceRef = useRef(null)
  const multiHitSeenRef = useRef({})
  const [recentPenalty, setRecentPenalty] = useState({})
  const [pendingDeducts, setPendingDeducts] = useState({})
  const [showConfirmReset, setShowConfirmReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [forcedLobbyView, setForcedLobbyView] = useState(false)
  // ensure audio/vibration unlock on first user gesture (no UI toast)
  useUserActivation()

  useEffect(() => {
    joinRoom(password) // Pass the password to joinRoom
    return () => leaveRoom()
  }, [password])

  // local tick to refresh timers on screen
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 300)
    return () => clearInterval(id)
  }, [])

  // keep local timed UI in sync with room state (so non-hosts can see current selection)
  useEffect(() => {
    if (!state) return
    setTimedMode(!!state?.timed)
    setTurnSeconds(state?.turnTimeoutSeconds || 30)
    // sync winner-by-money mode from room state
    setWinnerByHangmoney(!!state?.winnerByHangmoney)
    setStarterEnabled(!!state?.starterBonus?.enabled)
    setPowerUpsEnabled(!!state?.powerUpsEnabled)
    setMinWordSize(typeof state?.minWordSize === 'number' ? Math.max(2, Math.min(10, state.minWordSize)) : 2)
  }, [state?.timed, state?.turnTimeoutSeconds])

  // toggle a body-level class so the background becomes green when money-mode is active
  useEffect(() => {
    try {
      if (state?.winnerByHangmoney) document.body.classList.add('money-theme-body')
      else document.body.classList.remove('money-theme-body')
    } catch (e) {}
    return () => {}
  }, [state?.winnerByHangmoney])

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
      await dbUpdate(roomRef, { timed: !!timed, turnTimeoutSeconds: timed ? Math.max(10, Math.min(300, Number(seconds) || 30)) : null })
    } catch (e) {
      console.warn('Could not update room timing preview', e)
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

    // Strategy D-first: REST PATCH
    try {
      const authToken = (window.__firebaseAuth && window.__firebaseAuth.currentUser) ? await window.__firebaseAuth.currentUser.getIdToken() : null
      const dbUrl = window.__firebaseDatabaseURL || (typeof process !== 'undefined' && process.env && (process.env.VITE_FIREBASE_DATABASE_URL || process.env.FIREBASE_DATABASE_URL)) || null
      if (!dbUrl) throw new Error('No database URL available for REST fallback')
      const url = `${dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}.json${authToken ? `?auth=${authToken}` : ''}`
      const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
      if (!res.ok) throw new Error('REST fallback failed: ' + res.status + ' ' + (await res.text()))
      console.log('attemptReset: REST PATCH succeeded')
      return true
    } catch (errRestFirst) {
      console.warn('attemptReset: REST PATCH first attempt failed or unavailable', errRestFirst && (errRestFirst.stack || errRestFirst.message || String(errRestFirst)))
      errors.push({ step: 'rest-first', err: errRestFirst && (errRestFirst.stack || errRestFirst.message || String(errRestFirst)) })
      // next: try modular named update
      try {
        if (typeof dbUpdate === 'function') {
          await dbUpdate(roomRef, updates)
          console.log('attemptReset: named dbUpdate succeeded')
          return true
        } else {
          throw new Error('named dbUpdate not available')
        }
      } catch (errA) {
        console.warn('attemptReset: named dbUpdate failed or unavailable', errA && (errA.stack || errA.message || String(errA)))
        errors.push({ step: 'named dbUpdate', err: errA && (errA.stack || errA.message || String(errA)) })
        try {
          if (roomRef && typeof roomRef.update === 'function') {
            await roomRef.update(updates)
            console.log('attemptReset: roomRef.update succeeded')
            return true
          } else {
            throw new Error('roomRef.update not available')
          }
        } catch (errB) {
          console.warn('attemptReset: roomRef.update failed or unavailable', errB && (errB.stack || errB.message || String(errB)))
          errors.push({ step: 'ref.update', err: errB && (errB.stack || errB.message || String(errB)) })
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
        }
      }
    }

    console.error('attemptReset: all update strategies failed', errors)
    return false
  }

  // write winner mode to the room so all clients see it immediately
  async function updateRoomWinnerMode(enabled) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      await dbUpdate(roomRef, { winnerByHangmoney: !!enabled })
    } catch (e) {
      console.warn('Could not update winner mode', e)
    }
  }

  // watch for timeout logs in state.timeouts to show toast and flash player
  // dedupe timeouts per player to avoid duplicate toasts when both client and server
  const processedTimeoutPlayersRef = useRef({})
  // also dedupe by timeout key so the same timeout entry doesn't re-trigger repeatedly
  const processedTimeoutKeysRef = useRef({})
  // track previous hangmoney values so we can show gain toasts when anyone receives points
  const prevHangRef = useRef({})
  // track expected hangmoney values after a pending deduction so the UI can wait for DB confirmation
  const expectedHangRef = useRef({})
  const prevHostRef = useRef(null)

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
    if (!state) return
    // scan for privateHits where the current viewer (myId) has an entry with count >= 2
    try {
      const me = (state.players || []).find(p => p.id === myId) || {}
      const privateHits = me.privateHits || {}
      Object.keys(privateHits).forEach(targetId => {
        const entries = privateHits[targetId] || []
        entries.forEach(e => {
          if (e && e.type === 'letter' && (Number(e.count) || 0) >= 2) {
            const key = `${targetId}:${e.letter}:${e.count}`
          if (!multiHitSeenRef.current[key]) {
              multiHitSeenRef.current[key] = true
              const toastId = `mh_${Date.now()}`
              setToasts(t => [...t, { id: toastId, text: `Nice! ${e.count}× "${e.letter.toUpperCase()}" found — +${2*e.count}` , multi: true }])
              // remove this multi-hit toast after 7 seconds
                // after 7s, mark toast as removing so CSS fade-out can run
                setTimeout(() => {
                  setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x))
                }, 7000)
                // actually remove the toast after 8s (allow ~1s for fade animation)
                setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 8000)
            }
          }
        })
      })
    } catch (e) {}
    const timeouts = state.timeouts || {}
    const keys = Object.keys(timeouts)
    if (keys.length === 0) return

    keys.forEach(k => {
      const e = timeouts[k]
      if (!e || !e.player) return

  const player = e.player
  const ts = e.ts || Date.now()
  // try to resolve a display name from room state players list
  const playerObj = (state.players || []).find(p => p.id === player)
  const playerName = (playerObj && playerObj.name) ? playerObj.name : player

  // If we've recently processed a timeout for this player, skip to avoid dupes.
  // Prefer comparing the originating turnStartedAt when present so a single timed-out turn only yields one penalty.
  const seen = processedTimeoutPlayersRef.current[player] || {}
  const seenTurn = seen.turnStartedAt
  if (e.turnStartedAt && seenTurn && e.turnStartedAt === seenTurn) return
  // fallback: skip if we've processed a timeout with very similar ts recently
  const last = seen.ts || 0
  if (!e.turnStartedAt && Math.abs(ts - last) < 5000) return

  // mark processed for this player (store both ts and turnStartedAt when available)
  processedTimeoutPlayersRef.current[player] = { ts, turnStartedAt: e.turnStartedAt || null }

    // don't re-show the same timeout entry's toast repeatedly
    if (processedTimeoutKeysRef.current[k]) return
    processedTimeoutKeysRef.current[k] = true

    // show toast
    const toastId = `${k}`
  const toast = { id: toastId, text: `-2 hangmoney for ${playerName} (timed out)` }
    setToasts(t => [...t, toast])
      // auto-remove toast after 4s
      setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 4000)

      // set a visual marker for pending deduction and record the expected hangmoney
      if (e && typeof e.deducted === 'number') {
        // compute current hangmoney for this player from the in-memory state if possible
        const playerObj = (state.players || []).find(p => p.id === player) || {}
        const currentHang = Number(playerObj.hangmoney) || 0
        const expectedAfter = currentHang - e.deducted
        expectedHangRef.current[player] = expectedAfter
        // store the negative delta for UI display (e.g. -2)
        setPendingDeducts(prev => ({ ...prev, [player]: (prev[player] || 0) - e.deducted }))
        // DO NOT auto-clear after a fixed timeout here — wait until DB reflects the change (see effect below)
      }
    })
    // Show recent gain events (e.g., when someone gets +2 because another player's guess was wrong)
    try {
      (state.players || []).forEach(p => {
        const lg = p.lastGain
        if (lg && lg.amount && lg.ts) {
          const key = `lg_${p.id}_${lg.ts}`
          if (!multiHitSeenRef.current[key]) {
            multiHitSeenRef.current[key] = true
            const toastId = `lg_${Date.now()}`
            setToasts(t => [...t, { id: toastId, text: `${p.name} gained +${lg.amount} (${lg.reason === 'wrongGuess' ? 'from wrong guess' : 'bonus'})`, fade: true }])
            // schedule fade and removal
            setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 2500)
            setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3500)
          }
        }
      })
    } catch (e) {}

    // Show a generic fading toast for any positive hangmoney deltas (covers cases where server
    // updated hangmoney directly without writing lastGain). Use prevHangRef to avoid showing
    // toasts on initial load.
    try {
      (state.players || []).forEach(p => {
        const pid = p.id
        const prev = typeof prevHangRef.current[pid] === 'number' ? prevHangRef.current[pid] : null
        const nowVal = typeof p.hangmoney === 'number' ? p.hangmoney : 0
        if (prev !== null && nowVal > prev) {
          const delta = nowVal - prev
          const toastId = `gain_${pid}_${Date.now()}`
          setToasts(t => [...t, { id: toastId, text: `${p.name} gained +${delta}`, fade: true }])
          setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 2500)
          setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3500)
        }
        // record current for next comparison
        prevHangRef.current[pid] = nowVal
      })
    } catch (e) {}
  }, [state])

  // clear pending deductions when we observe the DB has applied the hangmoney change
  useEffect(() => {
    if (!state || !state.players) return
    const updated = { ...pendingDeducts }
    let changed = false
    Object.keys(expectedHangRef.current || {}).forEach(pid => {
      const expected = expectedHangRef.current[pid]
      const p = (state.players || []).find(x => x.id === pid)
      if (!p) return
      const actual = Number(p.hangmoney) || 0
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
  const myId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
  const currentTurnIndex = state?.currentTurnIndex || 0
  const currentTurnId = (state?.turnOrder || [])[currentTurnIndex]
  // derive some end-of-game values and visual pieces at top-level so hooks are not called conditionally
  // derive viewer name from server state if available (covers refresh cases)
  const myNode = (state?.players || []).find(p => p.id === myId) || {}
  const myName = myNode.name || playerName
  // consider the viewer a winner if the room's winnerId matches their id,
  // or if the stored winnerName equals their effective name (covers legacy rooms)
  const isWinner = (state?.winnerId && myId && state.winnerId === myId) || (state?.winnerName && state.winnerName === myName)
  // compute standings by hangmoney desc as a best-effort ranking
  const standings = (state?.players || []).slice().sort((a,b) => (b.hangmoney || 0) - (a.hangmoney || 0))

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
    if (!state?.winnerByHangmoney) return []
    return new Array(28).fill(0).map(() => ({
      left: Math.random() * 100,
      // stagger delays up to ~1.6s like confetti
      delay: Math.random() * 1.6,
      rotate: Math.random() * 360,
      // start slightly above the top using vh so viewport-relative
      topVh: -2 - (Math.random() * 6)
    }))
  }, [state?.winnerByHangmoney])

  

  const modeBadge = (
    <div style={{ position: 'fixed', right: 18, top: 18, zIndex: 9999 }}>
      <div className="mode-badge card" style={{ padding: '6px 10px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid rgba(34,139,34,0.12)' }}>
  <span style={{ fontSize: 16 }}>{state?.winnerByHangmoney ? '💸' : '🛡️'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: '1' }}>
            <strong style={{ fontSize: 13 }}>{state?.winnerByHangmoney ? 'Winner: Most hangmoney' : 'Winner: Last one standing'}</strong>
            <small style={{ color: '#666', fontSize: 12 }}>{state?.winnerByHangmoney ? 'Money wins' : 'Elimination wins'}</small>
          </div>
          {/* show a rocket badge when power-ups are enabled and visible to all players in the lobby */}
          {state?.powerUpsEnabled && phase === 'lobby' && (
            <div title="Power-ups are enabled" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="powerup-rocket" style={{ fontSize: 18 }}>🚀</span>
              <small style={{ color: '#666', fontSize: 12 }}>Power-ups</small>
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
      await dbUpdate(roomRef, changes)
    } catch (e) {
      console.warn('Could not update room settings', e)
    }
  }

  // (Settings gear moved into the modeBadge) helper removed

  function SettingsModal({ open, onClose }) {
    if (!open) return null
    // immediate update: write minWordSize on change to avoid spinner revert issues

    return (
      <div className="settings-modal" style={{ position: 'fixed', right: 18, top: 64, width: 360, zIndex: 10001 }}>
        <div className="card" style={{ padding: 12, maxHeight: '70vh', overflow: 'auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Room settings</strong>
            <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }} aria-label="Close settings">✖</button>
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="timedMode">
              <input id="timedMode" name="timedMode" type="checkbox" checked={timedMode} onClick={e => { e.stopPropagation(); const nv = !timedMode; setTimedMode(nv); updateRoomTiming(nv, turnSeconds); updateRoomSettings({ timed: !!nv, turnTimeoutSeconds: nv ? turnSeconds : null }) }} /> Timed game
            </label>
            {timedMode && (
              <label htmlFor="turnSeconds">
                Seconds per turn:
                <input id="turnSeconds" name="turnSeconds" type="number" min={10} max={300} value={turnSeconds} onChange={e => { const v = Math.max(10, Math.min(300, Number(e.target.value || 30))); setTurnSeconds(v); updateRoomTiming(timedMode, v); updateRoomSettings({ turnTimeoutSeconds: v }) }} style={{ width: 100, marginLeft: 8 }} />
              </label>
            )}
            <label htmlFor="starterEnabled" title="When enabled, a single random 'starter' requirement will be chosen when the game starts. Players whose submitted word meets the requirement receive +10 bonus hangmoney.">
              <input id="starterEnabled" name="starterEnabled" type="checkbox" checked={starterEnabled} onClick={e => { e.stopPropagation(); const nv = !starterEnabled; setStarterEnabled(nv); updateRoomSettings({ starterBonus: { enabled: !!nv, description: state?.starterBonus?.description || '' } }) }} /> Starter bonus
            </label>
            <label htmlFor="winnerByHangmoney" title="Choose how the winner is determined: Last one standing, or player with most hangmoney.">
              <input id="winnerByHangmoney" name="winnerByHangmoney" type="checkbox" checked={winnerByHangmoney} onClick={e => { e.stopPropagation(); const nv = !winnerByHangmoney; setWinnerByHangmoney(nv); updateRoomWinnerMode(nv); updateRoomSettings({ winnerByHangmoney: !!nv }) }} /> Winner by money
            </label>
            <label htmlFor="powerUpsEnabled" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title="Enable in-game power ups such as revealing letter counts or the starting letter.">
              <input id="powerUpsEnabled" name="powerUpsEnabled" type="checkbox" checked={powerUpsEnabled} onClick={e => { e.stopPropagation(); const nv = !powerUpsEnabled; setPowerUpsEnabled(nv); updateRoomSettings({ powerUpsEnabled: !!nv }) }} /> Power-ups
              <div style={{ fontSize: 12, color: '#666' }} onMouseEnter={() => { /* tooltip handled via title attr */ }}>ⓘ</div>
            </label>
              <label htmlFor="minWordSize" title="Minimum allowed word length for submissions (2-10)">
                Min word length:
                <input id="minWordSize" name="minWordSize" type="number" min={2} max={10} value={minWordSize} onChange={e => { const v = Math.max(2, Math.min(10, Number(e.target.value || 2))); setMinWordSize(v); updateRoomSettings({ minWordSize: v }) }} style={{ width: 80, marginLeft: 8 }} />
              </label>
          </div>
        </div>
      </div>
    )
  }

  // Power-up definitions
  const POWER_UPS = [
    { id: 'letter_for_letter', name: 'Letter for a Letter', price: 2, desc: "Reveals a random letter from your word and your opponent's word. You can't guess the revealed letter in your opponent's word for points, but if the letter appears more than once, you can still guess the other occurrences for points. Your opponent can guess the letter revealed from your word." },
    { id: 'vowel_vision', name: 'Vowel Vision', price: 3, desc: 'Tells you how many vowels the word contains.' },
    { id: 'letter_scope', name: 'Letter Scope', price: 3, desc: 'Find out how many letters the word has.' },
    { id: 'one_random', name: 'One Random Letter', price: 3, desc: 'Reveal one random letter. It may be a letter that is already revealed! You can guess this letter to get points next turn, if it is not already revealed!' },
    { id: 'mind_leech', name: 'Mind Leech', price: 3, desc: "The letters that are revealed from your word will be used to guess your opponent's word. You can guess these letter to get points next turn, if it is not already revealed!" },
    { id: 'zeta_drop', name: 'Zeta Drop', price: 5, desc: 'Reveal the last letter of the word. You can\'t guess this letter to get points next turn, if there is only one occurrence of it.' },
    { id: 'letter_peek', name: 'Letter Peek', price: 5, desc: 'Pick a position and reveal that specific letter.' },
  { id: 'related_roast', name: 'Related Word', price: 5, desc: 'Get a related word.' },
    { id: 'sound_check', name: 'Sound Check', price: 6, desc: 'Suggests a word that sounds like the target word.' },
    { id: 'dice_of_doom', name: 'Dice of Doom', price: 7, desc: 'Rolls a dice and reveals that many letters at random.' },
    { id: 'what_do_you_mean', name: 'What Do You Mean', price: 7, desc: 'Suggests words with similar meaning.' },
    { id: 'all_letter_reveal', name: 'All The Letters', price: 8, desc: 'Reveal all letters in shuffled order.' },
    { id: 'full_reveal', name: 'Full Reveal', price: 9, desc: 'Reveal the entire word instantly, in order.' }
  ]

  // helper to perform a power-up purchase; writes to DB private entries and deducts hangmoney
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
    const cost = pu.price
    // check buyer hangmoney
    const me = (state?.players || []).find(p => p.id === myId) || {}
    const myHang = Number(me.hangmoney) || 0
    if (myHang - cost < 0) {
      setToasts(t => [...t, { id: `pup_err_money_${Date.now()}`, text: 'Not enough hangmoney to buy that power-up.' }])
      return
    }
    setPowerUpLoading(true)
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const updates = {}
      // deduct buyer hangmoney
      updates[`players/${myId}/hangmoney`] = myHang - cost
      // write a private entry for buyer and target so only they see the result
      const key = `pu_${Date.now()}`
      // store under players/{buyer}/privatePowerReveals/{targetId}/{key} = { powerId, data }
      const data = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
      // attach additional results after computing
      // perform server-side or client-side compute for power-up results
      let resultPayload = null
      // compute some client-side results for immediate write when possible
      const targetNode = (state?.players || []).find(p => p.id === powerUpTarget) || {}
      const targetWord = targetNode.word || ''
      if (powerId === 'letter_scope') {
        resultPayload = { letters: (targetWord || '').length }
      } else if (powerId === 'zeta_drop') {
        resultPayload = { last: targetWord ? targetWord.slice(-1) : null }
      } else if (powerId === 'vowel_vision') {
        const vowels = (targetWord.match(/[aeiou]/ig) || []).length
        resultPayload = { vowels }
      } else if (powerId === 'one_random') {
        const letters = (targetWord || '').split('')
        if (letters.length > 0) {
          const ch = letters[Math.floor(Math.random() * letters.length)]
          resultPayload = { letter: ch }
        } else resultPayload = { letter: null }
      } else if (powerId === 'letter_peek') {
        const pos = Number(opts.pos) || 0
        // human-readable short messages; explicitly report no letter at position when invalid
        if (!pos || pos < 1) {
          resultPayload = { message: `Letter peek: no letter at position ${opts.pos || pos}`, pos }
        } else {
          const letter = (targetWord && targetWord[pos-1]) ? targetWord[pos-1] : null
          if (!letter) resultPayload = { message: `Letter peek: no letter at position ${pos}`, pos }
          else resultPayload = { message: `Letter peek: '${letter}' at position ${pos}`, letter, pos }
        }
      } else if (powerId === 'related_roast') {
        // Related Roast: use Datamuse rel_trg (related target words) and return a short roast word
        try {
          const q = encodeURIComponent(targetWord || '')
          const url = `https://api.datamuse.com/words?rel_trg=${q}&max=6`
          const res = await fetch(url)
          if (res && res.ok) {
            const list = await res.json()
            const words = Array.isArray(list) ? list.map(i => i.word).filter(Boolean) : []
            const candidate = words.find(w => w.toLowerCase() !== (targetWord || '').toLowerCase())
            if (candidate) resultPayload = { message: `Related roast: '${candidate}'` }
            else resultPayload = { message: 'Related roast: no result' }
          } else resultPayload = { message: 'Related roast: no result' }
        } catch (e) {
          resultPayload = { message: 'Related roast: no result' }
        }
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
        resultPayload = { roll, indices }
      } else if (powerId === 'all_letter_reveal') {
        resultPayload = { letters: (targetWord || '').split('').sort(() => Math.random()-0.5) }
        // also reveal all letters publicly (but shuffled order is kept in private payload)
        const existingAll = targetNode.revealed || []
        const allLetters = Array.from(new Set(((targetWord || '').toLowerCase().split('').filter(Boolean))))
        updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existingAll || []), ...allLetters]))
      } else if (powerId === 'full_reveal') {
        resultPayload = { full: targetWord }
        // reveal whole word publicly
        const existingFull = targetNode.revealed || []
        const allLettersFull = Array.from(new Set(((targetWord || '').toLowerCase().split('').filter(Boolean))))
        updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existingFull || []), ...allLettersFull]))
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
            const url = `https://api.datamuse.com/words?ml=${q}&max=6`
            const res = await fetch(url)
            if (res && res.ok) {
              const list = await res.json()
              const words = (Array.isArray(list) ? list.map(i => i.word).filter(Boolean) : []).slice(0,6)
              resultPayload = { suggestions: words }
            } else {
              resultPayload = { suggestions: [] }
            }
          }
        } catch (e) {
          resultPayload = { suggestions: [] }
        }
      } else if (powerId === 'mind_leech') {
        // Mind leech: use letters others have guessed for the buyer's own word
        // (buyerNode.guessedBy keys) to simulate those same guesses against the target's word.
        try {
          const buyerNode = (state?.players || []).find(p => p.id === myId) || {}
          const guessedBy = buyerNode.guessedBy || {}
          // keys in guessedBy map are letters (or '__word'); ignore '__word'
          const attemptedLetters = Object.keys(guessedBy || {}).filter(k => k && k !== '__word').map(k => k.toLowerCase())
          // de-dupe
          const attemptedSet = new Set(attemptedLetters)
          const letters = (targetWord || '').toLowerCase().split('')
          const found = []
          attemptedSet.forEach(l => {
            const count = letters.filter(ch => ch === l).length
            if (count > 0) found.push({ letter: l, count })
          })
          resultPayload = { found, attempted: Array.from(attemptedSet) }
        } catch (e) {
          resultPayload = { found: [], attempted: [] }
        }
      } else if (powerId === 'letter_for_letter') {
        // reveal one random letter from the target's word publicly (no-score),
        // AND privately reveal one random letter from the buyer's own word to the target.
        const targetLetters = (targetWord || '').split('')
        const tletter = targetLetters.length > 0 ? targetLetters[Math.floor(Math.random() * targetLetters.length)] : null
        // prepare asymmetric payloads
        let buyerResultPayload = null // what buyer (myId) will see about the target
        let targetResultPayload = null // what target will see about the buyer
        if (tletter) {
          const lower = tletter.toLowerCase()
          const existing = targetNode.revealed || []
          // add the letter to target's revealed publicly
          updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existing || []), lower]))
          // mark this letter as a no-score reveal so guesses won't award points for it
          updates[`players/${powerUpTarget}/noScoreReveals/${lower}`] = true
          // buyer sees the target letter
          buyerResultPayload = { letterFromTarget: tletter }
        }
        // compute a random letter from buyer's own word to reveal privately to the target
        try {
          const buyerNode = (state?.players || []).find(p => p.id === myId) || {}
          const buyerWord = buyerNode.word || ''
          const bLetters = (buyerWord || '').split('')
          const bletter = bLetters.length > 0 ? bLetters[Math.floor(Math.random() * bLetters.length)] : null
          if (bletter) targetResultPayload = { letterFromBuyer: bletter }
        } catch (e) {
          // ignore
        }
        // assign a combined resultPayload for the generic 'data' in case it's used elsewhere
        resultPayload = { targetReveal: buyerResultPayload, buyerReveal: targetResultPayload }
      }

      // For special asymmetric cases (letter_for_letter, vowel_vision) write different payloads to each recipient
      if (powerId === 'letter_for_letter') {
        const base = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
        // create short human-readable messages so the viewer sees concise info
        const buyerResult = (resultPayload && resultPayload.targetReveal) ? resultPayload.targetReveal : null
        const targetResult = (resultPayload && resultPayload.buyerReveal) ? resultPayload.buyerReveal : null
        const buyerMsg = buyerResult && buyerResult.letterFromTarget ? { message: `Letter revealed from ${playerIdToName[powerUpTarget] || powerUpTarget}: '${buyerResult.letterFromTarget}'`, letterFromTarget: buyerResult.letterFromTarget } : null
        const targetMsg = targetResult && targetResult.letterFromBuyer ? { message: `Letter revealed from ${playerIdToName[myId] || myId}: '${targetResult.letterFromBuyer}'`, letterFromBuyer: targetResult.letterFromBuyer } : null
        const buyerData = { ...base, result: buyerMsg }
        const targetData = { ...base, result: targetMsg }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
      } else if (powerId === 'vowel_vision') {
        // Include a human-readable message for buyer and target, visible only to them
        const vowels = (resultPayload && typeof resultPayload.vowels === 'number') ? resultPayload.vowels : (targetWord.match(/[aeiou]/ig) || []).length
        const buyerName = playerIdToName[myId] || myId
        const targetName = playerIdToName[powerUpTarget] || powerUpTarget
        const msg = `${buyerName} used Vowel Vision on ${targetName} to see that there are ${vowels} vowel${vowels === 1 ? '' : 's'}`
        const base = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
        const buyerData = { ...base, result: { vowels, message: msg } }
        const targetData = { ...base, result: { vowels, message: msg } }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
      } else {
        data.result = resultPayload
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = data
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = data
      }

      // For some reveal types we should also update the target's revealed array so letters are visible to both
      if (resultPayload && resultPayload.indices && Array.isArray(resultPayload.indices)) {
        // add those letters to target's revealed set
        const existing = targetNode.revealed || []
        const toAdd = resultPayload.indices.map(i => (targetWord[i] || '').toLowerCase()).filter(Boolean)
        const newRevealed = Array.from(new Set([...(existing || []), ...toAdd]))
        updates[`players/${powerUpTarget}/revealed`] = newRevealed
        // ensure buyer also sees these via their privateHits? keep the private reveal in privatePowerReveals
      }

      // For zeta_drop, letter_peek, one_random, all_letter_reveal, full_reveal we may want to reveal to target.revealed
      if (resultPayload && resultPayload.last) {
        const existing = targetNode.revealed || []
        const add = (resultPayload.last || '').toLowerCase()
        if (add) updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existing || []), add]))
      }

      // Also advance the turn immediately after a power-up is applied (end the buyer's turn)
      try {
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
            const prevNextHang = (typeof nextNode.hangmoney === 'number') ? nextNode.hangmoney : 0
            updates[`players/${nextPlayer}/hangmoney`] = prevNextHang + 1
          } catch (e) {}
        }
      } catch (e) {}

      // Finally perform the update
      await dbUpdate(roomRef, updates)
      // add a dismissible success toast for power-up application
      const pupToastId = `pup_ok_${Date.now()}`
      setToasts(t => [...t, { id: pupToastId, text: `${pu.name} applied to ${playerIdToName[powerUpTarget] || powerUpTarget}` }])
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
  useEffect(() => {
    if (!powerUpOpen) return
    // small next-tick focus to ensure the input exists in the DOM
    const t = setTimeout(() => {
      try {
        const el = powerUpChoiceRef.current
        if (el && typeof el.focus === 'function') {
          el.focus()
          // move caret to end
          const len = (el.value || '').length
          if (typeof el.setSelectionRange === 'function') el.setSelectionRange(len, len)
        }
      } catch (e) {}
    }, 0)
    return () => clearTimeout(t)
  }, [powerUpOpen, powerUpTarget, powerUpChoiceValue])

  // When the power-up modal is open, add a body-level class to pause site animations
  useEffect(() => {
    try {
      if (powerUpOpen) document.body.classList.add('modal-open')
      else document.body.classList.remove('modal-open')
    } catch (e) {}
    return () => { try { document.body.classList.remove('modal-open') } catch (e) {} }
  }, [powerUpOpen])

  function PowerUpModal({ open, targetId, onClose }) {
    if (!open || !targetId) return null
    const targetName = playerIdToName[targetId] || targetId
    const me = (state?.players || []).find(p => p.id === myId) || {}
    const myHang = Number(me.hangmoney) || 0
    return (
      <div className="modal-overlay shop-modal" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10002 }}>
        <div className="modal-dialog card no-anim shop-modal-dialog" style={{ maxWidth: 720, width: 'min(92%,720px)', maxHeight: '90vh', overflow: 'auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Power-ups for {targetName}</strong>
            <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>✖</button>
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {POWER_UPS.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 8, borderRadius: 8, background: 'rgba(0,0,0,0.03)' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{p.name} <small style={{ color: '#666', marginLeft: 8 }}>{p.desc}</small></div>
                  <div style={{ fontSize: 13, color: '#777' }}>{p.price} 🪙</div>
                </div>
                <div>
                  {p.id === 'letter_peek' ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input ref={powerUpChoiceRef} id={`powerup_${p.id}_choice`} name={`powerup_${p.id}_choice`} placeholder="position" value={powerUpChoiceValue} onChange={e => setPowerUpChoiceValue(e.target.value)} style={{ width: 84 }} />
                        <button disabled={powerUpLoading || myHang < p.price} onClick={() => purchasePowerUp(p.id, { pos: powerUpChoiceValue })}>{powerUpLoading ? '...' : 'Buy'}</button>
                      </div>
                    ) : (
                    <button disabled={powerUpLoading || myHang < p.price} onClick={() => purchasePowerUp(p.id)}>{powerUpLoading ? '...' : 'Buy'}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  

  // Component: host-only Play Again / Restart controls
  function PlayAgainControls({ isHost, myId, players }) {
    const [submitting, setSubmitting] = useState(false)

    // Host-only restart: reset per-player words, hangmoney, submission flags, clear wantsRematch, and set phase to 'waiting'
    async function restartForAll() {
      if (!isHost) return
      try {
        setSubmitting(true)
        setIsResetting(true)

  const updates = { phase: 'lobby', open: true }
        ;(players || []).forEach(p => {
          updates[`players/${p.id}/wantsRematch`] = null
          updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          updates[`players/${p.id}/hangmoney`] = 2
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

    if (!isHost) {
      // Non-hosts only see a passive message
      return <div style={{ color: '#2e7d32' }}>Waiting for the host to restart the room.</div>
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
        const updates = { phase: 'lobby', open: true }
        playersArr.forEach(p => {
          updates[`players/${p.id}/wantsRematch`] = null
          updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          // Clear power-up state as part of rematch reset so old results don't persist
          updates[`players/${p.id}/privatePowerReveals`] = null
          updates[`players/${p.id}/privatePowerUps`] = null
          updates[`players/${p.id}/noScoreReveals`] = null
          // preserve hangmoney if you want; here we leave it as-is so clients control their own reset
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
    const candidate = (w || '').toString().trim().toLowerCase()
    if (!/^[a-z]+$/.test(candidate)) return false
    try {
      // Primary check: dictionaryapi.dev (free, broad coverage)
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${candidate}`)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data) && data.length > 0) return true
      }

      // Fallback: Datamuse (no API key, good lexical coverage)
      // Use an exact-spelling query and check if it returns the same word
      try {
        const dm = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(candidate)}&max=1`)
        if (dm.ok) {
          const ddata = await dm.json()
          if (Array.isArray(ddata) && ddata.length > 0 && ddata[0].word && ddata[0].word.toLowerCase() === candidate) {
            return true
          }
        }
      } catch (e2) {
        // ignore datamuse failure and fall through
      }

      // If neither service affirmed the word, treat as non-word
      return false
    } catch (e) {
      console.warn('Dictionary check encountered an error, allowing word by default', e)
      // network failsafe: allow submission so users aren't blocked by lookup flakiness
      return true
    }
  }

  function TimerWatcher({ roomId, state }) {
    const [tick, setTick] = useState(0)
    useEffect(() => {
      const id = setInterval(() => setTick(t => t + 1), 300)
      return () => clearInterval(id)
    }, [])

    useEffect(() => {
      if (!state || !state.timed || !state.turnTimeoutSeconds || !state.currentTurnStartedAt) return
      const msLeft = state.currentTurnStartedAt + (state.turnTimeoutSeconds*1000) - Date.now()
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
          if (debug) console.log('TimerWatcher: writing timeout', { roomId, tkey, timedOutPlayer, expiredTurnStartedAt: r.currentTurnStartedAt || null })
          await dbUpdate(roomRef, updates)
        }).catch(e => console.warn('Could not advance turn on timeout', e))
      }
    }, [tick, state, roomId])

    return null
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
    // perform dictionary check (may be slow) and show a small spinner state
    setIsCheckingDictionary(true)
    const ok = await isEnglishWord(candidate)
    setIsCheckingDictionary(false)
    if (!ok) {
      setWordError("That doesn't look like an English word. Please pick another.")
      return
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
        {modeBadge}
        <div className={`victory-screen ${isWinner ? 'confetti' : 'sad'}`}>
          {isWinner && confettiPieces.map((c, i) => (
            <span key={i} className="confetti-piece" style={{ left: `${c.left}%`, width: c.size, height: c.size * 1.6, background: c.color, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s` }} />
          ))}
          {state?.winnerByHangmoney && cashPieces.map((c, i) => (
            <span key={`cash-${i}`} className="cash-piece" style={{ left: `${c.left}%`, top: `${c.top}px`, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s`, position: 'absolute' }} />
          ))}

          <h1>{isWinner ? '🎉 You Win! 🎉' : `😢 ${state?.winnerName} Wins`}</h1>
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
                    </div>
                    <div style={{ fontWeight: 800 }}>
                      <span style={{ background: '#f3f3f3', color: p.id === state?.winnerId ? '#b8860b' : '#222', padding: '6px 10px', borderRadius: 16, display: 'inline-block', minWidth: 48, textAlign: 'center' }}>
                        ${p.hangmoney || 0}{p.id === state?.winnerId ? ' (winner)' : ''}
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
            <div style={{ color: '#ddd' }}>If everyone clicks Play again, the room will reset automatically.</div>
          </div>
        </div>
      </>
    )
  }

  return (
    <div className={`game-room ${state && state.winnerByHangmoney ? 'money-theme' : ''}`}>
      {modeBadge}
  {phase === 'lobby' && <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />}
      {phase === 'lobby' && <h2>Room: {roomId}</h2>}
      {phase === 'lobby' && (
        <div style={{ display: 'inline-block' }}>
          <div style={{ marginBottom: 8 }}>
            {isHost ? (
              <>
                <label style={{ marginRight: 12 }}>
                  <input id="timedMode_view" name="timedMode_view" type="checkbox" checked={timedMode} onChange={e => { setTimedMode(e.target.checked); updateRoomTiming(e.target.checked, turnSeconds) }} /> Timed mode
                </label>
                <label style={{ marginRight: 12 }} title="When enabled, a single random 'starter' requirement will be chosen when the game starts. Players whose submitted word meets the requirement receive +10 bonus hangmoney.">
                  <input id="starterEnabled_view" name="starterEnabled_view" type="checkbox" checked={starterEnabled} onChange={e => setStarterEnabled(e.target.checked)} /> Starter bonus
                </label>
                <label style={{ marginRight: 12 }} title="Choose how the winner is determined: Last one standing (default) or player with most hangmoney. Visible to all players.">
                  <input id="winnerByHangmoney_view" name="winnerByHangmoney_view" type="checkbox" checked={winnerByHangmoney} onChange={e => { setWinnerByHangmoney(e.target.checked); updateRoomWinnerMode(e.target.checked) }} /> Winner by money
                </label>
                {timedMode && (
                  <label>
                    Seconds per turn:
                    <input id="turnSeconds_view" name="turnSeconds_view" type="number" min={10} max={300} value={turnSeconds} onChange={e => { setTurnSeconds(Math.max(10, Math.min(300, Number(e.target.value || 30)))); updateRoomTiming(timedMode, Math.max(10, Math.min(300, Number(e.target.value || 30)))) }} style={{ width: 80, marginLeft: 8 }} />
                  </label>
                )}
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
                onClick={() => startGame(timedMode ? { timed: true, turnSeconds, starterEnabled, winnerByHangmoney } : { starterEnabled, winnerByHangmoney })}
                disabled={players.length < 2}
                title={players.length < 2 ? 'Need at least 2 players to start' : ''}
                className={players.length >= 2 ? 'start-ready' : ''}
              >Start game</button>
              {players.length < 2 && <div style={{ fontSize: 13, color: '#7b6f8a', marginTop: 6 }}>Waiting for more players to join (need 2+ players)</div>}
            </>
          ) : null}
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

      <div className="circle">
        {players.length === 0 && <div>No players yet — wait for others to join.</div>}
        <div className="turn-indicator">Current turn: {players.find(p => p.id === currentTurnId)?.name || '—'}</div>
        {phase === 'playing' && state?.timed && state?.turnTimeoutSeconds && state?.currentTurnStartedAt && (
          <div className="turn-timer">
            <div className="bar"><div className="fill" style={{ width: `${Math.max(0, (state?.currentTurnStartedAt + (state?.turnTimeoutSeconds*1000) - Date.now()) / (state?.turnTimeoutSeconds*1000) * 100)}%` }} /></div>
            <div className="time">{(() => {
              const msLeft = Math.max(0, (state?.currentTurnStartedAt || 0) + ((state?.turnTimeoutSeconds || 0)*1000) - Date.now())
              const s = Math.ceil(msLeft / 1000)
              return `${s}s`
            })()}</div>
          </div>
        )}
        {(() => {
          // defensive: ensure players is an array of objects (some DB writes may briefly produce non-object entries)
          const sanitized = (players || []).filter(x => x && typeof x === 'object')
          if (sanitized.length !== (players || []).length) {
            try { console.warn('GameRoom: filtered invalid player entries from state.players', { rawPlayers: players, stateSnapshot: state }) } catch (e) {}
          }
          return sanitized.map(p => {
          // derive viewer-specific private data. viewer's node lives under state.players keyed by id — we need to find viewer's full object
          const viewerNode = players.find(x => x.id === myId) || {}
          // viewerNode may contain privateWrong, privateHits, privateWrongWords and private powerup data
          const viewerPrivate = {
            privateWrong: viewerNode.privateWrong || {},
            privateHits: viewerNode.privateHits || {},
            privateWrongWords: viewerNode.privateWrongWords || {},
            privatePowerUps: viewerNode.privatePowerUps || {},
            privatePowerReveals: viewerNode.privatePowerReveals || {}
          }

          // clone player and attach viewer's private data under _viewer so child can render it
          // compute ms left for the current player
          const msLeftForPlayer = (state?.currentTurnStartedAt && state?.turnTimeoutSeconds && state?.timed && currentTurnId === p.id)
            ? Math.max(0, (state?.currentTurnStartedAt || 0) + ((state?.turnTimeoutSeconds || 0)*1000) - Date.now())
            : null

          const playerWithViewer = { ...p, _viewer: viewerPrivate }

          const wasPenalized = Object.keys(state?.timeouts || {}).some(k => (state?.timeouts && state.timeouts[k] && state.timeouts[k].player) === p.id && recentPenalty[k])
          // determine why the power-up button should be disabled (if anything)
          const powerUpActive = powerUpsEnabled && (myId === currentTurnId) && p.id !== myId && !p.eliminated
          let pupReason = null
          if (!powerUpsEnabled) pupReason = 'Power-ups are disabled'
          else if (p.id === myId) pupReason = 'Cannot target yourself'
          else if (p.eliminated) pupReason = 'Player is eliminated'
          else if (myId !== currentTurnId) pupReason = 'Not your turn'
          else {
            const me = (state?.players || []).find(x => x.id === myId) || {}
            const cheapest = Math.min(...(POWER_UPS || []).map(x => x.price))
            const myHang = Number(me.hangmoney) || 0
            if (myHang < cheapest) pupReason = `Need at least ${cheapest} 🪙 to buy power-ups`
          }

          return (
            <PlayerCircle key={p.id}
                          player={playerWithViewer}
                          isSelf={p.id === myId}
                          viewerId={myId}
                          phase={phase}
                          hasSubmitted={!!p.hasWord}
                          canGuess={phase === 'playing' && myId === currentTurnId && p.id !== myId}
                          onGuess={(targetId, guess) => sendGuess(targetId, guess)} 
                          showPowerUpButton={powerUpsEnabled && (myId === currentTurnId) && p.id !== myId}
                          onOpenPowerUps={(targetId) => { setPowerUpTarget(targetId); setPowerUpOpen(true); setPowerUpChoiceValue('') }}
                          playerIdToName={playerIdToName}
                          timeLeftMs={msLeftForPlayer} currentTurnId={currentTurnId}
                          starterApplied={!!state?.starterBonus?.applied}
                          flashPenalty={wasPenalized}
                          pendingDeduct={pendingDeducts[p.id] || 0}
                          isWinner={p.id === state?.winnerId}
                          powerUpDisabledReason={pupReason} />
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

      {/* Power-up modal rendered when requested */}
      {powerUpOpen && <PowerUpModal open={powerUpOpen} targetId={powerUpTarget} onClose={() => setPowerUpOpen(false)} />}

      {/* Timer tick: client watches for timeout and advances turn if needed (best-effort) */}
        {phase === 'playing' && state?.timed && state?.turnTimeoutSeconds && state?.currentTurnStartedAt && (
        <TimerWatcher roomId={roomId} state={state} />
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
              {state?.starterBonus?.enabled && (
                <div style={{ marginTop: 6, fontSize: 13, color: '#666' }} title={state?.starterBonus?.description}>
                  Starter rule: <strong>{state?.starterBonus?.description}</strong>
                </div>
              )}
              <div className="progress" style={{ marginTop: 8, width: 220 }}>
                <div className="progress-bar" style={{ width: `${(players.length ? (submittedCount / players.length) * 100 : 0)}%`, background: '#4caf50', height: 10, borderRadius: 6 }} />
                <div style={{ marginTop: 6, fontSize: 13 }}>{submittedCount} / {players.length} submitted</div>
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
          {modeBadge}
          <div className={`victory-screen ${isWinner ? 'confetti' : 'sad'}`}>
            {isWinner && confettiPieces.map((c, i) => (
              <span key={i} className="confetti-piece" style={{ left: `${c.left}%`, width: c.size, height: c.size * 1.6, background: c.color, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s` }} />
            ))}
            {state?.winnerByHangmoney && cashPieces.map((c, i) => (
              <span key={`cash-${i}`} className="cash-piece" style={{ left: `${c.left}%`, top: `${c.top}px`, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s`, position: 'absolute' }} />
            ))}

            <h1>{isWinner ? '🎉 You Win! 🎉' : `😢 ${state?.winnerName} Wins`}</h1>
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
                      </div>
                      <div style={{ fontWeight: 800 }}>
                        <span style={{ background: '#f3f3f3', color: p.id === state?.winnerId ? '#b8860b' : '#222', padding: '6px 10px', borderRadius: 16, display: 'inline-block', minWidth: 48, textAlign: 'center' }}>
                          ${p.hangmoney || 0}{p.id === state?.winnerId ? ' (winner)' : ''}
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
              <div style={{ color: '#ddd' }}>If everyone clicks Play again, the room will reset automatically.</div>
            </div>
          </div>
          </>
        )}
      
    </div>
  )
}
