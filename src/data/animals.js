// A compact list of common animal names (lowercase, single words where possible)
// This is not exhaustive but provides deterministic validation for many cases.
const ANIMALS = [
  'aardvark','alligator','ant','anteater','antelope','ape','armadillo','baboon','badger','bat','bear','beaver','bee','bison','boar','buffalo','butterfly','camel','canary','capybara','caribou','cat','caterpillar','cheetah','chicken','chimpanzee','chinchilla','cobra','cod','cougar','cow','coyote','crab','crow','deer','dingo','dog','dolphin','donkey','dove','duck','eagle','eel','elephant','elk','emu','falcon','ferret','fish','flamingo','fox','frog','gazelle','gerbil','giraffe','goat','goose','gorilla','grasshopper','grouse','guanaco','guinea','gull','hamster','hare','hawk','hedgehog','hippopotamus','hornet','horse','hummingbird','hyena','ibex','ibis','iguana','impala','jaguar','jay','kakapo','kangaroo','koala','krill','lemur','leopard','lion','lizard','llama','lobster','lynx','macaw','mole','monkey','moose','mosquito','moth','mouse','mule','narwhal','newt','nightingale','ocean','ocelot','octopus','opossum','orangutan','orca','ostrich','otter','owl','ox','oyster','panda','panther','parrot','peacock','pelican','penguin','pheasant','pigeon','porcupine','porpoise','possum','puma','quail','rabbit','raccoon','rat','raven','reindeer','rhinoceros','rook','salamander','salmon','sandpiper','saola','scorpion','seahorse','seal','shark','sheep','shrimp','skunk','sloth','snail','snake','sparrow','spider','squid','squirrel','starfish','stingray','stork','swan','tapir','tarsier','termite','tiger','toad','tortoise','trout','turkey','turtle','vole','vulture','walrus','wasp','weasel','whale','wolf','wombat','woodpecker','yak','zebra',

  // common dog breeds (single-word, lowercase)
  'beagle','bulldog','dachshund','doberman','husky','poodle','chihuahua','pug','rottweiler','boxer','labrador','mastiff','greyhound','collie','shiba','akita','terrier',

  // common cat breeds (single-word, lowercase)
  'siamese','persian','sphynx','ragdoll','bengal','abyssinian','ocicat','manx','burmese','tonkinese',

  // additional single-word animals (birds, fish, exotic mammals, reptiles, etc.)
  'albatross','auk','anemone','angelfish','anglerfish','axolotl','barnacle','barracuda','beluga','bilby','binturong','booby','bonobo','caracal','cassowary','coati','condor','cormorant','curlew','echidna','gannet','gibbon','gnu','jackal','jerboa','kiwi','koi','lamprey','lemming','manatee','mink','murrelet','numbat','pangolin','perch','ptarmigan','quokka','quoll','remora','saki','shrew','skua','solenodon','starling','tern','uakari','vicuna','wallaby','weevil','wrasse','zorilla',

  // additional fish types
  'goldfish','tuna','carp','bass','sardine','anchovy','mackerel','halibut','haddock','herring','sole','flounder','cod','trout','salmon','tilapia','bream','grouper','goby','piranha','marlin','sailfish','swordfish','tarpon','catfish',

  // common insect/bug names
  'cockroach','roach','beetle','ladybird','ladybug','mantis','cicada','dragonfly','damselfly','firefly','lightningbug','earwig','silverfish','centipede','millipede','aphid','weevil','grasshopper',

  // plural forms and extra insect plurals
  'termites','ants','bees','flies','beetles','spiders','cockroaches','roaches','moths','butterflies',

  // dinosaurs and related prehistoric animals
  'dinosaur','dinosaurs','triceratops','tyrannosaurus','trex','velociraptor','stegosaurus','brachiosaurus','ankylosaurus','allosaurus','diplodocus','iguanodon','spinosaurus','pterodactyl','archaeopteryx',

  // additional single-word animals requested
  'platypus','okapi','warthog','mantaray','jellyfish','puffin','bluewhale','mako'
  ,
  // extra suggestions
  'crocodile','komodo','marmot','ermine','stoat','nutria','myna','loris','tamarin','capuchin',

  // gendered animal forms (female/male terms)
  'peahen','hen','rooster','cock','doe','hind','vixen','sow','nanny','mare','ewe','queen','tom','drake','cob','pen','buck','stag',

  // baby / juvenile animal names
  'puppy','pup','kitten','calf','foal','kid','joey','cub','chick','duckling','piglet','gosling','fawn','leveret','puggle','fry','tadpole','larva',

  // mythical / legendary animals
  'phoenix','unicorn','dragon','griffin','kraken','chimera','hydra','mermaid','basilisk','pegasus',

  // extinct animals / prehistoric species
  'dodo','auroch','moa','passengerpigeon','woollymammoth','smilodon','mastodon','glyptodon','thylacine','quagga'
,
  // round-2 extra animals
  'alpaca','oryx','dikdik','ayeaye','tenrec','coelacanth','cuttlefish','urchin','gecko','python','viper','locust','magpie','toucan','marmoset','howler','ram','gander'
]

export default ANIMALS

