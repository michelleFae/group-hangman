// Single-word Olympic sports (past and present) - lowercase single-word tokens only.
// This list is curated from the user's provided list and filtered to single words.

const RAW = [
  'aeronautics',
  'alpinism',
  'angling',
  'archery',
  'athletics',
  'badminton',
  'breakdancing',
  'baseball',
  'basketball',
  'biathlon',
  'bobsleigh',
  'boxing',
  'canoeing',
  'cricket',
  'croquet',
  'curling',
  'cycling',
  'climbing',
  'bouldering',
  'diving',
  'equestrian',
  'fencing',
  'football',
  'gliding',
  'golf',
  'glima',
  'gymnastics',
  'handball',
  'hockey',
  'hurling',
  'judo',
  'karate',
  'lacrosse',
  'luge',
  'marathon',
  'motorboating',
  'polo',
  'pentathlon',
  'rowing',
  'rackets',
  'roque',
  'rugby',
  'sailing',
  'shooting',
  'skating',
  'skateboarding',
  'skiing',
  'skeleton',
  'snowboarding',
  'softball',
  'squash',
  'surfing',
  'swimming',
  'taekwondo',
  'tennis',
  'triathlon',
  'volleyball',
  'weightlifting',
  'wrestling'
]

// Canonicalize: lowercase + dedupe while preserving provided tokens
const seen = new Set()
const OLYMPIC_SPORTS = []
for (const t of RAW) {
  const tok = String(t).toLowerCase()
  if (!seen.has(tok)) {
    seen.add(tok)
    OLYMPIC_SPORTS.push(tok)
  }
}

export default OLYMPIC_SPORTS
