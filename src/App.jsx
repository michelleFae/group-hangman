import React, { useState } from 'react'
import Lobby from './components/Lobby'
import GameRoom from './components/GameRoom'

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

  // If there's a room in the URL but no playerName yet, prompt for a name and auto-join
  if (initialRoom && !roomId) {
    setRoomId(initialRoom)
  }

  if (initialRoom && !playerName) {
    // small inline prompt for name before auto-joining
    const defaultName = 'Guest-' + Math.random().toString(36).slice(2, 6)
    return (
      <div style={{ padding: 20 }}>
        <h2>Join room {initialRoom}</h2>
        <p>Enter your display name to join the room (or leave blank for a guest name)</p>
        <input placeholder="Your name" defaultValue={defaultName} id="autoNameInput" />
        <button onClick={() => {
          const v = document.getElementById('autoNameInput').value || defaultName
          setPlayerName(v)
        }}>Join room</button>
      </div>
    )
  }

  if (!roomId) {
    return (
      <Lobby onJoin={(r, name) => { setRoomId(r); setPlayerName(name) }} initialRoom={initialRoom} />
    )
  }

  return <GameRoom roomId={roomId} playerName={playerName} />
}
