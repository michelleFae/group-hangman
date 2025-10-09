import React, { useState, useEffect, useRef } from 'react'

export default function PlayerCircle({ player, onGuess, canGuess = false, isSelf = false, viewerId = null, playerIdToName = {}, phase = 'lobby', hasSubmitted = false, timeLeftMs = null, currentTurnId = null, flashPenalty = false, pendingDeduct = 0, isWinner = false, showPowerUpButton = false, onOpenPowerUps = null, powerUpDisabledReason = null }) {
  // accept starterApplied prop to control when starter badge is visible
  const starterApplied = arguments[0] && arguments[0].starterApplied
  const revealed = player.revealed || []
  const [showWord, setShowWord] = useState(false)
  const [soundedLow, setSoundedLow] = useState(false)
  const [animateHang, setAnimateHang] = useState(false)
  const [pulse, setPulse] = useState(false)
  const lastDisplayedRef = useRef(null)
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
  const privatePowerRevealsObj = viewerPrivate.privatePowerReveals || {}
  // collect all private power-up reveals the viewer has stored, then filter those relevant to this player
  const _allPrivateReveals = []
  Object.values(privatePowerRevealsObj || {}).forEach(bucket => {
    Object.values(bucket || {}).forEach(r => { if (r) _allPrivateReveals.push(r) })
  })
  // show reveals that target this player (r.to === player.id). This covers cases where
  // the buyer stored under targetId (buyer view) and where the target stored under buyerId (target view).
  const privatePowerRevealsList = _allPrivateReveals.filter(r => r && (r.to === player.id))

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

  // pulse when the displayed hangmoney amount changes
  useEffect(() => {
    const displayed = (Number(player.hangmoney) || 0) + (Number(pendingDeduct) || 0)
    if (lastDisplayedRef.current !== null && lastDisplayedRef.current !== displayed) {
      setPulse(true)
      const id = setTimeout(() => setPulse(false), 450)
      return () => clearTimeout(id)
    }
    lastDisplayedRef.current = displayed
  }, [player.hangmoney, pendingDeduct])

  const isTurn = currentTurnId && currentTurnId === player.id
  return (
    <div className={`player ${isSelf ? 'player-self' : ''} ${isTurn ? 'player-turn' : ''} ${!hasSubmitted && phase === 'submit' ? 'waiting-pulse' : ''} ${flashPenalty ? 'flash-penalty' : ''}`} style={{ ['--halo']: haloRgba }}>
      <div className="avatar" style={{ background: avatarColor }}>{player.name[0] || '?'}</div>
      <div className="meta">
        <div className="name">{player.name} {player.eliminated ? '(out)' : ''}
          {player.starterBonusAwarded && phase === 'submit' && starterApplied && (
            <span className="starter-badge" title="Starter bonus awarded">+10</span>
          )}
        </div>
        {/* Show pending deduction visually while DB update appears; pendingDeduct is negative for a deduction */}
        <div className={`hangmoney ${animateHang ? 'decrement' : ''} ${pulse ? 'pulse' : ''}`}>
          <span style={{ background: '#f3f3f3', color: isWinner ? '#b8860b' : '#222', padding: '4px 8px', borderRadius: 12, display: 'inline-block', minWidth: 44, textAlign: 'center', fontWeight: 700, transition: 'transform 180ms ease, box-shadow 180ms ease' }}>
            ${(Number(player.hangmoney) || 0) + (Number(pendingDeduct) || 0)}
          </span>
        </div>
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
                {/* power-up button visible when parent allows it (e.g. it's your turn) */}
                {onOpenPowerUps && !isSelf && !player.eliminated && (
                  <button
                    title={powerUpDisabledReason || 'Open power-ups'}
                    onClick={(e) => { e.stopPropagation(); if (powerUpDisabledReason) return; onOpenPowerUps(player.id) }}
                    disabled={!!powerUpDisabledReason}
                    style={{ marginLeft: 8, opacity: powerUpDisabledReason ? 0.55 : 1, cursor: powerUpDisabledReason ? 'not-allowed' : 'pointer' }}
                  >
                    ⚡ Power-up
                  </button>
                )}
                {showGuessDialog && (
                  <div className="guess-dialog card" role="dialog" aria-label={`Guess for ${player.name}`}>
                    <input id={`guess_for_${player.id}`} name={`guess_for_${player.id}`} placeholder="letter or full word" value={guessValue} onChange={e => setGuessValue(e.target.value)} />
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
                    {privateHits.map((h, idx) => {
                      const isNoScore = h && h.note === 'no-score'
                      return (
                        <li key={idx} style={{ marginTop: 6 }}>
                          {h.type === 'letter' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ color: isNoScore ? '#555' : 'inherit' }}>Letter "{h.letter}" — {h.count} occurrence(s){isNoScore ? ' ' : ''}{isNoScore && <small title="This was revealed by a power-up and does not award points when guessed." style={{ color: '#777', marginLeft: 6 }}>(no points)</small>}</div>
                              <div className="private-hit-count" style={{ background: isNoScore ? '#efefef' : '#c8f5c8', color: isNoScore ? '#444' : '#0b6623', padding: '4px 8px', borderRadius: 8, fontWeight: 700 }}>{h.count}x</div>
                            </div>
                          ) : (
                            <div style={{ color: isNoScore ? '#777' : 'inherit' }}>Word "{h.word}"{isNoScore && <small title="This was revealed by a power-up and does not award points when guessed." style={{ color: '#777', marginLeft: 6 }}>(no points)</small>}</div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {/* show private wrong letters/words only to the guesser */}
              {privateWrong.length > 0 && (
                <div style={{ marginTop: 8, background: '#ffe6e6', padding: 6, borderRadius: 4, color: '#900' }}>
                  <strong>Wrong letters:</strong> {privateWrong.join(', ')}
                </div>
              )}

              {/* show private power-up reveals (only visible to the viewer) */}
              {privatePowerRevealsList.length > 0 && (
                <div style={{ marginTop: 8, background: '#eef6ff', padding: 6, borderRadius: 4 }}>
                  <strong>Power-up results:</strong>
                  <ul style={{ margin: '6px 0 0 12px' }}>
                    {privatePowerRevealsList.map((r, idx) => {
                      const res = r && r.result
                      return (
                        <li key={idx} style={{ marginTop: 6 }}>
                          {res && res.message ? (
                            <div>{res.message}</div>
                          ) : r.powerId === 'letter_for_letter' ? (
                            res && res.letterFromTarget ? (
                              <div>One letter revealed: <strong>{res.letterFromTarget}</strong></div>
                            ) : res && res.letterFromBuyer ? (
                              <div>Used letter for letter. You can guess this letter:<strong>{res.letterFromBuyer}</strong></div>
                            ) : (
                              <div>{r.powerId}: {JSON.stringify(res)}</div>
                            )
                          ) : (
                            <div>{r.powerId}: {JSON.stringify(res)}</div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
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
