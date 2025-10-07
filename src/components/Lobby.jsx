import React, { useState } from 'react'
import { db } from '../firebase'
import { ref as dbRef, get as dbGet } from 'firebase/database'

export default function Lobby({ onJoin, initialRoom = '' }) {
  const [name, setName] = useState('')
  const [room, setRoom] = useState(initialRoom || '')
  const [password, setPassword] = useState('')
  const [createdRoom, setCreatedRoom] = useState(null)

  function handleCreate() {
    // We'll generate a short id client-side (can be improved)
    const id = Math.random().toString(36).slice(2, 8)
    setCreatedRoom(id)
    // In a real app we'd save the hashed password in Firebase
    onJoin(id, name)
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
          alert('This room has already started and is closed to new players.')
          return
        }
        onJoin(room, name)
      }).catch(err => {
        // if reading fails, allow join attempt and let DB rules handle it
        // eslint-disable-next-line no-console
        console.warn('Could not read room state before joining:', err)
        onJoin(room, name)
      })
      return
    }

    // no db configured - proceed
    onJoin(room, name)
  }

  function shareLinkFor(id) {
    const url = new URL(window.location.href)
    url.searchParams.set('room', id)
    return url.toString()
  }

  async function copyLink(id) {
    const url = shareLinkFor(id)
    try {
      await navigator.clipboard.writeText(url)
      // eslint-disable-next-line no-alert
      alert('Room link copied to clipboard')
    } catch (e) {
      // fallback
      // eslint-disable-next-line no-alert
      prompt('Copy this link', url)
    }
  }

  return (
    <div className="lobby">
      <h1>Group Hangman</h1>
      <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />

      <div className="card">
        <h3>Create room</h3>
        <input placeholder="room name (auto)" value={room} onChange={e => setRoom(e.target.value)} />
        <input placeholder="password (optional)" value={password} onChange={e => setPassword(e.target.value)} />
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
        <input placeholder="password (if required)" value={password} onChange={e => setPassword(e.target.value)} />
        <button onClick={handleJoin}>Join</button>
      </div>
    </div>
  )
}
