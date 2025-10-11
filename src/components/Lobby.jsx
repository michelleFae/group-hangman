import React, { useState, useEffect, useRef } from 'react'
import { db, auth } from '../firebase'
import { ref as dbRef, get as dbGet } from 'firebase/database'
import { buildRoomUrl } from '../utils/url'

export default function Lobby({ onJoin, initialRoom = '' }) {
  const [name, setName] = useState('')
  const [room, setRoom] = useState(initialRoom || '')
  const [password, setPassword] = useState('')
  const [joinError, setJoinError] = useState('')
  const [createdRoom, setCreatedRoom] = useState(null)
  const [toasts, setToasts] = useState([])
  const [storedAnonForRoom, setStoredAnonForRoom] = useState(null)
  const nameRef = useRef(null)
  const ariaLiveRef = useRef(null)

  useEffect(() => {
    // autofocus name input on mount
    try { if (nameRef.current) nameRef.current.focus() } catch (e) {}
    // announce for screen readers
    try { if (ariaLiveRef.current) ariaLiveRef.current.textContent = 'Welcome. Enter a display name to join or create a room.' } catch (e) {}
  }, [])

  function handleCreate() {
    // We'll generate a short id client-side (can be improved)
    const id = Math.random().toString(36).slice(2, 8)
    setCreatedRoom(id)
    // require name to create
    if (!name || !name.toString().trim()) {
      setJoinError('Please enter a display name to create a room')
      return
    }
    // In a real app we'd save the hashed password in Firebase
    onJoin(id, name, password)
    try {
      const url = buildRoomUrl(id)
      window.history.replaceState({}, '', url)
    } catch (e) {
      // ignore
    }
  }

  function handleJoin() {
    if (!room) return
    // If Firebase is configured, check the room's 'open' flag before joining
    if (db) {
      const roomRef = dbRef(db, `rooms/${room}`)
      dbGet(roomRef).then(snap => {
        const val = snap.val()
        // If the room is closed to new players, allow rejoin when we have a stored anonymous id
        let storedAnon = null
        try { storedAnon = window.localStorage && window.localStorage.getItem(`gh_anon_${room}`) } catch (e) { storedAnon = null }
        // persist storedAnon to state so UI can reflect it
        setStoredAnonForRoom(storedAnon)
        if (val && val.open === false && !storedAnon) {
          try {
            // if all players are stale (lastSeen > 10 minutes), reset the room and allow join
            const players = val.players || {}
            const keys = Object.keys(players)
            const now = Date.now()
            const tenMin = 10 * 60 * 1000
            const allStale = keys.length > 0 && keys.every(k => {
              try {
                const p = players[k] || {}
                const ls = Number(p.lastSeen) || 0
                return (now - ls) > tenMin
              } catch (e) { return false }
            })
            if (allStale) {
              // reopen and clear players so the joining user can take the room
              const roomRef = dbRef(db, `rooms/${room}`)
              const updates = { open: true, phase: 'lobby', turnOrder: [], currentTurnIndex: null, currentTurnStartedAt: null }
              // clear player nodes to avoid conflicts (server-side eviction may do this later)
              keys.forEach(k => { updates[`players/${k}`] = null })
              update(roomRef, updates).catch(err => console.warn('Could not reset stale room before join', err))
              // allow join to proceed
            } else {
              setJoinError('This room has already started and is closed to new players.')
              return
            }
          } catch (e) {
            // fallback: treat as closed
            setJoinError('This room has already started and is closed to new players.')
            return
          }
        }
        // validate password inline instead of using a blocking alert
        // If there is a password and it doesn't match, allow rejoin when we have a stored anon id
        if (val && val.password && val.password !== (password || '')) {
          if (!storedAnon) {
            setJoinError('Password is incorrect. Please try again.')
            return
          }
          // allow rejoin with stored anon id — caller will preserve server-side name
          setJoinError('')
          onJoin(room, '', '')
          return
        }
        setJoinError('')
        // require name unless we have a stored anon id for this room
        if (storedAnon) {
          onJoin(room, '', password)
        } else if (!name || !name.toString().trim()) {
          setJoinError('Please enter a display name to join')
          return
        } else {
          onJoin(room, name, password) // Pass the password to onJoin
        }
      }).catch(err => {
        // if reading fails, allow join attempt and let DB rules handle it
        // eslint-disable-next-line no-console
        console.warn('Could not read room state before joining:', err)
        setJoinError('')
        if (!name || !name.toString().trim()) {
          setJoinError('Please enter a display name to join')
          return
        }
        onJoin(room, name, password) // Pass the password to onJoin
      })
      return
    }

    // no db configured - proceed
    onJoin(room, name, password) // Pass the password to onJoin
  }

  function shareLinkFor(id) {
    const url = new URL(window.location.href)
    url.searchParams.set('room', id)
    return url.toString()
  }

  async function copyLink(id) {
    const url = buildRoomUrl(id)
    try {
      await navigator.clipboard.writeText(url)
      setToasts(t => [...t, { id: Date.now(), text: 'Room link copied' }])
      setTimeout(() => setToasts(t => t.slice(1)), 3000)
    } catch (e) {
      prompt('Copy this link', url)
    }
  }

  // auto-join on refresh when a room param is present and we have a stored anonymous id
  React.useEffect(() => {
    if (!initialRoom) return
    console.log('Lobby: auto-join effect mounted for', initialRoom)
    const attempts = [0, 75, 500, 1500, 4000]
    const timers = []

    async function tryAutoJoin(attemptIdx) {
      let stored = null
      try { stored = window.localStorage && window.localStorage.getItem(`gh_anon_${initialRoom}`) } catch (e) { stored = null }

      // check if current auth user is the host
      let isHostAuth = false
      try {
        console.log('Lobby: tryAutoJoin checking auth state (attempt', attemptIdx, '). auth.currentUser=', auth && auth.currentUser)
        if (auth && auth.currentUser && auth.currentUser.uid) {
          const snap = await dbGet(dbRef(db, `rooms/${initialRoom}`))
          const rv = snap.val() || {}
          if (rv && rv.hostId && rv.hostId === auth.currentUser.uid) isHostAuth = true
          // also allow rejoin when the Fauthenticated uid corresponds to a player node in the room
          if (!isHostAuth && rv && rv.players && rv.players[auth.currentUser.uid]) {
            console.log('Lobby: auto-join allowed because auth UID matches a player node in the room')
            isHostAuth = true // treat as allowed to auto-join, proceed below to call onJoin
          }
        }
      } catch (e) {
        isHostAuth = false
      }

      if (!stored && !isHostAuth) {
        console.log('Lobby: tryAutoJoin aborting (no stored anon and not host)')
        return false
      }

      console.log('Lobby: performing auto-join for', initialRoom, 'storedAnon?', !!stored, 'isHostAuth?', isHostAuth, 'attemptIdx=', attemptIdx)
      const authName = isHostAuth && auth && auth.currentUser && auth.currentUser.displayName ? auth.currentUser.displayName : ''
      try {
        onJoin(initialRoom, authName || '', '')
        return true
      } catch (e) {
        console.warn('Lobby auto-join failed', e)
        return false
      }
    }

    let succeeded = false
    attempts.forEach((delay, idx) => {
      console.log('Lobby: scheduling auto-join attempt', idx, 'in', delay, 'ms')
      const t = setTimeout(async () => {
        if (succeeded) return
        try {
          const ok = await tryAutoJoin(idx)
          if (ok) succeeded = true
        } catch (e) {
          // ignore and let next attempt run
        }
      }, delay)
      timers.push(t)
    })

    return () => timers.forEach(t => clearTimeout(t))
  }, [initialRoom, onJoin])

  return (
    <div className="lobby">
      <div className="toast-container" style={{ position: 'fixed', right: 18, top: 18, zIndex: 9999 }}>
        {toasts.map(t => (
          <div key={t.id} className="toast" style={{ background: 'rgba(0,0,0,0.8)', color: 'white', padding: '8px 12px', borderRadius: 8, marginBottom: 8 }}>{t.text}</div>
        ))}
      </div>
      <div className="wordspiracy-header">
        <h1 className="wordspiracy-title">Wordspiracy <span className="bubble">😅</span></h1>
        <p className="wordspiracy-tag">Protect your word. Expose theirs.</p>
      </div>
  <input ref={nameRef} aria-label="Your display name" placeholder="Your name" className={`name-input ${(!name || !name.toString().trim()) ? 'required-glow' : ''}`} value={name} onChange={e => { setName(e.target.value); setJoinError('') }} />

      {/* ARIA live region for announcements */}
      <div ref={ariaLiveRef} aria-live="polite" style={{ position: 'absolute', left: -9999, top: 'auto', width: 1, height: 1, overflow: 'hidden' }} />

      <div className={`card ${room && room.toString().trim() ? 'card-dimmed' : ''}`}>
        <h3>Create room</h3>
        <input placeholder="room name (auto)" value={createdRoom || 'auto-generated'} disabled />
        <input placeholder="password (optional)" value={password} onChange={e => {
          setPassword(e.target.value)
          console.log('Password updated to:', e.target.value)
        }} />
        <button onClick={handleCreate} disabled={!!(room && room.toString().trim()) || !(name && name.toString().trim())}>Create</button>

        {createdRoom && (
          <div className="share">
            <p>Room created: <strong>{createdRoom}</strong></p>
            <button onClick={() => copyLink(createdRoom)}>Copy room link</button>
            <button onClick={() => window.open(shareLinkFor(createdRoom), '_blank')}>Open link</button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Join room</h3>
    <input placeholder="room id" value={room} onChange={e => { setRoom(e.target.value); setStoredAnonForRoom(window.localStorage && window.localStorage.getItem(`gh_anon_${e.target.value}`)) }} />
        <input placeholder="password (if required)" value={password} onChange={e => { setPassword(e.target.value); setJoinError('') }} />
    <button onClick={handleJoin} className={`join-btn ${room && room.toString().trim() ? 'join-glow' : ''}`} disabled={!(room && room.toString().trim() && (storedAnonForRoom || (name && name.toString().trim()))) }>Join</button>
  {joinError && <div className="small-error">{joinError}</div>}
      </div>
    </div>
  )
}
