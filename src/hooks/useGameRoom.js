import { useEffect, useState, useRef } from 'react'
import { db, auth } from '../firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { get, update } from 'firebase/database'
import {
  ref as dbRef,
  onValue as dbOnValue,
  set as dbSet,
  push as dbPush,
} from 'firebase/database'

export default function useGameRoom(roomId, playerName) {
  const [state, setState] = useState(null)
  const playerIdRef = useRef(null)

  useEffect(() => {
    if (!db || !auth) {
      setState({ players: [] })
      return
    }

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setState({ players: [] })
        return
      }

      const roomRef = dbRef(db, `rooms/${roomId}`)
      const unsub = dbOnValue(roomRef, snapshot => {
        const raw = snapshot.val() || {}
        const playersObj = raw.players || {}
        const players = Object.keys(playersObj).map(k => playersObj[k])
        setState({ ...raw, players })
      })

      const cleanup = () => unsub()
      unsubscribeAuth._dbUnsub = cleanup
    })

    return () => {
      try {
        if (unsubscribeAuth && typeof unsubscribeAuth === 'function') {
          if (unsubscribeAuth._dbUnsub) unsubscribeAuth._dbUnsub()
          unsubscribeAuth()
        }
      } catch (e) {}
    }
  }, [roomId])

  function joinRoom() {
    if (!db) {
      playerIdRef.current = 'local-' + Math.random().toString(36).slice(2, 8)
      setState(prev => ({
        ...prev,
        players: [...(prev?.players || []), { id: playerIdRef.current, name: playerName, hangmoney: 2, revealed: [] }]
      }))
      return
    }

    const uid = auth && auth.currentUser ? auth.currentUser.uid : null
    const playersRefPath = `rooms/${roomId}/players`

    if (uid) {
      playerIdRef.current = uid
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      get(roomRootRef).then(snapshot => {
        const roomVal = snapshot.val()
        if (!snapshot.exists()) {
          dbSet(roomRootRef, { hostId: uid, phase: 'lobby', open: true, players: {} })
        } else if (roomVal && roomVal.open === false) {
          console.warn('Room is closed to new joins')
          return
        }
        const pRef = dbRef(db, `${playersRefPath}/${uid}`)
        dbSet(pRef, { id: uid, name: playerName, hangmoney: 2, revealed: [], hasWord: false })
      })
      return
    }

    const playersRef = dbRef(db, playersRefPath)
    const newPlayerRef = dbPush(playersRef)
    playerIdRef.current = newPlayerRef.key
    dbSet(newPlayerRef, { id: newPlayerRef.key, name: playerName, hangmoney: 2, revealed: [], hasWord: false })
  }

  async function startGame() {
    if (!db) return
    const uid = playerIdRef.current
    if (!uid) return
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.hostId !== uid) return
    await update(roomRef, { phase: 'submit', open: false })
  }

  async function submitWord(word) {
    if (!db) return
    const uid = playerIdRef.current
    if (!uid) return
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.phase !== 'submit') {
      console.warn('Cannot submit word: room not in submit phase')
      return
    }
    const playerRef = dbRef(db, `rooms/${roomId}/players/${uid}`)
    await dbSet(playerRef, { id: uid, name: playerName, hangmoney: 2, revealed: [], hasWord: true, word })
    const playersSnap = await get(dbRef(db, `rooms/${roomId}/players`))
    const playersObj = playersSnap.val() || {}
    const allSubmitted = Object.values(playersObj).every(p => p.hasWord)
    if (allSubmitted) {
      const turnOrder = Object.keys(playersObj)
      await update(dbRef(db, `rooms/${roomId}`), { phase: 'playing', turnOrder, currentTurnIndex: 0 })
    }
  }

  function leaveRoom() {
    if (!playerIdRef.current) return
    if (!db) {
      setState(prev => ({ players: (prev?.players || []).filter(p => p.id !== playerIdRef.current) }))
      return
    }
    const pRef = dbRef(db, `rooms/${roomId}/players/${playerIdRef.current}`)
    dbSet(pRef, null)
  }

  async function sendGuess(targetId, payload) {
    const useServer = import.meta.env.VITE_USE_SERVERLESS === '1' || import.meta.env.VITE_USE_SERVERLESS === 'true'
    const payloadVal = (payload && payload.value) ? String(payload.value).trim() : ''
    if (!payloadVal) return

    if (useServer) {
      if (!auth || !auth.currentUser) {
        console.warn('Not authenticated for serverless call')
        return
      }
      try {
        const token = await auth.currentUser.getIdToken()
        const res = await fetch('/api/processGuess', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ roomId, targetId, value: payloadVal })
        })
        if (!res.ok) {
          // fallback to DB queue if serverless endpoint not reachable or returned error
          console.warn('Serverless endpoint returned non-ok, falling back to DB queue')
        } else {
          return
        }
      } catch (e) {
        console.error('Serverless guess failed, falling back to DB queue', e)
        // fall through to DB queue push
      }
    }

    if (!db) {
      console.log('guess (local):', { from: playerIdRef.current, target: targetId, payload })
      return
    }

    const qRef = dbRef(db, `rooms/${roomId}/queue`)
    await dbPush(qRef, { from: playerIdRef.current, target: targetId, payload, ts: Date.now() })
  }

  return { state, joinRoom, leaveRoom, sendGuess, startGame, submitWord, playerId: () => playerIdRef.current }
}
