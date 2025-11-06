import React, { useEffect, useRef, useState } from 'react'
import { db } from '../firebase'
import { ref as dbRef, push as dbPush } from 'firebase/database'

// messages in DB will include optional `recipient` field:
// { type: 'public' } // everyone
// { type: 'private', targetId: '<playerId>' } // visible only to sender and target
// { type: 'team', team: 'red' } // visible only to members of that team (and sender)
export default function ChatBox({ roomId, myId, myName, messages = {}, players = [], gameMode = null, phase = null }) {
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [recipient, setRecipient] = useState({ type: 'public' })
  const scrollRef = useRef(null)
  const [lastSeenTs, setLastSeenTs] = useState(0)

  // Convert messages object -> sorted array by timestamp
  const arranged = React.useMemo(() => {
    try {
      if (!messages) return []
      return Object.keys(messages || {}).map(k => ({ id: k, ...(messages[k] || {}) })).sort((a,b) => (Number(a.ts || 0) - Number(b.ts || 0)))
    } catch (e) { return [] }
  }, [messages])

  // derive myTeam (if any) from players prop
  const myTeam = React.useMemo(() => {
    try {
      const me = (players || []).find(p => p && p.id === myId) || {}
      return me.team || null
    } catch (e) { return null }
  }, [players, myId])

  // Filter arranged messages to only those visible to this viewer
  const visible = React.useMemo(() => {
    try {
      return arranged.filter(m => {
        try {
          const r = m.recipient || { type: 'public' }
          if (!r || r.type === 'public') return true
          if (r.type === 'private') {
            return (m.from === myId) || (r.targetId === myId)
          }
          if (r.type === 'team') {
            // Only show team messages to members of that team
            if (!myTeam) return false
            return r.team === myTeam
          }
          return true
        } catch (e) { return false }
      })
    } catch (e) { return [] }
  }, [arranged, myId, myTeam])

  useEffect(() => {
    try {
      // scroll to bottom when messages change
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    } catch (e) {}
  }, [arranged.length])

  // load last-seen timestamp from localStorage for this room+player
  useEffect(() => {
    try {
      const key = `gh_chat_last_seen_${roomId}_${myId}`
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
      const v = raw ? Number(raw) : 0
      setLastSeenTs(Number.isFinite(v) ? v : 0)
    } catch (e) { setLastSeenTs(0) }
  }, [roomId, myId])

  // when opening the chat, mark all visible messages as seen (persist latest ts)
  useEffect(() => {
    try {
      if (!open) return
      // compute latest visible message ts
      const latest = visible.length ? Math.max(...visible.map(m => Number(m.ts || 0))) : 0
      if (latest && latest > (lastSeenTs || 0)) {
        try {
          const key = `gh_chat_last_seen_${roomId}_${myId}`
          if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(latest))
        } catch (e) {}
        setLastSeenTs(latest)
      }
    } catch (e) {}
  }, [open])

  // Auto-minimize chat when entering the submit phase so players can focus on entering a word
  useEffect(() => {
    try {
      if (phase === 'submit') {
        setOpen(false)
      }
    } catch (e) {}
  }, [phase])

  // Reset recipient to public when the room is reset (players cleared).
  // Preserve user's chosen recipient across sends until the room is reset.
  useEffect(() => {
    try {
      if (!players || (Array.isArray(players) && players.length === 0)) {
        setRecipient({ type: 'public' })
      }
    } catch (e) {}
  }, [players && players.length])

  // compute unread messages counts by type (visible messages from others newer than lastSeenTs)
  const { unreadCount, unreadPrivateCount, unreadTeamCount, unreadPublicCount } = React.useMemo(() => {
    try {
      if (!visible || !Array.isArray(visible)) return { unreadCount: 0, unreadPrivateCount: 0, unreadTeamCount: 0, unreadPublicCount: 0 }
      const cutoff = Number(lastSeenTs || 0)
      let priv = 0, team = 0, pub = 0
      visible.forEach(m => {
        try {
          if (!m || !m.from || m.from === myId) return
          const t = Number(m.ts || 0)
          if (t <= cutoff) return
          const r = (m.recipient && m.recipient.type) ? m.recipient.type : 'public'
          if (r === 'private') priv++
          else if (r === 'team') team++
          else pub++
        } catch (e) {}
      })
      const total = priv + team + pub
      return { unreadCount: total, unreadPrivateCount: priv, unreadTeamCount: team, unreadPublicCount: pub }
    } catch (e) { return { unreadCount: 0, unreadPrivateCount: 0, unreadTeamCount: 0, unreadPublicCount: 0 } }
  }, [visible, lastSeenTs, myId])

  async function send() {
    try {
      const v = (text || '').toString().trim()
      if (!v) return
      setSending(true)
      const ref = dbRef(db, `rooms/${roomId}/chat`)
      const payload = { from: myId || null, name: myName || 'Someone', text: v, ts: Date.now() }
      // attach recipient metadata when not public
      try { if (recipient && recipient.type && recipient.type !== 'public') payload.recipient = recipient } catch (e) {}
      await dbPush(ref, payload)
      setText('')
      setSending(false)
    } catch (e) {
      console.warn('Chat send failed', e)
      setSending(false)
    }
  }

  return (
    <div style={{ position: 'fixed', right: 18, bottom: 18, width: 320, zIndex: 13000, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button onClick={() => setOpen(o => !o)} style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', position: 'relative' }}>
          {open ? 'Minimize' : 'Chat'}
          {!open && unreadCount > 0 && (
            (() => {
              // choose badge color by priority: private > team > public
              const badgeColor = unreadPrivateCount > 0 ? '#ef4444' : (unreadTeamCount > 0 ? '#3b82f6' : '#10b981')
              return (
                <span aria-hidden style={{ position: 'absolute', top: -6, right: -6, background: badgeColor, color: '#fff', borderRadius: 999, padding: '4px 6px', fontSize: 12, fontWeight: 800, minWidth: 20, textAlign: 'center' }}>{unreadCount > 9 ? '9+' : unreadCount}</span>
              )
            })()
          )}
        </button>
      </div>
      <div style={{ display: open ? 'block' : 'none', boxShadow: '0 8px 28px rgba(0,0,0,0.4)', borderRadius: 10, overflow: 'hidden', background: '#121212', color: '#fff' }}>
        <div style={{ padding: '8px 12px', background: 'linear-gradient(90deg,#1f2937,#111827)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Room chat</strong>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <small style={{ color: '#bbb', fontSize: 12 }}>{recipient && recipient.type === 'public' ? 'Everyone' : (recipient.type === 'team' ? `Team: ${recipient.team}` : `Private: ${players.find(p => p.id === (recipient.targetId || ''))?.name || 'someone'}`)}</small>
            {/* Recipient selector */}
            <select value={JSON.stringify(recipient)} onChange={e => { try { setRecipient(JSON.parse(e.target.value)) } catch (err) {} }} style={{ marginLeft: 8, padding: '6px 8px', borderRadius: 6, background: '#0b0b0b', color: '#fff', border: '1px solid rgba(255,255,255,0.04)' }}>
              <option value={JSON.stringify({ type: 'public' })}>Public</option>
              {/* Team option only when in lastTeamStanding and in playing phase */}
              {gameMode === 'lastTeamStanding' && phase === 'playing' && myTeam ? (
                <option value={JSON.stringify({ type: 'team', team: myTeam })}>Team ({myTeam})</option>
              ) : null}
              <optgroup label="Players">
                {(players || []).filter(p => p && p.id).map(p => (
                  <option key={p.id} value={JSON.stringify({ type: 'private', targetId: p.id })}>{p.name}{p.id === myId ? ' (you)' : ''}</option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
        <div ref={scrollRef} style={{ maxHeight: 260, overflowY: 'auto', padding: 10, background: '#0b0b0b' }}>
          {visible.length === 0 && <div style={{ color: '#999', fontSize: 13 }}>No messages yet</div>}
          {visible.map(m => (
            <div key={m.id} style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: m.from === myId ? '#2563eb' : '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{(m.name || '?')[0] || '?'}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 700 }}>{m.name || 'Someone'}</div>
                  <div style={{ color: '#888', fontSize: 12 }}>{new Date(Number(m.ts || 0)).toLocaleTimeString()}</div>
                  {m.recipient && m.recipient.type && m.recipient.type !== 'public' && (
                    <div style={{ marginLeft: 8, fontSize: 12, color: '#9ca3af', background: 'rgba(255,255,255,0.02)', padding: '4px 8px', borderRadius: 8 }}>
                      {m.recipient.type === 'private' ? `Private → ${players.find(p => p.id === m.recipient.targetId)?.name || m.recipient.targetId}` : (m.recipient.type === 'team' ? `Team: ${m.recipient.team}` : '')}
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 4, color: '#e9e9e9', fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.text}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: 8, borderTop: '1px solid rgba(255,255,255,0.04)', background: '#0b0b0b' }}>
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send() } }} placeholder="Type a message…" style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: 'none', outline: 'none', background: '#111', color: '#fff' }} maxLength={500} />
          <button onClick={send} disabled={sending || !text.trim()} style={{ padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: sending ? '#444' : '#10b981', color: '#041' }}>{sending ? '…' : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}
