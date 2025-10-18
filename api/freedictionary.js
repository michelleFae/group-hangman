// Simple serverless proxy for a free dictionary provider(s).
// This endpoint forwards requests to one of several provider URLs to avoid CORS
// in the browser. It accepts a `?word=` query param and will try providers in order.

export default async function handler(req, res) {
  try {
    const word = (req.query && req.query.word) ? String(req.query.word) : ''
    if (!word) return res.status(400).json({ error: 'missing word' })

    // Candidate providers (server-side only):
    // 1) dictionaryapi.dev (same as primary) — often reliable
    // 2) owlbot (example) or other provider (placeholder)
    // You can reorder or add providers here. Providers that require API keys should
    // be added via server environment variables and conditional logic.

    const providers = [
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      // add more providers here if you want; keep them anonymous-friendly
    ]

    let lastErr = null
    for (const target of providers) {
      try {
        const r = await fetch(target)
        if (r && r.ok) {
          const body = await r.text()
          // Forward the raw body with content-type and status
          res.setHeader('content-type', r.headers.get('content-type') || 'application/json')
          return res.status(r.status).send(body)
        }
      } catch (e) {
        lastErr = e
      }
    }

    // All providers failed or returned not-found — respond with 404
    return res.status(404).json({ error: 'not found', detail: lastErr ? String(lastErr) : null })
  } catch (e) {
    return res.status(500).json({ error: 'proxy error', detail: String(e) })
  }
}
