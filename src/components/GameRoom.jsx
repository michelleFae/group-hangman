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
  const [minWordSizeInput, setMinWordSizeInput] = useState(String(2))
  const [startingHangmoney, setStartingHangmoney] = useState(2)
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
  // Pause the tick when the power-up modal is open to avoid frequent re-renders that
  // can interfere with modal scroll position.
  useEffect(() => {
    if (powerUpOpen) return undefined
    const id = setInterval(() => setTick(t => t + 1), 300)
    return () => clearInterval(id)
  }, [powerUpOpen])

  // keep local timed UI in sync with room state (so non-hosts can see current selection)
  useEffect(() => {
    if (state?.timed !== undefined) setTimedMode(!!state.timed);
    if (state?.turnTimeoutSeconds !== undefined) setTurnSeconds(state.turnTimeoutSeconds || 30);
    setWinnerByHangmoney(!!state?.winnerByHangmoney);
    setStarterEnabled(!!state?.starterBonus?.enabled);
    setPowerUpsEnabled(!!state?.powerUpsEnabled);

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

    // ✅ same for starting hangmoney
    if (typeof state?.startingHangmoney === 'number') {
      setStartingHangmoney(Math.max(0, Number(state.startingHangmoney)));
    }

  }, [
    state?.timed,
    state?.turnTimeoutSeconds,
    state?.winnerByHangmoney,
    state?.starterBonus?.enabled,
    state?.powerUpsEnabled,
    state?.minWordSize,
    state?.startingHangmoney
  ]);

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

  // viewer id (derived from hook or firebase auth) — declare early to avoid TDZ in effects
  const myId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)

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
        setToasts(t => [...t, { id: toastId, text: `-2 hangmoney for ${playerName} (timed out)` }])
        setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 4000)

        // pending deduction UI + expected hangmoney
        if (e && typeof e.deducted === 'number') {
          const playerNow = players.find(p => p.id === playerIdTimed) || {}
          const currentHang = Number(playerNow.hangmoney) || 0
          const expectedAfter = currentHang - e.deducted
          expectedHangRef.current[playerIdTimed] = expectedAfter
          setPendingDeducts(prev => ({ ...prev, [playerIdTimed]: (prev[playerIdTimed] || 0) - e.deducted }))
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

    // generic positive hangmoney deltas (uses prevHangRef to avoid initial-load noise)
    try {
      players.forEach(p => {
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
        prevHangRef.current[pid] = nowVal
      })
    } catch (e) {}
  }, [state?.players, state?.timeouts])

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
  const currentTurnIndex = state?.currentTurnIndex || 0
  const currentTurnId = (state?.turnOrder || [])[currentTurnIndex]
  // whether the viewer is the current turn player
  const isMyTurnNow = state && state.turnOrder && typeof state.currentTurnIndex === 'number' && state.turnOrder[state.currentTurnIndex] === myId
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
                <input id="turnSeconds" name="turnSeconds" type="number" min={10} max={300} value={turnSeconds} onChange={e => { const v = Math.max(10, Math.min(300, Number(e.target.value || 30))); setTurnSeconds(v); updateRoomTiming(timedMode, v); updateRoomSettings({ turnTimeoutSeconds: v }) }} style={{ width: 100, marginLeft: 8 }} />
              </label>
            )}
            <label htmlFor="starterEnabled" title="When enabled, a single random 'starter' requirement will be chosen when the game starts. Players whose submitted word meets the requirement receive +10 bonus hangmoney.">
              <input id="starterEnabled" name="starterEnabled" type="checkbox" checked={starterEnabled} onChange={e => { const nv = e.target.checked; setStarterEnabled(nv); updateRoomSettings({ starterBonus: { enabled: !!nv, description: state?.starterBonus?.description || '' } }) }} /> Starter bonus
            </label>
            <label htmlFor="winnerByHangmoney" title="Choose how the winner is determined: Last one standing, or player with most hangmoney.">
              <input id="winnerByHangmoney" name="winnerByHangmoney" type="checkbox" checked={winnerByHangmoney} onChange={e => { const nv = e.target.checked; setWinnerByHangmoney(nv); updateRoomWinnerMode(nv); updateRoomSettings({ winnerByHangmoney: !!nv }) }} /> Winner by money
            </label>
            <label htmlFor="powerUpsEnabled" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title="Enable in-game power ups such as revealing letter counts or the starting letter.">
              <input id="powerUpsEnabled" name="powerUpsEnabled" type="checkbox" checked={powerUpsEnabled} onChange={e => { const nv = e.target.checked; setPowerUpsEnabled(nv); updateRoomSettings({ powerUpsEnabled: !!nv }) }} /> Power-ups
              <div style={{ fontSize: 12, color: '#666' }} onMouseEnter={() => { /* tooltip handled via title attr */ }}>ⓘ</div>
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
              <label htmlFor="startingHangmoney" title="Starting hangmoney for each player when the room is reset">
                Starting hangmoney:
                <input id="startingHangmoney" name="startingHangmoney" type="number" min={0} max={999} value={startingHangmoney} onChange={e => { const v = Math.max(0, Number(e.target.value || 0)); setStartingHangmoney(v); updateRoomSettings({ startingHangmoney: v }) }} style={{ width: 80, marginLeft: 8 }} disabled={!isHost} />
              </label>
          </div>
        </div>
      </div>
    )
  }

  // Power-up definitions
  const POWER_UPS = [
    { id: 'letter_for_letter', name: 'Letter for a Letter', price: 2, desc: "Reveals a random letter from your word and your opponent's word. You can't guess the revealed letter in your opponent's word for points, but if the letter appears more than once, you can still guess the other occurrences for points. Your opponent can guess the letter revealed from your word.", powerupType: 'singleOpponentPowerup' },
    { id: 'vowel_vision', name: 'Vowel Vision', price: 3, desc: 'Tells you how many vowels the word contains.', powerupType: 'singleOpponentPowerup' },
    { id: 'letter_scope', name: 'Letter Scope', price: 3, desc: 'Find out how many letters the word has.', powerupType: 'singleOpponentPowerup' },
    { id: 'one_random', name: 'One Random Letter', price: 3, desc: 'Reveal one random letter. It may be a letter that is already revealed! You can guess this letter to get points next turn, if it is not already revealed!', powerupType: 'singleOpponentPowerup' },
    { id: 'mind_leech', name: 'Mind Leech', price: 3, desc: "The letters that are revealed from your word will be used to guess your opponent's word. You can guess these letter to get points next turn, if it is not already revealed!", powerupType: 'singleOpponentPowerup' },
    { id: 'zeta_drop', name: 'Zeta Drop', price: 5, desc: 'Reveal the last letter of the word. You can\'t guess this letter to get points next turn, if there is only one occurrence of it.', powerupType: 'singleOpponentPowerup' },
    { id: 'letter_peek', name: 'Letter Peek', price: 5, desc: 'Pick a position and reveal that specific letter.', powerupType: 'singleOpponentPowerup' },
  { id: 'related_word', name: 'Related Word', price: 5, desc: 'Get a related word.', powerupType: 'singleOpponentPowerup' },
    { id: 'sound_check', name: 'Sound Check', price: 6, desc: 'Suggests a word that sounds like the target word.', powerupType: 'singleOpponentPowerup' },
    { id: 'dice_of_doom', name: 'Dice of Doom', price: 7, desc: 'Rolls a dice and reveals that many letters at random.', powerupType: 'singleOpponentPowerup' },
    { id: 'what_do_you_mean', name: 'What Do You Mean', price: 7, desc: 'Suggests words with similar meaning.', powerupType: 'singleOpponentPowerup' },
    { id: 'all_letter_reveal', name: 'All The Letters', price: 8, desc: 'Reveal all letters in shuffled order.', powerupType: 'singleOpponentPowerup' },
    { id: 'full_reveal', name: 'Full Reveal', price: 9, desc: 'Reveal the entire word instantly, in order.', powerupType: 'singleOpponentPowerup' }
  ]

  // add self-targeted powerups (available when target is yourself)
  POWER_UPS.push(
    { id: 'word_freeze', name: 'Word Freeze', price: 6, desc: 'Put your word on ice — no one can guess it until your turn comes back around. Players will see your player div freeze.', powerupType: 'selfPowerup' },
    { id: 'double_down', name: 'Double Down', price: 1, desc: 'Stake some hangmoney; next correct guess yields double the stake (or quadruple for 4 occurrences). Lose the stake on a wrong guess.', powerupType: 'selfPowerup' },
    { id: 'hang_shield', name: 'Hang Shield', price: 5, desc: 'Protect yourself — blocks the next attack against you. Only you will know you played it.', powerupType: 'selfPowerup' },
    { id: 'price_surge', name: 'Price Surge', price: 5, desc: 'Increase everyone else\'s shop prices by +2 for the next round.', powerupType: 'selfPowerup' },
    { id: 'crowd_hint', name: 'Crowd Hint', price: 5, desc: 'Reveal one random letter from everyone\'s word, including yours. Letters are revealed publicly and are no-score.', powerupType: 'selfPowerup' },
    { id: 'longest_word_bonus', name: 'Longest Word Bonus', price: 5, desc: 'Grant +10 coins to the player with the longest word. Visible to others when played. One-time per game.', powerupType: 'selfPowerup' }
  )

  // Ensure the UI shows power-ups ordered by price (ascending)
  try { POWER_UPS.sort((a,b) => (Number(a.price) || 0) - (Number(b.price) || 0)) } catch (e) {}

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
    const baseCost = pu.price
    // compute effective cost (account for global price surge set by another player)
    let cost = baseCost
    try {
      const surge = state && state.priceSurge
      if (surge && surge.amount && surge.by !== myId) {
        const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
        const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
        if (active) cost = baseCost + Number(surge.amount || 0)
      }
    } catch (e) {}
    // check buyer hangmoney
    const me = (state?.players || []).find(p => p.id === myId) || {}
    const myHang = Number(me.hangmoney) || 0
    if (myHang - cost < 0) {
      setToasts(t => [...t, { id: `pup_err_money_${Date.now()}`, text: 'Not enough hangmoney to buy that power-up.' }])
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
      // deduct buyer hangmoney
      updates[`players/${myId}/hangmoney`] = myHang - cost
      // write a private entry for buyer and target so only they see the result
      const key = `pu_${Date.now()}`
      // store under players/{buyer}/privatePowerReveals/{targetId}/{key} = { powerId, data }
      const data = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  // accumulate any hangmoney awards for the target here and apply once
  let stagedTargetAwardDelta = 0
  // flag to avoid double-awarding buyer when a power-up-specific award was already applied
  let skipBuyerLetterAward = false
      // attach additional results after computing
      // perform server-side or client-side compute for power-up results
      let resultPayload = null
      // compute some client-side results for immediate write when possible
      const targetNode = (state?.players || []).find(p => p.id === powerUpTarget) || {}
      const targetWord = targetNode.word || ''
      if (powerId === 'letter_scope') {
        resultPayload = { letters: (targetWord || '').length }
      } else if (powerId === 'zeta_drop') {
        const last = targetWord ? targetWord.slice(-1) : null
        resultPayload = { last }
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
      } else if (powerId === 'related_word') {
        // Related word: use Datamuse rel_trg (related target words) and return a short word word
        try {
          const q = encodeURIComponent(targetWord || '')
          const url = `https://api.datamuse.com/words?rel_trg=${q}&max=6`
          const res = await fetch(url)
          if (res && res.ok) {
            const list = await res.json()
            const words = Array.isArray(list) ? list.map(i => i.word).filter(Boolean) : []
            const candidate = words.find(w => w.toLowerCase() !== (targetWord || '').toLowerCase())
            if (candidate) resultPayload = { message: `Related word: '${candidate}'` }
            else resultPayload = { message: 'Related word: no result' }
          } else resultPayload = { message: 'Related word: no result' }
        } catch (e) {
          resultPayload = { message: 'Related word: no result' }
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
        // convert indices to the actual letters so payload exposes letters instead of numeric indices
        const revealedLetters = indices.map(i => (targetWord[i] || '').toLowerCase()).filter(Boolean)
        resultPayload = { roll, letters: revealedLetters }
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
            // what_do_you_mean: fetch a single English definition (dictionaryapi.dev). Do NOT include the word itself in the response.
            try {
              const raw = (targetWord || '').toString().trim()
              if (!raw) {
                resultPayload = { message: "I don't know the definition." }
              } else {
                const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(raw)}`
                try {
                  const dres = await fetch(dictUrl)
                  if (dres && dres.ok) {
                    const ddata = await dres.json()
                    // extract the first sensible definition string from the response
                    let def = null
                    if (Array.isArray(ddata) && ddata.length > 0) {
                      for (const entry of ddata) {
                        if (!entry || !entry.meanings) continue
                        for (const meaning of entry.meanings || []) {
                          if (!meaning || !Array.isArray(meaning.definitions)) continue
                          for (const d of meaning.definitions) {
                            if (d && d.definition && typeof d.definition === 'string' && d.definition.trim().length > 0) {
                              def = d.definition.trim()
                              break
                            }
                          }
                          if (def) break
                        }
                        if (def) break
                      }
                    }
                    if (def) {
                      // remove exact occurrences of the target word (case-insensitive), replace with a neutral token
                      try {
                        const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        const re = new RegExp(`\\b${escaped}\\b`, 'ig')
                        const safe = def.replace(re, 'the word')
                        // keep message concise: single sentence if possible
                        const oneSentence = safe.split(/[\.\!\?]\s/)[0]
                        resultPayload = { message: oneSentence || safe }
                      } catch (e) {
                        resultPayload = { message: def }
                      }
                    } else {
                      resultPayload = { message: "I don't know the definition." }
                    }
                  } else {
                    resultPayload = { message: "I don't know the definition." }
                  }
                } catch (e) {
                  resultPayload = { message: "I don't know the definition." }
                }
              }
            } catch (e) {
              resultPayload = { message: "I don't know the definition." }
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
        // reveal one random letter from the target's word publicly,
        // AND privately reveal one random letter from the buyer's own word to the target.
        // Award points to both players for any newly revealed occurrences (2 hangmoney per occurrence).
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
        // determine awards (they were applied earlier into updates[].hangmoney when applicable)
        // For buyer: if buyerResultPayload.letterFromTarget exists, compute how many occurrences in targetWord
        let buyerAward = 0
        let buyerLetter = null
        if (buyerResultPayload && buyerResultPayload.letterFromTarget) {
          buyerLetter = (buyerResultPayload.letterFromTarget || '').toString()
          const lower = buyerLetter.toLowerCase()
          const count = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === lower).length
          // Only count award if the target did not already have this letter publicly revealed
          const targetExisting = (targetNode && targetNode.revealed) ? targetNode.revealed : []
          const targetExistingSet = new Set((targetExisting || []).map(x => (x || '').toLowerCase()))
          buyerAward = (count > 0 && !targetExistingSet.has(lower)) ? 2 * count : 0
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
          const buyerExisting = (buyerNode && buyerNode.revealed) ? buyerNode.revealed : []
          const buyerExistingSet = new Set((buyerExisting || []).map(x => (x || '').toLowerCase()))
          targetAward = (countB > 0 && !buyerExistingSet.has(lowerB)) ? 2 * countB : 0
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

  // Immediately apply buyer award here to ensure their hangmoney reflects the +2 per newly revealed occurrence
  try {
    if (buyerAward && buyerAward > 0) {
      const meNow = (state?.players || []).find(p => p.id === myId) || {}
      const myHangCurrentNow = Number(meNow.hangmoney) || 0
      const baseAfterCostNow = (typeof updates[`players/${myId}/hangmoney`] !== 'undefined') ? updates[`players/${myId}/hangmoney`] : (myHangCurrentNow - cost)
      updates[`players/${myId}/hangmoney`] = Math.max(0, Number(baseAfterCostNow) + buyerAward)
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
  } catch (e) {}

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
            const prevTargetHangFinal = Number(targetNodeStateFinal.hangmoney) || 0
            const baseTargetFinal = (typeof updates[`players/${powerUpTarget}/hangmoney`] !== 'undefined') ? Number(updates[`players/${powerUpTarget}/hangmoney`]) : prevTargetHangFinal
            updates[`players/${powerUpTarget}/hangmoney`] = Math.max(0, Number(baseTargetFinal) + stagedTargetAwardDelta)
            // Explicitly mark this lastGain as a letter-for-letter award so clients can render a clear message
            updates[`players/${powerUpTarget}/lastGain`] = { amount: stagedTargetAwardDelta, by: myId, reason: 'letter_for_letter', ts: Date.now() }
          }
        } catch (e) {}
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
      if (resultPayload && resultPayload.letters && Array.isArray(resultPayload.letters)) {
        // add those letters to target's revealed set
        const existing = targetNode.revealed || []
        const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
        const toAdd = resultPayload.letters.map(ch => (ch || '').toLowerCase()).filter(Boolean)
        const newRevealed = Array.from(new Set([...(existing || []), ...toAdd]))
        updates[`players/${powerUpTarget}/revealed`] = newRevealed

        // Award points to the buyer for newly revealed letters (2 hangmoney per newly revealed occurrence)
        try {
          const me = (state?.players || []).find(p => p.id === myId) || {}
          const myHangCurrent = Number(me.hangmoney) || 0
          // base hangmoney after paying cost was set earlier; compute fresh base here in case
          const baseAfterCost = (typeof updates[`players/${myId}/hangmoney`] !== 'undefined')
            ? updates[`players/${myId}/hangmoney`]
            : (myHangCurrent - cost)

          let awardTotal = 0
          const prevHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget].slice() : []
          toAdd.forEach(letter => {
            if (!existingSet.has(letter)) {
              // reveal all occurrences of this letter in the target's word and award for each
              const countInWord = (targetWord.toLowerCase().match(new RegExp(letter, 'g')) || []).length
              if (countInWord > 0) {
                awardTotal += 2 * countInWord
                // merge into privateHits for buyer
                let merged = false
                for (let i = 0; i < prevHits.length; i++) {
                  const h = prevHits[i]
                  if (h && h.type === 'letter' && h.letter === letter) {
                    prevHits[i] = { ...h, count: (Number(h.count) || 0) + countInWord, ts: Date.now() }
                    merged = true
                    break
                  }
                }
                if (!merged) prevHits.push({ type: 'letter', letter, count: countInWord, ts: Date.now() })
              }
            }
          })

          if (awardTotal > 0) {
            updates[`players/${myId}/hangmoney`] = Math.max(0, Number(baseAfterCost) + awardTotal)
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
                const myHangCurrent = Number(me.hangmoney) || 0
                const baseAfterCost = (typeof updates[`players/${myId}/hangmoney`] !== 'undefined')
                  ? updates[`players/${myId}/hangmoney`]
                  : (myHangCurrent - cost)
                const award = 2 * count
                updates[`players/${myId}/hangmoney`] = Math.max(0, Number(baseAfterCost) + award)
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
                try {
                  if (powerId === 'zeta_drop') {
                    if (count === 1) updates[`players/${powerUpTarget}/noScoreReveals/${add}`] = true
                  }
                } catch (e) {}
                // mark visible gain
                updates[`players/${myId}/lastGain`] = { amount: 2 * count, by: powerUpTarget, reason: powerId, ts: Date.now() }
              }
            }
          } catch (e) {}
        }
      }
      // handle single-letter payloads (one_random, letter_peek) where resultPayload.letter is set
      if (resultPayload && resultPayload.letter) {
        try {
          const add = (resultPayload.letter || '').toLowerCase()
          if (add) {
            const existing = targetNode.revealed || []
            const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
            updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existing || []), add]))
            if (!existingSet.has(add)) {
              const count = (targetWord || '').split('').filter(ch => ch.toLowerCase() === add).length
                if (count > 0) {
                const me = (state?.players || []).find(p => p.id === myId) || {}
                const myHangCurrent = Number(me.hangmoney) || 0
                const baseAfterCost = (typeof updates[`players/${myId}/hangmoney`] !== 'undefined') ? updates[`players/${myId}/hangmoney`] : (myHangCurrent - cost)
                const award = 2 * count
                updates[`players/${myId}/hangmoney`] = Math.max(0, Number(baseAfterCost) + award)
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
                updates[`players/${myId}/lastGain`] = { amount: 2 * count, by: powerUpTarget, reason: powerId, ts: Date.now() }
              }
            }
          }
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
              const myHangCurrent = Number(me.hangmoney) || 0
              const baseAfterCost = (typeof updates[`players/${myId}/hangmoney`] !== 'undefined') ? updates[`players/${myId}/hangmoney`] : (myHangCurrent - cost)
              updates[`players/${myId}/hangmoney`] = Math.max(0, Number(baseAfterCost) + total)
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
            // If a previous staged update already adjusted this player's hangmoney (e.g. from a power-up), add to it
            const stagedNextHang = (typeof updates[`players/${nextPlayer}/hangmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/hangmoney`]) : prevNextHang
            updates[`players/${nextPlayer}/hangmoney`] = Math.max(0, Number(stagedNextHang) + 1)
            // clear any frozen flags when their turn begins
            updates[`players/${nextPlayer}/frozen`] = null
            updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
            // Add a lastGain entry to indicate the +1 starter award (clients will show this in tooltip)
            try {
              // only add when starter bonus is enabled in room state
              if (state && state.starterBonus && state.starterBonus.enabled) {
                updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
              }
            } catch (e) {}
          } catch (e) {}
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
                  // producing a duplicate visible line in the hangmoney tooltip.
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
    const myHang = Number(me.hangmoney) || 0
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
          <div className="powerup-list">
            {(POWER_UPS || []).map(p => {
              // compute effective price for display (show surge applied if it affects buyer)
              let displayPrice = p.price
              try {
                const surge = state && state.priceSurge
                if (surge && surge.amount && surge.by !== myId) {
                  const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
                  const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
                  if (active) displayPrice = p.price + Number(surge.amount || 0)
                }
              } catch (e) { }

              return (
                <div key={p.id} className={`powerup-row ${(p.powerupType === 'selfPowerup' && powerUpTarget === myId) ? 'self-powerup' : ''}`}>
                  <div className="powerup-meta">
                    <div className="title">{p.name} <small className="desc">{p.desc}</small></div>
                    <div className="powerup-price">{displayPrice} 🪙{displayPrice !== p.price ? <small className="surge">(+ surge)</small> : null}</div>
                  </div>
                  <div className="powerup-actions">
                    {p.id === 'letter_peek' ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input className="powerup-input" ref={powerUpChoiceRef} id={`powerup_${p.id}_choice`} name={`powerup_${p.id}_choice`} placeholder="position" value={powerUpChoiceValue} onChange={e => setPowerUpChoiceValue(e.target.value)} disabled={isLobby} />
                        {/* stable button width and no transition to avoid layout shift when label changes */}
                        <button className="powerup-buy" disabled={isLobby || powerUpLoading || myHang < displayPrice} onClick={() => purchasePowerUp(p.id, { pos: powerUpChoiceValue })}>{powerUpLoading ? '...' : 'Buy'}</button>
                      </div>
                    ) : p.id === 'double_down' ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input className="powerup-input" id={`powerup_${p.id}_stake`} name={`powerup_${p.id}_stake`} placeholder="stake" value={powerUpChoiceValue} onChange={e => setPowerUpChoiceValue(e.target.value)} disabled={isLobby} />
                        <button className="powerup-buy" disabled={isLobby || powerUpLoading || myHang < displayPrice} onClick={() => purchasePowerUp(p.id, { stake: powerUpChoiceValue })}>{powerUpLoading ? '...' : 'Buy'}</button>
                      </div>
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

  

  // Component: host-only Play Again / Restart controls
  function PlayAgainControls({ isHost, myId, players }) {
    const [submitting, setSubmitting] = useState(false)

    // Host-only restart: reset per-player words, hangmoney, submission flags, clear wantsRematch, and set phase to 'waiting'
    async function restartForAll() {
      if (!isHost) return
      try {
        setSubmitting(true)
        setIsResetting(true)

  const updates = { phase: 'lobby', open: true, turnOrder: [], currentTurnIndex: null, currentTurnStartedAt: null }
    // determine starting hangmoney to apply for resets (prefer authoritative room state, fallback to local setting)
    const resetStart = (state && typeof state.startingHangmoney === 'number') ? Math.max(0, Number(state.startingHangmoney)) : (typeof startingHangmoney === 'number' ? Math.max(0, Number(startingHangmoney)) : 2)
    ;(players || []).forEach(p => {
          updates[`players/${p.id}/wantsRematch`] = null
          updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          // apply configured starting hangmoney
          updates[`players/${p.id}/hangmoney`] = resetStart
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
  const startMoney = (state && typeof state.startingHangmoney === 'number') ? Math.max(0, Number(state.startingHangmoney)) : (typeof startingHangmoney === 'number' ? Math.max(0, Number(startingHangmoney)) : 2)
  const updates = { phase: 'lobby', open: true, turnOrder: [], currentTurnIndex: null, currentTurnStartedAt: null }
        playersArr.forEach(p => {
          updates[`players/${p.id}/wantsRematch`] = null
          updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          updates[`players/${p.id}/hangmoney`] = startMoney
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
          // clear frozen flags for the player whose turn will start
          try {
            const nextPlayer = order[nextIdx]
            if (nextPlayer) {
              updates[`players/${nextPlayer}/frozen`] = null
              updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
            }
          } catch (e) {}
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
            <div style={{ color: '#ddd' }}>If the host clicks Play again, the room will reset automatically.</div>
          </div>
        </div>
      </>
    )
  }

  return (
    <div className={`game-room ${state && state.winnerByHangmoney ? 'money-theme' : ''}`}>
      {modeBadge}
      <div className="app-content" style={powerUpOpen ? { pointerEvents: 'none', userSelect: 'none' } : undefined}>
  {phase === 'lobby' && <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />}
      {phase === 'lobby' && <h2>Room: {roomId}</h2>}
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

  <div className={`circle ${isMyTurnNow ? 'my-turn' : ''}`}>
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
                          hostId={hostId}
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

  </div>{/* end app-content */}
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
              <div style={{ color: '#ddd' }}>If the host clicks Play again, the room will reset automatically.</div>
            </div>
          </div>
          </>
        )}
      
    </div>
  )
}
