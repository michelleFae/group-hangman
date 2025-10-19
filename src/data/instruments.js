// Single-word musical instrument names (lowercase preferred)
// Include modern, ethnic, and some obsolete/historical instruments.
// This module canonicalizes the tokens: it lowercases them and removes duplicates
// while preserving singular and plural forms (if both are present) exactly once.

const RAW = [
  'accordion','accordionS','acousticbassguitar','acousticguitar','aeolianharp','ajaeng','alphorn','angklung','archlute','arghul','arpeggione','aulochrome','babendil','balafon','balalaika','bandola','bandoneon','bandurria','banhu','banjo','barbat','baritonehorn','baryton','bassclarinet','bassdrum','bassoon','bawu','bayan','bazooka','bell','berimbau','bianqing','bianzhong','bifora','biniou','biwa','bock','bodega','boha','bombarde','bombardino','bordonua','bouzouki','bullroarer','cabrette','calliope','carillon','castanets','cavaco','cavaquinho','caxixi','celesta','cello','ceng','chabrette','charango','chenda','chi','chimes','ching','chitarrone','cimbalom','cimbasso','cimpoi','cittern','clarinet','clavichord','concertina','conch','conga','cromorne','crotales','crumhorn','crwth','cuatro','cuica','cymbalum','dabakan','dadihu','dahu','daiko','dankiyo','daraboukka','darabukka','darbuka','darvyra','dhol','dholak','didgeridoo','dihu','diyingehu','djembe','dombak','domra','dotara','dulcian','dulcimer','dulzaina','dumbelek','dutar','duxianqin','ektara','erhu','erxian','euphonium','fangxiang','fiddle','fiscarmonica','flageolet','flugelhorn','flute','folgerphone','gaida','gaita','gajdy','gambang','ganza','gaohu','gayageum','gehu','gender','geomungo','ghatam','glasschord','glockenspiel','gong','gottuvadhyam','guan','guiro','guitar','guqin','gusli','gusle','guzheng','hang','harmonica','harmonium','harp','harpsichord','heckelphone','helicon','hichiriki','hocchiku','horagai','horn','hosho','hsaio','huemmelchen','huluhu','hun','huqin','igil','ipu','janggu','jiaohu','jinghu','jug','kadlong','kagul','kangling','kaval','khim','khloy','khol','kissar','knatele','kokyu','komungo','kora','koto','koudi','koziol','kubing','kutiyapi','lambeg','langeleik','laruan','launeddas','leier','leiqin','lirone','lithophone','lusheng','lute','lyre','maguhu','malimba','mandocello','mandola','mandolin','mangtong','maraca','marimba','marimbao','mellophone','mellotron','melodeon','melodica','mijwiz','mizwad','moodswinger','mridangam','muchosac','musette','nadaswaram','naqara','nay','ney','nyckelharpa','oboe','ocarina','octaban','octapad','octavin','ophicleide','organ','paixiao','palendang','piano','piccolo','pipa','piva','psaltery','pulalu','qanun','quena','quinticlave','racket','rainstick','raita','rajao','ratchet','rattle','rebab','rebec','recorder','ruan','ryuteki','sabar','sackbutt','sackpipa','saenghwang','sallaneh','sampho','sampler','santur','sanxian','saung','sarrusophone','saxhorn','saxonette','saxophone','serpent','serunai','setar','shamisen','shawm','shekere','sheng','shinobue','shofar','sihu','siren','sitar','sousaphone','spoons','sralai','suling','suona','synclavier','synthesizer','tabla','tagutok','taiko','tambourine','tamburitza','taphon','tar','tarogato','teponaztli','thavil','theorbo','theremin','timple','tin','tonette','trekspill','tres','triangle','trombone','trumpet','tsampouna','tuba','tuhu','tulum','tumpong','turntables','udu','ukulele','valiha','veuze','vibraphone','vielle','vihuela','viola','violin','violotta','volinka','washboard','washint','whip','whistle','willow','xiao','xiaodihu','xun','xylophone','xylorimba','yazheng','yehu','yu','zaqq','zampogna','zhongdihu','zhuihu','zither','zonghu','zufalo','zurna',
  'bagpipe','bagpipes','uilleann','uilleannpipes','greatpipes','musette','sleighbells','sleighbell','bugle','bugles','shaker','shakers'
];

// canonicalize: lowercase + dedupe while preserving plural/singular as separate tokens
const seen = new Set();
const normalized = [];
for (const t of RAW) {
  const tok = String(t).toLowerCase();
  if (!seen.has(tok)) {
    seen.add(tok);
    normalized.push(tok);
  }
}

export default normalized;
