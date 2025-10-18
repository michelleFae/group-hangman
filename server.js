const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
