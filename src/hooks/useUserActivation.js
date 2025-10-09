import { useEffect, useRef } from 'react'

// Hook: useUserActivation
// Listens for first user gesture (click/keydown/touch) and then:
// - resumes a provided AudioContext (if one exists on window.__ghAudioContext or created lazily)
// - plays a short unlock beep using an oscillator if needed
// - triggers navigator.vibrate if available
// - dispatches a global CustomEvent 'gh:user-activated' for other parts of the app to listen
// Returns nothing; side-effects only.

export default function useUserActivation({ onActivated } = {}) {
  const activatedRef = useRef(false)
  const ctxRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (activatedRef.current) return

    function doActivate(e) {
      if (activatedRef.current) return
      activatedRef.current = true

      // Try to resume an existing AudioContext on window or create one
      try {
        const existing = window.__ghAudioContext
        if (existing && typeof existing.resume === 'function') {
          existing.resume().catch(()=>{})
          ctxRef.current = existing
        } else {
          try {
            const AC = window.AudioContext || window.webkitAudioContext
            if (AC) {
              const ac = new AC()
              // store globally so other modules can reuse
              window.__ghAudioContext = ac
              ctxRef.current = ac
              // resume right away
              ac.resume().catch(()=>{})
            }
          } catch (e) {
            // ignore audio creation failures
          }
        }
      } catch (e) {}

      // Try to play a short unlock beep if we have an AudioContext
      try {
        const ac = ctxRef.current || window.__ghAudioContext
        if (ac && typeof ac.createOscillator === 'function') {
          const o = ac.createOscillator()
          const g = ac.createGain()
          o.type = 'sine'
          o.frequency.value = 440
          g.gain.value = 0.0001
          o.connect(g)
          g.connect(ac.destination)
          const now = ac.currentTime
          o.start(now)
          // quick ramp to avoid click
          g.gain.setValueAtTime(0.0001, now)
          g.gain.exponentialRampToValueAtTime(0.02, now + 0.05)
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15)
          o.stop(now + 0.16)
        }
      } catch (e) {}

      // Short vibration (50ms) if supported
      try {
        if (navigator && typeof navigator.vibrate === 'function') {
          navigator.vibrate(50)
        }
      } catch (e) {}

      // Dispatch global event for other modules
      try {
        const ev = new CustomEvent('gh:user-activated', { detail: { time: Date.now() } })
        window.dispatchEvent(ev)
      } catch (e) {}

      // call optional callback
      try { if (typeof onActivated === 'function') onActivated() } catch (e) {}

      // cleanup listeners
      removeListeners()
    }

    function removeListeners() {
      window.removeEventListener('click', doActivate, true)
      window.removeEventListener('keydown', doActivate, true)
      window.removeEventListener('touchstart', doActivate, true)
    }

    // Attach listeners in capture phase so we catch gestures before they may be stopped
    window.addEventListener('click', doActivate, true)
    window.addEventListener('keydown', doActivate, true)
    window.addEventListener('touchstart', doActivate, true)

    return () => removeListeners()
  }, [onActivated])
}
