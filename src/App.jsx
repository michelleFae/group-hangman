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
  // detect stored anonymous id for this room so we can skip the inline prompt on refresh
  let storedAnonForInitial = null
  try { storedAnonForInitial = initialRoom ? (window.localStorage && window.localStorage.getItem(`gh_anon_${initialRoom}`)) : null } catch (e) { storedAnonForInitial = null }
  // start without mounting GameRoom so Lobby can run its auto-join logic
  const [roomId, setRoomId] = useState(null)
  const [playerName, setPlayerName] = useState('')
  const [password, setPassword] = useState('')
  const [autoError, setAutoError] = useState('')

  // Debug info for initial join/rejoin flow
  console.log('App startup', { initialRoom, storedAnonForInitial })

  if (!roomId) {
    const handleJoin = (r, name, pw) => {
      console.log('App.handleJoin called', { r, name, pw })
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
