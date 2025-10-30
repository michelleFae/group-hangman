// Single-word country and common place names (lowercase).
// Per request: do NOT combine multiple-word names into a single concatenated token.
// This list contains only names that are commonly written as a single word in English
// or common one-word aliases/abbreviations (e.g. usa, uk). Multi-word country names
// are intentionally excluded rather than being merged into a single token.

let COUNTRIES = [
  'afghanistan','albania','algeria','andorra','angola',
  'argentina','armenia','australia','austria','azerbaijan',
  'bahamas','bahrain','bangladesh','barbados','belarus','belgium','belize','benin','bhutan','bolivia','botswana','brazil','brunei','bulgaria','burundi',
  'cambodia','cameroon','canada','chad','chile','china','colombia','comoros','congo','croatia','cuba','cyprus','czechia',
  'denmark','djibouti','dominica','ecuador','egypt','eritrea','estonia','eswatini','ethiopia',
  'fiji','finland','france',
  'gabon','gambia','georgia','germany','ghana','greece','grenada','guatemala','guinea','guyana',
  'haiti','honduras','hungary',
  'iceland','india','indonesia','iran','iraq','ireland','israel','italy',
  'jamaica','japan','jordan',
  'kazakhstan','kenya','kiribati','kuwait','kyrgyzstan',
  'laos','latvia','lebanon','lesotho','liberia','libya','liechtenstein','lithuania','luxembourg',
  'madagascar','malawi','malaysia','maldives','mali','malta','mauritania','mauritius','mexico','moldova','monaco','mongolia','montenegro','morocco','mozambique','myanmar',
  'namibia','nauru','nepal','netherlands','nicaragua','niger','nigeria','norway',
  'oman','pakistan','palau','panama','paraguay','palestine', 'peru','philippines','poland','portugal','qatar',
  'romania','russia','rwanda',
  'samoa','senegal','serbia','seychelles','singapore','slovakia','slovenia','somalia','spain','sudan','suriname','sweden','switzerland','syria',
  'tajikistan','tanzania','taiwan','thailand','togo','tonga','tunisia','turkey','turkmenistan','tuvalu',
  'uganda','ukraine','uruguay','uzbekistan',
  'vanuatu','vatican','venezuela','vietnam',
  'yemen','zambia','zimbabwe', 'korea',

  // Common regional / historic / colloquial names
  'america','americas','asia','africa','europe','oceania','antarctica',

  // Common subnational or one-word country parts / abbreviations
  'england','scotland','wales','britain','uk','usa','us','uae','drc'
]

// Normalize to lowercase alphabetic-only entries and dedupe
COUNTRIES = Array.from(new Set((COUNTRIES || []).map(c => (c || '').toString().toLowerCase().replace(/[^a-z]/g, '')))).filter(Boolean)

export default COUNTRIES
