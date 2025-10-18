export default async function handler(req, res) {
  // Simple proxy for dictionaryapi.dev to avoid browser CORS issues when hosted (e.g. Vercel)
  try {
    const q = (req.query && req.query.word) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('word') : null)
    const word = q ? String(q).trim() : null
    if (!word) {
      res.status(400).json({ error: 'missing word query param' })
      return
    }

    const target = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    const r = await fetch(target)

    // forward status and content-type
    res.status(r.status)
    const ct = r.headers.get('content-type')
    if (ct) res.setHeader('content-type', ct)

    // stream the body through
    const body = await r.arrayBuffer()
    const buf = Buffer.from(body)
    res.send(buf)
  } catch (err) {
    console.error('api/dictionary proxy error', err)
    res.status(502).json({ error: 'proxy_failed', detail: String(err && err.message) })
  }
}
