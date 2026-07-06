/**
 * Built-in banned-word lists shipped with the word filter.
 *
 * Entry format rules:
 * - `words` entries are stored in FOLDED form: lowercase, diacritics removed
 *   (ş→s, ç→c, ğ→g, ı→i, ö→o, ü→u), letters only. The matcher folds incoming
 *   tokens the same way (including leetspeak like s1kt1r → siktir) before
 *   comparing, so one entry covers the plain, accented, leet, stretched and
 *   spaced-out spellings.
 * - `rawWords` entries are matched against the UNFOLDED lowercase token (and,
 *   for multi-word phrases, against the folded full text). Use these when the
 *   folded form collides with an innocent word in another language
 *   (piç→pic, göt→got, sıç→sic).
 * - `stems` are substrings checked inside longer compacted tokens (≥5 chars)
 *   so glued compounds ("ananısikeyim", "motherfuckers") still fire. Keep
 *   stems long/distinct enough that no ordinary word contains them.
 *
 * Curation policy: every folded entry must be checked against innocent
 * collisions in BOTH English and Turkish before adding — e.g. "git" (VCS /
 * Turkish "go"), "af" (Turkish "pardon"), "koyayım" ("let me put"), "hıyar"
 * (cucumber), "coon" (Maine Coon), "naked" ("naked eye") were all rejected
 * or made phrase-only for that reason. Softer or domain-specific vocabulary
 * belongs in tenant word lists (uploaded via CSV), not here.
 */

export interface BuiltinWordList {
  words: string[];
  rawWords: string[];
  stems: string[];
}

// ── English ───────────────────────────────────────────────────────────────

const PROFANITY_EN_WORDS: string[] = [
  // core profanity + variants that survive folding
  'fuck', 'fucking', 'fucked', 'fucker', 'fuckers', 'fuckin', 'fck', 'fcking',
  'fvck', 'fuk', 'fukk', 'fuq', 'phuck', 'fock', 'effing', 'motherfucker',
  'motherfucking', 'mofo', 'stfu', 'gtfo', 'wtf',
  'shit', 'shite', 'shitty', 'shithead', 'shitface', 'bullshit', 'horseshit',
  'dogshit', 'batshit', 'shyt',
  'bitch', 'bitches', 'bitchy', 'biatch', 'beotch', 'sonofabitch',
  'asshole', 'assholes', 'arsehole', 'jackass', 'dumbass',
  'asshat', 'asswipe', 'assclown',
  'bastard', 'bastards',
  'goddamn', 'goddammit', 'dammit',
  'pissed', 'pissing', 'pisser', 'pissoff',
  'douche', 'douchebag', 'douchey',
  'wanker', 'wankers', 'tosser', 'twat', 'twats', 'prick', 'pricks',
  'knobhead', 'bellend', 'bollocks', 'minger', 'munter', 'numpty', 'plonker',
  'scumbag', 'sleazebag', 'dirtbag',
  // sexual explicit
  'cunt', 'cunts', 'dick', 'dickhead', 'dicks', 'cock', 'cocks', 'cocksucker',
  'pussy', 'pussies', 'tits', 'titties',
  'blowjob', 'handjob', 'rimjob', 'jerkoff', 'jackoff',
  'cumshot', 'jizz', 'smegma',
  'whore', 'whores', 'slut', 'sluts', 'slutty', 'skank', 'thot',
  'milf', 'dilf',
  'dildo', 'buttplug', 'fleshlight',
  'porn', 'porno', 'pornography', 'hentai',
  'deepthroat', 'gangbang', 'bukkake', 'creampie',
  'masturbate', 'masturbation', 'fap',
  'nudes',
  // slurs & hate terms
  'nigger', 'niggers', 'nigga', 'niggas',
  'faggot', 'faggots', 'fags', 'dyke', 'dykes', 'tranny', 'trannies',
  'shemale', 'ladyboy',
  'retard', 'retards', 'retarded', 'spastic', 'spaz', 'mongoloid',
  'chink', 'chinks', 'gook', 'gooks', 'zipperhead',
  'spic', 'spics', 'wetback', 'wetbacks', 'beaner', 'beaners',
  'kike', 'kikes',
  'raghead', 'towelhead', 'sandnigger', 'cameljockey',
  'wop', 'dago', 'polack', 'paki', 'pakis',
  'jigaboo', 'porchmonkey', 'tarbaby', 'darkie', 'darky',
  'injun', 'squaw',
  'gyppo', 'pikey', 'honky', 'whitetrash',
  // self-harm-adjacent abuse
  'killyourself', 'kys', 'neckyourself',
];

const PROFANITY_EN_RAW: string[] = [
  'son of a bitch', 'piece of shit', 'kill yourself', 'go kill yourself',
  'eat shit', 'fuck you', 'fuck off', 'suck my dick', 'piss off',
];

const PROFANITY_EN_STEMS: string[] = [
  'motherfuck', 'fucker', 'fucking', 'cocksuck', 'shithead',
  'dickhead', 'asshole', 'bullshit', 'nigger', 'faggot',
];

// ── Turkish ───────────────────────────────────────────────────────────────
// Stored folded (diacritics removed). The matcher folds ç/ğ/ı/ö/ş/ü and leet
// digits, so 'sikeyim' also covers 's1key1m', 'sıkeyim', 'sikeyiiim' etc.

const PROFANITY_TR_WORDS: string[] = [
  // am- family
  'amk', 'aq', 'amq', 'awk', 'amck', 'amcik', 'amcuk', 'amciklar',
  'amciklari', 'amcigi', 'amcigini', 'amina', 'aminda', 'amini',
  'aminakoyim', 'aminakoyayim', 'aminizi', 'amckoyim',
  // sik- family
  'sik', 'siki', 'sikik', 'sikikler', 'sikim', 'sikimi', 'sikimin',
  'sikimde', 'sikeyim', 'sikiyim', 'sikerim', 'sikerler', 'sikersin',
  'sikti', 'siktim', 'siktin', 'siktir', 'siktirgit', 'sikis', 'sikismek',
  'sikisme', 'sikici', 'sikildi', 'sikilmis', 'sikko', 'zikeyim', 'zikim',
  'hassiktir',
  // yarrak family
  'yarrak', 'yarak', 'yarragi', 'yarragim', 'yarragimi', 'yarraktan',
  'yarraklar', 'yarraga', 'yrrak', 'dalyarak', 'dalyarrak',
  // orospu family
  'orospu', 'orosbu', 'orspu', 'orospular', 'orospunun', 'orospuluk',
  'orospucocugu', 'orospucocuklari',
  // ibne / götveren family
  'ibne', 'ipne', 'ibnelik', 'ibneler', 'gotveren', 'gotlek', 'gotoglani',
  'gotcu',
  // pezevenk / kahpe / kaltak
  'pezevenk', 'pezeveng', 'pezo', 'kahpe', 'kahpelik', 'kahpeler',
  'kaltak', 'kaltaklar', 'surtuk', 'surtukler', 'fahise', 'kevase', 'yosma',
  'kancik',
  // yavşak / gavat / dallama and insults
  'yavsak', 'yavsaklar', 'yavsaklik', 'gavat', 'gavatlik', 'dallama',
  'dallamalar', 'dangalak', 'denyo', 'andaval', 'angut', 'godos', 'pust',
  'pustluk', 'gerizekali', 'beyinsiz', 'serefsiz', 'serefsizler',
  'haysiyetsiz', 'namussuz', 'ebleh',
  // anan/baban compounds (folded, glued)
  'ananisikeyim', 'ananisikerim', 'anansikerim', 'avradinisikeyim',
  'bacinisikeyim', 'sulalenisikeyim',
  // other explicit
  'tasak', 'tasaklar', 'tassak', 'tasagi', 'atmik', 'otuzbirci',
  'sicayim', 'sicarim', 'sictik', 'bokkafali', 'piclik', 'pickurusu',
];

const PROFANITY_TR_RAW: string[] = [
  'piç', 'piçler', 'piçlik', 'piç kurusu', 'göt', 'götü', 'götün',
  'göt veren', 'götüne', 'götünü',
  'orospu çocuğu', 'orospu cocugu', 'orospu evladı',
  'sıçayım', 'sıçarım', 'sıçtık', 'bok', 'boktan', 'bokunu ye',
  'ananı sikeyim', 'anani sikeyim', 'ananı sikerim', 'avradını sikeyim',
  'bacını sikeyim', 'sülaleni sikeyim',
  'siktir git', 'siktir ol git', 'has siktir',
  'geri zekalı', 'salak herif', 'aptal herif', 'mal herif',
  'allah belanı versin', 'otuz bir çek',
];

const PROFANITY_TR_STEMS: string[] = [
  'orospu', 'amcik', 'aminakoy', 'sikeyim', 'sikerim', 'siktir', 'yarrak',
  'yarrag', 'pezevenk', 'gotveren', 'ananisik', 'bacinisik', 'avradinisik',
  'dalyarak', 'dalyarrak', 'hassiktir', 'orospucocu',
];

// Folded forms that would collide with innocent words in either language —
// filtered defensively even if an entry above slips through a future edit.
const FOLDED_BLOCKLIST = new Set([
  'pic', 'got', 'top', 'mal', 'oc', 'am', 'af', 'git', 'esek', 'okuz',
  'hiyar', 'salak', 'aptal', 'koyayim', 'sokayim', 'bosalmak', 'otuzbir',
  'coon', 'coons', 'hoe', 'knob', 'sod', 'nip', 'mick', 'paddy', 'cracker',
  'naked', 'nude', 'anal', 'crap', 'damn', 'piss', 'arse', 'fag', 'jap',
  'negro', 'mong', 'midget', 'cripple', 'gringo', 'redneck', 'hillbilly',
  'kraut', 'yid', 'heeb', 'badass', 'bugger',
]);

// ── Compile & export ──────────────────────────────────────────────────────

function dedupe(words: string[], blocklist?: Set<string>): string[] {
  const out = new Set<string>();
  for (const word of words) {
    const w = word.trim().toLowerCase();
    if (!w) continue;
    if (blocklist?.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

export const BUILTIN_WORD_LISTS: Record<string, BuiltinWordList> = {
  'profanity-en': {
    words: dedupe(PROFANITY_EN_WORDS, FOLDED_BLOCKLIST),
    rawWords: dedupe(PROFANITY_EN_RAW),
    stems: PROFANITY_EN_STEMS,
  },
  'profanity-tr': {
    words: dedupe(PROFANITY_TR_WORDS, FOLDED_BLOCKLIST),
    rawWords: dedupe(PROFANITY_TR_RAW),
    stems: PROFANITY_TR_STEMS,
  },
};
