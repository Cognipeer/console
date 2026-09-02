/**
 * ONE description of what each policy family is, and one answer to "can this
 * policy run at this hook?".
 *
 * Every guardrail screen needs the same four facts about a family — what to
 * call it, what it does in one line, which hooks it may bind to, and whether
 * it can survive the streaming gate — and until now each screen carried its own
 * copy. Two copies of "word_filter cannot stream" is one copy that will
 * eventually say it can, and a family list that falls behind `PolicyFamily` is a
 * family an operator cannot reach at all (which is exactly the missing
 * regex/webhook/secrets/tool_access gap this wave closes).
 *
 * So: the colours, icons and compact `short` forms are declared here; everything
 * that is ALREADY a fact somewhere else — `POLICY_VALID_HOOKS`,
 * `STREAM_ELIGIBLE_FAMILIES`, `policyMaxMatchChars` from the contract, and the
 * family `label` from the CATALOG — is READ rather than restated, so a change
 * there reaches these screens without anyone remembering to mirror it.
 *
 * `label` joined that list after the two copies were found to have already
 * drifted; see the note on `PolicyFamilyMeta.label`. The rest of this table
 * still duplicates the catalog's display half and should eventually be deleted
 * in favour of it — `short`, `icon` (a React component, which the catalog
 * deliberately does not hold) and the hook helpers are what would remain.
 *
 * ── WHAT THIS FILE MAY NOT IMPORT ────────────────────────────────────────────
 * `hooks/contract` only, exactly like `GuardrailHooksMatrix`. `hooks/legacy`
 * (which owns the authoritative `validateGuardrailHooks`) and `hooks/engine`
 * both import the `@/lib/database` barrel, which constructs providers on load;
 * pulling either into a client bundle is a build failure.
 *
 * This module has no JSX and no React state, so it is importable from a plain
 * unit test.
 */

import {
  IconAlertOctagon,
  IconFilterX,
  IconFingerprint,
  IconKey,
  IconRegex,
  IconRobot,
  IconShieldLock,
  IconTool,
  IconWebhook,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import {
  POLICY_FAMILIES,
  POLICY_VALID_HOOKS,
  HOOK_IDS,
  STREAM_ELIGIBLE_FAMILIES,
  policyMaxMatchChars,
} from '@/lib/services/guardrail/hooks/contract';
import type { PolicyFamily, GuardrailPolicy, HookId } from '@/lib/services/guardrail/hooks/contract';
import { catalogFor } from '@/lib/services/guardrail/catalog';

export { POLICY_FAMILIES, HOOK_IDS };

// ── hooks ───────────────────────────────────────────────────────────────────

export interface HookMeta {
  /** Written from the emitter's point of view — an operator ticking a hook is
   *  asking "when does this fire?", not "what is its identifier?". */
  label: string;
  /** The hook id itself. It is what the API, the logs and the findings use, so
   *  it is shown verbatim rather than hidden behind a friendly name. */
  short: string;
  description: string;
}

export const HOOK_META: Readonly<Record<HookId, HookMeta>> = {
  // First, matching HOOK_IDS' pipeline order. The description leads with the
  // difference from `input.pre` because that is the only thing an operator can
  // get wrong here, and getting it wrong is expensive: the two read almost
  // identically in a checkbox list, but one fires once and the other fires on
  // every model call of the run. The second sentence says who emits it — no
  // console surface does, so a prompt.pre binding on a model or an agent is
  // inert until a remote enforcement point calls the evaluate route.
  'prompt.pre': {
    label: 'On the user turn, once per run',
    short: 'prompt.pre',
    description:
      'Runs once on what the person actually typed, at the start of a run. Not the same as input.pre, which fires again before every model call — after a tool round trip the newest message there is a tool result, not a human one. Emitted by a remote enforcement point (an SDK, via the hook evaluate API); nothing inside the console emits it yet.',
  },
  'input.pre': {
    label: 'Before every model call',
    short: 'input.pre',
    description:
      'Runs on the prompt and conversation history before anything is sent to the model, and again before each further call in an agent run. The cheapest place to stop something, and the only one where blocking costs no tokens.',
  },
  'output.pre': {
    label: 'Before the answer reaches the caller',
    short: 'output.pre',
    description:
      'Runs on the complete answer. For a streamed response this is the post-hoc audit — the text has already reached the client by then, which is what the streaming hook exists to fix.',
  },
  'output.stream.delta': {
    label: 'While the answer is streaming',
    short: 'output.stream.delta',
    description:
      'Holds text back behind a release frontier, adjudicates it, and only then writes it to the socket. Real-time enforcement, and the only hook that costs the caller latency.',
  },
  'tool.pre': {
    label: 'Before a tool runs',
    short: 'tool.pre',
    description:
      'Runs on the tool name and its arguments. This is where a tool call is denied, an argument is redacted, or a destructive side effect is stopped.',
  },
  'tool.post': {
    label: 'After a tool returns',
    short: 'tool.post',
    description:
      'Runs on the tool result before the model sees it. Catches secrets and personal data pulled in from a file, an API or a page.',
  },
};

// ── families ────────────────────────────────────────────────────────────────

export interface PolicyFamilyMeta {
  family: PolicyFamily;
  /**
   * From the CATALOG (`catalogFor(family).label`) — never restated here, for
   * the same reason `validHooks` and `streamSafe` are not.
   *
   * It used to be authored in `META` as well, and the two copies had already
   * drifted on two of the nine families: the catalog called `pii` "Personal
   * data" and `secrets` "Credentials", this table called them "PII" and
   * "Secrets". Since the cards, the "Add policy" catalog and the block-message
   * layer read the first and the hooks matrix and the drawer's own header read
   * the second, ONE policy drawer called the same family "PII policy" in its
   * title and "Personal data" in its Error message block. Reading the one
   * string makes that class of divergence unrepresentable rather than a thing
   * somebody has to notice.
   */
  label: string;
  /** For a narrow column or a chip. Deliberately still authored here: it is the
   *  compact form ("PII", "Words") that a grid cell needs, and the catalog has
   *  no equivalent. */
  short: string;
  /** ONE line, written for the "add a policy" family picker: what it detects,
   *  and what it costs. */
  description: string;
  icon: Icon;
  /** Mantine colour token. */
  color: string;
  /** From `POLICY_VALID_HOOKS` — never restated. */
  validHooks: readonly HookId[];
  /** From `STREAM_ELIGIBLE_FAMILIES`. Necessary, not sufficient: a stream-safe
   *  family still needs a bounded match length from its own config, which is
   *  what `canBindToHook` policies. */
  streamSafe: boolean;
  /** An enabled policy of this family with no `modelKey` reads as active while
   *  nothing runs — the server rejects it. */
  needsModel: boolean;
  /**
   * Whether `failMode` is a real question for this family.
   *
   * It answers "the policy could not RUN" — a model outage, a webhook timeout, a
   * PII policy read that failed — which only the families that reach out of the
   * process can experience. A regex, a word list and the secret patterns run in
   * memory on a string: offering them a failure mode is a control for a state
   * that does not occur, which is noise at best and false comfort at worst.
   *
   * `tool_access` is the one debatable row, and it is deliberately FALSE:
   * `families/toolAccess.ts` can emit a degraded entry (an argument nested past
   * `maxArgDepth`, a DNS lookup that fails while `denyPrivateNetworks` is on),
   * so a per-policy failure mode would not be meaningless there. It is left off
   * because the two cases are rare and narrow, and the guardrail-level
   * `failMode` still covers them — the editor says so in place of the control.
   * Flipping this one boolean is all it takes to surface it.
   */
  needsFailMode: boolean;
}

const META: Readonly<Record<PolicyFamily, Omit<PolicyFamilyMeta, 'family' | 'label' | 'validHooks' | 'streamSafe'>>> = {
  pii: {
    short: 'PII',
    description:
      'Personal data, scanned through a PII policy. Categories, languages, checksums and mask strategies live on the policy, not here.',
    icon: IconFingerprint,
    color: 'blue',
    needsModel: false,
    // The policy read is a database round trip, and it can fail.
    needsFailMode: true,
  },
  secrets: {
    short: 'Secrets',
    description:
      'API keys, tokens and private keys — vendor patterns plus an optional high-entropy heuristic. No database, no model.',
    icon: IconKey,
    color: 'yellow',
    needsModel: false,
    needsFailMode: false,
  },
  word_filter: {
    short: 'Words',
    description:
      'Word lists and phrases, matched after normalisation so leetspeak and s p a c e d out evasion still hit.',
    icon: IconFilterX,
    color: 'grape',
    needsModel: false,
    needsFailMode: false,
  },
  regex: {
    short: 'Regex',
    description:
      'Your own patterns. They produce spans, so they can redact in place — and with a declared match bound they can run on a stream.',
    icon: IconRegex,
    color: 'indigo',
    needsModel: false,
    needsFailMode: false,
  },
  moderation: {
    short: 'Moder.',
    description: 'LLM classifier for harmful and policy-violating content, across the OpenAI category set.',
    icon: IconAlertOctagon,
    color: 'red',
    needsModel: true,
    needsFailMode: true,
  },
  prompt_shield: {
    short: 'Shield',
    description: 'LLM detection of prompt injection and jailbreak attempts.',
    icon: IconShieldLock,
    color: 'orange',
    needsModel: true,
    needsFailMode: true,
  },
  custom: {
    short: 'Custom',
    description: 'A rule you write in prose, judged by an LLM.',
    icon: IconRobot,
    color: 'teal',
    needsModel: true,
    needsFailMode: true,
  },
  tool_access: {
    short: 'Tool',
    description:
      'Tool allow/deny lists, roles, side-effect classes, domains, filesystem paths and argument schemas. Only meaningful on the two tool hooks.',
    icon: IconTool,
    color: 'cyan',
    needsModel: false,
    needsFailMode: false,
  },
  webhook: {
    short: 'Hook',
    description:
      'Your own classifier over https. It receives the hook call and answers with a verdict — the same contract the built-in policies use.',
    icon: IconWebhook,
    color: 'violet',
    needsModel: false,
    needsFailMode: true,
  },
};

/**
 * Built by walking `POLICY_FAMILIES` — which is itself derived from a contract
 * table — so a tenth family cannot appear in the engine and quietly stay out of
 * the picker: `META` is typed by the same union, so omitting a row is a
 * compile error rather than a card that renders blank.
 */
export const POLICY_FAMILY_META: Readonly<Record<PolicyFamily, PolicyFamilyMeta>> = Object.freeze(
  Object.fromEntries(
    POLICY_FAMILIES.map((family) => {
      const meta = META[family];
      return [
        family,
        {
          ...meta,
          family,
          // Falls back to the raw family id for a family the catalog cannot
          // resolve — the same degradation `familyLabel` documents, and the
          // only string that still lets an operator recognise the policy.
          label: catalogFor(family)?.label ?? family,
          validHooks: POLICY_VALID_HOOKS[family],
          streamSafe: STREAM_ELIGIBLE_FAMILIES.has(family),
        } satisfies PolicyFamilyMeta,
      ];
    }),
  ) as Record<PolicyFamily, PolicyFamilyMeta>,
);

/** The picker's order: cheap and deterministic first, then the ones that cost a
 *  model call or a network hop. It is the order an operator should consider
 *  them in, not alphabetical. */
export const FAMILY_PICKER_ORDER: readonly PolicyFamily[] = [
  'pii',
  'secrets',
  'regex',
  'word_filter',
  'tool_access',
  'moderation',
  'prompt_shield',
  'custom',
  'webhook',
];

/**
 * The metadata for a family, or `undefined` for one THIS BUILD HAS NEVER HEARD
 * OF.
 *
 * The optional return type is the whole point. `POLICY_FAMILY_META` is a total
 * record over the `PolicyFamily` union, so TypeScript believes an index into it
 * always hits — but the union is a compile-time fact and the families arriving
 * here are a RUNTIME one. A policy authored by a newer console, replayed from
 * an evaluation-log row, or left behind by a family that was removed all carry
 * a `family` string this build cannot resolve, and the record answers
 * `undefined` while the old signature promised it could not.
 *
 * That promise was load-bearing in the worst way: every caller dereferenced the
 * result, so ONE such policy threw `Cannot read properties of undefined` out of
 * `canBindToHook` and took the whole card grid down — leaving an operator with
 * no way to even READ the guardrail, let alone remove the policy causing it.
 *
 * `catalogFor`/`fieldsOf` already degrade for exactly this case. This module is
 * now consistent with them: it answers `undefined`, and the compiler makes
 * every caller say what it does about that.
 */
export function familyMeta(family: PolicyFamily): PolicyFamilyMeta | undefined {
  return POLICY_FAMILY_META[family];
}

/**
 * A family's display label, degrading to the raw family id.
 *
 * The id is a poor label but a TRUE one, and it is the only thing that lets an
 * operator recognise the policy they need to delete. Every display site goes
 * through here so none of them has to decide that separately.
 */
export function familyLabel(family: PolicyFamily): string {
  return familyMeta(family)?.label ?? family;
}

/** The label a policy shows in a list: its own name, falling back to the family
 *  plus its id — never an empty cell, which reads as a broken row. */
export function policyDisplayName(policy: GuardrailPolicy): string {
  const label = policy.label?.trim();
  if (label) return label;
  return policy.id
    ? `${familyLabel(policy.family)} · ${policy.id}`
    : familyLabel(policy.family);
}

// ── hook eligibility ────────────────────────────────────────────────────────

export interface HookEligibility {
  ok: boolean;
  /**
   * Why not. NEVER absent when `ok` is false: a greyed-out toggle with no
   * explanation is indistinguishable from a broken screen, and the reasons here
   * are all real engineering constraints an operator can act on (bind it
   * somewhere else, declare a bound, turn the obfuscation pass off).
   */
  reason?: string;
}

const OK: HookEligibility = { ok: true };

/**
 * Can this FAMILY ever run at this hook, ignoring how a particular policy is
 * configured? Used by the family picker, which has no policy to inspect yet.
 */
export function familySupportsHook(family: PolicyFamily, hook: HookId): HookEligibility {
  const meta = familyMeta(family);

  // A family this build cannot resolve. Answered FIRST and truthfully: we do
  // not know what it inspects, so we cannot claim it fits this hook — and the
  // reasons below would all be inventions about a family we have never seen.
  // Ineligible-with-a-reason keeps the screen up, which is what lets an
  // operator find the policy and remove it; the old dereference here took the
  // whole grid down instead.
  if (!meta) {
    return {
      ok: false,
      reason: `“${family}” is not a policy family this build knows, so where it can run cannot be determined. It was most likely authored by a newer version of the console.`,
    };
  }

  // Checked BEFORE the generic valid-hooks test, because "not in the list" is a
  // true but useless answer for the streaming hook: the interesting fact is WHY
  // a folding detector can never be made correct there.
  if (hook === 'output.stream.delta' && !meta.streamSafe) {
    return {
      ok: false,
      reason:
        family === 'word_filter'
          ? 'The word filter normalises before it matches (case, diacritics, leetspeak, spacing), which changes the text length and joins non-adjacent characters. Its match has no bounded length in raw characters, so no hold-back window can guarantee a match cannot straddle the release frontier. It still runs at output.pre, on the finished answer.'
          : `${meta.label} returns a verdict on the whole text rather than a located match, so there is nothing to hold back and nothing to redact in place. It still runs at output.pre, on the finished answer.`,
    };
  }

  if (!meta.validHooks.includes(hook)) {
    return {
      ok: false,
      reason: `${meta.label} has no subject to work on at ${HOOK_META[hook].short}.`,
    };
  }

  return OK;
}

/**
 * Can THIS policy, as it is configured right now, bind to this hook?
 *
 * The second half is the half that matters. A stream-safe family is not enough:
 * the hold-back window is sized from `policyMaxMatchChars`, and a policy that
 * returns 0 there — a regex rule with no declared bound, a PII policy still
 * running its obfuscation pass — cannot be made correct by ANY window size.
 * Binding one anyway produces a config the server refuses to save.
 */
export function canBindToHook(policy: GuardrailPolicy, hook: HookId): HookEligibility {
  const family = familySupportsHook(policy.family, hook);
  if (!family.ok) return family;
  if (hook !== 'output.stream.delta') return OK;

  if (policyMaxMatchChars(policy) > 0) return OK;

  return {
    ok: false,
    reason:
      policy.family === 'pii'
        ? 'Turn the obfuscation pass off to bind this to the stream. That pass scans an NFKC-normalised, de-obfuscated copy whose length differs from the raw text, so its matches have no raw-character bound to size the hold-back window from.'
        : policy.family === 'regex'
          ? 'Every rule must declare a match-length bound (maxMatchChars) before this can run on a stream — one unbounded rule is enough to break the hold-back guarantee.'
          : `${familyLabel(policy.family)} declares no bounded match length, so no hold-back window can make it correct on a stream.`,
  };
}

/** The hooks this policy is bound to that it can actually serve — what a row
 *  should show as "where it runs". */
export function boundHooks(policy: GuardrailPolicy): HookId[] {
  return HOOK_IDS.filter((hook) => (policy.hooks ?? []).includes(hook));
}
