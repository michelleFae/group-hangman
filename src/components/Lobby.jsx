import React, { useState } from 'react'
import { db } from '../firebase'
import { ref as dbRef, get as dbGet } from 'firebase/database'
import { buildRoomUrl } from '../utils/url'

export default function Lobby({ onJoin, initialRoom = '' }) {
  const [name, setName] = useState('')
  const [room, setRoom] = useState(initialRoom || '')
  const [password, setPassword] = useState('')
  const [joinError, setJoinError] = useState('')
  const [createdRoom, setCreatedRoom] = useState(null)
  const [toasts, setToasts] = useState([])

  function handleCreate() {
    // We'll generate a short id client-side (can be improved)
    const id = Math.random().toString(36).slice(2, 8)
    setCreatedRoom(id)
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
        if (val && val.open === false) {
          // eslint-disable-next-line no-alert
          setJoinError('This room has already started and is closed to new players.')
          return
        }
        // validate password inline instead of using a blocking alert
        if (val && val.password && val.password !== (password || '')) {
          setJoinError('Password is incorrect. Please try again.')
          return
        }
        setJoinError('')
        onJoin(room, name, password) // Pass the password to onJoin
      }).catch(err => {
        // if reading fails, allow join attempt and let DB rules handle it
        // eslint-disable-next-line no-console
        console.warn('Could not read room state before joining:', err)
        setJoinError('')
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

  return (
    <div className="lobby">
      <div className="toast-container" style={{ position: 'fixed', right: 18, top: 18, zIndex: 9999 }}>
        {toasts.map(t => (
          <div key={t.id} className="toast" style={{ background: 'rgba(0,0,0,0.8)', color: 'white', padding: '8px 12px', borderRadius: 8, marginBottom: 8 }}>{t.text}</div>
        ))}
      </div>
      <div className="hangxiety-header">
        <h1 className="hangxiety-title">Hangxiety <span className="bubble">😅</span></h1>
        <p className="hangxiety-tag">A multiplayer word game that should come with a therapist.</p>
      </div>
      <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />

      <div className="card">
        <h3>Create room</h3>
        <input placeholder="room name (auto)" value={createdRoom || 'auto-generated'} disabled />
        <input placeholder="password (optional)" value={password} onChange={e => {
          setPassword(e.target.value)
          console.log('Password updated to:', e.target.value)
        }} />
        <button onClick={handleCreate}>Create</button>

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
        <input placeholder="room id" value={room} onChange={e => setRoom(e.target.value)} />
        <input placeholder="password (if required)" value={password} onChange={e => { setPassword(e.target.value); setJoinError('') }} />
        <button onClick={handleJoin}>Join</button>
  {joinError && <div className="small-error">{joinError}</div>}
      </div>
    </div>
  )
}
