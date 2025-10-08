import React, { useEffect, useState } from 'react'
import PlayerCircle from './PlayerCircle'
import useGameRoom from '../hooks/useGameRoom'
import { db } from '../firebase'
import { ref as dbRef, get as dbGet, update as dbUpdate } from 'firebase/database'
import { buildRoomUrl } from '../utils/url'

export default function GameRoom({ roomId, playerName, password }) { // Added password as a prop
  const { state, joinRoom, leaveRoom, sendGuess, startGame, submitWord, playerId } = useGameRoom(roomId, playerName)
  const [word, setWord] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [timedMode, setTimedMode] = useState(false)
  const [turnSeconds, setTurnSeconds] = useState(30)
  const [timeLeft, setTimeLeft] = useState(null)
  const [tick, setTick] = useState(0)
  const [toasts, setToasts] = useState([])
  const [recentPenalty, setRecentPenalty] = useState({})
  const [pendingDeducts, setPendingDeducts] = useState({})

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
    setTimedMode(!!state.timed)
    setTurnSeconds(state.turnTimeoutSeconds || 30)
  }, [state && state.timed, state && state.turnTimeoutSeconds])

  // write timing preview to room so all players (including non-hosts) can see before start
  async function updateRoomTiming(timed, seconds) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      await dbUpdate(roomRef, { timed: !!timed, turnTimeoutSeconds: timed ? Math.max(10, Math.min(300, Number(seconds) || 30)) : null })
    } catch (e) {
      console.warn('Could not update room timing preview', e)
    }
  }

  // watch for timeout logs in state.timeouts to show toast and flash player
  useEffect(() => {
    if (!state) return
    const timeouts = state.timeouts || {}
    const keys = Object.keys(timeouts)
    if (keys.length === 0) return
    // determine new timeouts (use local recentPenalty map to filter)
    keys.forEach(k => {
      const e = timeouts[k]
      if (!e || !e.player) return
      if (recentPenalty[k]) return // already handled
      // show toast
      const toast = { id: k, text: `-2 hangmoney for ${e.player} (timed out)` }
      setToasts(t => [...t, toast])
      // auto-remove toast after 4s
      setTimeout(() => setToasts(t => t.filter(x => x.id !== k)), 4000)
      setRecentPenalty(r => ({ ...r, [k]: true }))
      // set flag on player briefly by storing keyed flag (playerId -> true) with timeout
      setTimeout(() => {
        setRecentPenalty(r => {
          const copy = { ...r }
          delete copy[k]
          return copy
        })
      }, 3000)
      // Show a temporary pending deduction on the player's tile so users see immediate feedback even if DB
      // update takes a moment or functions are slow/not deployed yet.
      if (e && typeof e.deducted === 'number') {
        setPendingDeducts(prev => ({ ...prev, [e.player]: (prev[e.player] || 0) - e.deducted }))
        setTimeout(() => {
          setPendingDeducts(prev => {
            const copy = { ...prev }
            delete copy[e.player]
            return copy
          })
        }, 3500)
      }
    })
  }, [state])

  if (!state) return <div>Loading room...</div>

  const phase = state.phase || 'lobby'
  const hostId = state.hostId
  const players = state.players || []
  const playerIdToName = {}
  players.forEach(p => { playerIdToName[p.id] = p.name })
  const submittedCount = players.filter(p => p.hasWord).length

  const isHost = hostId && window.__firebaseAuth && window.__firebaseAuth.currentUser && window.__firebaseAuth.currentUser.uid === hostId
  const myId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
  const currentTurnIndex = state.currentTurnIndex || 0
  const currentTurnId = (state.turnOrder || [])[currentTurnIndex]

  if (state.phase === 'ended') {
    return (
      <div className="victory-screen">
        <h1>🎉 {state.winnerName} Wins! 🎉</h1>
        <p>All words guessed. Game over!</p>
        <button onClick={() => window.location.reload()}>Play again</button>
      </div>
    )
  }

  async function isEnglishWord(w) {
    const candidate = (w || '').toString().trim().toLowerCase()
    if (!/^[a-z]+$/.test(candidate)) return false
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${candidate}`)
      if (!res.ok) return false
      const data = await res.json()
      return Array.isArray(data) && data.length > 0
    } catch (e) {
      console.warn('Dictionary check failed, allowing word by default', e)
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
        dbGet(roomRef).then(snap => {
          const r = snap.val() || {}
          const order = r.turnOrder || []
          if (!order || order.length === 0) return
          const nextIdx = ((r.currentTurnIndex || 0) + 1) % order.length
          dbUpdate(roomRef, { currentTurnIndex: nextIdx, currentTurnStartedAt: Date.now() })
        }).catch(e => console.warn('Could not advance turn on timeout', e))
      }
    }, [tick, state, roomId])

    return null
  }

  async function handleSubmitWord() {
    const candidate = (word || '').toString().trim()
    if (!candidate) {
      alert('Please enter a word')
      return
    }
    if (!/^[a-zA-Z]+$/.test(candidate)) {
      alert('Words may only contain letters. No spaces or punctuation.')
      return
    }
    const ok = await isEnglishWord(candidate)
    if (!ok) {
      alert('That doesn\'t look like an English word. Please pick another.')
      return
    }
    await submitWord(candidate)
    setSubmitted(true)
  }

  return (
    <div className="game-room">
      {phase === 'lobby' && <h2>Room: {roomId}</h2>}
      {phase === 'lobby' && (
        <div style={{ display: 'inline-block' }}>
          <div style={{ marginBottom: 8 }}>
            {isHost ? (
              <>
                <label style={{ marginRight: 12 }}>
                  <input type="checkbox" checked={timedMode} onChange={e => { setTimedMode(e.target.checked); updateRoomTiming(e.target.checked, turnSeconds) }} /> Timed mode
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
                Timed mode: <strong>{state.timed ? 'On' : 'Off'}</strong>
                {state.timed && <span style={{ marginLeft: 12 }}>Seconds per turn: <strong>{state.turnTimeoutSeconds}</strong></span>}
              </div>
            )}
          </div>
          {isHost ? (
            <>
              <button
                onClick={() => startGame(timedMode ? { timed: true, turnSeconds } : {})}
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
        {phase === 'playing' && state.timed && state.turnTimeoutSeconds && state.currentTurnStartedAt && (
          <div className="turn-timer">
            <div className="bar"><div className="fill" style={{ width: `${Math.max(0, (state.currentTurnStartedAt + (state.turnTimeoutSeconds*1000) - Date.now()) / (state.turnTimeoutSeconds*1000) * 100)}%` }} /></div>
            <div className="time">{(() => {
              const msLeft = Math.max(0, state.currentTurnStartedAt + (state.turnTimeoutSeconds*1000) - Date.now())
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
          const msLeftForPlayer = (state.currentTurnStartedAt && state.turnTimeoutSeconds && state.timed && currentTurnId === p.id)
            ? Math.max(0, state.currentTurnStartedAt + (state.turnTimeoutSeconds*1000) - Date.now())
            : null

          const playerWithViewer = { ...p, _viewer: viewerPrivate }

          const wasPenalized = Object.keys(state.timeouts || {}).some(k => (state.timeouts[k] && state.timeouts[k].player) === p.id && recentPenalty[k])
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
                          flashPenalty={wasPenalized}
                          pendingDeduct={pendingDeducts[p.id] || 0} />
          )
        })}
      </div>

      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className="toast">{t.text}</div>
        ))}
      </div>

      {/* Timer tick: client watches for timeout and advances turn if needed (best-effort) */}
      {phase === 'playing' && state.timed && state.turnTimeoutSeconds && state.currentTurnStartedAt && (
        <TimerWatcher roomId={roomId} state={state} />
      )}

      {/* Submit bar moved to bottom so it can be reused for power-ups later */}

      {phase === 'lobby' && state.password && (
        <div className="room-password">
          <strong>Room Password:</strong> {state.password}
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
        return (
          <div className="submit-bar card">
            <div className="submit-left">
              <h4 style={{ margin: 0 }}>Submit your secret word</h4>
              <div className="progress" style={{ marginTop: 8, width: 220 }}>
                <div className="progress-bar" style={{ width: `${(players.length ? (submittedCount / players.length) * 100 : 0)}%`, background: '#4caf50', height: 10, borderRadius: 6 }} />
                <div style={{ marginTop: 6, fontSize: 13 }}>{submittedCount} / {players.length} submitted</div>
              </div>
            </div>
            <div className="submit-controls">
              {!myHasSubmitted ? (
                <>
                  <input placeholder="your word" value={word} onChange={e => setWord(e.target.value)} />
                  <button onClick={handleSubmitWord}>Submit</button>
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
