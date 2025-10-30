// A compact list of common animal names (lowercase, single words where possible)
// This is not exhaustive but provides deterministic validation for many cases.
// We'll keep the base list as-is, then programmatically add plural forms for each
// entry so the module exports a deduped, sorted array containing both singular
// and plural forms (including common irregular plurals).
const BASE_ANIMALS = [
  'aardvark','alligator','ant','anteater','antelope','ape','armadillo','baboon','badger','bat','bear','beaver','bee','bison','boar','buffalo','butterfly','camel','canary','capybara','caribou','cat','caterpillar','cheetah','chicken','chimpanzee','chinchilla','cobra','cod','cougar','cow','coyote','crab','crow','deer','dingo','dog','dolphin','donkey','dove','duck','eagle','eel','elephant','elk','emu','falcon','ferret','fish','flamingo','fox','frog','gazelle','gerbil','giraffe','goat','goose','gorilla','grasshopper','grouse','guanaco','guinea','gull','hamster','hare','hawk','hedgehog','hippo', 'hippopotamus','hornet','horse','hummingbird','hyena','ibex','ibis','iguana','impala','jaguar','jay','kakapo','kangaroo','koala','krill','lemur','leopard','lion','lizard','llama','lobster','lynx','macaw','mole','monkey','moose','mosquito','moth','mouse','mule','narwhal','newt','nightingale','ocean','ocelot','octopus','opossum','orangutan','orca','ostrich','otter','owl','ox','oyster','melo','conch','whelk','murex','limpet','gastropod','panda','panther','parrot','peacock','pelican','penguin','pheasant','pigeon','pig', 'cyclops', 'capybara','porcupine','porpoise','possum','puma','quail','rabbit','raccoon','rat','raven','reindeer','rhinoceros','rook','salamander','salmon','sandpiper','saola','scorpion','seahorse','seal','shark','sheep','shrimp','skunk','sloth','snail','snake','sparrow','spider','squid','squirrel','starfish','stingray','stork','swan','tapir','tarsier','termite','tiger','toad','tortoise','trout','turkey','turtle','vole','vulture','walrus','wasp','weasel','whale','wolf','wombat','woodpecker','yak','zebra',
  'addax','vaquita','condor',

  // // common dog breeds (single-word, lowercase)
  'beagle','bulldog','dachshund','doberman','husky','poodle','chihuahua','pug','rottweiler','boxer','labrador','mastiff','greyhound','collie','shiba','akita','terrier',

  // // common cat breeds (single-word, lowercase)
  // 'siamese','persian','sphynx','ragdoll','bengal','abyssinian','ocicat','manx','burmese','tonkinese',

  // additional single-word animals (birds, fish, exotic mammals, reptiles, etc.)
  'albatross','auk','anemone','angelfish','anglerfish','axolotl','barnacle','barracuda','beluga','bilby','binturong','booby','bonobo','caracal','cassowary','coati','condor','cormorant','curlew','echidna','gannet','gibbon','gnu','jackal','jerboa','kiwi','koi','lamprey','lemming','manatee','mink','murrelet','numbat','pangolin','perch','ptarmigan','quokka','quoll','remora','saki','shrew','skua','solenodon','starling','tern','uakari','vicuna','wallaby','weevil','wrasse','zorilla',
  // seabirds / gull relatives
  'seagull','kittiwake','shearwater','petrel','auklet','kinkajou',
  // added extra common animals
  'chipmunk','guppy','pony','mongoose','skink','civet','boa','pika','tarantula',

  // additional fish types
  'goldfish','tuna','carp','bass','sardine','anchovy','mackerel','halibut','haddock','herring','sole','flounder','cod','trout','salmon','tilapia','bream','grouper','goby','piranha','marlin','sailfish','swordfish','tarpon','catfish','nemo',

  // common insect/bug names
  'cockroach','roach','beetle','ladybird','ladybug','mantis','cicada','dragonfly','damselfly','firefly','lightningbug','earwig','silverfish','centipede','millipede','aphid','weevil','lice',
  // worm-related additions
  'worm','earthworm','mealworm','silkworm',

  // plural forms previously present here have been removed so BASE_ANIMALS
  // contains only singular/base forms; plural forms are generated below.

  // dinosaurs and related prehistoric animals
  'dinosaur','triceratops','tyrannosaurus','trex','velociraptor','stegosaurus','brachiosaurus','ankylosaurus','allosaurus','diplodocus','iguanodon','spinosaurus','pterodactyl','archaeopteryx',

  // additional single-word animals requested
  'platypus','okapi','warthog','mantaray','jellyfish','puffin','bluewhale','mako',

  // extra suggestions
  'crocodile','komodo','marmot','ermine','stoat','nutria','myna','loris','tamarin','capuchin',

  // gendered animal forms (female/male terms)
  'peahen','hen','rooster','cock','doe','hind','vixen','sow','nanny','mare','ewe','queen','tom','drake','cob','pen','buck','stag',

  // baby / juvenile animal names
  'puppy','pup','kitten','calf','foal','kid','joey','cub','chick','duckling','piglet','gosling','fawn','leveret','puggle','fry','tadpole','larva',

  // mythical / legendary animals
  'phoenix','unicorn','dragon','griffin','kraken','chimera','hydra','mermaid','basilisk','pegasus','lioness',

  // extinct animals / prehistoric species
  'dodo','auroch','moa','passengerpigeon','woollymammoth','smilodon','mastodon','glyptodon','thylacine','quagga',
  'mammoth',

  // round-2 extra animals
  'alpaca','oryx','dikdik','ayeaye','tenrec','coelacanth','cuttlefish','urchin','gecko','python','viper','locust','magpie','toucan','marmoset','howler','ram','gander',
  // added per request
  'zebrafish','zebu','zorse','zonkey','zooplankton', 'honeybadger','pangolin','axolotl',

  // neotropical rodents / related species added
  // neotropical rodents / related species added
  'agouti','paca','pacarana','acouchi','acouchy','coendou','peccary','javelina','tayassu',
  // additional requested animals
  'crane','nia','nene','nilgai','nandu','nudibranch',
]

// A small set of well-known irregular plurals and no-change plurals
const IRREGULARS = {
  mouse: ['mice'],
  ox: ['oxen'],
  goose: ['geese'],
  lice: ['lice'],
  // allow both common plurals
  octopus: ['octopuses','octopi'],
  platypus: ['platypuses','platypi','platypodes'],
  lioness: ['lionesses'],
  deer: ['deer'],
  sheep: ['sheep'],
}

// Words whose plural is identical to singular
const NO_CHANGE = new Set(['sheep','deer','fish','moose','aircraft','series','species'])

// Some common f/fe -> ves conversions for animals
const F_TO_VES = new Set(['wolf','calf','half','leaf','life','knife','shelf','elf','scarf'])

function pluralize(word){
  if(!word || typeof word !== 'string') return word
  if(IRREGULARS[word]) return IRREGULARS[word]
  if(NO_CHANGE.has(word)) return [word]

  // words already plural-ish (very simple heuristic): ending with 's' and length>2
  if(word.length>2 && word.endsWith('s')) return [word]

  const lower = word.toLowerCase()
  const last = lower.charAt(lower.length-1)
  const last2 = lower.slice(-2)

  // f/fe -> ves exceptions
  if(F_TO_VES.has(lower)){
    if(lower.endsWith('fe')) return [lower.slice(0,-2)+'ves']
    if(lower.endsWith('f')) return [lower.slice(0,-1)+'ves']
  }

  // words ending in y preceded by consonant -> ies
  const vowels = new Set(['a','e','i','o','u'])
  if(last === 'y' && !vowels.has(lower.charAt(lower.length-2))){
    return [lower.slice(0,-1)+'ies']
  }

  // words ending in s, x, z, ch, sh -> add 'es'
  if(['s','x','z'].includes(last) || ['ch','sh'].includes(last2)){
    return [lower + 'es']
  }

  // default: add s
  return [lower + 's']
}

// Conservative cleanup: remove plural-looking entries from BASE_ANIMALS
// when the singular exists in the list. This avoids accidental plural-only
// entries while keeping legitimate singular words that end with 's'.
const baseSet = new Set(BASE_ANIMALS.map(s => String(s).toLowerCase()))
const CLEAN_BASE_ANIMALS = BASE_ANIMALS.filter(w => {
  if(!w || typeof w !== 'string') return false
  const lw = w.toLowerCase()
  // keep words in NO_CHANGE (sheep, deer, etc.)
  if(typeof NO_CHANGE !== 'undefined' && NO_CHANGE.has(lw)) return true
  // if word ends with 's' and removing the trailing 's' yields a word
  // that also exists in BASE_ANIMALS, treat it as a plural and remove it
  if(lw.length > 1 && lw.endsWith('s')){
    const singular = lw.slice(0, -1)
    if(baseSet.has(singular)) return false
  }
  return true
})

// Build full list: include cleaned base items plus their plural forms
const combined = []
for(const w of CLEAN_BASE_ANIMALS){
  if(!w || typeof w !== 'string') continue
  const lw = w.toLowerCase()
  combined.push(lw)
  const plurals = pluralize(lw)
  for(const p of plurals) combined.push(p)
}

// Dedupe (preserve insertion order: singular then generated plural)
const ANIMALS = Array.from(new Set(combined))

export default ANIMALS

