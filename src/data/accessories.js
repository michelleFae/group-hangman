// Accessories theme - single-word tokens only (lowercase)
// Curated list of fashion/accessory tokens. Normalized at export (lowercase, letters-only, deduped).

const RAW = [
  'hat','cap','beanie','headband','helmet','scarf','shawl','glove','mitten','mittens','belt','tie','bowtie','cufflink','cuff','tieclip','tiepin','bracelet','necklace','pendant','locket','ring','earring','earcuff','brooch','pin','lapelpin','hairpin','hairclip','hairband','hairtie','choker','fob','stud',
  'sunglasses','glasses','eyeglasses','monocle','goggles','mask','visor',
  'watch','pocketwatch','watchstrap','handbag','bag','purse','clutch','wallet','cardholder','coinpurse','backpack','satchel','messengerbag','briefcase','beltbag','fannypack','keepall','pocketsquare',
  'lanyard','keychain','charm','brooch','corsage','coatclip','moneyclip','scrunchie','hairnet','hairnet',
  'socks','sock','stocking','stockings','tights','gaiter','sash','suspenders','armband','armlet','wristband','bangle','garter','garters',
  'turban','fascinator','veil','crown','tiara','diadem','hatband','boa','handkerchief','wrap','stole','cape','poncho','sombrero','fedora','bowler','trilby','panamahat','newsboycap','flatcap','beret','boater',
  'helmet','hardhat',
  'gaiter','muffler','earmuff','wristlet','neckwarmer','armlet','armband','headphone','headset','earbud','airpods',

  'handkerchief','umbrella','parasol','shoeclip','shoelace','shoehorn','toggles','clip'
]

// Helper: produce a sensible plural for common accessory nouns
function pluralize(token) {
  if (!token) return null
  if (token.endsWith('s')) return null
  const exceptions = {
    'panty': 'panties',
    'sari': 'saris',
    'jeans': null,
    'trousers': null,
    'shorts': null,
    'glasses': null,
    'sunglasses': null,
    'airpods': null,
    'fannypack': 'fannypacks'
  }
  if (exceptions[token] !== undefined) return exceptions[token]
  if (/(sh|ch|x|z)$/.test(token)) return token + 'es'
  if (/[aeiou]y$/.test(token)) return token + 's'
  if (token.endsWith('y')) return token.slice(0, -1) + 'ies'
  if (/(?:fe)$/.test(token)) return token.slice(0, -2) + 'ves'
  if (token.endsWith('f')) return token.slice(0, -1) + 'ves'
  return token + 's'
}

const normalizedBase = Array.from(new Set(RAW
  .map(s => (s || '').toString().trim().toLowerCase())
  .map(s => s.replace(/[^a-z]/g, ''))
  .filter(Boolean)
))

const pluralCandidates = []
normalizedBase.forEach(t => {
  const p = pluralize(t)
  if (p && typeof p === 'string' && p.length > 0) pluralCandidates.push(p)
})

const ACCESSORIES = Array.from(new Set([...normalizedBase, ...pluralCandidates])).sort()

export default ACCESSORIES
