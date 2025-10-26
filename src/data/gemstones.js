// Gemstones theme - single-word tokens only (lowercase)
// Curated list of gemstone tokens. Normalized at export (lowercase, letters-only, deduped).

const RAW = [
  'Actinolite', 'Adularia', 'Agate', 'Alexandrite', 'Almandine', 'Amazonite', 'Amber', 'Amblygonite', 'Amethyst', 'Ametrine', 'Andalusite', 'Apatite', 'Aquamarine', 'Aragonite', 'Aventurine', 'Axinite', 'Azurite',
  'Benitoite', 'Beryl', 'Bloodstone', 'Bone', 'Bornite', 'Bronzite',
  'Calcite', 'Carnelian', 'Cassiterite', 'Celestite', 'Chalcedony', 'Charoite', 'Chrysoberyl', 'Chrysocolla', 'Chrysoprase', 'Citrine', 'Coral', 'Cordierite', 'Cuprite',
  'Danburite', 'Diamond', 'Diaspore', 'Diopside', 'Dioptase', 'Dumortierite',
  'Ekanite', 'Emerald', 'Enstatite', 'Epidote',
  'Feldspar', 'Fluorite',
  'Gadolinite', 'Gahnite', 'Garnet', 'Gaspeite',
  'Halite', 'Heliodor', 'Hematite', 'Hiddenite', 'Howlite', 'Hessonite', 'Hauyne',
  'Idocrase', 'Iolite', 'Ivory',
  'Jade', 'Jasper', 'Jet',
  'Kornerupine', 'Kunzite', 'Kyanite',
  'Labradorite', 'Lapis', 'Larimar', 'Lazulite', 'Legrandite', 'Lepidolite',
  'Magnesite', 'Malachite', 'Marcasite', 'Meerschaum', 'Microcline', 'Moldavite', 'Moonstone', 'Morganite',
  'Nephrite',
  'Obsidian', 'Onyx', 'Opal',
  'Pearl', 'Peridot', 'Petalite', 'Phenakite', 'Prehnite', 'Psilomelane', 'Pyrargyrite', 'Pyrite',
  'Quartz',
  'Rhodochrosite', 'Rhodonite', 'Ruby', 'Rutile',
  'Sapphire', 'Sard', 'Sardonyx', 'Scapolite', 'Serpentine', 'Sodalite', 'Spinel', 'Spodumene', 'Sugilite', 'Sunstone',
  'Talc', 'Tanzanite', 'Tigerseye', 'Topaz', 'Tourmaline', 'Turquoise',
  'Unakite',
  'Variscite', 'Vesuvianite',
  'Wulfenite',
  'Zincite', 'Zircon', 'Zoisite'
]

// Helper: produce a sensible plural for common accessory nouns (kept from accessories.js)
function pluralize(token) {
  if (!token) return null
  if (token.endsWith('s')) return null
  const exceptions = {
    'ruby': 'rubies',
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
  // drop single-letter tokens (user requested we don't count headings like "B", "C")
  .filter(s => s && s.length > 1)
))

const pluralCandidates = []
normalizedBase.forEach(t => {
  const p = pluralize(t)
  if (p && typeof p === 'string' && p.length > 0) pluralCandidates.push(p)
})

const GEMSTONES = Array.from(new Set([...normalizedBase, ...pluralCandidates])).sort()

export { GEMSTONES }
export default GEMSTONES
