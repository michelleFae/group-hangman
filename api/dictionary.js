import fetch from 'node-fetch';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const word = req.query.word;
    if (!word) return res.status(400).json({ error: 'Missing word parameter' });

    const target = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
    const r = await fetch(target);
    const text = await r.text();

    // If upstream returned non-OK, log and return a JSON error for the client to consume
    if (!r.ok) {
      console.error(`dictionary proxy: upstream returned ${r.status} for word=${word}`, text && text.slice ? text.slice(0, 200) : text)
      return res.status(502).json({ error: 'Upstream dictionary service error', status: r.status, body: (text && text.slice) ? text.slice(0, 200) : String(text) })
    }

    // Try to parse JSON; if upstream returned non-JSON (unexpected), return safe JSON wrapper
    try {
      const json = JSON.parse(text)
      res.setHeader('Content-Type', 'application/json')
      return res.status(200).json(json)
    } catch (parseErr) {
      console.warn('dictionary proxy: upstream returned non-JSON body; returning as text in JSON wrapper', { word })
      return res.status(200).json({ raw: String(text) })
    }
  } catch (err) {
    console.error('dictionary proxy: unexpected error', err && (err.stack || err.message || String(err)))
    return res.status(502).json({ error: err && err.message ? err.message : 'Proxy error' })
  }
}
