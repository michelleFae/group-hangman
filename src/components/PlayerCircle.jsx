import React, { useState } from 'react'

export default function PlayerCircle({ player, onGuess, canGuess = false, isSelf = false, viewerId = null }) {
  const revealed = player.revealed || []
  const [showWord, setShowWord] = useState(false)

  // viewer-specific private arrays are stored on the player object under their own node when server processed
  // For example: rooms/{roomId}/players/{viewerId}/privateWrong/{targetId} and privateHits
  // Here, the component receives only the target player object, so viewer-side data must be injected via the player list structure.
  // We expect the parent to include viewer's private arrays under player._viewerPrivate (non-persistent field) if needed.

  // check whether the current viewer is the guesser or not
  const isViewerGuesser = !!(viewerId && player && player.id === viewerId)

  // private data for this target from the viewer's perspective may be embedded at player._viewer (populated by parent)
  const viewerPrivate = player._viewer || {}
  const privateWrong = (viewerPrivate.privateWrong && viewerPrivate.privateWrong[player.id]) || []
  const privateHits = (viewerPrivate.privateHits && viewerPrivate.privateHits[player.id]) || []

  // prepare display of owner's word with revealed letters colored red if viewer is the owner
  const ownerWord = player.word || ''
  const guessedBy = player.guessedBy || {} // map letter -> array of userIds, '__word' for full word

  const revealedSet = new Set(revealed || [])
  const fullWordRendered = ownerWord.split('').map((ch, idx) => {
    const lower = ch.toLowerCase()
    if (revealedSet.has(lower)) {
      return <span key={idx} style={{ color: 'red', fontWeight: '700' }}>{ch}</span>
    }
    return <span key={idx} style={{ color: '#333' }}>{ch}</span>
  })

  return (
    <div className="player">
      <div className="avatar">{player.name[0] || '?'}</div>
      <div className="meta">
        <div className="name">{player.name} {player.eliminated ? '(out)' : ''}</div>
        <div className="hangmoney">${player.hangmoney || 0}</div>
        <div className="revealed">{revealed.join(' ')}</div>
      </div>
      <div className="actions">
        {isSelf ? (
          <>
            <button onClick={() => setShowWord(s => !s)}>{showWord ? 'Hide word' : 'Show word'}</button>
            <div style={{ marginTop: 6 }}>{showWord ? (
              <span>{fullWordRendered}</span>
            ) : (player.word ? <span>{'_ '.repeat((player.word || '').length)}</span> : '(hidden)')}</div>

            {/* show who guessed which letters/word for the owner */}
            {Object.keys(guessedBy).length > 0 && (
              <div style={{ marginTop: 8, background: '#f6f6f6', padding: 8, borderRadius: 6 }}>
                <strong>Guessed by:</strong>
                <ul style={{ marginTop: 6, marginLeft: 18 }}>
                  {Object.entries(guessedBy).map(([k, arr]) => (
                    <li key={k}>{k === '__word' ? <span>Whole word — by: {arr.join(', ')}</span> : <span>Letter "{k}" — by: {arr.join(', ')}</span>}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div>
            <button disabled={!canGuess} onClick={() => {
              const val = prompt('Enter a single letter or a full-word guess:')
              if (!val) return
              const isLetter = val.length === 1
              onGuess(player.id, { type: isLetter ? 'letter-guess' : 'word-guess', value: val.trim() })
            }}>{canGuess ? 'Guess' : 'Locked'}</button>

            {/* show private correct hits (only visible to the guesser) */}
            {privateHits.length > 0 && (
              <div style={{ marginTop: 8, background: '#e6ffe6', padding: 6, borderRadius: 4 }}>
                <strong>Your correct guesses:</strong>
                <ul style={{ margin: '6px 0 0 12px' }}>
                  {privateHits.map((h, idx) => (
                    <li key={idx}>{h.type === 'letter' ? `Letter "${h.letter}" — ${h.count} occurrence(s)` : `Word "${h.word}"`}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* show private wrong letters/words only to the guesser */}
            {privateWrong.length > 0 && (
              <div style={{ marginTop: 8, background: '#ffe6e6', padding: 6, borderRadius: 4, color: '#900' }}>
                <strong>Wrong letters:</strong> {privateWrong.join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
