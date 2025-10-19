const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Very small CORS helper for local development. Allows Vite dev origin and any origin when running locally.
app.use((req, res, next) => {
  // Allow Vite dev server origin and common localhost variants. In production, a stricter policy is recommended.
  const origin = req.headers.origin || ''
  if (origin && (
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('http://[::1]') ||
    origin === 'https://wordspiracy.vercel.app'
  )) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  // handle preflight
  if (req.method === 'OPTIONS') return res.status(204).end()
  return next()
})

// Simple JSON body parsing (not strictly required for GET proxy below)
app.use(express.json())

// Local API proxy for dictionary endpoint so /api/dictionary executes server-side
app.get('/api/dictionary', async (req, res) => {
  try {
    const word = req.query.word || ''
    if (!word) return res.status(400).json({ error: 'Missing word parameter' })
    const target = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    // Node 18+ has global fetch; otherwise you can `npm install node-fetch` and require it
    const r = await fetch(target)
    const text = await r.text()
    if (!r.ok) {
      console.error(`dictionary proxy: upstream returned ${r.status} for word=${word}`, text && text.slice ? text.slice(0,200) : text)
      return res.status(502).json({ error: 'Upstream dictionary service error', status: r.status, body: (text && text.slice) ? text.slice(0,200) : String(text) })
    }
    try {
      const json = JSON.parse(text)
      return res.status(200).json(json)
    } catch (e) {
      return res.status(200).json({ raw: String(text) })
    }
  } catch (err) {
    console.error('dictionary proxy unexpected error', err && (err.stack || err.message || String(err)))
    return res.status(502).json({ error: err && err.message ? err.message : 'Proxy error' })
  }
})

// Validate an animal name. Uses a local list first for deterministic checks.
// If not found locally, will call the random-animal API as a fallback (but note
// that endpoint returns a random animal, so it's not a reliable lookup). We
// follow the user's instruction: treat 500 responses from the random-animal
// endpoint as valid, 200 means compare names, 404 means invalid.
app.get('/api/validate-animal', async (req, res) => {
  try {
    const candidate = (req.query.word || '').trim()
    if (!candidate) return res.status(400).json({ valid: false, reason: 'missing_word' })
    // load local animals list (bundled with frontend) by requiring the file from src/data
    let ANIMALS = []
    try {
      ANIMALS = require('./src/data/animals.js')
      // If module.exports default style, handle that
      if (ANIMALS && ANIMALS.default) ANIMALS = ANIMALS.default
    } catch (e) {
      console.warn('validate-animal: could not load local animals list', e && e.message)
      ANIMALS = []
    }

    const norm = candidate.toLowerCase()
    if (ANIMALS && ANIMALS.includes && ANIMALS.includes(norm)) {
      return res.json({ valid: true, source: 'local' })
    }

    // Fallback: call random-animal API once and compare
    try {
      const r = await fetch('https://random-animal-api.vercel.app/api/random-animal')
      const text = await r.text()
      if (r.status === 500) {
        // Per user instruction treat 500 as valid
        return res.json({ valid: true, source: 'remote(500-accepted)' })
      }
      if (!r.ok) {
        return res.json({ valid: false, source: 'remote', status: r.status })
      }
      let json
      try { json = JSON.parse(text) } catch (e) { json = { animal: String(text).trim() } }
      const remoteName = (json && (json.animal || json.name)) ? String((json.animal || json.name)).toLowerCase() : String(text).toLowerCase()
      if (remoteName === norm) return res.json({ valid: true, source: 'remote(match)' })
      return res.json({ valid: false, source: 'remote(no-match)', remote: remoteName })
    } catch (e) {
      console.error('validate-animal fallback error', e && (e.stack || e.message || String(e)))
      // On unexpected error, fail-safe: reject as invalid
      return res.json({ valid: false, source: 'error', reason: e && e.message ? e.message : String(e) })
    }
  } catch (err) {
    console.error('validate-animal unexpected', err && (err.stack || err.message || String(err)))
    return res.status(500).json({ valid: false, error: 'server_error' })
  }
})

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("a user connected");

  socket.on("chat message", (msg) => {
    io.emit("chat message", msg);
  });

  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
