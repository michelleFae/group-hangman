import React, { useState } from 'react'

export default function PlayerCircle({ player, onGuess, canGuess = false, isSelf = false, viewerId = null, playerIdToName = {}, phase = 'lobby', hasSubmitted = false, timeLeftMs = null, currentTurnId = null, flashPenalty = false, pendingDeduct = 0 }) {
  const revealed = player.revealed || []
  const [showWord, setShowWord] = useState(false)
  const [soundedLow, setSoundedLow] = useState(false)
  const [animateHang, setAnimateHang] = useState(false)
  const [showGuessDialog, setShowGuessDialog] = useState(false)
  const [guessValue, setGuessValue] = useState('')

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

  // masked word rendering for non-owners and default view
  // Masked rendering: only show underscores (and letter count) if the viewer has explicit permission
  // to see masked structure (e.g. via a power-up). Otherwise keep it fully hidden to avoid revealing length.
  const showMasked = !!(player && player._viewer && player._viewer.showMasked)
  const maskedRendered = showMasked ? ownerWord.split('').map((ch, idx) => {
    const lower = ch.toLowerCase()
    if (revealedSet.has(lower)) {
      return <span key={idx} style={{ color: '#000', fontWeight: 700, marginRight: 4 }}>{ch}</span>
    }
    return <span key={idx} style={{ color: '#999', marginRight: 4 }}>_</span>
  }) : null

  // derive halo color (semi-transparent) from player.color
  const avatarColor = player.color || '#FFD1D1'
  // Convert hex to rgba with 0.28 alpha
  function hexToRgba(hex, alpha = 0.28) {
    const h = hex.replace('#', '')
    const bigint = parseInt(h.length === 3 ? h.split('').map(c => c+c).join('') : h, 16)
    const r = (bigint >> 16) & 255
    const g = (bigint >> 8) & 255
    const b = bigint & 255
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const haloRgba = hexToRgba(avatarColor, 0.28)

  // play a short beep when time goes under 5s, and a different beep when time expires
  React.useEffect(() => {
    if (timeLeftMs == null) {
      setSoundedLow(false)
      return
    }
    const s = Math.ceil(timeLeftMs / 1000)
    if (s <= 0) {
      // expired
      try { navigator.vibrate && navigator.vibrate(200) } catch (e) {}
      // short lower-pitch beep for end
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = 'sine'
        o.frequency.value = 220
        g.gain.value = 0.001
        o.connect(g); g.connect(ctx.destination)
        o.start()
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
        setTimeout(() => { o.stop(); ctx.close() }, 400)
      } catch (e) {}
      setSoundedLow(false)
      return
    }
    if (s <= 5 && !soundedLow) {
      try { navigator.vibrate && navigator.vibrate([60,30,60]) } catch (e) {}
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = 'sine'
        o.frequency.value = 880
        g.gain.value = 0.002
        o.connect(g); g.connect(ctx.destination)
        o.start()
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12)
        setTimeout(() => { o.stop(); ctx.close() }, 160)
      } catch (e) {}
      setSoundedLow(true)
    }
  }, [timeLeftMs])

  // when parent signals penalty flash, animate hangmoney briefly
  React.useEffect(() => {
    if (flashPenalty) {
      setAnimateHang(true)
      const id = setTimeout(() => setAnimateHang(false), 1000)
      return () => clearTimeout(id)
    }
  }, [flashPenalty])

  return (
    <div className={`player ${!hasSubmitted && phase === 'submit' ? 'waiting-pulse' : ''} ${flashPenalty ? 'flash-penalty' : ''}`} style={{ ['--halo']: haloRgba }}>
      <div className="avatar" style={{ background: avatarColor }}>{player.name[0] || '?'}</div>
      <div className="meta">
        <div className="name">{player.name} {player.eliminated ? '(out)' : ''}
          {player.starterBonusAwarded && phase === 'submit' && (
            <span className="starter-badge" title="Starter bonus awarded">+10</span>
          )}
        </div>
        {/* Show pending deduction visually while DB update appears; pendingDeduct is negative for a deduction */}
        <div className={`hangmoney ${animateHang ? 'decrement' : ''}`}>${(Number(player.hangmoney) || 0) + (Number(pendingDeduct) || 0)}</div>
        <div className="revealed">{revealed.join(' ')}</div>
      </div>
      <div className="actions">
        {/* Controls first for non-self viewers, then hidden word below (so Locked appears above hidden) */}
        {isSelf ? (
          <div style={{ marginBottom: 8 }}>
            <button onClick={() => setShowWord(s => !s)}>{showWord ? 'Hide word' : 'Show word'}</button>
            <div style={{ marginTop: 6 }}>{showWord ? (
              <span>{fullWordRendered}</span>
            ) : (player.word ? <span>{'_ '.repeat((player.word || '').length)}</span> : '(hidden)')}</div>
          </div>
        ) : (
          <div style={{ marginBottom: 8 }}>
            <div>
              <>
                <button disabled={!canGuess} onClick={() => { if (canGuess) { setShowGuessDialog(true); setGuessValue('') } }}>{canGuess ? 'Guess' : 'Locked'}</button>
                {showGuessDialog && (
                  <div className="guess-dialog card" role="dialog" aria-label={`Guess for ${player.name}`}>
                    <input placeholder="letter or full word" value={guessValue} onChange={e => setGuessValue(e.target.value)} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button onClick={() => {
                        const val = (guessValue || '').trim()
                        if (!val) return
                        const isLetter = val.length === 1 && /^[a-zA-Z]$/.test(val)
                        onGuess(player.id, { type: isLetter ? 'letter-guess' : 'word-guess', value: val })
                        setShowGuessDialog(false)
                      }}>Submit</button>
                      <button onClick={() => setShowGuessDialog(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </>

              {/* show private correct hits (only visible to the guesser) */}
              {privateHits.length > 0 && (
                <div style={{ marginTop: 8, background: '#e6ffe6', padding: 6, borderRadius: 4 }}>
                  <strong>Your correct guesses:</strong>
                  <ul style={{ margin: '6px 0 0 12px' }}>
                    {privateHits.map((h, idx) => (
                      <li key={idx} style={{ marginTop: 6 }}>
                        {h.type === 'letter' ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div>Letter "{h.letter}" — {h.count} occurrence(s)</div>
                            <div className="private-hit-chips">
                              {new Array(Math.max(1, Number(h.count) || 1)).fill(0).map((_, i) => (
                                <span key={i} className="hit-chip">{h.letter}</span>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div>Word "{h.word}"</div>
                        )}
                      </li>
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
            {/* hidden word below locked/guess */}
            <div style={{ marginTop: 8 }}>
              {player.word ? (
                showMasked ? <span>{maskedRendered}</span> : <span>(hidden)</span>
              ) : <span>(hidden)</span>}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
