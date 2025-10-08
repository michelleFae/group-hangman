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
      setState({ players: [], password: '' }) // Ensure default structure includes password
      return
    }

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setState({ players: [], password: '' }) // Ensure default structure includes password
        return
      }

      const roomRef = dbRef(db, `rooms/${roomId}`)
      const unsub = dbOnValue(roomRef, snapshot => {
        const raw = snapshot.val() || {}
        console.log('Room data updated:', raw)
        const playersObj = raw.players || {}
        const players = Object.keys(playersObj).map(k => playersObj[k])
        setState({ ...raw, players, password: raw.password || '' })
        console.log('State updated with room data:', { ...raw, players, password: raw.password || '' })
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

  function joinRoom(password = '') {
    console.log('joinRoom called with password:', password)
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

    // pastel palette (Anxiously Cute)
    const palette = ['#B39DDB','#81D4FA','#FFABAB','#FFD54F','#C5E1A5','#F8BBD0','#B2EBF2']

    async function pickColorAndSetPlayer(pKey) {
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      const roomSnap = await get(roomRootRef)
      const roomVal = roomSnap.val() || {}
      const playersObj = roomVal.players || {}
      const used = new Set(Object.keys(playersObj).map(k => playersObj[k] && playersObj[k].color).filter(Boolean))
      let chosen = palette.find(c => !used.has(c))
      if (!chosen) {
        // deterministic fallback based on player key
        const hash = Array.from((pKey || '').toString()).reduce((acc,ch)=>acc + ch.charCodeAt(0), 0)
        chosen = palette[hash % palette.length]
      }
      const pRef = dbRef(db, `${playersRefPath}/${pKey}`)
      await dbSet(pRef, { id: pKey, name: playerName, hangmoney: 2, revealed: [], hasWord: false, color: chosen })
      return chosen
    }

    if (uid) {
      playerIdRef.current = uid
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      get(roomRootRef).then(snapshot => {
        const roomVal = snapshot.val() || {}
        console.log('Room data fetched:', roomVal)
        if (!snapshot.exists()) {
          dbSet(roomRootRef, { hostId: uid, phase: 'lobby', open: true, players: {}, password: password || '' })
          console.log('Room created with password:', password)
        } else if (roomVal && roomVal.open === false) {
          console.warn('Room is closed to new joins')
          return
        } else if (roomVal.password && roomVal.password !== password) {
          console.warn('Incorrect password')
          // Do not show an alert here; let the caller (Lobby) show inline feedback
          return
        }
        // enforce max players
        const playersObj = roomVal.players || {}
        const count = Object.keys(playersObj).length
        if (count >= 20) {
          alert('Room is full (20 players max)')
          return
        }
        // pick color and add player
        pickColorAndSetPlayer(uid).then(chosen => {
          setState(prev => ({ ...prev, password: roomVal?.password || password }))
          console.log('Player joined room with color:', chosen)
        })
      })
      return
    }

    const playersRef = dbRef(db, playersRefPath)
    const newPlayerRef = dbPush(playersRef)
    playerIdRef.current = newPlayerRef.key
    // pick color and set player using the pushed key
    // check max players for anonymous joins
    get(dbRef(db, `rooms/${roomId}`)).then(snap => {
      const rv = snap.val() || {}
      const count = Object.keys(rv.players || {}).length
      if (count >= 20) {
        alert('Room is full (20 players max)')
        return
      }
      pickColorAndSetPlayer(newPlayerRef.key).then(chosen => {
        console.log('Anonymous player joined with color:', chosen)
      })
    })
  }

  async function startGame(options = {}) {
    if (!db) return
    const uid = playerIdRef.current
    if (!uid) return
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const snap = await get(roomRef)
    const room = snap.val() || {}
    if (room.hostId !== uid) return
    // options: { timed: boolean, turnSeconds: number }
    const updates = { phase: 'submit', open: false }
    if (options && options.timed) {
      updates.timed = true
      updates.turnTimeoutSeconds = Math.max(10, Math.min(300, Number(options.turnSeconds) || 30))
    } else {
      updates.timed = false
      updates.turnTimeoutSeconds = null
    }
    await update(roomRef, updates)
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
  const stored = (word || '').toString().trim().toLowerCase()
  // Use update() so we don't overwrite existing fields like color or private lists
  await update(playerRef, { hasWord: true, word: stored, name: playerName })
    const playersSnap = await get(dbRef(db, `rooms/${roomId}/players`))
    const playersObj = playersSnap.val() || {}
    const allSubmitted = Object.values(playersObj).every(p => p.hasWord)
    if (allSubmitted) {
      const turnOrder = Object.keys(playersObj)
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      const rootSnap = await get(roomRootRef)
      const roomRoot = rootSnap.val() || {}
      const turnTimeout = roomRoot.turnTimeoutSeconds || null
      const timed = !!roomRoot.timed
      await update(roomRootRef, {
        phase: 'playing',
        turnOrder,
        currentTurnIndex: 0,
        currentTurnStartedAt: Date.now(),
        turnTimeoutSeconds: turnTimeout,
        timed
      })
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
