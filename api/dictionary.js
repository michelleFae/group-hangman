import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const word = req.query.word;
    if (!word) return res.status(400).json({ error: 'Missing word parameter' });

    const target = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
    const r = await fetch(target);
    const text = await r.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(text);
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(502).json({ error: err.message });
  }
}
