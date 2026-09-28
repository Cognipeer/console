/**
 * Built-in lexicons for the NON-LLM moderation detector (`moderationLexicon.ts`).
 *
 * Same `BuiltinWordList` shape and folding rules as `builtinWordLists.ts`
 * (kept in a separate file because it's a different feature's data, not a
 * different mechanism — see that file's header for the folding contract:
 * `words` are pre-folded single tokens, `rawWords` cover multi-word phrases
 * and locale-collision-prone terms, `stems` catch glued compounds).
 *
 * SCOPE, DELIBERATELY LIMITED — see `internal-notes/`'s benchmark report for
 * the reasoning in full:
 *   - Covered here: categories with a workable TECHNICAL/FACTUAL vocabulary
 *     (drug names, weapon types, cybercrime/fraud terms, self-harm risk
 *     phrases, terrorism-adjacent action phrases). A keyword hit is a
 *     coarse, high-recall / lower-precision signal — nothing here judges
 *     INTENT the way the LLM evaluator's prompt explicitly does, so this is
 *     positioned as a cheap `runIf` PRE-FILTER for the LLM judge (see
 *     `families/llm.ts`'s own header on that pattern), not a drop-in
 *     replacement for it. A policy that wants the lexicon as its ONLY
 *     detector accepts materially lower recall on figurative, coded, or
 *     novel phrasing in exchange for zero LLM cost and latency.
 *   - Deliberately NOT covered with a built-in list: `hate`, `harassment`,
 *     `sexual`, `sexual/minors`. A meaningful hate-speech/slur lexicon needs
 *     jurisdiction- and community-specific curation this session should not
 *     be hand-authoring into a shared source file reviewed by many
 *     engineers — that's exactly what the EXISTING tenant word-list feature
 *     (`guardrail_word_lists`, uploaded via the dashboard) is for, and
 *     `moderationLexicon.ts` accepts a tenant list mapped to any of these
 *     category ids for exactly this reason. `child_safety` gets a
 *     STRUCTURAL detector instead (age-reference + grooming-phrase
 *     co-occurrence, in `moderationLexicon.ts`) that needs no slur list at
 *     all. `misinformation` has no reliable keyword signal by nature (a
 *     false claim usually reads exactly like a true one) and is left to the
 *     LLM judge entirely.
 *
 * Starter-sized (not exhaustive) EN+TR seed lists, same spirit as the PII
 * gazetteer's `data/trGazetteer.ts`: enough to prove the mechanism and catch
 * the unambiguous, common cases; a production rollout grows these (or
 * points at tenant lists) rather than treating this file as complete.
 */

import type { BuiltinWordList } from './builtinWordLists';

const list = (words: string[], rawWords: string[] = [], stems: string[] = []): BuiltinWordList => ({
  words, rawWords, stems,
});

export const MODERATION_WORD_LISTS: Record<string, BuiltinWordList> = {
  'moderation-self-harm': list(
    ['intihar', 'suicide', 'suicidal'],
    [
      'kill myself', 'end my life', 'end it all', 'want to die', 'better off dead',
      'kendimi öldüreceğim', 'canıma kıyacağım', 'yaşamak istemiyorum', 'kendime zarar veriyorum',
      'self harm', 'self-harm', 'cutting myself', 'kendimi kesiyorum',
    ],
  ),
  'moderation-self-harm-instructions': list(
    [],
    [
      'how to commit suicide', 'painless way to die', 'lethal dose of', 'suicide method',
      'nasıl intihar edilir', 'ölümcül doz', 'acısız ölüm yöntemi',
    ],
  ),
  'moderation-violence': list(
    ['stab', 'strangle', 'behead', 'massacre', 'öldür', 'bıçakla', 'boğ'],
    [
      'kill him', 'kill her', 'kill them', 'beat him up', 'beat her up',
      'onu öldüreceğim', 'onu döveceğim', 'canını yakacağım',
    ],
  ),
  'moderation-violence-graphic': list(
    ['gore', 'disembowel', 'decapitate', 'mutilate'],
    ['graphic violence', 'severed head', 'kesik kafa', 'iç organları'],
  ),
  'moderation-weapons': list(
    [
      'bomb', 'grenade', 'explosive', 'detonator', 'gunpowder', 'silencer',
      'bomba', 'patlayıcı', 'el bombası', 'susturucu',
    ],
    [
      'pipe bomb', 'how to make a bomb', 'build a gun', '3d printed gun',
      'bomba nasıl yapılır', 'silah nasıl yapılır',
    ],
  ),
  'moderation-drugs': list(
    [
      'cocaine', 'heroin', 'fentanyl', 'methamphetamine', 'meth', 'lsd', 'mdma',
      'ecstasy', 'crackcocaine', 'crystalmeth',
      'kokain', 'eroin', 'esrar', 'metamfetamin', 'captagon',
    ],
    ['how to synthesize meth', 'cook meth', 'metamfetamin nasıl üretilir'],
  ),
  'moderation-cybercrime': list(
    [
      'ransomware', 'malware', 'keylogger', 'rootkit', 'botnet', 'spyware',
      'trojan', 'ddos', 'zeroday',
    ],
    [
      'sql injection', 'ddos attack', 'phishing kit', 'exploit kit', 'brute force attack',
      'fidye yazılımı', 'kimlik avı saldırısı',
    ],
  ),
  'moderation-fraud': list(
    ['ponzi', 'pyramidscheme', 'moneylaundering', 'phishing', 'skimmer'],
    [
      'wire fraud', 'identity theft', 'fake invoice scam', 'romance scam',
      'kimlik hırsızlığı', 'sahte fatura dolandırıcılığı', 'kara para aklama',
    ],
  ),
  'moderation-terrorism': list(
    ['jihadist', 'extremist', 'radicalize', 'radicalise'],
    [
      'suicide vest', 'car bomb', 'mass shooting', 'terrorist attack', 'join isis',
      'canlı bomba yeleği', 'araç bombası', 'terör saldırısı',
    ],
  ),
  'moderation-illicit': list(
    ['counterfeiting', 'smuggling', 'trafficking'],
    ['human trafficking', 'insan kaçakçılığı', 'sahte para basmak'],
  ),
};
