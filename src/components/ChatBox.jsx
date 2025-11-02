import React, { useEffect, useRef, useState } from 'react'
import { db } from '../firebase'
import { ref as dbRef, push as dbPush } from 'firebase/database'

export default function ChatBox({ roomId, myId, myName, messages = {} }) {
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef(null)

  // Convert messages object -> sorted array by timestamp
  const arranged = React.useMemo(() => {
    try {
      if (!messages) return []
      return Object.keys(messages || {}).map(k => ({ id: k, ...(messages[k] || {}) })).sort((a,b) => (Number(a.ts || 0) - Number(b.ts || 0)))
    } catch (e) { return [] }
  }, [messages])

  useEffect(() => {
    try {
      // scroll to bottom when messages change
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    } catch (e) {}
  }, [arranged.length])

  async function send() {
    try {
      const v = (text || '').toString().trim()
      if (!v) return
      setSending(true)
      const ref = dbRef(db, `rooms/${roomId}/chat`)
      await dbPush(ref, { from: myId || null, name: myName || 'Someone', text: v, ts: Date.now() })
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
        <button onClick={() => setOpen(o => !o)} style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer' }}>{open ? 'Minimize' : 'Chat'}</button>
      </div>
      <div style={{ display: open ? 'block' : 'none', boxShadow: '0 8px 28px rgba(0,0,0,0.4)', borderRadius: 10, overflow: 'hidden', background: '#121212', color: '#fff' }}>
        <div style={{ padding: '8px 12px', background: 'linear-gradient(90deg,#1f2937,#111827)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Room chat</strong>
          <small style={{ color: '#bbb', marginLeft: 'auto', fontSize: 12 }}>Everyone</small>
        </div>
        <div ref={scrollRef} style={{ maxHeight: 260, overflowY: 'auto', padding: 10, background: '#0b0b0b' }}>
          {arranged.length === 0 && <div style={{ color: '#999', fontSize: 13 }}>No messages yet</div>}
          {arranged.map(m => (
            <div key={m.id} style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: m.from === myId ? '#2563eb' : '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{(m.name || '?')[0] || '?'}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 700 }}>{m.name || 'Someone'}</div>
                  <div style={{ color: '#888', fontSize: 12 }}>{new Date(Number(m.ts || 0)).toLocaleTimeString()}</div>
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
