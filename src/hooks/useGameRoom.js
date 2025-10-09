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
  const heartbeatRef = useRef(null)

  useEffect(() => {
    if (!db) {
      setState({ players: [], password: '' }) // Ensure default structure includes password
      return
    }

    // Subscribe to room data regardless of authentication state so anonymous users
    // can rejoin after refresh.
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const unsub = dbOnValue(roomRef, snapshot => {
      const raw = snapshot.val() || {}
      console.log('Room data updated:', raw)
      const playersObj = raw.players || {}
      // build a sanitized array of player objects with id preserved
      const players = Object.keys(playersObj).map(k => {
        const val = playersObj[k]
        if (val && typeof val === 'object') return { id: k, ...val }
        return null
      }).filter(x => x && typeof x === 'object')
      if (Object.keys(playersObj).length !== players.length) {
        try { console.warn('useGameRoom: filtered invalid entries from playersObj', { playersObj }) } catch (e) {}
      }
      setState({ ...raw, players, password: raw.password || '' })
      console.log('State updated with room data:', { ...raw, players, password: raw.password || '' })
    })

    // Keep an auth listener around (optional) but do not gate the DB subscription on it.
    let unsubscribeAuth = null
    try {
      unsubscribeAuth = onAuthStateChanged(auth, (user) => {
        // no-op: we don't need to block room subscription based on auth here
        if (!user) return
      })
    } catch (e) {
      unsubscribeAuth = null
    }

    return () => {
      try {
        if (unsub) unsub()
        if (unsubscribeAuth && typeof unsubscribeAuth === 'function') unsubscribeAuth()
        // stop any running heartbeat when the hook unmounts
        try { if (heartbeatRef.current) clearInterval(heartbeatRef.current) } catch (e) {}
      } catch (e) {}
    }
  }, [roomId])

  function stopHeartbeat() {
    try {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
    } catch (e) {}
  }

  function startHeartbeat() {
    stopHeartbeat()
    if (!db) return
    const pid = playerIdRef.current
    if (!pid) return
    const pRef = dbRef(db, `rooms/${roomId}/players/${pid}`)
    // write immediate lastSeen then schedule periodic updates
    try { update(pRef, { lastSeen: Date.now() }) } catch (e) {}
    heartbeatRef.current = setInterval(() => {
      try { update(pRef, { lastSeen: Date.now() }) } catch (e) {}
    }, 30000)
  }

  async function joinRoom(password = '') {
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
      // include lastSeen so server-side cleaners can evict stale anonymous players
      await dbSet(pRef, { id: pKey, name: playerName, hangmoney: 2, revealed: [], hasWord: false, color: chosen, lastSeen: Date.now() })
      return chosen
    }

    if (uid) {
      playerIdRef.current = uid
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      get(roomRootRef).then(snapshot => {
        const roomVal = snapshot.val() || {}
        console.log('Room data fetched:', roomVal)
        // If an authenticated player node already exists for this UID, reuse it instead of overwriting
        const playersObj = roomVal.players || {}
        if (playersObj && playersObj[uid]) {
          playerIdRef.current = uid
          const pRef = dbRef(db, `${playersRefPath}/${uid}`)
          try { update(pRef, { lastSeen: Date.now(), ...(playerName && playerName.toString().trim() ? { name: playerName } : {}) }) } catch (e) {}
          try { startHeartbeat() } catch (e) {}
          setState(prev => ({ ...prev, password: roomVal?.password || password }))
          console.log('Reused existing authenticated player node for uid', uid)
          return
        }

        if (!snapshot.exists()) {
          dbSet(roomRootRef, { hostId: uid, phase: 'lobby', open: true, players: {}, password: password || '' })
          console.log('Room created with password:', password)
          // pick color and add player
          pickColorAndSetPlayer(uid).then(chosen => {
            setState(prev => ({ ...prev, password: password }))
            console.log('Player joined new room with color:', chosen)
            try { startHeartbeat() } catch (e) {}
          })
          return
        }

        // room exists but no existing player node for this UID. Enforce open/password before creating a new node.
        if (roomVal && roomVal.open === false) {
          console.warn('Room is closed to new joins')
          return
        }
        if (roomVal.password && roomVal.password !== password) {
          console.warn('Incorrect password')
          // Do not show an alert here; let the caller (Lobby) show inline feedback
          return
        }

        // enforce max players
        const count = Object.keys(playersObj).length
        if (count >= 20) {
          alert('Room is full (20 players max)')
          return
        }

        // pick color and add player
        pickColorAndSetPlayer(uid).then(chosen => {
          setState(prev => ({ ...prev, password: roomVal?.password || password }))
          console.log('Player joined room with color:', chosen)
          try { startHeartbeat() } catch (e) {}
        })
      })
      return
    }

    const playersRef = dbRef(db, playersRefPath)
    // try to reuse a locally stored anonymous id for this room
    let storedAnonId = null
    try {
      storedAnonId = window.localStorage && window.localStorage.getItem(`gh_anon_${roomId}`)
    } catch (e) {
      storedAnonId = null
    }
    console.log('joinRoom: storedAnonId for', roomId, '=>', storedAnonId)

    if (storedAnonId) {
      // attempt to reuse existing player node
      const pRef = dbRef(db, `rooms/${roomId}/players/${storedAnonId}`)
      const snap = await get(pRef)
      if (snap && snap.exists()) {
        // rejoin existing anonymous player: preserve hangmoney/word/etc, update lastSeen
        // only update name if a non-empty playerName was provided (so refresh doesn't wipe server name)
        playerIdRef.current = storedAnonId
        try {
          const existing = snap.val() || {}
          const upd = { lastSeen: Date.now() }
          // if this is an authenticated user (uid path) don't overwrite name unless explicitly provided
          if (playerName && playerName.toString().trim()) upd.name = playerName
          await update(pRef, upd)
        } catch (e) {}
        try { startHeartbeat() } catch (e) {}
        console.log('Rejoined anonymous player id from localStorage', storedAnonId)
        return
      }
      // if stored id doesn't exist server-side, fall through and create a fresh one
    }

    // check max players before creating a new anonymous player
    const roomSnap = await get(dbRef(db, `rooms/${roomId}`))
    const rv = roomSnap.val() || {}
    const count = Object.keys(rv.players || {}).length
    if (count >= 20) {
      alert('Room is full (20 players max)')
      return
    }

    const newPlayerRef = dbPush(playersRef)
    // ensure we have a display name before creating an anonymous player
    if (!playerName || !playerName.toString().trim()) {
      console.warn('joinRoom aborted: display name required to create anonymous player')
      return
    }
    playerIdRef.current = newPlayerRef.key
    // pick color and set player using the pushed key
    pickColorAndSetPlayer(newPlayerRef.key).then(chosen => {
      try {
        window.localStorage && window.localStorage.setItem(`gh_anon_${roomId}`, newPlayerRef.key)
      } catch (e) {}
      console.log('Anonymous player joined with color:', chosen)
      try { startHeartbeat() } catch (e) {}
    })
  }

  // Attempt automatic rejoin on refresh: if we have a stored anonymous id for this room
  // and the room is already in 'playing' phase, call joinRoom to reattach the player.
  const autoRejoinTriedRef = useRef(false)
  useEffect(() => {
    if (autoRejoinTriedRef.current) return
    autoRejoinTriedRef.current = true
    if (!db) return

    let mounted = true
    ;(async () => {
      try {
        let stored = null
        try { stored = window.localStorage && window.localStorage.getItem(`gh_anon_${roomId}`) } catch (e) { stored = null }
        console.log('useGameRoom: autoRejoin check for', roomId, 'storedAnon?', !!stored)
        if (!stored) return
        const roomSnap = await get(dbRef(db, `rooms/${roomId}`))
        const room = roomSnap.val() || {}
        console.log('useGameRoom: fetched room for autoRejoin', room)
        if (!mounted) return
        // allow auto-rejoin for stored anon id or when current auth uid matches a player node
        const uid = auth && auth.currentUser && auth.currentUser.uid
        const hasAuthPlayer = uid && room.players && room.players[uid]
        // Previously we only auto-rejoined when room.phase === 'playing'. That prevented non-hosts
        // from reattaching after refresh when the host was active. Attempt rejoin whenever we have
        // a stored anon id or an authenticated player node (this is a best-effort reattach).
        if ((stored || hasAuthPlayer)) {
          console.log('useGameRoom: attempting auto rejoin via joinRoom for', roomId, 'stored?', !!stored, 'hasAuthPlayer?', !!hasAuthPlayer, 'phase', room.phase)
          try { await joinRoom(room.password || '') } catch (e) { console.warn('useGameRoom: joinRoom autoRejoin failed', e) }
        }
      } catch (e) {
        console.warn('useGameRoom: autoRejoin encountered error', e)
      }
    })()

    return () => { mounted = false }
  }, [roomId])

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
    // handle starter bonus option: generate a simple rule (require containing a letter)
    if (options && options.starterEnabled) {
      try {
        const letters = 'abcdefghijklmnopqrstuvwxyz'
        const letter = letters[Math.floor(Math.random() * letters.length)]
        updates.starterBonus = { enabled: true, type: 'contains', value: letter, description: `Contains the letter "${letter.toUpperCase()}"`, applied: false }
      } catch (e) {
        // ignore
      }
    } else {
      // ensure no stale starterBonus remains
      updates.starterBonus = null
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
  // disallow one-letter words (extra safeguard server-side)
  if (stored.length === 1) {
    console.warn('submitWord rejected: single-letter words are not allowed')
    return false
  }
  // Use update() so we don't overwrite existing fields like color or private lists
  await update(playerRef, { hasWord: true, word: stored, name: playerName })
    const playersSnap = await get(dbRef(db, `rooms/${roomId}/players`))
    const playersObj = playersSnap.val() || {}
    const allSubmitted = Object.values(playersObj).every(p => p.hasWord)
    // Award starter bonus immediately on submission so the UI can show the +10 badge during submit phase.
    // This avoids a double-award by not applying the bonus again when allSubmitted is processed.
    try {
      const roomRootRef = dbRef(db, `rooms/${roomId}`)
      const rootSnap = await get(roomRootRef)
      const roomRoot = rootSnap.val() || {}
      const sb = roomRoot.starterBonus || null
      if (sb && sb.enabled && sb.type === 'contains' && sb.value) {
        const req = (sb.value || '').toString().toLowerCase()
        if (stored && stored.indexOf(req) !== -1) {
          // award to this player if not already awarded
          const pSnap = await get(playerRef)
          const pVal = pSnap.val() || {}
          if (!pVal.starterBonusAwarded) {
            const prev = typeof pVal.hangmoney === 'number' ? pVal.hangmoney : 0
            const ups = {}
            ups[`players/${uid}/hangmoney`] = prev + 10
            ups[`players/${uid}/starterBonusAwarded`] = true
            await update(roomRootRef, ups)
          }
        }
      }

      if (allSubmitted) {
        const turnOrder = Object.keys(playersObj)
        const turnTimeout = roomRoot.turnTimeoutSeconds || null
        const timed = !!roomRoot.timed
        const updates = {
          phase: 'playing',
          turnOrder,
          currentTurnIndex: 0,
          currentTurnStartedAt: Date.now(),
          turnTimeoutSeconds: turnTimeout,
          timed
        }
        // mark starterBonus as applied so we don't attempt to re-award later
        if (roomRoot.starterBonus && roomRoot.starterBonus.enabled) updates['starterBonus/applied'] = true
        await update(roomRootRef, updates)
      }
    } catch (e) {
      console.warn('submitWord post-processing failed', e)
    }
    return true
  }

  function leaveRoom() {
    if (!playerIdRef.current) return
    if (!db) {
      setState(prev => ({ players: (prev?.players || []).filter(p => p.id !== playerIdRef.current) }))
      return
    }
    // stop heartbeat before removing node
    stopHeartbeat()
    const pid = playerIdRef.current
    const roomRef = dbRef(db, `rooms/${roomId}`)
    ;(async () => {
      try {
        const snap = await get(roomRef)
        const room = snap.val() || {}
        const playersObj = room.players || {}
        // if this player is the host, pick a replacement if one exists
        if (room.hostId && room.hostId === pid) {
          // If the game has ended, prefer to keep the room and host node so the host
          // can refresh and see the same end screen. Only transfer or delete the room
          // when the game is not in the 'ended' phase.
          if (room.phase === 'ended') {
            console.log('leaveRoom: host leaving during ended phase — preserving room and host node to allow refresh/rejoin')
            // stop heartbeat but do not remove the host node or room
            try { stopHeartbeat() } catch (e) {}
            return
          }
          const other = Object.keys(playersObj).find(k => k !== pid)
          if (other) {
            // atomically remove player and set new host
            const ups = {}
            ups[`players/${pid}`] = null
            ups['hostId'] = other
            try { await update(roomRef, ups) } catch (e) { console.warn('Could not transfer host on leave', e) }
            return
          } else {
            // no other players — remove room entirely
            try { await dbSet(roomRef, null) } catch (e) { console.warn('Could not remove empty room on host leave', e) }
            return
          }
        }
        // not host: mark the player as left (don't remove immediately) so their avatar
        // remains visible and guessable for a short grace period. Eviction will remove
        // them after the configured TTL (server-side).
        const pRef = dbRef(db, `rooms/${roomId}/players/${pid}`)
        try {
          await update(pRef, { leftAt: Date.now(), lastSeen: Date.now(), present: false })
        } catch (e) { console.warn('Could not mark player as left on leave', e) }
      } catch (e) {
        // best-effort: attempt direct remove
        try { const pRef = dbRef(db, `rooms/${roomId}/players/${playerIdRef.current}`); await update(pRef, { leftAt: Date.now(), lastSeen: Date.now(), present: false }) } catch (err) { console.warn('leaveRoom fallback mark-left failed', err) }
      }
    })()
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
