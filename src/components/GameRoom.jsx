import React, { useEffect, useState, useMemo, useRef } from 'react'
import PlayerCircle from './PlayerCircle'
import useGameRoom from '../hooks/useGameRoom'
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
  const [timeLeft, setTimeLeft] = useState(null)
  const [tick, setTick] = useState(0)
  const [toasts, setToasts] = useState([])
  const multiHitSeenRef = useRef({})
  const [recentPenalty, setRecentPenalty] = useState({})
  const [pendingDeducts, setPendingDeducts] = useState({})
  const [showConfirmReset, setShowConfirmReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

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

  const confettiPieces = useMemo(() => {
    if (!isWinner) return []
    const colors = ['#FFABAB','#FFD54F','#B39DDB','#81D4FA','#C5E1A5','#F8BBD0','#B2EBF2']
    return new Array(48).fill(0).map(() => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.8,
      size: 6 + Math.random() * 12,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotate: Math.random() * 360
    }))
  }, [isWinner])

  const cashPieces = useMemo(() => {
    if (!state?.winnerByHangmoney) return []
    return new Array(28).fill(0).map(() => ({ left: Math.random() * 100, delay: Math.random() * 0.8, rotate: Math.random() * 360, top: -10 - (Math.random()*40) }))
  }, [state?.winnerByHangmoney])

  const modeBadge = (
    <div style={{ position: 'fixed', right: 18, top: 18, zIndex: 9999 }}>
      <div className="mode-badge card" style={{ padding: '6px 10px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid rgba(34,139,34,0.12)' }}>
  <span style={{ fontSize: 16 }}>{state?.winnerByHangmoney ? '💸' : '🛡️'}</span>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: '1' }}>
          <strong style={{ fontSize: 13 }}>{state?.winnerByHangmoney ? 'Winner: Most hangmoney' : 'Winner: Last one standing'}</strong>
          <small style={{ color: '#666', fontSize: 12 }}>{state?.winnerByHangmoney ? 'Money wins' : 'Elimination wins'}</small>
        </div>
      </div>
    </div>
  )

  if (phase === 'ended') {
    // Use the top-level computed values (standings, isWinner, confettiPieces, cashPieces)
    // to avoid calling hooks conditionally. Those values are computed above.
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
            {standings.map((p, idx) => {
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
          {isHost ? (
            <>
              <button onClick={() => setShowConfirmReset(true)}>Play again</button>
              {showConfirmReset && (
                <div className="modal-overlay">
                  <div className="modal-dialog card">
                    <h4>Reset room for a new round?</h4>
                    <p>All submitted words and revealed letters will be cleared, and hangmoney will be reset to starting values for everyone. This action can only be performed by the host.</p>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                      <button onClick={() => setShowConfirmReset(false)}>Cancel</button>
                      <button disabled={isResetting} onClick={async () => {
                        if (isResetting) return
                        setIsResetting(true)
                        try {
                          const roomRef = dbRef(db, `rooms/${roomId}`)
                          const updates = {
                            phase: 'lobby',
                            open: true,
                            winnerName: null,
                            winnerId: null,
                            turnOrder: null,
                            currentTurnIndex: 0,
                            currentTurnStartedAt: null,
                            timeouts: null
                          }
                          // reset per-player submit state and hangmoney
                          (state.players || []).forEach(p => {
                            updates[`players/${p.id}/hasWord`] = false
                            updates[`players/${p.id}/word`] = null
                            updates[`players/${p.id}/revealed`] = []
                            updates[`players/${p.id}/eliminated`] = false
                            updates[`players/${p.id}/hangmoney`] = 2
                          })
                          // debug: inspect dbUpdate and updates
                          try {
                            console.log('Reset: typeof dbUpdate =', typeof dbUpdate)
                            console.log('Reset: updates preview', Object.keys(updates).slice(0,20))
                          } catch (e) { console.warn('Reset: debug log failed', e) }
                          // Try a sequence of strategies; collect errors and only fail after all attempts
                          const errors = []
                          console.log('Reset: diagnostic info (ordered checks):', {
                            typeof_dbUpdate: typeof dbUpdate,
                            hasRoomRefUpdate: !!(roomRef && typeof roomRef.update === 'function'),
                            hasFetch: typeof fetch === 'function',
                            runtimeDBURL: !!window.__firebaseDatabaseURL,
                            hasAuth: !!(window && window.__firebaseAuth && window.__firebaseAuth.currentUser)
                          })

                          // Strategy A: prefer the modular named import (dbUpdate) when available
                          try {
                            if (typeof dbUpdate === 'function') {
                              console.log('Reset: attempting named dbUpdate(...)')
                              await dbUpdate(roomRef, updates)
                              console.log('Reset: named dbUpdate succeeded')
                            } else {
                              throw new Error('named dbUpdate not available')
                            }
                          } catch (errA) {
                            console.warn('Reset: named dbUpdate failed or unavailable', errA && (errA.stack || errA.message || String(errA)))
                            errors.push({ step: 'named dbUpdate', err: errA && (errA.stack || errA.message || String(errA)) })

                            // Strategy B: compat-style ref.update (older SDKs / compat layer)
                            try {
                              if (roomRef && typeof roomRef.update === 'function') {
                                console.log('Reset: attempting roomRef.update(...)')
                                await roomRef.update(updates)
                                console.log('Reset: roomRef.update succeeded')
                              } else {
                                throw new Error('roomRef.update not available')
                              }
                            } catch (errB) {
                              console.warn('Reset: roomRef.update failed or unavailable', errB && (errB.stack || errB.message || String(errB)))
                              errors.push({ step: 'ref.update', err: errB && (errB.stack || errB.message || String(errB)) })

                              // Strategy C: guarded dynamic import and call
                              try {
                                console.log('Reset: attempting guarded dynamic import of firebase/database')
                                const mod = await import('firebase/database')
                                const updateFn = (mod && typeof mod.update === 'function') ? mod.update : (mod && mod.default && typeof mod.default.update === 'function') ? mod.default.update : null
                                if (typeof updateFn === 'function') {
                                  await updateFn(roomRef, updates)
                                  console.log('Reset: dynamic import update succeeded')
                                } else {
                                  throw new Error('dynamic import did not expose a callable update()')
                                }
                              } catch (errC) {
                                console.warn('Reset: dynamic import approach failed', errC && (errC.stack || errC.message || String(errC)))
                                errors.push({ step: 'dynamic import', err: errC && (errC.stack || errC.message || String(errC)) })

                                // Strategy D: REST PATCH (last resort)
                                try {
                                  console.log('Reset: attempting REST PATCH fallback')
                                  const authToken = (window.__firebaseAuth && window.__firebaseAuth.currentUser) ? await window.__firebaseAuth.currentUser.getIdToken() : null
                                  const dbUrl = window.__firebaseDatabaseURL || (typeof process !== 'undefined' && process.env && (process.env.VITE_FIREBASE_DATABASE_URL || process.env.FIREBASE_DATABASE_URL)) || null
                                  if (!dbUrl) throw new Error('No database URL available for REST fallback')
                                  const url = `${dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}.json${authToken ? `?auth=${authToken}` : ''}`
                                  const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
                                  if (!res.ok) throw new Error('REST fallback failed: ' + res.status + ' ' + (await res.text()))
                                  console.log('Reset: REST PATCH succeeded')
                                } catch (errD) {
                                  console.error('Reset: REST fallback failed', errD && (errD.stack || errD.message || String(errD)))
                                  errors.push({ step: 'rest', err: errD && (errD.stack || errD.message || String(errD)) })
                                }
                              }
                            }
                          }

                          if (errors.length > 0) {
                            console.error('Reset: all update strategies failed', errors)
                            // show a short toast so the user knows reset failed
                            const toastId = `reset_fail_${Date.now()}`
                            setToasts(t => [...t, { id: toastId, text: 'Could not reset room for replay' }])
                            setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 4000)
                            // do not rethrow raw errors - we already informed the user and logged details
                          }
                        } catch (e) {
                          console.warn('Could not reset room for replay', e && e.stack ? e.stack : e)
                        } finally {
                          setIsResetting(false)
                          setShowConfirmReset(false)
                        }
                      }}>{isResetting ? 'Resetting…' : 'Confirm reset'}</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ color: '#ddd' }}>Waiting for host to reset the room</div>
          )}
        </div>
      </div>
      </>
    )
  }

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
    if (candidate.length === 1) {
      setWordError('Please pick a word that is at least 2 letters long.')
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

  return (
    <div className={`game-room ${state && state.winnerByHangmoney ? 'money-theme' : ''}`}>
      {modeBadge}
      {phase === 'lobby' && <h2>Room: {roomId}</h2>}
      {phase === 'lobby' && (
        <div style={{ display: 'inline-block' }}>
          <div style={{ marginBottom: 8 }}>
            {isHost ? (
              <>
                <label style={{ marginRight: 12 }}>
                  <input type="checkbox" checked={timedMode} onChange={e => { setTimedMode(e.target.checked); updateRoomTiming(e.target.checked, turnSeconds) }} /> Timed mode
                </label>
                <label style={{ marginRight: 12 }} title="When enabled, a single random 'starter' requirement will be chosen when the game starts. Players whose submitted word meets the requirement receive +10 bonus hangmoney.">
                  <input type="checkbox" checked={starterEnabled} onChange={e => setStarterEnabled(e.target.checked)} /> Starter bonus
                </label>
                <label style={{ marginRight: 12 }} title="Choose how the winner is determined: Last one standing (default) or player with most hangmoney. Visible to all players.">
                  <input type="checkbox" checked={winnerByHangmoney} onChange={e => { setWinnerByHangmoney(e.target.checked); updateRoomWinnerMode(e.target.checked) }} /> Winner by money
                </label>
                {timedMode && (
                  <label>
                    Seconds per turn:
                    <input type="number" min={10} max={300} value={turnSeconds} onChange={e => { setTurnSeconds(Math.max(10, Math.min(300, Number(e.target.value || 30)))); updateRoomTiming(timedMode, Math.max(10, Math.min(300, Number(e.target.value || 30)))) }} style={{ width: 80, marginLeft: 8 }} />
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
                      <input readOnly value={u.toString()} style={{ width: 360 }} />
                  <button onClick={async () => { await navigator.clipboard.writeText(u.toString()); setToasts(t => [...t, { id: Date.now(), text: 'Room link copied' }]); setTimeout(() => setToasts(t => t.slice(1)), 3000) }}>Copy</button>
                    </>
                  )
                } catch (e) {
                  const fallback = window.location.origin + '?room=' + roomId
                  return (
                    <>
                      <input readOnly value={fallback} style={{ width: 360 }} />
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
        {players.map(p => {
          // derive viewer-specific private data. viewer's node lives under state.players keyed by id — we need to find viewer's full object
          const viewerNode = players.find(x => x.id === myId) || {}
          // viewerNode may contain privateWrong, privateHits, privateWrongWords which are objects keyed by targetId
          const viewerPrivate = {
            privateWrong: viewerNode.privateWrong || {},
            privateHits: viewerNode.privateHits || {},
            privateWrongWords: viewerNode.privateWrongWords || {}
          }

          // clone player and attach viewer's private data under _viewer so child can render it
          // compute ms left for the current player
          const msLeftForPlayer = (state?.currentTurnStartedAt && state?.turnTimeoutSeconds && state?.timed && currentTurnId === p.id)
            ? Math.max(0, (state?.currentTurnStartedAt || 0) + ((state?.turnTimeoutSeconds || 0)*1000) - Date.now())
            : null

          const playerWithViewer = { ...p, _viewer: viewerPrivate }

          const wasPenalized = Object.keys(state?.timeouts || {}).some(k => (state?.timeouts && state.timeouts[k] && state.timeouts[k].player) === p.id && recentPenalty[k])
          return (
            <PlayerCircle key={p.id}
                          player={playerWithViewer}
                          isSelf={p.id === myId}
                          viewerId={myId}
                          phase={phase}
                          hasSubmitted={!!p.hasWord}
                          canGuess={phase === 'playing' && myId === currentTurnId && p.id !== myId}
                          onGuess={(targetId, guess) => sendGuess(targetId, guess)} 
                          playerIdToName={playerIdToName}
                          timeLeftMs={msLeftForPlayer} currentTurnId={currentTurnId}
                          starterApplied={!!state?.starterBonus?.applied}
                          flashPenalty={wasPenalized}
                          pendingDeduct={pendingDeducts[p.id] || 0}
                          isWinner={p.id === state?.winnerId} />
          )
        })}
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
                  <input placeholder="your word" value={word} onChange={e => { setWord(e.target.value); setWordError('') }} />
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
      
    </div>
  )
}
