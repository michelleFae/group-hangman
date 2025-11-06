import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function PlayerCircle({
  onSkip = null,
  player,
  onGuess,
  canGuess = false,
  isSelf = false,
  isHost = false,
  revealPreserveOrder = true,
  revealShowBlanks = true,
  viewerId = null,
  viewerIsSpy = false,
  playerIdToName = {},
  phase = 'lobby',
  hasSubmitted = false,
  timeLeftMs = null,
  currentTurnId = null,
  flashPenalty = false,
  pendingDeduct = 0,
  isWinner = false,
  showPowerUpButton = false,
  onOpenPowerUps = null,
  powerUpDisabledReason = null,
  starterApplied = false
  , ddActive = false,
  ddTarget = null
  , gameMode = 'money'
  , teamName = null
  , teamMoney = 0
  , viewerTeam = null
  , roomId = null
  , teamRevealForPlayer = false
  , onToggleTeamReveal = null
  , ready = false
  , onToggleReady = null
  , showGhostReenter = false
  , onGhostReenter = null
  , ghostReenterDisabled = false
}) {
  // hostId prop supported for safety (may be passed in by parent)
  const hostId = arguments[0] && arguments[0].hostId ? arguments[0].hostId : null
  const onRemove = arguments[0] && arguments[0].onRemove ? arguments[0].onRemove : null
  // hostId is optional prop; when provided, ensure the host's own revealed area shows public reveals
  // so the host and other players can see letters guessed for the host's word.
  const revealed = player.revealed || []
  // colors used for styling power-up names and revealed letters
  const powerNameColor = '#2b8cff'
  const revealedLetterColor = '#ffcc00'
  // Set of power-up ids considered important (fallback when reveal.updateType is missing)
  const IMPORTANT_POWERS = new Set([
    'vowel_vision', 'letter_scope', 'zeta_drop', 'letter_peek', 'related_word', 'sound_check', 'what_do_you_mean', 'longest_word_bonus', 'full_reveal', 'rare_trace'
  ])
  const [showWord, setShowWord] = useState(false)
  const [soundedLow, setSoundedLow] = useState(false)
  const [animateHang, setAnimateHang] = useState(false)
  const [pulse, setPulse] = useState(false)
  const lastDisplayedRef = useRef(null)
  const lastTotalRef = useRef(null)
  const lastGainTsRef = useRef(0)
  const [showGuessDialog, setShowGuessDialog] = useState(false)
  const rootRef = useRef(null)
  const [ghostPortalPos, setGhostPortalPos] = useState(null)
  const [guessValue, setGuessValue] = useState('')
  // small transient ignore window to avoid immediately-closing the guess dialog
  // when parent state updates (turn/time) race with the click that opened it.
  const ignoreCloseUntilRef = useRef(0)
  // (removed guess-closed toast; keep dialog open/closed logic only)
  // default expanded: show info by default for all players (button will hide it)
  const [expanded, setExpanded] = useState(true)
  // teammates' full-word view must be explicitly enabled; default off to avoid leakage
  const [showTeammateWord, setShowTeammateWord] = useState(false)
  const [showOwnWord, setShowOwnWord] = useState(true)

  useEffect(() => {
    // When entering Word Seeker mode, ensure interactive controls are closed/hidden
    if (gameMode === 'wordSeeker') {
      setShowGuessDialog(false)
      setExpanded(false)
    }
  }, [gameMode])

  // Close the guess dialog when the turn timer expires or the turn moves away.
  useEffect(() => {
    try {
      // Only act when the dialog is currently open
      if (!showGuessDialog) return
      // If the guess dialog is open and there is no time left for this player, close it and show toast
      if (typeof timeLeftMs === 'number' && timeLeftMs <= 0) {
        // If the dialog was just opened, treat this as a transient update and skip closing
        if (Date.now() < (ignoreCloseUntilRef.current || 0)) {
          try { if (typeof window !== 'undefined' && window.__GH_DEBUG_GUESS) console.debug('PlayerCircle: skipping close due to transient timeLeftMs update', { playerId: player.id, timeLeftMs, currentTurnId, ignoreUntil: ignoreCloseUntilRef.current }) } catch (e) {}
        } else {
          // Debug: log why we're closing the guess dialog
          try { if (typeof window !== 'undefined' && window.__GH_DEBUG_GUESS) console.debug('PlayerCircle: closing guess dialog due to timeLeftMs', { playerId: player.id, timeLeftMs, currentTurnId }) } catch (e) {}
          // simply close the dialog when time runs out
          ignoreCloseUntilRef.current = 0
          console.log("Michelle 1: in the else")
          setShowGuessDialog(false)
        }
      }
      // If the guess dialog is open but the current turn changed away from this player, close it and show toast
      else if (currentTurnId && currentTurnId !== player.id) {
        // If the dialog was just opened, treat an immediate turn flip as possibly transient and skip
        if (Date.now() < (ignoreCloseUntilRef.current || 0)) {
          try { if (typeof window !== 'undefined' && window.__GH_DEBUG_GUESS) console.debug('PlayerCircle: skipping close due to transient turn change', { playerId: player.id, currentTurnId, ignoreUntil: ignoreCloseUntilRef.current }) } catch (e) {}
        } else {
          try { if (typeof window !== 'undefined' && window.__GH_DEBUG_GUESS) console.debug('PlayerCircle: closing guess dialog due to turn change', { playerId: player.id, currentTurnId }) } catch (e) {}
          // simply close the dialog when the turn moves away
          ignoreCloseUntilRef.current = 0
          console.log("Michelle 3: in the else")
          setShowGuessDialog(false)
        }
      }
    } catch (e) {console.error("Michelle 2: in the else")}
    return () => {}
  }, [timeLeftMs, currentTurnId, showGuessDialog, player.id])


  // Log showGuessDialog changes when debug flag is enabled to help trace rerenders
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.__GH_DEBUG_GUESS) {
        console.debug('PlayerCircle: showGuessDialog changed', { playerId: player.id, showGuessDialog, currentTurnId, timeLeftMs })
      }
    } catch (e) {}
  }, [showGuessDialog, currentTurnId, timeLeftMs, player.id])

  // Inject thin black scrollbar styling for powerup results (fallback to avoid editing global CSS file)
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return
      if (document.getElementById('gh-powerup-scroll-css')) return
      const css = `
        .powerup-results-scroll { scrollbar-width: thin; scrollbar-color: #000000 transparent; }
        .powerup-results-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .powerup-results-scroll::-webkit-scrollbar-track { background: transparent; }
        .powerup-results-scroll::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.95); border-radius: 999px; border: 2px solid transparent; }
      `
      const s = document.createElement('style')
      s.id = 'gh-powerup-scroll-css'
      s.appendChild(document.createTextNode(css))
      document.head.appendChild(s)
    } catch (e) {}
    return () => {}
  }, [])

  const hideInteractiveForWordSeeker = (gameMode === 'wordSeeker')

  const viewerPrivate = player._viewer || {}
  const privateWrong = (viewerPrivate.privateWrong && viewerPrivate.privateWrong[player.id]) || []
  const privateHits = (viewerPrivate.privateHits && viewerPrivate.privateHits[player.id]) || []
  const privatePowerRevealsObj = viewerPrivate.privatePowerReveals || {}

  const _allPrivateReveals = []
  Object.values(privatePowerRevealsObj || {}).forEach(bucket => {
    Object.values(bucket || {}).forEach(r => { if (r) _allPrivateReveals.push(r) })
  })
  const privatePowerRevealsList = Array.isArray(_allPrivateReveals) ? _allPrivateReveals.filter(r => r && (r.to === player.id)) : []

  // Also collect reveals that were originated by the viewer (r.from === viewerId)
  // but only when the reveal targeted this player (r.to === player.id). This
  // ensures we only include buyer-origin reveals that actually apply to the
  // current player's tile and prevents leaking buyer reveals into unrelated tiles.
  const privatePowerRevealsByPlayer = Array.isArray(_allPrivateReveals) ? _allPrivateReveals.filter(r => r && viewerId && r.from === viewerId && r.to === player.id) : []

  const privateLetterSource = {}
  // Build privateLetterSource with clear precedence: reveals that targeted this player
  // take priority. Then include reveals that originated from this player but do not
  // overwrite existing mappings. Also preserve overridePublicColor entries.
  const assignIfMissing = (key, src) => { if (!privateLetterSource[key]) privateLetterSource[key] = src }

  // process targeted reveals first (highest precedence)
  const targetedReveals = Array.isArray(privatePowerRevealsList) ? privatePowerRevealsList : (privatePowerRevealsList ? Object.values(privatePowerRevealsList) : [])
  targetedReveals.forEach(r => {
    if (!r || !r.result) return
    const res = r.result
    const sourceId = r.from
    const push = (s) => {
      if (!s) return
      const lower = (s||'').toLowerCase()
      if (lower) assignIfMissing(lower, sourceId)
    }
    push(res.letterFromTarget)
  // also map letterFromBuyer when this reveal targeted this player so that
  // buyer-side private reveals (letters revealed on the buyer's own word)
  // are attributed to the revealer (r.from) and therefore render in their color
  // on the buyer's screen when not publicly revealed.
  push(res.letterFromBuyer)
    push(res.letter)
    push(res.last)
    if (res.letters && Array.isArray(res.letters)) res.letters.forEach(ch => { if (ch) assignIfMissing((ch||'').toLowerCase(), sourceId) })
    if (res.overridePublicColor) {
      const letter = (res.letterFromTarget || res.letter || res.last)
      if (letter) {
        const lower = (letter || '').toLowerCase()
        if (lower) assignIfMissing(`__override__${lower}`, sourceId)
      }
    }
  })

  // now process reveals that originated from this player but only set keys that
  // are not already set by targeted reveals (we don't want to overwrite the actor
  // who actually revealed letters on this tile).
  const byPlayerReveals = Array.isArray(privatePowerRevealsByPlayer) ? privatePowerRevealsByPlayer : (privatePowerRevealsByPlayer ? Object.values(privatePowerRevealsByPlayer) : [])
  byPlayerReveals.forEach(r => {
    if (!r || !r.result) return
    const res = r.result
    const sourceId = r.from
    const push = (s) => {
      if (!s) return
      const lower = (s||'').toLowerCase()
      if (lower) assignIfMissing(lower, sourceId)
    }
    push(res.letterFromBuyer)
    push(res.letter)
    push(res.last)
    if (res.letters && Array.isArray(res.letters)) res.letters.forEach(ch => { if (ch) assignIfMissing((ch||'').toLowerCase(), sourceId) })
    if (res.overridePublicColor) {
      const letter = (res.letterFromBuyer || res.letter || res.last)
      if (letter) {
        const lower = (letter || '').toLowerCase()
        if (lower) assignIfMissing(`__override__${lower}`, sourceId)
      }
    }
  })

  // Compute which private reveal letters the current viewer is allowed to see.
  // By default only include letters that were explicitly targeted at the viewer,
  // originated from the viewer, or were marked teamOnly and the viewer is on the same team.
  const allowedPrivateLetters = new Set()
  const allowedOverrideSource = {}
  const combinedRevealsForVisibility = [].concat(targetedReveals || [], byPlayerReveals || [])
  const revealVisibleToViewer = (r) => {
    if (!r) return false
    const res = r.result || {}
    try {
        if (viewerId && r.to === viewerId) return true
        if (viewerId && r.from === viewerId) return true
        if (res && res.teamOnly && gameMode === 'lastTeamStanding' && viewerTeam && player.team && viewerTeam === player.team) return true
    } catch (e) {}
    return false
  }
  combinedRevealsForVisibility.forEach(r => {
    if (!r || !r.result) return
    if (!revealVisibleToViewer(r)) return
    const res = r.result
    const push = (s) => { if (!s) return; const lower = (s||'').toString().toLowerCase(); if (lower) allowedPrivateLetters.add(lower) }
    push(res.letterFromTarget)
    push(res.letterFromBuyer)
    push(res.letter)
    push(res.last)
    if (res.letters && Array.isArray(res.letters)) res.letters.forEach(ch => { if (ch) allowedPrivateLetters.add((ch||'').toLowerCase()) })
    if (res.overridePublicColor) {
      const letter = (res.letterFromTarget || res.letter || res.last)
      if (letter) {
        const lower = (letter || '').toLowerCase()
        allowedOverrideSource[lower] = r.from
      }
    }
  })
  // Also include privateHits (viewer-level) letters
  try {
    const ph2 = (viewerPrivate.privateHits && viewerPrivate.privateHits[player.id]) || []
    Array.isArray(ph2) && ph2.forEach(h => { if (h && h.letter) allowedPrivateLetters.add((h.letter||'').toString().toLowerCase()) })
  } catch (e) {}

  const ownerWord = player.word || ''
  const revealedSet = new Set(revealed || [])

  // If every letter in the owner's word is revealed (e.g., correct full-word guess),
  // always render letters in their original order regardless of revealPreserveOrder.
  const allLettersRevealed = (ownerWord || '').split('').every(ch => revealedSet.has((ch || '').toLowerCase()))

  const fullWordRendered = ownerWord.split('').map((ch, idx) => {
    const lower = ch.toLowerCase()
    // if this letter is publicly revealed but a private reveal asked to override public color,
    // render it in the revealer's color instead of the public red only when allowed
    const overrideSource = allowedOverrideSource[lower] || privateLetterSource[`__override__${lower}`]
    const playerColors = player._viewer && player._viewer.playerColors ? player._viewer.playerColors : {}
    if (revealedSet.has(lower)) {
      if (overrideSource && playerColors && playerColors[overrideSource]) return <span key={idx} style={{ color: playerColors[overrideSource], fontWeight: 700 }}>{ch}</span>
      return <span key={idx} style={{ color: 'red', fontWeight: 700 }}>{ch}</span>
    }
    const sourceId = privateLetterSource[lower]
    // only show privately-revealed letters when viewer is allowed to see them
    if (sourceId && allowedPrivateLetters.has(lower)) {
      const color = (playerColors && playerColors[sourceId]) ? playerColors[sourceId] : revealedLetterColor
      return <span key={idx} style={{ color, fontWeight: 700 }}>{ch}</span>
    }
    return <span key={idx} style={{ color: '#9aa47f' }}>{ch}</span>
  })

  const showMasked = !!(player && player._viewer && player._viewer.showMasked)
  const maskedRendered = showMasked ? ownerWord.split('').map((ch, idx) => {
    const lower = ch.toLowerCase()
    if (revealedSet.has(lower)) return <span key={idx} style={{ color: '#000', fontWeight: 700, marginRight: 4 }}>{ch}</span>
    return <span key={idx} style={{ color: '#9aa47f', marginRight: 4 }}>_</span>
  }) : null

  // Build revealedPositions according to revealPreserveOrder / revealShowBlanks settings.
  let revealedPositions = null
  // Determine whether the viewer is a teammate (used to show the "Show teammate's word" control)
  const isViewerTeammate = (gameMode === 'lastTeamStanding' && viewerTeam && player.team && viewerTeam === player.team)
  if (allLettersRevealed) {
    // Use full ordered rendering so the revealed div shows letters in word order
    revealedPositions = fullWordRendered
  } else
  
  if (!isSelf && !revealPreserveOrder) {
    // Show letters in guessed order (derived from private reveals and privateHits),
    // expanding by occurrence count in the owner's word.
  const arr = []
  const collectedElems = []
    // Process private power reveals relevant to this player. We include both
    // reveals that targeted this player and reveals that originated from this
    // player (so the buyer can see letters they caused to be revealed from
    // their own word). Only push letters that actually exist in the owner's word
    // to avoid mixing letters across tiles.
    const ownerLower = (ownerWord || '').toLowerCase()
    // Collect reveal events (with timestamp and optional count and sourceId)
  // Combine targeted reveals (for this player) with reveals that originated
  // from the viewer but also target this player. Both lists are scoped so they
  // only contain records relevant to this player's tile.
  const combinedReveals = [].concat(targetedReveals || [], byPlayerReveals || [])
    combinedReveals.forEach(r => {
      const ts = Number(r.ts || (r.result && r.result.ts) || Date.now()) || Date.now()
      const res = r.result || {}
      const src = r.from
      // pushIfOwnerHas optionally accepts explicitSource to override src for
      // special cases (e.g. letterFromBuyer on the buyer's own view should be
      // colored as the tile owner). explicitSource === null/undefined uses src.
      const pushIfOwnerHas = (s, count, explicitSource) => {
        if (!s) return
        const lower = (s||'').toString().toLowerCase()
        if (ownerLower && ownerLower.indexOf(lower) !== -1) collectedElems.push({ letter: lower, ts, count: Number(count||1), sourceId: (typeof explicitSource !== 'undefined' ? explicitSource : src) })
      }
      pushIfOwnerHas(res.letterFromTarget, res.count || res.occurrences || res.hits)
      // If this reveal is a side-effect (letterFromBuyer) and the viewer is the buyer
      // (viewerId === src), prefer coloring it with the tile owner's color (player.id)
      // so the buyer sees the target's color on their own screen.
      const buyerSideEffectSource = (viewerId && src && viewerId === src) ? player.id : undefined
      pushIfOwnerHas(res.letterFromBuyer, res.count || res.occurrences || res.hits, buyerSideEffectSource)
      pushIfOwnerHas(res.letter, res.count || res.occurrences || res.hits)
      pushIfOwnerHas(res.last, res.count || res.occurrences || res.hits)
      if (res.letters && Array.isArray(res.letters)) res.letters.forEach(ch => pushIfOwnerHas(ch, 1))
    })
    // include privateHits entries (viewer-private hits on this player)
    let ph = (viewerPrivate.privateHits && viewerPrivate.privateHits[player.id]) || []
    ph = Array.isArray(ph) ? ph : []
    ph.forEach(h => { if (h && h.letter) collectedElems.push({ letter: (h.letter||'').toString().toLowerCase(), ts: Number(h.ts || Date.now()) || Date.now(), count: Number(h.count||1), sourceId: h.by || undefined }) })

    // ensure collectedElems is an array before operating on it
    // sort by ts
    collectedElems.sort((a,b) => (Number(a.ts)||0) - (Number(b.ts)||0))
    const wordLower = (ownerWord || '').toLowerCase()
    try {
      // Force a real array copy (break proxy links)
      const safeCollected = Array.from(collectedElems)
      // track how many of each letter we've already added so we don't exceed
      // the actual occurrences in the owner's word
      const addedCounts = {}
      safeCollected.forEach(c => {
        const letter = (c.letter || '').toLowerCase()
        if (!letter) return
        const occurrencesInWord = (wordLower.split('').filter(ch => ch === letter).length) || 1
        const already = Number(addedCounts[letter] || 0)
        const want = Number(c.count || 1)
        const canAdd = Math.max(0, Math.min(want, occurrencesInWord - already))
        for (let i = 0; i < canAdd; i++) arr.push({ letter, sourceId: c.sourceId })
        if (canAdd > 0) addedCounts[letter] = already + canAdd
      })
    } catch (err) {
      console.error("🔥 collectedElems broke here:", collectedElems, err)
    }
    // append any publicly revealed letters not already present (cap to occurrences)
    // First compute presentCounts from a defensive copy of `arr` (so we know how many
    // letters are already present). Then append missing public reveals to `arr`.
    const presentCounts = {}
    let snapshot = []
    try {
      snapshot = Array.isArray(arr) ? arr.slice() : (arr && typeof arr[Symbol.iterator] === 'function' ? Array.from(arr) : (arr ? [arr] : []))
    } catch (e) {
      snapshot = Array.isArray(arr) ? arr.slice() : (arr ? [arr] : [])
    }
    snapshot.forEach(x => { const L = x.letter || x; presentCounts[L] = (presentCounts[L] || 0) + 1 })

    ;(revealed || []).forEach(l => {
      const lower = (l||'').toLowerCase()
      const countInWord = (ownerWord || '').split('').filter(ch => ch.toLowerCase() === lower).length || 1
      const present = Number(presentCounts[lower] || 0)
      const need = Math.max(0, countInWord - present)
      // For public reveals we must not accidentally use buyer/other private source mappings.
      // Only apply a sourceId when there's an explicit override mapping for this letter.
      const overrideKey = `__override__${lower}`
      const overrideSrc = privateLetterSource[overrideKey]
      for (let i = 0; i < need; i++) {
        if (overrideSrc) arr.push({ letter: lower, sourceId: overrideSrc })
        else arr.push({ letter: lower })
      }
      if (need > 0) presentCounts[lower] = present + need
    })
    // render letters with any private color if available. Each arr item may be
    // an object { letter, sourceId } (from reveals) or a string for older flows.
    const playerColors = player._viewer && player._viewer.playerColors ? player._viewer.playerColors : {}
    // Make a final defensive plain-array copy for rendering
    let safeArrFinal = []
    try {
      safeArrFinal = Array.isArray(arr) ? arr.slice() : (arr && typeof arr[Symbol.iterator] === 'function' ? Array.from(arr) : (arr ? [arr] : []))
    } catch (e) {
      safeArrFinal = Array.isArray(arr) ? arr.slice() : (arr ? [arr] : [])
    }
    // Debugging aid: enable by setting window.__GH_DEBUG_REVEALS = true in the browser console.
    try {
      if (typeof window !== 'undefined' && window.__GH_DEBUG_REVEALS) {
        console.debug('gh:PlayerCircle reveals debug', {
          playerId: player.id,
          viewerId,
          targetedReveals: targetedReveals && targetedReveals.length ? targetedReveals.map(r => ({ from: r.from, to: r.to, powerId: r.powerId, result: r.result })) : targetedReveals,
          byPlayerReveals: byPlayerReveals && byPlayerReveals.length ? byPlayerReveals.map(r => ({ from: r.from, to: r.to, powerId: r.powerId, result: r.result })) : byPlayerReveals,
          collectedElems,
          snapshot,
          safeArrFinal,
          privateLetterSource,
          revealedSet: Array.from(revealedSet || [])
        })
      }
    } catch (e) {}
    revealedPositions = safeArrFinal.map((item, idx) => {
      const letter = (typeof item === 'string') ? item : (item.letter || '')
      const lower = (letter || '').toString().toLowerCase()
      const instanceSource = (typeof item === 'string') ? undefined : item.sourceId
      const overrideSource = privateLetterSource[`__override__${lower}`]
      // Publicly revealed letters should render red unless an override source exists
      if (revealedSet.has(lower)) {
        const allowedOverride = allowedOverrideSource[lower] || overrideSource
        if (allowedOverride && playerColors && playerColors[allowedOverride]) return <span key={`g_${idx}`} style={{ marginRight: 6, color: playerColors[allowedOverride] }}>{letter}</span>
        return <span key={`g_${idx}`} style={{ marginRight: 6, color: 'red', fontWeight: 700 }}>{letter}</span>
      }
      const sourceId = instanceSource || privateLetterSource[lower]
      // Only render private-letter coloring when the viewer is allowed to see that letter
      if (sourceId && allowedPrivateLetters.has(lower)) {
        const color = (playerColors && playerColors[sourceId]) ? playerColors[sourceId] : revealedLetterColor
        return <span key={`g_${idx}`} style={{ marginRight: 6, color }}>{letter}</span>
      }
      return <span key={`g_${idx}`} style={{ marginRight: 6 }}>{letter}</span>
    })
  } else {
    // preserve order: show letters in their positions. If revealShowBlanks is true, show '_' for unrevealed letters.
    revealedPositions = (ownerWord || '').split('').map((ch, idx) => {
      const lower = (ch || '').toLowerCase()
      const playerColors = player._viewer && player._viewer.playerColors ? player._viewer.playerColors : {}
      // If this letter is publicly revealed, apply an allowed override color when present
      if (revealedSet.has(lower)) {
        const allowedOverride = allowedOverrideSource[lower] || privateLetterSource[`__override__${lower}`]
        if (allowedOverride && playerColors && playerColors[allowedOverride]) return <span key={`r_${idx}`} style={{ marginRight: 4, color: playerColors[allowedOverride] }}>{ch}</span>
        return <span key={`r_${idx}`} style={{ marginRight: 4 }}>{ch}</span>
      }
      const sourceId = privateLetterSource[lower]
      // Only render private-letter coloring when the viewer is allowed to see that letter
      if ((isSelf) || (sourceId && allowedPrivateLetters.has(lower))) {
        const color = (playerColors && playerColors[sourceId]) ? playerColors[sourceId] : (isSelf ? '#000' : revealedLetterColor)
        return <span key={`r_${idx}`} style={{ marginRight: 4, color }}>{ch}</span>
      }
      if (revealShowBlanks) return <span key={`r_${idx}`} style={{ color: '#999', marginRight: 4 }}>_</span>
      return null
    }).filter(Boolean)
  }
  const avatarColor = player.color || '#ca29ffff'
  function hexToRgba(hex, alpha = 0.28) {
    const h = hex.replace('#', '')
    const bigint = parseInt(h.length === 3 ? h.split('').map(c => c+c).join('') : h, 16)
    const r = (bigint >> 16) & 255
    const g = (bigint >> 8) & 255
    const b = bigint & 255
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const haloRgba = hexToRgba(avatarColor, 0.28)

  useEffect(() => {
    if (timeLeftMs == null) { setSoundedLow(false); return }
    const s = Math.ceil(timeLeftMs / 1000)
    if (s <= 0) { try { navigator.vibrate && navigator.vibrate(200) } catch (e) {} ; setSoundedLow(false); return }
    if (s <= 5 && !soundedLow) {
      try { navigator.vibrate && navigator.vibrate([60,30,60]) } catch (e) {}
      setSoundedLow(true)
    }
  }, [timeLeftMs])

  // compute portal position for ghost re-enter button so it can be rendered
  // outside the .player element (avoids parent's filter affecting it)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const compute = () => {
      try {
        const el = rootRef.current
        if (!el) { setGhostPortalPos(null); return }
        const r = el.getBoundingClientRect()
        setGhostPortalPos({ top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height })
      } catch (e) { setGhostPortalPos(null) }
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => { window.removeEventListener('resize', compute); window.removeEventListener('scroll', compute, true) }
  }, [showGhostReenter])

  useEffect(() => {
    if (flashPenalty) { setAnimateHang(true); const id = setTimeout(() => setAnimateHang(false), 1000); return () => clearTimeout(id) }
  }, [flashPenalty])


  const isTurn = currentTurnId && currentTurnId === player.id


  // Determine elimination UI state
  const isEliminated = !!player.eliminated
  // When in lastTeamStanding, viewers on the same team should not see Guess/Power-up buttons
  const viewerSameTeam = (!isSelf && gameMode === 'lastTeamStanding' && teamName && viewerTeam && teamName === viewerTeam)
  // Determine who guessed this player out (prefer guessedBy.__word array last actor)
  let eliminatedByName = null
  try {
    const gb = player.guessedBy && player.guessedBy['__word'] ? player.guessedBy['__word'] : null
    if (Array.isArray(gb) && gb.length > 0) eliminatedByName = (playerIdToName && playerIdToName[gb[gb.length-1]]) || gb[gb.length-1]
  } catch (e) { eliminatedByName = null }

  // Filter out unhelpful/empty double_down entries so the UI doesn't show a bare "double_down:" line
  const visiblePrivatePowerReveals = (privatePowerRevealsList || []).filter(r => {
    if (!r) return false
    const res = r.result
    if (!res) return false
    // If the reveal is marked teamOnly, only show it to the target and their teammates
    if (res.teamOnly && gameMode === 'lastTeamStanding') {
      // viewerTeam and teamName are available in props; only allow when viewer is the target or on same team
      if (!(viewerId === player.id || (viewerTeam && teamName && viewerTeam === teamName))) return false
    }
    // For double_down entries, only show when there is a meaningful payload
    if (r.powerId === 'double_down') {
      // meaningful if it contains a message, letter info, an amount, or an explicit override
      if (res.message) return true
      if (res.letter || res.letterFromTarget || res.letterFromBuyer) return true
      if (typeof res.amount !== 'undefined' && res.amount !== null) return true
      if (res.overridePublicColor) return true
      return false
    }
    return true
  })

  // De-duplicate visually-similar power-up reveal entries so the target's
  // tile doesn't show essentially the same message twice (e.g., letter_for_letter
  // side-effect + a generic fallback entry). Keep first occurrence and preserve order.
  const _deduped = []
  try {
    const seen = new Set()
    ;(visiblePrivatePowerReveals || []).forEach(r => {
      try {
        if (!r || !r.result) return
        const pid = r.powerId || ''
        const from = r.from || r.by || ''
        const res = r.result || {}
        // Use HTML message when available for stability, else fallback to plain message
        const msg = String(res.messageHtml || res.message || '')
        // include prominent letter fields so letter_for_letter variants collapse
        const letterKey = String((res.letterFromBuyer || res.letterFromTarget || res.letter || (Array.isArray(res.letters) ? res.letters.join(',') : '')) || '')
        const teamOnlyFlag = res.teamOnly ? 'T' : 'F'
        const sig = `${pid}::${from}::${letterKey}::${msg}::${teamOnlyFlag}`
        if (!seen.has(sig)) {
          seen.add(sig)
          _deduped.push(r)
        }
      } catch (e) { _deduped.push(r) }
    })
  } catch (e) { /* fallback: leave as-is */ }
  const visiblePrivatePowerRevealsDeduped = _deduped

  return (
  <div ref={rootRef} data-player-id={player.id} className={`player ${isSelf ? 'player-self' : ''} ${player && player.stale ? 'player-stale' : ''} ${isTurn ? 'player-turn' : ''} ${!hasSubmitted && phase === 'submit' ? 'waiting-pulse' : ''} ${flashPenalty ? 'flash-penalty' : ''} ${player && (player.frozen || (typeof player.frozenUntilTurnIndex !== 'undefined' && player.frozenUntilTurnIndex !== null)) ? 'player-frozen' : ''} ${isEliminated ? 'player-eliminated' : ''}`} style={{ ['--halo']: haloRgba, position: 'relative', transform: 'none' }}>
      {/* Host remove control (red X) shown to host for non-self players in all phases.
          Automated stale/kick behavior is disabled; hosts should remove absent players manually. */}
      {isHost && onRemove && !isSelf && (
        <button title={`Remove ${player.name}`} onClick={(e) => { e.stopPropagation(); if (!confirm(`Remove player ${player.name} from the room?`)) return; try { onRemove(player.id) } catch (err) { console.error('onRemove failed', err) } }} style={{ position: 'absolute', left: 6, top: 6, border: 'none', background: '#4c1717bf', color: '#ff4d4f', fontWeight: 800, cursor: 'pointer', fontSize: 16, padding: '4px 6px', zIndex: 40 }}>×</button>
      )}
      <div style={{ alignItems: 'center', gap: 12, justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 72, gap: '1vw'}}>
          {/* Ex-ghost badge: visible when a player has re-entered after winning ghost challenge */}
            {(player && player.ghostState && player.ghostState.reentered) && (
              <div className="ex-ghost-badge" title={"Back from the dead because the afterlife wasn't fun"}>👻 Ex-ghost</div>
            )}
          
          <div style={{ fontSize: 12, marginTop: 6, textAlign: 'center', flexDirection: 'column', display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'relative' }}>
            <div className="avatar" style={{ background: avatarColor }}>{player.name ? player.name[0] : '?'}</div>
            {/* Presence indicator removed per UI preference: no offline badge shown */}
            {/* Frozen badge: visible when player is frozen (others see it) */}
            {(player && (player.frozen || (typeof player.frozenUntilTurnIndex !== 'undefined' && player.frozenUntilTurnIndex !== null))) && (
              <div className="frozen-badge" title="Player is frozen : guesses disabled">❄️ Frozen</div>
            )}


            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}>
              <div>{player.name}</div>
             </div>
            {teamName && (
              <div style={{ fontSize: 11, padding: '2px 6px', borderRadius: 8, background: teamName === 'red' ? '#ff5c5c' : '#5c9bff', color: '#fff', fontWeight: 800 }}>{teamName.toUpperCase()}</div>
            )}
          </div>
          {/* wordmoney: hide per-player wallet in lastTeamStanding when player is assigned to a team; team wallet is shown in the column header */}
          {!(gameMode === 'lastTeamStanding' && teamName) && (
            <div className={`wordmoney ${animateHang ? 'decrement' : ''} ${pulse ? 'pulse' : ''}`} style={{ marginTop: 6 }}>
              <span style={{ background: '#f3f3f3', color: isWinner ? '#b8860b' : '#222', padding: '4px 8px', borderRadius: 12, display: 'inline-block', minWidth: 44, textAlign: 'center', fontWeight: 700 }}>
                {`$${(Number(player.wordmoney) || 0) + (Number(pendingDeduct) || 0)}`}
              </span>
            </div>
          )}
          {isSelf && <div className="you-badge" style={{ marginTop: 6, padding: '2px 6px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>YOU</div>}
          {/* Double Down active badge: shows when this player has a pending doubleDown */}
          {player && player.doubleDown && player.doubleDown.active && (
            <div className="double-down-badge" title="Double Down active" style={{ marginTop: 6, padding: '2px 6px', borderRadius: 8, background: '#ffcc00', color: '#2b2b2b', fontSize: 11, fontWeight: 800 }}>DD</div>
          )}
          {/* Word Seeker voted indicator: shows when this player has cast a vote in Word Seeker */}
          {player && player.wordSeekerVote && (
            <div className="voted-badge" title="Voted in Word Seeker" style={{ marginTop: 6, padding: '2px 6px', borderRadius: 8, background: '#4CAF50', color: '#fff', fontSize: 11, fontWeight: 700 }}>✓ Voted</div>
          )}
           
        </div>
        <div>
        {/* Ready indicator visible to everyone. Show host as ready on other players' screens in the lobby */}
          {typeof ready !== 'undefined' && !isSelf && phase === 'lobby' && (() => {
            const displayedReady = (player && player.id && hostId && player.id === hostId) ? true : !!ready
            return (
              <div style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: displayedReady ? '#27ae60' : '#f96e87ff', color: displayedReady ? '#fff' : '#333', fontWeight: 700 }} title={displayedReady ? 'Ready' : 'Not ready'}>
                {displayedReady ? 'Ready' : 'Not Ready'}
              </div>
            )
          })()}
        </div>

        <div >
                          {/* Ready toggle for local (non-host) players while in lobby */}
                {phase === 'lobby' && isSelf && !isHost && typeof onToggleReady === 'function' && (
                  <button
                    onClick={() => { try { onToggleReady(player.id, !ready) } catch (e) { console.warn('toggle ready failed', e) } }}
                    aria-pressed={!!ready}
                    title={ready ? 'Click to unset Ready' : 'Click to set Ready'}
                    style={{
                      fontSize: 13,
                      padding: '6px 12px',
                      borderRadius: 999,
                      marginTop: 6,
                      border: 'none',
                      cursor: 'pointer',
                      background: ready ? 'linear-gradient(90deg,#27ae60,#16a34a)' : 'linear-gradient(90deg,#ff7a7a,#ff3b3b)',
                      color: '#fff',
                      boxShadow: ready ? '0 6px 18px rgba(39,174,96,0.28), 0 0 12px rgba(39,174,96,0.32)' : '0 6px 18px rgba(255,92,92,0.32), 0 0 18px rgba(255,92,92,0.48)',
                      fontWeight: 800,
                      transition: 'box-shadow 220ms ease, transform 220ms ease'
                    }}
                    onMouseEnter={e => { if (!ready) e.currentTarget.style.transform = 'translateY(-2px)'; }}
                    onMouseLeave={e => { if (!ready) e.currentTarget.style.transform = 'translateY(0)'; }}
                  >
                    {ready ? 'Ready' : 'Click to set Ready'}
                  </button>
                )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="revealed" title={isSelf && ownerWord ? `Your word: ${ownerWord}` : `Revealed letters for ${player.name}`} style={{ marginBottom: 8, position: 'relative', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'center', fontSize: 13, lineHeight: '1.1', maxWidth: '100%', overflow: 'visible' }}>
              {isSelf ? (
                showOwnWord ? (
                  // If in Word Seeker and the viewer is the spy, don't reveal the word : show a neutral message
                  (gameMode === 'wordSeeker' && viewerIsSpy) ? (
                    <span style={{ fontStyle: 'italic', color: '#cfcfcf' }}>you are the spy</span>
                  ) : (
                    // show the submitted word with private reveals colored by revealer and public reveals in red
                    fullWordRendered
                  )
                ) : (
                  // when hidden show masked underscores
                  ownerWord.split('').map((ch, idx) => <span key={`mask_${idx}`} style={{ color: '#999', marginRight: 6 }}>_</span>)
                )
              ) : (showTeammateWord ? fullWordRendered : revealedPositions)}

            </div>


            <div className="actions" style={{ marginBottom: 8, overflow: 'visible' }}>
                {isSelf ? (
                // Hide the "Show my word" button during Word Seeker mode
                (gameMode === 'wordSeeker') ? (
                  <div style={{ fontSize: 13, color: '#999', fontStyle: 'italic' }}>{viewerIsSpy ? 'You are the spy' : ''}</div>
                ) : (
                  // For normal modes, allow toggling own word — but hide this control in lobby/submit (waiting) phases
                  (phase !== 'lobby' && phase !== 'submit') ? (
                    <button className="action-button" title={ownerWord || 'No word submitted'} onClick={() => setShowOwnWord(s => !s)}>{showOwnWord ? 'Hide word' : 'Show my word'}</button>
                  ) : null
                )
              ) : (() => {
                // When viewer has an active Double Down on someone else, visually lock other players' Guess buttons
                const ddLocked = !!(ddActive && ddTarget && ddTarget !== player.id && !isSelf)
                const targetName = (playerIdToName && playerIdToName[ddTarget]) || ddTarget || 'the selected player'
                // Consider frozen state: when a player is frozen by a power-up, others should not be able to guess them
                const isFrozen = !!(player && (player.frozen || (typeof player.frozenUntilTurnIndex !== 'undefined' && player.frozenUntilTurnIndex !== null)))
                const titleText = isEliminated ? 'Player eliminated' : (isFrozen ? 'Player is frozen : guesses disabled' : (ddLocked ? `Double Down active : only ${targetName} may be guessed` : 'Guess this word'))
                const className = `action-button core ${ddLocked ? 'dd-locked' : ''} ${isFrozen && !isSelf ? 'frozen-locked' : ''}`
                // compute disabled reason for easier debugging
                const guessDisabled = (!canGuess || isEliminated || ddLocked || (isFrozen && !isSelf))
                const disabledReasons = []
                if (!canGuess) disabledReasons.push('not your turn')
                if (isEliminated) disabledReasons.push('player eliminated')
                if (ddLocked) disabledReasons.push('double-down lock')
                if (isFrozen && !isSelf) disabledReasons.push('player frozen')
                try { if (typeof window !== 'undefined' && window.__GH_DEBUG_GUESS) console.debug('PlayerCircle: render guess control', { playerId: player.id, guessDisabled, disabledReasons, canGuess, isEliminated, ddLocked, isFrozen, isSelf, phase, currentTurnId, timeLeftMs }) } catch (e) {}
                return (
                  <>
                    {!hideInteractiveForWordSeeker && !viewerSameTeam && phase !== 'lobby' && (
                      <button
                        className={className}
                        title={titleText}
                        disabled={guessDisabled}
                        data-guess-disabled={guessDisabled}
                        onClick={() => {
                          if (!guessDisabled) {
                            // set a short ignore window so the dialog doesn't auto-close
                            try { ignoreCloseUntilRef.current = Date.now() + 350 } catch (e) {}
                            setShowGuessDialog(true);
                            setGuessValue('')
                          }
                        }}
                      >{'Guess'}</button>
                    )}
                    
                  </>
                )
              })()}

              {/* Skip turn button: visible to the current player (self) when it's their turn (hidden in lobby) */}
              {isSelf && isTurn && !hideInteractiveForWordSeeker && phase !== 'lobby' && (
                <button className="action-button" title="End your turn" onClick={() => { try { if (typeof onSkip === 'function') onSkip() } catch (e) {} }} style={{ marginLeft: 8 }}>Skip turn</button>
              )}

              {!isSelf && !viewerSameTeam && onOpenPowerUps && !player.eliminated && !hideInteractiveForWordSeeker && (phase !== 'lobby' && phase !== 'submit') && (
                <button className="action-button curse" title={powerUpDisabledReason || 'Use power-up'} onClick={(e) => { e.stopPropagation(); if (powerUpDisabledReason) return; if (isEliminated) return; onOpenPowerUps(player.id) }} disabled={!!powerUpDisabledReason || isEliminated}>{'🕯️Curse'}</button>
              )}
              {/* show who eliminated this player when applicable */}
              {isEliminated && eliminatedByName && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#6b6b6b' }} aria-hidden>{`Out by: ${eliminatedByName}`}</div>
              )}
              {isEliminated && !eliminatedByName && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#6b6b6b' }} aria-hidden>{`Out`}</div>
              )}
            </div>
          </div>



          <div style={{ marginTop: 8 }}>
            {!hideInteractiveForWordSeeker && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                {/* Show teammate's word button: only when in lastTeamStanding and viewer is on same team */}
                  {(!isSelf && gameMode === 'lastTeamStanding' && teamName && viewerTeam && teamName === viewerTeam && phase !== 'lobby') && (
                  <button
                    onClick={async () => {
                      // If parent provided handler, use it to persist reveal to DB; otherwise fall back to local toggle
                      try {
                        const newVal = !(teamRevealForPlayer || showTeammateWord)
                        if (typeof onToggleTeamReveal === 'function') {
                          await onToggleTeamReveal(player.id, teamName, newVal)
                          // rely on parent state update (via DB subscription) to set new value; still update local UI optimistically
                          try { setShowTeammateWord(newVal) } catch (e) {}
                        } else {
                          setShowTeammateWord(s => !s)
                        }
                      } catch (e) {
                        console.warn('toggle team reveal failed', e)
                        // fallback local toggle
                        setShowTeammateWord(s => !s)
                      }
                    }}
                    className="action-button utility"
                    disabled={!(player && player.hasWord)}
                    title={player && player.hasWord ? `Show ${player.name}'s word to your team` : `${player.name} has not submitted a word`}
                    style={{ fontSize: 13, padding: '6px 8px', borderRadius: 8, background: (teamRevealForPlayer || showTeammateWord) ? '#222' : undefined, color: (teamRevealForPlayer || showTeammateWord) ? '#fff' : undefined }}
                  >
                    {(teamRevealForPlayer || showTeammateWord) ? `Hide ${player && player.name ? player.name : 'player'}'s word` : `Show ${player && player.name ? player.name : 'player'}'s word`}
                  </button>
                )}
                {(phase !== 'lobby' && phase !== 'submit') ? (
                  <>
                    {showGhostReenter && typeof onGhostReenter === 'function' && (
                      // Render the ghost re-enter button via portal so it is outside the
                      // .player element (which may have a filter applied). If portal
                      // position is not yet known, fall back to inline rendering.
                      (typeof document !== 'undefined' && ghostPortalPos) ? createPortal(
                        <div className="ghost-reenter-portal" style={{ position: 'absolute', top: ghostPortalPos.top + 8, left: ghostPortalPos.left + (ghostPortalPos.width / 2) - 56, width: 112, display: 'flex', justifyContent: 'center', pointerEvents: 'auto', zIndex: 1200 }}>
                          <button
                            className="action-button ghost-reenter"
                            onClick={(e) => { e.stopPropagation(); if (ghostReenterDisabled) return; try { onGhostReenter() } catch (er) { console.warn('onGhostReenter failed', er) } }}
                            disabled={!!ghostReenterDisabled}
                            style={{ fontSize: 13, padding: '6px 8px', borderRadius: 8 }}
                          >
                            Re-enter as Ghost
                          </button>
                        </div>
                      , document.body) : (
                        <button
                          className="action-button ghost-reenter"
                          onClick={(e) => { e.stopPropagation(); if (ghostReenterDisabled) return; try { onGhostReenter() } catch (er) { console.warn('onGhostReenter failed', er) } }}
                          disabled={!!ghostReenterDisabled}
                          style={{ fontSize: 13, padding: '6px 8px', borderRadius: 8 }}
                        >
                          Re-enter as Ghost
                        </button>
                      )
                    )}
                    <button onClick={() => setExpanded(x => !x)} style={{ fontSize: 13, padding: '6px 8px', borderRadius: 8 }}>
                      {expanded ? 'Hide info' : `View info for ${(player && player.name) ? player.name : 'player'}'s word`}
                    </button>
                  </>
                ) : null}

                
              </div>
            )}
          </div>
        </div>
      </div>

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

      {/* guess-closed toast removed: dialog will simply close when time expires or turn changes */}

      {expanded && (
        <div style={{ marginTop: 10 }}>
          {privateWrong.length > 0 && (
            <div style={{ marginTop: 8, background: '#f9b9b9ff', padding: 6, borderRadius: 4, color: '#900' }}>
              <strong>Your wrong letters:</strong> {privateWrong.join(', ')}
            </div>
          )}

          {(player._viewer && player._viewer.privateWrongWords && player._viewer.privateWrongWords[player.id] && player._viewer.privateWrongWords[player.id].length > 0) && (
            <div style={{ marginTop: 8, background: '#5f1515', padding: 6, borderRadius: 4 }}>
              <strong>Your wrong words:</strong>
              <div style={{ marginTop: 6 }}>{(player._viewer.privateWrongWords[player.id] || []).join(', ')}</div>
            </div>
          )}

              {visiblePrivatePowerReveals.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {!hideInteractiveForWordSeeker && (
                    // Put only the header text in a scrollable container
                    <div className="powerup-results-title" style={{ maxHeight: 48, overflow: 'auto' }}>
                      <strong>Curse results:</strong>
                    </div>
                  )}
                  <div className="powerup-results-scroll" style={{ marginTop: 6, overflowY: 'scroll', maxHeight: '50vh', paddingRight: '20px' }}>
                {visiblePrivatePowerRevealsDeduped.map((r, idx) => {
                  const res = r && r.result
                  const actorId = r && (r.from || r.by)
                  const actorName = (actorId && (playerIdToName && playerIdToName[actorId])) || actorId || 'Someone'
                  const actorIsViewer = viewerId && actorId && viewerId === actorId
                  // determine style from updateType (fallback to not-important)
                  const updateType = (r && (r.updateType || r.updateType === '') ) ? r.updateType : null
                  // derive importance from explicit updateType or from known power metadata
                  const isImportant = (r && r.updateType === 'important') || (r && r.powerId && IMPORTANT_POWERS.has(r.powerId))
                  
                    // Use a darker, related palette and apply the gradient to the important chip
                    const chipStyle = isImportant
                      ? {
                          // darker-to-light purple gradient but light enough for black text to remain readable
                          background: 'linear-gradient(135deg, #1f0a43ff 0%, #3d236dff 100%)',
                          color: '#fbebebff',
                          padding: '8px 10px',
                          borderRadius: 8,
                          marginTop: 6,
                          fontSize: 13,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                          border: '2px solid #3b75c9'
                        }
                      : {
                          // lighter purple gradient for non-important chips to ensure strong contrast with black text
                          background: 'linear-gradient(135deg, #07202cff 0%, #171b5bff 100%)',
                          color: '#fbebebff',
                          padding: '8px 10px',
                          borderRadius: 8,
                          marginTop: 6,
                          fontSize: 13,
                          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)',
                          border: '2px solid #3b75c9'
                        }
                    
                  return (
                    <div key={idx}>
                      {(r.powerId === 'letter_scope' && res && (typeof res.letters === 'number' || typeof res.letters === 'string')) ? (
                        <div style={chipStyle}><strong style={{ color: powerNameColor }}>Letter Scope</strong>: there are <strong style={{ color: revealedLetterColor }}>{Number(res.letters)}</strong> letter{Number(res.letters) === 1 ? '' : 's'} in the word</div>
                      ) : res && res.message ? (
                        (r.powerId === 'vowel_vision' && actorIsViewer && typeof res.vowels === 'number') ? (
                          <div style={chipStyle}><strong style={{ color: powerNameColor }}>Vowel Vision</strong>: There are <strong style={{ color: revealedLetterColor }}>{res.vowels}</strong> vowel{res.vowels === 1 ? '' : 's'}</div>
                        ) : (
                          <div style={chipStyle}>
                            {res && res.messageHtml ? (
                              <div dangerouslySetInnerHTML={{ __html: String(res.messageHtml) }} />
                            ) : (
                              <div>{res.message}</div>
                            )}
                          </div>
                        )
                      ) : r.powerId === 'letter_for_letter' ? (
                        (() => {
                          return <div></div>
                        })()
                      ) : (
                        (() => {
                          
                          try {
                            if (actorIsViewer) {
                              if (r.powerId === 'letter_scope' && (typeof res.letters === 'number' || typeof res.letters === 'string')) {
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Letter Scope</strong>:  <strong style={{ color: revealedLetterColor }}>{Number(res.letters)}</strong> letter{Number(res.letters) === 1 ? ' is' : 's are'} in the word</div>
                              }
                              if (r.powerId === 'vowel_vision' && typeof res.vowels === 'number') {
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Vowel Vision</strong>: There are <strong style={{ color: revealedLetterColor }}>{res.vowels}</strong> vowel{res.vowels === 1 ? '' : 's'}</div>
                              }
                              if (r.powerId === 'zeta_drop') {
                                const last = res && res.last ? res.last : null
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Zeta Drop</strong>: last letter is {last ? <strong style={{ color: revealedLetterColor }}>'{last}'</strong> : 'unknown'}</div>
                              }
                              if (r.powerId === 'one_random' && res.letter) {
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>One Random Letter</strong>: revealed <strong style={{ color: revealedLetterColor }}>'{String(res.letter).slice(0,1)}'</strong></div>
                              }
                              if (r.powerId === 'letter_peek') {
                                if (res && res.message) return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Letter Peek</strong>: {res.message}</div>
                                if (res && res.letter && typeof res.pos !== 'undefined') return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Letter Peek</strong>: <strong style={{ color: revealedLetterColor }}>'{res.letter}'</strong> at position {res.pos}</div>
                              }
                              if (r.powerId === 'related_word' && res && res.message) return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Related Word</strong>: {res.message}</div>
                              if (r.powerId === 'dice_of_doom' && res && typeof res.roll === 'number') {
                                const letters = Array.isArray(res.letters) ? res.letters.join(', ') : ''
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Dice of Doom</strong>: rolled <strong style={{ color: revealedLetterColor }}>{res.roll}</strong>{letters ? <span>: revealed: <strong style={{ color: revealedLetterColor }}>{letters}</strong></span> : null}</div>
                              }
                              if (r.powerId === 'all_letter_reveal' && res && Array.isArray(res.letters)) {
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>All Letter Reveal</strong>: revealed <strong style={{ color: revealedLetterColor }}>{res.letters.length}</strong> unique letter{res.letters.length === 1 ? '' : 's'}</div>
                              }
                              if (r.powerId === 'full_reveal' && res && typeof res.full === 'string') {
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Full Reveal</strong>: the word was revealed</div>
                              }
                              if (r.powerId === 'sound_check' && res && res.suggestions) return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Sound Check</strong>: suggestions : {Array.isArray(res.suggestions) ? res.suggestions.join(', ') : String(res.suggestions)}</div>
                              if (r.powerId === 'what_do_you_mean' && res && res.message) return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Definition</strong>: {res.message}</div>
                              if (r.powerId === 'mind_leech' && res && Array.isArray(res.found)) {
                                const found = res.found.map(f => `${f.letter}×${f.count}`).join(', ')
                                return <div style={chipStyle}><strong style={{ color: powerNameColor }}>Mind Leech</strong>: found {found || 'no letters'}</div>
                              }
                            }
                          } catch (e) {}
                          return <div style={chipStyle}><strong style={{ color: powerNameColor }}>{r.powerId}</strong>: {JSON.stringify(res)}</div>
                        })()
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
      </div>

      

    </div>
  )
}
// Styles moved to src/styles.css


