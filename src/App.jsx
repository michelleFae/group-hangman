import React, { useState } from 'react'
import Lobby from './components/Lobby'
import GameRoom from './components/GameRoom'
import { db } from './firebase'
import { ref as dbRef, get as dbGet } from 'firebase/database'

function getRoomFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('room')
  } catch (e) {
    return null
  }
}

export default function App() {
  const initialRoom = getRoomFromUrl()
  const [roomId, setRoomId] = useState(initialRoom)
  const [playerName, setPlayerName] = useState('')
  const [password, setPassword] = useState('')
  const [autoError, setAutoError] = useState('')

  // If there's a room in the URL but no playerName yet, prompt for a name and auto-join

  if (initialRoom && !playerName) {
    // small inline prompt for name before auto-joining
    const defaultName = 'Guest-' + Math.random().toString(36).slice(2, 6)
    return (
      <div style={{ padding: 20 }}>
        <h2>Join room {initialRoom}</h2>
        <p>Enter your display name to join the room (or leave blank for a guest name)</p>
        <input placeholder="Your name" defaultValue={defaultName} id="autoNameInput" />
        <input placeholder="Room password (if required)" id="autoPasswordInput" />
        <div style={{ marginTop: 10 }}>
          <button onClick={async () => {
            const v = document.getElementById('autoNameInput').value || defaultName
            const pw = document.getElementById('autoPasswordInput').value || ''
            if (db) {
              try {
                const roomRef = dbRef(db, `rooms/${initialRoom}`)
                const snap = await dbGet(roomRef)
                const val = snap.val() || {}
                if (val && val.open === false) {
                  setAutoError('This room has already started and is closed to new players.')
                  return
                }
                if (val && val.password && val.password !== pw) {
                  setAutoError('Password is incorrect. Please try again.')
                  return
                }
              } catch (e) {
                console.warn('Could not validate room before auto-join:', e)
                // network/read failed — fall through and allow join
              }
            }
            setAutoError('')
            setPlayerName(v)
            setPassword(pw)
            // ensure password state is applied before mounting GameRoom
            setTimeout(() => setRoomId(initialRoom), 0)
          }}>Join room</button>
          {autoError && <div className="small-error">{autoError}</div>}
        </div>
      </div>
    )
  }

  if (!roomId) {
    const handleJoin = (r, name, pw) => {
      setPlayerName(name)
      setPassword(pw || '')
      // ensure password state is applied before mounting GameRoom by deferring roomId set
      setTimeout(() => setRoomId(r), 0)
    }

    return (
      <Lobby onJoin={handleJoin} initialRoom={initialRoom} />
    )
  }

  return <GameRoom roomId={roomId} playerName={playerName} password={password} />
}
