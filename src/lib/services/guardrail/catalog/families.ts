/**
 * THE FAMILY CATALOG. One entry per policy family, and the only place the
 * console learns what a family is called, what it costs, what it configures and
 * what it looks like on a card.
 *
 * ═══ ADDING A TENTH FAMILY ═══════════════════════════════════════════════════
 * One entry in `DEFINITIONS` below, plus the contract rows a new family needs
 * anyway, plus THREE places outside this file that are listed at the bottom of
 * this block. What this catalog buys is that no SCREEN has to learn the family:
 * once the rows below are filled in, the picker, the card, the summary, the
 * form and the hook eligibility all come from this entry and the contract, with
 * no edit to any renderer.
 *
 * That narrower claim was MEASURED, by adding a throwaway tenth family and
 * removing it again: with the rows below and the three extras filled in, the
 * family appeared on a catalog shelf, was found by its own keyword, rendered a
 * real form from its field specs, produced a card and a summary, and offered
 * exactly the hooks `POLICY_VALID_HOOKS` gave it — with no edit to
 * `PolicyFieldRenderer`, `GuardrailPolicyDrawer`, `GuardrailPolicyCards` or
 * `PolicyCatalogModal`.
 *
 * In `hooks/contract.ts`, because the engine needs them and every one is a
 * `Record<PolicyFamily, …>` whose missing key is a compile error:
 *   · `LEGACY_FINDING_TYPE`      — the legacy `type` its findings persist.
 *                                  `POLICY_FAMILIES` is derived from its keys,
 *                                  so this row is what MAKES the family exist.
 *   · `POLICY_VALID_HOOKS`       — which hooks it may bind to.
 *   · `FAMILY_PRECEDENCE`        — how its mutations win an overlap.
 *   · `STREAM_ELIGIBLE_FAMILIES` / `SPAN_CAPABLE` / `DETERMINISTIC_POLICY_FAMILIES`
 *                                  — sets, so only membership is a decision.
 * In `hooks/messages.ts`:
 *   · `BLOCK_REASON_FOR_FAMILY`  — the coarse reason a blocked user is shown.
 * In `provider/types.domain.ts`:
 *   · a `Guardrail<Name>PolicyConfig extends GuardrailPolicyBase<'name'>`, added
 *     to the `GuardrailPolicy` union.
 * Then here:
 *   · `label`, `description`, `icon`, `color`, `catalog` (group / order /
 *     keywords), `fields`, `defaults`, `summarise`, `needsFailMode`.
 *
 * AND THE THREE PLACES THIS FILE DOES NOT COVER. Two are compile errors, which
 * is the safe direction — the build tells you, rather than a card rendering
 * blank. The third is NOT, and is the one to watch:
 *   · `components/guardrails/policyFamilyMeta.ts` — `META` is a second total
 *     `Record<PolicyFamily, …>` of label / icon / colour, deliberately total so
 *     an omission cannot render an unlabelled card. It predates this catalog and
 *     duplicates its display half; until one of them is deleted, a tenth family
 *     needs a row in BOTH. Compile error if you forget.
 *   · `components/guardrails/GuardrailHooksMatrix.tsx` — `defaultPolicyFor` is
 *     its own family switch, built before `defaults()` existed here and still
 *     hook-aware in a way `defaults()` is not. Compile error if you forget.
 *   · `hooks/legacy.ts` `validateGuardrailHooks` — its `switch (policy.family)`
 *     has a hand-written arm per family, and a family with no arm FALLS THROUGH
 *     SILENTLY. A `required` field declared here is then enforced in the editor
 *     and nowhere on the server, so an incomplete policy saves. No compile
 *     error; the "defaults are accepted by validateGuardrailHooks" case in
 *     `guardrail-catalog.test.ts` is what catches it, and it did.
 *
 * `validHooks`, `streamSafe` and `blockReason` are NOT authored here. They are
 * READ from `POLICY_VALID_HOOKS`, `STREAM_ELIGIBLE_FAMILIES` and
 * `BLOCK_REASON_FOR_FAMILY` when the catalog is assembled, so a change to the
 * contract reaches every screen without anyone remembering to mirror it. A
 * restated copy is a copy that will eventually say a folding matcher can
 * stream, and the streaming guarantee is not the place to find that out.
 *
 * ═══ WHAT `defaults()` IS ════════════════════════════════════════════════════
 * A STARTING POINT, not a valid policy. It fills in exactly the properties the
 * interface makes non-optional — TypeScript will not let a family author skip
 * one — and leaves every optional field ABSENT so the engine's own default
 * stays the single answer to "what happens when this is unset". The field
 * specs carry those engine defaults as `defaultValue`, for the placeholder.
 *
 * It deliberately does NOT fill a reference to a tenant resource: the catalog
 * has no tenant, so `piiPolicyKey` and `modelKey` come back empty and the
 * field's `required` flag is what makes the editor and the server demand them.
 * `guardrail-catalog.test.ts` pins that distinction — a fresh policy may report
 * MISSING fields, never INVALID ones.
 *
 * The `id` is a seed (`tool_access` -> `tool-access`), derived rather than
 * authored so a tenth family needs no id table. It is not unique: the caller
 * makes it so before saving, and `validateGuardrailHooks` rejects a duplicate.
 *
 * ═══ DEPENDENCY RULE ═════════════════════════════════════════════════════════
 * Same as `./fields`: `hooks/contract`, `hooks/messages` and
 * `services/guardrail/constants` — plus `families/secrets` for its pattern
 * TABLE, which is admitted under the same test the other three pass: it reaches
 * neither the database barrel nor React, importing `hooks/contract` and nothing
 * else. Never `hooks/legacy`, `hooks/engine` or `@/lib/database`. `icon` is a
 * NAME, not a component, so nothing here pulls React into the server or a plain
 * unit test.
 *
 * The test to apply to a fourth is not "is it a sibling" but "does importing it
 * construct anything": a family module that grew a dynamic `@/lib/database`
 * import would still be pure to the eye and fatal to the client bundle.
 */

import {
  BLOCK_MESSAGE_VARS,
  HOOK_IDS,
  POLICY_FAMILIES,
  POLICY_VALID_HOOKS,
  REGEX_MAX_MATCH_CHARS,
  STREAM_ELIGIBLE_FAMILIES,
  policyMaxMatchChars,
} from '../hooks/contract';
import type {
  BlockReasonClass,
  CustomPolicyConfig,
  GuardrailPolicy,
  HookId,
  ModerationPolicyConfig,
  PiiPolicyConfig,
  PolicyBase,
  PolicyFamily,
  PromptShieldPolicyConfig,
  RegexPolicyConfig,
  RegexRule,
  SecretsPolicyConfig,
  ToolAccessPolicyConfig,
  WebhookPolicyConfig,
  WordFilterPolicyConfig,
} from '../hooks/contract';
import { BLOCK_REASON_FOR_FAMILY } from '../hooks/messages';
import { MODERATION_CATEGORIES, WORD_FILTER_BUILTIN_LISTS } from '../constants';
// The one module outside the dependency rule's original three, and it is inside
// its SPIRIT: `families/secrets.ts` imports `../hooks/contract` and nothing else
// (checked, and its own header makes purity a stated requirement — the gateway
// calls its scanner on a hot path), so it constructs no provider and pulls no
// React. It is imported for the pattern TABLE only: the `covers` list under
// "Known vendor patterns" has to be the very table the scanner iterates, or it
// is a promise about a vendor the engine may no longer detect.
import { KNOWN_SECRET_PATTERNS } from '../families/secrets';
import {
  SAFETY_ACTION_OPTIONS,
  SIDE_EFFECT_OPTIONS,
  fieldsFor,
  validateHttpsUrl,
  validateRegexFlags,
  validateRegexPattern,
} from './fields';
import type { PolicyFieldConfig, PolicyFieldOption, PolicyFieldSpec } from './fields';

/** The configuration interface that goes with one family. Derived from the
 *  union, so a tenth family is covered the moment it joins it. */
export type GuardrailPolicyConfigFor<F extends PolicyFamily> = Extract<GuardrailPolicy, { family: F }>;

/**
 * The catalog's four shelves. An operator arrives knowing what they want to
 * stop, not which engine stops it, so the grouping is by SUBJECT:
 *   data    — something sensitive is in the text
 *   content — the text itself is unacceptable
 *   access  — the assistant is reaching for something it should not
 *   custom  — you describe the rule
 */
export type PolicyCatalogGroup = 'content' | 'data' | 'access' | 'custom';

export interface PolicyCatalogPlacement {
  group: PolicyCatalogGroup;
  /** Within the group, ascending. Cheap and deterministic before anything that
   *  costs a model call or a network hop. */
  order: number;
  /** Free-text search terms for the picker — the words an operator types when
   *  they do not know what the family is called ("gdpr", "jailbreak", "ssrf"). */
  keywords: readonly string[];
}

export interface PolicyFamilySpec<F extends PolicyFamily = PolicyFamily> {
  family: F;
  label: string;
  /** The catalog card's copy: what it detects, and what it costs. One line. */
  description: string;
  /** A kebab-case tabler icon name (`shield-lock` -> `IconShieldLock`). A NAME
   *  and not a component, so this module stays free of React. */
  icon: string;
  /** Mantine colour token. */
  color: string;
  catalog: PolicyCatalogPlacement;
  fields: readonly PolicyFieldSpec[];
  defaults: () => GuardrailPolicyConfigFor<F>;
  /** The card's one-line summary of a CONFIGURED policy. Must survive a partial
   *  or legacy config, and must never echo a secret. */
  summarise: (policy: GuardrailPolicyConfigFor<F>) => string;
  /**
   * Whether `failMode` is a real question here.
   *
   * It answers "the policy could not RUN" — a model outage, a webhook timeout,
   * a PII policy read that failed — which only the families that reach out of
   * the process can experience. A regex, a word list and the secret patterns
   * run in memory on a string: offering them a failure mode is a control for a
   * state that does not occur, which is noise at best and false comfort at
   * worst.
   */
  needsFailMode: boolean;
  /** READ from `BLOCK_REASON_FOR_FAMILY`. Several families share one class on
   *  purpose; the per-policy `message` is what separates them. */
  blockReason: BlockReasonClass;
  /** READ from `POLICY_VALID_HOOKS`. */
  validHooks: readonly HookId[];
  /** READ from `STREAM_ELIGIBLE_FAMILIES`. Necessary, not sufficient: a
   *  stream-safe family still needs a bounded match length from its own config. */
  streamSafe: boolean;
}

/** The distributed union — what a renderer iterating families holds. */
export type AnyPolicyFamilySpec = { [F in PolicyFamily]: PolicyFamilySpec<F> }[PolicyFamily];

/** What a family author writes. Everything else is derived. */
export type PolicyFamilyDefinition<F extends PolicyFamily> = Omit<
  PolicyFamilySpec<F>,
  'family' | 'blockReason' | 'validHooks' | 'streamSafe'
>;

// ── shared option sets ──────────────────────────────────────────────────────

/** Derived from the definitions the moderation family already ships, so the
 *  picker cannot fall behind the classifier's category set. */
const MODERATION_CATEGORY_OPTIONS: readonly PolicyFieldOption[] = MODERATION_CATEGORIES.map(
  (category) => ({ value: category.id, label: category.label }),
);

const BUILTIN_WORD_LIST_OPTIONS: readonly PolicyFieldOption[] = WORD_FILTER_BUILTIN_LISTS.map(
  (list) => ({ value: list.id, label: list.label, description: list.description }),
);

const SEVERITY_OPTIONS: readonly PolicyFieldOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/**
 * What "Known vendor patterns" actually covers, read from the scanner's own
 * table so the list under the switch cannot promise a vendor the engine has
 * stopped detecting — the same rule `MODERATION_CATEGORY_OPTIONS` follows.
 *
 * `description` is deliberately absent: a pattern's `source` is the only other
 * thing the definition carries, and putting a raw regex under a switch is how a
 * detail panel becomes something nobody reads. The label is the answer to the
 * question actually being asked ("does this catch a GitHub token?").
 */
const KNOWN_SECRET_PATTERN_OPTIONS: readonly PolicyFieldOption[] = KNOWN_SECRET_PATTERNS.map(
  (definition) => ({ value: definition.id, label: definition.label }),
);

// ── defaults ────────────────────────────────────────────────────────────────

/**
 * The two hooks a new policy binds to when its family can serve them.
 *
 * `tool_access` cannot — its subject is a tool call — so it falls back to its
 * own valid list. The streaming hook is never bound by default: it costs the
 * caller latency and needs a config that declares a bounded match length, so it
 * is a deliberate choice rather than a starting state.
 */
const PREFERRED_DEFAULT_HOOKS: readonly HookId[] = ['input.pre', 'output.pre'];

function defaultHooksFor(family: PolicyFamily): HookId[] {
  const valid = POLICY_VALID_HOOKS[family] ?? [];
  const preferred = PREFERRED_DEFAULT_HOOKS.filter((hook) => valid.includes(hook));
  return preferred.length > 0
    ? [...preferred]
    : valid.filter((hook) => hook !== 'output.stream.delta');
}

/**
 * The base every `defaults()` spreads. `{ timing: 'sync', onFail: 'block' }` —
 * the stored shape the enforcement control calls BLOCK — matching both the
 * legacy lift and what an operator adding a policy means by it: a policy that
 * only observes cannot stop anything, and nobody adds a guardrail policy hoping
 * it will not.
 */
function base<F extends PolicyFamily>(
  family: F,
): Pick<PolicyBase<F>, 'id' | 'family' | 'enabled' | 'hooks' | 'schedule'> {
  return {
    id: family.replace(/_/g, '-'),
    family,
    enabled: true,
    hooks: defaultHooksFor(family),
    schedule: { timing: 'sync', onFail: 'block' },
  };
}

// ── summary helpers ─────────────────────────────────────────────────────────

const listLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

const enabledKeys = (map: unknown): string[] =>
  map !== null && typeof map === 'object' && !Array.isArray(map)
    ? Object.entries(map as Record<string, unknown>)
        .filter(([, flag]) => flag === true)
        .map(([key]) => key)
    : [];

const mapSize = (map: unknown): number =>
  map !== null && typeof map === 'object' && !Array.isArray(map)
    ? Object.keys(map as Record<string, unknown>).length
    : 0;

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Joins the parts a summary actually has, so a half-configured policy reads as
 *  a sentence rather than as ", , ". */
const summary = (parts: Array<string | false | undefined>, fallback: string): string => {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return kept.length > 0 ? kept.join(' · ') : fallback;
};

/** First line of a prose field, clipped. Never the whole prompt: the card is
 *  one line and a 4KB rule would push every other card off the screen. */
const firstLine = (value: unknown, max = 80): string => {
  if (typeof value !== 'string') return '';
  const line = value.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Host only, never the path or the query: a webhook url routinely carries a
 *  token in it, and a card is the one place nobody expects to leak one. */
const hostOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
};

// ── "that belongs in the other list" ────────────────────────────────────────
/**
 * `tool_access` shows an operator SIX near-identical string lists across three
 * groups, and each takes a different kind of string — and, for the two that
 * take a path, a different answer to "does `*` work":
 *
 *   allow / deny                            TOOL NAMES     (`nameMatches`)      * = glob
 *   allowedDomains / deniedDomains          HOST NAMES     (`hostAllowed` / `hostDenied`)  * = glob
 *   allowedPathPrefixes / deniedPathPrefixes  FILESYSTEM PATHS (`matchesAnyPrefix`)         * = a literal directory name
 *
 * Nothing about the controls says so, and the failure is SILENT in the worst
 * way: a url typed into `deny` is a perfectly valid string that `nameMatches`
 * compares against `${serverKey}/${tool}` and never matches, so the policy
 * reads as configured, saves, runs, and blocks nothing. The operator's evidence
 * that the guardrail works is a screen that agrees with them. A `*` in a path
 * prefix is the same failure in miniature — legal string, no match, no word
 * said — which is why `globInPathList` exists rather than the path lists simply
 * growing a glob too; `matchesAnyPrefix` in `families/toolAccess.ts` carries the
 * audit that decided that.
 *
 * These three checks are the detector for exactly that. They fire only on a
 * value that is present and is provably of ANOTHER field's type, and they name
 * the field it belongs in — a validator that merely said "invalid" would leave
 * the operator with the same question they started with.
 *
 * A HINT, NOT A GATE. `validateGuardrailHooks` (hooks/legacy.ts) is the save-time
 * authority and knows nothing about this, so a policy carrying a misplaced entry
 * still saves — which is right, because the entry is useless rather than
 * illegal. The drawer surfaces it beside the control; see the handover note.
 */

const listEntries = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** `https://x/y`, `file:///etc`, and the protocol-relative `//evil.com` that
 *  `parseUrlArgument` also treats as a url. */
const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const looksLikeUrl = (entry: string): boolean => {
  const trimmed = entry.trim();
  return URL_LIKE.test(trimmed) || trimmed.startsWith('//');
};

/** Which entries offend, phrased so one and many both read as a sentence. */
const naming = (entries: readonly string[]): string =>
  entries.length === 1
    ? `“${entries[0]}”`
    : `${entries.length} entries, starting with “${entries[0]}”,`;

const verb = (entries: readonly string[], one: string, many: string): string =>
  entries.length === 1 ? one : many;

/** A url in a list of TOOL NAMES. */
function urlInNameList(value: unknown, otherList: string): string | undefined {
  const offenders = listEntries(value).filter(looksLikeUrl);
  if (offenders.length === 0) return undefined;
  return `${naming(offenders)} ${verb(offenders, 'is a url', 'are urls')}, and this list matches tool NAMES — so it can never match anything. A host belongs in ${otherList}, which is what checks the urls inside a tool’s arguments.`;
}

/** Why an entry can never equal a hostname. Ordered so the most specific
 *  diagnosis wins: a full url carries a path too, and naming the scheme is the
 *  more useful half. */
function hostFault(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (looksLikeUrl(trimmed)) return 'a scheme';
  if (trimmed.includes('/')) return 'a path';
  // `url.hostname` never carries the port, so `example.com:8443` matches nothing.
  if (/:\d+$/.test(trimmed)) return 'a port';
  return undefined;
}

/** Anything but a bare host in a list of HOST NAMES. */
function notAHost(value: unknown): string | undefined {
  const offenders = listEntries(value).filter((entry) => hostFault(entry) !== undefined);
  if (offenders.length === 0) return undefined;
  const fault = hostFault(offenders[0] ?? '') ?? 'a scheme';
  return `${naming(offenders)} ${verb(offenders, 'carries', 'carry')} ${fault}. This list is matched against the HOST of a url and nothing else — “internal.corp”, never “https://internal.corp/admin” — so the scheme, the path and the port match nothing.`;
}

/** A url in a list of FILESYSTEM paths. */
function urlInPathList(value: unknown, otherList: string): string | undefined {
  const offenders = listEntries(value).filter(looksLikeUrl);
  if (offenders.length === 0) return undefined;
  return `${naming(offenders)} ${verb(offenders, 'is a url', 'are urls')}, and this list matches filesystem PATHS — “/etc”, not “https://…”. A host belongs in ${otherList}.`;
}

/**
 * A `*` in a list of FILESYSTEM paths, where it is a literal directory name.
 *
 * The tool lists and the domain lists both take a glob, so an operator who has
 * learned that writes `/workspace/*` here next and gets silence — a legal
 * string, no match, and nothing on screen to say so. This is the one place that
 * says it. The decision NOT to add a glob here is argued in full at
 * `matchesAnyPrefix` in `families/toolAccess.ts`; the short version is in the
 * message, because an operator reading it needs the alternative, not the
 * rationale.
 */
function globInPathList(value: unknown): string | undefined {
  const offenders = listEntries(value).filter((entry) => entry.includes('*'));
  if (offenders.length === 0) return undefined;
  return `${naming(offenders)} ${verb(offenders, 'contains', 'contain')} a *, which is not a wildcard in this list — here it is a literal directory name, so the entry matches nothing. A prefix already covers everything beneath it: write “/workspace”, not “/workspace/*”. (The tool and domain lists do take a *; these two deliberately do not.)`;
}

/**
 * The undeclared scan switched on with nothing for it to compare against.
 *
 * It walks strings and hands what it finds to the domain and path lists; with
 * neither list configured it can produce no finding at all, and an operator who
 * turned it on to make a rule fire has turned on the half that was never the
 * missing piece.
 */
function scanWithNoLists(value: unknown, config: PolicyFieldConfig): string | undefined {
  if (value !== true) return undefined;
  const rules =
    listLength(config.allowedDomains)
    + listLength(config.deniedDomains)
    + listLength(config.allowedPathPrefixes)
    + listLength(config.deniedPathPrefixes);
  if (rules > 0) return undefined;
  return 'This policy has no domain and no path list, so there is nothing for the scan to compare what it finds against and it can produce no finding. Add an allowed or denied domain, or an allowed or denied path prefix, first.';
}

// ── the definitions ─────────────────────────────────────────────────────────

type PolicyFamilyDefinitions = { readonly [F in PolicyFamily]: PolicyFamilyDefinition<F> };

const DEFINITIONS: PolicyFamilyDefinitions = {
  // ══ data ═════════════════════════════════════════════════════════════════
  pii: {
    label: 'Personal data',
    description:
      'Names, contact details and ID numbers, scanned through one of your PII policies. Categories, languages, checksums and mask strategies belong to that policy — this form shows and edits them in place, on the policy itself.',
    icon: 'fingerprint',
    color: 'blue',
    catalog: {
      group: 'data',
      order: 10,
      keywords: ['pii', 'personal', 'privacy', 'gdpr', 'kvkk', 'email', 'phone', 'iban', 'identity', 'redact', 'mask'],
    },
    needsFailMode: true, // the policy read is a database round trip, and it can fail
    fields: fieldsFor<PiiPolicyConfig>([
      {
        kind: 'reference',
        key: 'piiPolicyKey',
        resource: 'pii_policy',
        label: 'PII policy',
        required: true,
        // The categories are shown BELOW this picker, read live from the policy
        // itself. That is not the same thing as duplicating them here: nothing
        // about the category set is stored on the guardrail, so there is no
        // second copy to drift. "Which categories count as personal data" is
        // the decision an operator opens this drawer to make, and sending them
        // to another page to make it is how it goes unmade.
        inlineDetail: true,
        help: 'Which PII policy this scans through. It is a shared asset — the categories, languages and mask strategies below belong to the policy, not to this guardrail, and every guardrail pointing at it sees the same ones.',
        emptyHint: 'No PII policies yet. Create one under Security → PII, then come back.',
      },
      {
        kind: 'select',
        key: 'actionOverride',
        label: 'How a match is rewritten',
        // ADVANCED: an override of a rendering the PII service already gets
        // right, and only two of its five values change anything at all.
        advanced: true,
        options: [
          { value: 'redact', label: 'Redact', description: 'Replace the match with a category tag.' },
          { value: 'mask', label: 'Mask', description: 'Keep the shape, hide the characters.' },
          { value: 'tokenize', label: 'Tokenize', description: 'Stored as tokenize; applied as redact here, because this layer has no vault to detokenize the answer from.' },
          { value: 'detect', label: 'Detect only', description: 'Falls through to “When it finds something” — nothing is rewritten unless that says Redact.' },
          { value: 'block', label: 'Block', description: 'An enforcement word, not a rendering one; it too falls through to “When it finds something”.' },
        ],
        clearable: true,
        inheritLabel: 'Whatever this policy does',
        // "Follow the POLICY's action" used to read as the PII policy's own
        // `defaultAction`, and it never was: `resolveScanAction`
        // (families/pii.ts) always passes an explicit action so a PII policy
        // shared by three guardrails cannot decide for all three. The label and
        // the help now say whose action it is.
        help: 'Overrides how the PII service rewrites a match. Only Redact and Mask change the rendering; the other three fall through to “When it finds something” above. The referenced PII policy’s default action is never used here.',
      },
      {
        kind: 'select',
        key: 'locale',
        // RENAMED, and the help below is rewritten, because the old copy said
        // this narrowed the scan and it does not. `families/pii.ts` passes it
        // to `scanWithPolicy` as `locale`, which reaches `detect` as the LABEL
        // locale (`categoryLabel(cat, locale)`); the language SCOPE comes from
        // the PII policy's own `languages`, which `pickActiveBuiltins` filters
        // on. An operator following the old sentence would set this expecting
        // fewer patterns to run and get exactly the same scan in a different
        // language of prose.
        label: 'Finding language',
        // ADVANCED: it changes the prose on a finding, not the scan. Which
        // languages are scanned belongs to the referenced PII policy.
        advanced: true,
        options: [
          { value: 'global', label: 'English (no localisation)' },
          { value: 'en', label: 'English' },
          { value: 'tr', label: 'Turkish' },
          { value: 'de', label: 'German' },
          { value: 'fr', label: 'French' },
          { value: 'es', label: 'Spanish' },
          { value: 'it', label: 'Italian' },
          { value: 'pt', label: 'Portuguese' },
          { value: 'ar', label: 'Arabic' },
          { value: 'ja', label: 'Japanese' },
          { value: 'zh', label: 'Chinese' },
        ],
        clearable: true,
        inheritLabel: 'English (the default)',
        help: 'The language the labels and messages on this policy’s findings are written in. It does NOT narrow the scan: which languages are scanned belongs to the PII policy above, alongside its categories.',
      },
      {
        kind: 'switch',
        key: 'detectObfuscated',
        label: 'Also catch obfuscated writing',
        defaultValue: true,
        // ADVANCED: on by default and the right default. Turning it off is an
        // expert trade — it is also what makes a PII policy stream-eligible.
        advanced: true,
        help: 'A second pass over normalised text, so “j.doe (at) example.com” still matches. It scans a string of a different length, so its findings carry no position — which is also why a policy with this on cannot run on a stream.',
      },
      {
        kind: 'flag_map',
        key: 'legacyCategories',
        label: 'Categories carried over from the old configuration',
        readOnly: true,
        advanced: true,
        defaultValue: false,
        help: 'Written only by the upgrade from the pre-hook configuration, never by this screen. It is the database-free fallback: if the PII policy above cannot be read, the scan runs statelessly with exactly these categories instead of failing.',
      },
    ]),
    defaults: () => ({ ...base('pii'), piiPolicyKey: '' }),
    summarise: (policy) =>
      summary(
        [
          policy.piiPolicyKey ? `Scans through “${policy.piiPolicyKey}”` : undefined,
          policy.locale && policy.locale !== 'global' ? policy.locale.toUpperCase() : undefined,
          policy.actionOverride ? `rewrites as ${policy.actionOverride}` : undefined,
          policy.detectObfuscated === false ? 'obfuscation pass off' : undefined,
        ],
        'No PII policy chosen yet, so this scans nothing.',
      ),
  },

  secrets: {
    label: 'Credentials',
    description:
      'API keys, access tokens and private keys — the vendor patterns plus an optional high-entropy heuristic. No database, no model, no network.',
    icon: 'key',
    color: 'yellow',
    catalog: {
      group: 'data',
      order: 20,
      keywords: ['secret', 'credential', 'api key', 'token', 'password', 'entropy', 'aws', 'stripe', 'jwt', 'pem'],
    },
    needsFailMode: false,
    fields: fieldsFor<SecretsPolicyConfig>([
      {
        kind: 'switch',
        key: 'known',
        label: 'Known vendor patterns',
        defaultValue: true,
        // The list is DERIVED rather than named in this sentence, which is why
        // the sentence no longer names five vendors and the control does: the
        // prose could not be kept true as patterns are appended, and "effectively
        // no false positives" is not an answer to "does this catch my token".
        covers: KNOWN_SECRET_PATTERN_OPTIONS,
        help: 'Precise credential shapes, so effectively no false positives. Every pattern this switch turns on is listed below.',
      },
      {
        kind: 'switch',
        key: 'genericHighEntropy',
        label: 'Long random-looking strings',
        defaultValue: true,
        help: 'Catches a credential no vendor pattern knows. It also fires on ordinary base64 and on UUIDs, which is what the entropy floor below is for.',
      },
      {
        kind: 'number',
        key: 'minEntropy',
        label: 'Entropy floor',
        min: 0,
        max: 8,
        step: 0.1,
        unit: 'bits/char',
        defaultValue: 3.5,
        advanced: true,
        visibleWhen: (config) => config.genericHighEntropy !== false,
        help: 'How random a string has to look before it counts. Lower catches more and false-positives on identifiers; higher misses short keys.',
      },
      {
        kind: 'string_list',
        key: 'allowValues',
        label: 'Known-safe values',
        // ADVANCED: an exception list nobody writes until a real scan has
        // reported something they want to keep.
        advanced: true,
        itemPlaceholder: 'sk_test_EXAMPLE_xxxxxxxxxxxxxxxxxxxx',
        unique: true,
        help: 'Exact strings never reported — the documentation sample and the test fixture that would otherwise trip this on every run.',
      },
    ]),
    defaults: () => ({ ...base('secrets') }),
    summarise: (policy) =>
      summary(
        [
          policy.known === false ? undefined : 'Vendor patterns',
          policy.genericHighEntropy === false
            ? undefined
            : `high-entropy scan${policy.minEntropy ? ` above ${policy.minEntropy}` : ''}`,
          listLength(policy.allowValues) > 0
            ? `${plural(listLength(policy.allowValues), 'value')} allowed`
            : undefined,
        ],
        'Both detectors are off, so this finds nothing.',
      ),
  },

  // ══ content ══════════════════════════════════════════════════════════════
  word_filter: {
    label: 'Word filter',
    description:
      'Word lists and phrases, matched after normalisation so leetspeak and s p a c e d out evasion still hit. Cannot run on a stream, for the same reason.',
    icon: 'filter-x',
    color: 'grape',
    catalog: {
      group: 'content',
      order: 10,
      keywords: ['word', 'profanity', 'banned', 'blocklist', 'blacklist', 'slur', 'term', 'phrase'],
    },
    needsFailMode: false,
    fields: fieldsFor<WordFilterPolicyConfig>([
      {
        kind: 'flag_map',
        key: 'builtinLists',
        label: 'Built-in lists',
        options: BUILTIN_WORD_LIST_OPTIONS,
        defaultValue: false,
        help: 'Curated lists shipped with the console, matched with obfuscation folding.',
      },
      {
        kind: 'reference',
        key: 'customListKeys',
        resource: 'word_list',
        multiple: true,
        label: 'Your word lists',
        // Same reason as `pii.piiPolicyKey`: the words are the thing being
        // decided and they live on another page. Declared here so the day a
        // screen supplies a `word_list` detail renderer, the words appear under
        // the picker with no edit to this file. Until then this draws exactly
        // what it drew before.
        inlineDetail: true,
        help: 'Reusable lists you maintain once and attach to as many guardrails as you like. A list is a shared asset — editing it changes every guardrail that attaches it.',
        emptyHint: 'No word lists yet. Create one under Security → Word lists.',
      },
      {
        kind: 'string_list',
        key: 'words',
        label: 'Words and phrases',
        itemPlaceholder: 'a term to block',
        unique: true,
        help: 'Terms that belong to this policy alone. Anything you would attach twice belongs in a word list instead.',
      },
      {
        kind: 'string_list',
        key: 'regexes',
        label: 'Patterns carried over from the old configuration',
        advanced: true,
        itemPlaceholder: '\\bcase[- ]?number\\b',
        validateItem: (item) => validateRegexPattern(item),
        help: 'Kept so the upgrade from the pre-hook configuration is behaviour-identical. New patterns belong in a Regex policy, which reports where it matched, can redact in place and can run on a stream — none of which these can.',
      },
    ]),
    defaults: () => ({
      ...base('word_filter'),
      // Derived from the definitions, so a new built-in list arrives switched
      // on or off exactly as its author declared rather than as this file guessed.
      builtinLists: Object.fromEntries(
        WORD_FILTER_BUILTIN_LISTS.map((list) => [list.id, list.defaultEnabled]),
      ),
    }),
    summarise: (policy) =>
      summary(
        [
          enabledKeys(policy.builtinLists).length > 0
            ? `${plural(enabledKeys(policy.builtinLists).length, 'built-in list')}`
            : undefined,
          listLength(policy.customListKeys) > 0
            ? plural(listLength(policy.customListKeys), 'custom list')
            : undefined,
          listLength(policy.words) > 0 ? plural(listLength(policy.words), 'word') : undefined,
          listLength(policy.regexes) > 0
            ? plural(listLength(policy.regexes), 'carried-over pattern')
            : undefined,
        ],
        'Nothing to match yet.',
      ),
  },

  moderation: {
    label: 'Moderation',
    description:
      'An LLM classifier for harmful and policy-violating content across the standard category set. Costs a model call on every run.',
    icon: 'alert-octagon',
    color: 'red',
    catalog: {
      group: 'content',
      order: 20,
      keywords: ['moderation', 'harmful', 'toxicity', 'hate', 'violence', 'sexual', 'self-harm', 'classifier'],
    },
    needsFailMode: true,
    fields: fieldsFor<ModerationPolicyConfig>([
      {
        kind: 'reference',
        key: 'modelKey',
        resource: 'model',
        label: 'Model',
        required: true,
        help: 'The classifier. An enabled policy with no model reads as active while nothing runs, so the server refuses to save one.',
        emptyHint: 'No models available on this project yet.',
      },
      {
        kind: 'flag_map',
        key: 'categories',
        label: 'Categories',
        options: MODERATION_CATEGORY_OPTIONS,
        defaultValue: false,
        help: 'Only the categories switched on are sent to the classifier, and only they can produce a finding.',
      },
    ]),
    defaults: () => ({
      ...base('moderation'),
      categories: Object.fromEntries(
        MODERATION_CATEGORIES.map((category) => [category.id, category.defaultEnabled]),
      ),
    }),
    summarise: (policy) => {
      const on = enabledKeys(policy.categories).length;
      return summary(
        [
          on > 0 ? `${on} of ${MODERATION_CATEGORIES.length} categories` : 'No categories switched on',
          policy.modelKey ? `via ${policy.modelKey}` : 'no model chosen',
        ],
        'Not configured yet.',
      );
    },
  },

  prompt_shield: {
    label: 'Prompt shield',
    description:
      // "classifier", not "check": this is the last user-visible survivor of the
      // noun this rename retired, and it sits directly under `moderation`'s
      // description in the catalog — which already says "An LLM classifier".
      'An LLM classifier for prompt injection and jailbreak attempts. Costs a model call, and its block message deliberately says nothing about why.',
    icon: 'shield-lock',
    color: 'orange',
    catalog: {
      group: 'content',
      order: 30,
      keywords: ['injection', 'jailbreak', 'prompt', 'shield', 'dan', 'exfiltration', 'override'],
    },
    needsFailMode: true,
    fields: fieldsFor<PromptShieldPolicyConfig>([
      {
        kind: 'reference',
        key: 'modelKey',
        resource: 'model',
        label: 'Model',
        required: true,
        help: 'The judge. An enabled policy with no model reads as active while nothing runs.',
        emptyHint: 'No models available on this project yet.',
      },
      {
        kind: 'select',
        key: 'sensitivity',
        label: 'Sensitivity',
        required: true,
        options: [
          { value: 'low', label: 'Low', description: 'Only unmistakable attempts. Fewest false positives.' },
          { value: 'balanced', label: 'Balanced', description: 'The default, and what almost everyone should use.' },
          { value: 'high', label: 'High', description: 'Flags anything suspicious. Expect legitimate prompts about prompts to trip it.' },
        ],
      },
    ]),
    defaults: () => ({ ...base('prompt_shield'), sensitivity: 'balanced' }),
    summarise: (policy) =>
      summary(
        [
          `${policy.sensitivity ?? 'balanced'} sensitivity`,
          policy.modelKey ? `via ${policy.modelKey}` : 'no model chosen',
        ],
        'Not configured yet.',
      ),
  },

  // ══ access ═══════════════════════════════════════════════════════════════
  tool_access: {
    label: 'Tool access',
    description:
      'Which tools may run, for whom, with what arguments, against which domains and paths. The only family that can stop a tool call before it happens.',
    icon: 'tool',
    color: 'cyan',
    catalog: {
      group: 'access',
      order: 10,
      keywords: ['tool', 'mcp', 'function', 'allowlist', 'denylist', 'ssrf', 'domain', 'path', 'role', 'side effect', 'schema'],
    },
    // Deliberately false. `families/toolAccess.ts` CAN degrade — an argument
    // nested past `maxArgDepth`, a DNS lookup that fails while
    // `denyPrivateNetworks` is on — so a per-policy failure mode would not be
    // meaningless here. It is left off because those two cases are rare and
    // narrow and the guardrail-level `failMode` already covers them. Flipping
    // this one boolean is all it takes to surface the control.
    needsFailMode: false,
    fields: fieldsFor<ToolAccessPolicyConfig>([
      {
        kind: 'string_list',
        key: 'allow',
        label: 'Allowed tool names',
        group: 'Which tools',
        // An example of THIS field's own type, because a placeholder is what
        // people copy — and `files.read` was a shape the engine never sees.
        itemPlaceholder: 'github/create_issue',
        unique: true,
        validate: (value) => urlInNameList(value, 'Allowed domains'),
        help: 'Tool NAMES, not urls. A name is the canonical one the engine matches on: “server/tool” for an MCP tool (github/create_issue), or “agent.tool.<tool>.<action>” for a workspace action (agent.tool.crm.create_ticket). An entry is exact, or a * glob — “github/*” allows every tool on that server. When this list is non-empty it is exhaustive: a tool not on it is denied. It is matched against the canonical name only, so an allow written against a renamed tool’s old spelling does not silently open it.',
      },
      {
        kind: 'string_list',
        key: 'deny',
        label: 'Denied tool names',
        group: 'Which tools',
        itemPlaceholder: 'github/delete_repo',
        unique: true,
        validate: (value) => urlInNameList(value, 'Denied domains'),
        help: 'The same shape as the allowed list — tool NAMES, exact or with a * glob — and it always wins over it. A deny is matched against both the canonical name and the older spelling a model may still be calling, so either one fires. Where a tool may REACH is a different question: a host goes in Denied domains, a file path in Denied path prefixes. A url here matches nothing.',
      },
      {
        kind: 'key_list',
        key: 'allowedRoles',
        label: 'Roles per tool',
        group: 'Which tools',
        // ADVANCED: a refinement of the two lists above — who may run a tool
        // that is already allowed at all.
        advanced: true,
        keyLabel: 'Tool',
        valueLabel: 'Roles',
        keyPlaceholder: 'github/delete_repo',
        valuePlaceholder: 'admin',
        help: 'A tool listed here runs only for an actor holding one of its roles. The actor comes from the authenticated context, never from a request header — a role a caller can choose is a role a caller can borrow.',
      },
      {
        kind: 'key_enum',
        key: 'sideEffects',
        label: 'What each tool does',
        group: 'Side effects',
        // ADVANCED, and so is the whole Side effects group: it is a second way
        // to say what the two tool lists already say, by CLASS rather than by
        // name, and it is only worth the typing once naming every tool stops
        // scaling.
        advanced: true,
        keyLabel: 'Tool',
        keyPlaceholder: 'github/delete_repo',
        options: SIDE_EFFECT_OPTIONS,
        help: 'Classifies a tool so the table below can act on it without naming every tool twice. Keyed by the same tool NAME the lists above use, and a * glob is matched here too — the most literal key wins, so “github/delete_repo” is not shadowed by “github/*”.',
      },
      {
        kind: 'select',
        key: 'defaultSideEffect',
        label: 'An undeclared tool counts as',
        group: 'Side effects',
        advanced: true,
        options: SIDE_EFFECT_OPTIONS,
        clearable: true,
        inheritLabel: 'Read (the default)',
        help: 'Defaulting an unknown tool to External made every unclassified tool suspicious and drowned the real signal; Read is the honest answer.',
      },
      {
        kind: 'key_enum',
        key: 'sideEffectActions',
        label: 'What to do about each side effect',
        group: 'Side effects',
        advanced: true,
        keys: SIDE_EFFECT_OPTIONS,
        // THE SHARED ARRAY, by identity: `isOutcomeField` and
        // `outcomeFieldsElsewhere` (GuardrailPolicyDrawer) recognise an action
        // field by `options === SAFETY_ACTION_OPTIONS`, so a derived copy would
        // silently stop being one and block 4 would stop saying this table is
        // here. It also renders in FULL — this control is advanced, and its own
        // defaults are the two rungs the basic action control hides; see
        // `basicOptions`.
        options: SAFETY_ACTION_OPTIONS,
        defaultValue: 'allow',
        // Mirrors `DEFAULT_SIDE_EFFECT_ACTIONS` in `families/toolAccess.ts`.
        // Only the two rows that differ are listed; the rest fall through to
        // `defaultValue`, so this map cannot drift into re-stating 'allow'.
        defaultValues: { destructive: 'warn', external: 'warn' },
        help: 'Destructive and External default to Warn rather than Block, because that reproduces what actually happened before: those two resolved to a sandbox decision whose adapter is a pass-through, so the tool ran anyway.',
      },
      {
        kind: 'string_list',
        key: 'allowedDomains',
        label: 'Allowed domains',
        group: 'Where it may reach',
        itemPlaceholder: 'api.example.com',
        unique: true,
        validate: notAHost,
        // EXACT unless written with a leading dot — `hostAllowed` and
        // `hostDenied` deliberately differ, and saying "a bare host covers its
        // subdomains" on both would be false on this one.
        help: 'HOST NAMES, matched against the urls in a tool’s ARGUMENTS. Non-empty means exhaustive — “allow these, deny the rest”: a url whose host is not listed is denied. A bare entry matches the host EXACTLY (this list and the denied list differ here, deliberately); write a leading dot, “.example.com”, to cover the apex and its subdomains; write a * anywhere to make the entry a glob over the whole host — “*.example.com” is the subdomains and NOT the apex, “*” is every host. A glob means the same thing in both domain lists. Keep the * at the FRONT: a trailing one is an open suffix, so “api.example.*” also allows api.example.com.evil.test, which is a domain somebody else can register. A port never matches, because only the host is compared. Reach: any argument whose entire value is a url is checked, so this list works without declaring anything; a url quoted inside a longer argument, or one in a tool’s result, needs a declared argument path below or the undeclared scan.',
      },
      {
        kind: 'string_list',
        key: 'deniedDomains',
        label: 'Denied domains',
        group: 'Where it may reach',
        itemPlaceholder: 'internal.corp',
        unique: true,
        validate: notAHost,
        help: 'HOST NAMES, matched against the urls in a tool’s ARGUMENTS, and always winning over the allowed list. A bare entry also covers its subdomains — “internal.corp” denies api.internal.corp — because denying more is the fail-safe direction, and this is where the two domain lists differ. A * anywhere makes the entry a glob over the whole host: “*” denies every host, and “*.internal.corp” denies the subdomains but NOT internal.corp itself, which the bare entry already covers. A port never matches, because only the host is compared. Same reach as above: any argument whose entire value is a url is checked without declaring anything. A url you want stopped belongs here, as its host — the tool lists above match names and can never match one.',
      },
      {
        kind: 'key_list',
        key: 'urlArgPaths',
        label: 'Which arguments carry a url',
        group: 'Where it may reach',
        // ADVANCED: the domain lists already work with nothing declared here —
        // this is for a url buried inside a larger argument.
        advanced: true,
        keyLabel: 'Tool',
        valueLabel: 'Argument paths',
        keyPlaceholder: 'agent.browser.browser_navigate',
        valuePlaceholder: 'url',
        help: 'WHERE A URL LIVES, when it is not the whole argument. An argument whose entire value is a url is found on its own, so the two lists above already work with nothing declared here. Declare a path (“url”, “request.url”, “attachments.*.url”) when the url is embedded in a larger value, when the argument may be malformed and you want that reported rather than skipped, or when the scheme matters — a declared path is the only place a non-http scheme (file:, data:) is rejected outright. A declared path always wins over what discovery would have found at the same argument.',
      },
      {
        kind: 'switch',
        key: 'denyPrivateNetworks',
        label: 'Block private and loopback addresses',
        group: 'Where it may reach',
        defaultValue: false,
        // ADVANCED despite being security-relevant, because it depends on the
        // advanced control above it: it resolves DNS, so it only ever sees a
        // url that is a whole argument or sits at a declared path.
        advanced: true,
        help: 'SSRF guard — loopback, private, link-local, CGNAT and cloud-metadata addresses, resolved through the one definition this codebase has. It resolves DNS, so it runs only on a url that is a whole argument or sits at a declared path above, never on one scraped out of prose and never on a streaming hook. At most 16 distinct urls per call are resolved; the rest are reported as degraded rather than as safe.',
      },
      {
        kind: 'string_list',
        key: 'allowedPathPrefixes',
        label: 'Allowed path prefixes',
        group: 'Which files',
        itemPlaceholder: '/workspace/data',
        unique: true,
        validate: (value) => urlInPathList(value, 'Allowed domains') ?? globInPathList(value),
        help: 'FILESYSTEM PATHS — not urls, and not hosts. Non-empty means exhaustive: a path under none of these prefixes is denied. NO * HERE: a prefix is already the wildcard, so “/workspace” covers everything beneath it and “/workspace/*” would match nothing at all. Comparison happens after the argument is normalised against the root below and is segment-aware, so “/workspace” covers /workspace/report.csv but not /workspace-old, and /workspace/../etc/shadow is resolved before it is compared rather than after. Reach: any argument whose entire value is an absolute path is checked, so this list works without declaring anything; a path mentioned inside a longer argument needs a declared argument path below or the undeclared scan.',
      },
      {
        kind: 'string_list',
        key: 'deniedPathPrefixes',
        label: 'Denied path prefixes',
        group: 'Which files',
        itemPlaceholder: '/etc',
        unique: true,
        validate: (value) => urlInPathList(value, 'Denied domains') ?? globInPathList(value),
        help: 'The same shape as the allowed prefixes — filesystem paths, normalised, segment-aware, and no * — and it wins over them. “/etc” denies everything beneath /etc, so there is nothing a wildcard would add. Same reach: an argument whose entire value is an absolute path is checked on its own; one buried in a longer string needs a declared argument path or the undeclared scan.',
      },
      {
        kind: 'text',
        key: 'fsRoot',
        label: 'Filesystem root',
        group: 'Which files',
        // ADVANCED: it only matters for a RELATIVE path argument; the prefix
        // lists compare absolute, normalised paths without it.
        advanced: true,
        monospace: true,
        placeholder: '/workspace',
        help: 'What a relative path resolves against. Matching is on a normalised path, because a plain prefix test lets /workspace/../etc/shadow walk straight through an allowed prefix.',
      },
      {
        kind: 'key_list',
        key: 'pathArgPaths',
        label: 'Which arguments carry a file path',
        group: 'Which files',
        // ADVANCED, same as its url counterpart: the prefix lists already work
        // with nothing declared here.
        advanced: true,
        keyLabel: 'Tool',
        valueLabel: 'Argument paths',
        keyPlaceholder: 'agent.tool.files.read',
        valuePlaceholder: 'path',
        help: 'WHERE A FILE PATH LIVES, when it is not the whole argument — the counterpart of the url paths above. An argument whose entire value is an absolute path is found on its own, so the two prefix lists already work with nothing declared here. Declare a path when the value is relative, when it is embedded in a larger string, or when you want a malformed or out-of-root argument reported as its own finding rather than skipped.',
      },
      {
        kind: 'switch',
        key: 'scanUndeclaredStrings',
        // Renamed: "undeclared arguments" stopped being true the moment an
        // argument whose whole value is a url or a path was checked without
        // being declared. What is left behind this switch is text — a target
        // quoted inside a longer string, and the tool's result.
        label: 'Also scan inside prose and results',
        group: 'Which files',
        advanced: true,
        defaultValue: false,
        validate: scanWithNoLists,
        // "held to Flag", not "held to Warn": the scrape passes
        // `override: 'flag'`, which records a finding the caller is never told
        // about — a materially weaker outcome than Warn, and the difference
        // decides whether an operator can rely on this to catch anything.
        help: 'The old scrape, kept as a clamped fallback for BOTH the domain and the path lists. It looks for a target INSIDE a longer string — a url in an email body, a path in a sentence — and, at “After a tool”, inside the result the tool returned. An argument whose entire value is the target does not need this and is checked either way. Its findings are held to Flag whatever this policy’s action says, so they are recorded and never block, and they never trigger a DNS lookup: it cannot tell a url in an argument from one quoted in a paragraph. Use it to discover what to declare, not as the rule itself.',
      },
      {
        kind: 'json',
        key: 'argumentSchemas',
        label: 'Argument schemas',
        group: 'Argument shape',
        advanced: true,
        rows: 10,
        schemaHint:
          'An object keyed by tool name. Each value accepts type, required, properties, enum and additionalProperties — no $ref and no remote schemas.',
        help: 'Rejects a tool call whose arguments do not fit the shape you declared, before it runs.',
      },
      {
        kind: 'number',
        key: 'maxArgBytes',
        label: 'Largest arguments',
        group: 'Limits',
        min: 0,
        unit: 'bytes',
        zeroMeans: 'no limit',
        advanced: true,
      },
      {
        kind: 'number',
        key: 'maxResultBytes',
        label: 'Largest result',
        group: 'Limits',
        min: 0,
        unit: 'bytes',
        zeroMeans: 'no limit',
        advanced: true,
        help: 'Applied after a tool returns, before the model sees the result.',
      },
      {
        kind: 'number',
        key: 'maxArgDepth',
        label: 'Deepest nesting',
        group: 'Limits',
        min: 1,
        max: 32,
        step: 1,
        defaultValue: 32,
        advanced: true,
        help: 'JSON-bomb defence, and it keeps “hide the secret forty levels down” from being an evasion primitive against every other family — the subject builder stops walking at the same depth.',
      },
    ]),
    defaults: () => ({ ...base('tool_access') }),
    summarise: (policy) =>
      summary(
        [
          listLength(policy.allow) > 0 ? `${plural(listLength(policy.allow), 'tool')} allowed` : undefined,
          listLength(policy.deny) > 0 ? `${listLength(policy.deny)} denied` : undefined,
          mapSize(policy.allowedRoles) > 0 ? `${mapSize(policy.allowedRoles)} role-gated` : undefined,
          listLength(policy.allowedDomains) + listLength(policy.deniedDomains) > 0
            ? 'domain rules'
            : undefined,
          listLength(policy.allowedPathPrefixes) + listLength(policy.deniedPathPrefixes) > 0
            ? 'path rules'
            : undefined,
          mapSize(policy.argumentSchemas) > 0
            ? `${plural(mapSize(policy.argumentSchemas), 'argument schema')}`
            : undefined,
          policy.denyPrivateNetworks ? 'SSRF guard on' : undefined,
        ],
        'No restrictions yet — every tool is allowed.',
      ),
  },

  // ══ custom ═══════════════════════════════════════════════════════════════
  regex: {
    label: 'Regex',
    description:
      'Your own patterns. They report where they matched, so they can redact in place — and with a declared match bound they are the cheapest thing that can run on a live stream.',
    icon: 'regex',
    color: 'indigo',
    catalog: {
      group: 'custom',
      order: 10,
      keywords: ['regex', 'pattern', 'match', 'expression', 'redact', 'span', 'stream'],
    },
    needsFailMode: false,
    fields: fieldsFor<RegexPolicyConfig>([
      {
        kind: 'item_list',
        key: 'rules',
        label: 'Rules',
        // `required`, not `minItems: 1`: an empty list is already "nothing
        // here", and two ways to say one rule is one that eventually says
        // something else. `minItems` is for a floor above one.
        required: true,
        addLabel: 'Add a rule',
        itemTitle: (item, index) =>
          firstLine(item.label) || firstLine(item.id) || `Rule ${index + 1}`,
        newItem: (existing) => {
          // Ids appear on every finding, so a duplicate makes a finding
          // untraceable to the rule that raised it.
          const used = new Set(
            existing.map((item) => (typeof item.id === 'string' ? item.id : '')),
          );
          let index = existing.length + 1;
          while (used.has(`rule-${index}`)) index += 1;
          return {
            id: `rule-${index}`,
            label: '',
            pattern: '',
            category: 'custom',
            severity: 'medium',
            maxMatchChars: 64,
          } satisfies Partial<RegexRule> as PolicyFieldConfig;
        },
        itemFields: fieldsFor<RegexRule>([
          {
            kind: 'text',
            key: 'id',
            label: 'Id',
            required: true,
            monospace: true,
            // ADVANCED: `newItem` always supplies one, so it is identity rather
            // than configuration. Worth opening only to give a rule a stable
            // name in the finding stream before anything starts referencing it.
            advanced: true,
            help: 'Appears on every finding this rule raises. Stable, and never reused.',
          },
          { kind: 'text', key: 'label', label: 'Name', placeholder: 'Internal case number' },
          {
            kind: 'text',
            key: 'pattern',
            label: 'Pattern',
            required: true,
            monospace: true,
            placeholder: '\\bCASE-\\d{6}\\b',
            validate: (value, config) =>
              typeof value === 'string'
                ? validateRegexPattern(value, typeof config.flags === 'string' ? config.flags : undefined)
                : undefined,
          },
          {
            kind: 'text',
            key: 'flags',
            label: 'Flags',
            monospace: true,
            // ADVANCED: empty is right for almost every pattern.
            advanced: true,
            placeholder: 'i',
            validate: (value) => (typeof value === 'string' ? validateRegexFlags(value) : undefined),
          },
          {
            kind: 'text',
            key: 'category',
            label: 'Category',
            required: true,
            placeholder: 'case_number',
            help: 'Grouping shown on the finding and counted on the dashboard.',
          },
          { kind: 'select', key: 'severity', label: 'Severity', required: true, options: SEVERITY_OPTIONS },
          {
            kind: 'select',
            key: 'action',
            label: 'When this rule matches',
            // ADVANCED: an override of the policy's own action, which is the
            // basic control one level up. A rule that wants the same thing as
            // its policy — nearly all of them — leaves this alone.
            advanced: true,
            options: SAFETY_ACTION_OPTIONS,
            clearable: true,
            inheritLabel: 'Whatever the policy does',
          },
          {
            kind: 'number',
            key: 'captureGroup',
            label: 'Redact only this group',
            min: 0,
            step: 1,
            advanced: true,
            help: 'Rewrites one capture group instead of the whole match — the number in “account 4111 1111 1111 1111”, not the sentence.',
          },
          {
            kind: 'number',
            key: 'maxMatchChars',
            label: 'Longest possible match',
            required: true,
            min: 1,
            max: REGEX_MAX_MATCH_CHARS,
            step: 1,
            unit: 'characters',
            help: `Required, and capped at ${REGEX_MAX_MATCH_CHARS}. It is what sizes the streaming hold-back window: an unbounded rule would make the stream silently unenforceable wherever a match straddles a window edge.`,
          },
        ]),
      },
    ]),
    defaults: () => ({ ...base('regex'), rules: [] }),
    summarise: (policy) => {
      const rules = Array.isArray(policy.rules) ? policy.rules : [];
      if (rules.length === 0) return 'No rules yet, so this matches nothing.';
      // READ from the contract, not recomputed. This number is the streaming
      // hold-back window; a card that works it out for itself is a card that
      // will eventually call a policy stream-safe that the engine refuses to
      // bind, and the operator has no way to tell which one is lying.
      const longest = policyMaxMatchChars(policy);
      return summary(
        [
          plural(rules.length, 'rule'),
          longest > 0 ? `longest match ${longest} characters` : 'not stream-safe: a rule has no bound',
        ],
        plural(rules.length, 'rule'),
      );
    },
  },

  custom: {
    label: 'Custom rule',
    description:
      'A rule you write in prose, judged by an LLM. The catch-all for anything the deterministic families cannot express. Costs a model call.',
    icon: 'robot',
    color: 'teal',
    catalog: {
      group: 'custom',
      order: 20,
      keywords: ['custom', 'prompt', 'judge', 'llm', 'rule', 'policy', 'natural language'],
    },
    needsFailMode: true,
    fields: fieldsFor<CustomPolicyConfig>([
      {
        kind: 'reference',
        key: 'modelKey',
        resource: 'model',
        label: 'Model',
        required: true,
        help: 'The judge. An enabled policy with no model reads as active while nothing runs.',
        emptyHint: 'No models available on this project yet.',
      },
      {
        kind: 'textarea',
        key: 'prompt',
        label: 'The rule',
        required: true,
        rows: 8,
        placeholder:
          'Flag anything that promises a delivery date, a refund, or a discount the workspace has not published.',
        help: 'Write it as an instruction to a careful reviewer. Say what should be flagged, and say what should not — a rule with no counter-examples flags far more than you meant.',
      },
      {
        kind: 'select',
        key: 'onMissingModel',
        label: 'When there is no model',
        required: true,
        advanced: true,
        options: [
          { value: 'error_finding', label: 'Raise a finding', description: 'The honest answer: the rule did not run, and the verdict says so.' },
          { value: 'skip', label: 'Pass silently', description: 'The pre-hook behaviour, kept only for configurations carried over from it.' },
        ],
      },
    ]),
    defaults: () => ({ ...base('custom'), prompt: '', onMissingModel: 'error_finding' }),
    summarise: (policy) =>
      summary(
        [firstLine(policy.prompt), policy.modelKey ? `via ${policy.modelKey}` : 'no model chosen'],
        'No rule written yet.',
      ),
  },

  webhook: {
    label: 'Webhook',
    description:
      'Your own classifier, over https. It receives the hook call and answers with a verdict — the same contract the built-in families speak. The extension point.',
    icon: 'webhook',
    color: 'violet',
    catalog: {
      group: 'custom',
      order: 30,
      keywords: ['webhook', 'http', 'external', 'callback', 'integration', 'custom', 'classifier', 'hmac'],
    },
    needsFailMode: true,
    fields: fieldsFor<WebhookPolicyConfig>([
      {
        kind: 'text',
        key: 'url',
        label: 'Endpoint',
        required: true,
        monospace: true,
        placeholder: 'https://guardrails.example.com/evaluate',
        validate: validateHttpsUrl,
        help: 'Called with the hook call as its body. Outbound requests go through the SSRF-guarded fetch.',
      },
      {
        kind: 'select',
        key: 'send',
        label: 'What to send',
        required: true,
        options: [
          { value: 'text', label: 'The text only', description: 'The flattened subject. Keeps structured personal data off the wire.' },
          { value: 'subject', label: 'The whole subject', description: 'Segments, tool arguments and results. Everything the model was handed, not just the prose a classifier needs.' },
        ],
      },
      {
        kind: 'switch',
        key: 'redactBeforeSend',
        label: 'Apply redactions before sending',
        defaultValue: true,
        // ADVANCED: on by default, and the default is the safe one. Turning it
        // off is a deliberate decision to ship unredacted text to a third party.
        advanced: true,
        help: 'On by default, and the default is the security-relevant half: by the time a webhook runs, the deterministic families have already located the credentials and the personal data, and shipping the raw text to a third party after deciding it must be redacted is a leak the guardrail itself caused. Turn it off only for a receiver that has to see the original.',
      },
      // ── the two secret keys ──────────────────────────────────────────────
      // Both were declared `resource: 'provider'`, and `'provider'` in this
      // codebase means a MODEL HUB LLM PROVIDER. So the picker enumerated the
      // tenant's model providers: adding a webhook policy offered Azure,
      // OpenAI, Anthropic and Bedrock as its signing secret. Two things were
      // wrong with that, not one — the list was irrelevant AND choosing from it
      // resolved a MODEL credential on the guardrail path. A model credential
      // and a webhook signing secret must not share a box, which is what
      // `'secret'` exists to say.
      //
      // `freeText` because the console has no enumerable secret store yet: the
      // operator types the key, which is what the pre-catalog editor did for
      // both of these anyway. The stored value is unchanged, so nothing that is
      // configured today stops working — see the runtime note in
      // `families/webhook.ts` and the handover for the sealing half.
      {
        kind: 'reference',
        key: 'credentialProviderKey',
        resource: 'secret',
        freeText: true,
        label: 'Bearer token',
        placeholder: 'guardrail.webhook.bearer',
        help: 'The KEY of a stored credential, sent as an Authorization header. The secret itself is never stored on this policy — only this key, resolved at call time. Not a Model Hub provider: those hold model credentials.',
        emptyHint:
          'Type the key of the stored credential. There is no picker yet — model providers are deliberately not offered here.',
      },
      {
        kind: 'reference',
        key: 'signingSecretRef',
        resource: 'secret',
        freeText: true,
        label: 'Signing secret',
        advanced: true,
        placeholder: 'guardrail.webhook.hmac',
        help: 'The KEY of the stored HMAC secret. Signs the request as “timestamp.body” so your endpoint can verify it came from here and reject a replay. The secret itself never reaches this policy.',
        emptyHint:
          'Type the key of the stored secret. There is no picker yet — model providers are deliberately not offered here.',
      },
      {
        kind: 'key_value',
        key: 'headers',
        label: 'Extra headers',
        advanced: true,
        secretValues: true,
        keyPlaceholder: 'x-tenant-region',
        valuePlaceholder: 'eu-west',
        help: 'Sent verbatim. Put a token in the fields above instead — a value typed here is stored on the policy.',
      },
      {
        kind: 'select',
        key: 'retries',
        label: 'Retries',
        advanced: true,
        options: [
          { value: 0, label: 'None' },
          { value: 1, label: 'Once' },
          { value: 2, label: 'Twice' },
        ],
        clearable: true,
        inheritLabel: 'None (the default)',
        help: 'Retries share one budget with the first attempt, so raising this does not raise the time the caller waits.',
      },
    ]),
    defaults: () => ({ ...base('webhook'), url: '', send: 'text' }),
    summarise: (policy) =>
      summary(
        [
          hostOf(policy.url) ? `Asks ${hostOf(policy.url)}` : undefined,
          policy.send === 'subject' ? 'sends the whole subject' : 'sends the text only',
          policy.redactBeforeSend === false ? 'sends unredacted' : undefined,
          policy.signingSecretRef ? 'signed' : undefined,
        ],
        'No endpoint yet.',
      ),
  },
};

// ── assembly ────────────────────────────────────────────────────────────────

/**
 * Built by walking `POLICY_FAMILIES` — itself derived from a contract table —
 * so a family cannot appear in the engine and quietly stay out of the picker.
 *
 * Two layers guard that. `DEFINITIONS` is typed as a total record, so omitting
 * a family is a COMPILE error; and the assembly below skips a family it cannot
 * find rather than producing a spec full of `undefined`, so a definition lost
 * to a bad merge shows up as a missing card and a failing test instead of nine
 * screens throwing on a null label.
 */
const CATALOG = ((): Partial<Record<PolicyFamily, AnyPolicyFamilySpec>> => {
  const out: Partial<Record<PolicyFamily, AnyPolicyFamilySpec>> = {};
  for (const family of POLICY_FAMILIES) {
    const definition = Object.prototype.hasOwnProperty.call(DEFINITIONS, family)
      ? (DEFINITIONS as Partial<Record<PolicyFamily, PolicyFamilyDefinition<PolicyFamily>>>)[family]
      : undefined;
    if (!definition) continue;
    out[family] = Object.freeze({
      ...definition,
      family,
      blockReason: BLOCK_REASON_FOR_FAMILY[family],
      validHooks: POLICY_VALID_HOOKS[family] ?? [],
      streamSafe: STREAM_ELIGIBLE_FAMILIES.has(family),
    }) as AnyPolicyFamilySpec;
  }
  return Object.freeze(out);
})();

/** The catalog, keyed by family. `undefined` only for a family with no entry —
 *  which the unit test forbids. */
export const POLICY_CATALOG: Readonly<Partial<Record<PolicyFamily, AnyPolicyFamilySpec>>> = CATALOG;

/** Every family that the engine knows about but the catalog does not. Empty, and
 *  `guardrail-catalog.test.ts` fails the moment it is not. */
export function familiesMissingFromCatalog(): PolicyFamily[] {
  return POLICY_FAMILIES.filter((family) => CATALOG[family] === undefined);
}

export function catalogFor(family: PolicyFamily): AnyPolicyFamilySpec | undefined {
  return CATALOG[family];
}

/** Every entry, in catalog order: by group, then by the group's own order, then
 *  by label so a tie is at least stable. */
export const POLICY_CATALOG_GROUPS: readonly PolicyCatalogGroup[] = [
  'data',
  'content',
  'access',
  'custom',
];

export function catalogEntries(): AnyPolicyFamilySpec[] {
  const groupIndex = (group: PolicyCatalogGroup): number => {
    const index = POLICY_CATALOG_GROUPS.indexOf(group);
    return index === -1 ? POLICY_CATALOG_GROUPS.length : index;
  };
  return POLICY_FAMILIES.map((family) => CATALOG[family])
    .filter((spec): spec is AnyPolicyFamilySpec => spec !== undefined)
    .sort(
      (a, b) =>
        groupIndex(a.catalog.group) - groupIndex(b.catalog.group) ||
        a.catalog.order - b.catalog.order ||
        a.label.localeCompare(b.label),
    );
}

/** Catalog entries under one group, in order. */
export function catalogGroup(group: PolicyCatalogGroup): AnyPolicyFamilySpec[] {
  return catalogEntries().filter((spec) => spec.catalog.group === group);
}

/**
 * Free-text search over the picker. Matches the label, the description and the
 * keywords, so "gdpr" finds the PII family and "jailbreak" finds the shield.
 */
export function searchCatalog(query: string): AnyPolicyFamilySpec[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return catalogEntries();
  return catalogEntries().filter(
    (spec) =>
      spec.label.toLowerCase().includes(needle) ||
      spec.family.includes(needle) ||
      spec.description.toLowerCase().includes(needle) ||
      spec.catalog.keywords.some((keyword) => keyword.includes(needle)),
  );
}

/**
 * A fresh policy of this family.
 *
 * ONE cast, and it is sound: `defaults` is declared against its own family's
 * config, which is not mutually assignable with the union, and the `family`
 * discriminant is what the lookup used. The alternative is a nine-arm switch in
 * every caller, which is what this file exists to delete.
 */
export function defaultPolicy(family: PolicyFamily): GuardrailPolicy | undefined {
  const spec = CATALOG[family];
  return spec ? (spec.defaults() as GuardrailPolicy) : undefined;
}

/** The card's one-line summary of a configured policy. Same cast, same reason. */
export function summarisePolicy(policy: GuardrailPolicy): string {
  const spec = CATALOG[policy.family];
  if (!spec) return '';
  return (spec.summarise as (value: GuardrailPolicy) => string)(policy);
}

/** The fields of one family, or an empty list for a family with no entry — so a
 *  renderer degrades to "no controls" rather than throwing. */
export function fieldsOf(family: PolicyFamily): readonly PolicyFieldSpec[] {
  return CATALOG[family]?.fields ?? [];
}

/**
 * Whether an enabled policy of this family needs a model, DERIVED from the
 * fields rather than restated: a family whose model reference is required is
 * one the server will refuse to save without a model.
 */
export function familyNeedsModel(family: PolicyFamily): boolean {
  return fieldsOf(family).some(
    (field) => field.kind === 'reference' && field.resource === 'model' && field.required === true,
  );
}

/**
 * Whether "if it cannot run" is a real question for this family — the
 * `needsFailMode` row, read rather than restated.
 *
 * It exists as a function because `COMMON_POLICY_FIELDS` uses it as the
 * `failMode` control's own `visibleWhen`, so the conditionality is DATA the
 * catalog carries instead of a rule each screen has to remember. A regex, a
 * word list and the secret patterns run in memory on a string: offering them a
 * failure mode is a control for a state that cannot occur.
 *
 * UNKNOWN FAMILY -> true, deliberately. A policy authored by a newer console
 * should show its stored setting rather than have it quietly hidden.
 */
export function familyNeedsFailMode(family: PolicyFamily): boolean {
  return catalogFor(family)?.needsFailMode ?? true;
}

/** The closed variable set a block-message template may use. Re-exported so a
 *  message field's `templateVars` and the editor's chip list are one list. */
export const POLICY_MESSAGE_VARS: readonly string[] = BLOCK_MESSAGE_VARS;

// ── the fields every policy has ─────────────────────────────────────────────

/**
 * `GuardrailPolicyBase`, described in the same language as the family configs,
 * so the common half of the form renders from the catalog too.
 *
 * ── THE BASIC FOUR ──────────────────────────────────────────────────────────
 * Three of them are here — a NAME, WHERE IT RUNS, and WHAT A FINDING DOES — and
 * the fourth is the family's own basic fields. Everything else on this list is
 * `advanced`, and each one says below which of the four advanced kinds it is.
 * That is the whole simplification: an operator adding a policy answers four
 * questions, and the twelve other stored fields keep their exact meanings
 * behind one disclosure.
 *
 * `hooks` is here as the ONE multi-select, and with a caveat: which options are
 * SELECTABLE depends on the family, the policy's own configuration and the
 * guardrail's bindings, and that rule (`canBindToHook`) lives with the hooks
 * matrix. A second copy of it here is exactly the drift this catalog exists to
 * remove, so the options are listed and the eligibility is not. Their labels
 * are the hook ids verbatim for the same reason: the matrix has prose for each
 * one, and two sets of hook copy is two sets to keep true.
 *
 * ── WHY `schedule` IS STILL NOT HERE ────────────────────────────────────────
 * It is now ONE control on screen — `GuardrailEnforcement`, three values,
 * replacing the pair of selects that advertised a fourth combination the type
 * forbids. It is still not a FIELD SPEC, because a field spec binds a control
 * to a stored property of the same shape and this one does not have one: the
 * screen value is a string, the stored value is `{ timing, onFail }`. Declaring
 * `key: 'schedule'` as a select would write the string straight over the object
 * — and `validateShape` would then call every already-stored schedule "not one
 * of the available choices". `toEnforcement` / `fromEnforcement` in
 * `hooks/contract` are the mapping instead, and the hooks matrix owns the
 * control because a schedule is set on the BINDING and pushed down onto the
 * policies bound to it.
 */
export const COMMON_POLICY_FIELDS: readonly PolicyFieldSpec[] = fieldsFor<
  PolicyBase<PolicyFamily>
>([
  {
    kind: 'text',
    key: 'label',
    label: 'Name',
    placeholder: 'What this policy is for',
    help: 'Shown wherever this policy appears. Its id is what findings reference.',
  },
  {
    kind: 'multi_select',
    key: 'hooks',
    label: 'Where it runs',
    required: true,
    options: HOOK_IDS.map((hook) => ({ value: hook, label: hook })),
    help: 'A policy bound to no hook can never run. Which hooks are available depends on the family and on how this policy is configured.',
  },
  {
    // THE basic action control, and the only place an operator is asked what a
    // finding does. Block / Redact / Flag lead; 'warn' and 'allow' are the two
    // advanced rungs of the same stored ladder — see `SAFETY_ACTION_OPTIONS`.
    kind: 'select',
    key: 'action',
    label: 'When it finds something',
    options: SAFETY_ACTION_OPTIONS,
    clearable: true,
    // The guardrail-level default action is no longer AUTHORED anywhere: the
    // `action` column is projected from these policies on save, for the readers
    // that still enforce from it. So "inherit" now means "whatever the rest of
    // this guardrail does", not "a number somebody typed on the other tab".
    inheritLabel: 'Whatever the rest of this guardrail does',
    help: 'What happens when THIS policy finds something. Block stops the request, Redact rewrites the match and lets the rest through, Flag records it and changes nothing.',
  },
  {
    kind: 'switch',
    key: 'enabled',
    label: 'Enabled',
    defaultValue: true,
    // ADVANCED because it is not a decision the FORM owns: a policy is switched
    // on and off from its card, in one click, without opening anything. It is
    // still here so a half-built policy can be parked from inside the drawer.
    advanced: true,
    help: 'A disabled policy keeps its configuration and is not validated, so a half-built one can be parked here rather than deleted.',
  },
  {
    kind: 'select',
    key: 'failMode',
    label: 'If it cannot run',
    options: [
      { value: 'closed', label: 'Block it', description: 'Safer, and it makes an outage visible.' },
      { value: 'open', label: 'Let the content through', description: 'Available, and it makes an outage silent.' },
    ],
    clearable: true,
    inheritLabel: 'Follow the guardrail’s setting',
    // ADVANCED (an override of an inherited value), and CONDITIONAL: shown only
    // for a family whose policy can actually fail to run. A regex and a word
    // list scan a string in memory — a failure mode for them is a control for a
    // state that does not occur. The rule is the catalog's `needsFailMode` row,
    // read here so no screen has to remember it.
    advanced: true,
    visibleWhen: (config) =>
      typeof config.family === 'string'
        ? familyNeedsFailMode(config.family as PolicyFamily)
        : true,
    help: 'What happens when the policy itself is unavailable — a model outage, a webhook timeout — as opposed to when it finds something. Per policy, so one flaky model judge does not take a deterministic scan down with it.',
  },
  {
    kind: 'number',
    key: 'timeoutMs',
    label: 'Time limit',
    min: 0,
    step: 50,
    unit: 'ms',
    zeroMeans: 'no limit',
    advanced: true,
    help: 'How long this policy may take before “if it cannot run” decides. The hook’s own budget still caps it.',
  },
  {
    kind: 'select',
    key: 'runIf',
    label: 'Only run when',
    advanced: true,
    options: [
      { value: 'always', label: 'Every time' },
      { value: 'onFinding', label: 'Something cheaper has already found something', description: 'Runs only once a deterministic policy has raised a finding.' },
      { value: 'onSideEffect', label: 'The tool has side effects', description: 'Includes an unclassified tool — an unknown tool is itself the signal.' },
    ],
    clearable: true,
    inheritLabel: 'Every time',
    help: 'The single biggest cost lever here. Read only by the families that call a model; the deterministic ones cost a pass over a string, so gating them would only add a way to switch them off by accident.',
  },
  {
    kind: 'textarea',
    key: 'message',
    label: 'Block message',
    rows: 4,
    templateVars: BLOCK_MESSAGE_VARS,
    // ADVANCED (an override of an inherited value): the wording every policy
    // sharing this reason gets is set once on the Messages tab, and this
    // replaces it for this policy alone.
    advanced: true,
    help: 'What someone is told when THIS policy blocks something. Leave it empty to inherit the message set for its reason on the Messages tab.',
  },
]);
