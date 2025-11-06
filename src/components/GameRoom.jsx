import React, { useEffect, useState, useMemo, useRef, useLayoutEffect } from 'react'
import ReactDOM from 'react-dom'
import PlayerCircle from './PlayerCircle'
import ChatBox from './ChatBox'
import useGameRoom from '../hooks/useGameRoom'
import useUserActivation from '../hooks/useUserActivation'
import COLOURS from '../data/colours'
import ANIMALS from '../data/animals'
import BALLSPORTS from '../data/ballsports'
import OLYMPICSPORTS from '../data/olympicsports'
import GEMSTONES from '../data/gemstones'
import INSTRUMENTS from '../data/instruments'
import ELEMENTS from '../data/elements'
import NOUNS from '../data/nouns'
import CPPTERMS from '../data/cppterms'
import FRUITS from '../data/fruits'
import VEGETABLES from '../data/vegetables'
import OCCUPATIONS from '../data/occupations'
import COUNTRIES from '../data/countries'
import { db } from '../firebase'
import { ref as dbRef, get as dbGet, update as dbUpdate, runTransaction } from 'firebase/database'
import { buildRoomUrl } from '../utils/url'

// Small, memoized component to isolate starting balance and min-word-size controls.
// This keeps frequent local edits (typing) from re-rendering the entire Settings UI.

const StartingMinSettings = React.memo(function StartingMinSettings({ initialStarting, initialMin, onPersistStarting, onPersistMin, isHost }) {
  const [localStart, setLocalStart] = React.useState(typeof initialStarting === 'number' ? initialStarting : 0)
  const [localMin, setLocalMin] = React.useState(typeof initialMin === 'number' ? initialMin : 2)

  // Keep inputs in sync when authoritative values change from outside
  React.useEffect(() => { try { setLocalStart(typeof initialStarting === 'number' ? initialStarting : 0) } catch (e) {} }, [initialStarting])
  React.useEffect(() => { try { setLocalMin(typeof initialMin === 'number' ? initialMin : 2) } catch (e) {} }, [initialMin])
 

  return (
    <div>
      <label htmlFor="minWordSize" title="Minimum allowed word length for submissions (2-10)">
        Min word length:
        <input
          id="minWordSize"
          name="minWordSize"
          type="number"
          min={2}
          max={10}
          value={localMin}
          onChange={e => { try { setLocalMin(Number(e.target.value || 2)) } catch (er) {} }}
          onBlur={() => {
            try {
              const parsed = Number(localMin)
              const v = Number.isFinite(parsed) ? Math.max(2, Math.min(10, parsed)) : 2
              setLocalMin(v)
              try { if (typeof onPersistMin === 'function') onPersistMin(v) } catch (e) {}
            } catch (e) {}
          }}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          style={{ width: 80, marginLeft: 8 }}
        />
      </label>

      <label htmlFor="startingWordmoney" title="Starting wordmoney assigned to each player when they join or when the room is reset" style={{ display: 'block', marginTop: 8 }}>
        Starting balance:
        <input
          id="startingWordmoney"
          name="startingWordmoney"
          type="number"
          min={0}
          step={1}
          value={localStart}
          onChange={e => { try { setLocalStart(e.target.value) } catch (er) {} }}
          onBlur={async () => {
            try {
              const parsed = Number(localStart)
              const v = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
              setLocalStart(v)
              try { if (typeof onPersistStarting === 'function') await onPersistStarting(v) } catch (e) {}
            } catch (e) {}
          }}
          style={{ width: 100, marginLeft: 8 }}
        />
      </label>
    </div>
  )
})

// Small control to isolate the Letter Peek input so typing doesn't re-render the
// entire power-up list. It manages its own local state and forwards a ref to
// the underlying input so parent effects (autofocus) still work.
const LetterPeekControl = React.memo(React.forwardRef(function LetterPeekControl({ open, disabled, displayPrice, onBuy, powerUpLoading, buyerBalance, isMyTurn }, ref) {
  const [localPos, setLocalPos] = React.useState('')
  const inputRef = React.useRef(null)
  // expose the input DOM node to parent via forwarded ref
  React.useEffect(() => { try { if (ref) { if (typeof ref === 'function') ref(inputRef.current); else ref.current = inputRef.current } } catch (e) {} }, [ref])
  // clear local input when modal closes
  React.useEffect(() => { if (!open) setLocalPos('') }, [open])

  const disabledFinal = Boolean(disabled || powerUpLoading || buyerBalance < displayPrice || !isMyTurn)

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input className="powerup-input" ref={inputRef} id={`powerup_letter_peek_choice`} name={`powerup_letter_peek_choice`} placeholder="position" value={localPos} onChange={e => setLocalPos(e.target.value)} disabled={disabled} />
      <button className="powerup-buy" disabled={disabledFinal} onClick={() => { try { onBuy && onBuy(localPos) } catch (e) {} }}>
        {powerUpLoading ? '...' : 'Buy'}
      </button>
    </div>
  )
}))

// Theme select isolated to avoid re-rendering dropdown options when unrelated state changes.
// The comparator only re-renders when the selected value or style/id changes.
const THEME_OPTIONS = [
  { value: 'animals', label: 'Animals' },
  { value: 'colours', label: 'Colours' },
  { value: 'instruments', label: 'Instruments' },
  { value: 'countries', label: 'Countries' },
  { value: 'ballsports', label: 'Ball Sports' },
  { value: 'olympicsports', label: 'Olympic Sports' },
  { value: 'gemstones', label: 'Gemstones' },
  { value: 'fruits', label: 'Fruits' },
  { value: 'vegetables', label: 'Vegetables' },
  { value: 'occupations', label: 'Occupations' },
  { value: 'elements', label: 'Periodic elements' },
  { value: 'cpp', label: 'C++ terms' },
  { value: 'custom', label: 'Custom' }
]

const ThemeSelect = React.memo(function ThemeSelect({ id, value, onChange, style }) {
  return (
    <select id={id} value={value} onChange={onChange} style={style}>
      {THEME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}, (prev, next) => {
  return prev.value === next.value && prev.style === next.style && prev.id === next.id
})

export default function GameRoom({ roomId, playerName, password }) { // Added password as a prop
  const { state, joinRoom, leaveRoom, sendGuess, startGame, submitWord, addBot, playerId,
    // Bot helpers
    botMakeMove, removeBot,
    // Word Seeker hooks
    startWordSeeker, markWordSeekerReady, beginWordSeekerPlaying, endWordSeekerPlaying, voteForPlayer, tallyWordSeekerVotes, submitSpyGuess, playNextWordSeekerRound
  } = useGameRoom(roomId, playerName)
  // viewer id (derived from hook or firebase auth) : declare early so effects can reference it without TDZ
  const myId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
  // Derive frequently-used room-level values early so effects can reference them without TDZ
  const phase = state?.phase || 'lobby'
  const [word, setWord] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [wordError, setWordError] = useState('')
  const [isCheckingDictionary, setIsCheckingDictionary] = useState(false)
  const [timedMode, setTimedMode] = useState(false)
  const [turnSeconds, setTurnSeconds] = useState(30)
  const [starterEnabled, setStarterEnabled] = useState(true)
  // Defaults: preserve reveal order and show blanks should be ON by default
  const [revealPreserveOrder, setRevealPreserveOrder] = useState(true)
  const [revealShowBlanks, setRevealShowBlanks] = useState(true)
  const [winnerByWordmoney, setWinnerByWordmoney] = useState(false)
  // multi-mode support: 'money' | 'lastOneStanding' | 'wordSeeker'
  const [gameMode, setGameMode] = useState('lastOneStanding')
  const [wordSeekerTimerSeconds, setWordSeekerTimerSeconds] = useState(120)
  const [wordSeekerRounds, setWordSeekerRounds] = useState(3)
  const [powerUpsEnabled, setPowerUpsEnabled] = useState(true)
  const [freeBubblesEnabled, setFreeBubblesEnabled] = useState(true)
  const [submitTimerEnabled, setSubmitTimerEnabled] = useState(false)
  const [submitTimerSeconds, setSubmitTimerSeconds] = useState(60)
  // track local claim-in-progress so the UI disables the bubble immediately after click
  const [claimingBubbleId, setClaimingBubbleId] = useState(null)
  const [showWordsOnEnd, setShowWordsOnEnd] = useState(true)
  const [minWordSize, setMinWordSize] = useState(2)
  const [minWordSizeInput, setMinWordSizeInput] = useState(String(2))
  // starting wordmoney is hard-coded to 2; no local state needed
  const [startingWordmoney, setStartingWordmoney] = useState(2)
  const [showSettings, setShowSettings] = useState(false)
  const [howToOpen, setHowToOpen] = useState(false)
  const [howToMinimized, setHowToMinimized] = useState(false)
  const [startGameHint, setStartGameHint] = useState(null)
  const [secretThemeEnabled, setSecretThemeEnabled] = useState(true)
  const [secretThemeType, setSecretThemeType] = useState('animals')
  // auto-disable ghost when host custom set explicitly allows any word (empty array)
  const autoGhostDisabledDueToCustom = useRef(false)
  // Stable handler for theme changes to avoid recreating the callback each render
  const handleThemeChange = React.useCallback((e) => {
    try { setSecretThemeType(e.target.value) } catch (er) {}
  }, [setSecretThemeType])

  // Persist secret theme settings whenever either the enabled flag or selected type changes.
  React.useEffect(() => {
    try {
      // Only the host should persist authoritative room settings. Avoid having
      // every client write defaults which can cause DB churn and re-trigger
      // effects when players join/leave.
      const amHost = state && state.hostId && myId && state.hostId === myId
      if (!amHost) return
      // Avoid writing if the authoritative value already matches local UI state.
      const remote = (state && state.secretWordTheme) ? state.secretWordTheme : {}
      const remoteType = remote.type || 'animals'
      const remoteEnabled = !!remote.enabled
      if (remoteEnabled === !!secretThemeEnabled && remoteType === (secretThemeType || 'animals')) return
      updateRoomSettings({ secretWordTheme: { enabled: !!secretThemeEnabled, type: secretThemeType } })
    } catch (e) {}
  }, [secretThemeEnabled, secretThemeType, state?.hostId, myId, state?.secretWordTheme])
  // keep local freeBubblesEnabled in sync with room state (default true)
  useEffect(() => {
    try { setFreeBubblesEnabled(state?.freeBubblesEnabled ?? true) } catch (e) {}
  }, [state?.freeBubblesEnabled])

  // Debug: log when authoritative room flags for free bubbles or ghost re-entry change
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.console && typeof window.console.log === 'function') {
        console.log('Room flags changed: freeBubblesEnabled=', state?.freeBubblesEnabled, 'ghostReEntryEnabled=', state?.ghostReEntryEnabled, 'hostId=', state?.hostId)
      }
    } catch (e) {}
  }, [state?.freeBubblesEnabled, state?.ghostReEntryEnabled, state?.hostId])
  // Auto-enable submit-timer when the room is configured as a timed game
  useEffect(() => {
    try {
      if (state && state.timed && !state.submitTimerEnabled) {
        // persist to room settings so everyone honors it
        try { updateRoomSettings({ submitTimerEnabled: true }) } catch (e) {}
      }
    } catch (e) {}
  }, [state?.timed])
  // keep submit-timer settings in sync with room state (default off)
  useEffect(() => {
    try { setSubmitTimerEnabled(Boolean(state?.submitTimerEnabled)) } catch (e) {}
    try { setSubmitTimerSeconds(Number(state?.submitTimerSeconds) || 60) } catch (e) {}
  }, [state?.submitTimerEnabled, state?.submitTimerSeconds])
  // Host-provided custom theme inputs (title + comma-separated list)
  const [customTitle, setCustomTitle] = useState('')
  const [customCsv, setCustomCsv] = useState('')
  const [customError, setCustomError] = useState('')
  const prevCustomSerializedRef = useRef(null)
  const customTitleRef = useRef(null)
  const customCsvRef = useRef(null)
  const [timeLeft, setTimeLeft] = useState(null)
  const [tick, setTick] = useState(0)
  const [toasts, setToasts] = useState([])
  // processed keys for free-bubble toasts (dedupe duplicate effect runs)
  const processedFreeBubbleRef = useRef({})
  // store stable random positions per free-bubble id so they don't jitter on re-renders
  const freeBubblePositionsRef = useRef({})
  // track auto-claim timers for free-bubbles so we can cancel when claimed by humans
  const freeBubbleAutoClaimTimersRef = useRef({})

  const [powerUpOpen, setPowerUpOpen] = useState(false)
  const [powerUpTarget, setPowerUpTarget] = useState(null)

  // Safe wrapper around Firebase multi-path update that avoids creating a
  // parent `players/<id>` node when only writing descendant paths for a player
  // that no longer exists server-side. This prevents briefly re-creating a
  // removed player's object when another client issues a multi-path update.
  async function safeDbUpdate(roomRef, updates) {
    if (!roomRef || !updates || typeof updates !== 'object') return await dbUpdate(roomRef, updates)
    try {
      // read current players map once
      const snap = await dbGet(roomRef)
      const roomVal = snap && typeof snap.val === 'function' ? snap.val() : (snap || {})
      const playersObj = (roomVal && roomVal.players) ? roomVal.players : {}
      const present = new Set(Object.keys(playersObj || {}))
      const safe = {}
      Object.keys(updates).forEach(k => {
        try {
          // allow top-level players null (intentional reset)
          if (k === 'players') { safe[k] = updates[k]; return }
          const m = k.match(/^players\/([^\/]+)(\/.*)?$/)
          if (!m) {
            // not targeting players/<id>... keep as-is
            safe[k] = updates[k]
            return
          }
          const id = m[1]
          const hasDesc = !!m[2]
          if (!hasDesc) {
            // direct players/<id> path is intentional (create or delete). Keep it.
            safe[k] = updates[k]
            return
          }
          // descendant path under players/<id>/... : only apply if player exists server-side
          if (present.has(id)) safe[k] = updates[k]
          else {
            // skip writing descendant key for missing player to avoid accidental recreation
            console.warn('safeDbUpdate: skipping write to', k, 'because player not present')
          }
        } catch (e) {}
      })
      if (Object.keys(safe).length === 0) return null
      return await dbUpdate(roomRef, safe)
    } catch (e) {
      // fallback: attempt direct update
      try { return await dbUpdate(roomRef, updates) } catch (err) { console.warn('safeDbUpdate failed', err); throw err }
    }
  }
  // separate inputs: one for generic choice (e.g. letter position) and one for double-down stake
  const [powerUpChoiceValue, setPowerUpChoiceValue] = useState('')
  const [powerUpStakeValue, setPowerUpStakeValue] = useState('')
  const [powerUpLoading, setPowerUpLoading] = useState(false)
  // Locally lock the power-up shop for the viewer after buying Double Down until they make a guess
  const [ddShopLocked, setDdShopLocked] = useState(false)
  const powerUpChoiceRef = useRef(null)
  const powerupListRef = useRef(null)
  // null means "no stored scroll position yet"; avoid defaulting to 0 which forces
  // the list to scroll-to-top when effects run but the user previously scrolled.
  const powerupScrollRef = useRef(null)
  const settingsListRef = useRef(null)
  const settingsRef = useRef(null)
  const settingsScrollRef = useRef(0)
  const multiHitSeenRef = useRef({})
  // control whether certain power-ups reveal publicly (when available in UI)
  const [powerUpRevealPublic, setPowerUpRevealPublic] = useState(false)
  // Ghost Re-Entry setting (on by default)
  const [ghostReEntryEnabled, setGhostReEntryEnabled] = useState(true)
  // Ghost guess cooldown (seconds) - default 20s; configurable by host when ghostReEntryEnabled
  const [ghostGuessCooldownSeconds, setGhostGuessCooldownSeconds] = useState(20)
  const [ghostModalOpen, setGhostModalOpen] = useState(false)
  const [ghostChallengeKeyLocal, setGhostChallengeKeyLocal] = useState(null)

  // Auto-close ghost modal when the room ends (playing → ended).
  useEffect(() => {
    try {
      if (phase === 'ended' && ghostModalOpen) {
        setGhostModalOpen(false)
      }
    } catch (e) {}
  }, [phase])

  // When the room ends, remove any unclaimed underworld free-bubble so it
  // doesn't linger on the end screen. Only the host should perform this
  // authoritative cleanup to avoid races.
  useEffect(() => {
    try {
      if (phase !== 'ended') return
      if (!state || !state.freeBubble) return
      const fb = state.freeBubble
      // if already claimed, let the claim flow handle announcements
      if (fb && fb.claimedBy) return
      // compute host status at runtime (avoid TDZ by not referencing `isHost` or `hostId` here)
      const amHost = state && state.hostId && window.__firebaseAuth && window.__firebaseAuth.currentUser && window.__firebaseAuth.currentUser.uid === state.hostId
      if (!amHost) return
      const roomRef = dbRef(db, `rooms/${roomId}`)
      // best-effort removal; ignore failures
      dbUpdate(roomRef, { freeBubble: null }).catch(() => {})
    } catch (e) {}
  }, [phase, state && state.freeBubble, state && state.hostId, roomId])
  const [firstWordWins, setFirstWordWins] = useState(false)
  // Mode badge info popover
  const [showModeInfo, setShowModeInfo] = useState(false)
  const modeInfoRef = useRef(null)
  // Whether the ModeBadge is shown in compact (minimized) form
  const [modeBadgeMinimized, setModeBadgeMinimized] = useState(false)
  // remember when the popover was last opened so we can ignore the same click event
  const modeInfoOpenedAtRef = useRef(null)
  // dedupe double-down room announcements so we only show them once per ts
  const processedDoubleDownRef = useRef({})
  // Underworld event banner when someone is eliminated by a guess
  const [underworldEvent, setUnderworldEvent] = useState(null)
  const prevPlayersRef = useRef({})
  // Watch for player elimination transitions to show a centered underworld banner
  useEffect(() => {
    try {
      const currPlayers = Array.isArray(state?.players) ? state.players.slice() : []
      // initialize prev on first run and skip firing so we don't show messages on initial load
      const prevMap = prevPlayersRef.current || {}
      if (!prevMap || Object.keys(prevMap).length === 0) {
        const m = {}
        currPlayers.forEach(p => { if (p && p.id) m[p.id] = { ...p } })
        prevPlayersRef.current = m
        return
      }
      const currMap = {}
      currPlayers.forEach(p => { if (p && p.id) currMap[p.id] = p })
      // detect newly-eliminated players
      Object.keys(currMap).forEach(pid => {
        try {
          const prevP = prevMap[pid] || {}
          const currP = currMap[pid] || {}
          const prevElim = !!prevP.eliminated
          const currElim = !!currP.eliminated
          if (!prevElim && currElim) {
            // Determine who guessed them out (prefer last entry of guessedBy.__word)
            const guessedArr = (currP.guessedBy && currP.guessedBy['__word']) ? currP.guessedBy['__word'] : []
            const lastGuesserId = (Array.isArray(guessedArr) && guessedArr.length) ? guessedArr[guessedArr.length - 1] : null
            const guesserNode = (state?.players || []).find(p => p.id === lastGuesserId) || {}
            const guesserName = guesserNode && guesserNode.name ? guesserNode.name : (lastGuesserId || 'Someone')
            const victimName = currP.name || pid
            let text = `${guesserName} sent ${victimName} to the underworld`
            if (ghostReEntryEnabled && !(currP.ghostState && currP.ghostState.reentered)) text += ' ... but for how long?'
            else text += ' forever!'
            setUnderworldEvent({ id: `uw_${Date.now()}`, text })
            // auto-clear after a short interval
            setTimeout(() => setUnderworldEvent(null), 3600)
          }
        } catch (e) {}
      })
      // update prev map
      const newMap = {}
      currPlayers.forEach(p => { if (p && p.id) newMap[p.id] = { ...p } })
      prevPlayersRef.current = newMap
    } catch (e) {}
  }, [state?.players, ghostReEntryEnabled])

  // Ensure host maintains a clean alternating turnOrder in lastTeamStanding when players change
  useEffect(() => {
    try {
      if (!state) return
      if (state.gameMode !== 'lastTeamStanding') return
      // only the host should persist authoritative turnOrder reshuffles to avoid races
      if (!hostId || hostId !== myId) return
      const playersArr = Array.isArray(state.players) ? state.players.slice() : []

      const buildLastTeamStandingOrder = (playersArr = []) => {
        try {
          const alive = (playersArr || []).filter(p => p && !p.eliminated)
          const teams = {}
          const unteamed = []
          alive.forEach(p => {
            if (p && p.team) {
              teams[p.team] = teams[p.team] || []
              teams[p.team].push(p.id)
            } else if (p && p.id) {
              unteamed.push(p.id)
            }
          })
          const teamNames = Object.keys(teams)
          if (teamNames.length === 2) {
            const a = teams[teamNames[0]] || []
            const b = teams[teamNames[1]] || []
            const maxLen = Math.max(a.length, b.length)
            const res = []
            for (let i = 0; i < maxLen; i++) {
              if (a.length > 0) {
                const cand = a[i % a.length]
                if (cand && !res.includes(cand)) res.push(cand)
              }
              if (b.length > 0) {
                const cand2 = b[i % b.length]
                if (cand2 && !res.includes(cand2)) res.push(cand2)
              }
            }
            return res.concat(unteamed)
          }
          // fallback: preserve players order skipping eliminated ones
          return alive.map(p => p.id).concat(unteamed.filter(id => !alive.some(ap => ap.id === id)))
        } catch (e) {
          return (playersArr || []).filter(p => p && !p.eliminated).map(p => p.id)
        }
      }

      const newOrder = buildLastTeamStandingOrder(playersArr)
      if (!Array.isArray(newOrder) || newOrder.length === 0) return
      const curOrder = Array.isArray(state.turnOrder) ? state.turnOrder.slice() : []
      // If identical, nothing to do
      const same = JSON.stringify(newOrder) === JSON.stringify(curOrder.filter(pid => newOrder.includes(pid)))
      if (same) return
      // compute new currentTurnIndex: try to preserve current player if possible
      const currentPid = (Array.isArray(state.turnOrder) && typeof state.currentTurnIndex === 'number') ? state.turnOrder[state.currentTurnIndex] : null
      const newIndex = newOrder.indexOf(currentPid)
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const ups = { turnOrder: newOrder }
      if (newIndex >= 0) ups.currentTurnIndex = newIndex
      else ups.currentTurnIndex = 0
      // Persist authoritative reshuffle
      safeDbUpdate(roomRef, ups).catch(() => {})
    } catch (e) {}
  }, [JSON.stringify(state?.players || []), state?.gameMode, state?.hostId, myId])
  // coin pieces shown when a double-down is won
  const [ddCoins, setDdCoins] = useState([])
  // transient overlay events when ghosts re-enter so we can show animated UI for everyone
  const [ghostReenterEvents, setGhostReenterEvents] = useState([])
  // show a prominent "Your turn" banner briefly when the viewer's turn starts
  const [showYourTurnBanner, setShowYourTurnBanner] = useState(false)
  const yourTurnTimeoutRef = useRef(null)
  // remember which turn index we've already shown the banner for so we don't re-show
  // it on unrelated re-renders while the turn is still active
  const lastShownTurnRef = useRef(null)
  // portal root for dd overlay attached to document.body to avoid stacking-context issues
  const [ddOverlayRoot, setDdOverlayRoot] = useState(null)
  // portal root for modals (settings / power-up) attached to document.body to avoid layout jumps
  const [modalRoot, setModalRoot] = useState(null)
  const [recentPenalty, setRecentPenalty] = useState({})
  const [pendingDeducts, setPendingDeducts] = useState({})
  const [showConfirmReset, setShowConfirmReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [forcedLobbyView, setForcedLobbyView] = useState(false)
  // ensure audio/vibration unlock on first user gesture (no UI toast)
  useUserActivation()

  // Helper: apply an award/deduction amount to either a player's wallet or their team wallet
  // depending on room.mode === 'lastTeamStanding'. Always record a per-player lastGain for UI.
  function applyAward(updates, pid, amount, { reason = null, by = null } = {}) {
 
    const playerNode = (state?.players || []).find(p => p.id === pid) || {}
    // Prefer authoritative room state when available, but fall back to local UI state
    const effectiveMode = (state && state.gameMode) ? state.gameMode : gameMode
    if (effectiveMode === 'lastTeamStanding' && playerNode && playerNode.team) {
        const team = playerNode.team
  const prevTeam = Number(state?.teams?.[team]?.wordmoney || 0)
        const teamBase = (typeof updates[`teams/${team}/wordmoney`] !== 'undefined') ? Number(updates[`teams/${team}/wordmoney`]) : prevTeam
        updates[`teams/${team}/wordmoney`] = Math.max(0, Number(teamBase) + Number(amount))
      } else {
        const prev = (playerNode && typeof playerNode.wordmoney === 'number') ? Number(playerNode.wordmoney) : 0
        const base = (typeof updates[`players/${pid}/wordmoney`] !== 'undefined') ? Number(updates[`players/${pid}/wordmoney`]) : prev
        updates[`players/${pid}/wordmoney`] = Math.max(0, Number(base) + Number(amount))
      }
      updates[`players/${pid}/lastGain`] = { amount: Number(amount), by: by, reason: reason, ts: Date.now() }
    
  }

  // Global capture: log unhandled promise rejections and window errors to help debug
  // intermittent extension-related failures that show as "A listener indicated an asynchronous response..."
  useEffect(() => {
    const onRejection = (ev) => {
      try {
        console.error('Global unhandledrejection caught in GameRoom:', ev)
        // some browsers put the actual error in ev.reason
        if (ev && ev.reason) console.error('Rejection reason:', ev.reason)
        // rethrow a bit later so it's also visible in dev tools stack if desired
      } catch (e) {}
    }
    const onError = (ev) => {
      try {
        console.error('Global error caught in GameRoom:', ev)
      } catch (e) {}
    }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [])

  useEffect(() => {
    joinRoom(password) // Pass the password to joinRoom
    return () => leaveRoom()
  }, [password])

  // create a body-level container for the dd overlay to avoid ancestor stacking contexts
  useEffect(() => {
    try {
      const id = `gh-dd-overlay-root-${roomId || 'global'}`
      let el = document.getElementById(id)
      if (!el) {
        el = document.createElement('div')
        el.id = id
        document.body.appendChild(el)
      }
      setDdOverlayRoot(el)
      return () => {
        try { if (el && el.parentNode) el.parentNode.removeChild(el) } catch (e) {}
      }
    } catch (e) {}
  }, [roomId])

  // create a dedicated modal root on document.body for Settings / PowerUp modals
  useEffect(() => {
    try {
      const id = `gh-modal-root-${roomId || 'global'}`
      let el = document.getElementById(id)
      if (!el) {
        el = document.createElement('div')
        el.id = id
        document.body.appendChild(el)
      }
      setModalRoot(el)
      return () => {
        try { if (el && el.parentNode) el.parentNode.removeChild(el) } catch (e) {}
      }
    } catch (e) {}
  }, [roomId])

  // local tick to refresh timers on screen
  // Pause the tick when the power-up modal is open to avoid frequent re-renders that
  // can interfere with modal scroll position.
  useEffect(() => {
    // Also pause the tick while the settings modal is open so dropdowns inside
    // the modal (e.g. the gameMode <select>) aren't closed by rapid re-renders.
    if (powerUpOpen || showSettings) return undefined
    const id = setInterval(() => setTick(t => t + 1), 300)
    return () => clearInterval(id)
  }, [powerUpOpen, showSettings])

  // keep local timed UI in sync with room state (so non-hosts can see current selection)
  useEffect(() => {
    // If room explicitly sets timed, respect it; otherwise, when Word Seeker is active
    // default timed mode ON and compute seconds = 60 * number of players (clamped)
    if (state?.timed !== undefined) setTimedMode(!!state.timed);
    if (state?.turnTimeoutSeconds !== undefined) setTurnSeconds(state.turnTimeoutSeconds || 30);
    if (state?.gameMode === 'wordSeeker') {
      try {
        setTimedMode(true)
        const playersCount = (state && state.players && Array.isArray(state.players)) ? state.players.length : 1
        const computed = Math.max(10, Math.min(600, 60 * Math.max(1, playersCount)))
        // prefer explicit room value if present, otherwise use computed
        if (typeof state?.turnTimeoutSeconds !== 'number') {
          setTurnSeconds(computed)
        }
        // keep legacy wordSeekerTimerSeconds in sync for compatibility
        setWordSeekerTimerSeconds(prev => (typeof state?.wordSeekerTimerSeconds === 'number' ? Math.max(10, Math.min(600, Number(state.wordSeekerTimerSeconds))) : computed))
      } catch (e) {}
    }
    // legacy support: if gameMode exists, prefer it; otherwise derive from winnerByWordmoney
    if (state?.gameMode) setGameMode(state.gameMode)
    else setWinnerByWordmoney(!!state?.winnerByWordmoney);
  // sync new gameMode and Word Seeker settings when present
  if (state?.gameMode) setGameMode(state.gameMode)
  if (typeof state?.wordSeekerTimerSeconds === 'number') setWordSeekerTimerSeconds(Math.max(10, Math.min(600, Number(state.wordSeekerTimerSeconds))))
  if (typeof state?.wordSeekerRounds === 'number') setWordSeekerRounds(Math.max(1, Math.min(20, Number(state.wordSeekerRounds))))
  setStarterEnabled(!!state?.starterBonus?.enabled);
  // default power-ups to enabled unless the room explicitly sets it to false
  setPowerUpsEnabled(state?.powerUpsEnabled ?? true);
    // sync Ghost Re-Entry setting from room state (default true)
    // If the host custom set exists and is an empty array (meaning "allow any word"),
    // automatically disable Ghost Re-Entry for UI purposes. Persisting the disabled
    // value to room settings is handled when the host saves the custom set below.
    try {
      const customEmpty = (secretThemeType === 'custom') && (state && state.secretWordTheme && state.secretWordTheme.custom && Array.isArray(state.secretWordTheme.custom.words) && state.secretWordTheme.custom.words.length === 0)
      if (customEmpty) {
        // Force the local UI to show Ghost Re-Entry disabled
        setGhostReEntryEnabled(false)
        // If the current viewer is the host, persist this change once so the
        // room settings reflect that Ghost Re-Entry is disabled when custom
        // set explicitly allows any word (empty list).
        try {
          const amHostNow = state && state.hostId && window.__firebaseAuth && window.__firebaseAuth.currentUser && window.__firebaseAuth.currentUser.uid === state.hostId
          if (amHostNow && !autoGhostDisabledDueToCustom.current) {
            // only persist when room still has ghostReEntryEnabled truthy (or undefined)
            if (typeof state?.ghostReEntryEnabled === 'undefined' || state.ghostReEntryEnabled !== false) {
              try { updateRoomSettings({ ghostReEntryEnabled: false }) } catch (e) {}
              autoGhostDisabledDueToCustom.current = true
            }
          }
        } catch (e) {}
      } else {
        setGhostReEntryEnabled(state?.ghostReEntryEnabled ?? true)
        // reset auto-disable marker when not in custom-empty mode
        try { autoGhostDisabledDueToCustom.current = false } catch (e) {}
      }
    } catch (e) {
      // fallback to previous behavior
      setGhostReEntryEnabled(state?.ghostReEntryEnabled ?? true)
    }
    // sync ghost guess cooldown seconds (host-configurable). Default remains 20s when not set.
    try {
      if (typeof state?.ghostGuessCooldownSeconds === 'number') setGhostGuessCooldownSeconds(Math.max(1, Math.min(300, Number(state.ghostGuessCooldownSeconds))))
    } catch (e) {}
    // showWordsOnEnd controls whether players' secret words are displayed on final standings
    if (typeof state?.showWordsOnEnd === 'boolean') setShowWordsOnEnd(!!state.showWordsOnEnd)

    // ✅ update min word size only if that specific field changes
    const syncedMin = typeof state?.minWordSize === 'number'
      ? Math.max(2, Math.min(10, state.minWordSize))
      : 2;

    setMinWordSize(prev => {
      if (prev !== syncedMin) {
        setMinWordSizeInput(String(syncedMin));
        return syncedMin;
      }
      return prev;
    });

    // sync configured starting wordmoney when present (accept numeric strings too)
    try {
      if (typeof state?.startingWordmoney !== 'undefined' && !Number.isNaN(Number(state.startingWordmoney))) {
        setStartingWordmoney(Math.max(0, Number(state.startingWordmoney)))
      }
    } catch (e) {}

    // startingWordmoney is fixed to 2 (hard-coded); do not sync from room settings
    // sync reveal settings
    if (typeof state?.revealPreserveOrder === 'boolean') setRevealPreserveOrder(!!state.revealPreserveOrder)
    if (typeof state?.revealShowBlanks === 'boolean') setRevealShowBlanks(!!state.revealShowBlanks)
    // If server indicates Show blanks is enabled, ensure Preserve reveal order is enforced
    try {
      if (state && state.revealShowBlanks) {
        // enforce locally
        setRevealPreserveOrder(true)
        // if server has an inconsistent value, correct it by persisting preserve=true
        if (typeof state.revealPreserveOrder !== 'boolean' || state.revealPreserveOrder !== true) {
          try { updateRoomSettings({ revealPreserveOrder: true }) } catch (e) {}
        }
      }
    } catch (e) {}
    // sync secret word theme settings if present (run whenever the authoritative room setting changes)
    if (typeof state?.secretWordTheme === 'object') {
      const st = state.secretWordTheme || {}
      // Update local UI state so all players see the current host-selected theme immediately
      setSecretThemeEnabled(!!st.enabled)
      setSecretThemeType(st.type || 'animals')
      // Pre-fill host custom inputs when present and when the theme is 'custom'.
      // Only overwrite uncontrolled inputs when the settings modal is open so an actively-typing host doesn't lose focus.
      try {
        if (showSettings && (st.type === 'custom') && st.custom && Array.isArray(st.custom.words)) {
          const ser = JSON.stringify({ title: st.custom.title || '', words: (st.custom.words || []) })
          if (prevCustomSerializedRef.current !== ser) {
            prevCustomSerializedRef.current = ser
            try { if (customTitleRef.current) customTitleRef.current.value = st.custom.title || '' } catch (e) {}
            try { if (customCsvRef.current) customCsvRef.current.value = (st.custom.words || []).join(',') } catch (e) {}
            setCustomTitle(st.custom.title || '')
            setCustomCsv((st.custom.words || []).join(','))
          }
        }
      } catch (e) {}
    }

    // sync lastTeamStanding 'firstWordWins' setting (default false)
    try {
      // Default to false when the authoritative room flag is not present.
      setFirstWordWins(typeof state?.firstWordWins === 'undefined' ? false : !!state.firstWordWins)
    } catch (e) {}

  // sync Word Seeker settings if present
  if (typeof state?.wordSeekerTimerSeconds === 'number') setWordSeekerTimerSeconds(Math.max(10, Math.min(600, Number(state.wordSeekerTimerSeconds))))
  if (typeof state?.wordSeekerRounds === 'number') setWordSeekerRounds(Math.max(1, Math.min(20, Number(state.wordSeekerRounds))))

  }, [
    state?.timed,
    state?.turnTimeoutSeconds,
    state?.winnerByWordmoney,
    state?.starterBonus?.enabled,
    state?.powerUpsEnabled,
    state?.minWordSize,
    // ensure we re-run when the authoritative secretWordTheme changes so UI updates for all players
    state?.secretWordTheme,
    // ensure we re-run when the configured starting balance changes
    state?.startingWordmoney,
    // startingWordmoney removed
  ]);

  // toggle a body-level class so the background becomes green when money-mode is active
  useEffect(() => {
    try {
      if (state?.winnerByWordmoney) document.body.classList.add('money-theme-body')
      else document.body.classList.remove('money-theme-body')
    } catch (e) {}
    return () => {}
  }, [state?.winnerByWordmoney])

  // Toggle Word Seeker theme (pink/black) when the room's gameMode is 'wordSeeker'
  useEffect(() => {
    try {
      if (state?.gameMode === 'wordSeeker') {
        document.body.classList.add('wordseeker-theme-body')
      } else {
        document.body.classList.remove('wordseeker-theme-body')
      }
    } catch (e) {}
    return () => {}
  }, [state?.gameMode])

  // Always enable the underworld theme (visual theme) for the game UI.
  // Money mode keeps its green theme via `money-theme-body` which will override
  // the underworld background; WordSeeker keeps its own body class and will get
  // a different underworld background via CSS overrides.
  useEffect(() => {
    try {
      document.body.classList.add('underworld-theme')
    } catch (e) {}
    return () => { try { document.body.classList.remove('underworld-theme') } catch (e) {} }
  }, [])

  // Small badge component to display the active secret-word theme with emoji + gradient
  function ThemeBadge({ type }) {
    const infoMap = {
      animals: { emoji: '🐾', label: 'Animals', bg: 'linear-gradient(90deg,#34d399,#059669)' },
  ballsports: { emoji: '🏀', label: 'Ball Sports', bg: 'linear-gradient(90deg,#f97316,#f43f5e)' },
  olympicsports: { emoji: '🏅', label: 'Olympic Sports', bg: 'linear-gradient(90deg,#ffb86b,#ff6b6b)' },
  colours: { emoji: '🎨', label: 'Colours', bg: 'linear-gradient(90deg,#7c3aed,#ec4899)' },
  fruits: { emoji: '🍎', label: 'Edible Fruits (Culinary)', bg: 'linear-gradient(90deg,#f97316,#f43f5e)' },
  vegetables: { emoji: '🥬', label: 'Vegetables', bg: 'linear-gradient(90deg,#84cc16,#16a34a)' },
    occupations: { emoji: '🧑‍🔧', label: 'Occupations', bg: 'linear-gradient(90deg,#f59e0b,#a78bfa)' },
  countries: { emoji: '🌍', label: 'Countries', bg: 'linear-gradient(90deg,#06b6d4,#0ea5a1)' },
  instruments: { emoji: '🎵', label: 'Musical Instruments', bg: 'linear-gradient(90deg,#f97316,#ef4444)' },
  elements: { emoji: '⚛️', label: 'Periodic Table Elements', bg: 'linear-gradient(90deg,#9ca3af,#6b7280)' },
  cpp: { emoji: '💻', label: 'C++ terms', bg: 'linear-gradient(90deg,#0ea5e9,#0369a1)' },
  gemstones: { emoji: '💎', label: 'Gemstones', bg: 'linear-gradient(90deg,#f472b6,#f43f5e)' },
  custom: { emoji: '📝', label: 'Custom', bg: 'linear-gradient(90deg,#f59e0b,#ef4444)' },
      default: { emoji: '🔖', label: type || 'Theme', bg: 'linear-gradient(90deg,#2b8cff,#0b63d6)' }
    }
    const info = infoMap[type] || infoMap.default
    return (
      <div style={{ marginTop: 8 }}>
        <span title={`Secret word theme: ${info.label}`} style={{ background: info.bg, color: '#fff', padding: '6px 10px', borderRadius: 12, fontSize: 13, fontWeight: 700, display: 'inline-block', textTransform: 'none' }}>
          <span style={{ marginRight: 8 }}>{info.emoji}</span>
          {info.label}
        </span>
      </div>
    )
  }

  // highlight when it's the viewer's turn by adding/removing a body-level class
  useEffect(() => {
    try {
      const myIdLocal = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
      const isMyTurnNowLocal = state && state.turnOrder && typeof state.currentTurnIndex === 'number' && state.turnOrder[state.currentTurnIndex] === myIdLocal
      if (isMyTurnNowLocal) {
        document.body.classList.add('my-turn-body')
        try {
          // only show the banner the first time this particular turn index becomes active
          const idx = (typeof state?.currentTurnIndex === 'number') ? state.currentTurnIndex : null
          if (idx !== null && lastShownTurnRef.current !== idx) {
            lastShownTurnRef.current = idx
            setShowYourTurnBanner(true)
            if (yourTurnTimeoutRef.current) clearTimeout(yourTurnTimeoutRef.current)
            yourTurnTimeoutRef.current = setTimeout(() => setShowYourTurnBanner(false), 5000)
          }
        } catch (e) {}
      } else {
        document.body.classList.remove('my-turn-body')
        try {
          if (yourTurnTimeoutRef.current) { clearTimeout(yourTurnTimeoutRef.current); yourTurnTimeoutRef.current = null }
        } catch (e) {}
        // clear lastShownTurnRef so the banner will show again the next time it's your turn
        lastShownTurnRef.current = null
        setShowYourTurnBanner(false)
      }
    } catch (e) {}
    return () => { try { if (yourTurnTimeoutRef.current) { clearTimeout(yourTurnTimeoutRef.current); yourTurnTimeoutRef.current = null } } catch (e) {} }
  }, [state?.turnOrder, state?.currentTurnIndex])

  // write timing preview to room so all players (including non-hosts) can see before start
  async function updateRoomTiming(timed, seconds) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
  await safeDbUpdate(roomRef, { timed: !!timed, turnTimeoutSeconds: timed ? Math.max(10, Math.min(600, Number(seconds) || 30)) : null })
    } catch (e) {
      console.warn('Could not update room timing preview', e)
    }
  }

    // Helper: sanitize multi-path update objects for Firebase Realtime Database.
    // Firebase rejects updates that contain both an ancestor path and a descendant
    // path in the same multi-path update object (e.g. { "teams": null, "teams/blue/x": 1 }).
    // This function removes descendant keys when an ancestor is present, preferring
    // the ancestor assignment (keeps the shorter key and drops any keys that start
    // with that key + '/').
    function sanitizeUpdatesForFirebase(updates) {
      try {
        if (!updates || typeof updates !== 'object') return updates
        const keys = Object.keys(updates)
        const sanitized = {}
        for (const k of keys) {
          // if any other key is an ancestor of k (i.e. otherKey + '/' is prefix of k),
          // then skip k to avoid ancestor/descendant conflict
          const hasAncestor = keys.some(a => a !== k && k.startsWith(a + '/'))
          if (!hasAncestor) sanitized[k] = updates[k]
        }
        return sanitized
      } catch (e) {
        // on error, fallback to original updates (better to try than silently drop)
        return updates
      }
    }

  async function updateRoomGameMode(mode, opts = {}) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const safeMode = (mode === 'money' || mode === 'lastOneStanding' || mode === 'wordSeeker' || mode === 'lastTeamStanding') ? mode : 'lastOneStanding'
      const updates = { gameMode: safeMode }
      // keep legacy boolean in sync
      updates['winnerByWordmoney'] = safeMode === 'money'
      if (safeMode === 'wordSeeker') {
        if (opts.timerSeconds) updates['wordSeekerTimerSeconds'] = Math.max(10, Math.min(600, Number(opts.timerSeconds)))
        if (opts.rounds) updates['wordSeekerRounds'] = Math.max(1, Math.min(20, Number(opts.rounds)))
      }
  await safeDbUpdate(roomRef, updates)
    } catch (e) {
      console.warn('Could not update room game mode', e)
    }
  }

  // Helper to attempt resetting the room using a REST-first fallback, returns boolean
  async function attemptReset(updates) {
    const roomRef = dbRef(db, `rooms/${roomId}`)
    const errors = []
    console.log('attemptReset: diagnostic info (ordered checks):', {
      typeof_dbUpdate: typeof dbUpdate,
      hasRoomRefUpdate: !!(roomRef && typeof roomRef.update === 'function'),
      hasFetch: typeof fetch === 'function',
      runtimeDBURL: !!window.__firebaseDatabaseURL,
      hasAuth: !!(window && window.__firebaseAuth && window.__firebaseAuth.currentUser)
    })
    // Preferred strategy: use SDK update helpers first (most reliable in normal clients)
    try {
      if (typeof dbUpdate === 'function') {
  await safeDbUpdate(roomRef, updates)
        console.log('attemptReset: named dbUpdate succeeded')
        return true
      }
    } catch (errA) {
      console.warn('attemptReset: named dbUpdate failed', errA && (errA.stack || errA.message || String(errA)))
      errors.push({ step: 'named dbUpdate', err: errA && (errA.stack || errA.message || String(errA)) })
    }

    // Next fallback: roomRef.update
    try {
      if (roomRef && typeof roomRef.update === 'function') {
        await roomRef.update(updates)
        console.log('attemptReset: roomRef.update succeeded')
        return true
      }
    } catch (errB) {
      console.warn('attemptReset: roomRef.update failed', errB && (errB.stack || errB.message || String(errB)))
      errors.push({ step: 'ref.update', err: errB && (errB.stack || errB.message || String(errB)) })
    }

    // REST PATCH fallback (useful for environments where SDK update isn't available)
    try {
      const authToken = (window.__firebaseAuth && window.__firebaseAuth.currentUser) ? await window.__firebaseAuth.currentUser.getIdToken() : null
      const dbUrl = window.__firebaseDatabaseURL || (typeof process !== 'undefined' && process.env && (process.env.VITE_FIREBASE_DATABASE_URL || process.env.FIREBASE_DATABASE_URL)) || null
      if (!dbUrl) throw new Error('No database URL available for REST fallback')
      const url = `${dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}.json${authToken ? `?auth=${authToken}` : ''}`
      const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
      if (!res.ok) throw new Error('REST fallback failed: ' + res.status + ' ' + (await res.text()))
      console.log('attemptReset: REST PATCH succeeded')
      return true
    } catch (errRest) {
      console.warn('attemptReset: REST PATCH failed or unavailable', errRest && (errRest.stack || errRest.message || String(errRest)))
      errors.push({ step: 'rest-patch', err: errRest && (errRest.stack || errRest.message || String(errRest)) })
    }

    // Final fallback: dynamic import of firebase update function
    try {
      const mod = await import('firebase/database')
      const updateFn = (mod && typeof mod.update === 'function') ? mod.update : (mod && mod.default && typeof mod.default.update === 'function') ? mod.default.update : null
      if (typeof updateFn === 'function') {
        await updateFn(roomRef, updates)
        console.log('attemptReset: dynamic import update succeeded')
        return true
      } else {
        throw new Error('dynamic import did not expose a callable update()')
      }
    } catch (errC) {
      console.warn('attemptReset: dynamic import approach failed', errC && (errC.stack || errC.message || String(errC)))
      errors.push({ step: 'dynamic import', err: errC && (errC.stack || errC.message || String(errC)) })
    }

    console.error('attemptReset: all update strategies failed', errors)
    return false
  }

  // write winner mode to the room so all clients see it immediately
  async function updateRoomWinnerMode(enabled) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      // preserve backwards compatibility by setting winnerByWordmoney, but also set gameMode when toggled
      const updates = { winnerByWordmoney: !!enabled }
      // if enabled, set mode to 'money'
      updates['gameMode'] = enabled ? 'money' : (state?.gameMode || 'lastOneStanding')
  await safeDbUpdate(roomRef, updates)
    } catch (e) {
      console.warn('Could not update winner mode', e)
    }
  }

  // watch for timeout logs in state.timeouts to show toast and flash player
  // dedupe timeouts per player to avoid duplicate toasts when both client and server
  const processedTimeoutPlayersRef = useRef({})
  // also dedupe by timeout key so the same timeout entry doesn't re-trigger repeatedly
  const processedTimeoutKeysRef = useRef({})
  // track previous wordmoney values so we can show gain toasts when anyone receives points
  const prevHangRef = useRef({})
  // track expected wordmoney values after a pending deduction so the UI can wait for DB confirmation
  const expectedHangRef = useRef({})
  const prevHostRef = useRef(null)

  // viewer id (derived from hook or firebase auth) : declare early to avoid TDZ in effects
  

  // Derived room values: declare early so effects can reference them without TDZ
  const hostId = state?.hostId
  const players = state?.players || []
  // whether all non-host players have signaled ready in the lobby
  const allNonHostPlayersReady = (Array.isArray(players) ? players.filter(p => p && p.id !== hostId) : []).every(p => !!p.ready)
  const playerIdToName = {}
  players.forEach(p => { if (p && p.id) playerIdToName[p.id] = p.name })
  const waitingForSubmission = (players || []).filter(p => !p.hasWord)
  const firstWaiting = waitingForSubmission && waitingForSubmission.length > 0 ? waitingForSubmission[0] : null
  const submittedCount = players.filter(p => p.hasWord).length

  // Submit-phase phrases: compute once and cycle through them while in submit phase.
  const submitPhrases = useMemo(() => {
    return [
      'Submit your word',
                            (state?.secretThemeEnabled && state?.secretThemeType) ? `The word should belong to the category "${state.secretThemeType}"` : null,
                            "Don't know how to play? There's a button on the top right!",
                            `Don't keep us waiting, ${firstWaiting ? firstWaiting.name : 'mortal'}`,
                            'Choose wisely',
                            'Hide it well',
                            'Make your move',
                            `Hey ${firstWaiting ? firstWaiting.name : 'mortal'}, hurry up!`,
                            'Whisper it to the void. It listens',
                            'The tombstones are taking bets',
                            'Even the bats are gossiping',
                            'Seal it in a sarcophagus of secrecy',
                            "Don't anger the librarians of Hades",
                            'Sacrifice a syllable for good luck',
                            'The reaper prefers short words',
                            'Make the underworld proud (or at least entertained)',
                            'Quick, the ghosts are forming a conga line',
                            `My ghost mother comes up with words faster than ${firstWaiting ? firstWaiting.name : 'you mortal'}`,
                            'Keep it cursed, not cursed out',
                            'Hide it better than a vampire hides sunscreen',
                            'Hurry! The bats are voting',
                            "They'll haunt you for a bad word choice",
                            "Don't let the skeletons correct your spelling",
                            "Write it fast! The crypt's closing soon",
                            'Oh my ghoul...',
                            "You'd think you'd have a word by now",
                            'This part of the game is not meant to be hard',
                            'Just write something! ANYTHING!!!',
                            'Ask your fellow mortals on the chat?',
                            'The spirits are waiting',
                            'Hurry up before the ghosts start judging you',
                            'The underworld is watching...',
                            'Time is running out, and so are your chances',
                            "Don't let the pressure get to you",
                            'The spirits are restless',
                            'Can you feel their gaze?',
                            'Every second counts',
                            `Choose wisely, ${firstWaiting ? firstWaiting.name : 'mortal'}`,
                            'The clock is ticking...',
                            "Don't keep the spirits waiting",
                            'Your word is your shield',
                            'Speak your word into the void',
                            'Let the darkness consume your doubts',
                            'Embrace the chaos within',
                            'The underworld awaits your choice',
                            "Make your mark before it's too late",
                            'The reaper is getting impatient',
                            'Choose a word that even the ghosts would fear',
                            'Remember, in the underworld, silence is deadly',
                            `OKAY, ${firstWaiting ? firstWaiting.name : 'MORTAL'}.`,
                            'TIME IS UP SO PICK A WORD ALREADY!',
                            'THE GHOSTS ARE GETTING RESTLESS!',
                            'EVEN THE REAPER IS TAPPING HIS SCYTHE!',
                            'THE UNDERWORLD IS STARTING TO MOAN!',
                            'HURRY UP BEFORE YOU\'RE HAUNTED!',
                            'THE BATTS ARE STARTING TO VOTE!',
                            'THE SKELETONS ARE CORRECTING YOUR SPELLING!',
                            "THE CRYPT'S CLOSING SOON!",
                            'OH MY GHOUL, JUST PICK A WORD!',
                            'ASK GhostGPT FOR A SUGGESTION!',
                            'I need to calm down.',
                            'I apologize. Did not mean to yell.',
                            'Please, take your time.',
                            'Choose a word that resonates with your soul.',
                            'Let your intuition guide you.',
                            'Trust in the whispers of the underworld.',
                            'Select a word that echoes through eternity.',
                            'Find a term that even the shadows respect.',
                            'Pick a word that would make the reaper nod in approval.',
                            `${firstWaiting ? firstWaiting.name : 'someone'}, the spirits are waiting for you.`,
                            'Hurry, before the underworld loses its patience.',
                            'The fate of your word lies in your hands.',
                            'Choose wisely, for the underworld remembers all.',
                            'Let your word be your legacy in the realm of shadows.'
    ].filter(Boolean)
  }, [state?.secretThemeEnabled, state?.secretThemeType, firstWaiting && firstWaiting.id])

  const [submitPhraseIndex, setSubmitPhraseIndex] = useState(0)
  useEffect(() => {
    if (phase !== 'submit' || !submitPhrases || submitPhrases.length === 0) {
      setSubmitPhraseIndex(0)
      return undefined
    }
    // start at 0 each time submit phase begins
    setSubmitPhraseIndex(0)
    const id = setInterval(() => {
      setSubmitPhraseIndex(i => (i + 1) % submitPhrases.length)
    }, 9000)
    return () => clearInterval(id)
  }, [phase, submitPhrases.length])

  const isHost = hostId && window.__firebaseAuth && window.__firebaseAuth.currentUser && window.__firebaseAuth.currentUser.uid === hostId
  const currentTurnIndex = state?.currentTurnIndex || 0
  const currentTurnId = (state?.turnOrder || [])[currentTurnIndex]
  // whether the viewer is the current turn player
  const isMyTurnNow = state && state.turnOrder && typeof state.currentTurnIndex === 'number' && state.turnOrder[state.currentTurnIndex] === myId

  // Host-runner: when it's a bot player's turn, the host schedules the bot to act
  useEffect(() => {
    try {
      if (!isHost) return
      if (!state || state.phase !== 'playing') return
      const order = state.turnOrder || []
      const idx = typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex : null
      if (idx === null) return
      const pid = order[idx]
      if (!pid) return
      const playerNode = (state.players || []).find(p => p.id === pid) || {}
      if (!playerNode || !playerNode.isBot) return
      // determine delay per-bot then schedule
      const bs = playerNode.botSettings || state.botSettings || {}
      const delayMs = Number(bs.delayMs) || 4000
      const jitter = Math.floor(Math.random() * 800) - 400
      const timer = setTimeout(() => {
        try {
          if (typeof botMakeMove === 'function') botMakeMove(pid).catch(() => {})
        } catch (e) {}
      }, Math.max(250, delayMs + jitter))
      return () => clearTimeout(timer)
    } catch (e) {}
  }, [state?.currentTurnIndex, JSON.stringify(state?.turnOrder || []), JSON.stringify(state?.players || []), isHost, state?.phase])

  // live per-second cooldown display for ghost guesses (seconds remaining)
  const [ghostCooldownSec, setGhostCooldownSec] = useState(0)
  useEffect(() => {
    // update every second while modal is open so the UI shows a live countdown
    if (!ghostModalOpen) {
      try { setGhostCooldownSec(0) } catch (e) {}
      return undefined
    }
    let mounted = true
    function tickLocal() {
      try {
        const me = (state?.players || []).find(p => p.id === myId) || {}
  const last = Number(me.ghostLastGuessAt || 0)
  // Determine cooldown using authoritative room state when available, otherwise use local host-configured value.
  const cfgSeconds = (state && typeof state.ghostGuessCooldownSeconds === 'number') ? Number(state.ghostGuessCooldownSeconds) : Number(ghostGuessCooldownSeconds || 20)
  const cooldownMs = Math.max(1000, Math.min(300000, cfgSeconds * 1000))
        const now = Date.now()
        const remainingMs = last ? Math.max(0, cooldownMs - (now - last)) : 0
        const sec = Math.ceil(remainingMs / 1000)
        if (mounted) setGhostCooldownSec(sec)
      } catch (e) {}
    }
    tickLocal()
    const id = setInterval(tickLocal, 1000)
    return () => { mounted = false; clearInterval(id) }
  }, [state?.players, myId, ghostModalOpen])

  // Track whether we've observed the current player in the room previously so we only
  // redirect when we detect their removal after having been present.
  const wasPresentRef = useRef(false)

  // If the current viewer's player entry disappears from state.players after
  // previously being present, assume they were removed and redirect them to '/'.
  useEffect(() => {
    try {
      if (!state || !Array.isArray(state.players) || !myId) return
      const present = state.players.some(p => p && p.id === myId)
      if (present) {
        wasPresentRef.current = true
        return
      }
      if (!present && wasPresentRef.current) {
        // we were present before and now we aren't : redirect to main page
        try {
          // attempt a replace so back button doesn't return to removed room
          window.location.replace('/')
        } catch (e) {
          try { window.location.href = '/' } catch (ee) {}
        }
      }
    } catch (e) {}
  }, [state && state.players, myId])

  // Notify players when host changes
  useEffect(() => {
  if (!state) return
  const prev = prevHostRef.current
  const current = state?.hostId
    // initialize on first run
    if (prev === null) {
      prevHostRef.current = current
      return
    }
    if (prev !== current) {
      const newHostObj = (state.players || []).find(p => p.id === current) || {}
      const newHostName = newHostObj.name || current || 'Unknown'
      const toastId = `host_${Date.now()}`
      const text = (current === myId) ? 'You are now the host' : `Host changed: ${newHostName}`
      setToasts(t => [...t, { id: toastId, text }])
      setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 4000)
      prevHostRef.current = current
    }
  }, [state?.hostId])
  useEffect(() => {
    const players = state?.players || []
    const timeouts = state?.timeouts || {}

    // scan for privateHits where the current viewer (myId) has an entry with count >= 2
    try {
      const me = players.find(p => p.id === myId) || {}
      const privateHits = me.privateHits || {}
      Object.keys(privateHits).forEach(targetId => {
        const entries = privateHits[targetId] || []
        entries.forEach(e => {
          if (e && e.type === 'letter' && (Number(e.count) || 0) >= 2) {
            const key = `${targetId}:${e.letter}:${e.count}`
            if (!multiHitSeenRef.current[key]) {
              multiHitSeenRef.current[key] = true
              const toastId = `mh_${Date.now()}`
              setToasts(t => [...t, { id: toastId, text: `Nice! ${e.count}× "${e.letter.toUpperCase()}" found : +${2*e.count}`, multi: true }])
              setTimeout(() => {
                setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x))
              }, 7000)
              setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 8000)
            }
          }
        })
      })
    } catch (e) {}

    // handle timeouts
    try {
      const keys = Object.keys(timeouts)
      keys.forEach(k => {
        const e = timeouts[k]
        if (!e || !e.player) return

        const playerIdTimed = e.player
        const ts = e.ts || Date.now()
        const playerObj = players.find(p => p.id === playerIdTimed)
        const playerName = (playerObj && playerObj.name) ? playerObj.name : playerIdTimed

        // dedupe per-player, prefer turnStartedAt when present
        const seen = processedTimeoutPlayersRef.current[playerIdTimed] || {}
        const seenTurn = seen.turnStartedAt
        if (e.turnStartedAt && seenTurn && e.turnStartedAt === seenTurn) return
        const last = seen.ts || 0
        if (!e.turnStartedAt && Math.abs(ts - last) < 5000) return
        processedTimeoutPlayersRef.current[playerIdTimed] = { ts, turnStartedAt: e.turnStartedAt || null }

        // don't re-show the same timeout entry's toast repeatedly
        if (processedTimeoutKeysRef.current[k]) return
        processedTimeoutKeysRef.current[k] = true

  const toastId = `${k}`
  // Custom actions may be attached to timeout entries (e.g. skip or removal due to inactivity)
  let toastText = `-2 wordmoney for ${playerName} (timed out)`
  if (e && e.action === 'skip_due_inactivity') toastText = `${playerName} was skipped due to inactivity`
  if (e && e.action === 'removed_inactivity') toastText = `${playerName} was removed due to inactivity`
  setToasts(t => [...t, { id: toastId, text: toastText }])
        setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 4000)

        // pending deduction UI + expected wordmoney
        if (e && typeof e.deducted === 'number') {
          const playerNow = players.find(p => p.id === playerIdTimed) || {}
          const currentHang = Number(playerNow.wordmoney) || 0
          const expectedAfter = currentHang - e.deducted
          expectedHangRef.current[playerIdTimed] = expectedAfter
          setPendingDeducts(prev => ({ ...prev, [playerIdTimed]: (prev[playerIdTimed] || 0) - e.deducted }))
          // Also persist a local hang-history entry and dispatch a local event so
          // PlayerCircle tooltips update immediately to show the -2 deduction.
          try {
            const entry = { ts: Number(e.ts || Date.now()), delta: -Math.abs(Number(e.deducted || 0)), reason: 'timeout', prev: Math.max(0, currentHang) }
            const key = `gh_hang_history_${playerIdTimed}`
            try {
              const existingRaw = localStorage.getItem(key)
              const existing = existingRaw ? JSON.parse(existingRaw) : []
              const next = [entry].concat(Array.isArray(existing) ? existing : []).slice(0,3)
              try { localStorage.setItem(key, JSON.stringify(next)) } catch (e2) {}
            } catch (e2) {}
            try {
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                try { window.dispatchEvent(new CustomEvent('gh_hang_history_update', { detail: { playerId: playerIdTimed, entry } })) } catch (e3) {}
              }
            } catch (e3) {}
          } catch (e3) {}
        }
      })
    } catch (e) {}

    // recent gain events (lastGain) : show once per (player,ts)
  
      players.forEach(p => {
        const lg = p.lastGain
        if (lg && lg.amount && lg.ts) {
          const key = `lg_${p.id}_${lg.ts}`
          if (!multiHitSeenRef.current[key]) {
            multiHitSeenRef.current[key] = true
            // Use a deterministic id based on player and lastGain timestamp to avoid duplicate keys
            const toastId = key
            setToasts(t => [...t, { id: toastId, text: `${p.name} gained +${lg.amount} (${lg.reason === 'wrongGuess' ? 'from wrong guess' : 'bonus'})`, fade: true }])
            // If this is a positive gain and it's from a Double Down power-up, spawn falling coins
            try {
              const amountGain = Number(lg.amount) || 0
              // Normalize reason (e.g. 'doubleDown', 'double_down') to a compact string for comparison
              const reasonNorm = (lg.reason || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '')
              const isDoubleDownGain = reasonNorm === 'doubledown'
              if (amountGain > 0 && isDoubleDownGain) {
                const pieces = new Array(24).fill(0).map(() => ({ left: Math.random() * 100, delay: Math.random() * 0.8, size: 10 + Math.random() * 14 }))
                setDdCoins(pieces)
                // clear after same duration as dd coin animation
                setTimeout(() => setDdCoins([]), 4000)
              }
            } catch (e) { /* swallow debug spawn error */ }
            // start fade at ~7s, remove at 8s for fading toasts
            setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 7000)
            setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 8000)
          }
        }
      })
    

    // generic positive wordmoney deltas (uses prevHangRef to avoid initial-load noise)
    
      players.forEach(p => {
        const pid = p.id
        const prev = typeof prevHangRef.current[pid] === 'number' ? prevHangRef.current[pid] : null
        const nowVal = typeof p.wordmoney === 'number' ? p.wordmoney : 0
        if (prev !== null && nowVal > prev) {
          const delta = nowVal - prev
          // If we recently processed a free-bubble claim for this player, suppress
          // the generic "gained +X" toast so only the claim toast is shown.
          try {
            const sup = processedFbGainSuppressRef.current[pid]
            if (sup && Number(sup.amount) === Number(delta)) {
              // consume suppression marker and skip the generic toast
              delete processedFbGainSuppressRef.current[pid]
            } else {
              const toastId = `gain_${pid}_${Date.now()}`
              setToasts(t => [...t, { id: toastId, text: `${p.name} gained +${delta}`, fade: true }])
              // start fade at ~7s, remove at 8s for fading toasts
              setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 7000)
              setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 8000)
            }
          } catch (e) {
            // fallback: still show generic toast if suppression check fails
            const toastId = `gain_${pid}_${Date.now()}`
            setToasts(t => [...t, { id: toastId, text: `${p.name} gained +${delta}`, fade: true }])
            setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 7000)
            setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 8000)
          }
        }
        prevHangRef.current[pid] = nowVal
      })
  }, [state?.players, state?.timeouts])

  // Watch for room-level Double Down announcements (written by server on resolution)
  useEffect(() => {
    try {
      const dd = state?.lastDoubleDown
      // Debug: log raw dd object when effect runs
      if (!dd || !dd.ts) {
        // still log when undefined to help debugging
        // console output intentionally brief when no dd present
        // console.log('lastDoubleDown effect: no dd or missing ts', dd)
        return
      }
  // compute a stable key even if ts is missing
  // Include success and amount in the key so that an update that overwrites
  // lastDoubleDown with a different result (e.g. failure -> success) will still fire.
  const baseId = dd && (dd.ts || dd.id || dd._id) ? String(dd.ts || dd.id || dd._id) : JSON.stringify({ b: dd && dd.buyerId, t: dd && dd.targetId, l: dd && dd.letter })
  const key = `${baseId}|s:${dd.success ? 1 : 0}|a:${typeof dd.amount !== 'undefined' ? dd.amount : (typeof dd.stake !== 'undefined' ? dd.stake : '')}`
  console.log('lastDoubleDown effect: received', { key, dd, processedBefore: !!processedDoubleDownRef.current[key] })
  if (processedDoubleDownRef.current[key]) return
  processedDoubleDownRef.current[key] = true

      const buyer = dd.buyerName || playerIdToName[dd.buyerId] || dd.buyerId || 'Someone'
      const target = dd.targetName || playerIdToName[dd.targetId] || dd.targetId || 'a player'
      const letter = dd.letter || ''
      const stake = typeof dd.stake === 'number' ? dd.stake : (typeof dd.amount === 'number' ? dd.amount : 0)

      if (dd.success) {
        console.log('lastDoubleDown: success path for', { buyer, target, letter, stake })
        // success: show long green toast with two lines and spawn falling coins
        const id = `dd_success_${key}`
        const main = `${buyer} wins the double down of letter ${letter ? `'${letter}'` : ''} on ${target}!`
        const sub = `(They earned +2 per correct letter and 2× their stake of ${stake})`
        const node = (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontWeight: 800 }}>{main}</div>
            <div style={{ fontSize: 12, opacity: 0.95 }}>{sub}</div>
          </div>
        )
        // show toast for at least 10s
        setToasts(t => [...t, { id, node, success: true }])
        // auto-hide after 10s (start fade at 9s)
        setTimeout(() => setToasts(t => t.map(x => x.id === id ? { ...x, removing: true } : x)), 9500)
        setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 10500)

        // spawn coin pieces for ~4s (brief animation visible to everyone)
        const pieces = new Array(24).fill(0).map(() => ({ left: Math.random() * 100, delay: Math.random() * 0.8, size: 10 + Math.random() * 14 }))
        console.log('lastDoubleDown: spawning ddCoins', pieces.length, pieces)
        setDdCoins(pieces)
        setTimeout(() => setDdCoins([]), 4000)
      } else {
        console.log('lastDoubleDown: failure path', { buyer, target, stake, dd })
        // failure: short red toast indicating stake lost (no coins)
        const id = `dd_fail_${key}`
        const msg = `${buyer} did not win the double down; lost stake of $${stake}`
        // show the failure toast briefly (no coins) : keep visible ~4s
        setToasts(t => [...t, { id, text: msg, error: true }])
        setTimeout(() => setToasts(t => t.map(x => x.id === id ? { ...x, removing: true } : x)), 3000)
        setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200)
      }
    } catch (e) {
      // swallow errors to avoid breaking other effects
    }
  }, [state?.lastDoubleDown])

  // Watch for ghost re-entry announcements and notify once
  const processedGhostAnnRef = useRef({})
  // close mode info popover on outside click
  useEffect(() => {
    if (!showModeInfo) return undefined
    function onDoc(e) {
      try {
        const root = modeInfoRef && modeInfoRef.current
        // If we don't yet have a ref to the badge element, don't auto-close
        // (it may be in the process of mounting after the click that opened it).
        if (!root) return
        // If the popover was opened very recently (by the same click), ignore this event.
        try {
          const opened = modeInfoOpenedAtRef.current
          if (opened && (Date.now() - opened) < 60) return
        } catch (e) {}
        if (root.contains && root.contains(e.target)) return
        setShowModeInfo(false)
      } catch (err) { setShowModeInfo(false) }
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [showModeInfo])
  useEffect(() => {
    try {
      const anns = state?.ghostAnnouncements || {}
      Object.keys(anns || {}).forEach(k => {
        if (processedGhostAnnRef.current[k]) return
        processedGhostAnnRef.current[k] = true
        const a = anns[k] || {}
        try { setToasts(t => [...t, { id: `ghost_ann_${k}`, text: `${a.name || a.player} has re-entered as a ghost!` }]) } catch (e) {}
        setTimeout(() => setToasts(t => t.filter(x => x.id !== `ghost_ann_${k}`)), 5000)
        // also trigger a full-screen overlay with floating ghost emojis for 5s
        try {
          const name = a && (a.name || a.player) ? (a.name || a.player) : 'Someone'
          setGhostReenterEvents(prev => [...prev, { id: k, name, ts: Date.now() }])
          setTimeout(() => setGhostReenterEvents(prev => prev.filter(x => x.id !== k)), 5000)
        } catch (e) {}
      })
    } catch (e) {}
  }, [state?.ghostAnnouncements])

  // Scheduler & spawner for underworld-themed free bubbles (host schedules only)
  const bubbleTimerRef = useRef(null)
  useEffect(() => {
    let mounted = true
    try {
      // only the host will schedule spawn attempts to reduce duplicated transactions
      if (!isHost) return () => { mounted = false }

      const scheduleNext = () => {
        try {
          // random delay: at least 2 minutes, up to ~5 minutes
          const delay = 120000 + Math.floor(Math.random() * 180000)
          if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
          bubbleTimerRef.current = setTimeout(async () => {
            try {
              if (!mounted) return
              // only spawn during an active playing phase and when enabled in room
              if (!freeBubblesEnabled) { scheduleNext(); return }
              if (state && state.gameMode === 'wordSeeker') { scheduleNext(); return }
              if (phase !== 'playing') { scheduleNext(); return }

              // attempt atomic creation using a transaction on rooms/<roomId>/freeBubble
              const fbRef = dbRef(db, `rooms/${roomId}/freeBubble`)
              const now = Date.now()
              const id = `fb_${now}_${Math.random().toString(36).slice(2,8)}`
              const amount = 2 + Math.floor(Math.random() * 4) // 2..5
              try {
                await runTransaction(fbRef, (curr) => {
                  const n = Date.now()
                  // if an active bubble exists and it's younger than 2 minutes, abort
                  if (curr && curr.spawnedAt && (n - curr.spawnedAt) < 120000) return undefined
                  // otherwise create a new bubble
                  return { id, amount, spawnedAt: n, theme: 'underworld' }
                })
              } catch (e) {
                // ignore transaction failures; we'll schedule the next attempt
              }
            } catch (e) {}
            // schedule next spawn regardless
            try { scheduleNext() } catch (e) {}
          }, delay)
        } catch (e) {}
      }

      // start scheduling when host, enabled and in playing phase
      if (freeBubblesEnabled && phase === 'playing' && state && state.gameMode !== 'wordSeeker') scheduleNext()
    } catch (e) {}
    return () => { mounted = false; try { if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current) } catch (e) {} }
  }, [isHost, freeBubblesEnabled, phase, state && state.gameMode, roomId])

  // Handle claims and show toasts when a free bubble is created or claimed
  useEffect(() => {
    try {
      const fb = state?.freeBubble || null
      if (!fb) return
      const id = fb.id || `fb_${fb.spawnedAt || Date.now()}`
      // dedupe: if we've already processed this bubble id, skip creating another toast
      if (processedFreeBubbleRef.current[id]) return
      processedFreeBubbleRef.current[id] = true
      // show a toast when bubble appears
      try {
        const text = fb && fb.amount ? `Underworld bubble: +${fb.amount} wordmoney (first click claims)` : 'A free bubble appeared!'
        const toastId = `free_bubble_${id}`
        setToasts(t => [...t, { id: toastId, text, fade: true }])
        // start fade at ~7s, remove at 8s so the toast visibly fades out
        setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 7000)
        setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 8000)
      } catch (e) {}

      // Schedule an automatic bot claim when possible. Choose the fastest available bot difficulty
      try {
        // Clear any stale timer for this bubble id
        try { if (freeBubbleAutoClaimTimersRef.current[id]) { clearTimeout(freeBubbleAutoClaimTimersRef.current[id]); delete freeBubbleAutoClaimTimersRef.current[id] } } catch (e) {}
        const playersList = Array.isArray(state?.players) ? state.players.slice() : []
        const bots = playersList.filter(p => p && p.isBot && !p.eliminated)
        if (bots && bots.length > 0) {
          // group by difficulty
          const byDiff = { hard: [], medium: [], easy: [] }
          bots.forEach(b => {
            try {
              const d = (b.botSettings && b.botSettings.difficulty) ? (''+b.botSettings.difficulty).toLowerCase() : 'medium'
              if (!byDiff[d]) byDiff[d] = []
              byDiff[d].push(b)
            } catch (e) {}
          })
          // prefer hard -> medium -> easy (fastest claims win)
          let chosenBucket = null
          if ((byDiff.hard || []).length > 0) chosenBucket = 'hard'
          else if ((byDiff.medium || []).length > 0) chosenBucket = 'medium'
          else if ((byDiff.easy || []).length > 0) chosenBucket = 'easy'
          if (chosenBucket) {
            const delays = { hard: 2000, medium: 4000, easy: 10000 }
            const delayMs = delays[chosenBucket] || 4000
            const candidates = byDiff[chosenBucket] || []
            // pick a random bot among same-difficulty bots
            const pick = candidates[Math.floor(Math.random() * candidates.length)]
            if (pick && pick.id) {
              // schedule the claim; ensure we re-check bubble state at claim time
              const t = setTimeout(async () => {
                try {
                  const roomRef = dbRef(db, `rooms/${roomId}`)
                  // Attempt atomic claim via transaction similar to human claim
                  const fbRef = dbRef(db, `rooms/${roomId}/freeBubble`)
                  try {
                    const res = await runTransaction(fbRef, (curr) => {
                      if (!curr) return
                      if (curr.claimedBy) return
                      return { ...curr, claimedBy: pick.id, claimedAt: Date.now() }
                    }, { applyLocally: false })
                    if (!res || !res.committed) return
                    const val = res.snapshot && typeof res.snapshot.val === 'function' ? res.snapshot.val() : (res && res.val) || {}
                    if (!val || val.claimedBy !== pick.id) return
                    const amount = Number(val.amount || 0)
                    const updates = {}
                    const roomSnap = (state || {})
                    // award to team or player depending on game mode
                    if (roomSnap && roomSnap.gameMode === 'lastTeamStanding') {
                      const botNode = (roomSnap.players || []).find(p => p.id === pick.id) || {}
                      if (botNode && botNode.team) {
                        const teamKey = `teams/${botNode.team}/wordmoney`
                        const currTeam = Number(roomSnap?.teams?.[botNode.team]?.wordmoney || 0)
                        updates[teamKey] = Math.max(0, currTeam + amount)
                      } else {
                        const playerKey = `players/${pick.id}/wordmoney`
                        const currPlayer = Number((roomSnap.players || []).find(p => p.id === pick.id)?.wordmoney || 0)
                        updates[playerKey] = Math.max(0, currPlayer + amount)
                      }
                    } else {
                      const playerKey = `players/${pick.id}/wordmoney`
                      const currPlayer = Number((state?.players || []).find(p => p.id === pick.id)?.wordmoney || 0)
                      updates[playerKey] = Math.max(0, currPlayer + amount)
                    }
                    // clear bubble and create announcement
                    const claimKey = `fb_claim_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
                    const ann = { by: pick.id, name: (playerIdToName && playerIdToName[pick.id]) ? playerIdToName[pick.id] : pick.name || pick.id, amount, ts: Date.now() }
                    updates[`freeBubble`] = null
                    updates[`freeBubbleClaims/${claimKey}`] = ann
                    try { await dbUpdate(roomRef, updates) } catch (e) { try { if (roomRef && typeof roomRef.update === 'function') await roomRef.update(updates) } catch (ee) {} }
                    // schedule removal of announcement
                    setTimeout(async () => { try { await dbUpdate(roomRef, { [`freeBubbleClaims/${claimKey}`]: null }) } catch (e) {} }, 7000)
                  } catch (e) { /* transaction failed or already claimed */ }
                } catch (e) { console.warn('auto-claim timer handler failed', e) }
                // cleanup timer ref
                try { delete freeBubbleAutoClaimTimersRef.current[id] } catch (e) {}
              }, delayMs)
              freeBubbleAutoClaimTimersRef.current[id] = t
            }
          }
        }
      } catch (e) {}
      // claiming is handled via a short-lived announcement node (`freeBubbleClaims`) so
      // the bubble itself can be cleared immediately for everyone while clients show who claimed it.
    } catch (e) {}
  }, [state?.freeBubble])

  // Process submit-auto-assigned announcements (so clients show a fading toast)
  const processedAutoAssignRef = useRef({})
  useEffect(() => {
    try {
      const anns = state?.submitAutoAssigned || {}
      Object.keys(anns || {}).forEach(k => {
        if (processedAutoAssignRef.current[k]) return
        processedAutoAssignRef.current[k] = true
        const a = anns[k] || {}
        try {
          const name = a.name || a.player || 'Someone'
          const text = `${name} didn't choose a word on time, was assigned a random word and lost ${a.penalty || 2} wordmoney.`
          const id = `auto_assign_${k}`
          setToasts(t => [...t, { id, text, fade: true }])
          // keep fading toasts visible for 8s
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 8000)
        } catch (e) {}
        // attempt to remove announcement from DB
        try { const roomRef = dbRef(db, `rooms/${roomId}`); dbUpdate(roomRef, { [`submitAutoAssigned/${k}`]: null }).catch(() => {}) } catch (e) {}
      })
    } catch (e) {}
  }, [state?.submitAutoAssigned])

  // processed ref for free bubble claim announcements
  const processedFbClaimRef = useRef({})
  // suppress the generic "gained +X" toast when we just showed a free-bubble claim toast
  // keyed by player id -> { amount, ts }
  const processedFbGainSuppressRef = useRef({})
  // Watch for freeBubbleClaims announcements and show a fading toast indicating who claimed it.
  useEffect(() => {
    try {
      const claims = state?.freeBubbleClaims || {}
      Object.keys(claims || {}).forEach(k => {
        if (processedFbClaimRef.current[k]) return
        processedFbClaimRef.current[k] = true
        const c = claims[k] || {}
        try {
          const name = c.name || c.by || 'Someone'
          const text = `${name} claimed the underworld tombstone (+${c.amount || 0})`
          const id = `free_bubble_claim_${k}`
          setToasts(t => [...t, { id, text, fade: true }])
          // Suppress the generic per-player "gained +X" toast that would come from
          // the wordmoney delta caused by this claim. Store a short-lived marker
          // keyed by the player id (c.by) with the claimed amount so the next
          // generic gain toast can be skipped.
          try {
            const claimantId = c.by || null
            if (claimantId) processedFbGainSuppressRef.current[claimantId] = { amount: Number(c.amount || 0), ts: Date.now() }
          } catch (e) {}
          // keep fading toasts visible for 8s
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 8000)
        } catch (e) {}
        // attempt to remove the announcement so it doesn't persist in DB
        try {
          const roomRef = dbRef(db, `rooms/${roomId}`)
          dbUpdate(roomRef, { [`freeBubbleClaims/${k}`]: null }).catch(() => {})
        } catch (e) {}
      })
    } catch (e) {}
  }, [state?.freeBubbleClaims])

  // Clear any pending auto-claim timers when the bubble is removed or claimed by a human
  useEffect(() => {
    try {
      const fb = state?.freeBubble || null
      // if no bubble exists or it's already claimed, clear any scheduled timers
      if (!fb || fb.claimedBy) {
        try {
          const keys = Object.keys(freeBubbleAutoClaimTimersRef.current || {})
          keys.forEach(k => { try { clearTimeout(freeBubbleAutoClaimTimersRef.current[k]) } catch (e) {} })
          freeBubbleAutoClaimTimersRef.current = {}
        } catch (e) {}
      }
    } catch (e) {}
  }, [state?.freeBubble])

  // cleanup on unmount: clear any remaining auto-claim timers
  useEffect(() => {
    return () => {
      try {
        const keys = Object.keys(freeBubbleAutoClaimTimersRef.current || {})
        keys.forEach(k => { try { clearTimeout(freeBubbleAutoClaimTimersRef.current[k]) } catch (e) {} })
        freeBubbleAutoClaimTimersRef.current = {}
      } catch (e) {}
    }
  }, [])

  // Watch for host start-block announcements and show a fading toast once
  const processedStartAnnRef = useRef({})
  useEffect(() => {
    try {
      const anns = state?.startBlockedAnnouncements || {}
      Object.keys(anns || {}).forEach(k => {
        if (processedStartAnnRef.current[k]) return
        processedStartAnnRef.current[k] = true
        const a = anns[k] || {}
        try {
          const text = a && a.message ? (a.name ? `${a.name}: ${a.message}` : a.message) : 'Host attempted to start but could not.'
          const id = `start_block_${k}`
          setToasts(t => [...t, { id, text, fade: true }])
          // keep fading toasts visible for 8s
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 8000)
        } catch (e) {}
      })
    } catch (e) {}
  }, [state?.startBlockedAnnouncements])

  // processed ref for bot-skip announcements
  const processedBotSkipRef = useRef({})
  useEffect(() => {
    try {
      const anns = state?.botSkipAnnouncements || {}
      Object.keys(anns || {}).forEach(k => {
        if (processedBotSkipRef.current[k]) return
        processedBotSkipRef.current[k] = true
        const a = anns[k] || {}
        try {
          const name = a.name || a.by || 'A bot'
          const text = `${name} skipped their turn (no valid targets)`
          const id = `bot_skip_${k}`
          setToasts(t => [...t, { id, text, fade: true }])
          // keep fading toasts visible for 6s
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000)
        } catch (e) {}
        // attempt to remove announcement so it doesn't persist
        try {
          const roomRef = dbRef(db, `rooms/${roomId}`)
          dbUpdate(roomRef, { [`botSkipAnnouncements/${k}`]: null }).catch(() => {})
        } catch (e) {}
      })
    } catch (e) {}
  }, [state?.botSkipAnnouncements])

  // Watch for setting change announcements and show a fading toast to all clients
  // except the host (host doesn't need the notification since they initiated it).
  const processedSettingChangeRef = useRef({})
  useEffect(() => {
    try {
      const anns = state?.settingChangeAnnouncements || {}
      Object.keys(anns || {}).forEach(k => {
        if (processedSettingChangeRef.current[k]) return
        processedSettingChangeRef.current[k] = true
        const a = anns[k] || {}
        try {
          const text = a && a.text ? a.text : 'Room settings were changed'
          const id = `setting_change_${k}`
          // don't show this toast to the host
          if (myId && hostId && myId === hostId) {
            // still attempt to remove the announcement from DB
          } else {
            setToasts(t => [...t, { id, text, fade: true }])
            setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 8000)
          }
        } catch (e) {}
        // attempt to remove announcement from DB
        try { const roomRef = dbRef(db, `rooms/${roomId}`); dbUpdate(roomRef, { [`settingChangeAnnouncements/${k}`]: null }).catch(() => {}) } catch (e) {}
      })
    } catch (e) {}
  }, [state?.settingChangeAnnouncements, myId, hostId])

  // When the room enters the submit phase, announce that chat was minimized so players
  // can focus on entering a word. The host will write the announcement to DB and
  // all clients will show a fading toast when they process it.
  const prevPhaseRef = useRef(null)
  useEffect(() => {
    try {
      const prev = prevPhaseRef.current
      if (phase === 'submit' && prev !== 'submit') {
        // only the host writes the DB announcement to reduce duplicate writes
        try {
          if (isHost) {
            const roomRef = dbRef(db, `rooms/${roomId}`)
            const key = `cm_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
            const text = 'Underworld hush: chat minimized so you can enter a word 👻'
            const ann = { id: key, text, ts: Date.now(), by: myId || null }
            const ups = {}
            ups[`chatMinimizedAnnouncements/${key}`] = ann
            try { dbUpdate(roomRef, ups).catch(() => {}) } catch (e) {}
            // schedule removal after a short interval
            setTimeout(() => { try { dbUpdate(roomRef, { [`chatMinimizedAnnouncements/${key}`]: null }).catch(() => {}) } catch (e) {} }, 7000)
          }
        } catch (e) {}
        // NOTE: host writes the announcement to DB above; clients (including host)
        // will process the DB-written announcement and show a single toast. Do not
        // also create an immediate local toast here to avoid duplicate toasts.
      }
      prevPhaseRef.current = phase
    } catch (e) {}
  }, [phase, isHost, roomId, myId])

  // Process chat-minimized announcements written to DB so all clients display a fading toast
  const processedChatMinRef = useRef({})
  useEffect(() => {
    try {
      const anns = state?.chatMinimizedAnnouncements || {}
      Object.keys(anns || {}).forEach(k => {
        if (processedChatMinRef.current[k]) return
        processedChatMinRef.current[k] = true
        const a = anns[k] || {}
        try {
          const text = a && a.text ? a.text : 'Chat minimized for submission phase'
          const id = `chat_min_${k}`
          setToasts(t => [...t, { id, text, fade: true }])
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 8000)
        } catch (e) {}
        // attempt to remove the announcement from DB
        try { const roomRef = dbRef(db, `rooms/${roomId}`); dbUpdate(roomRef, { [`chatMinimizedAnnouncements/${k}`]: null }).catch(() => {}) } catch (e) {}
      })
    } catch (e) {}
  }, [state?.chatMinimizedAnnouncements])

  // Debug: log when ddCoins changes so we can confirm pieces were created and the overlay should render
  useEffect(() => {
    try {
      // ddCoins state changed : overlay rendering handled elsewhere. Keep console quiet in production.
    } catch (e) {}
  }, [ddCoins])

  // Expose debug helpers on window so you can test from the browser console
  useEffect(() => {
    try {
      // fetch raw lastDoubleDown from the DB
      window.fetchLastDoubleDown = async () => {
        try {
          const snap = await dbGet(dbRef(db, `rooms/${roomId}/lastDoubleDown`))
          console.log('DB lastDoubleDown:', snap.val())
          return snap.val()
        } catch (e) { console.warn('fetchLastDoubleDown failed', e); throw e }
      }
      // simulate coins locally (exposes existing simulateDoubleDown if available)
      window.simulateDoubleDown = () => {
        try {
          if (typeof simulateDoubleDown === 'function') simulateDoubleDown()
          else console.warn('simulateDoubleDown not available')
        } catch (e) { console.warn('simulateDoubleDown failed', e) }
      }
    } catch (e) {}
    return () => {
      try { delete window.fetchLastDoubleDown } catch (e) {}
      try { delete window.simulateDoubleDown } catch (e) {}
    }
  }, [roomId, simulateDoubleDown])

  // inject CSS for ghost re-enter overlay and animations once
  useEffect(() => {
    try {
      const id = 'gh-ghost-overlay-style'
      if (!document.getElementById(id)) {
        const s = document.createElement('style')
        s.id = id
        s.innerHTML = `
          .ghost-reenter-overlay { position: fixed; left: 0; top: 0; right: 0; bottom: 0; pointer-events: none; display: flex; align-items: center; justify-content: center; z-index: 12000 }
          .ghost-reenter-card { pointer-events: auto; background: rgba(0,0,0,0.6); color: #fff; padding: 18px 26px; border-radius: 12px; font-weight: 800; font-size: 20px; backdrop-filter: blur(4px); }
          .ghost-floating { position: absolute; left: 0; right: 0; top: 30%; bottom: 0; pointer-events: none; overflow: visible }
          .ghost-floating .ghost-emoji { position: absolute; top: 60%; font-size: 28px; transform: translateY(0) scale(1); opacity: 0; animation-name: ghFloatUp; animation-duration: 4s; animation-timing-function: cubic-bezier(.2,.8,.2,1); }
          @keyframes ghFloatUp { 0% { transform: translateY(0) scale(0.9); opacity: 0 } 10% { opacity: 1 } 100% { transform: translateY(-60vh) scale(1.1); opacity: 0 } }
        `
        document.head.appendChild(s)
      }
    } catch (e) {}
  }, [])

    // inject CSS for free-bubble tombstone visuals once
    useEffect(() => {
      try {
        const id = 'gh-tombstone-style'
        if (!document.getElementById(id)) {
          const s = document.createElement('style')
          s.id = id
          s.innerHTML = `
            .free-bubble-tombstone { display: inline-flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 14px; cursor: pointer; box-shadow: 0 10px 30px rgba(0,0,0,0.6); color: #fff; background: linear-gradient(180deg,#7f7f7f,#333); border: 1px solid rgba(0,0,0,0.2); pointer-events: auto; }
            /* Tombstone rounded top and flat base using extra element */
            .free-bubble-tombstone.tombstone { border-radius: 18px 18px 8px 8px; background: linear-gradient(180deg,#8a8a8a,#3a3a3a); }
            .free-bubble-tombstone .tomb-icon { font-size: 22px; display: inline-block; }
            .free-bubble-tombstone .tomb-body { display:flex; flex-direction: column; align-items: flex-start }
            .free-bubble-tombstone .tomb-amount { font-size: 14px; line-height: 1; font-weight: 800 }
            .free-bubble-tombstone .tomb-sub { font-size: 11px; color: #d7d7d7 }
            .free-bubble-tombstone.disabled { opacity: 0.65; cursor: not-allowed }
            /* subtle beveled highlight */
            .free-bubble-tombstone:after { content: ''; position: absolute; left: 0; right: 0; height: 6px; top: 0; border-top-left-radius: 18px; border-top-right-radius: 18px; pointer-events: none; mix-blend-mode: overlay; }
          `
          document.head.appendChild(s)
        }
      } catch (e) {}
    }, [])

  // clear pending deductions when we observe the DB has applied the wordmoney change
  useEffect(() => {
    if (!state || !state.players) return
    const updated = { ...pendingDeducts }
    let changed = false
    Object.keys(expectedHangRef.current || {}).forEach(pid => {
      const expected = expectedHangRef.current[pid]
      const p = (state.players || []).find(x => x.id === pid)
      if (!p) return
      const actual = Number(p.wordmoney) || 0
      // once actual is less-than-or-equal-to expected, consider the deduction persisted
      if (actual <= expected) {
        if (typeof updated[pid] !== 'undefined') {
          delete updated[pid]
          changed = true
        }
        delete expectedHangRef.current[pid]
      }
    })
    if (changed) setPendingDeducts(updated)
  }, [state?.players])

  
  // derive some end-of-game values and visual pieces at top-level so hooks are not called conditionally
  // derive viewer name from server state if available (covers refresh cases)
  const myNode = (state?.players || []).find(p => p.id === myId) || {}
  const myName = myNode.name || playerName
  // consider the viewer a winner if the room's winnerId matches their id
  // also consider team wins: when winnerTeam is set, all players on that team are winners
  const isWinner = (state?.winnerTeam ? (myNode && myNode.team && state.winnerTeam && myNode.team === state.winnerTeam) : (state?.winnerId && myId && state.winnerId === myId))
  // friendly label for winner (player or team)
  const winnerLabel = state?.winnerTeam ? (state.winnerTeam.charAt(0).toUpperCase() + state.winnerTeam.slice(1) + ' Team') : (playerIdToName[state?.winnerId] || state?.winnerName || state?.winnerId)
  // compute standings:
  // - if winnerByWordmoney is true, sort by wordmoney desc
  // - otherwise (last-one-standing), order by elimination: winner first, then players
  //   who were eliminated most recently, with the earliest-eliminated placed last.
  let standings = (state?.players || []).slice()
  try {
    if (state && state.winnerByWordmoney) {
      standings.sort((a,b) => (b.wordmoney || 0) - (a.wordmoney || 0))
    } else {
      // last-one-standing: derive order using eliminatedAt timestamps
      // winner should be first
      const winnerIdLocal = state && state.winnerId ? state.winnerId : null
      standings.sort((a,b) => {
        // winner first
        if (a.id === winnerIdLocal && b.id !== winnerIdLocal) return -1
        if (b.id === winnerIdLocal && a.id !== winnerIdLocal) return 1
        // survivors (not eliminated) come before eliminated players (but winner handling above)
        const aElim = !!a.eliminated
        const bElim = !!b.eliminated
        if (aElim !== bElim) return aElim ? 1 : -1
        // both eliminated or both active: sort by eliminatedAt desc so that most recently eliminated appears higher
        const aTs = a.eliminatedAt ? Number(a.eliminatedAt) : 0
        const bTs = b.eliminatedAt ? Number(b.eliminatedAt) : 0
        // newer timestamps first
        return bTs - aTs
      })
    }
  } catch (e) {
    // fallback: wordmoney desc
    standings.sort((a,b) => (b.wordmoney || 0) - (a.wordmoney || 0))
  }

  // defensive: ensure standings are valid objects before rendering (prevents invalid element type errors)
  const sanitizedStandings = (standings || []).filter(p => p && typeof p === 'object' && (p.id || p.name))
  if (sanitizedStandings.length !== (standings || []).length) {
    try { console.warn('GameRoom: filtered invalid entries from standings before rendering end screen', { rawStandings: standings, stateSnapshot: state }) } catch (e) {}
  }

  const confettiPieces = useMemo(() => {
    // Show confetti when either the viewer is a winner or the room ended with a team winner.
    if (!isWinner && !state?.winnerTeam) return []
    // Use team-colored palettes when a team won, otherwise fall back to celebratory mixed colors
    const team = state?.winnerTeam || null
    let colors = ['#FFABAB','#FFD54F','#B39DDB','#81D4FA','#C5E1A5','#F8BBD0','#B2EBF2']
    if (team === 'red') colors = ['#ff8a80','#ff5252','#ff1744','#ff4081','#ff9e80']
    else if (team === 'blue') colors = ['#82b1ff','#448aff','#2979ff','#40c4ff','#81d4fa']
    return new Array(48).fill(0).map(() => ({
      left: Math.random() * 100,
      // stagger delays up to ~1.6s so pieces reach bottom at different times
      delay: Math.random() * 1.6,
      size: 6 + Math.random() * 12,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotate: Math.random() * 360
    }))
  }, [isWinner])

  const cashPieces = useMemo(() => {
    if (!state?.winnerByWordmoney) return []
    return new Array(28).fill(0).map(() => ({
      left: Math.random() * 100,
      // stagger delays up to ~1.6s like confetti
      delay: Math.random() * 1.6,
      rotate: Math.random() * 360,
      // start slightly above the top using vh so viewport-relative
      topVh: -2 - (Math.random() * 6)
    }))
  }, [state?.winnerByWordmoney])

  // When a team wins, tint the page background to the team's color instead of rendering a
  // high z-index overlay. Clean up on unmount or when the winner changes.
  useEffect(() => {
    try {
      const prev = document.body.style.background || ''
      if (phase === 'ended' && state && state.winnerTeam) {
        const wt = state.winnerTeam
        const teamColor = wt === 'red' ? '255,77,79' : (wt === 'blue' ? '24,144,255' : '136,136,136')
        document.body.style.background = `linear-gradient(180deg, rgba(${teamColor},0.92), rgba(0,0,0,0.55))`
      } else {
        // restore previous background when not in a team-winner end-screen
        document.body.style.background = prev
      }
      return () => { try { document.body.style.background = prev } catch (e) {} }
    } catch (e) { /* ignore */ }
  }, [phase, state && state.winnerTeam])

  

  function ModeBadge({ fixed = true }) {
    // Hide the ModeBadge entirely on the end screen
    if (phase === 'ended') return null

    // outer container uses fixed positioning on wide screens, static flow when inline
    // use a normal zIndex so the badge doesn't block or overlay other UI unexpectedly
    const outerStyle = fixed ? { position: 'fixed', right: 18, top: 18, zIndex: 'auto', pointerEvents: 'none' } : { position: 'static', right: 'auto', top: 'auto', zIndex: 'auto', pointerEvents: 'none' }
    // If minimized, render a compact badge with an expand control
    if (modeBadgeMinimized) {
      return (
        <div style={outerStyle}>
          <div className="mode-badge card" style={{ pointerEvents: 'auto', padding: '6px 8px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid rgba(34,139,34,0.08)' }}>
            <span style={{ fontSize: 16 }}>{state?.gameMode === 'wordSeeker' ? '🕵️' : (state?.gameMode === 'lastTeamStanding' ? '👥' : (state?.winnerByWordmoney ? '💸' : '🛡️'))}</span>
            <button
              title="Expand"
              aria-label="Expand mode badge"
              onMouseDown={(e) => { try { e.preventDefault(); e.stopPropagation(); setModeBadgeMinimized(false) } catch (err) {} }}
              onTouchStart={(e) => { try { e.preventDefault(); e.stopPropagation(); setModeBadgeMinimized(false) } catch (err) {} }}
              onClick={() => setModeBadgeMinimized(false)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
            >▸</button>
          </div>
        </div>
      )
    }

    return (
      <div style={outerStyle}>
        <div ref={modeInfoRef} className="mode-badge card" style={{ pointerEvents: 'auto', padding: '6px 10px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid rgba(34,139,34,0.12)' }}>
          <span style={{ fontSize: 16 }}>{state?.gameMode === 'wordSeeker' ? '🕵️' : (state?.gameMode === 'lastTeamStanding' ? '👥' : (state?.winnerByWordmoney ? '💸' : '🛡️'))}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: '1' }}>
              <strong style={{ fontSize: 13 }}>
                {(state?.gameMode === 'wordSeeker') ? 'Word Seeker'
                  : (state?.gameMode === 'money' || state?.winnerByWordmoney) ? 'Winner: Most wordmoney'
                  : (state?.gameMode === 'lastTeamStanding') ? 'Winner: Last team standing'
                  : 'Winner: Last one standing'}
              </strong>
              <small style={{ color: '#B4A3A3', fontSize: 12 }}>
                {(state?.gameMode === 'wordSeeker') ? 'Word Seeker mode'
                  : (state?.gameMode === 'money' || state?.winnerByWordmoney) ? 'Mo$t wordmoney win$'
                  : (state?.gameMode === 'lastTeamStanding') ? (state?.firstWordWins ? 'First word guessed wins' : 'Eliminate all players on the other team to win')
                  : 'Last person alive wins'}
              </small>
            </div>
            {/* show a rocket badge when curses/power-ups are enabled (defaults to true) and visible to all players in the lobby */}
            {powerUpsEnabled && phase === 'lobby' && (
              <div title="Curses are enabled" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="powerup-rocket" style={{ fontSize: 18 }}>🕯️</span>
                <small style={{ color: '#B4A3A3', fontSize: 12 }}>Curses</small>
              </div>
            )}
            {/* Minimize control */}
            <button
              title="Minimize"
              aria-label="Minimize mode badge"
              onMouseDown={(e) => { try { e.preventDefault(); e.stopPropagation(); setModeBadgeMinimized(true) } catch (err) {} }}
              onTouchStart={(e) => { try { e.preventDefault(); e.stopPropagation(); setModeBadgeMinimized(true) } catch (err) {} }}
              onClick={() => setModeBadgeMinimized(true)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
            >▾</button>
            {/* Info icon to show mode-specific details */}
            <button
              title="Game info"
              aria-label="Game info"
              onMouseDown={(e) => { try { e.preventDefault(); e.stopPropagation(); if (!showModeInfo) modeInfoOpenedAtRef.current = Date.now(); setShowModeInfo(s => !s) } catch (err) {} }}
              onTouchStart={(e) => { try { e.preventDefault(); e.stopPropagation(); if (!showModeInfo) modeInfoOpenedAtRef.current = Date.now(); setShowModeInfo(s => !s) } catch (err) {} }}
              onClick={(e) => { try { console.log('ModeBadge info clicked (wasOpen=', showModeInfo, ')') } catch (e) {} try { if (!showModeInfo) modeInfoOpenedAtRef.current = Date.now() } catch (er) {} setShowModeInfo(s => !s) }}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}
            >ℹ️</button>
            {showModeInfo && (() => {
              // Render the info popover via a portal to avoid being blocked by player tiles
              const node = (
                <div style={{ position: 'absolute', right: 18, top: 60, zIndex: 12002 }}>
                  <div className="mode-info-card card" style={{ pointerEvents: 'auto', padding: 12, maxWidth: 320 }}>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Game info</div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}><strong>Reveal letters based on occurrence in word:</strong> {(typeof revealPreserveOrder !== 'undefined') ? (!revealPreserveOrder ? 'Yes' : 'No') : 'Unknown'}</div>
                    {state?.gameMode === 'lastTeamStanding' ? (
                      <div style={{ fontSize: 13, marginBottom: 6 }}><strong>First word guessed wins:</strong> {(typeof state?.firstWordWins !== 'undefined') ? (state.firstWordWins ? 'Yes' : 'No') : (firstWordWins ? 'Yes' : 'No')}</div>
                    ) : null}
                    <div style={{ fontSize: 13, marginBottom: 6 }}><strong>Ghost re-entry enabled:</strong> {(typeof state?.ghostReEntryEnabled !== 'undefined') ? (state.ghostReEntryEnabled ? 'Yes' : 'No') : (ghostReEntryEnabled ? 'Yes' : 'No')}</div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>
                      <strong>Free wordmoney tombstones:</strong>
                      {(typeof state?.freeBubblesEnabled !== 'undefined')
                        ? (state.freeBubblesEnabled ? ' Enabled' : ' Disabled')
                        : (typeof freeBubblesEnabled !== 'undefined' ? (freeBubblesEnabled ? ' Enabled' : ' Disabled') : ' Unknown')}
                    </div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>
                      <strong>Secret-word theme:</strong>
                      {secretThemeEnabled ? (
                        <div style={{ display: 'inline-block', marginLeft: 8 }}><ThemeBadge type={secretThemeType} /></div>
                      ) : (
                        <span style={{ marginLeft: 8, color: '#888' }}>None</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#888' }}>Click the info icon again to close.</div>
                  </div>
                </div>
              )
              try {
                if (modalRoot && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) return ReactDOM.createPortal(node, modalRoot)
              } catch (e) {}
              return node
            })()}
            {isHost && phase === 'lobby' && (
              <button
                title="Room settings"
                aria-label="Room settings"
                onMouseDown={(e) => { try { e.preventDefault(); e.stopPropagation(); setShowSettings(true) } catch (err) {} }}
                onTouchStart={(e) => { try { e.preventDefault(); e.stopPropagation(); setShowSettings(true) } catch (err) {} }}
                onClick={() => setShowSettings(true)}
                style={{ background: 'transparent', border: 'none', fontSize: 18, cursor: 'pointer' }}
              >⚙️</button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Debug helper: simulate a successful double-down (visible when ?debugDD=1 is in the URL)
  const showDebugDD = typeof window !== 'undefined' && /[?&]debugDD=1\b/.test(window.location.search)
  function simulateDoubleDown() {
    try {
      const buyer = (myName || 'You')
      const target = 'Someone'
      const stake = 3
      const letter = 'x'
      const id = `dd_debug_${Date.now()}`
      const main = `${buyer} wins the double down of letter '${letter}' on ${target}!`
      const sub = `(Simulated) They earned +2 per correct letter and 2× their stake of ${stake}`
      const node = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontWeight: 800 }}>{main}</div>
          <div style={{ fontSize: 12, opacity: 0.95 }}>{sub}</div>
        </div>
      )
      setToasts(t => [...t, { id, node, success: true }])
      setTimeout(() => setToasts(t => t.map(x => x.id === id ? { ...x, removing: true } : x)), 9500)
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 10500)
  const pieces = new Array(24).fill(0).map(() => ({ left: Math.random() * 100, delay: Math.random() * 0.8, size: 10 + Math.random() * 14 }))
      setDdCoins(pieces)
      setTimeout(() => setDdCoins([]), 4000)
    } catch (e) { console.warn('simulateDoubleDown failed', e) }
  }

  // Persist various room-level settings
  async function updateRoomSettings(changes) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      // Ensure startingWordmoney is persisted as a Number (avoid storing numeric strings)
      const safe = { ...changes }
      try {
        if (typeof safe.startingWordmoney !== 'undefined') {
          const n = Number(safe.startingWordmoney)
          safe.startingWordmoney = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
        }
      } catch (e) {}
      // If the mode is being changed to lastTeamStanding and firstWordWins is unset,
      // initialize it to false for sensible default behaviour.
      try {
        if (safe.gameMode === 'lastTeamStanding') {
          if (typeof (state && state.firstWordWins) === 'undefined' || state.firstWordWins === null) {
            safe.firstWordWins = false
          }
        }
      } catch (e) {}
      // Build multi-path updates: include the requested safe changes, reset ready for all
      // non-host players, and write a short-lived announcement so clients show a toast.
      const updates = { ...safe }
      try {
        const pl = Array.isArray(state?.players) ? state.players.slice() : []
        pl.forEach(p => {
          try {
            if (!p || !p.id) return
            // Never clear the host's ready flag.
            if (p.id === hostId) return
            // Keep bots always ready: do not clear ready for bot players on settings update
            if (p.isBot) return
            updates[`players/${p.id}/ready`] = null
          } catch (e) {}
        })
      } catch (e) {}

      // Create a concise human-readable description of the change
      try {
        const keys = Object.keys(safe || {})
        let text = 'Room settings updated'
        if (keys.length === 1) {
          const k = keys[0]
          const v = safe[k]
          if (k === 'submitTimerEnabled') text = `Submit timer ${v ? 'enabled' : 'disabled'}`
          else if (k === 'submitTimerSeconds') text = `Submit timer set to ${v}s`
          else if (k === 'freeBubblesEnabled') text = `Free bubbles ${v ? 'enabled' : 'disabled'}`
          else if (k === 'timed') text = `Timed mode ${v ? 'enabled' : 'disabled'}`
          else if (k === 'turnTimeoutSeconds') text = `Turn timeout set to ${v || 'unset'}`
          else if (k === 'gameMode') text = `Game mode set to ${v}`
          else text = `Updated ${k}`
        } else if (keys.length > 1) {
          text = 'Room settings updated'
        }
        const annKey = `sc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
        updates[`settingChangeAnnouncements/${annKey}`] = { id: annKey, text, ts: Date.now(), by: myId || null }
        // schedule removal of the announcement
        setTimeout(async () => {
          try { await dbUpdate(roomRef, { [`settingChangeAnnouncements/${annKey}`]: null }) } catch (e) {}
        }, 7000)
      } catch (e) {}

      // Instrumentation: log what we're about to write so we can debug unexpected toggles
      try { console.log('updateRoomSettings: writing updates', updates) } catch (e) {}
      try {
        await safeDbUpdate(roomRef, updates)
        try { console.log('updateRoomSettings: write succeeded') } catch (e) {}
      } catch (writeErr) {
        console.warn('updateRoomSettings: write failed', writeErr)
        // Surface a toast to the host so they see the failure immediately
        try {
          const id = `settings_write_error_${Date.now()}`
          setToasts(t => [...t, { id, text: 'Could not persist room settings — check permissions or network.' }])
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000)
        } catch (e) {}
        throw writeErr
      }
    } catch (e) {
      console.warn('Could not update room settings', e)
    }
  }

  // Toggle the ready state for a player in the lobby. Only used for non-host players to
  // mark themselves ready. Writes to players/<id>/ready in the room object.
  async function togglePlayerReady(targetPlayerId, readyVal) {
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const updates = {}
      updates[`players/${targetPlayerId}/ready`] = readyVal ? true : null
      // store true when ready, remove the key when not ready (keeps payload small)
      await safeDbUpdate(roomRef, updates)
    } catch (e) {
      console.warn('Could not toggle ready state', e)
    }
  }

  // Helper: pick a random word using current theme if enabled, else from NOUNS
  function pickRandomWordForGhost() {
    try {
      if (secretThemeEnabled && secretThemeType) {
        const type = secretThemeType
        let pool = null
        if (type === 'animals') pool = ANIMALS
    else if (type === 'ballsports') pool = BALLSPORTS
    else if (type === 'olympicsports') pool = OLYMPICSPORTS
  else if (type === 'gemstones') pool = GEMSTONES
        else if (type === 'colours') pool = COLOURS
        else if (type === 'instruments') pool = INSTRUMENTS
        else if (type === 'elements') pool = ELEMENTS
        else if (type === 'cpp') pool = CPPTERMS
  else if (type === 'fruits') pool = FRUITS
  else if (type === 'vegetables') pool = VEGETABLES
        else if (type === 'occupations') pool = OCCUPATIONS
        else if (type === 'countries') pool = COUNTRIES
        else if (type === 'custom' && state && state.secretWordTheme && state.secretWordTheme.custom && Array.isArray(state.secretWordTheme.custom.words) && state.secretWordTheme.custom.words.length > 0) {
          pool = state.secretWordTheme.custom.words
        }
        if (Array.isArray(pool) && pool.length > 0) {
          const idx = Math.floor(Math.random() * pool.length)
          return (pool[idx] || '').toString().toLowerCase()
        }
      }
      // fallback: NOUNS
      if (Array.isArray(NOUNS) && NOUNS.length > 0) {
        const idx = Math.floor(Math.random() * NOUNS.length)
        return (NOUNS[idx] || '').toString().toLowerCase()
      }
    } catch (e) {}
    // final fallback: a short common noun
    return 'apple'
  }

  // Request ghost re-entry: creates or joins a room-level ghostChallenge and records player intent
  async function requestGhostReentry() {
    if (!ghostReEntryEnabled) return false
    if (!myId) return false
    // only allow if eliminated and at least 2 uneliminated players remain
    const me = (state?.players || []).find(p => p.id === myId) || {}
    if (!me.eliminated) return false
    const activePlayers = (state?.players || []).filter(p => p && !p.eliminated)
    if ((activePlayers || []).length < 2) return false
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      // If no ghostChallenge exists or if it's resolved, create a fresh one
      const existing = state && state.ghostChallenge
      const now = Date.now()
      const updates = {}
      let challengeKey = existing && existing.key ? existing.key : `ghost_${now}`
      let challengeWord = existing && existing.word ? existing.word : null
      if (!challengeWord) {
        // pick a random word and store at room ghostChallenge
        challengeWord = pickRandomWordForGhost()
        updates[`ghostChallenge`] = { key: challengeKey, word: challengeWord, ts: now }
      }
      // record player's pending ghost re-entry attempt state: allow only one re-entry per player
      updates[`players/${myId}/ghostState`] = { reentered: false, attemptedAt: now, challengeKey }
  // write multi-path updates
  await safeDbUpdate(roomRef, updates)
      // open local modal to attempt guesses (client-side)
      setGhostModalOpen(true)
      setGhostChallengeKeyLocal(challengeKey)
      return true
    } catch (e) {
      console.warn('requestGhostReentry failed', e)
      return false
    }
  }

  // Claim a free underworld bubble (atomic claim using transaction).
  async function claimFreeBubble(bubble) {
    try {
      if (!bubble) return
      if (!myId) {
        const id = `fb_claim_needlogin_${Date.now()}`
        setToasts(t => [...t, { id, text: 'You must be signed in to claim the bubble.' }])
        setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
        return
      }
      const fbRef = dbRef(db, `rooms/${roomId}/freeBubble`)
      const res = await runTransaction(fbRef, (curr) => {
        if (!curr) return
        if (curr.claimedBy) return
        return { ...curr, claimedBy: myId, claimedAt: Date.now() }
      }, { applyLocally: false })
      if (!res || !res.committed) return
      const val = res.snapshot && typeof res.snapshot.val === 'function' ? res.snapshot.val() : (res && res.val) || {}
      if (!val || val.claimedBy !== myId) return

      // Award the amount to the player or their team depending on game mode
      const amount = Number(val.amount || 0)
      const updates = {}
      const meNode = (state?.players || []).find(p => p.id === myId) || {}
      if (state && state.gameMode === 'lastTeamStanding' && meNode.team) {
        const teamKey = `teams/${meNode.team}/wordmoney`
        const currTeam = Number(state?.teams?.[meNode.team]?.wordmoney || 0)
        updates[teamKey] = Math.max(0, currTeam + amount)
      } else {
        const playerKey = `players/${myId}/wordmoney`
        const currPlayer = Number(meNode.wordmoney || 0)
        updates[playerKey] = Math.max(0, currPlayer + amount)
      }
      const roomRef = dbRef(db, `rooms/${roomId}`)
      try { await dbUpdate(roomRef, updates) } catch (e) { /* best-effort */ }

      // Create a short-lived announcement and clear the bubble immediately so it disappears for everyone.
      try {
        const claimKey = `fb_claim_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
        const ann = { by: myId, name: playerIdToName[myId] || myId, amount, ts: Date.now() }
        const annUpdates = {}
        annUpdates[`freeBubble`] = null
        annUpdates[`freeBubbleClaims/${claimKey}`] = ann
        try { await safeDbUpdate(roomRef, annUpdates) } catch (e) { try { await dbUpdate(roomRef, annUpdates) } catch (ee) {} }
        // schedule removal of the announcement after a short period
        setTimeout(async () => { try { await dbUpdate(roomRef, { [`freeBubbleClaims/${claimKey}`]: null }) } catch (e) {} }, 7000)
      } catch (e) {}
    } catch (e) { console.warn('claimFreeBubble failed', e) }
  }

  // Attempt a ghost guess (letter or full word). Ghosts cannot use power-ups.
  async function submitGhostGuess(letterOrWord) {

      if (!myId) return { ok: false }
      console.log("michelle 1")
      const me = (state?.players || []).find(p => p.id === myId) || {}
      if (!me.eliminated) return { ok: false }
  console.log("michelle 2", me.ghostState)
  // Allow guesses when ghostState is undefined (client may not have written attempted state yet).
  // Only block if the player has already re-entered.
  if (me.ghostState && me.ghostState.reentered) return { ok: false }
      console.log("michelle 3", state)
      let challenge = state && state.ghostChallenge
      // Coerce legacy/string-shaped challenge to an object
      if (challenge && typeof challenge === 'string') challenge = { word: challenge }
      // If challenge missing from local state due to race, attempt a one-time read from DB
      if ((!challenge || !challenge.word) && typeof dbGet === 'function') {
        try {
          const roomRef = dbRef(db, `rooms/${roomId}/ghostChallenge`)
          const snap = await dbGet(roomRef)
          // Safely extract snapshot value whether snap.val is a function (Firebase) or
          // a plain property (testing/mocks). Call functions where appropriate.
          if (snap) {
            let val = null
            try {
              val = (typeof snap.val === 'function') ? snap.val() : snap.val
            } catch (err) {
              // defensively attempt to read .val when available
              try { val = snap.val() } catch (e) { val = null }
            }
            if (val && val.word) challenge = val
          }
        } catch (e) {
          console.warn('Could not fetch ghostChallenge from DB', e)
        }
      }
      // If still missing, try reading the 'word' child directly (some environments may store it as a primitive)
      if ((!challenge || !challenge.word) && typeof dbGet === 'function') {
        try {
          const wordRef = dbRef(db, `rooms/${roomId}/ghostChallenge/word`)
          const snap2 = await dbGet(wordRef)
          if (snap2) {
            try {
              const val2 = (typeof snap2.val === 'function') ? snap2.val() : snap2.val
              if (val2 && typeof val2 === 'string') challenge = { word: val2 }
            } catch (e) {
              try {
                const v2 = snap2.val && snap2.val()
                if (v2 && typeof v2 === 'string') challenge = { word: v2 }
              } catch (ee) {
                console.warn('Could not get ghostChallenge.word from DB', ee)
              }
            }
          }
        } catch (e) {
          console.warn('Could not fetch ghostChallenge.word from DB', e)
          // ignore - best-effort fallback
        }
      }
      console.log("michelle 3a", challenge)
      // Enforce per-player cooldown: prevent rapid repeated guesses. Return retryAfter (ms) when blocked.
      try {
        const meNode = (state?.players || []).find(p => p.id === myId) || {}
        const lastTs = Number(meNode.ghostLastGuessAt || 0)
        const now = Date.now()
        const cfgSeconds = (state && typeof state.ghostGuessCooldownSeconds === 'number') ? Number(state.ghostGuessCooldownSeconds) : Number(ghostGuessCooldownSeconds || 20)
        const cooldownMs = Math.max(1000, Math.min(300000, cfgSeconds * 1000))
        if (lastTs && (now - lastTs) < cooldownMs) {
          return { ok: false, retryAfter: Math.max(0, cooldownMs - (now - lastTs)) }
        }
      } catch (e) {}
      if (!challenge || !challenge.word) return { ok: false }
      const guess = (letterOrWord || '').toString().trim().toLowerCase()
      if (!guess) return { ok: false }
      // simple letter feedback: return which letters are correct in position if full word, or whether letter exists
      const target = (challenge.word || '').toString().toLowerCase()
      if (guess.length === 1) {
        const ch = guess
        const positions = []
        for (let i = 0; i < target.length; i++) if (target[i] === ch) positions.push(i)
        // record the guess privately under players/{myId}/ghostGuesses
        const roomRef = dbRef(db, `rooms/${roomId}`)
  const key = `g_${Date.now()}`
  const updates = {}
        console.log("michelle 7")
        updates[`players/${myId}/ghostGuesses/${key}`] = { ts: Date.now(), guess: ch, positions }
  // record timestamp for last guess to enforce cooldown
  updates[`players/${myId}/ghostLastGuessAt`] = Date.now()
  await safeDbUpdate(roomRef, updates)
        console.log("michelle 8")
        return { ok: true, positions }
      } else {
        // full word guess - if correct, re-enter the game: set players/{myId}/eliminated=false and set their word to challenge.word
        const correct = guess === target
        console.log("michelle 9")
        const roomRef = dbRef(db, `rooms/${roomId}`)
        const updates = {}
        const nowTs = Date.now()
        if (correct) {
          updates[`players/${myId}/eliminated`] = false
          updates[`players/${myId}/eliminatedAt`] = null
          updates[`players/${myId}/word`] = target
          updates[`players/${myId}/hasWord`] = true
          // mark that this player has re-entered so they cannot re-enter again
          updates[`players/${myId}/ghostState/reentered`] = true
          updates[`players/${myId}/ghostState/reenteredAt`] = nowTs
          // notify room: a ghost reentered - write into room.ghostAnnouncements to be observed by others
          const annKey = `ga_${nowTs}`
          updates[`ghostAnnouncements/${annKey}`] = { player: myId, name: playerIdToName[myId] || myId, ts: nowTs }
          // When a ghost guesses the shared word correctly, record the previous target into ghostHistory
          try {
            updates[`ghostHistory/${nowTs}`] = { word: target, replacedBy: null, by: myId, ts: nowTs }
          } catch (e) {}
          // change the room challenge to a new random word so other ghosts face a new target
          const newWord = pickRandomWordForGhost()
          // update ghostHistory entry with what it was replaced by
          try {
            updates[`ghostHistory/${nowTs}`].replacedBy = newWord
          } catch (e) {}
          // record this player's last guess time so they enter cooldown after a full-word correct guess as well
          try { updates[`players/${myId}/ghostLastGuessAt`] = nowTs } catch (e) {}
            // Clear all players' ghostGuesses so everyone sees a fresh challenge when it rotates
            try {
              (state?.players || []).forEach(pp => {
                try { updates[`players/${pp.id}/ghostGuesses`] = null } catch (e) {}
              })
            } catch (e) {}
            // Clear per-viewer private UI state that references this player so the
            // ex-ghost's tile appears fresh on everyone else's screen. This removes
            // private power-up results, wrong-letter/word lists, and private hit lists
            // that viewers might have stored under their own player objects keyed by this player id.
            try {
              (state?.players || []).forEach(p => {
                // avoid writing descendant paths when we also null the entire branch for the re-entering player
                if (!p || !p.id) return
                if (p.id === myId) return
                try { updates[`players/${p.id}/privatePowerReveals/${myId}`] = null } catch (e) {}
                try { updates[`players/${p.id}/privateWrong/${myId}`] = null } catch (e) {}
                try { updates[`players/${p.id}/privateWrongWords/${myId}`] = null } catch (e) {}
                try { updates[`players/${p.id}/privateHits/${myId}`] = null } catch (e) {}
              })
            } catch (e) {}
            // Also clear any private state stored on the re-entering player's own entry
            try {
              updates[`players/${myId}/privatePowerReveals`] = null
              updates[`players/${myId}/privateHits`] = null
              updates[`players/${myId}/privateWrong`] = null
              updates[`players/${myId}/privateWrongWords`] = null
              // Clear any prior guess-blocking records for the re-entering player
              updates[`players/${myId}/guessedBy`] = null
            } catch (e) {}
            // Reset the public revealed letters on the re-entering player's tile so
            // other players no longer see previous revealed letters for this player.
            try { updates[`players/${myId}/revealed`] = [] } catch (e) {}
            // Recompute turnOrder to add the re-entering player (if not present).
            try {
              // Helper: build a deterministic alternating order for lastTeamStanding
              // mode by keeping two lists (one per team) preserving the players
              // array order and interleaving them with independent wraparound.
              const buildLastTeamStandingOrder = (playersArr = [], includeId = null) => {
                try {
                  const alive = (playersArr || []).filter(p => p && (!p.eliminated || (includeId && p.id === includeId)))
                  const teams = {}
                  const unteamed = []
                  alive.forEach(p => {
                    if (p && p.team) {
                      teams[p.team] = teams[p.team] || []
                      teams[p.team].push(p.id)
                    } else if (p && p.id) {
                      unteamed.push(p.id)
                    }
                  })
                  const teamNames = Object.keys(teams)
                  // If exactly two teams present, interleave deterministically.
                  if (teamNames.length === 2) {
                    const a = teams[teamNames[0]] || []
                    const b = teams[teamNames[1]] || []
                    const total = a.length + b.length
                    const result = []
                    let ia = 0
                    let ib = 0
                    while (result.length < total) {
                      if (a.length > 0) {
                        const pickA = a[ia % a.length]
                        if (!result.includes(pickA)) result.push(pickA)
                        ia++
                      }
                      if (result.length >= total) break
                      if (b.length > 0) {
                        const pickB = b[ib % b.length]
                        if (!result.includes(pickB)) result.push(pickB)
                        ib++
                      }
                    }
                    return result.concat(unteamed)
                  }
                  // Fallback: preserve players array order skipping eliminated.
                  return alive.map(p => p.id).concat(unteamed.filter(id => !alive.some(ap => ap.id === id)))
                } catch (e) { return (playersArr || []).filter(p => p && !p.eliminated).map(p => p.id) }
              }

              // If room is in lastTeamStanding mode, rebuild the full alternating order
              // (this ensures re-entering ghosts are added to their team list correctly).
              if (state && state.gameMode === 'lastTeamStanding') {
                try {
                  const newOrder = buildLastTeamStandingOrder(state.players || [], myId)
                  if (Array.isArray(newOrder) && newOrder.length > 0) updates[`turnOrder`] = newOrder
                } catch (e) {}
              } else {
                const curOrder = Array.isArray(state && state.turnOrder) ? (state.turnOrder || []).slice() : []
                if (!curOrder.includes(myId)) {
                  // Insert before the player whose current turn it is so the re-entered
                  // player will act just before the current turn (i.e. they'll go "last"
                  // relative to new entrants).
                  const insertIndex = (typeof state?.currentTurnIndex === 'number') ? state.currentTurnIndex : curOrder.length
                  const idx = Math.max(0, Math.min(curOrder.length, insertIndex))
                  const next = curOrder.slice()
                  next.splice(idx, 0, myId)
                  updates[`turnOrder`] = next
                }
              }
            } catch (e) {}
            updates[`ghostChallenge`] = { key: `ghost_${nowTs}`, word: newWord, ts: nowTs }
        } else {
          // incorrect full-word guess : record attempt
          const key = `g_${nowTs}`
          updates[`players/${myId}/ghostGuesses/${key}`] = { ts: nowTs, guess }
          // record timestamp for last guess to enforce cooldown
          updates[`players/${myId}/ghostLastGuessAt`] = nowTs
        }
    console.log("michelle a 1")
    console.log("michelle a 2")
    await safeDbUpdate(roomRef, updates)
    return { ok: true, correct }
      }
  }

  // (Settings gear moved into the modeBadge) helper removed

  function SettingsModal({ open, onClose }) {
    // Always render the settings modal element so it remains in the DOM even when hidden.
    // Visibility is controlled via inline style to avoid mount/unmount cycles that reset scroll.
    // immediate update: write minWordSize on change to avoid spinner revert issues

    return (
      <div id="settings" ref={settingsRef} className="settings-modal" style={{ display: open ? 'block' : 'none', overflowY: 'auto', height: '100%', position: 'fixed', right: 18, top: 64, width: 360, zIndex: 10001 }} onMouseDown={e => { try { e.stopPropagation() } catch (er) {} }} onClick={e => { try { e.stopPropagation() } catch (er) {} }}>
        <div className="card" ref={settingsListRef} onScroll={() => { try { settingsScrollRef.current = settingsListRef.current ? settingsListRef.current.scrollTop : 0 } catch (e) {} }} style={{ padding: 12, maxHeight: '70vh', overflow: 'auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Room settings</strong>
            {/* fixed-size close button to avoid jitter when hovered/focused */}
            <button onClick={onClose} aria-label="Close settings" style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              width: 36,
              height: 36,
              padding: 6,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'none',
              outline: 'none'
            }}>✖</button>
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="timedMode">
              <input id="timedMode" name="timedMode" type="checkbox" checked={timedMode} onChange={e => { const nv = e.target.checked; setTimedMode(nv); updateRoomTiming(nv, turnSeconds); updateRoomSettings({ timed: !!nv, turnTimeoutSeconds: nv ? turnSeconds : null }) }} /> Timed game
            </label>
            {timedMode && (
              <label htmlFor="turnSeconds">
                Seconds per turn:
                <input id="turnSeconds" name="turnSeconds" type="number" min={10} max={600} value={turnSeconds} onChange={e => { const v = Math.max(10, Math.min(600, Number(e.target.value || 30))); setTurnSeconds(v); updateRoomTiming(timedMode, v); updateRoomSettings({ turnTimeoutSeconds: v }) }} style={{ width: 100, marginLeft: 8 }} />
              </label>
            )}
            <label htmlFor="starterEnabled" title="When enabled, a single random word requirement will be chosen when the game starts. Players whose submitted word meets the requirement receive +10 bonus wordmoney.">
              <input id="starterEnabled" name="starterEnabled" type="checkbox" checked={starterEnabled} onChange={e => { const nv = e.target.checked; setStarterEnabled(nv); updateRoomSettings({ starterBonus: { enabled: !!nv, description: state?.starterBonus?.description || '' } }) }} /> Word selection bonus
            </label>
            <div style={{ marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input id="secretThemeEnabled" type="checkbox" checked={secretThemeEnabled} onChange={e => { const nv = e.target.checked; setSecretThemeEnabled(nv); updateRoomSettings({ secretWordTheme: { enabled: !!nv, type: secretThemeType } }) }} /> Enforce secret word theme
                </label>
                {secretThemeEnabled && (
                  <label style={{ marginTop: 6 }} htmlFor="secretThemeType">Theme:
                    <ThemeSelect id="secretThemeType" value={secretThemeType} onChange={handleThemeChange} style={{ marginLeft: 8 }} />
                  </label>
                )}
                {/* Host-only custom theme upload */}
                {secretThemeEnabled && isHost && secretThemeType === 'custom' && (
                  <div style={{ marginTop: 10, padding: 8, border: '1px dashed #eee', borderRadius: 8 }}>
                    <strong style={{ fontSize: 13 }}>Upload custom word set (host only)</strong>
                    <div style={{ marginTop: 8 }}>
                      <label style={{ display: 'block', fontSize: 13 }}>Title (optional):
                        <input id="custom_title" ref={customTitleRef} defaultValue={customTitle} onChange={e => { try { setCustomError('') } catch (er) {} }} placeholder="e.g. Party words" style={{ width: '100%', marginTop: 6 }} />
                      </label>
                      <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>Words (comma-separated):
                        <input id="custom_csv" ref={customCsvRef} defaultValue={customCsv} onChange={e => { try { setCustomError('') } catch (er) {} }} placeholder="ribbon,candy,cake,balloon,balloons" style={{ width: '100%', marginTop: 6 }} />
                      </label>
                      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                        <button onClick={async () => {
                          // validate CSV: lower-case, split, ensure each token is letters-only and single-word
                          try {
                            const raw = (customCsvRef.current ? (customCsvRef.current.value || '') : (customCsv || '')).toString().trim()
                            // allow empty raw: means any word permitted (no validation)
                            const parts = raw ? raw.split(',').map(s => (s || '').toString().trim().toLowerCase()).filter(Boolean) : []
                            // if provided some tokens, validate them
                            if (parts.length > 0) {
                              const invalid = parts.filter(w => !/^[a-z]+$/.test(w) || /\s/.test(w))
                              if (invalid.length > 0) {
                                // Preserve whatever the user has typed in the input : do NOT clear or overwrite
                                // the ref or local state so they can fix the comma-separated list in-place.
                                setCustomError(`Invalid words: ${invalid.slice(0,6).join(', ')}${invalid.length > 6 ? ', …' : ''}. Words must be single words with letters only.`)
                                // Do not touch prevCustomSerializedRef, customTitleRef, or customCsvRef here.
                                return
                              }
                            }
                            // Save to room settings (persist title and array). Empty array means "allow any word".
                            const titleVal = (customTitleRef.current ? (customTitleRef.current.value || '') : (customTitle || '')).toString().trim() || null
                            await updateRoomSettings({ secretWordTheme: { enabled: true, type: secretThemeType, custom: { title: titleVal, words: parts } } })
                            // If the host saved an explicit empty custom list (meaning "allow any word"),
                            // persist ghostReEntryEnabled=false so the toggle is globally turned off.
                            try {
                              if (Array.isArray(parts) && parts.length === 0) {
                                await updateRoomSettings({ ghostReEntryEnabled: false })
                                // mark we auto-disabled due to custom-empty so UI won't flip back
                                try { autoGhostDisabledDueToCustom.current = true } catch (e) {}
                              }
                            } catch (e) { /* non-fatal */ }
                            // remember serialized value so we don't overwrite local edits unnecessarily
                            const serNow = JSON.stringify({ title: titleVal || '', words: parts })
                            prevCustomSerializedRef.current = serNow
                            // Ensure the inputs reflect the confirmed saved set so the host can edit it further
                            try { if (customTitleRef.current) customTitleRef.current.value = titleVal || '' } catch (e) {}
                            try { if (customCsvRef.current) customCsvRef.current.value = (parts || []).join(',') } catch (e) {}
                            // keep local state in sync for compatibility
                            setCustomTitle(titleVal || '')
                            setCustomCsv((parts || []).join(','))
                            setCustomError('')
                            const savedToastId = `custom_ok_${Date.now()}`
                            setToasts(t => [...t, { id: savedToastId, text: 'Custom word set saved' }])
                            setTimeout(() => setToasts(t => t.filter(x => x.id !== savedToastId)), 4000)
                          } catch (e) {
                            console.warn('Could not save custom set', e)
                            setCustomError('Could not save custom set. Try again.')
                          }
                        }}>Save custom set</button>
                        <button onClick={async () => {
                          try {
                            // clear custom set from room
                            await updateRoomSettings({ secretWordTheme: { enabled: !!secretThemeEnabled, type: secretThemeType, custom: null } })
                            // clear local inputs and prev serialized marker
                            prevCustomSerializedRef.current = null
                            try { if (customCsvRef.current) customCsvRef.current.value = '' } catch (e) {}
                            try { if (customTitleRef.current) customTitleRef.current.value = '' } catch (e) {}
                            setCustomCsv('')
                            setCustomTitle('')
                            setCustomError('')
                            const clearedToastId = `custom_cleared_${Date.now()}`
                            setToasts(t => [...t, { id: clearedToastId, text: 'Custom word set cleared' }])
                            setTimeout(() => setToasts(t => t.filter(x => x.id !== clearedToastId)), 4000)
                          } catch (e) {
                            setCustomError('Could not clear custom set')
                          }
                        }}>Clear</button>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                        Example: ribbon,candy,cake,balloon,balloons : leave blank to allow any word (no validation)
                      </div>
                      {customError && <div style={{ marginTop: 8, color: '#900', fontSize: 13 }}>{customError}</div>}
                    </div>
                  </div>
                )}
              </div>
            <label htmlFor="gameMode" title="Choose the game mode for this room">
              Mode:
              <select id="gameMode" name="gameMode" value={gameMode} onChange={e => {
                const nv = e.target.value
                // when switching to Word Seeker, default timed mode ON and set seconds = 60 * players
                if (nv === 'wordSeeker') {
                  const playersCount = (state && state.players && Array.isArray(state.players)) ? state.players.length : ((players && Array.isArray(players)) ? players.length : 1)
                  const computed = Math.max(10, Math.min(600, 60 * Math.max(1, playersCount)))
                  setGameMode(nv)
                  setTimedMode(true)
                  setTurnSeconds(computed)
                  // persist mode and timing to room
                  updateRoomTiming(true, computed)
                  updateRoomGameMode(nv, { timerSeconds: computed, rounds: wordSeekerRounds })
                  updateRoomSettings({ gameMode: nv, timed: true, turnTimeoutSeconds: computed })
                } else {
                  setGameMode(nv)
                  updateRoomGameMode(nv, { timerSeconds: turnSeconds, rounds: wordSeekerRounds })
                  updateRoomSettings({ gameMode: nv })
                }
              }} style={{ marginLeft: 8 }}>
                <option value="lastOneStanding">Last One Standing</option>
                  <option value="lastTeamStanding">Last Team Standing</option>
                <option value="money">Money Wins</option>
                <option value="wordSeeker">Word Seeker</option>
              </select>
            </label>
            {gameMode === 'lastTeamStanding' && isHost && (
              <label htmlFor="firstWordWins" title="When on, the first team to correctly guess any opponent's word wins immediately">
                <input id="firstWordWins" name="firstWordWins" type="checkbox" checked={firstWordWins} onChange={e => { const nv = e.target.checked; setFirstWordWins(nv); updateRoomSettings({ firstWordWins: !!nv }) }} /> First word guessed wins
              </label>
            )}
            {gameMode === 'wordSeeker' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                {/* Word Seeker uses the global Timed game seconds (computed as 60 * players by default). Do not show a separate Word Seeker timer input. */}
                <label htmlFor="wordSeekerRounds">Rounds:
                  <input id="wordSeekerRounds" type="number" min={1} max={20} value={wordSeekerRounds} onChange={e => { const v = Math.max(1, Math.min(20, Number(e.target.value || 1))); setWordSeekerRounds(v); updateRoomGameMode('wordSeeker', { timerSeconds: turnSeconds, rounds: v }); updateRoomSettings({ wordSeekerRounds: v }) }} style={{ width: 120, marginLeft: 8 }} />
                </label>
              </div>
            )}
            <label htmlFor="powerUpsEnabled" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title="Enable in-game power ups such as revealing letter counts or the starting letter.">
              <input id="powerUpsEnabled" name="powerUpsEnabled" type="checkbox" checked={powerUpsEnabled} onChange={e => { const nv = e.target.checked; setPowerUpsEnabled(nv); updateRoomSettings({ powerUpsEnabled: !!nv }) }} /> Curses enabled
            </label>
            <label htmlFor="ghostReEntryEnabled" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={"Allow eliminated players to attempt re-entry as ghosts by guessing a random word"}>
              <input id="ghostReEntryEnabled" name="ghostReEntryEnabled" type="checkbox" checked={ghostReEntryEnabled} onChange={e => { const nv = e.target.checked; setGhostReEntryEnabled(nv); updateRoomSettings({ ghostReEntryEnabled: !!nv }) }}
                disabled={secretThemeType === 'custom' && state && state.secretWordTheme && state.secretWordTheme.custom && Array.isArray(state.secretWordTheme.custom.words) && state.secretWordTheme.custom.words.length === 0}
              /> Ghost Re-Entry enabled
            </label>
            <label htmlFor="freeBubblesEnabled" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={"Spawn random underworld-themed free wordmoney bubbles during play (at least 2 minutes apart)."}>
              <input
                id="freeBubblesEnabled"
                name="freeBubblesEnabled"
                type="checkbox"
                checked={freeBubblesEnabled}
                disabled={!isHost}
                onChange={e => {
                  try {
                    // Only hosts are allowed to persist room settings. If a non-host
                    // somehow triggers this handler (e.g. via keyboard), show a quick
                    // toast explaining why the toggle won't stick.
                    if (!isHost) {
                      const id = `settings_denied_${Date.now()}`
                      setToasts(t => [...t, { id, text: 'Only the host can change room settings.' }])
                      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000)
                      return
                    }
                    const nv = e.target.checked
                    setFreeBubblesEnabled(nv)
                    updateRoomSettings({ freeBubblesEnabled: !!nv })
                  } catch (err) {}
                }}
              /> Random free wordmoney bubbles (underworld themed)
            </label>
            {/* Bot settings (host-only) */}
            {isHost && (
              <div style={{ marginTop: 8, padding: 8, border: '1px dashed rgba(255,255,255,0.04)', borderRadius: 8 }}>
                <strong style={{ fontSize: 13 }}>Bots</strong>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Delay (ms):
                    <input type="number" value={state?.botSettings?.delayMs || 4000} onChange={e => { try { updateRoomSettings({ botSettings: { ...(state?.botSettings || {}), delayMs: Number(e.target.value) || 4000 } }) } catch (er) {} }} style={{ width: 110, marginLeft: 6 }} />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Difficulty:
                    <select value={state?.botSettings?.difficulty || 'medium'} onChange={e => { try { updateRoomSettings({ botSettings: { ...(state?.botSettings || {}), difficulty: e.target.value } }) } catch (er) {} }} style={{ marginLeft: 6 }}>
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </label>
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button onClick={async () => {
                    try {
                      const bs = state?.botSettings || {}
                      const id = await addBot({ difficulty: bs.difficulty || 'medium', delayMs: Number(bs.delayMs) || 4000 })
                      if (id) {
                        const tid = `bot_added_${Date.now()}`
                        setToasts(t => [...t, { id: tid, text: 'Bot added to room' }])
                        setTimeout(() => setToasts(t => t.filter(x => x.id !== tid)), 4000)
                      } else {
                        const tid = `bot_err_${Date.now()}`
                        setToasts(t => [...t, { id: tid, text: 'Could not add bot (check host status)', error: true }])
                        setTimeout(() => setToasts(t => t.filter(x => x.id !== tid)), 4000)
                      }
                    } catch (e) { console.warn('Add bot failed', e) }
                  }}>Add bot</button>
                </div>
              </div>
            )}
            <label htmlFor="submitTimerEnabled" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }} title={"When enabled, players have a limited time to submit a word during the submit phase; unsubmitted players are auto-assigned a word and receive -2 wordmoney."}>
              <input id="submitTimerEnabled" name="submitTimerEnabled" type="checkbox" checked={submitTimerEnabled} onChange={e => { const nv = e.target.checked; setSubmitTimerEnabled(nv); updateRoomSettings({ submitTimerEnabled: !!nv }) }} /> Enable submit-phase timer
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <label style={{ fontSize: 13, color: '#ccc' }}>Submit seconds:</label>
              <input type="number" min={5} max={600} value={submitTimerSeconds} onChange={e => { const v = Number(e.target.value) || 60; setSubmitTimerSeconds(v); updateRoomSettings({ submitTimerSeconds: v }) }} style={{ width: 96 }} />
            </div>
            {(secretThemeType === 'custom' && state && state.secretWordTheme && state.secretWordTheme.custom && Array.isArray(state.secretWordTheme.custom.words) && state.secretWordTheme.custom.words.length === 0) && (
              <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>Ghost Re-Entry is disabled when the host's custom set allows any word (empty list).</div>
            )}
            {ghostReEntryEnabled && isHost && (
              <label htmlFor="ghostGuessCooldownSeconds" title="Seconds ghosts must wait between guesses">
                Ghost guess cooldown (seconds):
                <input id="ghostGuessCooldownSeconds" type="number" min={1} max={300} value={ghostGuessCooldownSeconds} onChange={e => { const v = Math.max(1, Math.min(300, Number(e.target.value || 20))); setGhostGuessCooldownSeconds(v); updateRoomSettings({ ghostGuessCooldownSeconds: v }) }} style={{ width: 120, marginLeft: 8 }} />
              </label>
            )}
            <label htmlFor="showWordsOnEnd" title="When enabled, each player's submitted secret word is shown on the final standings screen">
              <input id="showWordsOnEnd" name="showWordsOnEnd" type="checkbox" checked={showWordsOnEnd} onChange={e => { const nv = e.target.checked; setShowWordsOnEnd(nv); updateRoomSettings({ showWordsOnEnd: !!nv }) }} /> Show words on end screen
            </label>
                <label htmlFor="revealPreserveOrder" title="When on, revealed letters are shown in their positions within the word (helps when combined with blanks).">
                  <input id="revealPreserveOrder" name="revealPreserveOrder" type="checkbox" checked={revealPreserveOrder} disabled={revealShowBlanks} onChange={e => {
                    const nv = e.target.checked
                    // If Show blanks is enabled, Preserve reveal order must remain true
                    if (revealShowBlanks && !nv) {
                      // ignore attempts to turn off; ensure UI reflects enforced value
                      setRevealPreserveOrder(true)
                      return
                    }
                    setRevealPreserveOrder(nv)
                    updateRoomSettings({ revealPreserveOrder: !!nv })
                  }} title={revealShowBlanks ? 'This option is required when Show blanks is enabled' : 'When on, revealed letters are shown in their positions within the word (helps when combined with blanks).'} /> Reveal letters in order of their positions in the word
                </label>
                <label htmlFor="revealShowBlanks" title="Show blanks (underscores) for unrevealed letters. Enabling this will also enable Preserve reveal order.">
                  <input id="revealShowBlanks" name="revealShowBlanks" type="checkbox" checked={revealShowBlanks} onChange={e => { const nv = e.target.checked; setRevealShowBlanks(nv); if (nv) { setRevealPreserveOrder(true); updateRoomSettings({ revealShowBlanks: !!nv, revealPreserveOrder: true }) } else { updateRoomSettings({ revealShowBlanks: !!nv }) } }} /> Show blanks
                </label>
                {/* Isolated starting/min controls to avoid re-rendering the whole settings UI while typing */}
                <StartingMinSettings
                  initialStarting={startingWordmoney}
                  initialMin={minWordSize}
                  onPersistStarting={async (v) => {
                    try {
                      setStartingWordmoney(v)
                      await updateRoomSettings({ startingWordmoney: v })
                    } catch (e) { console.warn('Could not persist startingWordmoney', e) }
                  }}
                  onPersistMin={(v) => {
                    try {
                      setMinWordSize(v)
                      setMinWordSizeInput(String(v))
                      updateRoomSettings({ minWordSize: v })
                    } catch (e) { console.warn('Could not persist minWordSize', e) }
                  }}
                  isHost={isHost}
                />
          </div>
        </div>
      </div>
    )
  }

  // Power-up definitions
  // Memoize the SettingsModal element in the GameRoom scope so unrelated re-renders
  // don't recreate it and close native <select> dropdowns. The element is memoized
  // (not the portal) and later rendered into the modalRoot via ReactDOM.createPortal.
  const settingsNode = useMemo(() => {
    try {
      return <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    } catch (e) {
      return <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    }
  // Include flags that SettingsModal consumes so it updates when authoritative
  // room settings change (freeBubblesEnabled was previously omitted causing
  // the checkbox to appear stale).
  }, [showSettings, timedMode, turnSeconds, starterEnabled, secretThemeEnabled, secretThemeType, gameMode, firstWordWins, wordSeekerTimerSeconds, wordSeekerRounds, powerUpsEnabled, ghostReEntryEnabled, ghostGuessCooldownSeconds, minWordSize, startingWordmoney, revealPreserveOrder, revealShowBlanks, freeBubblesEnabled, submitTimerEnabled, submitTimerSeconds, showWordsOnEnd])
  // Close settings when clicking outside the settings modal
  useEffect(() => {
    if (!showSettings) return () => {}
    function onDocMouseDown(e) {
      try {
        const node = settingsRef && settingsRef.current
        if (!node) return
        if (!node.contains(e.target)) {
          setShowSettings(false)
        }
      } catch (err) {}
    }
    try { document.addEventListener('mousedown', onDocMouseDown) } catch (e) { document.addEventListener && document.addEventListener('click', onDocMouseDown) }
    return () => { try { document.removeEventListener('mousedown', onDocMouseDown) } catch (e) { try { document.removeEventListener && document.removeEventListener('click', onDocMouseDown) } catch (er) {} } }
  }, [showSettings])
  const POWER_UPS = [
    { id: 'letter_for_letter', updateType:"not important", name: 'Letter for a Letter', price: 2, desc: "Reveals a random letter from your word and your opponent's word, only to each other. Both players get points unless the letter has already been revealed before. Reveals all occurrences of the letter.", powerupType: 'singleOpponentPowerup' },
    { id: 'vowel_vision', updateType:"important", name: 'Vowel Vision', price: 4, desc: 'Privately tells just you how many vowels the word contains.', powerupType: 'singleOpponentPowerup' },
    { id: 'letter_scope', updateType:"important", name: 'Letter Scope', price: 4, desc: 'Find out how many letters the word has. The information is revealed to only you.', powerupType: 'singleOpponentPowerup' },
    { id: 'one_random', updateType:"not important", name: 'One Random Letter', price: 4, desc: 'Publicly reveal one random letter from your target\'s word. It may be a letter that is already revealed, in which case, you won\'t get points for it!', powerupType: 'singleOpponentPowerup' },
    { id: 'mind_leech', updateType:"not important", name: 'Mind Leech', price: 4, desc: "The letters that are revealed from your word will be used to guess letters in your opponent's word. Only you will be able to see the revealed letters!", powerupType: 'singleOpponentPowerup' },
    { id: 'zeta_drop', updateType:"important", name: 'Zeta Drop', price: 5, desc: 'Publicly reveal the last letter of the word, and all occurrences of it (other people will not be told it is the last letter though 😉. You get points if the letter was previously not revealed.', powerupType: 'singleOpponentPowerup' },
    { id: 'letter_peek', updateType:"important", name: 'Letter Peek', price: 5, desc: 'Pick a position and publicly reveal that specific letter, and all occurences of it! You get points if the letter was not revealed before, for every occurence of the letter. Other players will not be given any information about the letter\'s position.', powerupType: 'singleOpponentPowerup' },
  { id: 'related_word', updateType:"important", name: 'Related Word', price: 5, desc: 'Get a related word, visible to only you. How related though? Well... it depends!', powerupType: 'singleOpponentPowerup' },
    { id: 'sound_check', updateType:"important", name: 'Sound Check', price: 8, desc: 'Suggests a word that sounds like the target word. Only you can see the suggestion.', powerupType: 'singleOpponentPowerup' },
    { id: 'dice_of_doom', updateType:"not important", name: 'Dice of Doom', price: 22, desc: 'Rolls a dice and publicly reveal that many letters at random from the target\'s word. It may be a letter that is already revealed, but if it isn\'t, you get points for each occurence of the letter!', powerupType: 'singleOpponentPowerup' },
  { id: 'split_15', updateType:"not important", name: 'Split 15', price: 2, desc: 'If the target word has 15 or more letters, publicly reveal the first half of the word publicly. You earn points for any previously unrevealed letters.', powerupType: 'singleOpponentPowerup' },
    { id: 'what_do_you_mean', updateType:"important", name: 'What Do You Mean', price: 8, desc: 'Gives a definition of the word. If we can\'t find a definition, we\'ll provide two previously unrevealed letters instead (with points!).', powerupType: 'singleOpponentPowerup' },
    { id: 'all_letter_reveal', updateType:"not important", name: 'All The Letters', price: 35, desc: 'Publicly reveal all letters in shuffled order.', powerupType: 'singleOpponentPowerup' },
    { id: 'full_reveal', updateType:"important", name: 'Full Reveal', price: 55, desc: 'Publicly reveal the entire word instantly, in order.', powerupType: 'singleOpponentPowerup' },
    { id: 'word_freeze', updateType:"not important", name: 'Word Freeze', price: 3, desc: 'Put your word on ice: no one can guess it or play power ups on it until your turn comes back around.', powerupType: 'selfPowerup' },
    { id: 'double_down', updateType:"not important", name: 'Double Down', price: 1, desc: 'Stake some wordmoney; next correct guess yields double the stake you put down, for each correct letter. In addition to the stake, you will also get the default +2 when a letter is correctly guessed. Beware: you will lose the stake on a wrong guess.', powerupType: 'selfPowerup' },
  { id: 'the_unseen', updateType: "important", name: 'The Unseen', price: 6, desc: 'Publicly reveal a previously unrevealed letter from the target.', powerupType: 'singleOpponentPowerup' },
    { id: 'price_surge', updateType:"not important", name: 'Price Surge', price: 2, desc: 'Increase everyone else\'s shop prices by +2 for the next round (even if they have word freeze on)!', powerupType: 'selfPowerup' },
    { id: 'crowd_hint', updateType:"not important", name: 'Crowd Hint', price: 5, desc: 'Publicly reveal one random letter from everyone\'s word, including yours. Letters are revealed publicly, but you recieve no points for them.', powerupType: 'selfPowerup' },
    { id: 'longest_word_bonus', updateType:"important", name: 'Longest Word Bonus', price: 5, desc: 'Grant +10 wordmoney to the player with the longest word. Visible to others when played. Can be used once per player, per game.', powerupType: 'selfPowerup' },
    { id: 'rare_trace', updateType:"important", name: 'Rare Trace', price: 2, desc: 'Reports how many rare letters (Q, X, Z, J, K, V) appear in the target\'s word.', powerupType: 'singleOpponentPowerup' }
  ]

  // Ensure the UI shows power-ups ordered by price (ascending)
  try { POWER_UPS.sort((a,b) => (Number(a.price) || 0) - (Number(b.price) || 0)) } catch (e) {}

  // helper to perform a power-up purchase; writes to DB private entries and deducts wordmoney
  async function purchasePowerUp(powerId, opts = {}) {
    if (!powerUpTarget) return
    if (!myId) return
    // ensure it's the player's turn
    if (currentTurnId !== myId) {
      setToasts(t => [...t, { id: `pup_err_turn_${Date.now()}`, text: 'You can only play power-ups on your turn.' }])
      return
    }
    const pu = POWER_UPS.find(p => p.id === powerId)
    if (!pu) return
    const baseCost = pu.price
  // Resolve viewer/player and gameMode early so subsequent surge/cost logic
  // can reference them without temporal-dead-zone issues.
  const me = (state?.players || []).find(p => p.id === myId) || {}
  const myHang = Number(me.wordmoney) || 0
  const gmMode = (state && state.gameMode) ? state.gameMode : gameMode
  // declare teamMoney early so later code (stake checks) can reference it without TDZ
  let teamMoney = 0
    // compute effective cost (account for global price surge(s) set by other player(s)).
    // Support both legacy single-object shape and new per-player map shape.
    let cost = baseCost
   
      let totalSurgeAmount = 0
      const ps = state && state.priceSurge
      if (ps && typeof ps === 'object') {
        // legacy single-object shape: { amount, by, expiresAtTurnIndex }
        if (typeof ps.amount !== 'undefined' && (typeof ps.by !== 'undefined' || typeof ps.expiresAtTurnIndex !== 'undefined')) {
          const surge = ps
          if (surge && surge.amount && surge.by !== myId) {
            // In lastTeamStanding, a surge played by a player should not affect their teammates.
            if (gmMode === 'lastTeamStanding' && me.team) {
              try {
                const authorNode = (state?.players || []).find(p => p.id === surge.by) || {}
                if (authorNode && authorNode.team && authorNode.team === me.team) {
                  // surge by teammate: ignore
                } else {
                  const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
                  const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
                  if (active) totalSurgeAmount += Number(surge.amount || 0)
                }
              } catch (e) {
                const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
                const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
                if (active) totalSurgeAmount += Number(surge.amount || 0)
              }
            } else {
              const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
              const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
              if (active) totalSurgeAmount += Number(surge.amount || 0)
            }
          }
        } else {
          // new map shape: { [playerId]: { amount, by, expiresAtTurnIndex }, ... }
          Object.keys(ps || {}).forEach(k => {
            try {
              const entry = ps[k]
              if (!entry || !entry.amount) return
              if (entry.by === myId) return // buyer's own surge does not affect them
              // If in lastTeamStanding, ignore surges authored by teammates
              if (gmMode === 'lastTeamStanding' && me.team) {
                try {
                  const authorNode = (state?.players || []).find(p => p.id === entry.by) || {}
                  if (authorNode && authorNode.team && authorNode.team === me.team) return
                } catch (e) {}
              }
              const expires = typeof entry.expiresAtTurnIndex === 'number' ? entry.expiresAtTurnIndex : null
              const active = expires === null || (typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex < expires : true)
              if (active) totalSurgeAmount += Number(entry.amount || 0)
            } catch (e) {}
          })
        }
      }
      if (totalSurgeAmount) cost = baseCost + totalSurgeAmount
   
  // check buyer/team wordmoney affordability (viewer/player and gmMode resolved earlier)
  // Compute an explicit buyerBalance that is the authoritative balance to check for affordability.
  // This ensures we only consider the team wallet when the room is actually in lastTeamStanding.
  let buyerBalance = Number(me.wordmoney) || 0
  if (gmMode === 'lastTeamStanding' && me.team) {
    // Try to read the authoritative team wallet from the DB to avoid using a stale local state
    try {
      const teamRef = dbRef(db, `rooms/${roomId}/teams/${me.team}/wordmoney`)
      const snap = await dbGet(teamRef)
      let live = null
      try { live = (snap && typeof snap.val === 'function') ? snap.val() : snap.val } catch (e) { live = snap }
      if (typeof live === 'number' || (typeof live === 'string' && !Number.isNaN(Number(live)))) {
        teamMoney = Number(live)
      } else {
        // fallback to room state snapshot
        teamMoney = Number(state?.teams?.[me.team]?.wordmoney || 0)
      }
    } catch (e) {
      // DB read failed - fall back to local room state
      teamMoney = Number(state?.teams?.[me.team]?.wordmoney || 0)
    }
    buyerBalance = Number(teamMoney) || 0
  }

  console.log(`GH: Attempting to purchase power-up ${powerId} for $${cost} (base $${baseCost} + surge $${totalSurgeAmount}) by player ${myId} in mode ${gmMode} with buyerBalance $${buyerBalance} (myHang ${myHang})`)

  if (buyerBalance - cost < 0) {
    // If we're in team mode show a team-specific message
    if (gmMode === 'lastTeamStanding' && me.team) {
      setToasts(t => [...t, { id: `pup_err_money_${Date.now()}`, text: 'Not enough team wordmoney to buy that power-up.' }])
    } else {
      setToasts(t => [...t, { id: `pup_err_money_${Date.now()}`, text: 'Not enough wordmoney to buy that power-up.' }])
    }
    return
  }

    // Guard: only allow longest_word_bonus once per buyer
    if (powerId === 'longest_word_bonus') {
      try {
        if (state && state.usedLongestWordBonus && state.usedLongestWordBonus[myId]) {
          setToasts(t => [...t, { id: `pup_err_used_${Date.now()}`, text: 'Longest Word Bonus already used.' }])
          return
        }
      } catch (e) {}
    }
    setPowerUpLoading(true)
    try {
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const updates = {}
      // deduct buyer wordmoney (as a delta) using applyAward so team-mode credits the team wallet
      // applyAward will write to teams/<team>/wordmoney when appropriate and still record players/<id>/lastGain
      applyAward(updates, myId, -cost, { reason: 'purchase', by: powerUpTarget })
      // if buying Double Down, record the stake and keep turn active so the buyer can guess
      if (powerId === 'double_down') {
        try {
          const stake = Number(opts && opts.stake) || 0
          // server/client guard: do not allow staking more than (current wordmoney - 1)
          // e.g. if wordmoney is 3, max stake is 2
          const maxStake = gmMode === 'lastTeamStanding' && me.team ? Math.max(0, (Number(teamMoney) || 0) - 1) : Math.max(0, (Number(me.wordmoney) || 0) - 1)
          if (stake > maxStake) {
            setToasts(t => [...t, { id: `pup_err_stake_${Date.now()}`, text: `Stake cannot exceed $${maxStake} (your current wordmoney - 1)` }])
            setPowerUpLoading(false)
            return
          }
          updates[`players/${myId}/doubleDown`] = { active: true, stake }
        } catch (e) {}
      }
      // write a private entry for buyer and target so only they see the result
      const key = `pu_${Date.now()}`
      // store under players/{buyer}/privatePowerReveals/{targetId}/{key} = { powerId, data }
      const data = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  // accumulate any wordmoney awards for the target here and apply once
  let stagedTargetAwardDelta = 0
  // flag to avoid double-awarding buyer when a power-up-specific award was already applied
  let skipBuyerLetterAward = false
      // attach additional results after computing
  // perform server-side or client-side compute for power-up results
  let resultPayload = null
  // tracker for one_random award so we can write a friendly message into the
  // buyer/target privatePowerReveals after we compute awards below
  let oneRandomAward = 0
  // compute some client-side results for immediate write when possible
  const targetNode = (state?.players || []).find(p => p.id === powerUpTarget) || {}
  const targetWord = targetNode.word || ''
  
  const buyerName = playerIdToName[myId] || myId
  const targetName = playerIdToName[powerUpTarget] || powerUpTarget
  const buyerBase = { powerId: 'vowel_vision', ts: Date.now(), from: myId, by: myId, to: powerUpTarget }
  const targetBase = { powerId: 'vowel_vision', ts: Date.now(), from: myId, by: myId, to: powerUpTarget }
  
      if (powerId === 'letter_scope') {
        const letters = (targetWord || '').length
        resultPayload = { letters, message: `Letter Scope: there are ${letters} letter${letters === 1 ? '' : 's'} in the word` }
        
  const buyerMsg = `Letter Scope: Including duplicates, there are ${letters} letter${letters === 1 ? '' : 's'} in the word`
  const targetMsg = `Letter Scope: ${buyerName} used Letter Scope on you`
  // Provide HTML message variants so clients can render styled names/labels
  const buyerMessageHtml = `<strong class="power-name">Letter Scope</strong>: Including duplicates, there are <strong class="revealed-letter">${letters}</strong> letter${letters === 1 ? '' : 's'} in the word`
  const targetMessageHtml = `<strong class="power-name">Letter Scope</strong>: <em>${buyerName}</em> used Letter Scope on you`
  const buyerData = { ...buyerBase, result: { letters, message: buyerMsg, messageHtml: buyerMessageHtml } }
  const targetData = { ...targetBase, result: { letters, message: targetMsg, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData

      } else if (powerId === 'zeta_drop') {
        const last = targetWord ? targetWord.slice(-1) : null
        // Zeta Drop now publicly reveals the last letter (added to target.revealed).
        // Set resultPayload so downstream reveal handling adds it to the public revealed
        // set and awards the buyer if appropriate.
        resultPayload = { last }

        const buyerMsg = `Zeta Drop: last letter is ${last}`
        const targetMsg = `Zeta Drop: ${buyerName} found out the last letter of your word is ${last}`
        // write privatePowerReveals entries for buyer and target so UI can show the results
        const buyerBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
        const targetBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  const buyerMessageHtml = `<strong class="power-name">Zeta Drop</strong>: last letter is <strong class="revealed-letter">${last}</strong>`
  const targetMessageHtml = `<strong class="power-name">Zeta Drop</strong>: <em>${buyerName}</em> found out the last letter of your word is <strong class="revealed-letter">${last}</strong>`
  const buyerData = { ...buyerBase, result: { last, message: buyerMsg, messageHtml: buyerMessageHtml } }
  const targetData = { ...targetBase, result: { last, message: targetMsg, messageHtml: targetMessageHtml } }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData

      } else if (powerId === 'one_random') {
        const letters = (targetWord || '').split('')
        // letters.length > 0 guaranteed since minWordSize >= 2
        const ch = letters[Math.floor(Math.random() * letters.length)]
        resultPayload = { letter: ch }
        const buyerMsg = `One Random Letter: ${ch} in ${targetName}'s word`
        const targetMsg = `One Random Letter: ${buyerName} used One Random Letter on you; they revealed ${ch}`
  const buyerMessageHtml = `<strong class="power-name">One Random Letter</strong>: <strong class="revealed-letter">${ch}</strong> in <em>${targetName}</em>'s word`
  const targetMessageHtml = `<strong class="power-name">One Random Letter</strong>: <em>${buyerName}</em> used One Random Letter on you; they revealed <strong class="revealed-letter">${ch}</strong>`
  const buyerData = { ...buyerBase, result: { letter: ch, message: buyerMsg, messageHtml: buyerMessageHtml } }
  const targetData = { ...targetBase, result: { letter: ch, message: targetMsg, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
      } else if (powerId === 'letter_peek') {
        const pos = Number(opts.pos) || 0
        // shared variables need to be in outer scope so we can reference them below
        let letter = null
        let buyerMsg = null
        let targetMsg = null

        // human-readable short messages; explicitly report no letter at position when invalid
        if (!pos || pos < 1) {
          buyerMsg = `Letter Peek: no letter at position ${opts.pos || pos}`
          targetMsg = `Letter Peek: ${buyerName} used Letter Peek on you; they revealed no letter at position ${opts.pos || pos}`
          resultPayload = { message: `Letter Peek: no letter at position ${opts.pos || pos}`, pos }
        } else {
          letter = (targetWord && targetWord[pos-1]) ? targetWord[pos-1] : null
          if (!letter) {
            resultPayload = { message: `Letter Peek: no letter at position ${pos}`, pos }
            buyerMsg = `Letter Peek: no letter at position ${pos}`
            targetMsg = `${buyerName} used Letter Peek on you; they revealed no letter at position ${pos}`
          } else {
            resultPayload = { message: `Letter Peek: '${letter}' at position ${pos}`, letter, pos }
            buyerMsg = `Letter Peek: '${letter}' at position ${pos}`
            targetMsg = `${buyerName} used Letter Peek on you; they revealed '${letter}' letter at position ${pos}`
          }
        }

      const buyerMessageHtml = `<strong class="power-name">Letter Peek</strong>: <strong class="revealed-letter">'${letter}'</strong> at position <strong class="revealed-letter">${pos}</strong>`
      const targetMessageHtml = `<strong class="power-name">Letter Peek</strong>: <em>${buyerName}</em> used Letter Peek on you; they revealed <strong class="revealed-letter">'${letter}'</strong> at position <strong class="revealed-letter">${pos}</strong>`
      const buyerData = { ...buyerBase, result: { letter: letter, message: buyerMsg, messageHtml: buyerMessageHtml } }
    const targetData = { ...targetBase, result: { letter: letter, message: targetMsg, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }

        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
      } // The Unseen: reveal a single previously unrevealed letter publicly (always public)
      else if (powerId === 'the_unseen') {
        
          const existing = (targetNode.revealed || []).map(x => (x || '').toLowerCase())
          const all = (targetWord || '').toLowerCase().split('').filter(Boolean)
          // pick unique unrevealed letters
          const uniques = Array.from(new Set(all)).filter(ch => !existing.includes(ch))
          let picked = null
          if (uniques.length > 0) picked = uniques[Math.floor(Math.random() * uniques.length)]
          // if none left, fallback to any letter
          if (!picked && all.length > 0) picked = all[Math.floor(Math.random() * all.length)]
          if (picked) {
            // Always perform a public reveal: add letter to revealed (all occurrences), award buyer for newly revealed occurrences
            resultPayload = { letter: picked }
            // buyer/target private messages to describe the public reveal
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const buyerMsgLocal = `The Unseen: revealed '${picked}' from ${targetName}'s word`
            const targetMsgLocal = `The Unseen: ${buyerName} revealed '${picked}' from your word publicly`
            const buyerMessageHtml = `<strong class="power-name">The Unseen</strong>: revealed <strong class="revealed-letter">${picked}</strong> from <em>${targetName}</em>'s word.`
            const targetMessageHtml = `<strong class="power-name">The Unseen</strong>: <em>${buyerName}</em> revealed <strong class="revealed-letter">${picked}</strong> from your word.`
            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { letter: picked, message: buyerMsgLocal, messageHtml: buyerMessageHtml } }
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { letter: picked, message: targetMsgLocal, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
          } else {
            // no letter could be found
            const buyerMessageHtml = `<strong class="power-name">The Unseen</strong>: No letters left to reveal from <em>${targetName}</em>'s word.`
            const targetMessageHtml = `<strong class="power-name">The Unseen</strong>: <em>${buyerName}</em> revealed <strong class="revealed-letter">${picked}</strong> from your word.`
            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: { message: `The Unseen: no unrevealed letters available`, messageHtml: buyerMessageHtml } }
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: { message: `${buyerName} used The Unseen on you; no letters available`, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
          }
       
      } else if (powerId === 'related_word') {
        // Related word: use Datamuse rel_trg (related target words) and return a short word word
        let buyerMsg = `Related Word: no result found`
        let targetMsg = `Related Word: ${buyerName} used Related Word on you. They revealed no related word`
        let datamuseDown = false;
        let candidate = null;
        // fetch related words from Datamuse API
        
        const q = encodeURIComponent(targetWord || '')
        const url = `https://api.datamuse.com/words?rel_trg=${q}&max=1`
        const res = await fetch(url)
        console.log('Related Word fetch', res)
        if (res && res.ok) {
          const list = await res.json()
          const words = Array.isArray(list) ? list.map(i => i.word).filter(Boolean) : []
          candidate = words.find(w => w.toLowerCase() !== (targetWord || '').toLowerCase())
          
            if (candidate) {
              buyerMsg = `Related Word: '${candidate}'.`
              targetMsg = `Related Word: ${buyerName} used Related Word on you and revealed '${candidate}' as a related word.`
              const buyerMessageHtml = `<strong class="power-name">Related Word</strong>: '<strong class="revealed-letter">${candidate}</strong>'`
              const targetMessageHtml = `<strong class="power-name">Related Word</strong>: <em>${buyerName}</em> used Related Word on you and revealed '<strong class="revealed-letter">${candidate}</strong>' as a related word.`
              const buyerDataLocal = { ...buyerBase, result: { message: buyerMsg, messageHtml: buyerMessageHtml } }
              const targetDataLocal = { ...targetBase, result: { message: targetMsg, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
              updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerDataLocal
              updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetDataLocal
              // explicit entries written above; fall through so default writer won't overwrite them (it checks for existing keys)
            }
        }
        else if (res && res.status !== 404) {
        // treat non-404 errors as API being down
        datamuseDown = true;
        console.warn('Datamuse API error ', res);
      }
      

      if (!candidate){
        // If no related-word candidate was found, reveal up to 2 previously unrevealed
        // letters from the target's word publicly and award the buyer for any newly
        // revealed occurrences (2 points per occurrence). Provide a friendly
        // private message using the requested wording.
        
          const existing = (targetNode.revealed || []).map(x => (x || '').toLowerCase())
          const existingSet = new Set(existing)
          const allLetters = (targetWord || '').toLowerCase().split('').filter(Boolean)
          // find unique unrevealed letters
          const uniques = Array.from(new Set(allLetters)).filter(ch => !existingSet.has(ch))
          // pick up to 2 letters at random from uniques
          const pickCount = Math.min(2, uniques.length)
          const picked = []
          const pool = uniques.slice()
          while (picked.length < pickCount && pool.length > 0) {
            const idx = Math.floor(Math.random() * pool.length)
            picked.push(pool.splice(idx,1)[0])
          }
            // add picked letters to public revealed set
            const newRevealedSet = new Set([...(existing || []), ...picked])
            updates[`players/${powerUpTarget}/revealed`] = Array.from(newRevealedSet)

            // compute award for buyer: 2 points per occurrence of each picked letter

              const meNow = (state?.players || []).find(p => p.id === myId) || {}
              const baseAfterCostNow = ((gmMode === 'lastTeamStanding' && me.team)
                ? (typeof updates[`teams/${me.team}/wordmoney`] !== 'undefined' ? updates[`teams/${me.team}/wordmoney`] : Number(teamMoney) - cost)
                : (typeof updates[`players/${myId}/wordmoney`] !== 'undefined' ? updates[`players/${myId}/wordmoney`] : (Number(meNow.wordmoney) || 0) - cost)
              )
              let awardTotal = 0
              const prevHitsNow = (meNow.privateHits && meNow.privateHits[powerUpTarget]) ? meNow.privateHits[powerUpTarget].slice() : []
              picked.forEach(letter => {
                
                  const count = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === letter).length
                  if (count > 0) {
                    awardTotal += 2 * count
                    // merge into privateHits
                    let merged = false
                    for (let i = 0; i < prevHitsNow.length; i++) {
                      const h = prevHitsNow[i]
                      if (h && h.type === 'letter' && h.letter === letter) {
                        prevHitsNow[i] = { ...h, count: (Number(h.count) || 0) + count, ts: Date.now() }
                        merged = true
                        break
                      }
                    }
                    if (!merged) prevHitsNow.push({ type: 'letter', letter, count, ts: Date.now() })
                  }
              })
              if (awardTotal > 0) {
                // Use helper to credit team or player wallet and set lastGain
                applyAward(updates, myId, awardTotal, { reason: powerId, by: powerUpTarget })
                updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHitsNow
              }

            // compose messages for buyer and target describing the picked letters
            const letterList = picked.map(l => `<strong class="revealed-letter">${l}</strong>`).join(picked.length === 2 ? ' and ' : ', ')
            let buyerHtml
            let targetHtml
            let buyerMsgLocal
            let targetMsgLocal
            if (picked.length === 2) {
              buyerHtml = `<strong class="power-name">Related Word</strong>: I don't know a related word, but here are 2 previously unrevealed letters: ${letterList}`
              targetHtml = `<strong class="power-name">Related Word</strong>: <em>${buyerName}</em> tried Related Word but got no definition; we revealed ${letterList} publicly.`
              buyerMsgLocal = `I don't know the definition, but here are 2 previously unrevealed letters: ${picked.join(', ')}`
              targetMsgLocal = `${buyerName} used Related Word; no definition was found, and we revealed ${picked.join(', ')} publicly.`
            } else if (picked.length === 1) {
              // single remaining unrevealed letter : use the 'last letter' phrasing
              const theLetter = picked[0]
              buyerHtml = `<strong class="power-name">Related Word</strong>: I don't know a related word, but here is the last letter that is unrevealed: <strong class="revealed-letter">${theLetter}</strong>`
              targetHtml = `<strong class="power-name">Related Word</strong>: <em>${buyerName}</em> tried Related Word but got no definition; we revealed the last unrevealed letter <strong class="revealed-letter">${theLetter}</strong> publicly.`
              buyerMsgLocal = `I don't know a related word, but here is the last letter that is unrevealed: ${theLetter}`
              targetMsgLocal = `${buyerName} used Related Word; no definition was found, and we revealed the last unrevealed letter ${theLetter} publicly.`
            } else {
              // picked.length === 0 : all letters already revealed
              buyerHtml = `<strong class="power-name">Related Word</strong>: I don't know a related word, and all the letters of the word are revealed, so I can't help with more letters!`
              targetHtml = `<strong class="power-name">Related Word</strong>: <em>${buyerName}</em> tried Related Word but no definition was found; all letters are already revealed.`
              buyerMsgLocal = `I don't know a related word, and all the letters of the word are revealed, so I can't help with more letters!`
              targetMsgLocal = `${buyerName} used Related Word; no definition was found and all letters are already revealed.`
            }

            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBase, result: { message: buyerMsgLocal, messageHtml: buyerHtml, letters: picked } }
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBase, result: { message: targetMsgLocal, messageHtml: targetHtml, letters: picked, teamOnly: (gmMode === 'lastTeamStanding') } }

      }
        

        
      } else if (powerId === 'dice_of_doom') {
        const roll = Math.floor(Math.random() * 6) + 1
        // Pick up to `roll` distinct letters (unique characters) from the target word.
        // Previously we sampled indices which could produce the same character multiple
        // times if the word contains repeated letters (e.g. "boot" -> 'o' twice).
        const wordChars = (targetWord || '').toLowerCase().split('').filter(Boolean)
        const uniqueChars = Array.from(new Set(wordChars))
        const revealCount = Math.min(uniqueChars.length, roll)
        const revealedLetters = []
        const available = uniqueChars.slice()
        while (revealedLetters.length < revealCount && available.length > 0) {
          const idx = Math.floor(Math.random() * available.length)
          revealedLetters.push(available.splice(idx, 1)[0])
        }
        resultPayload = { roll, letters: revealedLetters }
        // write explicit buyer/target privatePowerReveals so buyer always sees result
        
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = (revealedLetters && revealedLetters.length > 0) ? `Dice of Doom: revealed ${revealedLetters.join(', ')}` : `Dice of Doom: no letters could be revealed`
          const targetMsgLocal = (revealedLetters && revealedLetters.length > 0) ? `Dice of Doom: ${buyerName} used Dice of Doom on you; they revealed ${revealedLetters.join(', ')}` : `${buyerName} used Dice of Doom on you; no letters were revealed`
          const revealedHtml = (revealedLetters && revealedLetters.length > 0) ? revealedLetters.map(l => `<strong class="revealed-letter">${l}</strong>`).join(', ') : null
          const buyerMessageHtml = revealedHtml ? `<strong class="power-name">Dice of Doom</strong>: Rolled ${roll}, revealed ${revealedHtml}` : `<strong class="power-name">Dice of Doom</strong>: rolled ${roll}, but no letters could be revealed`
          const targetMessageHtml = revealedHtml ? `<strong class="power-name">Dice of Doom</strong>: <em>${buyerName}</em> used Dice of Doom on you; they revealed ${revealedHtml}` : `<strong class="power-name">Dice of Doom</strong>: <em>${buyerName}</em> used Dice of Doom on you; no letters were revealed`
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal, messageHtml: buyerMessageHtml } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
       
      } else if (powerId === 'all_letter_reveal') {
        resultPayload = { letters: (targetWord || '').split('').sort(() => Math.random()-0.5) }
        // also reveal all letters publicly (but shuffled order is kept in private payload)
        const existingAll = targetNode.revealed || []
        const allLetters = Array.from(new Set(((targetWord || '').toLowerCase().split('').filter(Boolean))))
        updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existingAll || []), ...allLetters]))
        // buyer/target private messages for all_letter_reveal
        try {
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = `All Letters: revealed all letters from ${targetName}'s word`
          const targetMsgLocal = `All Letters: ${buyerName} revealed all letters of your word publicly`
          const buyerMessageHtml = `<strong class="power-name">All The Letters</strong>: revealed all letters from <em>${targetName}</em>'s word`
          const targetMessageHtml = `<strong class="power-name">All The Letters</strong>: <em>${buyerName}</em> revealed all letters of your word publicly`
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal, messageHtml: buyerMessageHtml } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
        } catch (e) {}
        } else if (powerId === 'split_15') {
          // If the target word has 15+ letters, reveal the first half publicly and
          // award the buyer for any newly-unrevealed occurrences in that half.
          try {
            const w = (targetWord || '')
            if (w && w.length >= 15) {
              const half = Math.floor(w.length / 2)
              const firstHalf = w.slice(0, half).toLowerCase().split('').filter(Boolean)
              // prepare resultPayload exposing the letters (unique)
              const letters = Array.from(new Set(firstHalf))
              resultPayload = { letters }

              // write buyer/target privatePowerReveals
              const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              const buyerMsgLocal = `Split 15: revealed first ${half} letters of ${targetName}'s word`
              const targetMsgLocal = `Split 15: ${buyerName} used Split 15 on you; the first ${half} letters were revealed publicly`
              const buyerMessageHtml = `<strong class="power-name">Split 15</strong>: revealed first <strong class="revealed-letter">${half}</strong> letters of <em>${targetName}</em>'s word`
              const targetMessageHtml = `<strong class="power-name">Split 15</strong>: <em>${buyerName}</em> used Split 15 on you; the first <strong class="revealed-letter">${half}</strong> letters were revealed publicly`
              updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { letters, message: buyerMsgLocal, messageHtml: buyerMessageHtml } }
              updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { letters, message: targetMsgLocal, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }

              // add letters to revealed set (preserve any existing revealed letters)
              const existing = targetNode.revealed || []
              const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
              const toAdd = letters.map(ch => (ch || '').toLowerCase()).filter(Boolean)
              const newRevealed = Array.from(new Set([...(existing || []), ...toAdd]))
              updates[`players/${powerUpTarget}/revealed`] = newRevealed

              // Award buyer for newly revealed occurrences (2 per occurrence)
              try {
                const meNow = (state?.players || []).find(p => p.id === myId) || {}
                const baseAfterCostNow = ((gmMode === 'lastTeamStanding' && me.team)
                  ? (typeof updates[`teams/${me.team}/wordmoney`] !== 'undefined' ? updates[`teams/${me.team}/wordmoney`] : Number(teamMoney) - cost)
                  : (typeof updates[`players/${myId}/wordmoney`] !== 'undefined' ? updates[`players/${myId}/wordmoney`] : (Number(meNow.wordmoney) || 0) - cost)
                )
                let awardTotal = 0
                const prevHitsNow = (meNow.privateHits && meNow.privateHits[powerUpTarget]) ? meNow.privateHits[powerUpTarget].slice() : []
                toAdd.forEach(letter => {
                  try {
                    if (!existingSet.has(letter)) {
                      const count = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === letter).length
                      if (count > 0) {
                        awardTotal += 2 * count
                        // merge into privateHits
                        let merged = false
                        for (let i = 0; i < prevHitsNow.length; i++) {
                          const h = prevHitsNow[i]
                          if (h && h.type === 'letter' && h.letter === letter) {
                            prevHitsNow[i] = { ...h, count: (Number(h.count) || 0) + count, ts: Date.now() }
                            merged = true
                            break
                          }
                        }
                        if (!merged) prevHitsNow.push({ type: 'letter', letter, count, ts: Date.now() })
                      }
                    }
                  } catch (e) {}
                })
                if (awardTotal > 0) {
                  applyAward(updates, myId, awardTotal, { reason: powerId, by: powerUpTarget })
                  updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHitsNow
                }
              } catch (e) {}
            } else {
              // word too short: write buyer/target messages indicating nothing happened
              const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
              const buyerMsgShort = `Split 15: target word is shorter than 15 letters; no effect`
              const targetMsgShort = `Split 15 Side Effect: ${buyerName} used Split 15 on you; but your word is too short for anything to be revealed :)`
              const buyerMessageHtmlShort = `<strong class="power-name">Split 15</strong>: target word is shorter than <strong class="revealed-letter">15</strong> letters; no effect`
              const targetMessageHtmlShort = `<strong class="power-name">Split 15</strong>: <em>${buyerName}</em> used Split 15 on you; but your word is too short for anything to be revealed :)`
              updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { message: buyerMsgShort, messageHtml: buyerMessageHtmlShort } }
              updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { message: targetMsgShort, messageHtml: targetMessageHtmlShort, teamOnly: (gmMode === 'lastTeamStanding') } }
            }
          } catch (e) {}
      } else if (powerId === 'full_reveal') {
        resultPayload = { full: targetWord }
        // reveal whole word publicly
        const existingFull = targetNode.revealed || []
        const allLettersFull = Array.from(new Set(((targetWord || '').toLowerCase().split('').filter(Boolean))))
        updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existingFull || []), ...allLettersFull]))
        // buyer/target private messages for full_reveal
        try {
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = `Full Reveal: revealed ${targetName}'s word: ${targetWord}`
          const targetMsgLocal = `Full Reveal Side Effect: ${buyerName} used Full Reveal on you; your word was revealed publicly`
          const buyerMessageHtml = `<strong class="power-name">Full Reveal</strong>: revealed <em>${targetName}</em>'s word: <strong class="revealed-letter">${targetWord}</strong>`
          const targetMessageHtml = `<strong class="power-name">Full Reveal</strong>: <em>${buyerName}</em> used Full Reveal on you; your word was revealed publicly`
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal, messageHtml: buyerMessageHtml } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
        } catch (e) {}
      } else if (powerId === 'sound_check' || powerId === 'what_do_you_mean') {
        // sound_check: return exactly one rhyming word (Datamuse rel_rhy) that isn't the exact target
        // what_do_you_mean: return similar-meaning suggestions (ml) as before
        try {
          const q = encodeURIComponent(targetWord || '')
          if (powerId === 'sound_check') {
            // use RhymeBrain for rhymes; return a single rhyme that's not identical
            try {
              const url = `https://rhymebrain.com/talk?function=getRhymes&word=${q}`
              const res2 = await fetch(url)
              if (res2 && res2.ok) {
                const list2 = await res2.json()
                const words2 = Array.isArray(list2) ? list2.map(i => i.word).filter(Boolean) : []
                const candidate = words2.find(w => w.toLowerCase() !== (targetWord || '').toLowerCase())
                resultPayload = { suggestions: candidate ? [candidate] : [] }
              } else resultPayload = { suggestions: [] }
            } catch (e) {
              // fallback to empty
              resultPayload = { suggestions: [] }
            }
            } else {
            // what_do_you_mean: fetch a single English definition (dictionaryapi.dev). Do NOT include the word itself in the response.
            try {
              const raw = (targetWord || '').toString().trim()
              if (!raw) {
                resultPayload = { message: "I don't know the definition!" }
              } else {
                // Attempt dictionary lookup. Try the local proxy first (/api/dictionary).
                // If that fails, try the upstream Free Dictionary API directly as a fallback.
                // Prefer a definition that does NOT contain the target word; otherwise sanitize it.
                async function fetchDefinitions(url) {
                  try {
                    const r = await fetch(url)
                    if (r && r.ok) {
                      const j = await r.json()
                      return Array.isArray(j) ? j : null
                    }
                  } catch (e) {
                    // swallow and return null so caller can try fallback
                  }
                  return null
                }


                const response = await fetch(
                  `https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(raw)}?`
                );
                console.log('FreeDictionaryAPI response status:', response.status);

                if (!response.ok && response.status !== 404) {
                  freeDictDown = true
                }

                const data = await response.json();
                console.log('FreeDictionaryAPI response data:', data);

                // Check if we got a valid entry with definitions
                const isValid = data.entries.length > 0;

                if (isValid) {
                  console.log(`Found definitions for "${raw}":`, data);

                  data.entries?.some(entry =>
                    entry.senses?.some(sense => {
                      const defs = [sense.definition];
                  

                        
                        // Enhanced definition selection + sanitization
                        const badWords = ['penis','vagina', 'fuck'].map(s => s.toLowerCase())
                        // First pass: prefer a def that does NOT include the raw word and contains NO bad words
                        let picked = null
                        for (const def of defs) {
                          try {
                          const dLow = (def || '').toString().toLowerCase()
                          if (raw && dLow.includes(raw.toLowerCase())) continue
                          const hasBad = badWords.some(b => dLow.includes(b))
                          if (hasBad) continue
                          picked = { rawDef: def }
                          break
                          } catch (e) { /* ignore and continue */ }
                        }
                        if (picked) {
                          resultPayload = { message: picked.rawDef }
                          return true
                        }

                        // Second pass: find a def that includes the raw word and produce a redacted HTML variant.
                        for (const def of defs) {
                          try {
                          const d = (def || '').toString()
                          const dLow = d.toLowerCase()
                          if (!raw || !dLow.includes(raw.toLowerCase())) continue

                          // Replace foul words with "[foul word]" (case-insensitive, whole-word)
                          let sanitized = d
                          try {
                            const foulRe = new RegExp(`\\b(${badWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})\\b`, 'ig')
                            sanitized = sanitized.replace(foulRe, '[foul word]')
                          } catch (e) {}

                          // Replace occurrences of the raw word with a visible redaction for dark backgrounds.
                          // Use a strong tag with a readable color; keep a plain-text fallback.
                          try {
                            const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                            const rawRe = new RegExp(`\\b${escaped}\\b`, 'ig')
                            const redactedHtml = `<strong style="color:#ff7b72">[redacted word]</strong>`
                            const messageHtml = sanitized.replace(rawRe, redactedHtml)
                            resultPayload = { message: sanitized.replace(new RegExp(`\\b${escaped}\\b`, 'ig'), '[redacted word]'), messageHtml }
                          } catch (e) {
                            // fallback if regex fails
                            resultPayload = { message: sanitized }
                          }
                          return true
                          } catch (e) { /* continue */ }
                        }

                        // Final fallback: pick the first available def but sanitize foul words
                        for (const def of defs) {
                          try {
                          let sanitized = (def || '').toString()
                          try {
                            const foulRe = new RegExp(`\\b(${badWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})\\b`, 'ig')
                            sanitized = sanitized.replace(foulRe, '[foul word]')
                          } catch (e) {}
                          resultPayload = { message: sanitized }
                          return true
                          } catch (e) {}
                        }
                        return false
                        
                    })
                  );
                } else {
                  // try api/dicitonary

                try {
                  const proxyUrl = `/api/dictionary?word=${encodeURIComponent(raw)}`
                  let ddata = await fetchDefinitions(proxyUrl)

                  // extract candidate definitions (strings) from the response
                  let candidates = []
                  if (Array.isArray(ddata) && ddata.length > 0) {
                    for (const entry of ddata) {
                      if (!entry || !entry.meanings) continue
                      for (const meaning of entry.meanings || []) {
                        if (!meaning || !Array.isArray(meaning.definitions)) continue
                        for (const d of meaning.definitions) {
                          if (d && d.definition && typeof d.definition === 'string' && d.definition.trim().length > 0) {
                            candidates.push(d.definition.trim())
                          }
                        }
                      }
                    }
                  }

                  if (candidates.length === 0) {
                    resultPayload = { message: "I don't know the definition." }
                  } else {
                    // prefer a definition that does not include the target word (as a whole word, case-insensitive)
                    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    const wholeRe = new RegExp(`\\b${escaped}\\b`, 'i')
                    let pick = candidates.find(c => !wholeRe.test(c)) || candidates[0]
                    // If pick contains the word, sanitize exact whole-word occurrences by replacing with a neutral token
                    try {
                      const sanitizeRe = new RegExp(`\\b${escaped}\\b`, 'ig')
                      if (sanitizeRe.test(pick)) {
                        pick = pick.replace(sanitizeRe, 'the word')
                      }
                    } catch (e) {}
                    // keep message concise: single sentence if possible
                    const oneSentence = (pick || '').split(/[\.\!\?]\s/)[0]
                    resultPayload = { message: oneSentence || pick }
                  }
                } catch (e) {
                  console.warn(e);
                  resultPayload = { message: "I don't know the definition." }
                }
              }
              }
            } catch (e) {
              console.warn(e);
              resultPayload = { message: "I don't know the definition :(" }
            }
          }
        } catch (e) {
          resultPayload = { suggestions: [] }
        }
        // Write buyer/target messages for sound_check / definition lookup so buyer sees a friendly result
        try {
          const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMsgLocal = (powerId === 'sound_check')
            ? `Sound Check: sounds similar to ${((resultPayload && resultPayload.suggestions) || []).slice(0,3).join(', ') || 'none'}`
            : `Definition: ${((resultPayload && resultPayload.message) || "I don't know the definition.")}`
          const targetMsgLocal = (powerId === 'sound_check')
            ? `Sound Check Side Effect: ${buyerName} knows your word sounds similar to ${((resultPayload && resultPayload.suggestions) || []).slice(0,3).join(', ') || '... well, they don\'t know. Wanna give them a hint?'}`
            : `What Do You Mean Side Effect: ${buyerName} knows your word's definition is: ${((resultPayload && resultPayload.message) || "... well, they don't know it. Wanna give them a hint?")}`

          // HTML variants for client rendering (use CSS classes defined in src/styles.css)
          const buyerMessageHtml = (powerId === 'sound_check')
            ? `<strong class="power-name">Sound Check</strong>: sounds similar to ${((resultPayload && resultPayload.suggestions) || []).slice(0,3).map(s => String(s)).join(', ') || 'none'}`
            : `<strong class="power-name">Definition</strong>: ${((resultPayload && resultPayload.message) || "I don't know the definition.")}`
          const targetMessageHtml = (powerId === 'sound_check')
            ? `<strong class="power-name">Sound Check</strong>: <em>${buyerName}</em> knows your word sounds similar to ${((resultPayload && resultPayload.suggestions) || []).slice(0,3).map(s => String(s)).join(', ') || '... well, they don\'t know. Wanna give them a hint?'}`
            : `<strong class="power-name">Definition</strong>: <em>${buyerName}</em> knows your word's definition is: ${((resultPayload && resultPayload.message) || "... well, they don't know it. Wanna give them a hint?")}`

          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { ...(resultPayload || {}), message: buyerMsgLocal, messageHtml: buyerMessageHtml } }
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { ...(resultPayload || {}), message: targetMsgLocal, messageHtml: targetMessageHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
        } catch (e) {}
      } else if (powerId === 'mind_leech') {
        // Mind leech: use letters others have guessed for the buyer's own word
        // (buyerNode.guessedBy keys) to simulate those same guesses against the target's word.
        
          const buyerNode = (state?.players || []).find(p => p.id === myId) || {}
          const guessedBy = buyerNode.guessedBy || {}
          // keys in guessedBy map are letters (or '__word'); ignore '__word'
          const attemptedSet = new Set(Object.keys(guessedBy || {}).filter(k => k && k !== '__word').map(k => k.toLowerCase()))

          // ALSO include any letters revealed to the buyer via power-ups recorded in
          // buyerNode.privateHits. These entries can include single-letter
          // fields (letter, last, letterFromBuyer, letterFromTarget), arrays (letters),
          // or found arrays (objects with .letter). Add all discovered letters to the
          // attempted set so Mind Leech uses them when probing the target word.
          try {
            const ppr = buyerNode.privateHits || {}
            Object.keys(ppr || {}).forEach(bucket => {
              const entries = ppr[bucket] || {}
              Object.values(entries || {}).forEach(entry => {
                try {
                  if (!entry || !entry.result) return
                  const res = entry.result || {}
                  const push = (v) => { try { if (v) attemptedSet.add(String(v).toLowerCase()) } catch (e) {} }
                  if (res.letter) push(res.letter)
                  if (res.last) push(res.last)
                  if (res.letterFromBuyer) push(res.letterFromBuyer)
                  if (res.letterFromTarget) push(res.letterFromTarget)
                  if (Array.isArray(res.letters)) res.letters.forEach(ch => push(ch))
                  if (Array.isArray(res.found)) res.found.forEach(f => { if (f && f.letter) push(f.letter) })
                } catch (e) {}
              })
            })
          } catch (e) {}

          // ALSO include any letters already publicly revealed on the buyer's own word
          // (buyerNode.revealed). These should be considered attempted as the buyer
          // effectively 'knows' these letters and wants to probe whether they exist
          // in the target's word as well.
          try {
            const revealedLetters = buyerNode.revealed || []
            if (Array.isArray(revealedLetters)) {
              revealedLetters.forEach(ch => { try { if (ch) attemptedSet.add(String(ch).toLowerCase()) } catch (e) {} })
            }
          } catch (e) {}
          const letters = (targetWord || '').toLowerCase().split('')
          // Build a stable, sorted attempted array for display and deterministic behavior
          const attemptedArray = Array.from(attemptedSet).filter(Boolean).map(x => (x || '').toString().toLowerCase())
          attemptedArray.sort()
          const found = []
          attemptedArray.forEach(l => {
            const count = letters.filter(ch => ch === l).length
            if (count > 0) found.push({ letter: l, count })
          })

          // Build human-friendly messages that explicitly state which letters were tried
          const triedDisplay = attemptedArray.length > 0 ? attemptedArray.join(', ') : 'none'
          const buyerMsg = (found && found.length > 0)
            ? `Mind Leech: tried ${triedDisplay}; found ${found.map(f => `${f.letter} (${f.count})`).join(', ')} in ${targetName}'s word`
            : `Mind Leech: tried ${triedDisplay}; no letters from your word matched ${targetName}'s word`
          const targetMsg = (found && found.length > 0)
            ? `Mind Leech Side Effect: ${buyerName} found ${found.map(f => `${f.letter} (${f.count})`).join(', ')}`
            : `Mind Leech Side Effect: ${buyerName} used Mind Leech on you; They found no matching letters :)`

          // write privatePowerReveals entries for buyer and target so UI can show the results
          const buyerBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const targetBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          const buyerMessageHtml = (found && found.length > 0)
            ? `<strong class="power-name">Mind Leech</strong>: tried ${attemptedArray.length ? attemptedArray.map(x => `<strong class=\"revealed-letter\">${x}</strong>`).join(', ') : 'none'}; found ${found.map(f => `<strong class=\"revealed-letter\">${f.letter}</strong> (${f.count})`).join(', ')} in <em>${targetName}</em>'s word`
            : `<strong class="power-name">Mind Leech</strong>: tried ${attemptedArray.length ? attemptedArray.map(x => `<strong class=\"revealed-letter\">${x}</strong>`).join(', ') : 'none'}; no letters from your word matched <em>${targetName}</em>'s word`
          const targetMessageHtml = (found && found.length > 0)
            ? `<strong class="power-name">Mind Leech</strong> Side Effect: <em>${buyerName}</em> found ${found.map(f => `<strong class=\"revealed-letter\">${f.letter}</strong> (${f.count})`).join(', ')}`
            : `<strong class="power-name">Mind Leech</strong> Side Effect: <em>${buyerName}</em> used Mind Leech on you; they found no matching letters :)`

          const buyerData = { ...buyerBase, result: { found, attempted: attemptedArray, message: buyerMsg, messageHtml: buyerMessageHtml } }
          const targetData = { ...targetBase, result: { found, attempted: attemptedArray, message: targetMsg, messageHtml: targetMessageHtml } }
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData

          // Award buyer points for any newly-revealed occurrences (2 per occurrence) that were not
          // already publicly revealed or privately revealed to this buyer previously.
          try {
            const targetExisting = (targetNode && targetNode.revealed) ? targetNode.revealed : []
            const targetExistingSet = new Set((targetExisting || []).map(x => (x || '').toLowerCase()))

            // check buyer's previous private reveals sent to this target
            const buyerPrivateBucket = (buyerNode.privatePowerReveals && buyerNode.privatePowerReveals[powerUpTarget]) ? Object.values(buyerNode.privatePowerReveals[powerUpTarget]) : []
            const wasPrivatelyRevealed = (letterLower) => {
              try {
                for (const r of buyerPrivateBucket) {
                  if (!r || !r.result) continue
                  const res = r.result
                  const check = (s) => (s || '').toString().toLowerCase() === letterLower
                  if (res.letterFromTarget && check(res.letterFromTarget)) return true
                  if (res.letterFromBuyer && check(res.letterFromBuyer)) return true
                  if (res.letter && check(res.letter)) return true
                  if (res.last && check(res.last)) return true
                  if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(letterLower)) return true
                  if (res.found && Array.isArray(res.found) && res.found.map(x => (x && x.letter || '').toString().toLowerCase()).includes(letterLower)) return true
                }
              } catch (e) {}
              return false
            }

            let awardTotal = 0
            const meNow = (state?.players || []).find(p => p.id === myId) || {}
            const prevHitsNow = (meNow.privateHits && meNow.privateHits[powerUpTarget]) ? meNow.privateHits[powerUpTarget].slice() : []
            for (const f of (found || [])) {
              try {
                const letter = (f && f.letter) ? (f.letter || '').toString() : null
                if (!letter) continue
                const lower = letter.toLowerCase()
                if (targetExistingSet.has(lower)) continue
                if (wasPrivatelyRevealed(lower)) continue
                const count = Number(f.count) || 0
                if (count <= 0) continue
                const add = 2 * count
                awardTotal += add
                // merge into privateHits for buyer
                let mergedNow = false
                for (let i = 0; i < prevHitsNow.length; i++) {
                  const h = prevHitsNow[i]
                  if (h && h.type === 'letter' && h.letter === lower) {
                    prevHitsNow[i] = { ...h, count: (Number(h.count) || 0) + count, ts: Date.now() }
                    mergedNow = true
                    break
                  }
                }
                if (!mergedNow) prevHitsNow.push({ type: 'letter', letter: lower, count, ts: Date.now() })
              } catch (e) {}
            }

            if (awardTotal > 0) {
              // Centralized credit that respects lastTeamStanding team wallets and records lastGain
              applyAward(updates, myId, awardTotal, { reason: powerId, by: powerUpTarget })
              updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHitsNow
            }
          } catch (e) {}
       
          // Also merge the discovered letters into the target's public revealed array
          // so they appear in the target's "revealed" div for all viewers.
          try {
            if (found && Array.isArray(found) && found.length > 0) {
              const existing = (targetNode && Array.isArray(targetNode.revealed)) ? targetNode.revealed.slice() : []
              const existingCounts = {}
              try { existing.forEach(ch => { const l = (ch || '').toString().toLowerCase(); existingCounts[l] = (existingCounts[l] || 0) + 1 }) } catch (e) {}
              const updated = existing.slice()
              for (const f of (found || [])) {
                try {
                  const letter = (f && f.letter) ? (f.letter || '').toString().toLowerCase() : null
                  const count = Number(f.count) || 0
                  if (!letter || count <= 0) continue
                  const already = existingCounts[letter] || 0
                  const need = Math.max(0, count - already)
                  for (let i = 0; i < need; i++) updated.push(letter)
                  existingCounts[letter] = (existingCounts[letter] || 0) + need
                } catch (e) {}
              }
              updates[`players/${powerUpTarget}/revealed`] = updated
            }
          } catch (e) {}

      } else if (powerId === 'vowel_vision') {
    // Include a human-readable message for buyer and target, visible only to them.
    // Explicitly include powerId, from and by fields so PlayerCircle's visiblePrivatePowerReveals
    // recognizes the entry as a power-up result (same pattern as letter_for_letter).
    const vowels = (targetWord.match(/[aeiou]/ig) || []).length
    resultPayload = { vowels }
  const buyerMsg = `Vowel Vision: There ${vowels === 1 ? 'is' : 'are'} ${vowels} vowel${vowels === 1 ? '' : 's'} in ${targetName}'s word.`
  const targetMsg = `Vowel Vision: ${buyerName} knows there ${vowels === 1 ? 'is' : 'are'} ${vowels} vowel${vowels === 1 ? '' : 's'} from your word.`
  const buyerMessageHtml = `<strong class="power-name">Vowel Vision</strong>: There ${vowels === 1 ? 'is' : 'are'} <strong class="revealed-letter">${vowels}</strong> vowel${vowels === 1 ? '' : 's'} in <em>${targetName}</em>'s word.`
  const targetMessageHtml = `<strong class="power-name">Vowel Vision</strong>: <em>${buyerName}</em> knows there ${vowels === 1 ? 'is' : 'are'} <strong class="revealed-letter">${vowels}</strong> vowel${vowels === 1 ? '' : 's'} in your word.`
  const buyerData = { ...buyerBase, result: { vowels, message: buyerMsg, messageHtml: buyerMessageHtml } }
  const targetData = { ...targetBase, result: { vowels, message: targetMsg, messageHtml: targetMessageHtml } }
    updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
    updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
  } else if (powerId === 'letter_for_letter') {
        // reveal one random letter from the target's word publicly,
        // AND privately reveal one random letter from the buyer's own word to the target.
        // Award points to both players for any newly revealed occurrences (2 wordmoney per occurrence).
  const targetLetters = (targetWord || '').split('')
  const tletter = targetLetters.length > 0 ? targetLetters[Math.floor(Math.random() * targetLetters.length)] : null
  // pick a random letter from the buyer's own word to privately reveal to the target
  const buyerNodeForPick = (state?.players || []).find(p => p.id === myId) || {}
  const buyerLetters = (buyerNodeForPick.word || '').split('')
  const bletter = buyerLetters.length > 0 ? buyerLetters[Math.floor(Math.random() * buyerLetters.length)] : null
  // prepare asymmetric payloads
  let buyerResultPayload = null // what buyer (myId) will see about the target
  let targetResultPayload = null // what target will see about the buyer
  // public reveal payload for the target (so downstream code that handles resultPayload.letter applies awards)
  let resultPayload = null
  if (tletter) resultPayload = { letter: tletter }
  if (tletter) buyerResultPayload = { letterFromTarget: tletter }
  if (bletter) targetResultPayload = { letterFromBuyer: bletter }
        // determine awards (they were applied earlier into updates[].wordmoney when applicable)
        // For buyer: if buyerResultPayload.letterFromTarget exists, compute how many occurrences in targetWord
        let buyerAward = 0
        let buyerLetter = null
        if (buyerResultPayload && buyerResultPayload.letterFromTarget) {
          buyerLetter = (buyerResultPayload.letterFromTarget || '').toString()
          const lower = buyerLetter.toLowerCase()
          const count = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === lower).length
          // Only count award if the target did not already have this letter publicly revealed
          // and the buyer hasn't already privately revealed this same letter to the target.
          const targetExisting = (targetNode && targetNode.revealed) ? targetNode.revealed : []
          const targetExistingSet = new Set((targetExisting || []).map(x => (x || '').toLowerCase()))
          // check buyer's previous private reveals sent to this target
          const buyerNodeForCheck = (state?.players || []).find(p => p.id === myId) || {}
          const buyerPrivateBucket = (buyerNodeForCheck.privatePowerReveals && buyerNodeForCheck.privatePowerReveals[powerUpTarget]) ? Object.values(buyerNodeForCheck.privatePowerReveals[powerUpTarget]) : []
          const letterWasPrivatelyRevealedByBuyer = (function() {
            try {
              for (const r of buyerPrivateBucket) {
                if (!r || !r.result) continue
                const res = r.result
                const check = (s) => (s || '').toString().toLowerCase() === lower
                if (res.letterFromTarget && check(res.letterFromTarget)) return true
                if (res.letterFromBuyer && check(res.letterFromBuyer)) return true
                if (res.letter && check(res.letter)) return true
                if (res.last && check(res.last)) return true
                if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(lower)) return true
              }
            } catch (e) {}
            return false
          })()

          buyerAward = (count > 0 && !targetExistingSet.has(lower) && !letterWasPrivatelyRevealedByBuyer) ? 2 * count : 0
        }
        // For target: if targetResult.letterFromBuyer exists, compute occurrences in buyer's word
        let targetAward = 0
        let targetLetter = null
        if (targetResultPayload && targetResultPayload.letterFromBuyer) {
          targetLetter = (targetResultPayload.letterFromBuyer || '').toString()
          const lowerB = targetLetter.toLowerCase()
          const buyerNode = (state?.players || []).find(p => p.id === myId) || {}
          const buyerWord = buyerNode.word || ''
          const countB = (buyerWord || '').split('').filter(ch => (ch || '').toLowerCase() === lowerB).length
          // Only award target if the buyer's letter wasn't already publicly revealed
          // and the target hasn't already privately revealed this same letter (in any way) to the buyer.
          const buyerExisting = (buyerNode && buyerNode.revealed) ? buyerNode.revealed : []
          const buyerExistingSet = new Set((buyerExisting || []).map(x => (x || '').toLowerCase()))
          const targetNodeForCheck = (state?.players || []).find(p => p.id === powerUpTarget) || {}
          const targetPrivateBucket = (targetNodeForCheck.privatePowerReveals && targetNodeForCheck.privatePowerReveals[myId]) ? Object.values(targetNodeForCheck.privatePowerReveals[myId]) : []
          const letterWasPrivatelyRevealedByTarget = (function() {
            try {
              for (const r of targetPrivateBucket) {
                if (!r || !r.result) continue
                const res = r.result
                const check = (s) => (s || '').toString().toLowerCase() === lowerB
                if (res.letterFromTarget && check(res.letterFromTarget)) return true
                if (res.letterFromBuyer && check(res.letterFromBuyer)) return true
                if (res.letter && check(res.letter)) return true
                if (res.last && check(res.last)) return true
                if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(lowerB)) return true
              }
            } catch (e) {}
            return false
          })()

          targetAward = (countB > 0 && !buyerExistingSet.has(lowerB) && !letterWasPrivatelyRevealedByTarget) ? 2 * countB : 0
        }

  // Build messages according to user's requested phrasing.
        // Buyer sees in opponent's div: either "letter for letter: revealed, + points" or "no points awarded since the letter is already revealed"
  let buyerMsg = null
        if (buyerLetter) {
          if (buyerAward > 0) buyerMsg = { message: `letter for letter: you revealed '${buyerLetter}', +${buyerAward} points`, letterFromTarget: buyerLetter }
          else buyerMsg = { message: `letter for letter: you revealed '${buyerLetter}', no points awarded since the letter is already revealed`, letterFromTarget: buyerLetter }
        }

        // Target-side effect message (what the buyer should see in the opponent's div)
        let targetMsg = null
        if (targetLetter) {
          const targetDisplay = playerIdToName[powerUpTarget] || powerUpTarget
          if (targetAward > 0) {
            targetMsg = {
              message: `Letter For Letter: ${targetDisplay} had letter '${targetLetter}' revealed; they earned +${targetAward} points`,
              letterFromBuyer: targetLetter
            }
          } else {
            targetMsg = {
              message: `Letter For Letter: ${targetDisplay} had letter '${targetLetter}' revealed; no points were awarded`,
              letterFromBuyer: targetLetter
            }
          }
        }

  // Buyer-facing summary: show the buyer which letter was revealed on them (if any)
  // and how many points the opponent earned. Fall back to the original buyerMsg if target info not present.
  let buyerResultForSelf = buyerMsg
  // Show buyer which letter they revealed on the opponent and how much they earned
  if (buyerLetter) {
    if (buyerAward > 0) {
      buyerResultForSelf = {
        message: `Letter For Letter: you revealed '${buyerLetter}' and earned +${buyerAward} points`,
        letterFromTarget: buyerLetter
      }
    } else {
      buyerResultForSelf = {
        message: `Letter For Letter: you revealed '${buyerLetter}', which was already revealed; no points were awarded`,
        letterFromTarget: buyerLetter
      }
    }
  }
  // base payloads for buyer/target privatePowerReveals entries
  const buyerBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  const targetBase = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
  // include both the human-friendly message for the buyer and the raw private letter reveal so PlayerCircle can color it
  // Build an HTML variant for clients that prefer styled markup
  try {
    const bLetter = buyerLetter || (buyerResultPayload && (buyerResultPayload.letterFromTarget || buyerResultPayload.letter || buyerResultPayload.last)) || ''
    let buyerMessageHtml = null
    if (bLetter) {
      if (typeof buyerAward === 'number' && buyerAward > 0) {
        buyerMessageHtml = `<strong class="power-name">Letter for Letter</strong>: you revealed <strong class="revealed-letter">'${bLetter}'</strong> and earned +${buyerAward} points`
      } else {
        buyerMessageHtml = `<strong class="power-name">Letter for Letter</strong>: you revealed <strong class="revealed-letter">'${bLetter}'</strong>, no points were awarded`
      }
    } else if (buyerResultForSelf && buyerResultForSelf.message) {
      buyerMessageHtml = `<strong class="power-name">Letter for Letter</strong>: ${buyerResultForSelf.message}`
    }
    const buyerData = { ...buyerBase, result: { ...(buyerResultForSelf || {}), ...(buyerResultPayload || {}), ...(buyerMessageHtml ? { messageHtml: buyerMessageHtml } : {}) } }
    updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
  } catch (e) {
    updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBase, result: { ...(buyerResultForSelf || {}), ...(buyerResultPayload || {}) } }
  }

  // Special-case: for letter_for_letter, write a clear, target-facing message so the target
  // sees exactly: "B used letter for letter on you to reveal letter x" as requested.
      try {
    if (powerId === 'letter_for_letter') {
      const letterDisplay = (buyerLetter || (resultPayload && (resultPayload.letter || resultPayload.last || (Array.isArray(resultPayload.letters) && resultPayload.letters[0])))) || ''
      const msg = `Letter For Letter: ${playerIdToName[myId] || myId} revealed letter ${letterDisplay}`
      const targetHtml = `<strong class="power-name">Letter For Letter</strong>: <em>${playerIdToName[myId] || myId}</em> revealed letter <strong class="revealed-letter">${letterDisplay}</strong>`
      updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: { message: msg, letterFromBuyer: letterDisplay, messageHtml: targetHtml } }
    }
  } catch (e) {}

  // Immediately apply buyer award here to ensure their wordmoney reflects the +2 per newly revealed occurrence
  if (buyerAward && buyerAward > 0) {
      // Credit buyer (team or player) using helper so team-mode is respected. helper also writes lastGain.
      applyAward(updates, myId, buyerAward, { reason: powerId, by: powerUpTarget })
      // merge into privateHits for buyer similar to other award flows
      try {
        const prevHitsNow = (meNow.privateHits && meNow.privateHits[powerUpTarget]) ? meNow.privateHits[powerUpTarget].slice() : []
        const letter = (buyerLetter || '').toLowerCase()
        if (letter) {
          let mergedNow = false
          const countInWord = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === letter).length
          for (let i = 0; i < prevHitsNow.length; i++) {
            const h = prevHitsNow[i]
            if (h && h.type === 'letter' && h.letter === letter) {
              prevHitsNow[i] = { ...h, count: (Number(h.count) || 0) + countInWord, ts: Date.now() }
              mergedNow = true
              break
            }
          }
          if (!mergedNow) prevHitsNow.push({ type: 'letter', letter, count: countInWord, ts: Date.now() })
        }
        updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHitsNow
      } catch (e) {}
      // lastGain is set by applyAward helper
      // mark that we've already applied the buyer award so generic reveal branches skip awarding again
      skipBuyerLetterAward = true
    }

  // (buyer-side message will be written below together with the target-side payload so we avoid overwriting buyer's
  // view of the opponent's div. See consolidated write later that includes letterFromBuyer for coloring.)
        // (removed writing a buyer-phrased message into the target's own privatePowerReveals)
        // Also store the side-effect message under the target's node keyed by buyer so the target will see
        // both: (A) a message in their own div saying they earned points, and (B) a message appearing in
        // the buyer's div on the target's screen describing that the target had a letter revealed.
        if (targetMsg || targetResultPayload) {
          // (B) Buyer div on target's screen: the target (viewer) should also see a message in the BUYER's tile
          // indicating the target had a letter revealed (actor is the target, and 'to' is the buyer id so it
          // renders inside the buyer's div when the target is viewing)
          const buyerDivKey = `${key}_buyer_${Date.now()}`
          const buyerDivHtml = (typeof targetAward === 'number' && targetAward > 0)
            ? `<strong class="power-name">Letter for Letter</strong>: <em>${playerIdToName[powerUpTarget] || powerUpTarget}</em> had letter <strong class="revealed-letter">'${targetLetter}'</strong> revealed; they earned <strong class="revealed-letter">+${targetAward}</strong> points`
            : `<strong class="power-name">Letter for Letter</strong>: <em>${playerIdToName[powerUpTarget] || powerUpTarget}</em> had letter <strong class="revealed-letter">'${targetLetter}'</strong> revealed; no points were awarded`
          const buyerDivMsg = (typeof targetAward === 'number' && targetAward > 0)
            ? { message: `letter for letter: ${playerIdToName[powerUpTarget] || powerUpTarget} had letter '${targetLetter}' revealed. They earned +${targetAward} points`, letterFromBuyer: targetLetter, messageHtml: buyerDivHtml }
            : { message: `letter for letter: ${playerIdToName[powerUpTarget] || powerUpTarget} had letter '${targetLetter}' revealed. No points were awarded`, letterFromBuyer: targetLetter, messageHtml: buyerDivHtml }
          // Only write a buyer-div style message into the TARGET's own privatePowerReveals
          // when in team mode (lastTeamStanding). In non-team modes the buyer's own
          // privatePowerReveals (written above under the buyer's node) is sufficient
          // and avoids showing duplicate messages in the target's tile.
          if ((state && state.gameMode) === 'lastTeamStanding') {
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${buyerDivKey}`] = { powerId, ts: Date.now(), from: powerUpTarget, to: myId, result: { ...(buyerDivMsg || {}), ...(targetResultPayload || {}) } }
          }

          // Also store the side-effect payload under the BUYER's own node so the buyer can see the summary
          // in their own view (unchanged behavior)
          const buyerSideKey2 = `pu_side_from_${powerUpTarget}_${Date.now()}_${myId}`
          // Build an HTML summary for the buyer-side payload as well
          const buyerSideHtml = targetLetter ? `<strong class="power-name">Letter for Letter</strong>: <em>${playerIdToName[powerUpTarget] || powerUpTarget}</em> had letter <strong class="revealed-letter">'${targetLetter}'</strong> revealed${(typeof targetAward === 'number' && targetAward > 0) ? `; they earned +${targetAward} points` : '; no points were awarded'}` : (targetMsg && targetMsg.message ? `<strong class="power-name">Letter for Letter</strong>: ${targetMsg.message}` : null)
          const buyerSidePayload = { powerId, ts: Date.now(), from: powerUpTarget, to: myId, result: { ...(targetMsg || {}), ...(targetResultPayload || {}), ...(buyerSideHtml ? { messageHtml: buyerSideHtml } : {}) } }
          updates[`players/${myId}/privatePowerReveals/${myId}/${buyerSideKey2}`] = buyerSidePayload

          // Instead of writing a personalized "you earned" message into the target's own div (which made the
          // target's tile show that sentence), write a tiny color-override private reveal entry so that
          // newly-public letters revealed by letter_for_letter render in the buyer's color on the target's own word.
          // Only do this when the buyer actually revealed a new letter (buyerAward > 0) : if the letter was
          // already revealed, keep the normal public/red rendering.
          try {
            if (buyerLetter && typeof buyerAward === 'number' && buyerAward > 0) {
              const colorKey = `pu_color_${Date.now()}_${myId}_${powerUpTarget}`
              updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${colorKey}`] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: { letterFromTarget: buyerLetter, overridePublicColor: true } }
            }
          } catch (e) {}
        }
        // if the target earned an award from the private reveal, add it to stagedTargetAwardDelta so it applies once
        try {
          if (typeof targetAward === 'number' && targetAward > 0) stagedTargetAwardDelta = (stagedTargetAwardDelta || 0) + targetAward
        } catch (e) {}
        // If any target awards were staged, apply them once using applyAward so team-mode credits team wallet
        try {
          if (typeof stagedTargetAwardDelta === 'number' && stagedTargetAwardDelta > 0) {
            applyAward(updates, powerUpTarget, stagedTargetAwardDelta, { reason: 'letter_for_letter', by: myId })
          }
        } catch (e) {}
      } else {
        data.result = resultPayload
        updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = data
        updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = data
      }

      // Ensure buyer/target privatePowerReveals entries exist for this purchase so the
      // "Power-up results" UI always updates. Some branches write explicit buyer/target
      // entries (e.g. vowel_vision, letter_for_letter); for branches that didn't, write
      // a generic entry here without overwriting any explicit payloads.
      try {
        const buyerKey = `players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`
        const targetKey = `players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`
        if (!updates[buyerKey]) {
          updates[buyerKey] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: (resultPayload || {}) }
        }
        // Special-case: Crowd Hint should only write the buyer-facing message under the buyer's
        // privatePowerReveals so the summary appears on the buyer's tile. Avoid writing a
        // target-side private reveal entry for crowd_hint to prevent the message showing up
        // on targets' own tiles.
        if (powerId !== 'crowd_hint') {
          if (!updates[targetKey]) {
            // For the target's view prefer a short message if resultPayload is complex
            const targetResult = (resultPayload && typeof resultPayload === 'object') ? { ...(resultPayload || {}), message: (resultPayload && resultPayload.message) ? resultPayload.message : `${playerIdToName[myId] || myId} used ${powerId}` } : { message: (resultPayload || '') }
            updates[targetKey] = { powerId, ts: Date.now(), from: myId, to: powerUpTarget, result: targetResult }
          }
        } else {
          // ensure no accidental target entry remains for crowd_hint
          if (updates[targetKey]) delete updates[targetKey]
        }
      } catch (e) {}

      // Additional explicit per-power handling for some self power-ups and effects
      try {
        if (powerId === 'crowd_hint') {
          // Reveal one random letter from everyone's word, mark as no-score, and notify buyer
          try {
            const picks = {}
            ;(state?.players || []).forEach(pp => {
              try {
                // Skip if the player's word is frozen (Word Freeze power-up active)
                const isFrozen = !!(pp && (pp.frozen || (typeof pp.frozenUntilTurnIndex !== 'undefined' && pp.frozenUntilTurnIndex !== null)))
                if (isFrozen) return
                const w = (pp && pp.word) ? pp.word.toLowerCase().split('') : []
                if (w && w.length > 0) {
                  const ch = w[Math.floor(Math.random() * w.length)]
                  if (ch) {
                    const existing = pp.revealed || []
                    updates[`players/${pp.id}/revealed`] = Array.from(new Set([...(existing || []), ch]))
                    updates[`players/${pp.id}/noScoreReveals/${ch}`] = true
                    picks[pp.id] = picks[pp.id] || []
                    picks[pp.id].push(ch)
                  }
                }
              } catch (e) {}
            })
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const summary = Object.keys(picks).map(pid => `${playerIdToName[pid] || pid}: ${picks[pid].join(', ')}`).join('; ')
            const buyerMessageHtml = `<strong class="power-name">Crowd Hint</strong>: revealed ${Object.keys(picks).map(pid => `<em>${playerIdToName[pid] || pid}</em>: ${picks[pid].map(ch => `<strong class=\"revealed-letter\">${ch}</strong>`).join(', ')}`).join('; ') || 'no letters'}`
            // Write the summary only under the BUYER's privatePowerReveals so it appears in the buyer's tile
            // for everyone viewing the room. Do NOT write an entry under the target's privatePowerReveals
            // to avoid the message appearing in the target's own tile.
            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { message: `<strong class="power-name">Crowd Hint</strong>: revealed ${summary || 'no letters'}`, picks, messageHtml: buyerMessageHtml } }
          } catch (e) {}
        }

        if (powerId === 'longest_word_bonus') {
          try {
            const playersArr = (state?.players || [])
            // Find the longest word length, then award ALL players who match that length
            let best = -1
            try {
              playersArr.forEach(pp => { try { const l = (pp.word || '').toString().length || 0; if (l > best) best = l } catch (e) {} })
            } catch (e) { best = -1 }
            const amount = 10
            const winners = []
            if (best > 0) {
              playersArr.forEach(pp => {
                try {
                  const l = (pp.word || '').toString().length || 0
                  if (l === best) winners.push(pp.id)
                } catch (e) {}
              })
            }
            // Award amount to every winner found
            if (winners.length > 0) {
              // expose for downstream UI/toast rendering
              resultPayload = { winners, amount }
              winners.forEach(wid => {
                try {
                  // Use helper so team-mode is respected; still set a per-player lastGain for UI
                  applyAward(updates, wid, amount, { reason: powerId, by: myId })
                } catch (e) {}
              })
            }
            // mark that this buyer used their longest_word_bonus
            updates[`usedLongestWordBonus/${myId}`] = true
            // Only write a private message for the BUYER under their own viewer key so
            // it appears only on the buyer's screen (not in others' tiles).
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: myId }
            const winnerNames = (winners.length > 0) ? winners.map(id => playerIdToName[id] || id) : []
            const buyerMsg = winners.length === 0
              ? `Longest Word Bonus: no eligible words found` 
              : `Longest Word Bonus: ${winnerNames.join(', ')} received +${amount}`
            const buyerHtml = `<strong class="power-name">Longest Word Bonus</strong>: <strong class="revealed-letter">${winnerNames.join(', ')}</strong> received +${amount}. <em>Only you know why :)</em>`
            updates[`players/${myId}/privatePowerReveals/${myId}/${key}`] = { ...buyerBaseLocal, result: { winners, amount, message: buyerMsg, messageHtml: buyerHtml } }
          } catch (e) {}
        }

        if (powerId === 'word_freeze') {
          try {
            // Word Freeze is a self-targeted power-up: ensure it freezes the buyer's own word
            const expires = (typeof state.currentTurnIndex === 'number') ? state.currentTurnIndex + 1 : null
            const freezeTarget = myId
            updates[`players/${freezeTarget}/frozen`] = true
            updates[`players/${freezeTarget}/frozenUntilTurnIndex`] = expires
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: freezeTarget }
            const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: freezeTarget }
            const buyerHtml = `<strong class="power-name">Word Freeze</strong>: your word is frozen for one round`
            const targetHtml = `<strong class="power-name">Word Freeze</strong>: <em>${buyerName}</em> used Word Freeze`
            // Inform the buyer that their word is frozen and add a message for the buyer's own private reveals
            updates[`players/${myId}/privatePowerReveals/${freezeTarget}/${key}`] = { ...buyerBaseLocal, result: { message: `Word Freeze: your word is frozen for one round`, messageHtml: buyerHtml } }
            // Also add an entry under the frozen player's privatePowerReveals for consistency (buyer = target here)
            updates[`players/${freezeTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { message: `${buyerName} used Word Freeze`, messageHtml: targetHtml } }
          } catch (e) {}
        }
        if (powerId === 'price_surge') {
          try {
            // Represent the surge as an entry keyed by the buyer so it globally affects everyone except the buyer.
            // The surge will be cleared when the buyer's turn begins (turn-advance logic clears priceSurge/{playerId}).
            try {
              const expiresAt = null
              updates[`priceSurge/${myId}`] = { amount: 2, by: myId, expiresAtTurnIndex: expiresAt }
            } catch (e) {}
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: null }
            const buyerHtml = `<strong class="power-name">Price Surge</strong>: Everyone else's shop prices increased by <strong class="revealed-letter">+2</strong> until your next turn`
            updates[`players/${myId}/privatePowerReveals/${myId}/${key}`] = { ...buyerBaseLocal, result: { message: `<strong class="power-name">Price Surge</strong>: Everyone else's shop prices increased by +2 until your next turn`, messageHtml: buyerHtml } }
          } catch (e) {}
        }
        // Rare Trace: tell buyer how many occurrences of very-rare letters exist in the target's word
        if (powerId === 'rare_trace') {
          try {
            const rareLetters = ['q','x','z','j','k','v']
            const wordLower = (targetWord || '').toLowerCase()
            let count = 0
            for (let i = 0; i < (wordLower || '').length; i++) {
              try { if (rareLetters.includes(wordLower[i])) count++ } catch (e) {}
            }
            const buyerBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const targetBaseLocal = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
            const buyerHtml = `<strong class="power-name">Rare Trace</strong>: There are <strong class="revealed-letter">${count}</strong> occurrence${count === 1 ? '' : 's'} of Q,X,Z,J,K,or V in <em>${targetName}</em>'s word`
            const targetHtml = `<strong class="power-name">Rare Trace</strong>: <em>${playerIdToName[myId] || myId}</em> used Rare Trace on you`
            updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = { ...buyerBaseLocal, result: { message: `<strong class="power-name">Rare Trace</strong>: there are ${count} occurrence${count === 1 ? '' : 's'} of Q,X,Z,J,K,or V`, count, messageHtml: buyerHtml } }
            updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = { ...targetBaseLocal, result: { message: `<strong class="power-name">Rare Trace</strong>: was used on you by <em>${playerIdToName[myId] || myId}</em>`, messageHtml: targetHtml, teamOnly: (gmMode === 'lastTeamStanding') } }
          } catch (e) {}
        }
      } catch (e) {}

      // For some reveal types we should also update the target's revealed array so letters are visible to both
      if (resultPayload && resultPayload.letters && Array.isArray(resultPayload.letters)) {
        // add those letters to target's revealed set
        const existing = targetNode.revealed || []
        const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
        const toAdd = resultPayload.letters.map(ch => (ch || '').toLowerCase()).filter(Boolean)
        const newRevealed = Array.from(new Set([...(existing || []), ...toAdd]))
        updates[`players/${powerUpTarget}/revealed`] = newRevealed

        // Award points to the buyer for newly revealed letters (2 wordmoney per newly revealed occurrence)
        try {
          const me = (state?.players || []).find(p => p.id === myId) || {}
          const myHangCurrent = Number(me.wordmoney) || 0
          // base wordmoney after paying cost: consider team wallet when in lastTeamStanding
          const baseAfterCost = ((gmMode === 'lastTeamStanding' && me.team)
            ? (typeof updates[`teams/${me.team}/wordmoney`] !== 'undefined' ? updates[`teams/${me.team}/wordmoney`] : (Number(teamMoney) || 0) - cost)
            : (typeof updates[`players/${myId}/wordmoney`] !== 'undefined' ? updates[`players/${myId}/wordmoney`] : (myHangCurrent - cost))
          )

          let awardTotal = 0
          const prevHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget].slice() : []
          // Build a quick set of letters the buyer already has privately for this target
          const prevHitsSet = new Set((prevHits || []).filter(h => h && h.type === 'letter').map(h => (h.letter || '').toString().toLowerCase()))
          toAdd.forEach(letter => {
            try {
              // Skip any letters already publicly revealed
              if (existingSet.has(letter)) return
              // Also skip awarding if buyer already privately has this letter for the same target
              if (prevHitsSet.has(letter)) return
              // reveal all occurrences of this letter in the target's word and award for each
              const countInWord = (targetWord.toLowerCase().match(new RegExp(letter, 'g')) || []).length
              if (countInWord > 0) {
                awardTotal += 2 * countInWord
                // merge into privateHits for buyer
                let merged = false
                for (let i = 0; i < prevHits.length; i++) {
                  const h = prevHits[i]
                  if (h && h.type === 'letter' && String(h.letter).toLowerCase() === letter) {
                    prevHits[i] = { ...h, count: (Number(h.count) || 0) + countInWord, ts: Date.now() }
                    merged = true
                    break
                  }
                }
                if (!merged) prevHits.push({ type: 'letter', letter, count: countInWord, ts: Date.now() })
              }
            } catch (e) {}
          })

          if (awardTotal > 0) {
            // Use helper to credit the buyer (team or player) and record lastGain
            applyAward(updates, myId, awardTotal, { reason: powerId, by: powerUpTarget })
            updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
          }
        } catch (e) {}
      }

  // For zeta_drop, letter_peek, one_random, all_letter_reveal, full_reveal we may want to reveal to target.revealed
      if (resultPayload && resultPayload.last) {
        const existing = targetNode.revealed || []
        const existingSet = new Set((existing || []).map(x => (x || '').toLowerCase()))
        const add = (resultPayload.last || '').toLowerCase()
        if (add) {
          updates[`players/${powerUpTarget}/revealed`] = Array.from(new Set([...(existing || []), add]))
          // Award buyer points for newly revealed occurrences of the letter (2 per occurrence)
          try {
            if (!existingSet.has(add)) {
              const count = (targetWord || '').split('').filter(ch => ch.toLowerCase() === add).length
              if (count > 0) {
                const me = (state?.players || []).find(p => p.id === myId) || {}
                // Determine whether the buyer already received this letter privately earlier
                const buyerPrivateReveals = (me.privatePowerReveals && me.privatePowerReveals[powerUpTarget]) ? Object.values(me.privatePowerReveals[powerUpTarget]) : []
                const buyerPrivateHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget] : []
                let wasPrivatelyRevealedByBuyer = false
                try {
                  for (const r of buyerPrivateReveals) {
                    if (!r || !r.result) continue
                    const res = r.result || {}
                    const check = (s) => (s || '').toString().toLowerCase() === add
                    if (res.letterFromTarget && check(res.letterFromTarget)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.letterFromBuyer && check(res.letterFromBuyer)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.letter && check(res.letter)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.last && check(res.last)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.letters && Array.isArray(res.letters) && res.letters.map(x => (x || '').toString().toLowerCase()).includes(add)) { wasPrivatelyRevealedByBuyer = true; break }
                    if (res.found && Array.isArray(res.found) && res.found.map(x => (x && x.letter || '').toString().toLowerCase()).includes(add)) { wasPrivatelyRevealedByBuyer = true; break }
                  }
                } catch (e) {}
                try {
                  if (!wasPrivatelyRevealedByBuyer && Array.isArray(buyerPrivateHits)) {
                    for (const h of buyerPrivateHits) {
                      if (!h) continue
                      if (h.type === 'letter' && ((h.letter || '').toString().toLowerCase() === add)) { wasPrivatelyRevealedByBuyer = true; break }
                    }
                  }
                } catch (e) {}

                // Only award buyer if it wasn't already revealed publicly or privately by them
                if (!wasPrivatelyRevealedByBuyer) {
                  const myHangCurrent = Number(me.wordmoney) || 0
                  const baseAfterCost = (typeof updates[`players/${myId}/wordmoney`] !== 'undefined')
                    ? updates[`players/${myId}/wordmoney`]
                    : (myHangCurrent - cost)
                  const award = 2 * count
                  // Credit buyer (team or player)
                  applyAward(updates, myId, award, { reason: powerId, by: powerUpTarget })
                  const prevHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget].slice() : []
                  let merged = false
                  for (let i = 0; i < prevHits.length; i++) {
                    const h = prevHits[i]
                    if (h && h.type === 'letter' && h.letter === add) {
                      prevHits[i] = { ...h, count: (Number(h.count) || 0) + count, ts: Date.now() }
                      merged = true
                      break
                    }
                  }
                  if (!merged) prevHits.push({ type: 'letter', letter: add, count, ts: Date.now() })
                  updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
                  // zeta_drop special-case: if only one occurrence, still mark no-score per rules
                  if (powerId === 'zeta_drop') {
                    if (count === 1) updates[`players/${powerUpTarget}/noScoreReveals/${add}`] = true
                  }
                  // mark visible gain
                  updates[`players/${myId}/lastGain`] = { amount: 2 * count, by: powerUpTarget, reason: powerId, ts: Date.now() }
                }
              }
            }
          } catch (e) {}
        }
      }
      // handle single-letter payloads (one_random, letter_peek, letter_for_letter) where resultPayload.letter is set
      if (resultPayload && resultPayload.letter) {
        try {
          const add = (resultPayload.letter || '').toLowerCase()
          if (add) {
            const existing = Array.isArray(targetNode.revealed) ? targetNode.revealed.slice() : []
            // count how many of this letter are already in revealed (keeps duplicates)
            const existingCount = existing.filter(x => (x || '').toLowerCase() === add).length
            // total occurrences in the target word
            const totalCount = (targetWord || '').split('').filter(ch => (ch || '').toLowerCase() === add).length
            // number of new occurrences to add to revealed array
            const toAdd = Math.max(0, totalCount - existingCount)
            if (toAdd > 0) {
              // append the letter to the revealed array for each newly discovered occurrence
              for (let i = 0; i < toAdd; i++) existing.push(add)
              updates[`players/${powerUpTarget}/revealed`] = existing

              // Award buyer for newly revealed occurrences (2 per occurrence)
              try {
                const me = (state?.players || []).find(p => p.id === myId) || {}
                const myHangCurrent = Number(me.wordmoney) || 0
                const baseAfterCost = ((gmMode === 'lastTeamStanding' && me.team)
                  ? (typeof updates[`teams/${me.team}/wordmoney`] !== 'undefined' ? updates[`teams/${me.team}/wordmoney`] : (Number(teamMoney) || 0) - cost)
                  : (typeof updates[`players/${myId}/wordmoney`] !== 'undefined' ? updates[`players/${myId}/wordmoney`] : (myHangCurrent - cost))
                )
                // Determine if buyer already has this letter recorded for this target.
                const prevHits = (me.privateHits && me.privateHits[powerUpTarget]) ? me.privateHits[powerUpTarget].slice() : []
                const alreadyHasLetter = prevHits.some(h => h && h.type === 'letter' && String(h.letter).toLowerCase() === add)
                // Per rule: if this purchase is letter_peek and the buyer already has this letter in privateHits
                // for the target, do not award points (but still apply the revealed change to the target).
                const award = (powerId === 'letter_peek' && alreadyHasLetter) ? 0 : 2 * toAdd
                if (award > 0) {
                  // credit buyer (team-aware) for newly revealed occurrences
                  applyAward(updates, myId, award, { reason: powerId, by: powerUpTarget })
                  let merged = false
                  for (let i = 0; i < prevHits.length; i++) {
                    const h = prevHits[i]
                    if (h && h.type === 'letter' && String(h.letter).toLowerCase() === add) {
                      prevHits[i] = { ...h, count: (Number(h.count) || 0) + toAdd, ts: Date.now() }
                      merged = true
                      break
                    }
                  }
                  if (!merged) prevHits.push({ type: 'letter', letter: add, count: toAdd, ts: Date.now() })
                  updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
                  // remember award so we can include it in the buyer/target privatePowerReveals message
                  if (powerId === 'one_random') oneRandomAward = award
                }
              } catch (e) {}
            } else {
              // nothing new to reveal; still ensure revealed array is set (no-op)
              updates[`players/${powerUpTarget}/revealed`] = existing
            }
          }
        } catch (e) {}
      }

      // If this was a one_random reveal, ensure the privatePowerReveals entries include
      // a human-readable message that indicates what letter was revealed and whether
      // the buyer earned points. Overwrite the earlier generic payload with an enriched
      // one so PlayerCircle shows a friendly sentence (and buyer sees the amount).
      if (powerId === 'one_random') {
        try {
          const ch = (resultPayload && resultPayload.letter) ? String(resultPayload.letter) : null
          const letterDisplay = ch ? String(ch).slice(0,1) : null
          const base = { powerId, ts: Date.now(), from: myId, to: powerUpTarget }
          let buyerMsg = null
          if (letterDisplay) {
            if (oneRandomAward && oneRandomAward > 0) {
              buyerMsg = { message: `One Random Letter: revealed '${letterDisplay}' : you earned +${oneRandomAward}`, letter }
            } else {
              buyerMsg = { message: `One Random Letter: revealed '${letterDisplay}', no points awarded (already revealed)`, letter }
            }
          } else {
            buyerMsg = { message: `One Random Letter: no letter could be revealed`, letter: null }
          }
          const buyerData = { ...base, result: { ...(resultPayload || {}), ...(buyerMsg || {}) } }
          const targetData = { ...base, result: { ...(resultPayload || {}), message: `One Random Letter was used on you by ${playerIdToName[myId] || myId}` } }
          updates[`players/${myId}/privatePowerReveals/${powerUpTarget}/${key}`] = buyerData
          updates[`players/${powerUpTarget}/privatePowerReveals/${myId}/${key}`] = targetData
        } catch (e) {}
      }

      // handle full reveal (full word) awarding buyer for all unique letters occurrences
      if (resultPayload && resultPayload.full) {
        try {
          const full = (resultPayload.full || '').toLowerCase()
          if (full) {
            // reveal all letters (already set on updates earlier)
            // award buyer for every letter occurrence in the target's word
            const letters = full.split('')
            let total = 0
            const counts = {}
            letters.forEach(ch => { if (ch) counts[ch] = (counts[ch] || 0) + 1 })
            Object.keys(counts).forEach(l => { total += 2 * counts[l] })
              if (total > 0) {
              // credit buyer (team-aware) for full reveal award
              applyAward(updates, myId, total, { reason: powerId, by: powerUpTarget })
              // record aggregated privateHits for buyer
              const mePrev = (state?.players || []).find(p => p.id === myId) || {}
              const prevHits = (mePrev.privateHits && mePrev.privateHits[powerUpTarget]) ? mePrev.privateHits[powerUpTarget].slice() : []
              Object.keys(counts).forEach(l => {
                prevHits.push({ type: 'letter', letter: l, count: counts[l], ts: Date.now() })
              })
              updates[`players/${myId}/privateHits/${powerUpTarget}`] = prevHits
            }
          }
        } catch (e) {}
      }

      // Also advance the turn immediately after a power-up is applied (end the buyer's turn)
      // Exception: when the buyer purchases 'double_down' we intentionally DO NOT advance the turn
      // so the buyer can make their guess while the doubleDown is active.
      try {
        if (powerId !== 'double_down') {
          // determine effective turn order (prefer any turnOrder we already modified)
          const effectiveTurnOrder = updates.hasOwnProperty('turnOrder') ? updates['turnOrder'] : (state.turnOrder || [])
          const currentIndexLocal = typeof state.currentTurnIndex === 'number' ? state.currentTurnIndex : 0
          if (effectiveTurnOrder && effectiveTurnOrder.length > 0) {
            // Choose next index so that, when in lastTeamStanding mode, we prefer a
            // player from a different team than the current player (if possible).
            const findNextIndex = (order, curIdx) => {
              try {
                const len = (order || []).length
                if (!len) return 0
                const currPid = order[curIdx]
                const currNode = (state.players || []).find(p => p.id === currPid) || {}
                const currTeam = currNode && currNode.team ? currNode.team : null
                // Non-team modes or missing team info: simple next
                if (!currTeam || (state && state.gameMode) !== 'lastTeamStanding') return (curIdx + 1) % len

                // Build a fresh alternating order from currently alive players so we
                // strictly alternate teams even when counts are uneven. Preserve the
                // players list order when possible (use state.players order).
                const alive = (state.players || []).filter(p => p && !p.eliminated)
                const teams = {}
                const unteamed = []
                alive.forEach(p => {
                  if (p.team) {
                    teams[p.team] = teams[p.team] || []
                    teams[p.team].push(p.id)
                  } else {
                    unteamed.push(p.id)
                  }
                })
                const teamNames = Object.keys(teams)
                // If meaningful teams not present, fallback to original order skipping eliminated players
                if (teamNames.length <= 1) {
                  const compact = (order || []).filter(pid => {
                    const node = (state.players || []).find(p => p.id === pid) || {}
                    return node && !node.eliminated
                  })
                  const pos = compact.indexOf(currPid)
                  const nextPos = pos === -1 ? 0 : (pos + 1) % (compact.length || 1)
                  // Map back to original order's index space if possible
                  const nextPid = compact.length ? compact[nextPos] : null
                  return nextPid ? (order.indexOf(nextPid) >= 0 ? order.indexOf(nextPid) : 0) : 0
                }

                // Prefer starting from the team that is not the current player's team
                const firstTeam = teamNames.find(t => t !== currTeam) || teamNames[0]
                const orderedTeams = [firstTeam].concat(teamNames.filter(t => t !== firstTeam))
                const queues = {}
                orderedTeams.forEach(t => { queues[t] = teams[t] ? teams[t].slice() : [] })
                const result = []
                let idxPtr = 0
                while (Object.keys(queues).some(k => queues[k].length > 0)) {
                  let found = null
                  for (let offset = 0; offset < orderedTeams.length; offset++) {
                    const cand = orderedTeams[(idxPtr + offset) % orderedTeams.length]
                    if (queues[cand] && queues[cand].length > 0) {
                      found = cand
                      idxPtr = idxPtr + offset
                      break
                    }
                  }
                  if (!found) break
                  result.push(queues[found].shift())
                  idxPtr++
                }
                // append any unteamed players at the end
                const newOrder = result.concat(unteamed)
                if (newOrder.length === 0) return 0
                // persist the new alternating order so subsequent advances follow it
                updates[`turnOrder`] = newOrder
                // find current position in the new order (fallback to 0)
                const curPos = newOrder.indexOf(currPid)
                const curPosResolved = curPos === -1 ? 0 : curPos
                const nextPosResolved = (curPosResolved + 1) % newOrder.length
                const nextPid = newOrder[nextPosResolved]
                // return the index of nextPid in the effective order space (newOrder)
                return newOrder.indexOf(nextPid)
              } catch (e) { return (curIdx + 1) % (order.length || 1) }
            }
            const nextIndex = findNextIndex(effectiveTurnOrder, currentIndexLocal)
            updates[`currentTurnIndex`] = nextIndex
            updates[`currentTurnStartedAt`] = Date.now()
              try {
                const nextOrder = (updates && Object.prototype.hasOwnProperty.call(updates, 'turnOrder')) ? updates['turnOrder'] : effectiveTurnOrder
                const nextPlayer = nextOrder[nextIndex]
                const nextNode = (state.players || []).find(p => p.id === nextPlayer) || {}
                // Award +1 to the player whose turn begins. Use applyAward so team-mode credits team wallet.
                try {
                  applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                } catch (e) {
                  // fallback: staged per-player or team increment
                  try {
                    const gm = state && state.gameMode
                    if (gm === 'lastTeamStanding') {
                      const team = nextNode.team
                      if (team) {
                        const teamKey = `teams/${team}/wordmoney`
                        const currTeam = (typeof updates[teamKey] !== 'undefined') ? Number(updates[teamKey]) : Number(state?.teams?.[team]?.wordmoney || 0)
                        updates[teamKey] = Math.max(0, Number(currTeam) + 1)
                      } else {
                        const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : 0
                          // credit start-of-turn +1 using applyAward so team-mode writes to team wallet
                          try {
                            applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                          } catch (e) {
                            // fallback to staged per-player increment when applyAward isn't available
                            const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                            try {
                              applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                            } catch (e) {
                              const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                            try {
                              applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                            } catch (e) {
                              try {
                                applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                              } catch (e) {
                                try {
                                  applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                } catch (e) {
                                  try {
                                    applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                  } catch (e) {
                                    try {
                                      applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                    } catch (e) {
                                      updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
                                    }
                                  }
                                }
                              }
                            }
                            }
                          }
                      }
                    } else {
                      const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : 0
                      try {
                        applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                      } catch (e) {
                        try {
                          applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                        } catch (e) {
                          const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                          try {
                            applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                          } catch (e) {
                            const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                            try {
                              applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                            } catch (e) {
                            try {
                              applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                            } catch (e) {
                              try {
                                applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                              } catch (e) {
                                try {
                                  applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                } catch (e) {
                                  try {
                                    applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                  } catch (e) {
                                    updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
                                  }
                                }
                              }
                            }
                            }
                          }
                        }
                      }
                    }
                  } catch (ee) {
                    const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : 0
                  try {
                    applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                  } catch (e) {
                    const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                          try {
                            applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                          } catch (e) {
                            const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                          try {
                            applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                          } catch (e) {
                            try {
                              applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                            } catch (e) {
                              try {
                                applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                              } catch (e) {
                                try {
                                  applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                } catch (e) {
                                  try {
                                    applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                  } catch (e) {
                                    updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
                                  }
                                }
                              }
                            }
                          }
                          }
                  }
                  }
                }
              // clear any frozen flags when their turn begins
              updates[`players/${nextPlayer}/frozen`] = null
              updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
              // clear any per-player price surge authored by the player whose turn is beginning
              updates[`priceSurge/${nextPlayer}`] = null
              // Add a lastGain entry to indicate the +1 starter award (clients will show this in tooltip)
              try {
                // only add when starter bonus is enabled in room state
                if (state && state.starterBonus && state.starterBonus.enabled) {
                  // ensure lastGain exists for UI; when in team-mode applyAward already wrote lastGain
                  if (typeof updates[`players/${nextPlayer}/lastGain`] === 'undefined') updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
                }
              } catch (e) {}
            } catch (e) {}
          }
        }
      } catch (e) {}

      // Finally perform the update
      // (debug logging removed)
      // If we're in lastTeamStanding mode, replicate buyer-facing privatePowerReveals
      // entries to all teammates so team members share visibility of power-up results.
      try {
        if ((state && state.gameMode) === 'lastTeamStanding') {
          try {
            const meLocal = (state?.players || []).find(p => p.id === myId) || {}
            if (meLocal && meLocal.team) {
              const teammates = (state?.players || []).filter(p => p && p.team === meLocal.team) || []
              teammates.forEach(tp => {
                try {
                  if (!tp || tp.id === myId) return
                  Object.keys(updates || {}).forEach(k => {
                    const m = k.match(new RegExp(`^players\\/${myId}\\/privatePowerReveals\\/${powerUpTarget}\\\/([^/]+)$`))
                    if (m) {
                      const entryKey = m[1]
                      // copy buyer's entry to teammate's private bucket
                      updates[`players/${tp.id}/privatePowerReveals/${powerUpTarget}/${entryKey}`] = updates[k]
                    }
                  })
                } catch (e) {}
              })
            }
          } catch (e) {}
        }
      } catch (e) {}
  await safeDbUpdate(roomRef, updates)
      try {
    // debug toast removed
        // Persist any lastGain updates to localStorage so the UI tooltip can show immediately for affected players
        try {
          Object.keys(updates || {}).forEach(k => {
            const m = k.match(/^players\/([^/]+)\/lastGain$/)
            if (m) {
              const pid = m[1]
              try {
                  const lg = updates[k]
                if (lg && typeof lg.ts !== 'undefined') {
                  // Avoid persisting a local history entry for letter-for-letter here because
                  // the DB write will arrive and PlayerCircle will also add the same entry,
                  // producing a duplicate visible line in the wordmoney tooltip.
                  if ((lg.reason === 'letter_for_letter' || lg.reason === 'letter-for-letter')) return
                  // write a small array entry for tooltip fallback
                  const key = `gh_hang_history_${pid}`
                  const existing = (function() { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null } catch (e) { return null } })()
                  const reasonMap = (r) => {
                    const s = (r || '').toString()
                    if (s === 'powerupReveal') return 'from power-up reveal'
                    if (s === 'letter_for_letter' || s === 'letter-for-letter') return 'from letter-for-letter'
                    if (s === 'startTurn' || s === 'turnStart' || s === 'startBonus') return 'from start of turn'
                    if (s === 'wrongGuess' || s === 'correctGuess') return 'from guessing'
                    return s || 'Adjustment'
                  }
                  const entry = { ts: Number(lg.ts || Date.now()), delta: Number(lg.amount || 0), reason: reasonMap(lg.reason), prev: null }
                  const next = [entry].concat(existing || []).slice(0,3)
                  try { localStorage.setItem(key, JSON.stringify(next)) } catch (e) {}
                  try {
                    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                      try { window.dispatchEvent(new CustomEvent('gh_hang_history_update', { detail: { playerId: pid, entry } })) } catch (e) {}
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
          })
        } catch (e) {}
      } catch (e) {}
      // add a dismissible success toast for power-up application
      const pupToastId = `pup_ok_${Date.now()}`
      // For longest_word_bonus, show the winner(s) display name(s); otherwise show the target
      let pupText = `${pu.name} applied to ${playerIdToName[powerUpTarget] || powerUpTarget}`
      try {
        if (powerId === 'longest_word_bonus' && resultPayload) {
          if (Array.isArray(resultPayload.winners) && resultPayload.winners.length > 0) {
            const names = resultPayload.winners.map(id => playerIdToName[id] || id).join(', ')
            pupText = `${pu.name}: ${names} +${resultPayload.amount}`
          } else if (resultPayload.winner) {
            pupText = `${pu.name}: ${playerIdToName[resultPayload.winner] || resultPayload.winner} +${resultPayload.amount}`
          }
        }
      } catch (e) {}
      setToasts(t => [...t, { id: pupToastId, text: pupText }])
      if (powerId === 'double_down') {
        // remind the buyer they can still guess while the double-down is active
        const tipId = `pup_tip_double_${Date.now()}`
        // remove any existing double-down tips first to avoid duplicates
        setToasts(t => (t || []).filter(x => !(x && typeof x.text === 'string' && x.text.startsWith && x.text.startsWith('Double Down active'))))
        // add the new tip
        setToasts(t => [...t, { id: tipId, text: `Double Down active : make a guess now to earn your stake per occurrence.` }])
        // auto-hide the tip after the same interval as other toasts (fade then remove)
        setTimeout(() => setToasts(t => t.map(x => x.id === tipId ? { ...x, removing: true } : x)), 3200)
        setTimeout(() => setToasts(t => t.filter(x => x.id !== tipId)), 4200)
        // lock the shop UI for this viewer until they make their guess
        try { setDdShopLocked(true) } catch (e) {}
      }
      // schedule fade + removal after a short interval
      setTimeout(() => {
        setToasts(t => t.map(x => x.id === pupToastId ? { ...x, removing: true } : x))
      }, 3200)
      setTimeout(() => {
        setToasts(t => t.filter(x => x.id !== pupToastId))
      }, 4200)
      setPowerUpOpen(false)
    } catch (e) {
      console.error('Curse purchase failed', e)
      setToasts(t => [...t, { id: `pup_err_${Date.now()}`, text: 'Could not perform curse. Try again.' }])
    } finally {
      setPowerUpLoading(false)
    }
  }

  // Keep the letter_peek input focused while the power-up modal is open so typing isn't interrupted
  const prevPowerUpOpenRef = useRef(false)
  useEffect(() => {
    // only autofocus when the modal transitions from closed -> open to avoid repeated scroll resets
    if (!powerUpOpen || prevPowerUpOpenRef.current) {
      prevPowerUpOpenRef.current = powerUpOpen
      return
    }
    prevPowerUpOpenRef.current = true
    // small next-tick focus to ensure the input exists in the DOM
    const t = setTimeout(() => {
      try {
        const el = powerUpChoiceRef.current
        if (el && typeof el.focus === 'function') {
          // prefer preventing scroll when focusing so modal doesn't jump
          // Only call focus once and prefer the options object when supported.
          try {
            el.focus({ preventScroll: true })
          } catch (e) {
            // If options not supported, attempt to set selection without calling focus again
            try {
              const len = (el.value || '').length
              if (typeof el.setSelectionRange === 'function') el.setSelectionRange(len, len)
            } catch (ee) {}
          }
          // move caret to end where possible (no extra focus call)
          try {
            const len = (el.value || '').length
            if (typeof el.setSelectionRange === 'function') el.setSelectionRange(len, len)
          } catch (e) {}
        }
      } catch (e) {}
    }, 0)
    return () => clearTimeout(t)
  // Re-run restoration whenever room state that can affect the modal layout updates
  // (players, turn order, phase, price surge, teams, or game mode). This ensures
  // scrollTop is reapplied after realtime updates so the modal doesn't jump to top.
  }, [powerUpOpen, state?.players, state?.priceSurge, state?.turnOrder, state?.currentTurnIndex, state?.phase, state?.gameMode, state?.teams])

  // Preserve the scroll position of the power-up list while the modal is open.
  // Some room state updates re-render the list and can reset scrollTop; remember
  // the scrollTop on user scroll and restore it when the modal remains open.
  useEffect(() => {
    const el = powerupListRef.current
    if (!el) return () => {}
    const onScroll = () => {
      try { powerupScrollRef.current = el.scrollTop } catch (e) {}
    }
    try { el.addEventListener('scroll', onScroll, { passive: true }) } catch (e) { el.onscroll = onScroll }
    // when the modal opens, restore previous scroll position (next tick)
    if (powerUpOpen) {
      const t = setTimeout(() => {
        try { if (typeof powerupScrollRef.current === 'number') el.scrollTop = powerupScrollRef.current } catch (e) {}
      }, 0)
      return () => {
        clearTimeout(t)
        try { el.removeEventListener && el.removeEventListener('scroll', onScroll) } catch (e) { el.onscroll = null }
      }
    }
    return () => { try { el.removeEventListener && el.removeEventListener('scroll', onScroll) } catch (e) { el.onscroll = null } }
  // Re-run restoration whenever room state that can affect the modal layout updates
  // (players, turn order, phase, price surge, teams, or game mode). This ensures
  // scrollTop is reapplied after realtime updates so the modal doesn't jump to top.
  }, [powerUpOpen, state?.players, state?.priceSurge, state?.turnOrder, state?.currentTurnIndex, state?.phase, state?.gameMode, state?.teams])

  // Ensure scrollTop is restored immediately after any state changes while the modal
  // remains open. Using useLayoutEffect prevents a visible jump by restoring before
  // the browser paints the updated DOM.
  useLayoutEffect(() => {
    if (!powerUpOpen) return
    const el = powerupListRef.current
    if (!el) return
    try {
      // Only restore when we have a previously-stored numeric scroll position.
      const v = (typeof powerupScrollRef.current === 'number') ? powerupScrollRef.current : null
      if (v !== null) {
        // apply immediately
        try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
        // reapply across a couple animation frames and a short timeout to handle
        // later style/transition-driven layout changes that may reset scrollTop.
        try {
          let raf1 = null, raf2 = null, to = null
          raf1 = requestAnimationFrame(() => {
            try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
            raf2 = requestAnimationFrame(() => {
              try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
              to = setTimeout(() => { try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {} }, 50)
            })
          })
          return () => { try { if (raf1) cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); if (to) clearTimeout(to) } catch (e) {} }
        } catch (e) {}
      }
    } catch (e) {}
  // Re-run restoration whenever room state that can affect the modal layout updates
  // (players, turn order, phase, price surge, teams, or game mode). This ensures
  // scrollTop is reapplied before paint after realtime updates so the modal doesn't jump.
  }, [powerUpOpen, state?.players, state?.priceSurge, state?.turnOrder, state?.currentTurnIndex, state?.phase, state?.gameMode, state?.teams])

  // When the power-up modal is open, add a body-level class to pause site animations
  useEffect(() => {
    try {
      if (powerUpOpen) document.body.classList.add('modal-open')
      else document.body.classList.remove('modal-open')
      // prevent background scrolling while modal is open so modal scrolling is smooth
      try { document.body.style.overflow = powerUpOpen ? 'hidden' : '' } catch (e) {}
    } catch (e) {}
    return () => { try { document.body.classList.remove('modal-open') } catch (e) {} }
  }, [powerUpOpen])

  // Preserve the scroll position of the Settings modal when it is open.
  useEffect(() => {
    const el = settingsListRef.current
    if (!el) return () => {}
    const onScroll = () => {
      try { settingsScrollRef.current = el.scrollTop } catch (e) {}
    }
    try { el.addEventListener('scroll', onScroll, { passive: true }) } catch (e) { el.onscroll = onScroll }
    if (showSettings) {
      const t = setTimeout(() => { try { if (typeof settingsScrollRef.current === 'number') el.scrollTop = settingsScrollRef.current } catch (e) {} }, 0)
      return () => { clearTimeout(t); try { el.removeEventListener && el.removeEventListener('scroll', onScroll) } catch (e) { el.onscroll = null } }
    }
    return () => { try { el.removeEventListener && el.removeEventListener('scroll', onScroll) } catch (e) { el.onscroll = null } }
  // Re-run restoration whenever room state that can affect the Settings modal
  // layout updates. This prevents the settings card from jumping to the top when
  // realtime room data (players/turns/price surge/etc) changes while the modal is open.
  }, [showSettings, state?.players, state?.priceSurge, state?.turnOrder, state?.currentTurnIndex, state?.phase, state?.gameMode, state?.teams])

  // Reapply stored scrollTop across layout changes while Settings modal is open (prevents paint jumps)
  useLayoutEffect(() => {
    if (!showSettings) return
    const el = settingsListRef.current
    if (!el) return
    try {
      const v = (typeof settingsScrollRef.current === 'number') ? settingsScrollRef.current : null
      if (v !== null) {
        try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
        try {
          let raf1 = null, raf2 = null, to = null
          raf1 = requestAnimationFrame(() => {
            try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
            raf2 = requestAnimationFrame(() => {
              try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {}
              to = setTimeout(() => { try { if (el.scrollTop !== v) el.scrollTop = v } catch (e) {} }, 50)
            })
          })
          return () => { try { if (raf1) cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); if (to) clearTimeout(to) } catch (e) {} }
        } catch (e) {}
      }
    } catch (e) {}
  }, [showSettings])
  // Stable PowerUpModal component created once and reading dynamic values via refs.
  // This avoids changing the component identity on parent re-renders which would
  // otherwise unmount/remount the modal (causing scrollTop to reset).
  const _powerUpModalRef = useRef(null)
  const _stateRef = useRef(state)
  const _playerIdToNameRef = useRef(playerIdToName)
  const _myIdRef = useRef(myId)
  const _roomIdRef = useRef(roomId)
  const _phaseRef = useRef(phase)
  const _currentTurnIdRef = useRef(currentTurnId)
  // keep refs up-to-date
  useEffect(() => { _stateRef.current = state }, [state])
  useEffect(() => { _playerIdToNameRef.current = playerIdToName }, [playerIdToName])
  useEffect(() => { _myIdRef.current = myId }, [myId])
  useEffect(() => { _roomIdRef.current = roomId }, [roomId])
  useEffect(() => { _phaseRef.current = phase }, [phase])
  useEffect(() => { _currentTurnIdRef.current = currentTurnId }, [currentTurnId])
  // keep copies of modal-related callbacks/state in refs so the stable modal
  // component can read latest values without being redefined each render
  const purchasePowerUpRef = useRef(null)
  const powerUpLoadingRef = useRef(false)
  const powerUpChoiceValueRef = useRef('')
  const powerUpStakeValueRef = useRef('')
  const setPowerUpChoiceValueRef = useRef(null)
  const setPowerUpStakeValueRef = useRef(null)
  const powerUpRevealPublicRef = useRef(false)
  useEffect(() => { purchasePowerUpRef.current = purchasePowerUp }, [purchasePowerUp])
  useEffect(() => { powerUpLoadingRef.current = powerUpLoading }, [powerUpLoading])
  useEffect(() => { powerUpChoiceValueRef.current = powerUpChoiceValue }, [powerUpChoiceValue])
  useEffect(() => { powerUpStakeValueRef.current = powerUpStakeValue }, [powerUpStakeValue])
  useEffect(() => { setPowerUpChoiceValueRef.current = setPowerUpChoiceValue }, [setPowerUpChoiceValue])
  useEffect(() => { setPowerUpStakeValueRef.current = setPowerUpStakeValue }, [setPowerUpStakeValue])
  useEffect(() => { powerUpRevealPublicRef.current = powerUpRevealPublic }, [powerUpRevealPublic])

  if (!_powerUpModalRef.current) {
    _powerUpModalRef.current = function PowerUpModalStable({ open, targetId, onClose }) {
      // read dynamic values from refs so this function can be defined once
      const stateNow = _stateRef.current || {}
      const playerIdToNameNow = _playerIdToNameRef.current || {}
      const myIdNow = _myIdRef.current
      const roomIdNow = _roomIdRef.current
      const phaseNow = _phaseRef.current
      const currentTurnIdNow = _currentTurnIdRef.current

      const targetName = (playerIdToNameNow && playerIdToNameNow[targetId]) ? playerIdToNameNow[targetId] : targetId
      const me = (stateNow?.players || []).find(p => p.id === myIdNow) || {}
      const [buyerBalance, setBuyerBalance] = React.useState(Number(me.wordmoney) || 0)

      React.useEffect(() => {
        let mounted = true
        async function computeBalance() {
          try {
            const base = Number(me.wordmoney) || 0
            const gm = stateNow?.gameMode
            if (gm === 'lastTeamStanding' && me.team) {
              try {
                const teamRef = dbRef(db, `rooms/${roomIdNow}/teams/${me.team}/wordmoney`)
                const snap = await dbGet(teamRef)
                let live = null
                try { live = (snap && typeof snap.val === 'function') ? snap.val() : snap.val } catch (e) { live = snap }
                const teamVal = (typeof live === 'number' || (typeof live === 'string' && !Number.isNaN(Number(live)))) ? Number(live) : Number(stateNow?.teams?.[me.team]?.wordmoney || 0)
                if (mounted) setBuyerBalance(teamVal)
              } catch (e) {
                if (mounted) setBuyerBalance(Number(stateNow?.teams?.[me.team]?.wordmoney || 0))
              }
            } else {
              if (mounted) setBuyerBalance(base)
            }
          } catch (e) {
            if (mounted) setBuyerBalance(Number(me.wordmoney) || 0)
          }
        }
        if (open) computeBalance()
        else setBuyerBalance(Number(me.wordmoney) || 0)
        return () => { mounted = false }
      // avoid depending on the entire `state` object - only depend on the specific pieces we read
      }, [open, stateNow?.gameMode, stateNow?.teams?.[me.team]?.wordmoney, me && me.id, me && me.wordmoney, me && me.team, roomIdNow])

      const isLobby = phaseNow === 'lobby'
      const isMyTurn = (myIdNow === currentTurnIdNow)
      return (
        <div id="powerup" className={`modal-overlay shop-modal ${open ? 'open' : 'closed'}`} role="dialog" aria-modal="true" style={{ display: (open && targetId) ? 'flex' : 'none', overflowY: 'auto', height: '100%' }}>
          <div className="modal-dialog card no-anim shop-modal-dialog shop-modal-dialog">
            <div className="shop-modal-header">
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <strong>Curses on {targetName}</strong>
                <small style={{ fontSize: 12, color: '#ddd' }}>Use these to influence the round</small>
              </div>
              <button className="shop-modal-close" onClick={onClose}>✖</button>
            </div>
            <div className="powerup-list" ref={powerupListRef}>
              {(POWER_UPS || []).map(p => {
              // compute effective price for display (show surge applied if it affects buyer)
              let displayPrice = p.price
              try {
                // compute sum of active surges (skip any surge authored by viewer)
                let totalSurgeAmount = 0
                const ps = stateNow && stateNow.priceSurge
                if (ps && typeof ps === 'object') {
                  if (typeof ps.amount !== 'undefined' && (typeof ps.by !== 'undefined' || typeof ps.expiresAtTurnIndex !== 'undefined')) {
                    const surge = ps
                    if (surge && surge.amount && surge.by !== myIdNow) {
                      const expires = typeof surge.expiresAtTurnIndex === 'number' ? surge.expiresAtTurnIndex : null
                      const active = expires === null || (typeof stateNow.currentTurnIndex === 'number' ? stateNow.currentTurnIndex < expires : true)
                      if (active) totalSurgeAmount += Number(surge.amount || 0)
                    }
                  } else {
                    Object.keys(ps || {}).forEach(k => {
                      try {
                        const entry = ps[k]
                        if (!entry || !entry.amount) return
                        if (entry.by === myIdNow) return
                        const expires = typeof entry.expiresAtTurnIndex === 'number' ? entry.expiresAtTurnIndex : null
                        const active = expires === null || (typeof stateNow.currentTurnIndex === 'number' ? stateNow.currentTurnIndex < expires : true)
                        if (active) totalSurgeAmount += Number(entry.amount || 0)
                      } catch (e) {}
                    })
                  }
                }
                if (totalSurgeAmount) displayPrice = p.price + totalSurgeAmount
              } catch (e) { }

              // compute a visual style/class to distinguish power-up types
              const isSelfType = p.powerupType === 'selfPowerup'
              const isSingleOpponent = p.powerupType === 'singleOpponentPowerup'
              const rowClass = `powerup-row ${isSelfType ? 'powerup-type-self' : isSingleOpponent ? 'powerup-type-opponent' : ''} ${(isSelfType && targetId === myIdNow) ? 'self-powerup' : ''}`
              const rowStyle = isSelfType ? { background: '#fff9e6', border: '1px solid rgba(204,170,60,0.12)' } : (isSingleOpponent ? { background: '#f0f7ff', border: '1px solid rgba(30,120,220,0.08)' } : {})
                      return (
                <div key={p.id} className={rowClass} style={rowStyle}>
                  <div className="powerup-meta">
                    <div className="title">{p.name} <small className="desc">{p.desc}</small></div>
                    <div className="powerup-price">{displayPrice} 🪙{displayPrice !== p.price ? <small className="surge">(+ surge)</small> : null}</div>
                  </div>
                  <div className="powerup-actions">
                        {p.id === 'letter_peek' ? (
                      <LetterPeekControl
                        ref={powerUpChoiceRef}
                        open={open}
                        disabled={isLobby || stateNow?.phase === 'wordseeker_playing'}
                        displayPrice={displayPrice}
                        onBuy={(pos) => { try { purchasePowerUpRef.current && purchasePowerUpRef.current(p.id, { pos }) } catch (e) {} }}
                        powerUpLoading={powerUpLoadingRef.current}
                        buyerBalance={buyerBalance}
                        isMyTurn={isMyTurn}
                      />
                    ) : p.id === 'double_down' ? (
                      (() => {
                        // Double Down should use the stake input, not the letter_peek choice
                        const stakeVal = (powerUpStakeValueRef.current || '').toString().trim()
                        const stakeNum = Number(stakeVal)
                        const stakeInvalid = !stakeVal || Number.isNaN(stakeNum) || stakeNum <= 0
                        // Max stake is your buyerBalance - 1 (buyerBalance is authoritative for enabling/disabling purchases)
                        let maxStake = Math.max(0, Number(buyerBalance || 0) - 1)
                        const stakeTooLarge = !stakeInvalid && stakeNum > maxStake
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <input className="powerup-input" id={`powerup_${p.id}_stake`} name={`powerup_${p.id}_stake`} placeholder="stake" value={powerUpStakeValueRef.current} onChange={e => { try { setPowerUpStakeValueRef.current && setPowerUpStakeValueRef.current(e.target.value) } catch (e) {} }} disabled={isLobby || stateNow?.phase === 'wordseeker_playing'} />
                              <button className="powerup-buy" disabled={isLobby || powerUpLoadingRef.current || buyerBalance < displayPrice || stakeInvalid || stakeTooLarge || stateNow?.phase === 'wordseeker_playing' || !isMyTurn} onClick={() => { try { purchasePowerUpRef.current && purchasePowerUpRef.current(p.id, { stake: powerUpStakeValueRef.current }) } catch (e) {} }}>{powerUpLoadingRef.current ? '...' : 'Buy'}</button>
                            </div>
                            {stakeInvalid && (
                              <div style={{ color: '#900', fontSize: 12 }}>Please enter a valid stake greater than 0</div>
                            )}
                            {stakeTooLarge && (
                              <div style={{ color: '#900', fontSize: 12, maxWidth: 220, wordBreak: 'break-word', whiteSpace: 'normal' }}>
                                Stake cannot exceed ${maxStake} (your current wordmoney - 1 (cost of this power up))
                              </div>
                            )}
                          </div>
                        )
                      })()
                      ) : (
                      p.id === 'the_unseen' ? (
                        <button className="powerup-buy" disabled={isLobby || powerUpLoadingRef.current || buyerBalance < displayPrice || !isMyTurn} onClick={() => { try { purchasePowerUpRef.current && purchasePowerUpRef.current(p.id, { public: powerUpRevealPublicRef.current }) } catch (e) {} }}>{powerUpLoadingRef.current ? '...' : 'Buy'}</button>
                      ) : (
                        <button className="powerup-buy" disabled={isLobby || powerUpLoadingRef.current || buyerBalance < displayPrice || !isMyTurn} onClick={() => { try { purchasePowerUpRef.current && purchasePowerUpRef.current(p.id) } catch (e) {} }}>{powerUpLoadingRef.current ? '...' : 'Buy'}</button>
                      )
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  }

  const PowerUpModal = _powerUpModalRef.current

  // inject small styling for power-up types if not present
try {
  const styleId = 'gh-powerup-type-style'
  if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    const s = document.createElement('style')
    s.id = styleId
    s.innerHTML = `
      .powerup-row { padding: 10px; border-radius: 8px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center }
      .powerup-type-self { background: #fff9e6; border: 1px solid rgba(204,170,60,0.12) }
      .powerup-type-opponent { background: #f0f7ff; border: 1px solid rgba(30,120,220,0.08) }
      .powerup-row .title { font-weight: 700 }
      .powerup-row.self-powerup { box-shadow: 0 2px 8px rgba(0,0,0,0.03) }
    `
    document.head.appendChild(s)
  }
} catch (e) {}

  

  // Component: host-only Play Again / Restart controls
  function PlayAgainControls({ isHost, myId, players }) {
    const [submitting, setSubmitting] = useState(false)

    // Only the host should see these controls
    if (!isHost) return null
    // Host-only restart: reset per-player words, wordmoney, submission flags, clear wantsRematch, and set phase to 'waiting'
    async function restartForAll() {
      if (!isHost) return
      try {
        setSubmitting(true)
        setIsResetting(true)
        // Immediately clear any victory tint so UI updates as soon as host clicks
        try { document.body.style.background = '' } catch (e) {}
        try { const vs = document.querySelector && document.querySelector('.victory-screen'); if (vs) vs.style.background = '' } catch (e) {}

  const updates = { phase: 'lobby', open: true, turnOrder: [], currentTurnIndex: null, currentTurnStartedAt: null }
  // clear winner state when restarting so the victory screen doesn't persist
  updates['winnerId'] = null
  // clear room chat on restart
  updates['chat'] = null
  // clear team winner marker
  updates['winnerTeam'] = null
  // clear any team reveal state so teammates don't keep revealed words across rematch
  updates['teamReveals'] = null
  // clear any ghost challenge/announcements so ghost target word isn't preserved
  updates['ghostChallenge'] = null
  updates['ghostAnnouncements'] = null
  // clear per-team initial counts and compensation applied if present
  try {
  const teamNames = state?.teams ? Object.keys(state.teams || {}) : []
    teamNames.forEach(t => {
      try { updates[`teams/${t}/initialCount`] = null } catch (e) {}
      try { updates[`teams/${t}/compensationApplied`] = null } catch (e) {}
    })
  } catch (e) {}
  // determine starting wordmoney to apply for resets : prefer room setting, fallback to 2
  const resetStart = (state && typeof state.startingWordmoney !== 'undefined' && !Number.isNaN(Number(state.startingWordmoney))) ? Number(state.startingWordmoney) : 2
  ;(players || []).forEach(p => {
      updates[`players/${p.id}/wantsRematch`] = null
    // Reset ready flag for everyone except the host so players must re-ready after a restart
    try { if (p.id !== myId && !p.isBot) updates[`players/${p.id}/ready`] = null } catch (e) {}
      updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          updates[`players/${p.id}/eliminatedAt`] = null
          updates[`players/${p.id}/eliminatedAt`] = null
          // apply configured starting wordmoney (team-mode: initialize team wallets once)
          try {
            if (state && state.gameMode === 'lastTeamStanding' && p.team) {
              // initialize the team's wallet if not already set in this update batch
              if (typeof updates[`teams/${p.team}/wordmoney`] === 'undefined') updates[`teams/${p.team}/wordmoney`] = resetStart
            } else {
              updates[`players/${p.id}/wordmoney`] = resetStart
            }
          } catch (e) {
            updates[`players/${p.id}/wordmoney`] = resetStart
          }
          // allow starter bonus to be re-awarded after a restart
          updates[`players/${p.id}/starterBonusAwarded`] = null
          // clear any ghost-related per-player state so previous ghost attempts don't persist
          updates[`players/${p.id}/ghostState`] = null
          updates[`players/${p.id}/ghostLastGuessAt`] = null
          // Clear viewer-specific guess tracking so old guesses don't persist
          updates[`players/${p.id}/privateHits`] = null
          // Clear any prior guess-blocking records so players can be guessed again after a restart
          updates[`players/${p.id}/guessedBy`] = null
          updates[`players/${p.id}/privateWrong`] = null
          updates[`players/${p.id}/privateWrongWords`] = null
          // Clear any power-up results and markers (private reveals, tracked powerups, and no-score flags)
          updates[`players/${p.id}/privatePowerReveals`] = null
          updates[`players/${p.id}/privatePowerUps`] = null
          updates[`players/${p.id}/noScoreReveals`] = null
          // Clear any previous team assignment so teams do not persist across restarts
          try { updates[`players/${p.id}/team`] = null } catch (e) {}
          // Clear any prior guess-blocking records so players can be guessed again on automatic rematch
          updates[`players/${p.id}/guessedBy`] = null
        })

  // clear the entire teams branch so team wallets/metadata don't persist across restarts
  try { updates['teams'] = null } catch (e) {}
  const ok = await attemptReset(sanitizeUpdatesForFirebase(updates))
        if (ok) {
          const idOk = `rematch_host_ok_${Date.now()}`
          setToasts(t => [...t, { id: idOk, text: 'Room restarted : waiting for players to rejoin.' }])
          // auto-dismiss: fade then remove after short delay
          setTimeout(() => { setToasts(t => t.map(x => x.id === idOk ? { ...x, removing: true } : x)) }, 3200)
          setTimeout(() => { setToasts(t => t.filter(x => x.id !== idOk)) }, 4200)
          // Inform players that chat was cleared for the new game
          try {
            const idChat = `chat_cleared_${Date.now()}`
            setToasts(t => [...t, { id: idChat, text: 'Chat cleared for new game', fade: true }])
            setTimeout(() => setToasts(t => t.filter(x => x.id !== idChat)), 8000)
          } catch (e) {}
        } else {
          const idErr = `rematch_host_err_${Date.now()}`
          setToasts(t => [...t, { id: idErr, text: 'Could not restart room for all players. Check console for details.' }])
          setTimeout(() => { setToasts(t => t.map(x => x.id === idErr ? { ...x, removing: true } : x)) }, 4200)
          setTimeout(() => { setToasts(t => t.filter(x => x.id !== idErr)) }, 5200)
        }
      } catch (e) {
        console.error('Host restart failed', e)
        setToasts(t => [...t, { id: `rematch_host_err_${Date.now()}`, text: 'Could not restart room for all players. Check console for details.' }])
      } finally {
        setSubmitting(false)
        setIsResetting(false)
      }
    }
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={restartForAll} disabled={submitting || isResetting}>{submitting || isResetting ? 'Restarting…' : 'Play again (restart)'} </button>
        <div style={{ fontSize: 13 }}>{players.length} players</div>
      </div>
    )
  }

  // Clear forcedLobbyView if the room phase moves away from 'ended' (i.e., next game started)
  useEffect(() => {
    if (state?.phase && state.phase !== 'ended' && forcedLobbyView) {
      setForcedLobbyView(false)
    }
  }, [state?.phase])

  // Clear local submit input when the room is reset to lobby (e.g., host clicked Play Again / restart)
  useEffect(() => {
    try {
      if (state && state.phase === 'lobby') {
        // clear any draft word the local client was typing
        try { setWord('') } catch (e) {}
        try { setSubmitted(false) } catch (e) {}
        try { setWordError('') } catch (e) {}
        // Also clear the DOM input value if present (defensive)
        try { const el = document.getElementById('submit_word'); if (el) el.value = '' } catch (e) {}
      }
    } catch (e) {}
  }, [state?.phase])

  // If we're the host and everyone has opted into rematch (wantsRematch=true), perform a room reset.
  const resetAttemptRef = useRef(0)
  useEffect(() => {
    if (!state) return
    if (!isHost) return
    if (state.phase !== 'ended') return
    const playersArr = state.players || []
    if (playersArr.length === 0) return
    const allReady = playersArr.every(p => !!p.wantsRematch)
    if (!allReady) return
    // debounce: avoid running multiple times within a short window
    const now = Date.now()
    if (now - (resetAttemptRef.current || 0) < 3000) return
    resetAttemptRef.current = now
    ;(async () => {
      try {
        setIsResetting(true)
        // clear any victory tint immediately when automatic rematch is triggered
        try { document.body.style.background = '' } catch (e) {}
        try { const vs = document.querySelector && document.querySelector('.victory-screen'); if (vs) vs.style.background = '' } catch (e) {}
        // Build a multi-path update: reset room phase and clear per-player wantsRematch and submissions
  const startMoney = (state && typeof state.startingWordmoney !== 'undefined' && !Number.isNaN(Number(state.startingWordmoney))) ? Number(state.startingWordmoney) : 2
  const updates = { phase: 'lobby', open: true, turnOrder: [], currentTurnIndex: null, currentTurnStartedAt: null }
  // ensure winnerId is cleared when performing an automatic rematch reset
  updates['winnerId'] = null
  // clear room chat on automatic rematch
  updates['chat'] = null
  // clear any persisted team-winner marker
  updates['winnerTeam'] = null
  // clear persisted teammate reveals on automatic rematch so everyone starts fresh
  updates['teamReveals'] = null
  // clear ghost challenge and announcements so ghost target word isn't carried over
  updates['ghostChallenge'] = null
  updates['ghostAnnouncements'] = null
  // clear per-team initial counts and compensationApplied values so rematch starts fresh
  try {
  const teamNames = state?.teams ? Object.keys(state.teams || {}) : []
    teamNames.forEach(t => {
      try { updates[`teams/${t}/initialCount`] = null } catch (e) {}
      try { updates[`teams/${t}/compensationApplied`] = null } catch (e) {}
    })
  } catch (e) {}
        playersArr.forEach(p => {
          updates[`players/${p.id}/wantsRematch`] = null
          // Reset ready flag for everyone except the host so players must re-ready after an automatic rematch
          try { if (p.id !== hostId && !p.isBot) updates[`players/${p.id}/ready`] = null } catch (e) {}
          updates[`players/${p.id}/hasWord`] = false
          updates[`players/${p.id}/word`] = null
          updates[`players/${p.id}/revealed`] = []
          updates[`players/${p.id}/eliminated`] = false
          // clear ghost-related state for each player on automatic rematch
          updates[`players/${p.id}/ghostState`] = null
          updates[`players/${p.id}/ghostLastGuessAt`] = null
          try {
            if (state && state.gameMode === 'lastTeamStanding' && p.team) {
              if (typeof updates[`teams/${p.team}/wordmoney`] === 'undefined') updates[`teams/${p.team}/wordmoney`] = startMoney
            } else {
              updates[`players/${p.id}/wordmoney`] = startMoney
            }
          } catch (e) {
            updates[`players/${p.id}/wordmoney`] = startMoney
          }
          // allow starter bonus to be re-awarded on automatic rematch resets
          updates[`players/${p.id}/starterBonusAwarded`] = null
          // Clear power-up state as part of rematch reset so old results don't persist
          updates[`players/${p.id}/privatePowerReveals`] = null
          updates[`players/${p.id}/privatePowerUps`] = null
          updates[`players/${p.id}/noScoreReveals`] = null
          // Clear any previous team assignment so teams do not persist across automatic rematches
          try { updates[`players/${p.id}/team`] = null } catch (e) {}
        })
  // clear the entire teams branch so team wallets/metadata don't persist across automatic rematches
  try { updates['teams'] = null } catch (e) {}
  const ok = await attemptReset(sanitizeUpdatesForFirebase(updates))
        if (!ok) console.warn('Host reset attempted but failed; players may still be opted in')
        else {
          // Announce chat cleared on automatic rematch reset for players
          try {
            const idChatAuto = `chat_cleared_auto_${Date.now()}`
            setToasts(t => [...t, { id: idChatAuto, text: 'Chat cleared for new game', fade: true }])
            setTimeout(() => setToasts(t => t.filter(x => x.id !== idChatAuto)), 8000)
          } catch (e) {}
        }
      } catch (e) {
        console.error('Host attempted rematch reset failed', e)
      } finally {
        setIsResetting(false)
      }
    })()
  }, [state?.phase, state?.players, isHost])

  async function isEnglishWord(w) {
    console.log('isEnglishWord check for word:', w)
    const candidate = (w || '').toString().trim().toLowerCase()
    if (!/^[a-z]+$/.test(candidate)) return false


    let dictDown = false
    let datamuseDown = false
    let freeDictDown = false

    try {
      // === FreeDictionary API ===
    const response = await fetch(
      `https://freedictionaryapi.com/api/v1/entries/en/${word}?translations=true&pretty=true`
    );
    console.log('FreeDictionaryAPI response status:', response.status);

    if (!response.ok && response.status !== 404) {
      freeDictDown = true
    }

    const data = await response.json();
    console.log('FreeDictionaryAPI response data:', data);

    // Check if we got a valid entry with definitions
    const isValid = data.entries.length > 0;

      if (isValid) {
        // word found
        return true;
      }

      // === Datamuse fallback ===
      try {
        console.log('Checking Datamuse for word:', candidate);
        const dm = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(candidate)}&max=1`)
        if (dm.ok) {
          const ddata = await dm.json()
          if (
            Array.isArray(ddata) &&
            ddata.length > 0 &&
            ddata[0].word &&
            ddata[0].word.toLowerCase() === candidate
          ) {
            return true
          }
        } else if (dm.status !== 404) {
          datamuseDown = true
          console.warn('Datamuse lookup non-ok response', dm.status)
        }
      } catch (e2) {
        datamuseDown = true
        console.warn('Datamuse lookup failed', e2)
      }
      // === DictionaryAPI.dev check via Vercel proxy ===
      //not going to work because cors
      console.log('Checking DictionaryAPI.dev for word:', candidate);
      let res = null;
      try {
        res = await fetch(`/api/dictionary?word=${encodeURIComponent(candidate)}`);
      } catch (err) {
        console.warn('DictionaryAPI.dev lookup failed', err);
        dictDown = true;
      }

      if (res && res.ok) {
        try {
          const data = await res.json();
          // dictionaryapi.dev returns an array of entries for valid words
          if (Array.isArray(data) && data.length > 0) return true;
        } catch (err) {
          console.warn('DictionaryAPI.dev returned invalid JSON', err);
          dictDown = true;
        }
      } else if (res && res.status !== 404) {
        // treat non-404 errors as API being down
        dictDown = true;
      }

      

      // === Allow if all external APIs are down ===
      if (dictDown && datamuseDown && freeDictDown) return true

      return false
    } catch (e) {
      console.warn('isEnglishWord unexpected error : permitting word', e)
      return true
    }
  }


  function TimerWatcher({ roomId, timed, turnTimeoutSeconds, currentTurnStartedAt, currentTurnIndex }) {
    const [tick, setTick] = useState(0)
    useEffect(() => {
      const id = setInterval(() => setTick(t => t + 1), 300)
      return () => clearInterval(id)
    }, [])

    useEffect(() => {
      if (!timed || !turnTimeoutSeconds || !currentTurnStartedAt) return
      const msLeft = currentTurnStartedAt + (turnTimeoutSeconds*1000) - Date.now()
      if (msLeft <= 0) {
        const roomRef = dbRef(db, `rooms/${roomId}`)
        dbGet(roomRef).then(async snap => {
          const r = snap.val() || {}
          const debug = (() => { try { return !!localStorage.getItem('gh_debug_timeouts') } catch (e) { return false } })()
          if (debug) console.log('TimerWatcher: expired check', { roomId, msLeft, localHostId: r.hostId, currentTurnIndex: r.currentTurnIndex, now: Date.now() })
          const order = r.turnOrder || []
          if (!order || order.length === 0) return

          // only the host should write authoritative timeout advances to avoid races
          const localMyId = playerId() || (window.__firebaseAuth && window.__firebaseAuth.currentUser ? window.__firebaseAuth.currentUser.uid : null)
          if (!r.hostId || r.hostId !== localMyId) {
            if (debug) console.log('TimerWatcher: not host, skipping authoritative timeout write', { roomId, rHost: r.hostId, localMyId })
            return
          }

          const timedOutPlayer = order[r.currentTurnIndex || 0]
          // check if a timeout for this exact turn (same turn start) already exists
          const timeouts = r.timeouts || {}
          const recent = Object.keys(timeouts || {}).find(k => {
            try {
              const te = timeouts[k]
              // prefer dedupe by turnStartedAt when available (prevents duplicates even if ts differs)
              return te && te.player === timedOutPlayer && te.turnStartedAt && r.currentTurnStartedAt && te.turnStartedAt === r.currentTurnStartedAt
            } catch (e) { return false }
          })
          if (recent) {
            if (debug) console.log('TimerWatcher: skipping timeout write because recent entry exists', { roomId, recentKey: recent, recentEntry: timeouts[recent] })
            return
          }

            const findNextIndexForSnapshot = (order, curIdx, snap) => {
              try {
                const len = (order || []).length
                if (!len) return 0
                const currPid = order[curIdx]
                const currNode = (snap.players && snap.players[currPid]) ? snap.players[currPid] : {}
                const currTeam = currNode && currNode.team ? currNode.team : null
                if (!currTeam || (snap && snap.gameMode) !== 'lastTeamStanding') return (curIdx + 1) % len
                for (let offset = 1; offset < len; offset++) {
                  const idx = (curIdx + offset) % len
                  const pid = order[idx]
                  const node = (snap.players && snap.players[pid]) ? snap.players[pid] : {}
                  if (!node.team || node.team !== currTeam) return idx
                }
                return (curIdx + 1) % len
              } catch (e) { return (curIdx + 1) % (order.length || 1) }
            }
            const nextIdx = findNextIndexForSnapshot(order, r.currentTurnIndex || 0, r)
          // write an authoritative timeout entry for auditing and to notify other clients
          const tkey = `t_${Date.now()}`
          const updates = { currentTurnIndex: nextIdx, currentTurnStartedAt: Date.now() }
          // include the expired turn's start timestamp so consumers can dedupe by turn
          updates[`timeouts/${tkey}`] = { player: timedOutPlayer, deducted: 2, ts: Date.now(), turnStartedAt: r.currentTurnStartedAt || null }
          // clear frozen flags for the player whose turn will start
          try {
            const nextPlayer = order[nextIdx]
            if (nextPlayer) {
              updates[`players/${nextPlayer}/frozen`] = null
              updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
              // clear per-player price surge for the player whose turn is starting (surge expires)
              updates[`priceSurge/${nextPlayer}`] = null
            }
          } catch (e) {}
          // Award the starter +1 to the player whose turn will begin (respect room starterBonus)
          try {
            const nextPlayer = order[nextIdx]
            if (nextPlayer) {
              const nextNode = (r && r.players && r.players[nextPlayer]) || {}
              try {
                applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
              } catch (e) {
                try {
                  const gm = state && state.gameMode
                  if (gm === 'lastTeamStanding') {
                    const team = nextNode.team
                    if (team) {
                      const teamKey = `teams/${team}/wordmoney`
                      const currTeam = (typeof updates[teamKey] !== 'undefined') ? Number(updates[teamKey]) : Number(state?.teams?.[team]?.wordmoney || 0)
                      updates[teamKey] = Math.max(0, Number(currTeam) + 1)
                    } else {
                      const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : 0
                      const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                      try {
                        applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                      } catch (e) {
                                try {
                                  applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                } catch (e) {
                                  try {
                                    applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                                  } catch (e) {
                                    updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
                                  }
                                }
                      }
                    }
                  } else {
                    const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : Number(nextNode.wordmoney) || 0
                    const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                    try {
                      applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                    } catch (e) {
                      try {
                        applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                      } catch (e) {
                        updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
                      }
                    }
                  }
                } catch (ee) {
                  const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : Number(nextNode.wordmoney) || 0
                  const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                      try {
                        applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                      } catch (e) {
                        try {
                          applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                        } catch (e) {
                          try {
                            applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                          } catch (e) {
                            updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
                          }
                        }
                      }
                }
              }
              try {
                if (r && r.starterBonus && r.starterBonus.enabled) {
                  updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
                }
              } catch (e) {}
            }
          } catch (e) {}
          if (debug) console.log('TimerWatcher: writing timeout', { roomId, tkey, timedOutPlayer, expiredTurnStartedAt: r.currentTurnStartedAt || null })
          await safeDbUpdate(roomRef, updates)
        }).catch(e => console.warn('Could not advance turn on timeout', e))
      }
  }, [tick, timed, turnTimeoutSeconds, currentTurnStartedAt, currentTurnIndex, roomId])

    return null
  }

  // Track local submit-phase start time so clients can show a countdown
  const submitPhaseStartRef = useRef(null)
  useEffect(() => {
    try {
      if (phase === 'submit') {
        submitPhaseStartRef.current = Date.now()
      } else {
        submitPhaseStartRef.current = null
      }
    } catch (e) {}
  }, [phase])

  // Auto-minimize/expand ModeBadge on phase transitions:
  // - minimize when playing begins
  // - expand when returning to lobby
  useEffect(() => {
    try {
      if (phase === 'playing') setModeBadgeMinimized(true)
      else if (phase === 'lobby') setModeBadgeMinimized(false)
    } catch (e) {}
  }, [phase])

  // Auto-assign a random word for the local player if they fail to submit in time
  useEffect(() => {
    let timer = null
    try {
      if (!submitTimerEnabled) return () => {}
      if (phase !== 'submit') return () => {}
      if (!myId) return () => {}
      const me = (state?.players || []).find(p => p.id === myId) || {}
      if (me.hasWord) return () => {}
      const start = submitPhaseStartRef.current || Date.now()
      const secs = Math.max(1, Math.min(600, Number(submitTimerSeconds) || 60))
      const msLeft = (start + (secs*1000)) - Date.now()
      if (msLeft <= 0) {
        // already expired: do immediate assignment
        (async () => {
          try {
            const randomWord = pickRandomWordForGhost()
            // submit word via existing helper
            const ok = await submitWord(randomWord)
            // apply penalty of -2 wordmoney (transactional)
            try {
              if (state && state.gameMode === 'lastTeamStanding' && me && me.team) {
                const teamKey = me.team
                const teamMoneyRef = dbRef(db, `rooms/${roomId}/teams/${teamKey}/wordmoney`)
                await runTransaction(teamMoneyRef, curr => Math.max(0, (Number(curr) || 0) - 2))
              } else {
                const playerMoneyRef = dbRef(db, `rooms/${roomId}/players/${myId}/wordmoney`)
                await runTransaction(playerMoneyRef, curr => Math.max(0, (Number(curr) || 0) - 2))
              }
            } catch (e) {
              try {
                const roomRef = dbRef(db, `rooms/${roomId}`)
                if (state && state.gameMode === 'lastTeamStanding' && me && me.team) {
                  const teamKey = me.team
                  await dbUpdate(roomRef, { [`teams/${teamKey}/wordmoney`]: Math.max(0, Number(state?.teams?.[teamKey]?.wordmoney || 0) - 2) })
                } else {
                  await dbUpdate(roomRef, { [`players/${myId}/wordmoney`]: Math.max(0, Number(me.wordmoney || 0) - 2) })
                }
              } catch (ee) {}
            }
            // announce to room so others can show toast
            try {
              const roomRef = dbRef(db, `rooms/${roomId}`)
              const key = `sa_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
              const ann = { player: myId, name: me.name || myId, word: randomWord, penalty: 2, ts: Date.now() }
              const ups = {}
              ups[`submitAutoAssigned/${key}`] = ann
              await dbUpdate(roomRef, ups)
              // schedule removal
              setTimeout(() => { try { dbUpdate(roomRef, { [`submitAutoAssigned/${key}`]: null }) } catch (e) {} }, 7000)
            } catch (e) {}
          } catch (e) { console.warn('auto-assign submit failed', e) }
        })()
        return () => {}
      }
      timer = setTimeout(async () => {
        try {
          const randomWord = pickRandomWordForGhost()
          const ok = await submitWord(randomWord)
          try {
            const playerMoneyRef = dbRef(db, `rooms/${roomId}/players/${myId}/wordmoney`)
            await runTransaction(playerMoneyRef, curr => Math.max(0, (Number(curr)||0) - 2))
          } catch (e) {
            try { const roomRef = dbRef(db, `rooms/${roomId}`); await dbUpdate(roomRef, { [`players/${myId}/wordmoney`]: Math.max(0, Number(me.wordmoney || 0) - 2) }) } catch (ee) {}
          }
          try {
            const roomRef = dbRef(db, `rooms/${roomId}`)
            const key = `sa_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
            const ann = { player: myId, name: me.name || myId, word: randomWord, penalty: 2, ts: Date.now() }
            const ups = {}
            ups[`submitAutoAssigned/${key}`] = ann
            await dbUpdate(roomRef, ups)
            setTimeout(() => { try { dbUpdate(roomRef, { [`submitAutoAssigned/${key}`]: null }) } catch (e) {} }, 7000)
          } catch (e) {}
        } catch (e) { console.warn('submit auto-assign timer action failed', e) }
      }, msLeft)
    } catch (e) { console.warn('submit auto-assign watcher failed', e) }
    return () => { try { if (timer) clearTimeout(timer) } catch (e) {} }
  }, [phase, submitTimerEnabled, submitTimerSeconds, myId, state && state.players])

  // Host-side bot runner: when it's a bot's turn, host client will schedule
  // a bot action (guess a letter or occasionally guess the full word) using
  // the configured botSettings.delayMs and difficulty.
  useEffect(() => {
    if (!isHost) return
    if (!state) return
    if (phase !== 'playing') return
    const order = state.turnOrder || []
    const idx = (typeof state.currentTurnIndex === 'number') ? state.currentTurnIndex : null
    const currentPid = (idx !== null && Array.isArray(order) && order.length > idx) ? order[idx] : null
    if (!currentPid) return
    const botNode = (state.players || []).find(p => p && p.id === currentPid && p.isBot)
    if (!botNode) return

    const roomBotSettings = state?.botSettings || {}
    const delay = (botNode.botSettings && Number(botNode.botSettings.delayMs)) || Number(roomBotSettings.delayMs) || 4000
    const difficulty = (botNode.botSettings && botNode.botSettings.difficulty) || roomBotSettings.difficulty || 'medium'

    const timer = setTimeout(async () => {
      try {
        // pick a target: alive, not eliminated, not a bot
        const alive = (state.players || []).filter(p => p && !p.eliminated && p.id !== botNode.id && !p.isBot)
        if (!alive || alive.length === 0) return
        const target = alive[Math.floor(Math.random() * alive.length)]
        if (!target) return

        // decide action probability
        const probWord = (difficulty === 'hard') ? 0.30 : (difficulty === 'easy') ? 0.05 : 0.12
        if (Math.random() < probWord) {
          // attempt full-word guess
          try { await sendGuess(target.id, { value: (target.word || '') }) } catch (e) { console.warn('bot full-word guess failed', e) }
          return
        }

        // otherwise guess a letter: prefer unrevealed letters
        const word = (target.word || '').toString().toLowerCase()
        const revealed = Array.isArray(target.revealed) ? target.revealed.map(x => (x||'').toString().toLowerCase()) : []
        const uniques = Array.from(new Set((word || '').split('').filter(Boolean)))
        const unrevealed = uniques.filter(ch => !revealed.includes(ch))
        let letter = null
        if (unrevealed.length > 0) letter = unrevealed[Math.floor(Math.random() * unrevealed.length)]
        else if (word && word.length > 0) letter = word[Math.floor(Math.random() * word.length)]
        else letter = String.fromCharCode(97 + Math.floor(Math.random() * 26))
        try { await sendGuess(target.id, { value: letter }) } catch (e) { console.warn('bot letter guess failed', e) }
      } catch (e) {
        console.warn('bot runner unexpected error', e)
      }
    }, Math.max(250, delay || 4000))

    return () => { try { clearTimeout(timer) } catch (e) {} }
  }, [state?.currentTurnIndex, state?.turnOrder, state?.phase, state?.players, isHost])

  // Allow the current player to voluntarily end their turn and advance to the next player.
  async function skipTurn() {
    try {
      if (!myId) return
      if (currentTurnId !== myId) {
        setToasts(t => [...t, { id: `skip_err_${Date.now()}`, text: 'You can only skip on your turn.' }])
        return
      }
      const order = state && state.turnOrder ? state.turnOrder : []
      if (!order || order.length === 0) return
      const currentIndexLocal = (typeof state.currentTurnIndex === 'number') ? state.currentTurnIndex : 0
      const findNextIndexLocal = (order, curIdx, playersList, gm) => {
        try {
          const len = (order || []).length
          if (!len) return 0
          const currPid = order[curIdx]
          const currNode = (playersList || []).find(p => p.id === currPid) || {}
          const currTeam = currNode && currNode.team ? currNode.team : null
          if (!currTeam || gm !== 'lastTeamStanding') return (curIdx + 1) % len
          for (let offset = 1; offset < len; offset++) {
            const idx = (curIdx + offset) % len
            const pid = order[idx]
            const node = (playersList || []).find(p => p.id === pid) || {}
            if (!node.team || node.team !== currTeam) return idx
          }
          return (curIdx + 1) % len
        } catch (e) { return (curIdx + 1) % (order.length || 1) }
      }
      const nextIndex = findNextIndexLocal(order, currentIndexLocal, state && state.players ? state.players : [], state && state.gameMode)
      const nextPlayer = order[nextIndex]
      const roomRef = dbRef(db, `rooms/${roomId}`)
      const updates = {
        currentTurnIndex: nextIndex,
        currentTurnStartedAt: Date.now()
      }
      // Clear any frozen flags for the player whose turn will begin
      try {
        if (nextPlayer) {
          updates[`players/${nextPlayer}/frozen`] = null
          updates[`players/${nextPlayer}/frozenUntilTurnIndex`] = null
          // clear per-player price surge for the player whose turn is starting (surge expires)
          updates[`priceSurge/${nextPlayer}`] = null
        }
      } catch (e) {}
      // Award the starter +1 to the player whose turn will begin (respect room starterBonus)
      try {
        if (nextPlayer) {
          const nextNode = (state && state.players || []).find(p => p.id === nextPlayer) || {}
          try {
            applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
          } catch (e) {
            const prevNextHang = (typeof nextNode.wordmoney === 'number') ? nextNode.wordmoney : Number(nextNode.wordmoney) || 0
            const stagedNextHang = (typeof updates[`players/${nextPlayer}/wordmoney`] !== 'undefined') ? Number(updates[`players/${nextPlayer}/wordmoney`]) : prevNextHang
                      try {
                        applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                      } catch (e) {
                        try {
                          applyAward(updates, nextPlayer, 1, { reason: 'startTurn', by: null })
                        } catch (e) {
                          updates[`players/${nextPlayer}/wordmoney`] = Math.max(0, Number(stagedNextHang) + 1)
                        }
                      }
          }
          try {
            if (state && state.starterBonus && state.starterBonus.enabled) {
              updates[`players/${nextPlayer}/lastGain`] = { amount: 1, by: null, reason: 'startTurn', ts: Date.now() }
            }
          } catch (e) {}
        }
      } catch (e) {}
  await safeDbUpdate(roomRef, updates)
      const toastId = `skip_ok_${Date.now()}`
      setToasts(t => [...t, { id: toastId, text: 'Turn skipped' }])
      // auto-dismiss after a short time
      setTimeout(() => {
        // mark removing to allow CSS fade if supported
        setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x))
      }, 3000)
      setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3500)
    } catch (e) {
      console.error('skipTurn failed', e)
      setToasts(t => [...t, { id: `skip_err_${Date.now()}`, text: 'Could not skip turn. Try again.' }])
    }
  }

  // Helper: compute Levenshtein distance and suggest the closest word from a list
  function levenshtein(a = '', b = '') {
    a = (a || '').toString()
    b = (b || '').toString()
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
      }
    }
    return dp[m][n]
  }

  function suggestClosest(list, candidate) {
    if (!Array.isArray(list) || !candidate) return null
    const c = candidate.toString().toLowerCase()
    let best = null
    let bestScore = Infinity
    for (const w of list) {
      if (!w) continue
      const s = (w || '').toString().toLowerCase()
      if (!/^[a-z]+$/.test(s)) continue
      const d = levenshtein(c, s)
      if (d < bestScore) { bestScore = d; best = s }
    }
    // Accept suggestion only when reasonably close.
    // threshold: allow up to 2 edits or up to ~30% of word length (min 1)
    if (!best) return null
    const maxAllowed = Math.max(1, Math.floor(Math.min(2, Math.ceil(best.length * 0.3))))
    return (bestScore <= Math.max(2, Math.floor(candidate.length * 0.3))) ? best : null
  }

  function suggestAndSetError(baseMsg, list, candidate) {
    try {
      const sug = suggestClosest(list, candidate)
      if (sug) setWordError(React.createElement('span', null, baseMsg + ' Did you mean ', React.createElement('strong', null, sug), '?'))
      else setWordError(baseMsg)
    } catch (e) {
      setWordError(baseMsg)
    }
  }

  async function handleSubmitWord() {
    const candidate = (word || '').toString().trim()
    // client-side safety checks (length and characters)
    if (!candidate) {
      setWordError('Please enter a word')
      return
    }
    // enforce minimum word size from room setting (clamped 2-10)
    const minAllowed = Math.max(2, Math.min(10, Number(minWordSize) || 2))
    if (candidate.length < minAllowed) {
      setWordError(`Please pick a word that is at least ${minAllowed} letters long.`)
      return
    }
    if (!/^[a-zA-Z]+$/.test(candidate)) {
      setWordError('Words may only contain letters. No spaces or punctuation.')
      return
    }
    setWordError('')
    // If a host custom set is present, respect its semantics:
    // - If custom.words is an empty array => host permits any word (skip dictionary checks)
    // - If custom.words is a non-empty array => membership is enforced (checked later) and skip dictionary checks
  const custom = (secretThemeType === 'custom') && state?.secretWordTheme && state.secretWordTheme.custom
    // If any secret-word theme is enforced by the host, skip the English dictionary check.
    // Theme-specific validation (colours/animals/elements/cpp/custom) runs later.
    if (!secretThemeEnabled) {
      // perform dictionary check (may be slow) and show a small spinner state
      setIsCheckingDictionary(true)
      const ok = await isEnglishWord(candidate)
      setIsCheckingDictionary(false)
      if (!ok) {
        setWordError("That doesn't look like an English word. Please pick another.")
        return
      }
    } else {
      // theme is enabled: skip general dictionary checks; theme validation follows below
    }
    // If the host enabled a secret-word theme, validate according to selected type
      if (secretThemeEnabled) {
        try {
          // If the selected theme is 'custom' and the host provided a custom set, it overrides theme validation entirely.
              if (secretThemeType === 'custom' && state?.secretWordTheme && state.secretWordTheme.custom) {
            const wordsArr = Array.isArray(state.secretWordTheme.custom.words) ? state.secretWordTheme.custom.words : null
            // wordsArr === null means host did not save words (treat as no custom list) : fall through to theme checks
                if (Array.isArray(wordsArr)) {
              // If the array has length > 0, enforce membership in that array.
              if (wordsArr.length > 0) {
                const allowed = (wordsArr || []).map(s => (s || '').toString().toLowerCase())
                if (!allowed.includes(candidate.toLowerCase())) {
                  suggestAndSetError('Word must be from the host-provided custom list.', allowed, candidate)
                  return
                }
              }
              // If array is empty, host means "allow any word" : treat as valid and continue
              // Do not return here; allow flow to proceed to submitWord
            }
          }
        // No host custom set: fall back to built-in theme validations
        if (secretThemeType === 'colours') {
          const arr = Array.isArray(COLOURS) ? COLOURS : (COLOURS && COLOURS.default ? COLOURS.default : [])
          if (!arr.includes(candidate.toLowerCase())) {
            suggestAndSetError('Word must be a colour from the selected theme (no spaces).', arr, candidate)
            return
          }
            } else if (secretThemeType === 'animals') {
          // Validate against the bundled ANIMALS list (offline-safe, deterministic)
          try {
            const localList = Array.isArray(ANIMALS) ? ANIMALS : (ANIMALS && ANIMALS.default ? ANIMALS.default : [])
            if (!Array.isArray(localList) || !localList.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be an animal from the selected theme (no spaces).', localList, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate animal : try again')
            return
          }
        } else if (secretThemeType === 'instruments') {
          // Built-in instruments validation (local list lookup)
          try {
            const arr = Array.isArray(INSTRUMENTS) ? INSTRUMENTS : (INSTRUMENTS && INSTRUMENTS.default ? INSTRUMENTS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be an instrument from the selected theme (no spaces).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate instrument : try again')
            return
          }
        } else if (secretThemeType === 'elements') {
          // Built-in periodic elements validation : use list
          try {
            const arr = Array.isArray(ELEMENTS) ? ELEMENTS : (ELEMENTS && ELEMENTS.default ? ELEMENTS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be a periodic element from the selected theme (use element name, no spaces).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate element : try again')
            return
          }
        } else if (secretThemeType === 'cpp') {
          // Built-in C++ terms validation : use list
          try {
            const arr = Array.isArray(CPPTERMS) ? CPPTERMS : (CPPTERMS && CPPTERMS.default ? CPPTERMS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be a C++ related term from the selected theme (no spaces).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate C++ term : try again')
            return
          }
        } else if (secretThemeType === 'fruits' || secretThemeType === 'vegetables') {
          try {
            const arr = (secretThemeType === 'fruits') ? (Array.isArray(FRUITS) ? FRUITS : (FRUITS && FRUITS.default ? FRUITS.default : [])) : (Array.isArray(VEGETABLES) ? VEGETABLES : (VEGETABLES && VEGETABLES.default ? VEGETABLES.default : []))
            if (!arr.includes(candidate.toLowerCase())) {
              const label = secretThemeType === 'fruits' ? 'fruit' : 'vegetable'
              suggestAndSetError(`Word must be a ${label} from the selected theme (single word).`, arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate themed word : try again')
            return
          }
        } else if (secretThemeType === 'occupations') {
          try {
            const arr = Array.isArray(OCCUPATIONS) ? OCCUPATIONS : (OCCUPATIONS && OCCUPATIONS.default ? OCCUPATIONS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be an occupation from the selected theme (no spaces).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate occupation : try again')
            return
          }
        } else if (secretThemeType === 'countries') {
          try {
            const arr = Array.isArray(COUNTRIES) ? COUNTRIES : (COUNTRIES && COUNTRIES.default ? COUNTRIES.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be a country from the selected theme (single word).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate country : try again')
            return
          }
        } else if (secretThemeType === 'ballsports') {
          try {
            const arr = Array.isArray(BALLSPORTS) ? BALLSPORTS : (BALLSPORTS && BALLSPORTS.default ? BALLSPORTS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be a ball-sport from the selected theme (single word).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate ball sport : try again')
            return
          }
        } else if (secretThemeType === 'olympicsports') {
          try {
            const arr = Array.isArray(OLYMPICSPORTS) ? OLYMPICSPORTS : (OLYMPICSPORTS && OLYMPICSPORTS.default ? OLYMPICSPORTS.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be an Olympic sport from the selected theme (single word).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate Olympic sport : try again')
            return
          }
        } else if (secretThemeType === 'gemstones') {
          try {
            const arr = Array.isArray(GEMSTONES) ? GEMSTONES : (GEMSTONES && GEMSTONES.default ? GEMSTONES.default : [])
            if (!arr.includes(candidate.toLowerCase())) {
              suggestAndSetError('Word must be a gemstone from the selected theme (single word).', arr, candidate)
              return
            }
          } catch (e) {
            setWordError('Could not validate gemstone : try again')
            return
          }
        }
      } catch (e) {
        setWordError('Theme validation failed : try again')
        return
      }
    }
    // call submitWord and only mark submitted when it succeeds
    try {
      const success = await submitWord(candidate)
      if (success) setSubmitted(true)
      else setWordError('Submission rejected by server')
    } catch (e) {
      setWordError('Submission failed : please try again')
    }
  }
  // Note: the full victory-screen is rendered later in the main return so we avoid
  // returning early here and breaking hook ordering. The prior early-return block
  // was removed because hooks (e.g. responsive gutter state) are declared below.

  // Reserve a right gutter for the mode-badge / turn UI using CSS grid so the
  // main content doesn't need explicit padding that shifts centering.
  // Make the gutter responsive: collapse to a single column on narrow viewports.
  const appContentStyle = Object.assign(
    powerUpOpen ? { pointerEvents: 'none', userSelect: 'none' } : {}
  )

  // Responsive gutter state (collapse on small screens)
  const [isNarrow, setIsNarrow] = React.useState(false)
  React.useEffect(() => {
    function onResize() {
      try {
        setIsNarrow(typeof window !== 'undefined' ? window.innerWidth < 900 : false)
      } catch (e) { setIsNarrow(false) }
    }
    onResize()
    try { window.addEventListener('resize', onResize) } catch (e) {}
    return () => { try { window.removeEventListener('resize', onResize) } catch (e) {} }
  }, [])

  return (
    <div className={`game-room ${state && state.winnerByWordmoney ? 'money-theme' : ''} ${phase === 'lobby' ? 'lobby' : ''}`}>
      {/* Layout: two-column grid. Left = main app content (centered by content styles),
          Right = a fixed-width gutter that holds mode badge, turn indicator, timers, etc. */}
  <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : '1fr ', gap: 0 }}>
        <div style={{ gridColumn: '1 / 2' }}>
          <div className="app-content" style={appContentStyle}>
            {/* On narrow screens render the modeBadge inline at the top of app content so it remains discoverable */}
            {isNarrow && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}><ModeBadge fixed={false} /></div>
            )}
  {(() => {
    if (modalRoot && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) {
      try { return ReactDOM.createPortal(settingsNode, modalRoot) } catch (e) { return settingsNode }
    }
    return settingsNode
  })()}
  {/* Decorative embers and faint smoke while waiting in-room (matches Lobby visual) */}
  {phase === 'lobby' && (
    <>
      <div className="ambient-embers" aria-hidden="true">
        {/* Increased ember count for better visibility; decorative only */}
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
      </div>
        {/* Ambient runic letters: ghostly, low-opacity shapes that fade randomly */}
        <div className="ambient-runes" aria-hidden="true">
          {state && state.gameMode === 'lastOneStanding' && (
            <span className="rune" style={{ left: '50%', bottom: '84%', fontSize: '20px', animationDuration: '18s', animationDelay: '4s' }}>
              υηιтє тσ яєνєαℓ тнєιρ ωσя∂ѕ
            </span>
          )}
          {state && state.gameMode === 'wordSeeker' && (
            <span className="rune" style={{ left: '50%', bottom: '84%', fontSize: '20px', animationDuration: '18s', animationDelay: '4s' }}>
              𝐒𝐩𝐲? 𝐅𝐚𝐝𝐞 𝐢𝐧𝐭𝐨 𝐭𝐡𝐞 𝐮𝐧𝐝𝐞𝐫𝐰𝐨𝐫𝐥𝐝. 𝐄𝐥𝐬𝐞, 𝐬𝐡𝐢𝐧𝐞 𝐚 𝐥𝐢𝐠𝐡𝐭.
            </span>
          )}
          {(state?.powerUpsEnabled || powerUpsEnabled) && (
            <span className="rune" style={{ left: '16%', bottom: '42%', fontSize: '20px', animationDuration: '14s', animationDelay: '1.1s' }}>
              ᑭᑌᖇᑕᕼᗩᔕE ᗪᗩᖇK ᑕᑌᖇᔕEᔕ
            </span>
          )}
          <span className="rune" style={{ left: '2%',  bottom: '18%', fontSize: '20px', animationDuration: '13s', animationDelay: '0s' }}>Lҽƚƚҽɾʂ Hαʋҽ Sσυʅʂ</span>
          <span className="rune" style={{ left: '6%',  bottom: '12%', fontSize: '20px', animationDuration: '10s', animationDelay: '7s' }}>ᛉ</span>
          <span className="rune" style={{ left: '14%', bottom: '8%',  fontSize: '26px', animationDuration: '13s', animationDelay: '1.2s' }}>ᛜ</span>
          <span className="rune" style={{ left: '22%', bottom: '18%', fontSize: '18px', animationDuration: '9s',  animationDelay: '0.6s' }}>ᛟ</span>
          <span className="rune" style={{ left: '30%', bottom: '6%',  fontSize: '28px', animationDuration: '14s', animationDelay: '2.4s' }}>ᛞ</span>
          <span className="rune" style={{ left: '38%', bottom: '14%', fontSize: '22px', animationDuration: '11s', animationDelay: '0.9s' }}>ᛒ</span>
          <span className="rune" style={{ left: '46%', bottom: '10%', fontSize: '20px', animationDuration: '12s', animationDelay: '11.8s' }}>ᛇ</span>
          <span className="rune" style={{ left: '54%', bottom: '22%', fontSize: '24px', animationDuration: '56s', animationDelay: '5.0s' }}>ᛉ</span>
          <span className="rune" style={{ left: '80%',  bottom: '2%', fontSize: '20px', animationDuration: '43s', animationDelay: '7.7s' }}>Ͳհҽ աìղղҽɾ ʂքҽӀӀʂ ահąէ օէհҽɾʂ հìժҽ</span>
          <span className="rune" style={{ left: '62%', bottom: '20%', fontSize: '18px', animationDuration: '8s',  animationDelay: '1.6s' }}>ᛝ</span>
          <span className="rune" style={{ left: '70%', bottom: '12%', fontSize: '24px', animationDuration: '15s', animationDelay: '2.8s' }}>⚰</span>
          <span className="rune" style={{ left: '78%', bottom: '9%',  fontSize: '20px', animationDuration: '11s', animationDelay: '0.4s' }}>⚱</span>
          <span className="rune" style={{ left: '86%', bottom: '18%', fontSize: '22px', animationDuration: '12s', animationDelay: '1.0s' }}>⚔</span>
          <span className="rune" style={{ left: '92%', bottom: '6%',  fontSize: '20px', animationDuration: '10s', animationDelay: '2.0s' }}>⚚</span>
          <span className="rune" style={{ left: '4%',  bottom: '24%', fontSize: '22px', animationDuration: '13s', animationDelay: '3.4s' }}>⚗</span>
          <span className="rune" style={{ left: '12%', bottom: '28%', fontSize: '18px', animationDuration: '9s',  animationDelay: '0.7s' }}>🜏</span>
          <span className="rune" style={{ left: '20%', bottom: '26%', fontSize: '20px', animationDuration: '14s', animationDelay: '2.2s' }}>🜃</span>
          <span className="rune" style={{ left: '28%', bottom: '30%', fontSize: '24px', animationDuration: '11s', animationDelay: '1.1s' }}>🜄</span>
          <span className="rune" style={{ left: '36%', bottom: '32%', fontSize: '18px', animationDuration: '10s', animationDelay: '0.2s' }}>🜂</span>
          <span className="rune" style={{ left: '44%', bottom: '26%', fontSize: '26px', animationDuration: '16s', animationDelay: '3.8s' }}>✴</span>
          <span className="rune" style={{ left: '52%', bottom: '28%', fontSize: '20px', animationDuration: '12s', animationDelay: '1.4s' }}>✶</span>
          <span className="rune" style={{ left: '60%', bottom: '32%', fontSize: '20px', animationDuration: '13s', animationDelay: '2.6s' }}>✹</span>
          <span className="rune" style={{ left: '68%', bottom: '30%', fontSize: '18px', animationDuration: '9s',  animationDelay: '0.9s' }}>✺</span>
          <span className="rune" style={{ left: '76%', bottom: '26%', fontSize: '22px', animationDuration: '11s', animationDelay: '1.9s' }}>⊙</span>
          <span className="rune" style={{ left: '84%', bottom: '28%', fontSize: '22px', animationDuration: '10s', animationDelay: '0.6s' }}>⊗</span>
          <span className="rune" style={{ left: '90%', bottom: '24%', fontSize: '24px', animationDuration: '14s', animationDelay: '2.3s' }}>◈</span>
          <span className="rune" style={{ left: '8%',  bottom: '36%', fontSize: '18px', animationDuration: '12s', animationDelay: '0.3s' }}>⋇</span>
          <span className="rune" style={{ left: '18%', bottom: '34%', fontSize: '20px', animationDuration: '10s', animationDelay: '1.7s' }}>∴</span>
          <span className="rune" style={{ left: '28%', bottom: '36%', fontSize: '20px', animationDuration: '13s', animationDelay: '2.9s' }}>∵</span>
          <span className="rune" style={{ left: '40%', bottom: '38%', fontSize: '26px', animationDuration: '15s', animationDelay: '3.6s' }}>⁂</span>
        </div>
        {/* CSS-only ghostly symbols (pseudo-elements) - very faint, animated background glyphs */}
        <div className="ghostly-symbols" aria-hidden="true" />
      <div className="lobby-smoke" aria-hidden="true">
        <span className="smoke smoke-left" />
        <span className="smoke smoke-right" />
      </div>
    </>
  )}
  {phase === 'lobby' && (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Room: {roomId}</h2>
        {secretThemeEnabled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ThemeBadge type={secretThemeType} />
            {secretThemeType === 'custom' && state && state.secretWordTheme && state.secretWordTheme.custom && state.secretWordTheme.custom.title ? (
              <div style={{ fontSize: 13, color: '#666', marginLeft: 6 }} title={state.secretWordTheme.custom.title}>
                {state.secretWordTheme.custom.title}{Array.isArray(state.secretWordTheme.custom.words) && state.secretWordTheme.custom.words.length === 0 ? ' (any word allowed)' : ''}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* (removed duplicate inline compact mode card — the fixed `modeBadge` overlay above is authoritative) */}
    </div>
  )}
      {phase === 'lobby' && (
        <div style={{ display: 'inline-block' }}>
          <div style={{ marginBottom: 8 }}>
            {isHost ? (
              <>
              </>
              ) : (
              <div style={{ color: '#555' }}>
                Timed mode: <strong>{state?.timed ? 'On' : 'Off'}</strong>
                {state?.timed && <span style={{ marginLeft: 12 }}>Seconds per turn: <strong>{state?.turnTimeoutSeconds}</strong></span>}
                {/* Reveal-setting shown inline in lobby next to timed mode */}
                <span style={{ marginLeft: 12 }}>Reveal letters based on occurrence in word: <strong style={{ marginLeft: 6 }}>{(typeof state?.revealPreserveOrder === 'boolean') ? (state.revealPreserveOrder ? 'No' : 'Yes') : (revealPreserveOrder ? 'On' : 'Off')}</strong></span>
                {/* When in lastTeamStanding, surface the firstWordWins rule inline */}
                {state?.gameMode === 'lastTeamStanding' && (
                  <span style={{ marginLeft: 12 }}>Rule: <strong>{(typeof state?.firstWordWins !== 'undefined') ? (state.firstWordWins ? 'First word guessed wins' : 'Full elimination required') : (firstWordWins ? 'First word guessed wins' : 'Full elimination required')}</strong></span>
                )}
              </div>
            )}
          </div>
          {isHost ? (
            <>
              <button
                onClick={async () => {
                  // compute human-friendly reasons why start is blocked
                  try {
                    const reasons = []
                    const pcount = (players || []).length
                    // enforce max 5 bots at game start
                    try {
                      const botCount = (players || []).filter(p => p && p.isBot).length
                      if (botCount > 5) reasons.push('Cannot start with more than 5 bots in the room')
                    } catch (e) {}
                    if (pcount < 2) reasons.push('Need at least 2 players to start')
                    if ((state && state.gameMode) === 'lastTeamStanding' && pcount < 3) reasons.push('Need at least 3 players to start Last Team Standing')
                    if ((state && state.gameMode) === 'wordSeeker' && pcount < 3) reasons.push('Need at least 3 players to start Word Seeker')
                    if (!allNonHostPlayersReady) reasons.push('Waiting for all players to mark Ready')
                    if (reasons.length > 0) {
                      const msg = reasons.join(' · ')
                      setStartGameHint(msg)
                      setTimeout(() => { try { setStartGameHint(null) } catch (e) {} }, 4000)
                      // Notify other clients briefly that the host attempted to start but couldn't.
                      try {
                        const nowTs = Date.now()
                        const annKey = `sb_${nowTs}`
                        const roomRef = dbRef(db, `rooms/${roomId}`)
                        const ann = { by: state?.hostId || null, name: playerIdToName[state?.hostId] || null, message: msg, ts: nowTs }
                        const updates = {}
                        updates[`startBlockedAnnouncements/${annKey}`] = ann
                        // attempt to write announcement to DB (best-effort)
                        try { dbUpdate(roomRef, updates).catch(() => {}) } catch (e) {}
                        // schedule a cleanup of the announcement after a short delay so it doesn't linger
                        setTimeout(() => {
                          try { const rm = {}; rm[`startBlockedAnnouncements/${annKey}`] = null; dbUpdate(roomRef, rm).catch(() => {}) } catch (e) {}
                        }, 7000)
                      } catch (e) {}
                      return
                    }
                  } catch (e) {}

                  // no blocking reasons — proceed with existing start logic
                  if (gameMode === 'wordSeeker') {
                    try { startWordSeeker({ timerSeconds: wordSeekerTimerSeconds, rounds: wordSeekerRounds }) } catch (e) { console.warn('startWordSeeker failed', e) }
                  } else {
                    const opts = timedMode ? { timed: true, turnSeconds, starterEnabled, winnerByWordmoney } : { starterEnabled, winnerByWordmoney }
                    // include the local UI startingWordmoney so startGame can prefer it
                    opts.startingWordmoney = startingWordmoney
                    // Persist important settings (startingWordmoney, minWordSize) before starting the game
                    try {
                      await updateRoomSettings({ startingWordmoney: startingWordmoney, minWordSize: minWordSize })
                    } catch (e) {
                      console.warn('Failed to persist settings before starting game', e)
                    }
                    // close the settings panel if still open
                    try { setShowSettings(false) } catch (e) {}
                    try { await startGame(opts) } catch (e) { console.warn('startGame failed', e) }
                  }
                }}
                title={((state && state.gameMode) === 'lastTeamStanding' && players.length < 3)
                  ? 'Need at least 3 players to start Last Team Standing'
                  : ((state && state.gameMode) === 'wordSeeker' && players.length < 3)
                    ? 'Need at least 3 players to start Word Seeker'
                    : (players.length < 2 ? 'Need at least 2 players to start' : '')}
                className={(players.length >= 2 && !((state && state.gameMode) === 'lastTeamStanding' && players.length < 3) && !((state && state.gameMode) === 'wordSeeker' && players.length < 3) && allNonHostPlayersReady) ? 'start-ready' : ''}
              >Start game</button>
              {startGameHint && (
                <div style={{ marginTop: 8, color: '#f3f3f3', background: '#8b2b2b', padding: '6px 10px', borderRadius: 8, fontSize: 13 }} role="status">{startGameHint}</div>
              )}
              {!allNonHostPlayersReady && (
                <div style={{ fontSize: 13, color: '#7b6f8a', marginTop: 6 }}>Waiting for all players to mark Ready</div>
              )}
              {players.length < 2 && <div style={{ fontSize: 13, color: '#7b6f8a', marginTop: 6 }}>Waiting for more players to join (need 2+ players)</div>}
              {/* When startGame detects Last Team Standing requires more players it sets state.ltsWarning; show it inline for host */}
              {isHost && state && state.ltsWarning && (
                <div style={{ marginTop: 8, color: '#fff', background: '#c0392b', padding: '10px 12px', borderRadius: 8, fontWeight: 700 }}>
                  {typeof state.ltsWarning === 'string' ? state.ltsWarning : 'At least 3 players are required to start Last Team Standing.'}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* Word Seeker specific UI flows */}
      {state && state.gameMode === 'wordSeeker' && state.wordSeeker && (
        (() => {
          const ws = state.wordSeeker || {}
          const myId = playerId()
          const isSpy = ws.spyId === myId
          // waiting phase
          if ((state.phase === 'wordseeker_wait' || ws.state === 'waiting')) {
            return (
              <div className="notice card">
                <h4>Word Seeker : Round {ws.currentRound} / {ws.roundsRemaining + ws.currentRound - 1}</h4>
                <div>
                  {!isSpy ? (
                    <>
                      <p>The secret word is: <strong style={{ letterSpacing: 2 }}>{ws.word}</strong></p>
                      <p>When you're ready, click Ready.</p>
                    </>
                  ) : (
                    <>
                      <p>You are the spy : keep the word secret. Your goal is to guess the word later.</p>
                      <p>When others are ready, the host will start the playing phase.</p>
                    </>
                  )}

                  {/* Ready button shown to everyone (including spy) */}
                  <button onClick={() => { try { markWordSeekerReady() } catch (e) { console.warn(e) } }}>Ready</button>
                  {isHost && <button style={{ marginLeft: 8 }} onClick={() => { try { beginWordSeekerPlaying() } catch (e) { console.warn('beginWordSeekerPlaying failed', e) } }}>Force start</button>}
                  {/* removed redundant Start playing button; Ready is sufficient and host can Force start */}
                </div>
              </div>
            )
          }

          // playing phase
          if (state.phase === 'wordseeker_playing' || ws.state === 'playing') {
            const startedAt = ws.playingStartedAt || ws.startedAt || state.currentTurnStartedAt || Date.now()
            const totalMs = (ws.timerSeconds || 120) * 1000
            const msLeft = Math.max(0, (startedAt + totalMs) - Date.now())
            const sLeft = Math.ceil(msLeft / 1000)
            return (
              <div className="notice card">
                <h4>Word Seeker : Playing</h4>
                {!isSpy ? (
                  <div>
                    <p>Word: <strong style={{ letterSpacing: 2 }}>{ws.word}</strong></p>
                    <p>Time left: <strong>{sLeft}s</strong></p>
                  </div>
                ) : (
                  <div>
                    <p>You are the spy : you don't see the word. Watch the discussion and try to blend in.</p>
                    <p>Time left: <strong>{sLeft}s</strong></p>
                  </div>
                )}
                {/* Host can end playing early and move to voting regardless of whether they are the spy */}
                {isHost && <div style={{ marginTop: 8 }}><button onClick={() => { try { endWordSeekerPlaying() } catch (e) { console.warn(e) } }}>End playing / move to voting</button></div>}
              </div>
            )
          }

          // voting phase
          if (state.phase === 'wordseeker_voting' || ws.state === 'voting') {
            // players can click a person to vote
            const roundResults = (ws && ws.roundResults) ? Object.values(ws.roundResults).sort((a,b) => b.ts - a.ts) : []
            const myNodeLocal = (players || []).find(p => p.id === myId) || {}
            const myVoteLocal = myNodeLocal.wordSeekerVote || null
            const votersList = (players || []).filter(p => p.wordSeekerVote).map(p => ({ id: p.id, name: p.name, votedFor: p.wordSeekerVote }))
            return (
              <div className="notice card">
                <h4>Vote for the spy</h4>
                <p>Click a player you think is the spy. You may change your vote until the host tallies.</p>

                {votersList.length > 0 && (
                  <div style={{ marginBottom: 8, fontSize: 13 }}>
                    <strong>Players who have voted:</strong> {votersList.map(v => v.name).join(', ')}
                  </div>
                )}

                {/* If a tally was attempted and there's no clear majority, show an error so players can change votes */}
                {ws && ws.lastTally && (() => {
                  try {
                    const totalPlayers = (players || []).length || 0
                    const majorityNeeded = Math.floor(totalPlayers / 2) + 1
                    const lt = ws.lastTally || {}
                    if (lt && lt.top && lt.topCount < majorityNeeded) {
                      return (
                        <div style={{ marginTop: 8, color: '#fff', background: '#b02a37', padding: 8, borderRadius: 6 }}>
                          No clear majority : change your vote until there is a clear majority (need {majorityNeeded} of {totalPlayers}).
                        </div>
                      )
                    }
                  } catch (e) {}
                  return null
                })()}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {players.map(p => {
                    const selected = myVoteLocal === p.id
                    return (
                      <button key={p.id}
                              disabled={p.id === myId}
                              onClick={() => { try { voteForPlayer(playerId(), p.id) } catch (e) { console.warn(e) } }
                              }
                              style={{ background: selected ? '#DFF0D8' : undefined, border: selected ? '2px solid #4CAF50' : undefined }}>
                        {p.name}{p.wordSeekerVote ? ' ✓' : ''}
                      </button>
                    )
                  })}
                </div>

                <div style={{ marginTop: 8 }}>
                  {myVoteLocal ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 13 }}>Your vote: <strong>{playerIdToName[myVoteLocal] || myVoteLocal}</strong></div>
                      <button onClick={() => { try { voteForPlayer(playerId(), null) } catch (e) { console.warn(e) } }}>Clear vote</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13 }}>You haven't voted yet.</div>
                  )}
                </div>

                {isHost && <div style={{ marginTop: 8 }}><button onClick={async () => { try { await tallyWordSeekerVotes() } catch (e) { console.warn('tally failed', e) } }}>Tally votes</button></div>}

    
              </div>
            )
          }

          // spy guess phase
          if (state.phase === 'wordseeker_spyguess' || ws.state === 'spyGuess') {
            const me = players.find(p => p.id === playerId()) || {}
            const guessesObj = me.wordSeekerGuesses || {}
            const attempts = Object.keys(guessesObj || {}).length
            const maxAttempts = 3
            const lastReveal = ws.lastReveal || null
            // build masked word view based on ws.revealed map
            const revealedMap = ws.revealed || {}
            const ownerWord = (ws.word || '')
            const preserve = !!revealPreserveOrder
            const masked = (() => {
              try {
                const arr = (ownerWord || '').split('')
                // when preserve order is enabled, reveal letters according to word order
                if (preserve) {
                  const counts = {}
                  Object.keys(revealedMap || {}).forEach(k => { counts[k] = Number(revealedMap[k] || 0) })
                  return arr.map(ch => {
                    const lower = (ch || '').toLowerCase()
                    if (counts[lower] && counts[lower] > 0) {
                      counts[lower] = counts[lower] - 1
                      return ch
                    }
                    return '_'
                  }).join('')
                }
                // otherwise, build masked view from revealSequence entries (guess-order)
                const seq = ws.revealSequence || {}
                // flatten sequence entries by timestamp order
                const seqKeys = Object.keys(seq || {}).sort((a,b) => Number(a) - Number(b))
                const counts = {}
                seqKeys.forEach(k => {
                  try { (seq[k].letters || []).forEach(ch => { counts[ch] = (counts[ch] || 0) + 1 }) } catch (e) {}
                })
                // fallback: also include any letters from revealed map
                Object.keys(revealedMap || {}).forEach(k => { counts[k] = (counts[k] || 0) + Number(revealedMap[k] || 0) })
                return arr.map(ch => {
                  const lower = (ch || '').toLowerCase()
                  if (counts[lower] && counts[lower] > 0) {
                    counts[lower] = counts[lower] - 1
                    return ch
                  }
                  return '_'
                }).join('')
              } catch (e) { return (ownerWord || '').split('').map(_ => '_').join('') }
            })()

            return (
              <div className="notice card">
                <h4>Spy Guess : Round {ws.currentRound || ws.current || 1}</h4>
                <div style={{ marginBottom: 8 }}>
                  <strong>Word length:</strong> {(ws.word || '').length} letters
                </div>
                <div style={{ marginBottom: 8 }}>
                  <strong>Revealed so far:</strong> <span style={{ letterSpacing: 2 }}>{masked}</span>
                </div>
                {isSpy ? (
                  <div>
                    <p>Guess the word. Attempts: {attempts} / {maxAttempts}</p>
                    <input id="spy_guess_input" placeholder="exact-length guess" maxLength={(ws.word||'').length} />
                    <button onClick={async () => {
                      try {
                        const el = document.getElementById('spy_guess_input')
                        const val = el ? el.value.trim() : ''
                        if (!val) return
                        const res = await submitSpyGuess(val)
                        if (res && res.correct) {
                          setToasts(t => [...t, { id: `spy_win_${Date.now()}`, text: 'Spy guessed the word!' }])
                        } else if (res && res.revealed) {
                          setToasts(t => [...t, { id: `spy_reveal_${Date.now()}`, text: `Revealed letters: ${res.revealed}` }])
                        }
                      } catch (e) { console.warn('submitSpyGuess err', e) }
                    }}>Submit guess</button>
                    {lastReveal && <div style={{ marginTop: 8 }}>Last reveal: {lastReveal.revealed || lastReveal.guess}</div>}
                  </div>
                ) : (
                  <div>
                    <p>{ws.spyId ? `Discuss and then vote for who you think the spy is.` : 'Waiting...'}</p>
                    <div style={{ marginTop: 8 }}>{isHost && <button onClick={() => { try { playNextWordSeekerRound() } catch (e) { console.warn(e) } }}>Next round</button>}</div>
                  </div>
                )}
              </div>
            )
          }

          return null
        })()
      )}

      {/* Word Seeker round summary popup after tally */}
      {state && state.wordSeeker && state.wordSeeker.lastRoundSummary && ((state.wordSeeker.roundsRemaining || 0) > 0) && (
        <div className="modal-backdrop">
          <div className="modal card" style={{ maxWidth: 520 }}>
            <h3>Round {state.wordSeeker.lastRoundSummary.round || '?'} summary</h3>
            <p>The spy for that round was: <strong>{playerIdToName[state.wordSeeker.lastRoundSummary.spyId] || state.wordSeeker.lastRoundSummary.spyId}</strong></p>
            <p>The word was: <strong>{state.wordSeeker.lastRoundSummary.word || '-'}</strong></p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {isHost ? (
                <button onClick={async () => { try { await playNextWordSeekerRound(); } catch (e) { console.warn(e) } }}>Next round</button>
              ) : (
                <strong onClick={() => { /* non-host just dismiss */ }}>Wait for host</strong>
              )}
            </div>
          </div>
        </div>
      )}

      {/* non-host waiting message */}
      {phase === 'lobby' && !isHost && (
        <div className="notice card">
          <h4>Waiting for the host to start the game</h4>
          <p>The host <strong>{playerIdToName[hostId] || '-'}</strong> can start the game when ready.</p>
        </div>
      )}

      {phase === 'lobby' && (
        <div className="share-room">
          <small>Share this link to invite:</small>
            <div>
              {/* Build the share link string using buildRoomUrl so it's consistent */}
              {(() => {
                try {
                  const u = new URL(window.location.href)
                  u.searchParams.set('room', roomId)
                  return (
                    <>
                      <input id="share_link" name="share_link" readOnly value={u.toString()} style={{ width: 360 }} />
                      <button onClick={async () => { await navigator.clipboard.writeText(u.toString()); const toastId = `linkcopied_${Date.now()}_${Math.random().toString(36).slice(2,6)}`; setToasts(t => [...t, { id: toastId, text: 'Room link copied' }]); setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3000) }}>Copy Link</button>
                    </>
                  )
                } catch (e) {
                  const fallback = window.location.origin + '?room=' + roomId
                  return (
                    <>
                      <input id="share_link_fallback" name="share_link_fallback" readOnly value={fallback} style={{ width: 360 }} />
                      <button onClick={async () => { await navigator.clipboard.writeText(fallback); const toastId = `linkcopied_${Date.now()}_${Math.random().toString(36).slice(2,6)}`; setToasts(t => [...t, { id: toastId, text: 'Room link copied' }]); setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 3000) }}>Copy Link</button>
                    </>
                  )
                }
              })()}
            </div>
        </div>
      )}

  <div className={`circle ${isMyTurnNow ? 'my-turn' : ''}`} style={{ display: phase === 'ended' ? 'none' : undefined }}>
    {players.length === 0 && <div>No players yet : wait for others to join.</div>}
    {/* Place the prominent "Your turn" card at the top of the players circle when it's your turn.
        This renders inside the flow of the circle so it stays visually attached to the player list
        instead of as a separate fixed overlay. */}
    {phase === 'playing' && (() => {
      try {
        const currentPlayer = (players || []).find(p => p.id === currentTurnId) || {}
        const isViewerCurrent = currentTurnId && myId && currentTurnId === myId
        const displayName = currentPlayer.name || (currentTurnId || '-')
        const titleText = isViewerCurrent ? 'Your turn' : `It is ${displayName}'s turn`
        const cardBase = { display: 'flex', alignItems: 'center', gap: 18, padding: '12px 18px', borderRadius: 12, background: 'linear-gradient(180deg, rgba(30,28,32,0.98), rgba(18,16,20,0.96))' }
        const glowStyle = isViewerCurrent ? { boxShadow: '0 12px 36px rgba(255,214,102,0.28), 0 6px 18px rgba(0,0,0,0.6)' } : { boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }
        return (
          <div style={{ width: '100%', display: 'flex', justifyContent: 'center', marginBottom: 12 }} aria-live="polite">
            <div className="big-yourturn-card" style={{ ...cardBase, ...glowStyle }}>
              <div className="big-avatar big-self" style={{ background: (currentPlayer.color || '#2b8cff'), width: 64, height: 64, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>{(displayName || '?')[0] || '?'}</div>
              <div style={{ marginLeft: 0 }}>
                <h1 style={{ margin: 0, fontSize: 28, lineHeight: '1.02' }}>{titleText}</h1>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{isViewerCurrent ? displayName : displayName}</div>
              </div>
            </div>
          </div>
        )
      } catch (e) { return null }
    })()}
        {/* Timer moved to fixed overlay near turn indicator */}
        {(() => {
          // defensive: ensure players is an array of objects (some DB writes may briefly produce non-object entries)
          const sanitized = (players || []).filter(x => x && typeof x === 'object')
          if (sanitized.length !== (players || []).length) {
            try { console.warn('GameRoom: filtered invalid player entries from state.players', { rawPlayers: players, stateSnapshot: state }) } catch (e) {}
          }
          // Order players according to the authoritative turnOrder for non-team modes
          let orderedPlayers = sanitized
          try {
            if ((state && state.gameMode) !== 'lastTeamStanding' && Array.isArray(state?.turnOrder) && state.turnOrder.length > 0) {
              const byId = (sanitized || []).reduce((acc, p) => { if (p && p.id) acc[p.id] = p; return acc }, {})
              const fromOrder = state.turnOrder.map(id => byId[id]).filter(Boolean)
              // Append any players not present in turnOrder at the end to avoid dropping nodes
              const extras = (sanitized || []).filter(p => !state.turnOrder.includes(p.id))
              orderedPlayers = fromOrder.concat(extras)
            }
          } catch (e) { orderedPlayers = sanitized }
          // Build a renderer for individual player tiles, then arrange teams into columns
          const renderTile = (p) => {
            // host-only remove API for player tiles
            const removePlayer = async (pid) => {
              if (!isHost) return false
              try {
                const playerRef = dbRef(db, `rooms/${roomId}/players/${pid}`)
                try {
                  await dbUpdate(playerRef, null)
                  try { setToasts(t => [...t, { id: `remove_ok_${pid}_${Date.now()}`, text: `Removed player ${playerIdToName[pid] || pid}` }]) } catch (e) {}
                  setTimeout(() => setToasts(t => t.map(x => x.id && x.id.startsWith(`remove_ok_${pid}_`) ? { ...x, removing: true } : x)), 2200)
                  setTimeout(() => setToasts(t => t.filter(x => !(x.id && x.id.startsWith(`remove_ok_${pid}_`)))), 3000)
                  return true
                } catch (e) {
                  try {
                    const roomRef = dbRef(db, `rooms/${roomId}`)
                    await dbUpdate(roomRef, { [`players/${pid}`]: null })
                    try { setToasts(t => [...t, { id: `remove_ok_${pid}_${Date.now()}`, text: `Removed player ${playerIdToName[pid] || pid}` }]) } catch (e2) {}
                    setTimeout(() => setToasts(t => t.map(x => x.id && x.id.startsWith(`remove_ok_${pid}_`) ? { ...x, removing: true } : x)), 2200)
                    setTimeout(() => setToasts(t => t.filter(x => !(x.id && x.id.startsWith(`remove_ok_${pid}_`)))), 3000)
                    return true
                  } catch (e2) {
                    console.warn('removePlayer: fallback failed', e2)
                  }
                }
              } catch (err) { console.error('removePlayer failed', err) }
              try { setToasts(t => [...t, { id: `remove_err_${pid}_${Date.now()}`, text: `Could not remove ${playerIdToName[pid] || pid}`, removing: false }]) } catch (e) {}
              setTimeout(() => setToasts(t => t.map(x => x.id && x.id.startsWith(`remove_err_${pid}_`) ? { ...x, removing: true } : x)), 4200)
              setTimeout(() => setToasts(t => t.filter(x => !(x.id && x.id.startsWith(`remove_err_${pid}_`)))), 5200)
              return false
            }

            const viewerNode = players.find(x => x.id === myId) || {}
            // By default use the viewer's private buckets. In lastTeamStanding mode,
            // merge the target player's privatePowerReveals into the viewer's view so
            // all players can see private-power reveal results for that target.
            const viewerPrivatePowerReveals = viewerNode.privatePowerReveals || {}
            // In lastTeamStanding mode we previously merged the target player's
            // privatePowerReveals into the viewer's view for all viewers. That
            // exposed certain side-effect messages (e.g. "knows your word's
            // definition is:") to the buyer's team. To avoid leaking that
            // information, only merge the target's private reveals into the
            // viewer's view when the viewer and the target are on the same
            // team (i.e., teammates should see team-local private reveals).
            const mergedPrivatePowerReveals = (state?.gameMode === 'lastTeamStanding') ? (() => {
              try {
                const base = { ...(viewerNode.privatePowerReveals || {}) }
                const myTeam = viewerNode && viewerNode.team ? viewerNode.team : null
                // When in lastTeamStanding, reveal-buyers' privatePowerReveals that target this player
                // should be visible to all members of the buyer's team. Iterate teammates and merge
                // only entries that target the current player `p.id` into the viewer's bucket map.
                if (myTeam && p && p.id) {
                  try {
                    ;(players || []).forEach(pp => {
                      try {
                        if (!pp || !pp.id) return
                        // only consider teammates (including the viewer themself)
                        if (pp.team !== myTeam) return
                        const tpr = pp.privatePowerReveals || {}
                        Object.keys(tpr || {}).forEach(bucketId => {
                          try {
                            const bucket = tpr[bucketId] || {}
                            Object.keys(bucket || {}).forEach(eid => {
                              try {
                                const entry = bucket[eid]
                                if (!entry) return
                                // only merge entries that target this player
                                if (entry.to && entry.to === p.id) {
                                  if (!base[bucketId]) base[bucketId] = {}
                                  base[bucketId][eid] = entry
                                }
                              } catch (e) {}
                            })
                          } catch (e) {}
                        })
                      } catch (e) {}
                    })
                  } catch (e) {}
                }
                return base
              } catch (e) { return viewerPrivatePowerReveals }
            })() : viewerPrivatePowerReveals

            const viewerPrivate = {
              privateWrong: viewerNode.privateWrong || {},
              privateHits: viewerNode.privateHits || {},
              privateWrongWords: viewerNode.privateWrongWords || {},
              privatePowerUps: viewerNode.privatePowerUps || {},
              privatePowerReveals: mergedPrivatePowerReveals,
              playerColors: (players || []).reduce((acc, pp) => { if (pp && pp.id) acc[pp.id] = pp.color || null; return acc }, {})
            }

            const msLeftForPlayer = (state?.currentTurnStartedAt && state?.turnTimeoutSeconds && state?.timed && currentTurnId === p.id)
              ? Math.max(0, (state?.currentTurnStartedAt || 0) + ((state?.turnTimeoutSeconds || 0)*1000) - Date.now())
              : null

            const playerWithViewer = { ...p, _viewer: viewerPrivate }
            const viewerDDActive = !!(viewerNode && viewerNode.doubleDown && viewerNode.doubleDown.active)
            let viewerDDTarget = null
            try {
              if (viewerDDActive) {
                const ppr = viewerNode.privatePowerReveals || {}
                let latestTs = 0
                Object.keys(ppr).forEach(tid => {
                  const bucket = ppr[tid] || {}
                  Object.values(bucket).forEach(entry => {
                    if (!entry) return
                    const isDD = entry && (entry.powerId === 'double_down' || (entry.result && entry.result.powerId === 'double_down'))
                    if (!isDD) return
                    const ts = Number(entry.ts || (entry.result && entry.result.ts) || 0)
                    if (ts >= latestTs) {
                      latestTs = ts
                      viewerDDTarget = tid
                    }
                  })
                })
              }
            } catch (e) { viewerDDTarget = null }

            const baseCanGuess = phase === 'playing' && myId === currentTurnId && p.id !== myId
            const targetFrozen = !!(p && (p.frozen || (typeof p.frozenUntilTurnIndex !== 'undefined' && p.frozenUntilTurnIndex !== null)))
            let canGuessComputed = baseCanGuess && (!viewerDDActive || !viewerDDTarget || viewerDDTarget === p.id) && !(targetFrozen && p.id !== myId)
            
              const gm = state && state.gameMode
              if (gm === 'lastTeamStanding') {
                const me = (state?.players || []).find(x => x.id === myId) || {}
                const myTeam = me && me.team ? me.team : null
                if (myTeam && p.team && myTeam === p.team) {
                  canGuessComputed = false
                }
              }
           

            const wasPenalized = Object.keys(state?.timeouts || {}).some(k => (state?.timeouts && state.timeouts[k] && state.timeouts[k].player) === p.id && recentPenalty[k])
            const powerUpActive = powerUpsEnabled && (myId === currentTurnId) && p.id !== myId && !p.eliminated
            let pupReason = null
            if (!powerUpsEnabled) pupReason = 'Curses are disabled'
            else if (p.id === myId) pupReason = 'Cannot target yourself'
            else if (p.eliminated) pupReason = 'Player is eliminated'
            else if (ddShopLocked) pupReason = 'Double Down placed : make your guess first'
            else {
              const me = (state?.players || []).find(x => x.id === myId) || {}
              const cheapest = Math.min(...(POWER_UPS || []).map(x => x.price))

              let myHang = Number(me.wordmoney) || 0
              if (gm === 'lastTeamStanding') {
                // team hangs are shared; check team balance
                // guard state.teams itself before indexing (it may be null briefly)
                myHang = Number(state?.teams?.[me.team]?.wordmoney || 0)
              }
              
              if (myHang < cheapest) pupReason = `Need at least ${cheapest} 🪙 to buy curses.`
              
            }

            return (
              <div key={`pc_wrap_${p.id}`} style={{ position: 'relative' }}>
                <PlayerCircle
                  key={p.id}
                  player={playerWithViewer}
                  ready={!!p.ready}
                  onToggleReady={async (targetId, newVal) => { try { if (targetId === myId) await togglePlayerReady(targetId, newVal) } catch (e) { console.warn('onToggleReady failed', e) } }}
                  teamName={p.team}
                  viewerTeam={viewerNode.team}
                  teamMoney={Number(state?.teams?.[p.team]?.wordmoney || 0)}
                  gameMode={state?.gameMode}
                  viewerIsSpy={state && state.wordSeeker && state.wordSeeker.spyId === myId}
                  isSelf={p.id === myId}
                  hostId={hostId}
                  isHost={isHost}
                  onRemove={removePlayer}
                  viewerId={myId}
                  roomId={roomId}
                  // whether the current viewer has an active team reveal for this player
                  teamRevealForPlayer={!!(state?.teamReveals?.[p.team]?.[p.id]?.[myId])}
                  // handler to toggle a team reveal for this player (writes to DB)
                  onToggleTeamReveal={async (targetPlayerId, teamName, show) => {
                    try {
                      const roomRef = dbRef(db, `rooms/${roomId}`)
                      const updates = {}
                      const path = `teamReveals/${teamName}/${targetPlayerId}/${myId}`
                      if (show) updates[path] = { ts: Date.now(), by: myId }
                      else updates[path] = null
                      await safeDbUpdate(roomRef, updates)
                    } catch (e) {
                      console.warn('Could not toggle team reveal', e)
                    }
                  }}
                  phase={phase}
                  hasSubmitted={!!p.hasWord}
                  canGuess={canGuessComputed}
                  ddActive={viewerDDActive}
                  ddTarget={viewerDDTarget}
                  onGuess={async (targetId, guess) => {
                    try { setDdShopLocked(false) } catch (e) {}
                    try {
                      const res = await sendGuess(targetId, guess)
                      if (res && res.blocked) {
                        const toastId = `dup_guess_${Date.now()}`
                        setToasts(t => [...t, { id: toastId, text: res.message || 'Duplicate guess', error: true }])
                        // auto-hide after short interval
                        setTimeout(() => setToasts(t => t.map(x => x.id === toastId ? { ...x, removing: true } : x)), 2200)
                        setTimeout(() => setToasts(t => t.filter(x => x.id !== toastId)), 2600)
                        return
                      }
                    } catch (e) {
                      // if sendGuess threw, swallow here and allow existing error handling elsewhere
                    }
                  }}
                  showPowerUpButton={powerUpsEnabled && p.id !== myId}
                  onOpenPowerUps={(targetId) => { setPowerUpTarget(targetId); setPowerUpOpen(true); setPowerUpChoiceValue(''); setPowerUpStakeValue('') }}
                  onSkip={phase === 'playing' ? skipTurn : undefined}
                  playerIdToName={playerIdToName}
                  timeLeftMs={msLeftForPlayer} currentTurnId={currentTurnId}
                  starterApplied={!!state?.starterBonus?.applied}
                  flashPenalty={wasPenalized}
                  pendingDeduct={pendingDeducts[p.id] || 0}
                  isWinner={p.id === state?.winnerId}
                  powerUpDisabledReason={pupReason}
                  revealPreserveOrder={revealPreserveOrder}
                  revealShowBlanks={revealShowBlanks}
                  showGhostReenter={Boolean(p.eliminated && ghostReEntryEnabled && p.id === myId && (state?.players || []).filter(x => x && !x.eliminated).length >= 2 && !(p.ghostState && p.ghostState.reentered))}
                  ghostReenterDisabled={!!ghostCooldownSec}
                  onGhostReenter={() => { setGhostModalOpen(true); setGhostChallengeKeyLocal((state && state.ghostChallenge && state.ghostChallenge.key) || null) }}
                />
                
              </div>
            )
          }

          // direct renderTile usage (we hardened team lookups elsewhere; remove temporary debug wrapper)

          // If playing Last Team Standing, render three-column team layout (red / others / blue)
          if ((state && state.gameMode) === 'lastTeamStanding') {
            const redPlayers = sanitized.filter(p => (p && p.team) === 'red')
            const bluePlayers = sanitized.filter(p => (p && p.team) === 'blue')
            const others = sanitized.filter(p => !(p && p.team) || ((p.team) !== 'red' && (p.team) !== 'blue'))

            return (
              <div style={{ display: 'flex', gap: 16, justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
                <div style={{ flex: '0 0 45%', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                  {/* Team wallet box for Red team (shown when lastTeamStanding mode is active) */}
                  {state?.gameMode === 'lastTeamStanding' && state?.teams?.red && (
                    <div style={{ width: '90%', padding: '10px 14px', borderRadius: 10, background: '#ff4d4f', color: '#fff', fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Red Team</span>
                      <span style={{ fontFamily: 'monospace' }}>${(state?.teams?.red?.wordmoney || 0)}</span>
                    </div>
                  )}
                  {redPlayers.map(p => renderTile(p))}
                </div>
                <div style={{ flex: '0 0 10%', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                  {others.map(p => renderTile(p))}
                </div>
                <div style={{ flex: '0 0 45%', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                  {/* Team wallet box for Blue team (shown when lastTeamStanding mode is active) */}
                  {state?.gameMode === 'lastTeamStanding' && state?.teams?.blue && (
                    <div style={{ width: '90%', padding: '10px 14px', borderRadius: 10, background: '#1890ff', color: '#fff', fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Blue Team</span>
                      <span style={{ fontFamily: 'monospace' }}>${(state?.teams?.blue?.wordmoney || 0)}</span>
                    </div>
                  )}
                  {bluePlayers.map(p => renderTile(p))}
                </div>
              </div>
            )
          }

          // Non-team modes: render players in a circular/wrap layout centered on screen
          return (
            <div style={{ paddingTop: '2vh', display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'center', width: '100%' }}>
              {orderedPlayers.map(p => (
                <div key={`pc_circle_${p.id}`} style={{ flex: '0 0 auto' }}>{renderTile(p)}</div>
              ))}
            </div>
          )
        })()}
      </div>

      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.multi ? 'multi-hit-toast' : ''} ${t.removing ? 'removing' : ''} ${t.success ? 'toast-success' : ''} ${t.error ? 'toast-error' : ''}`}>
            {t.multi && (
              <>
                <span className="confetti-like" />
                <span className="confetti-like" />
                <span className="confetti-like" />
              </>
            )}
            {t.node ? t.node : t.text}
          </div>
        ))}
      </div>

  </div>{/* end app-content */}

        </div>{/* end left column */}
        {!isNarrow && (
          <div style={{ gridColumn: '2 / 3', padding: 12, boxSizing: 'border-box' }}>
            <div style={{ position: 'sticky', top: 18, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-end' }}>
              {/* authoritative mode badge rendered in the right gutter so it doesn't overlap centered content */}
        <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end' }}>{/* ModeBadge moved to render after victory screen so it appears above it */}</div>

              {/* Host PlayAgain controls shown in the gutter (moved to the main victory screen to avoid duplicates) */}

              {/* Turn indicator (flowed into the gutter instead of fixed) */}
              {/* <div className="turn-indicator" style={{ fontSize: 13, color: '#ddd', textAlign: 'right' }}>
                {phase === 'playing' ? `Current turn: ${players.find(p => p.id === currentTurnId)?.name || '-'}` : null}
              </div> */}

              {/* Reveal indicator (kept visible during playing) */}
              {/* {(phase === 'playing') && (
                <div style={{ fontSize: 12, color: '#ddd', background: 'rgba(0,0,0,0.12)', padding: '6px 10px', borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,0.06)', textAlign: 'right' }}>
                  Reveal letters based on occurence in word: <strong style={{ marginLeft: 6, color: '#fff' }}>{(typeof state?.revealPreserveOrder === 'boolean') ? (state.revealPreserveOrder ? 'No' : 'Yes') : (revealPreserveOrder ? 'On' : 'Off')}</strong>
                </div>
              )} */}

              {/* Turn timer (flowed into gutter) */}
              {phase === 'playing' && state?.timed && state?.turnTimeoutSeconds && state?.currentTurnStartedAt && (
                <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end' }}>
                  <div className="turn-timer" style={{ textAlign: 'right' }}>
                    <div className="bar"><div className="fill" style={{ width: `${Math.max(0, (state?.currentTurnStartedAt + (state?.turnTimeoutSeconds*1000) - Date.now()) / (state?.turnTimeoutSeconds*1000) * 100)}%` }} /></div>
                    <div className="time">{(() => {
                      const msLeft = Math.max(0, (state?.currentTurnStartedAt || 0) + ((state?.turnTimeoutSeconds || 0)*1000) - Date.now())
                      const s = Math.ceil(msLeft / 1000)
                      return `${s}s`
                    })()}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>{/* end two-column grid */}
  {/* falling coins overlay for recent double-down wins (rendered at top-level so z-index works) */}
  {
    ddCoins && ddCoins.length > 0 && (console.log && console.log('render: dd-coin-overlay count', ddCoins.length, ddCoins && ddCoins.slice(0,6)))
  }
  {/* Render authoritative ModeBadge after major overlays (including victory screen) so it appears above them visually.
      Only render the fixed overlay on wide layouts — when `isNarrow` is true we already render an inline compact ModeBadge
      earlier. This prevents duplicate mode-badge elements on small viewports. */}
  {!isNarrow && (
    <div style={{ position: 'fixed', right: 18, top: 18, zIndex: 'auto', pointerEvents: 'none' }}>
      <ModeBadge fixed={true} />
    </div>
  )}
  {/* Lava-style top timer bar: visible during playing when timed */}
  {phase === 'playing' && state?.timed && state?.turnTimeoutSeconds && state?.currentTurnStartedAt && (() => {
    try {
      const durationMs = Number(state.turnTimeoutSeconds || 0) * 1000
      const elapsed = Math.max(0, Date.now() - (state.currentTurnStartedAt || 0))
      const pct = Math.max(0, Math.min(100, (elapsed / Math.max(1, durationMs)) * 100))
      const embers = new Array(10).fill(0).map(() => ({ left: (Math.random() * 100), delay: (Math.random() * 1.6) }))
      const node = (
        <div className="lava-timer" aria-hidden="true">
          <div className="lava-track">
            <div className="lava-fill" style={{ width: `${pct}%` }} />
            {embers.map((e, i) => <span key={i} className="lava-ember" style={{ left: `${e.left}%`, animationDelay: `${e.delay}s` }} />)}
          </div>
        </div>
      )
      return node
    } catch (e) { return null }
  })()}
  {
    // build overlay node and portal it to body-level root when available to avoid stacking-context clipping
    (() => {
      const overlayNode = (
        <div className={`dd-coin-overlay debug-visible`} aria-hidden="true">
          {ddCoins && ddCoins.length > 0 ? ddCoins.map((c, i) => (
            <span key={i} className="coin-piece" style={{ left: `${c.left}%`, animationDelay: `${c.delay}s`, width: `${c.size}px`, height: `${c.size}px` }} />
          )) : (
            <div style={{ position: 'absolute', left: 12, top: 12, color: 'rgba(255,255,255,0.9)', fontSize: 12 }}></div>
          )}
        </div>
      )
      if (ddOverlayRoot && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) {
        try { return ReactDOM.createPortal(overlayNode, ddOverlayRoot) } catch (e) { return overlayNode }
      }
      return overlayNode
    })()
  }

  {/* Free bubble overlay (underworld themed) */}
  {
    (state && state.freeBubble && state.gameMode !== 'wordSeeker') && (() => {
      try {
        const fb = state.freeBubble
        if (!fb) return null
        // determine a per-bubble random position (persisted while the bubble id exists)
        const key = fb.id || `fb_${fb.spawnedAt || Date.now()}`
        let pos = freeBubblePositionsRef.current[key]
        try {
          if (!pos) {
            // choose a viewport-relative percent position with safe margins
            const left = 6 + Math.random() * 84 // 6%..90%
            const top = 8 + Math.random() * 72 // 8%..80%
            pos = { left, top }
            freeBubblePositionsRef.current[key] = pos
          }
        } catch (e) { pos = pos || { left: 16, top: 60 } }

        const overlayNode = (
          <div style={{ position: 'fixed', left: `${pos.left}%`, top: `${pos.top}%`, zIndex: 13050, pointerEvents: 'auto' }} aria-hidden={false}>
            <div
              role="button"
              onClick={async () => {
                try {
                  if (!fb || fb.claimedBy || claimingBubbleId) return
                  setClaimingBubbleId(fb.id)
                  await claimFreeBubble(fb)
                } catch (e) {} finally { setClaimingBubbleId(null) }
              }}
              className={`free-bubble-tombstone tombstone ${fb && fb.claimedBy ? 'disabled' : ''}`}
              title={fb && fb.amount ? `Claim +${fb.amount} wordmoney` : 'Claim free wordmoney'}
              aria-disabled={Boolean(fb && fb.claimedBy) || Boolean(claimingBubbleId)}
              style={{ position: 'relative' }}
            >
              <span className="tomb-icon">🪦</span>
              <div className="tomb-body">
                <div className="tomb-amount">{fb && fb.amount ? `+${fb.amount} wordmoney` : 'Free!'}</div>
                <div className="tomb-sub">{(fb && fb.claimedBy) ? 'Claimed' : 'Underworld tombstone'}</div>
              </div>
            </div>
          </div>
        )
        if (ddOverlayRoot && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) {
          try { return ReactDOM.createPortal(overlayNode, ddOverlayRoot) } catch (e) { return overlayNode }
        }
        return overlayNode
      } catch (e) { return null }
    })()
  }

  
  {/* Big overlays: Waiting for player or Your Turn */}
  {(() => {
    try {
      // Show big waiting banner during submission phase (removed)
      // Prominent Your Turn banner handled inside the players circle now; keep waiting overlay here
    } catch (e) {}
    return null
  })()}
  {/* Ghost re-enter overlay (floating ghosts + centered message) */}
  {
    ghostReenterEvents && ghostReenterEvents.length > 0 && (() => {
      const overlayNode = (
        <div className="ghost-reenter-overlay" aria-hidden="true">
          {ghostReenterEvents.map(ev => (
            <div key={ev.id} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div className="ghost-reenter-card">{`${ev.name}'s ghost re-entered the game!`}</div>
              <div className="ghost-floating" aria-hidden>
                {new Array(12).fill(0).map((_,i) => (
                  <span key={i} className="ghost-emoji" style={{ left: `${10 + Math.random()*80}%`, animationDelay: `${Math.random()*1.2}s`, fontSize: `${20 + Math.random()*28}px` }}>👻</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )
      if (ddOverlayRoot && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) {
        try { return ReactDOM.createPortal(overlayNode, ddOverlayRoot) } catch (e) { return overlayNode }
      }
      return overlayNode
    })()
  }
  {/* Underworld elimination banner */}
  {underworldEvent && (() => {
    const overlayNode = (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 12010 }} aria-hidden>
        <div style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.72), rgba(16,16,16,0.6))', color: '#fff', padding: '18px 24px', borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,0.6)', maxWidth: '92%', textAlign: 'center' }}>
          <div style={{ fontSize: 20, opacity: 0.98, fontWeight: 700 }}>{underworldEvent.text}</div>
        </div>
      </div>
    )
    if (ddOverlayRoot && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) {
      try { return ReactDOM.createPortal(overlayNode, ddOverlayRoot) } catch (e) { return overlayNode }
    }
    return overlayNode
  })()}
  {/* Power-up modal (always rendered; visibility controlled by its `open` prop) */}
  {(() => {
    const node = <PowerUpModal open={powerUpOpen} targetId={powerUpTarget} onClose={() => setPowerUpOpen(false)} />
    if (modalRoot && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) {
      try { return ReactDOM.createPortal(node, modalRoot) } catch (e) { return node }
    }
    return node
  })()}

  {/* Ghost Re-Entry modal for eliminated players */}
  {ghostModalOpen && (
    <div className="modal-backdrop">
      <div className="modal card" style={{ maxWidth: 520 }}>
        <h3>Ghost Re-entry</h3>
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: '#f5f5f5', fontFamily: 'Inter, sans-serif', lineHeight: 1.6, backgroundColor: '#2b2b2b', padding: 20, borderRadius: 12, maxWidth: 600, margin: 'auto' }}>
            <h2 style={{ color: '#ffcc00', textAlign: 'center' }}>👻 Ghost Mode</h2>
            <p><span style={{ color: '#00e5ff' }}>As a ghost</span>, your goal is to guess a shared mystery word.</p>
            <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
              <li>🅰️ Guess <span style={{ color: '#90ee90' }}>letters</span> to reveal all their occurrences.</li>
              <li>💡 When you think you know it, guess the <span style={{ color: '#ffa07a' }}>full word</span> to rejoin the game.</li>
              <li>🔀 Correct letters appear <span style={{ color: '#ff69b4' }}>shuffled</span>, not in order.</li>
              <li>🎯 If your room has a theme, the word fits it, but may ignore the "bonus letter" rule.</li>
              <li>⏳ You can guess <span style={{ color: '#ffcc00' }}>once every 15 seconds</span>. Ghosts need time to think.</li>
              <li>🌍 All ghosts share the same word. When one solves it, a <span style={{ color: '#00e5ff' }}>new word</span> appears for the rest.</li>
            </ul>
          </div>
          {/* Show the current challenge and the viewer's ghost guesses (ordered by guess time).
              Correct letters are shown in guess-order and include duplicates (one entry per occurrence).
              Wrong guesses (letters or full-word attempts) are shown separately. */}
          <div style={{ fontSize: 13, marginTop: 6 }}>
            {(() => {
              
                const gw = (state && state.ghostChallenge && state.ghostChallenge.word) ? String(state.ghostChallenge.word) : null
                // render blanks as spaced underscores: "_ _ _"
                const blanks = gw ? gw.split('').map(() => '_').join(' ') : '-'
                const lettersCount = gw ? gw.length : null
                return (
                  <div>
                    <div>
                      Current challenge: <strong>{blanks}</strong>
                      {lettersCount ? (
                        <span style={{ marginLeft: 8, color: '#666', fontSize: 12 }}>
                          ({lettersCount} letter{lettersCount === 1 ? '' : 's'})
                        </span>
                      ) : null}
                      <span
                        title="Ghosts share the same target word. The length is shown to help guesses."
                        aria-label="Ghosts share the same target word. The length is shown to help guesses."
                        style={{ marginLeft: 8, color: '#888', fontSize: 13, cursor: 'help' }}
                      >
                        ℹ
                      </span>
                    </div>
                  </div>
                )
            })()}
            {(() => {
              try {
                const me = (state?.players || []).find(p => p.id === myId) || {}
                const raw = me.ghostGuesses || {}
                const ordered = Object.keys(raw || {}).map(k => ({ key: k, ...(raw[k] || {}) })).sort((a,b) => (Number(a.ts || 0) - Number(b.ts || 0)))
                const correctLetters = []
                const wrongLetters = []
                const wrongWords = []
                ordered.forEach(g => {
                  try {
                    const s = (g && g.guess) ? String(g.guess).toLowerCase() : ''
                    if (!s) return
                    if (s.length === 1) {
                      const positions = Array.isArray(g.positions) ? g.positions : []
                      if (positions.length > 0) {
                        // Repeat the letter for each occurrence found so duplicates appear
                        for (let i = 0; i < positions.length; i++) correctLetters.push(s)
                      } else {
                        wrongLetters.push(s)
                      }
                    } else {
                      // full-word attempts
                      wrongWords.push(s)
                    }
                  } catch (e) {}
                })
                return (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 13 }}><strong>Correct guesses:</strong> {correctLetters.length > 0 ? correctLetters.join(' ') : '-'}</div>
                    <div style={{ fontSize: 13, marginTop: 6 }}><strong>Wrong guesses:</strong> {(wrongLetters.concat(wrongWords).length > 0) ? wrongLetters.concat(wrongWords).join(', ') : '-'}</div>
                  </div>
                )
              } catch (e) { return null }
            })()}
          </div>
        </div>
        {(() => {
          try {
            // use live countdown computed in state so the UI updates every second
            const disabled = ghostCooldownSec > 0
            const remainingSec = ghostCooldownSec
            return (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input id="ghost_guess_input" placeholder="letter or full word" disabled={disabled} />
                <button disabled={disabled} onClick={async () => {
                  try {
                    const el = document.getElementById('ghost_guess_input')
                    const val = el ? el.value.trim() : ''
                    if (!val) return
                    const res = await submitGhostGuess(val)
                    if (!res || !res.ok) {
                      // If server returned a retryAfter, surface friendly message
                      if (res && res.retryAfter) {
                        const sec = Math.ceil(Number(res.retryAfter || 0) / 1000)
                        setToasts(t => [...t, { id: `ghost_cooldown_${Date.now()}`, text: `You can only make a guess every 15 seconds. Try again in ${sec}s.` }])
                        return
                      }
                      console.warn('ghost guess submit failed', res)
                      setToasts(t => [...t, { id: `ghost_err_${Date.now()}`, text: 'Could not submit guess' }])
                      return
                    }
                    if (typeof res.correct !== 'undefined') {
                      if (res.correct) {
                        const okId = `ghost_reenter_ok_${Date.now()}`
                        setToasts(t => [...t, { id: okId, text: 'Correct! You re-entered the game.' }])
                        // auto-dismiss after short interval with a fade
                        setTimeout(() => { try { setToasts(t => t.map(x => x.id === okId ? { ...x, removing: true } : x)) } catch (e) {} }, 2200)
                        setTimeout(() => { try { setToasts(t => t.filter(x => x.id !== okId)) } catch (e) {} }, 2600)
                        setGhostModalOpen(false)
                      } else {
                        const errId = `ghost_wrong_${Date.now()}`
                        setToasts(t => [...t, { id: errId, text: 'Incorrect guess.' }])
                        setTimeout(() => { try { setToasts(t => t.map(x => x.id === errId ? { ...x, removing: true } : x)) } catch (e) {} }, 2200)
                        setTimeout(() => { try { setToasts(t => t.filter(x => x.id !== errId)) } catch (e) {} }, 2600)
                      }
                    } else if (res.positions) {
                      // Avoid exposing exact positions in toasts; modal shows the letters below the challenge.
                      const letterId = `ghost_letter_${Date.now()}`
                      setToasts(t => [...t, { id: letterId, text: 'Letter found.' }])
                      try { if (el) el.value = '' } catch (e) {}
                      // auto-dismiss/fade
                      setTimeout(() => { try { setToasts(t => t.map(x => x.id === letterId ? { ...x, removing: true } : x)) } catch (e) {} }, 2200)
                      setTimeout(() => { try { setToasts(t => t.filter(x => x.id !== letterId)) } catch (e) {} }, 2600)
                    }
                  } catch (e) { console.warn(e) }
                }}>{disabled ? `Wait ${remainingSec}s` : 'Submit'}</button>
                <button onClick={() => setGhostModalOpen(false)}>Close</button>
                <div style={{ marginLeft: 12, fontSize: 13, color: disabled ? '#b00' : '#666' }}>
                  You can only make a guess every 15 seconds{disabled ? `: wait ${remainingSec}s` : ''}.
                </div>
              </div>
            )
          } catch (e) { return (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input id="ghost_guess_input" placeholder="letter or full word" />
              <button onClick={async () => { try { const el = document.getElementById('ghost_guess_input'); const val = el ? el.value.trim() : ''; if (!val) return; await submitGhostGuess(val) } catch (er) {} }}>Submit</button>
              <button onClick={() => setGhostModalOpen(false)}>Close</button>
            </div>
          ) }
        })()}
      </div>
    </div>
  )}

      {/* Chat box (minimisable) - visible on all pages when state available */}
      {state && (
        <ChatBox roomId={roomId} myId={myId} myName={myName} messages={state.chat || {}} players={players} gameMode={state?.gameMode} phase={phase} />
      )}

      {/* Timer tick: client watches for timeout and advances turn if needed (best-effort) */}
        {phase === 'playing' && state?.timed && state?.turnTimeoutSeconds && state?.currentTurnStartedAt && (
        <TimerWatcher roomId={roomId} timed={state?.timed} turnTimeoutSeconds={state?.turnTimeoutSeconds} currentTurnStartedAt={state?.currentTurnStartedAt} currentTurnIndex={state?.currentTurnIndex} />
      )}

      {/* Submit bar moved to bottom so it can be reused for power-ups later */}

      {phase === 'lobby' && state?.password && (
        <div className="room-password">
          <strong>Room Password:</strong> {state?.password}
          {isHost && <span> (You are the host)</span>}
        </div>
      )}

      <div className="controls">
        {/* Controls for guesses and power-ups will go here during playing phase */}
      </div>
      {/* Bottom-fixed submit bar (shown during submit phase). This contains the secret-word entry and submit button
          and is intentionally separated so it can be reused later for power-ups. */}
  {phase === 'submit' 


  && (() => {
        const me = players.find(p => p.id === myId) || {}
        const myHasSubmitted = !!me.hasWord
        const candidateInput = (word || '').toString().trim()
        const localInvalid = !candidateInput || candidateInput.length === 1 || !/^[a-zA-Z]+$/.test(candidateInput)
        return (
          <div style={{ position: 'relative' }}>
            {/* Full-screen dim overlay during submit phase */}
            <div
              aria-hidden="true"
              className="submit-overlay"
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                background: 'rgba(0,0,0,0.98)',
                zIndex: 200
              }}
            >
              {/* Decorative underworld ghosts/fog (purely visual) */}
              <div className="submit-ghost ghost-1" aria-hidden="true" />
              <div className="submit-ghost ghost-2" aria-hidden="true" />
              <div className="submit-fog" aria-hidden="true" />

             
                      <div className="submit-phrases" aria-hidden="true">
                        {(() => {
                          const positions = [
                            { left: '50%', top: '34%' },
                            { left: '50%', top: '46%' },
                            { left: '50%', top: '58%' },
                            { left: '30%', top: '38%' },
                            { left: '70%', top: '38%' },
                            { left: '32%', top: '50%' },
                            { left: '72%', top: '50%' },
                            { left: '34%', top: '30%' },
                            { left: '76%', top: '30%' },
                            { left: '36%', top: '26%' },
                            { left: '74%', top: '26%' }
                          ]
                          const i = submitPhraseIndex || 0
                          const text = (submitPhrases && submitPhrases.length > 0) ? submitPhrases[i % submitPhrases.length] : ''
                          const pos = positions[i % positions.length]
                          const size = `${Math.max(20, 40 - (i % 6))}px`
                          return (
                            <span key={i} className="submit-phrase" style={{ left: pos.left, top: pos.top, fontSize: size, animationDuration: '9s' }}>{text}</span>
                          )
                        })()}
                      </div>
                    </div>
                    <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 202 }}>
                      <button
                      onClick={() => { try { setHowToOpen(o => !o); if (!howToOpen) setHowToMinimized(false) } catch (e) {} }}
                className="how-to-toggle"
                style={{
                  padding: '8px 14px',
                  borderRadius: 20,
                  background: 'linear-gradient(90deg,#ff9d42,#ff6fff)',
                  color: '#141217',
                  fontWeight: 800,
                  border: 'none',
                  boxShadow: '0 8px 28px rgba(255,157,66,0.18)',
                  cursor: 'pointer'
                }}
              >
                How to Play
              </button>
            </div>

            {howToOpen && (
              <div style={{ position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: '100%',  maxWidth: '980px', maxHeight: 'calc(100vh - 120px)', zIndex: 900 }}>
                <div className="how-to-win card" style={{ padding: 22, borderRadius: 12, background: 'rgba(12,12,12,0.995)', border: '1px solid rgba(255,255,255,0.04)', color: '#E8E6E6', fontSize: 16, boxShadow: '0 18px 60px rgba(0,0,0,0.6)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ color: '#ffd28a' }}>How to Play</strong>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setHowToOpen(false)} style={{ padding: '6px 8px', borderRadius: 8, border: 'none', cursor: 'pointer' }}>Close</button>
                    </div>
                  </div>
                  {!howToMinimized && (
                    <div style={{ marginTop: 14, overflowY: 'auto', paddingRight: 8, maxHeight: 'calc(100vh - 200px)' }}>
                      <div>Enter your <span style={{ color: '#4efcfc' }}>secret word</span> now.</div>
                      {secretThemeEnabled && secretThemeType && (
                        <div style={{ marginTop: 6 }}>Pick a word that fits the theme: <strong style={{ color: '#ff9d42', textTransform: 'capitalize' }}>{secretThemeType}</strong>.</div>
                      )}
                      {state?.starterBonus?.enabled && (
                        <div style={{ marginTop: 6 }}>Starter bonus: <strong style={{ color: '#4efcfc' }}>+10 wordmoney</strong> if your word uses the letter <strong style={{ color: '#ffd28a' }}>{state?.starterBonus?.value || 'a specific letter'}</strong>.</div>
                      )}
                      <div style={{ marginTop: 8 }}>Goal: <span style={{ color: '#ff6fff' }}>guess</span> other players' words with the <strong style={{ color: '#4efcfc' }}>Guess</strong> button. {(state?.powerUpsEnabled || powerUpsEnabled) && (<span style={{ color: '#ff9d42' }}>Curses are enabled to reveal more letters.</span>)}</div>
                      <div style={{ marginTop: 6 }}><span style={{ color: '#ff6fff' }}>Guess a letter</span> to reveal it, or <span style={{ color: '#4efcfc' }}>guess the whole word</span> if you know it.</div>
                      {state?.gameMode === 'lastTeamStanding' && (
                        <div style={{ marginTop: 6 }}>Last Team Standing: <span style={{ color: '#ff6fff' }}>guess opponents' words</span> to eliminate them. {state?.firstWordWins ? <span style={{ color: '#ffd28a' }}>First to guess an opponent wins.</span> : <span style={{ color: '#ffd28a' }}>Guess all opponents’ words to win.</span>}</div>
                      )}
                      {state?.gameMode === 'lastOneStanding' && (
                        <div style={{ marginTop: 6 }}>Last One Standing: <span style={{ color: '#ff6fff' }}>be the last player alive</span> to win.</div>
                      )}
                      {(state?.winnerByWordmoney || state?.gameMode === 'money') && (
                        <div style={{ marginTop: 6 }}>Money mode: <span style={{ color: '#4efcfc' }}>have the most wordmoney</span> to win.</div>
                      )}
                      {(typeof state?.ghostReEntryEnabled !== 'undefined' ? state.ghostReEntryEnabled : ghostReEntryEnabled) && (
                        <div style={{ marginTop: 6 }}>Ghost re-entry: if your word is guessed, you may rejoin <span style={{ color: '#ff9d42' }}>once</span> by guessing a system word shared by ghosts.</div>
                      )}
                      {state?.timed && (
                        <div style={{ marginTop: 6, fontWeight: 700, color: '#ffd28a' }}>Watch the <span style={{ color: '#ff6fff' }}>timer</span>!</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}


          <div className="submit-bar card" style={{ position: 'fixed', left: 0, bottom: 0, width: '100%',  maxWidth: '980px', boxSizing: 'border-box', zIndex: 201, overflow: 'hidden', display: 'flex', justifyContent: 'space-between', padding: 10 }}>
         
              <div>
              <h4 style={{ margin: 0 }}>Submit your secret word</h4>
              {secretThemeEnabled && (
                <ThemeBadge type={secretThemeType} />
              )}
              </div>
              {state?.starterBonus?.enabled && (
                <div style={{ marginTop: 6, fontSize: 13, color: '#B4A3A3' }} title={state?.starterBonus?.description}>
                  +10 bonus wordmoney if: <strong>{state?.starterBonus?.description}</strong>
                  <div style={{ marginTop: 4, color: '#e3bebeff', fontSize: 10 }}>
                   Note: All occurrences of this letter in your word will be revealed to other players.</div>
                </div>
              )}
              
              {/* Explain balanced last-team-standing behavior when teams will be unbalanced */}
              {state?.gameMode === 'lastTeamStanding' && state?.firstWordWins && (() => {
                try {
                  const total = (players || []).length || 0
                  if (total >= 2) {
                    const larger = Math.ceil(total / 2)
                    const smaller = Math.floor(total / 2)
                    if (larger !== smaller) {
                      const compBase = (typeof state?.startingWordmoney === 'number') ? Number(state.startingWordmoney) : Number(startingWordmoney || 0)
                      const compExtra = state?.starterBonus && state.starterBonus.enabled ? 10 : 0
                      const comp = compBase + compExtra
                      return (
                        <div style={{ marginTop: 8, fontSize: 10, color: '#666' }}>
                          <strong>Balancing:</strong> Teams will be split approximately {larger} vs {smaller}. The smaller team only needs to eliminate {smaller} player{smaller !== 1 ? 's' : ''} from the larger team to win. At game start the smaller team will be credited <strong>+${comp}</strong> to compensate.
                        </div>
                      )
                    }
                  }
                } catch (e) {}
                return null
              })()}
              {state?.gameMode === 'lastTeamStanding' && !(state?.firstWordWins) && (() => {
                try {
                  const total = (players || []).length || 0
                  if (total >= 2) {
                    const larger = Math.ceil(total / 2)
                    const smaller = Math.floor(total / 2)
                    if (larger !== smaller) {
                      const compBase = (typeof state?.startingWordmoney === 'number') ? Number(state.startingWordmoney) : Number(startingWordmoney || 0)
                      const compExtra = state?.starterBonus && state.starterBonus.enabled ? 10 : 0
                      const comp = compBase + compExtra
                      return (
                        <div style={{ marginTop: 8, fontSize: 10, color: '#666' }}>
                          <strong>Balancing:</strong> Teams will be split approximately {larger} vs {smaller}. At game start the smaller team will be credited <strong>+${comp}</strong> to compensate.
                        </div>
                      )
                    }
                  }
                } catch (e) {}
                return null
              })()}
            
            <div className="submit-controls">
              {!myHasSubmitted ? (
                <>
                  <input
                    id="submit_word"
                    name="submit_word"
                    placeholder="your word"
                    value={word}
                    onChange={e => { setWord(e.target.value); setWordError('') }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        // Mirror the Submit button behavior when Enter is pressed
                        try {
                          // Prevent accidental form submission/defaults
                          e.preventDefault()
                        } catch (err) {}
                        try { handleSubmitWord() } catch (err) {}
                      }
                    }}
                  />
                  <button onClick={handleSubmitWord} disabled={isCheckingDictionary || localInvalid}>{isCheckingDictionary ? 'Checking…' : 'Submit'}</button>
                        {/* Submit-phase timer UI for current player: shows remaining time when enabled */}
                        {submitTimerEnabled && (
                          <div style={{ marginLeft: 12, fontSize: 13, color: '#cfcfcf' }}>
                            {(() => {
                              const start = submitPhaseStartRef.current || Date.now()
                              const secs = Number(submitTimerSeconds) || 60
                              const msLeft = Math.max(0, (start + (secs*1000)) - Date.now())
                              const sLeft = Math.ceil(msLeft/1000)
                              return (<div>Time to submit: <strong>{sLeft}s</strong></div>)
                            })()}
                          </div>
                        )}
                  {/* inline helper / error */}
                  {(wordError || (!isCheckingDictionary && localInvalid && candidateInput)) && (
                    <div className="small-error" style={{ marginLeft: 12 }}>
                      {wordError || (candidateInput && candidateInput.length === 1 ? 'Please pick a word that is at least 2 letters long.' : 'Words may only contain letters. No spaces or punctuation.')}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ padding: '8px 12px' }}>Submitted : waiting for others</div>
              )}
            </div>
            <div>
              <div className="submit-waiting">
                {players.filter(p => !p.hasWord).length > 0 && (
                  <div
                    className="notice"
                    style={{ marginLeft: 12 }}
                    title={`${Math.max(0, (players.length || 0) - (Number(submittedCount) || 0))} player${((players.length || 0) - (Number(submittedCount) || 0)) === 1 ? '' : 's'} still to submit`}
                    aria-label={`Waiting for ${Math.max(0, (players.length || 0) - (Number(submittedCount) || 0))} players`}
                  >
                    <strong>Waiting for:</strong>
                    <div className="waiting-list" style={{ marginTop: 8 }}>
                      {players.filter(p => !p.hasWord).map(p => (
                        <div key={p.id} style={{ marginBottom: 6 }}>
                          <span className="waiting-dot" style={{ background: p.color || '#FFABAB' }} />{p.name}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              </div>
            
          </div>
          </div>
        )
      })()}
        {/* Render ended/victory screen after hooks have been declared to avoid skipping hooks */}
        {phase === 'ended' && (
          <>
          <div className={`victory-screen ${isWinner ? 'confetti' : 'sad'}`}>
            {confettiPieces.map((c, i) => (
              <span key={i} className="confetti-piece" style={{ left: `${c.left}%`, width: c.size, height: c.size * 1.6, background: c.color, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s` }} />
            ))}
            {state?.winnerByWordmoney && cashPieces.map((c, i) => (
              <span key={`cash-${i}`} className="cash-piece" style={{ left: `${c.left}%`, top: `${c.top}px`, transform: `rotate(${c.rotate}deg)`, animationDelay: `${c.delay}s`, position: 'absolute' }} />
            ))}

              <h1>{isWinner ? '🎉 You Win! 🎉' : `😢 ${winnerLabel || '-'} Wins`}</h1>
            <p>{isWinner ? 'All words guessed. Nice work!' : 'Game over : better luck next time.'}</p>

            <div className="standings card" style={{ marginTop: 12 }}>
              <h4>Final standings</h4>
              {state && state.gameMode === 'lastTeamStanding' ? (
                (() => {
                  try {
                    const winnerTeam = state?.winnerTeam || null
                    const winners = sanitizedStandings.filter(p => p && p.team === winnerTeam)
                    const losers = sanitizedStandings.filter(p => p && p.team !== winnerTeam)
                    return (
                      <div style={{ display: 'flex', gap: 12, flexDirection: 'column' }}>
                        <div style={{ padding: 8, borderRadius: 8, background: (winnerTeam == "blue") ? '#1c81adff' : 'rgba(228, 63, 63, 1)', color: '#fff' }}>
                          <strong style={{ fontSize: 16 }}>Winners {winnerTeam ? `(Team ${winnerTeam})` : ''}</strong>
                          <div style={{ marginTop: 8 }}>
                            {winners.length === 0 && <div style={{ color: '#ddd' }}>No winners listed</div>}
                            <ol style={{ margin: 0, paddingLeft: 18 }}>
                              {winners.map((p, idx) => (
                                <li key={p.id} style={{ margin: '6px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <strong>{p.name}</strong>
                                    {showWordsOnEnd && p.word && (
                                      <span style={{ marginLeft: 8, background: '#eef5ee', padding: '4px 8px', borderRadius: 8, fontSize: 12, color: '#234' }}>{p.word}</span>
                                    )}
                                  </div>
                                  <div style={{ fontWeight: 800 }}>${state?.gameMode == "lastTeamStanding" ? (state?.teams[p.team]?.wordmoney || 0):  (p.wordmoney || 0) }</div>
                                </li>
                              ))}
                            </ol>
                          </div>
                        </div>

                        <div style={{ padding: 8, borderRadius: 8, background: '#2b2b2b', color: '#fff' }}>
                          <strong style={{ fontSize: 16 }}>Opponents</strong>
                          <div style={{ marginTop: 8 }}>
                            {losers.length === 0 && <div style={{ color: '#ddd' }}>No opponents listed</div>}
                            <ol style={{ margin: 0, paddingLeft: 18 }}>
                              {losers.map((p, idx) => (
                                <li key={p.id} style={{ margin: '6px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <strong>{p.name}</strong>
                                    {showWordsOnEnd && p.word && (
                                      <span style={{ marginLeft: 8, background: '#eef5ee', padding: '4px 8px', borderRadius: 8, fontSize: 12, color: '#234' }}>{p.word}</span>
                                    )}
                                  </div>
                                  <div style={{ fontWeight: 800 }}>${state?.gameMode == "lastTeamStanding" ? (state?.teams[p.team]?.wordmoney || 0):  (p.wordmoney || 0) }</div>
                                </li>
                              ))}
                            </ol>
                          </div>
                        </div>
                      </div>
                    )
                  } catch (e) { return null }
                })()
              ) : (
                <ol>
                  {sanitizedStandings.map((p, idx) => {
                    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null
                    const accent = idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : idx === 2 ? '#CD7F32' : undefined
                    return (
                      <li key={p.id} style={{ margin: '8px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {medal && <span style={{ fontSize: 22 }}>{medal}</span>}
                          <strong style={{ color: accent || 'inherit' }}>{idx+1}. {p.name}</strong>
                          {showWordsOnEnd && p.word && (
                            <span style={{
                              marginLeft: 8,
                              background: '#eef5ee',
                              padding: '4px 8px',
                              borderRadius: 8,
                              fontSize: 12,
                              color: '#234',
                              display: 'inline-block',
                              maxWidth: '40vw',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}>{p.word}</span>
                          )}
                        </div>
                        <div style={{ fontWeight: 800 }}>
                          <span style={{
                            background: '#f3f3f3',
                            color: p.id === state?.winnerId ? '#b8860b' : '#222',
                            padding: '6px 10px',
                            borderRadius: 16,
                            display: 'inline-block',
                            minWidth: 48,
                            maxWidth: 120,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            textAlign: 'center'
                          }}>
                            ${p.wordmoney || 0}
                          </span>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ marginBottom: 8 }}>
                <PlayAgainControls isHost={isHost} myId={myId} players={players} />
              </div>
              <div style={{ color: '#ddd' }}>If the host clicks Play again, the room will reset automatically.</div>
            </div>
          </div>
          </>
        )}
      
    </div>
  )
}
