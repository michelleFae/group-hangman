import React, { useEffect, useState } from 'react'
import PlayerCircle from './PlayerCircle'
import useGameRoom from '../hooks/useGameRoom'

export default function GameRoom({ roomId, playerName }) {
  const { state, joinRoom, leaveRoom, sendGuess, startGame, submitWord, playerId } = useGameRoom(roomId, playerName)
  const [word, setWord] = useState('')
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    joinRoom()
    return () => leaveRoom()
  }, [])

  if (!state) return <div>Loading room...</div>

  const phase = state.phase || 'lobby'
  const hostId = state.hostId
  const players = state.players || []
  const submittedCount = players.filter(p => p.hasWord).length

  const isHost = hostId && window.__firebaseAuth && window.__firebaseAuth.currentUser && window.__firebaseAuth.currentUser.uid === hostId
  const myId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
  const currentTurnIndex = state.currentTurnIndex || 0
  const currentTurnId = (state.turnOrder || [])[currentTurnIndex]

  return (
    <div className="game-room">
      <h2>Room: {roomId} — phase: {phase}</h2>
      {isHost && phase === 'lobby' && (
        <button onClick={() => startGame()}>Start game</button>
      )}
      <div className="share-room">
        <small>Share this link to invite:</small>
        <div>
          <input readOnly value={new URL(window.location.href).origin + '?room=' + roomId} style={{ width: 360 }} />
          <button onClick={async () => { await navigator.clipboard.writeText(new URL(window.location.href).origin + '?room=' + roomId); alert('Link copied') }}>Copy</button>
        </div>
      </div>
      <div className="circle">
        {players.length === 0 && <div>No players yet — wait for others to join.</div>}
        <div className="turn-indicator">Current turn: {players.find(p => p.id === currentTurnId)?.name || '—'}</div>
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
          const playerWithViewer = { ...p, _viewer: viewerPrivate }

          return (
            <PlayerCircle key={p.id}
                          player={playerWithViewer}
                          isSelf={p.id === myId}
                          viewerId={myId}
                          canGuess={phase === 'playing' && myId === currentTurnId && p.id !== myId}
                          onGuess={(targetId, guess) => sendGuess(targetId, guess)} />
          )
        })}
      </div>

      {phase === 'submit' && (
        <div className="submit-word">
          <h3>Submit your secret word</h3>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${(players.length ? (submittedCount / players.length) * 100 : 0)}%`, background: '#4caf50', height: 12, borderRadius: 6 }} />
            <div style={{ marginTop: 6 }}>{submittedCount} / {players.length} submitted</div>
          </div>
          {!submitted ? (
            <>
              <input placeholder="your word" value={word} onChange={e => setWord(e.target.value)} />
              <button onClick={async () => { await submitWord(word); setSubmitted(true) }}>Submit</button>
            </>
          ) : (
            <div>Submitted — waiting for others</div>
          )}
        </div>
      )}

      <div className="controls">
        {/* Controls for guesses and power-ups will go here during playing phase */}
      </div>
    </div>
  )
}
