// Single-word occupation names (lowercase) - single-token only
const BASE = [
  'actor','activist','architect','artist','author','baker','pastrycook','confectioner','breadmaker','boulanger','barber','beekeeper','butcher','carpenter','chef','chemist',
  'clerk','coach','coder','composer','consultant','cook','dancer','dentist','developer','director','doctor','driver',
  'editor','electrician','engineer','farmer','filmmaker','firefighter','fisher','gardener','geologist','guard',
  'hairdresser','handyman','historian','illustrator','inspector','investor','janitor','journalist','judge','librarian','mechanic',
  'musician','nurse','optician','painter','pharmacist','photographer','physician','pilot','plumber','police','politician','postman',
  'professor','programmer','publisher','receptionist','referee','researcher','sailor','scientist','secretary','shopkeeper','soldier',
  'surgeon','tailor','teacher','technician','translator','veterinarian','waiter','writer', 'speaker',
  // added professions
  'ecologist','violinist','pianist','actress','waitress','hostess','stewardess','seamstress','authoress', 'hairstylist',
  // sports professions
  ,'footballer','basketballer','cricketer','baseballer','golfer','tennisplayer','boxer','wrestler','swimmer','runner','athlete'
  // more professions
  ,'clown','entertainer','magician','illusionist','comedian','acrobat','hooker','escort','sexworker','stripper','bartender'
  // jester/performer related
  ,'minstrel','fool','harlequin','busker','landlord', 'glassmaker','brewer','distiller','winemaker', 'bottler', 'cellarman',    'collier','coalminer','miner'
  // musical & dance professions
  ,'saxophonist','drumer','drummer','ballerina'
  // additional requested professions
  ,'influencer','reporter','newsman','newswoman','principal','cleaner','custodian','caretaker','broadcaster','anchor'
  // extra professions and regional variants
  ,'bodyguard','designer','coder','youtuber','judge','lawyer','cameraman','camerawoman','assistant','banker','paramedic','therapist',
  'mentalist','tester',
  'psychologist','psychiatrist','socialworker','nanny','babysitter','barista','cashier','accountant','auditor','realtor','maid','housekeeper',
  'landscaper','roofer','welder','blacksmith','butler','chauffeur','astronaut','sysadmin','administrator','developer','qa','tester','chemist',
  'biologist','physicist','mathematician','statistician','economist','anthropologist','sociologist','librarian','archivist','curator','barber'
  // latest requested
  ,'professor','comedian','writer','novelist','mayor','politician','surgeon','poet','columnist','playwright'
  // additional final professions
  ,'publicist','woodworker','masseuse','businessman','businesswoman','worker'
  // requested executive / finance / misc professions
  ,'gamer','manager','broker','trader','ceo','cto','officer','detective','beautitian','beautician','homemaker'
  // artists, trades, planning
  ,'sculptor','hunter','dermatologist','planner','surveyor'
  // fashion & beauty professions
  ,'model','supermodel','stylist','fashiondesigner','couturier','agent','scout','booker','makeupartist','costumer'
  // entertainers, guides, emergency services, hosts
  ,'jester','guide','fireman','firewoman','host','presenter','emcee','mc'
  // aquatic and library professions
  ,'diver','swimmer','lifeguard','librarian'
    ,'surfer','surfboarder','oceanographer','marinebiologist'
  // music & fitness professions
  ,'singer','vocalist','coach','trainer','instructor','gymnast'
  // medical, religious, judicial
  ,'medic','priest','executioner','nun','sheriff','chaplain','friar'
  // STEM professions
  ,'datascientist','dataengineer','mlengineer','engineer','computerscientist','neuroscientist','bioinformatician','roboticist','astrophysicist','quant','cryptographer','bioengineer','labtechnician','geneticist'
  // photo/video professions and vets/animal care
  ,'videographer','cinematographer','photojournalist','vet','zookeeper','apiculturist','avianist','optometrist','optician'
  // DJ / production, analysis, apiary, and security professions
  ,'dj','deejay','discjockey','producer','promoter','showrunner','actuary','analyst','strategist','advisor','adviser','apiarist','apiculturist','security','securityguard','securityofficer','bouncer'
  // medical optics / related (include requested misspellings as variants)
  ,'ophthalmologist','physisist','optitian'
  // mail/postal and typing professions
  ,'mailman','mailwoman','courier','postalworker','typist','stenographer'
  // retail, inspection, and pediatric professions
  ,'grocer','inspector','pediatrician','paediatrician','pediatritian','neonatologist','midwife'
  // zoology, mime, and sales professions
  ,'zoologist','mime','salesman','saleswoman','salesperson','salesrep','merchant','retailer','salesclerk','merchandiser','salesassociate','vendor','stallholder','animalkeeper'
  // sports & craft professions
  ,'skateboarder','skater','biker','cyclist','bicyclist','motorcyclist','technologist','potter','ceramist','mechanic','racer','stuntman','stuntwoman','pitcrew'
  // medical specialists, equestrian and martial roles
  ,'cardiologist','jockey','equestrian','farrier','stablehand','groom','horseman','wrestler','samurai'
  // craft and maker professions
  ,'candlemaker','chandler','waxmaker','wickmaker','soapmaker','perfumer','tallowmaker'
]

const IRREGULARS = {
  'police': 'police',
  'postman': 'postmen',
  'handyman': 'handymen'
}

function pluralize(word) {
  if (!word) return word
  if (IRREGULARS[word]) return IRREGULARS[word]
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, 'ies')
  if (word.endsWith('man')) return word.replace(/man$/, 'men')
  // words ending in s, x, z, ch, sh -> add 'es' (actress -> actresses)
  if (/(?:[sxz]|ch|sh)$/.test(word)) return word + 'es'
  return word + 's'
}

const COMBINED = []
BASE.forEach(w => {
  COMBINED.push(w)
  try {
    const p = pluralize(w)
    if (p && p !== w) COMBINED.push(p)
  } catch (e) {}
})

const OCCUPATIONS = Array.from(new Set((COMBINED || []).map(s => (s || '').toString().toLowerCase().trim()).filter(Boolean))).filter(x => /^[a-z]+$/.test(x))
export default OCCUPATIONS
