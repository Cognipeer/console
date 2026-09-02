'use client';

/**
 * The hook plane, as a grid — rows are hook points, columns are POLICY
 * INSTANCES.
 *
 * ── WHY INSTANCES AND NOT FAMILIES ────────────────────────────────────────
 * This grid used to draw one column per family. That collapsed every regex
 * policy into a single column, so the one configuration an operator most needs
 * to read — "the SQL-injection patterns run on tool arguments, the internal-URL
 * patterns run on the answer" — was literally unrepresentable: two policies, two
 * different hook sets, one tick box. `GuardrailPolicy.hooks` has always been
 * per-policy, so the family grid was a lossy projection of the stored shape.
 *
 * With a column per policy the two defects this grid exists to expose stay
 * visible and gain a third:
 *   · a policy bound to a hook it cannot serve             → an em-dash cell
 *   · an enabled policy on a hook whose binding is off     → an issue + a dim row
 *   · two policies of one family that run in different places → two columns
 *
 * ── WHAT THIS COMPONENT MAY NOT IMPORT ────────────────────────────────────
 * `hooks/contract` only. It is the leaf of the hook plane: type-only imports
 * plus pure constants, no database, no agent SDK. `hooks/legacy` (which owns
 * the authoritative `validateGuardrailHooks`) and `hooks/engine` both import
 * the `@/lib/database` barrel, which constructs providers on load — pulling
 * either into a client bundle would be a build failure at best. The local
 * `describeIssues()` below therefore duplicates a SUBSET of the server's
 * validation on purpose; the server stays authoritative and its message is
 * what an operator sees if the two ever disagree.
 *
 * ── WHAT THIS SCREEN DOES NOT EDIT ────────────────────────────────────────
 * A policy's own configuration — its rules, its policy, its model, its prompt,
 * its endpoint — belongs to the Policies tab. This screen edits exactly two
 * things: WHERE a policy runs, and how the hook it runs on is scheduled. A
 * column header and the `Open` button on the detail panel emit `onOpenPolicy`
 * so the page can route there; duplicating those editors in two places is how
 * the two screens drift apart and how an operator ends up not knowing which
 * one won.
 *
 * ── THE BINDING/CELL COUPLING ─────────────────────────────────────────────
 * `validateGuardrailHooks` rejects an enabled policy whose hook has no enabled
 * binding. Rather than let an operator author that state and then refuse to
 * save it, the two are coupled here: turning a cell on enables its binding,
 * and turning a binding off clears that hook from every policy. The illegal
 * state is unreachable instead of merely rejected — the same principle
 * `HookSchedule` applies to `{ timing: 'async', onFail: 'block' }`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Menu,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconInfoCircle,
  IconLayoutGrid,
  IconPlus,
} from '@tabler/icons-react';
import {
  POLICY_VALID_HOOKS,
  DEFAULT_STREAM_SETTINGS,
  GUARDRAIL_CONTRACT_VERSION,
  GUARDRAIL_ENFORCEMENTS,
  HOOK_IDS,
  REGEX_MAX_MATCH_CHARS,
  STREAM_ELIGIBLE_FAMILIES,
  fromEnforcement,
  policyMaxMatchChars,
  toEnforcement,
} from '@/lib/services/guardrail/hooks/contract';
// The one home for the three enforcement words and the three mode words.
import { ENFORCEMENT_VOCABULARY, MODE_VOCABULARY } from './guardrailVocabulary';
import type {
  PolicyFamily,
  GuardrailEnforcement,
  GuardrailPolicy,
  GuardrailHooksConfig,
  GuardrailMode,
  HookBinding,
  HookId,
  HookSchedule,
  StreamGuardSettings,
} from '@/lib/services/guardrail/hooks/contract';
import { WORD_FILTER_BUILTIN_LISTS } from '@/lib/services/guardrail/constants';
// The family/hook vocabulary is SHARED with the Policies tab rather than restated
// here. Two copies of "word_filter cannot stream" is one copy that will
// eventually say it can.
import { HOOK_META, canBindToHook, familyLabel, policyDisplayName, familyMeta } from './policyFamilyMeta';

// A column header IS a policy's display name, so this module re-exports the
// shared one rather than defining a second: the grid and the policy list cannot
// then disagree about what a policy is called. Everything else about a family —
// `POLICY_FAMILY_META`, the picker order, the icons — is imported from
// `./policyFamilyMeta` directly by whoever needs it; re-exporting it here would
// only create a second import path for one constant.
export { policyDisplayName };

// ── vocabulary ────────────────────────────────────────────────────────────

const SYNC_BLOCK: HookSchedule = { timing: 'sync', onFail: 'block' };

const STREAM_HOOK: HookId = 'output.stream.delta';

/** Families whose findings come from a model, and therefore the only ones a
 *  `runIf` gate can save money on. Mirrors the union `resolveRunIf` accepts. */
const LLM_FAMILIES: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>([
  'moderation',
  'prompt_shield',
  'custom',
]);

/** Derived from the declared field, so a rename in `GuardrailPolicyBase` is a
 *  compile error here rather than a matrix that writes a key nothing reads. */
type PolicyRunIf = NonNullable<GuardrailPolicy['runIf']>;

const RUN_IF_OPTIONS = [
  { value: 'always', label: 'Always — a model call on every request' },
  { value: 'onFinding', label: 'Only after a deterministic finding' },
  { value: 'onSideEffect', label: 'Only for destructive or external tool calls' },
];

// ── the one enforcement control ───────────────────────────────────────────
/**
 * ONE COLUMN WHERE THERE WERE TWO.
 *
 * This grid used to carry a `Timing` select and an `On failure` select side by
 * side, which advertised four combinations for a type that has three: the
 * fourth cell was rendered and then greyed out with `disabled={… timing ===
 * 'async'}`, so the screen's own answer to "why can't I pick that?" was a
 * disabled control. An async check has already let the response go; there is
 * nothing left for it to stop.
 *
 * STORED FIELDS THIS CONTROL WRITES — nothing else, and nothing new:
 *   'block'           → schedule = { timing: 'sync',  onFail: 'block' }
 *   'observe'         → schedule = { timing: 'sync',  onFail: 'log'   }
 *   'observe_no_wait' → schedule = { timing: 'async', onFail: 'log'   }
 * on `GuardrailHookBinding.schedule`, and — through `setHookSchedule` — on the
 * `schedule` of every policy bound to that hook. `toEnforcement` reads it back;
 * both live in `hooks/contract` so this screen and the drawer cannot disagree.
 *
 * The words are the guardrail's own vocabulary one scope smaller: OBSERVE here
 * is what MONITOR is for the whole guardrail — everything runs, everything is
 * recorded, no decision is acted on. `timing` and `onFail` are not words an
 * operator needs any more.
 *
 * The copy itself lives in `./guardrailVocabulary`, which is the single home
 * for these three words — this grid, the policy drawer, the policy cards, the
 * detail page and the list all render the same table, so the same choice can no
 * longer be offered in two phrasings on two tabs of one feature.
 */

/**
 * The column-header tooltip's copy: every value with the sentence that says
 * what it does.
 *
 * NOT EXPORTED, deliberately. It used to be, at the name `ENFORCEMENT_OPTIONS`,
 * so the policy cards could import a label table through this 90KB client
 * component — and the drawer exports a DIFFERENT array under the same name
 * whose `label` is the long register, which is exactly the collision
 * `guardrailVocabulary`'s header describes. The cards now call
 * `enforcementSummaryLabel` from that file; anything else that needs these
 * three words should read `ENFORCEMENT_VOCABULARY` and pick its own register.
 */
const ENFORCEMENT_TOOLTIP_ROWS: ReadonlyArray<{
  value: GuardrailEnforcement;
  label: string;
  description: string;
}> = ENFORCEMENT_VOCABULARY.map(({ value, short, description }) => ({
  value,
  label: short,
  description,
}));

/** Mantine `data` for a narrow control: the compact label. */
const ENFORCEMENT_DATA = ENFORCEMENT_VOCABULARY.map(({ value, short }) => ({
  value,
  label: short,
}));
/** …and for one with room to say what it does. */
const ENFORCEMENT_DATA_LONG = ENFORCEMENT_VOCABULARY.map(({ value, long }) => ({
  value,
  label: long,
}));

/** Reads a Mantine `string | null` back as the union without widening the
 *  stored shape: an unrecognised value falls to 'block', the same direction
 *  `fromEnforcement`'s own default takes. */
function asEnforcement(value: string | null): GuardrailEnforcement {
  return GUARDRAIL_ENFORCEMENTS.find((option) => option === value) ?? 'block';
}

/**
 * The guardrail-wide posture, in the same three words everywhere it appears —
 * this toolbar, the per-hook Mode cell, the detail panel. It writes
 * `IGuardrail.mode` (and, through the page, `IGuardrail.enabled` beside it via
 * `writeGuardrailMode`); nothing here is per hook. The one thing a hook row can
 * say for itself is 'Off', which turns that BINDING off and leaves the
 * guardrail's mode alone.
 */
const MODE_DATA: ReadonlyArray<{ value: GuardrailMode; label: string }> =
  MODE_VOCABULARY.map(({ value, long }) => ({ value, label: long }));

/** The same three at the width of a grid cell, where 'Off' is per hook. */
const MODE_DATA_COMPACT: ReadonlyArray<{ value: GuardrailMode; label: string }> =
  MODE_VOCABULARY.map(({ value, short }) => ({ value, label: short }));

/**
 * `ensureHooks()` gives a lifted policy this prefix (`legacy:pii`,
 * `legacy:word_filter`, …). A lifted column is real and must be shown — a
 * legacy guardrail that rendered an empty grid would read as "nothing runs",
 * which is the opposite of the truth — but its payload was derived rather than
 * authored, so the column is labelled and its per-policy settings stay on the
 * Policies tab.
 */
const LEGACY_POLICY_ID_PREFIX = 'legacy:';

// ── pure helpers over the config ──────────────────────────────────────────

export function emptyHooksConfig(): GuardrailHooksConfig {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    policies: [],
    bindings: {},
    // Newly authored configs opt INTO real-time streaming enforcement; only
    // rows lifted from the legacy columns get `false`, so no existing tenant's
    // streaming behaviour moves on upgrade.
    stream: { enabled: true },
    shortCircuit: true,
  };
}

/** True when this policy came from `ensureHooks()`'s legacy lift. */
export function isLiftedPolicy(policy: GuardrailPolicy): boolean {
  return policy.id.startsWith(LEGACY_POLICY_ID_PREFIX);
}

/**
 * `Object.assign` rather than an object literal spread: `GuardrailPolicy` is a
 * nine-member discriminated union, and `{ ...policy, hooks, enabled }` produces
 * a type TypeScript will not accept back as a `GuardrailPolicy`. The assign
 * form types as `GuardrailPolicy & { … }`, which is assignable, and needs no
 * cast to get there.
 */
function rebind(policy: GuardrailPolicy, hooks: HookId[], enabled: boolean): GuardrailPolicy {
  return Object.assign({}, policy, { hooks, enabled });
}

/**
 * Read with the same three-value coercion the engine applies (`resolveRunIf`,
 * services/guardrail/families/llm.ts). The value is widened to `unknown` first
 * even though the field is declared: it arrives from a stored JSON blob, and an
 * unrecognised value written by a newer console must read as 'always' — run the
 * policy — rather than as a gate that silently suppresses it.
 */
function readRunIf(policy: GuardrailPolicy): PolicyRunIf {
  const raw: unknown = policy.runIf;
  return raw === 'onFinding' || raw === 'onSideEffect' ? raw : 'always';
}

function writeRunIf(policy: GuardrailPolicy, runIf: PolicyRunIf): GuardrailPolicy {
  return Object.assign({}, policy, { runIf });
}

/**
 * Can this policy run at this hook AS IT IS CONFIGURED RIGHT NOW?
 *
 * The boolean half of `canBindToHook`, which is what the column model and the
 * cell state machine need; the screen itself renders that function's `reason`,
 * because a greyed-out cell with no explanation is indistinguishable from a
 * broken one.
 */
export function canPolicyBind(policy: GuardrailPolicy, hook: HookId): boolean {
  return canBindToHook(policy, hook).ok;
}

// ── the column model ──────────────────────────────────────────────────────

export interface MatrixColumn {
  policyId: string;
  /** What the header shows: the label, falling back to the id. */
  name: string;
  family: PolicyFamily;
  familyLabel: string;
  enabled: boolean;
  /** Derived by the legacy lift rather than authored here. */
  lifted: boolean;
  /** The hooks this policy could take given its family AND its own current
   *  configuration — not merely `POLICY_VALID_HOOKS[family]`. */
  validHooks: HookId[];
}

/**
 * One column per policy, in stored order.
 *
 * Order is the policies array's own order, never sorted: that array IS the
 * deterministic execution order the engine runs and the order findings are
 * reported in, so a grid that sorted columns alphabetically would be showing a
 * sequence that does not happen.
 */
export function matrixColumns(
  hooks: GuardrailHooksConfig,
  opts?: { enabledOnly?: boolean },
): MatrixColumn[] {
  const columns: MatrixColumn[] = [];
  for (const policy of hooks.policies ?? []) {
    if (opts?.enabledOnly && !policy.enabled) continue;
    columns.push({
      policyId: policy.id,
      name: policyDisplayName(policy),
      family: policy.family,
      familyLabel: familyLabel(policy.family),
      enabled: policy.enabled,
      lifted: isLiftedPolicy(policy),
      validHooks: HOOK_IDS.filter((hook) => canPolicyBind(policy, hook)),
    });
  }
  return columns;
}

/** 'on' = runs here · 'off' = could run here and does not · 'invalid' = cannot. */
export type MatrixCell = 'on' | 'off' | 'invalid';

function findPolicy(hooks: GuardrailHooksConfig, policyId: string): GuardrailPolicy | undefined {
  return (hooks.policies ?? []).find((policy) => policy.id === policyId);
}

/**
 * A BOUND AND ENABLED policy reads 'on' even when it can no longer legally take
 * the hook. That state is reachable — a regex rule loses its declared bound
 * after it was bound to the stream, an older build wrote the row — and showing
 * it as 'invalid' would hide from the operator that the config they have on
 * disk claims something the server will reject. It shows as an on cell with a
 * warning, and `describeIssues` names it.
 */
export function cellState(
  hooks: GuardrailHooksConfig,
  policyId: string,
  hook: HookId,
): MatrixCell {
  const policy = findPolicy(hooks, policyId);
  if (!policy) return 'invalid';
  if (policy.enabled && policy.hooks?.includes(hook)) return 'on';
  return canPolicyBind(policy, hook) ? 'off' : 'invalid';
}

/** Convenience over `cellState` for callers that only care about the binary. */
export function isPolicyOn(hooks: GuardrailHooksConfig, policyId: string, hook: HookId): boolean {
  return cellState(hooks, policyId, hook) === 'on';
}

/**
 * Why a cell cannot be filled, in `canBindToHook`'s own words — the reasons are
 * real engineering constraints an operator can act on (bind it somewhere else,
 * declare a bound, turn the obfuscation pass off), and a disabled cell that
 * does not say which one is indistinguishable from a broken screen.
 */
export function cellBlockedReason(
  hooks: GuardrailHooksConfig,
  policyId: string,
  hook: HookId,
): string | undefined {
  const policy = findPolicy(hooks, policyId);
  if (!policy) return 'This policy is no longer part of the configuration.';
  const eligibility = canBindToHook(policy, hook);
  return eligibility.ok ? undefined : eligibility.reason;
}

/**
 * Family-level read, kept because a preset and the legacy screens still ask
 * "does anything from this family run here?".
 */
export function isCellOn(hooks: GuardrailHooksConfig, family: PolicyFamily, hook: HookId): boolean {
  return (hooks.policies ?? []).some(
    (policy) => policy.family === family && policy.enabled && policy.hooks?.includes(hook),
  );
}

function nextPolicyId(hooks: GuardrailHooksConfig, family: PolicyFamily): string {
  const taken = new Set((hooks.policies ?? []).map((policy) => policy.id));
  if (!taken.has(family)) return family;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${family}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable in practice; a timestamp beats throwing inside a click handler.
  return `${family}-${Date.now()}`;
}

/**
 * A brand-new policy for a family, configured so it is VALID the moment it
 * appears. A preset or a click that produces a config the operator then has to
 * repair before it will save teaches them to distrust the grid.
 *
 * The two exceptions are the references this component cannot invent: a PII
 * policy key and an LLM model key. Those policies are created ENABLED with an
 * empty reference and the issue list names them, because the honest reading of
 * "the operator asked for PII" is "they want PII on", not "they want a disabled
 * placeholder".
 */
function defaultPolicyFor(
  family: PolicyFamily,
  hook: HookId,
  id: string,
  modelKey?: string,
): GuardrailPolicy {
  // Not `as const`: that would freeze `hooks` to a readonly tuple, and the
  // persisted shape asks for a mutable `HookId[]`.
  const base: { id: string; enabled: boolean; hooks: HookId[]; schedule: HookSchedule } = {
    id,
    enabled: true,
    hooks: [hook],
    schedule: SYNC_BLOCK,
  };
  switch (family) {
    case 'pii':
      return {
        ...base,
        family,
        piiPolicyKey: '',
        // The obfuscation pass scans a NFKC-normalised string whose length
        // differs from the raw one, so it has no raw-character bound and
        // `policyMaxMatchChars` returns 0. On the streaming hook that is fatal,
        // so a stream-bound PII policy gives it up; everywhere else it stays on
        // because dropping it is how a migration silently loses obfuscation
        // resistance.
        detectObfuscated: hook !== STREAM_HOOK,
      };
    case 'secrets':
      return {
        ...base,
        family,
        known: true,
        // Off by default: the `[A-Za-z0-9-_]{32,}` heuristic fires on ordinary
        // base64 and on UUIDs, and a guardrail that redacts file payloads gets
        // switched off wholesale within a day.
        genericHighEntropy: false,
        action: 'redact',
      };
    case 'word_filter':
      return {
        ...base,
        family,
        // Seeded from the catalog's own defaults. An empty map is a word filter
        // that matches nothing, which reads as configured and does the one
        // thing this whole screen exists to prevent.
        builtinLists: Object.fromEntries(
          WORD_FILTER_BUILTIN_LISTS.map((list) => [list.id, list.defaultEnabled === true]),
        ),
        words: [],
      };
    case 'regex':
      return {
        ...base,
        family,
        rules: [
          {
            id: 'private-ipv4',
            label: 'Example — private IPv4 address',
            pattern:
              '\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})\\b',
            category: 'internal_address',
            severity: 'medium',
            // 255.255.255.255 is 15 characters; nothing this rule matches is
            // longer. The declared bound is what sizes the stream hold-back.
            maxMatchChars: 15,
          },
        ],
      };
    case 'moderation':
      return { ...base, family, modelKey, categories: {} };
    case 'prompt_shield':
      return { ...base, family, modelKey, sensitivity: 'balanced' };
    case 'custom':
      return {
        ...base,
        family,
        modelKey,
        prompt: '',
        // Authored policies get the honest behaviour: a custom rule with no
        // model raises an evaluation error rather than passing silently, which
        // is what lifted legacy policies ('skip') still do.
        onMissingModel: 'error_finding',
      };
    case 'tool_access':
      return {
        ...base,
        family,
        defaultSideEffect: 'read',
        sideEffectActions: { destructive: 'warn', external: 'warn' },
      };
    case 'webhook':
      return { ...base, family, url: '', send: 'text', retries: 0 };
  }
}

function withBinding(
  hooks: GuardrailHooksConfig,
  hook: HookId,
  patch: Partial<HookBinding>,
): GuardrailHooksConfig {
  const current: HookBinding = hooks.bindings?.[hook] ?? { enabled: false, schedule: SYNC_BLOCK };
  return { ...hooks, bindings: { ...hooks.bindings, [hook]: { ...current, ...patch } } };
}

/**
 * Drop one hook from a policy without ever discarding its payload.
 *
 * A regex policy carries its rules, a webhook its url, a tool policy its whole
 * allow/deny model; unticking a box is not consent to delete any of that. A
 * policy left with no hooks is PARKED instead — disabled, with its last hook
 * kept so the config stays valid (the validator rejects a policy bound to
 * nothing) and so re-ticking the same cell restores exactly what was there.
 */
function unbind(policy: GuardrailPolicy, hook: HookId): GuardrailPolicy {
  const remaining = (policy.hooks ?? []).filter((h) => h !== hook);
  return remaining.length > 0
    ? rebind(policy, remaining, policy.enabled)
    : rebind(policy, [hook], false);
}

/**
 * Turn ONE POLICY's cell on or off. This is what a click in the grid does.
 *
 * The two asymmetries are deliberate. Turning a cell ON enables the hook's
 * binding, because an enabled policy on a dead binding is the exact state the
 * server refuses. Turning a PARKED policy back on REPLACES its hook list rather
 * than extending it, so re-enabling a policy cannot silently light up a cell the
 * operator switched off earlier.
 */
export function setPolicyHook(
  hooks: GuardrailHooksConfig,
  policyId: string,
  hook: HookId,
  on: boolean,
): GuardrailHooksConfig {
  const policies = hooks.policies ?? [];
  const target = policies.find((policy) => policy.id === policyId);
  if (!target) return hooks;

  if (!on) {
    if (!target.hooks?.includes(hook)) {
      // Already off, but possibly only because the policy is disabled. Nothing
      // to remove; leaving the config untouched keeps the click idempotent.
      return hooks;
    }
    return {
      ...hooks,
      policies: policies.map((policy) => (policy.id === policyId ? unbind(policy, hook) : policy)),
    };
  }

  // The grid renders an invalid cell as a non-button, so this is unreachable
  // from a click — but a preset, a paste or a future caller can reach it, and
  // authoring a config the validator will reject is worse than doing nothing.
  if (!canPolicyBind(target, hook)) return hooks;

  const next = policies.map((policy) => {
    if (policy.id !== policyId) return policy;
    return policy.enabled
      ? rebind(policy, Array.from(new Set([...(policy.hooks ?? []), hook])), true)
      : rebind(policy, [hook], true);
  });
  return withBinding({ ...hooks, policies: next }, hook, { enabled: true });
}

/**
 * Family-level toggle, kept for the presets and for any caller that still
 * thinks in families. It picks an existing policy of the family where it can
 * and creates one where it cannot; the grid itself no longer calls it, because
 * "the regex family" is not a thing an operator can point at once two regex
 * policies exist.
 */
export function setCell(
  hooks: GuardrailHooksConfig,
  family: PolicyFamily,
  hook: HookId,
  on: boolean,
  modelKey?: string,
): GuardrailHooksConfig {
  const policies = hooks.policies ?? [];

  if (!on) {
    const next = policies.map((policy) =>
      policy.family === family && policy.hooks?.includes(hook) ? unbind(policy, hook) : policy,
    );
    return { ...hooks, policies: next };
  }

  if (!POLICY_VALID_HOOKS[family].includes(hook)) return hooks;

  // Prefer a policy that is already live and can take this hook; fall back to a
  // parked one, whose hook list is REPLACED rather than extended.
  const live = policies.find((c) => c.family === family && c.enabled && canPolicyBind(c, hook));
  if (live) return setPolicyHook(hooks, live.id, hook, true);

  const parked = policies.find((c) => c.family === family && !c.enabled && canPolicyBind(c, hook));
  if (parked) return setPolicyHook(hooks, parked.id, hook, true);

  const created = defaultPolicyFor(family, hook, nextPolicyId(hooks, family), modelKey);
  return withBinding({ ...hooks, policies: [...policies, created] }, hook, { enabled: true });
}

/**
 * Turning a hook off clears it from every policy rather than leaving enabled
 * policies stranded on a dead binding — that state is precisely the silent
 * no-op this grid exists to make impossible, and the server rejects it.
 */
export function setHookEnabled(
  hooks: GuardrailHooksConfig,
  hook: HookId,
  enabled: boolean,
): GuardrailHooksConfig {
  if (enabled) return withBinding(hooks, hook, { enabled: true });
  // Ids are captured from the ORIGINAL array; `next` is rebuilt each pass and
  // ids are stable, so the walk cannot miss a policy or visit one twice.
  const bound = (hooks.policies ?? [])
    .filter((policy) => policy.enabled && policy.hooks?.includes(hook))
    .map((policy) => policy.id);
  let next = hooks;
  for (const policyId of bound) next = setPolicyHook(next, policyId, hook, false);
  return withBinding(next, hook, { enabled: false });
}

function scheduleFor(binding: HookBinding | undefined): HookSchedule {
  return binding?.schedule ?? SYNC_BLOCK;
}

/**
 * Propagates the hook's schedule down onto every policy bound to it.
 *
 * The two exist at both levels and the engine honours both; keeping them in
 * step from the grid means "this hook observes instead of blocking" is one
 * statement rather than one plus N.
 */
function setHookSchedule(
  hooks: GuardrailHooksConfig,
  hook: HookId,
  schedule: HookSchedule,
): GuardrailHooksConfig {
  const policies = (hooks.policies ?? []).map((policy) =>
    policy.hooks?.includes(hook) ? Object.assign({}, policy, { schedule }) : policy,
  );
  return withBinding({ ...hooks, policies }, hook, { schedule });
}

// ── streaming cost ────────────────────────────────────────────────────────

export interface StreamCostEstimate {
  /** max(policyMaxMatchChars) over the policies actually bound to the stream. */
  requiredOverlap: number;
  overlapChars: number;
  holdBackChars: number;
  holdBackMs: number;
  /** True when the configured hold-back is below what the bound policies need,
   *  i.e. the engine will raise it at save time. */
  raised: boolean;
  /** Delay before the first character reaches the caller. */
  addedTtftMs: number;
  /** Steady-state lag, which oscillates between the two release triggers. */
  steadyLagMinMs: number;
  steadyLagMaxMs: number;
  /**
   * Does the gate ACTUALLY engage on this configuration today?
   *
   * When false the three latency figures above are hypothetical — what
   * buffering would cost if it were switched on — and the real added latency is
   * zero, because `foldStreamSettings` returns PASS_THROUGH.
   */
  gated: boolean;
  /** Why not, when `gated` is false. Absent when it is true. */
  notGatedReason?: string;
}

/**
 * What buffering actually costs, in the only units an operator cares about.
 *
 * The gate releases when the held region exceeds `holdBackChars`, OR when
 * `holdBackMs` has passed since the last release — and the timed path keeps
 * only `overlapChars` back rather than dropping to zero, because `holdBackMs`
 * is a latency promise and honouring it fully would break the invariant the
 * hold-back exists for. So the caller sees text arrive a fixed distance behind
 * the model, never later than `holdBackMs`.
 *
 * Note what this does NOT claim: total completion time barely moves, because
 * the final window releases everything. The cost is time-to-first-token and a
 * constant lag, and saying so is the difference between an operator turning
 * streaming enforcement on with their eyes open and shipping a TTFT regression
 * they discover from a support ticket.
 *
 * `gated` mirrors `foldStreamSettings` (hooks/streamGate.ts) clause for clause,
 * INCLUDING the one that surprises people: a single stream-bound policy with no
 * declared match bound makes the engine skip the whole guardrail's gate, so one
 * bad regex rule silently turns real-time enforcement off for everything else
 * bound there.
 */
export function estimateStreamCost(
  hooks: GuardrailHooksConfig,
  charsPerSecond: number,
  mode?: GuardrailMode,
): StreamCostEstimate {
  const boundEligible = (hooks.policies ?? []).filter(
    (policy) =>
      policy.enabled &&
      policy.hooks?.includes(STREAM_HOOK) === true &&
      STREAM_ELIGIBLE_FAMILIES.has(policy.family),
  );
  const unbounded = boundEligible.find((policy) => policyMaxMatchChars(policy) <= 0);
  const requiredOverlap = boundEligible.reduce(
    (max, policy) => Math.max(max, policyMaxMatchChars(policy)),
    0,
  );

  // `Partial<>`: `enabled` is required on the persisted shape, so a bare `{}`
  // fallback would not be assignable to it.
  const stream: Partial<StreamGuardSettings> = hooks.stream ?? {};
  const overlapChars = Math.max(
    stream.overlapChars ?? DEFAULT_STREAM_SETTINGS.overlapChars,
    requiredOverlap,
  );
  const configuredHoldBack = stream.holdBackChars ?? DEFAULT_STREAM_SETTINGS.holdBackChars;
  const holdBackChars = Math.max(configuredHoldBack, overlapChars);
  const holdBackMs = stream.holdBackMs ?? DEFAULT_STREAM_SETTINGS.holdBackMs;

  const rate = charsPerSecond > 0 ? charsPerSecond : 1;
  const msFor = (chars: number) => Math.round((chars / rate) * 1000);

  const notGatedReason = ((): string | undefined => {
    if (hooks.stream?.enabled !== true) {
      return 'Streaming enforcement is off for this guardrail, so the answer is only audited once it has already reached the caller.';
    }
    if (hooks.bindings?.[STREAM_HOOK]?.enabled !== true) {
      return 'The streaming hook is switched off, so nothing is held back.';
    }
    if (mode !== undefined && mode !== 'enforce') {
      return 'This guardrail is in monitor mode. A monitor verdict cannot block or redact, so the engine skips the gate rather than buying latency for a decision it will neutralise.';
    }
    if (unbounded) {
      return `"${policyDisplayName(unbounded)}" is bound here with no declared match bound, and one such policy makes the engine skip this guardrail's gate entirely — every other policy bound here stops enforcing on the stream too.`;
    }
    if (boundEligible.length === 0) {
      return 'No policy with a bounded match length is bound here, so the window closes to zero and streaming costs nothing.';
    }
    return undefined;
  })();

  const gated = notGatedReason === undefined;

  return {
    requiredOverlap,
    overlapChars,
    holdBackChars,
    holdBackMs,
    raised:
      holdBackChars > configuredHoldBack ||
      overlapChars > (stream.overlapChars ?? DEFAULT_STREAM_SETTINGS.overlapChars),
    addedTtftMs: Math.min(holdBackMs, msFor(holdBackChars)),
    steadyLagMinMs: Math.min(holdBackMs, msFor(overlapChars)),
    steadyLagMaxMs: Math.min(holdBackMs, msFor(holdBackChars)),
    gated,
    notGatedReason,
  };
}

// ── local issue list ──────────────────────────────────────────────────────

export interface HookIssue {
  policyId: string;
  /** The display name, so the alert reads the way the columns do. */
  policyName: string;
  hook?: HookId;
  message: string;
}

/**
 * A SUBSET of `validateGuardrailHooks`, re-stated here because that function
 * lives behind the database barrel and cannot enter a client bundle. It covers
 * the states an operator can reach from this screen; the server re-validates
 * everything and its errors are the ones that decide a save.
 *
 * Keep this list short on purpose. A client validator that drifts from the
 * server is worse than none: it either blocks a save the server would accept,
 * or promises one it would refuse. Every entry below has a line-for-line
 * counterpart in `validateGuardrailHooks`.
 */
export function describeIssues(hooks: GuardrailHooksConfig): HookIssue[] {
  const issues: HookIssue[] = [];
  const seen = new Set<string>();

  if (hooks.contractVersion !== GUARDRAIL_CONTRACT_VERSION) {
    issues.push({
      policyId: '<config>',
      policyName: 'This guardrail',
      message: `The stored contract version is ${String(hooks.contractVersion)}; this console writes ${GUARDRAIL_CONTRACT_VERSION} and the server will refuse the save.`,
    });
  }

  for (const policy of hooks.policies ?? []) {
    const id = policy.id || `<unnamed ${policy.family}>`;
    const name = policyDisplayName(policy);
    const at = (message: string, hook?: HookId): HookIssue => ({
      policyId: id,
      policyName: name,
      hook,
      message,
    });

    if (!policy.id) {
      issues.push(at('Every policy needs an id — it is what a finding names when it reports back.'));
    } else if (seen.has(policy.id)) {
      issues.push(at('Two policies share this id, so their findings cannot be told apart.'));
    }
    seen.add(policy.id);

    // Checked for DISABLED policies too: the validator does the same, because a
    // parked policy with an empty hook list is still a row the server refuses.
    if (!policy.hooks?.length) {
      issues.push(at('This policy is bound to no hook, so it can never run.'));
    }

    if (!policy.enabled) continue;

    for (const hook of policy.hooks ?? []) {
      if (!POLICY_VALID_HOOKS[policy.family].includes(hook)) {
        issues.push(
          at(`${familyLabel(policy.family)} cannot run at ${HOOK_META[hook].short}.`, hook),
        );
      } else if (hooks.bindings?.[hook]?.enabled !== true) {
        issues.push(at(`${HOOK_META[hook].short} is switched off, so this policy never runs.`, hook));
      }
      if (hook === STREAM_HOOK && policyMaxMatchChars(policy) <= 0) {
        issues.push(
          at(
            policy.family === 'pii'
              ? 'A streaming PII policy must turn its obfuscation pass off — that pass scans a normalised string, so it has no bounded match length to size the window from.'
              : 'This policy declares no bounded match length, so no hold-back window can make it correct on a stream.',
            hook,
          ),
        );
      }
    }

    switch (policy.family) {
      case 'pii':
        if (!policy.piiPolicyKey?.trim()) {
          issues.push(at('Pick a PII policy on the Policies tab — an enabled PII policy needs one.'));
        }
        break;
      case 'moderation':
      case 'prompt_shield':
      case 'custom':
        if (!policy.modelKey?.trim()) {
          issues.push(at('No model to evaluate this policy, so it reads as active while nothing runs.'));
        }
        if (policy.family === 'custom' && !policy.prompt?.trim()) {
          issues.push(at('A custom policy needs a rule to evaluate.'));
        }
        break;
      case 'regex':
        if (!policy.rules?.length) {
          issues.push(at('A regex policy with no rules matches nothing.'));
        }
        for (const rule of policy.rules ?? []) {
          try {
            new RegExp(rule.pattern, rule.flags ?? '');
          } catch {
            issues.push(
              at(`Rule "${rule.label || rule.id}" is not a valid pattern, so it can never fire.`),
            );
          }
          if (
            !Number.isFinite(rule.maxMatchChars) ||
            rule.maxMatchChars <= 0 ||
            rule.maxMatchChars > REGEX_MAX_MATCH_CHARS
          ) {
            issues.push(
              at(
                `Rule "${rule.label || rule.id}" needs a match-length bound between 1 and ${REGEX_MAX_MATCH_CHARS}.`,
              ),
            );
          }
        }
        break;
      case 'webhook':
        if (!/^https:\/\//i.test(policy.url ?? '')) {
          issues.push(
            at(
              'A webhook must use https — the verdict decides whether a request is blocked, so a plaintext hop is a bypass.',
            ),
          );
        }
        break;
      default:
        break;
    }
  }

  return issues;
}

// ── presets ───────────────────────────────────────────────────────────────

export interface HookPreset {
  id: string;
  name: string;
  description: string;
  /** What the operator still has to supply. Shown before they apply it, so a
   *  preset never lands as a surprise pile of red. */
  requires: string[];
  build: (modelKey?: string) => GuardrailHooksConfig;
}

const enabledBinding = (schedule: HookSchedule = SYNC_BLOCK): HookBinding => ({
  enabled: true,
  schedule,
});

/**
 * Three, not thirty. Each one is a posture an operator recognises, and between
 * them they touch all five hooks — which is the point: a brand-new guardrail
 * opens on a working configuration you can subtract from, rather than a blank
 * grid that gives no clue which binding is meaningful.
 *
 * Every policy a preset creates is LABELLED, because the label is now a column
 * header rather than a footnote.
 */
export const HOOK_PRESETS: readonly HookPreset[] = [
  {
    id: 'starter-input',
    name: 'Starter — inbound',
    description:
      'Catch the two things people paste by accident: a credential and a customer record. Cheap, deterministic, and it never spends a model call.',
    requires: ['A PII policy, to turn the PII policy on.'],
    build: () => ({
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      policies: [
        Object.assign(defaultPolicyFor('secrets', 'input.pre', 'secrets'), {
          action: 'block' as const,
          label: 'Credentials in the prompt',
        }),
        Object.assign(defaultPolicyFor('pii', 'input.pre', 'pii'), {
          label: 'Personal data in the prompt',
        }),
        Object.assign(defaultPolicyFor('word_filter', 'input.pre', 'word_filter'), {
          action: 'flag' as const,
          label: 'Banned wording',
        }),
      ],
      bindings: { 'input.pre': enabledBinding() },
      // Nothing here runs on the output, so there is no stream to gate.
      stream: { enabled: false },
      shortCircuit: true,
    }),
  },
  {
    id: 'output-safety',
    name: 'Output safety',
    description:
      'Nothing leaves with a credential or an internal address in it, and the secret scan runs while the answer streams rather than after it has already reached the browser.',
    requires: [
      'A PII policy, to turn the PII policy on.',
      'Streaming adds latency — see the estimate below.',
    ],
    build: () => ({
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      policies: [
        Object.assign(defaultPolicyFor('secrets', 'output.pre', 'secrets'), {
          hooks: ['output.pre', STREAM_HOOK] as HookId[],
          action: 'redact' as const,
          label: 'Credential redaction',
        }),
        Object.assign(defaultPolicyFor('pii', 'output.pre', 'pii'), {
          label: 'Personal data in the answer',
        }),
        Object.assign(defaultPolicyFor('regex', 'output.pre', 'regex'), {
          hooks: ['output.pre', STREAM_HOOK] as HookId[],
          action: 'redact' as const,
          label: 'Internal addresses',
        }),
      ],
      bindings: { 'output.pre': enabledBinding(), [STREAM_HOOK]: enabledBinding() },
      stream: { enabled: true },
      shortCircuit: true,
    }),
  },
  {
    id: 'tool-safety',
    name: 'Tool safety',
    description:
      'The posture the built-in tool guardrail ships with: side effects classified, credentials redacted out of arguments and results, and sensitive values flagged going in but redacted coming back.',
    requires: [],
    build: () => ({
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      policies: [
        Object.assign(defaultPolicyFor('tool_access', 'tool.pre', 'tool-access'), {
          hooks: ['tool.pre', 'tool.post'] as HookId[],
          label: 'Tool side effects',
        }),
        Object.assign(defaultPolicyFor('secrets', 'tool.pre', 'dlp-secrets'), {
          hooks: ['tool.pre', 'tool.post'] as HookId[],
          action: 'redact' as const,
          label: 'Credential redaction',
          // Deliberately narrow. This guardrail sits in front of file writes,
          // and the generic 32-character heuristic would redact ordinary
          // payloads and get the whole thing switched off.
          genericHighEntropy: false,
        }),
      ],
      bindings: { 'tool.pre': enabledBinding(), 'tool.post': enabledBinding() },
      stream: { enabled: false },
      // Every finding matters here: the audit trail for a denied tool call is
      // the only record of what the model tried to do.
      shortCircuit: false,
    }),
  },
];

// ── telemetry ─────────────────────────────────────────────────────────────

export interface HookTelemetry {
  calls: number;
  blocked: number;
  blockRatePct: number;
  p95LatencyMs: number | null;
}

interface EvaluationLogRow {
  hook?: string;
  target?: string;
  decision?: string;
  passed?: boolean;
  latencyMs?: number;
}

const TELEMETRY_LIMIT = 200;

/**
 * Pre-hook-plane rows carry no `hook`, only the two legacy phases — and those
 * really did run at these two points, so folding them in is accurate rather
 * than convenient. A row whose `target` is neither is dropped: guessing would
 * put another guardrail's traffic on a row.
 */
function bucketOf(row: EvaluationLogRow): HookId | null {
  const raw = row.hook ?? row.target;
  if (raw === 'input') return 'input.pre';
  if (raw === 'output') return 'output.pre';
  return HOOK_IDS.includes(raw as HookId) ? (raw as HookId) : null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[index]);
}

function useHookTelemetry(guardrailId: string | undefined, windowHours: number) {
  const [byHook, setByHook] = useState<Partial<Record<HookId, HookTelemetry>>>({});
  const [sampleSize, setSampleSize] = useState(0);

  useEffect(() => {
    if (!guardrailId) return;
    let cancelled = false;

    const from = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const params = new URLSearchParams({ from, limit: String(TELEMETRY_LIMIT), groupBy: 'day' });

    fetch(`/api/guardrails/${guardrailId}/evaluations?${params.toString()}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { logs: [] }))
      .then((data: { logs?: EvaluationLogRow[] }) => {
        if (cancelled) return;
        const rows = data.logs ?? [];
        const latencies = new Map<HookId, number[]>();
        const next: Partial<Record<HookId, HookTelemetry>> = {};

        for (const row of rows) {
          const hook = bucketOf(row);
          if (!hook) continue;
          const bucket = next[hook] ?? { calls: 0, blocked: 0, blockRatePct: 0, p95LatencyMs: null };
          bucket.calls += 1;
          // `decision` is the EFFECTIVE outcome and exists only on hook-plane
          // rows. Older rows only recorded whether a blocking finding existed,
          // which is the closest honest answer available for them.
          const blocked = row.decision ? row.decision === 'block' : row.passed === false;
          if (blocked) bucket.blocked += 1;
          next[hook] = bucket;
          if (typeof row.latencyMs === 'number') {
            const list = latencies.get(hook) ?? [];
            list.push(row.latencyMs);
            latencies.set(hook, list);
          }
        }

        for (const hook of HOOK_IDS) {
          const bucket = next[hook];
          if (!bucket) continue;
          bucket.blockRatePct = bucket.calls > 0 ? (bucket.blocked / bucket.calls) * 100 : 0;
          bucket.p95LatencyMs = percentile(latencies.get(hook) ?? [], 0.95);
        }

        setByHook(next);
        setSampleSize(rows.length);
      })
      .catch(() => {
        // Telemetry is decoration on a configuration screen. Failing to load it
        // must never stop someone editing their guardrail.
      });

    return () => {
      cancelled = true;
    };
  }, [guardrailId, windowHours]);

  return { byHook, sampleSize };
}

// ── the component ─────────────────────────────────────────────────────────

/** Fixed widths, so the grid's minimum width is arithmetic rather than a guess
 *  and the horizontal scroll appears exactly when it is needed. */
const HOOK_COL_W = 236;
const POLICY_COL_W = 104;
// enforcement + mode + the three telemetry columns. It was 100 + 96 + … when
// `On failure` and `Timing` were two selects; one control needs less room than
// the pair it replaced even at a width that fits "Observe, no wait".
const TAIL_COL_W = 158 + 108 + 76 + 84 + 76;

export interface GuardrailHooksMatrixProps {
  guardrailId?: string;
  hooks: GuardrailHooksConfig;
  onChange: (hooks: GuardrailHooksConfig) => void;
  /** The record-level enforcement posture. There is no per-hook mode column in
   *  the persisted shape — see the note under the table. */
  mode: GuardrailMode;
  onModeChange: (mode: GuardrailMode) => void;
  /** True when this config was DERIVED from the legacy columns rather than
   *  authored (hooksVersion 0). Saving it promotes it to authored. */
  derived?: boolean;
  /** Only used to seed a preset's LLM policies with a model. */
  models?: Array<{ value: string; label: string }>;
  readOnly?: boolean;
  /**
   * A column header was clicked, or `Open` was pressed on a policy in a hook's
   * detail panel. The page routes this to the Policies tab — this screen owns
   * WHERE a policy runs, never WHAT it looks for.
   */
  onOpenPolicy?: (policyId: string) => void;
  /** The empty state's and the toolbar's `+ Add policy`. Same destination. */
  onAddPolicy?: () => void;
}

export default function GuardrailHooksMatrix({
  guardrailId,
  hooks,
  onChange,
  mode,
  onModeChange,
  derived = false,
  models = [],
  readOnly,
  onOpenPolicy,
  onAddPolicy,
}: GuardrailHooksMatrixProps) {
  const [openHook, setOpenHook] = useState<HookId | null>(null);
  const [scope, setScope] = useState<'enabled' | 'all'>('all');
  // The assumed generation rate behind the latency estimate. Editable because
  // it is the one number the estimate cannot know, and a figure presented
  // without its assumption is just a number.
  const [charsPerSecond, setCharsPerSecond] = useState(160);

  const { byHook, sampleSize } = useHookTelemetry(guardrailId, 24);
  const issues = useMemo(() => describeIssues(hooks), [hooks]);
  const streamCost = useMemo(
    () => estimateStreamCost(hooks, charsPerSecond, mode),
    [hooks, charsPerSecond, mode],
  );

  const allColumns = useMemo(() => matrixColumns(hooks), [hooks]);
  const columns = useMemo(
    () => (scope === 'enabled' ? allColumns.filter((column) => column.enabled) : allColumns),
    [allColumns, scope],
  );
  const hiddenCount = allColumns.length - columns.length;

  const issuesFor = useCallback(
    (hook: HookId) => issues.filter((issue) => issue.hook === hook),
    [issues],
  );

  const policiesOn = useCallback(
    (hook: HookId) =>
      (hooks.policies ?? []).filter((policy) => policy.enabled && policy.hooks?.includes(hook)),
    [hooks],
  );

  const patchPolicy = (policyId: string, patch: (policy: GuardrailPolicy) => GuardrailPolicy) => {
    onChange({
      ...hooks,
      policies: (hooks.policies ?? []).map((policy) => (policy.id === policyId ? patch(policy) : policy)),
    });
  };

  const patchStream = (patch: Partial<StreamGuardSettings>) => {
    const current: StreamGuardSettings = hooks.stream ?? { enabled: false };
    onChange({ ...hooks, stream: { ...current, ...patch } });
  };

  const defaultModel = models[0]?.value;
  const minWidth = HOOK_COL_W + Math.max(columns.length, 1) * POLICY_COL_W + TAIL_COL_W;

  const presetMenu = (
    <Menu withinPortal position="bottom-end" width={340}>
      <Menu.Target>
        <Button
          size="xs"
          variant="default"
          rightSection={<IconChevronDown size={13} />}
          disabled={readOnly}
        >
          Apply a preset
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Replaces every policy and binding below</Menu.Label>
        {HOOK_PRESETS.map((preset) => (
          <Menu.Item key={preset.id} onClick={() => onChange(preset.build(defaultModel))}>
            <Text size="sm" fw={500}>
              {preset.name}
            </Text>
            <Text size="xs" c="dimmed">
              {preset.description}
            </Text>
            {preset.requires.map((req) => (
              <Text key={req} size="xs" c="orange.7" mt={4}>
                Needs: {req}
              </Text>
            ))}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <Stack gap="md">
      {/* ── toolbar ── */}
      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon size={28} radius="sm" variant="light" color="blue">
              <IconLayoutGrid size={15} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm">
                Hook plane
              </Text>
              <Text size="xs" c="dimmed" maw={640}>
                One column per policy, one row per hook point. A filled cell means that policy is
                evaluated there — so two policies of the same family can run in two different places
                and you can see it.
              </Text>
            </div>
          </Group>
          <Group gap="xs" wrap="wrap" align="flex-end">
            {/* The guardrail's own posture, and the SAME control as the one on
                the Policies tab — both write `mode` (with `enabled` beside it,
                through `writeGuardrailMode` on the page). Labelled "Mode" and
                not "Enforcement": Enforcement is the per-hook question in the
                grid below, and calling two different decisions by one word is
                how this screen got confusing in the first place. */}
            <Select
              size="xs"
              w={230}
              label="Mode"
              data={MODE_DATA}
              value={mode}
              onChange={(v) => onModeChange((v ?? 'enforce') as GuardrailMode)}
              disabled={readOnly}
            />
            {allColumns.length > 0 && (
              <SegmentedControl
                size="xs"
                value={scope}
                onChange={(v) => setScope(v === 'enabled' ? 'enabled' : 'all')}
                data={[
                  { value: 'all', label: 'All policies' },
                  { value: 'enabled', label: 'Enabled only' },
                ]}
              />
            )}
            {presetMenu}
            {onAddPolicy && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlus size={13} />}
                onClick={onAddPolicy}
                disabled={readOnly}
              >
                Add policy
              </Button>
            )}
          </Group>
        </Group>
      </Paper>

      {/* Derived from `mode`, not from a second `enabled` prop. The two used to
          be separate — a Mode select here and an Enabled switch on the Policies
          tab — which is one decision asked twice and two ways to disagree about
          it. `mode: 'disabled'` IS the off state now, on both screens. */}
      {mode === 'disabled' && (
        <Alert color="gray" icon={<IconInfoCircle size={16} />} variant="light">
          This guardrail&apos;s mode is <strong>Off</strong>, so nothing below runs — the grid is
          showing what <em>would</em> run. Set it back to Enforce or Monitor above.
        </Alert>
      )}

      {derived && (
        <Alert
          color="blue"
          icon={<IconInfoCircle size={16} />}
          variant="light"
          title="Derived from the legacy policy"
        >
          These policies were read off the legacy columns rather than authored, and they are
          re-derived on every evaluation — which is why they carry a{' '}
          <Text span ff="monospace" size="xs">
            legacy:
          </Text>{' '}
          id and no name of their own. They are real and they run. The moment you save from this tab
          the configuration becomes the source of truth and the legacy fields stop driving what
          happens.
        </Alert>
      )}

      {issues.length > 0 && (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={16} />}
          variant="light"
          title={`${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before this saves`}
        >
          <Stack gap={4}>
            {issues.map((issue, i) => (
              <Text size="xs" key={`${issue.policyId}-${i}`}>
                {onOpenPolicy && issue.policyId !== '<config>' ? (
                  <UnstyledButton
                    onClick={() => onOpenPolicy(issue.policyId)}
                    style={{ fontSize: 'inherit', textDecoration: 'underline' }}
                  >
                    <Text span fw={600} size="xs">
                      {issue.policyName}
                    </Text>
                  </UnstyledButton>
                ) : (
                  <Text span fw={600} size="xs">
                    {issue.policyName}
                  </Text>
                )}
                {' — '}
                {issue.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      {allColumns.length === 0 ? (
        <EmptyMatrix onAddPolicy={onAddPolicy} readOnly={readOnly} presetMenu={presetMenu} />
      ) : (
        <Paper withBorder radius="md" p={0}>
          <ScrollArea type="auto" offsetScrollbars="x">
            <Table
              fz="xs"
              withRowBorders
              verticalSpacing={6}
              horizontalSpacing={8}
              style={{ minWidth }}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ ...stickyCell(3), minWidth: HOOK_COL_W, width: HOOK_COL_W }}>
                    Hook
                  </Table.Th>

                  {columns.map((column) => (
                    <Table.Th
                      key={column.policyId}
                      ta="center"
                      style={{ width: POLICY_COL_W, minWidth: POLICY_COL_W, verticalAlign: 'bottom' }}
                    >
                      <ColumnHeader column={column} onOpenPolicy={onOpenPolicy} />
                    </Table.Th>
                  ))}

                  <Table.Th style={{ width: 158 }}>
                    <Tooltip
                      label={
                        <Stack gap={2}>
                          {ENFORCEMENT_TOOLTIP_ROWS.map((option) => (
                            <Text size="xs" key={option.value}>
                              <Text span fw={600} size="xs">
                                {option.label}
                              </Text>
                              {' — '}
                              {option.description}
                            </Text>
                          ))}
                          <Text size="xs" mt={2}>
                            There is no fourth combination: a check the request does not wait for
                            cannot block it.
                          </Text>
                        </Stack>
                      }
                      multiline
                      w={340}
                      withArrow
                    >
                      <Text size="xs" fw={600} style={{ cursor: 'help' }}>
                        Enforcement
                      </Text>
                    </Tooltip>
                  </Table.Th>
                  <Table.Th style={{ width: 108 }}>
                    <Tooltip
                      label="Enforce and monitor are set for the whole guardrail — changing one row changes them all. Only 'off' is per hook."
                      multiline
                      w={280}
                      withArrow
                    >
                      <Text size="xs" fw={600} style={{ cursor: 'help' }}>
                        Mode
                      </Text>
                    </Tooltip>
                  </Table.Th>
                  <Table.Th ta="right" style={{ width: 76 }}>
                    <Tooltip
                      label={`Evaluations at this hook in the last 24 hours, from the most recent ${TELEMETRY_LIMIT} rows (${sampleSize} in this window).`}
                      multiline
                      w={280}
                      withArrow
                    >
                      <Text size="xs" fw={600} style={{ cursor: 'help' }}>
                        24h calls
                      </Text>
                    </Tooltip>
                  </Table.Th>
                  <Table.Th ta="right" style={{ width: 84 }}>
                    <Text size="xs" fw={600}>
                      Block rate
                    </Text>
                  </Table.Th>
                  <Table.Th ta="right" style={{ width: 76 }}>
                    <Text size="xs" fw={600}>
                      p95
                    </Text>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>

              <Table.Tbody>
                {HOOK_IDS.map((hook) => {
                  const bound = hooks.bindings?.[hook];
                  const on = bound?.enabled === true;
                  const schedule = scheduleFor(bound);
                  const telemetry = byHook[hook];
                  const rowIssues = issuesFor(hook);
                  const expanded = openHook === hook;
                  const meta = HOOK_META[hook];

                  return (
                    <Table.Tr
                      key={hook}
                      style={{
                        opacity: on ? 1 : 0.55,
                        background: expanded ? 'var(--ds-surface-1)' : undefined,
                      }}
                    >
                      <Table.Td style={stickyCell(2, expanded)}>
                        <Group gap={6} wrap="nowrap" align="flex-start">
                          <Switch
                            size="xs"
                            mt={4}
                            checked={on}
                            disabled={readOnly}
                            aria-label={`Enable ${meta.short}`}
                            onChange={(e) =>
                              onChange(setHookEnabled(hooks, hook, e.currentTarget.checked))
                            }
                          />
                          <UnstyledButton
                            onClick={() => setOpenHook(expanded ? null : hook)}
                            aria-expanded={expanded}
                            style={{ minWidth: 0, flex: 1, textAlign: 'left' }}
                          >
                            <Group gap={4} wrap="nowrap" align="center">
                              {expanded ? (
                                <IconChevronDown size={13} />
                              ) : (
                                <IconChevronRight size={13} />
                              )}
                              <Text size="xs" fw={600}>
                                {meta.label}
                              </Text>
                            </Group>
                            <Group gap={6} pl={17}>
                              <Text size="xs" c="dimmed" ff="monospace">
                                {meta.short}
                              </Text>
                              {hook === STREAM_HOOK && on && streamCost.gated && (
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color="grape"
                                  leftSection={<IconBolt size={9} />}
                                >
                                  +{streamCost.addedTtftMs} ms
                                </Badge>
                              )}
                              {rowIssues.length > 0 && (
                                <Badge size="xs" variant="light" color="orange">
                                  {rowIssues.length}
                                </Badge>
                              )}
                            </Group>
                          </UnstyledButton>
                        </Group>
                      </Table.Td>

                      {columns.map((column) => (
                        <Table.Td key={column.policyId} ta="center">
                          <MatrixCellToggle
                            column={column}
                            hook={hook}
                            state={cellState(hooks, column.policyId, hook)}
                            blockedReason={cellBlockedReason(hooks, column.policyId, hook)}
                            hookOn={on}
                            readOnly={readOnly}
                            onToggle={(next) =>
                              onChange(setPolicyHook(hooks, column.policyId, hook, next))
                            }
                          />
                        </Table.Td>
                      ))}

                      {/* ONE control, three values. It writes
                          `binding.schedule` and the `schedule` of every policy
                          bound here — see ENFORCEMENT_META for the mapping. */}
                      <Table.Td>
                        <Select
                          size="xs"
                          aria-label={`Enforcement at ${meta.short}`}
                          data={ENFORCEMENT_DATA}
                          value={toEnforcement(schedule)}
                          disabled={readOnly || !on}
                          onChange={(v) =>
                            onChange(setHookSchedule(hooks, hook, fromEnforcement(asEnforcement(v))))
                          }
                        />
                      </Table.Td>

                      <Table.Td>
                        <Select
                          size="xs"
                          data={MODE_DATA_COMPACT}
                          value={on && mode !== 'disabled' ? mode : 'disabled'}
                          disabled={readOnly}
                          onChange={(v) => {
                            if (v === 'disabled') {
                              onChange(setHookEnabled(hooks, hook, false));
                              return;
                            }
                            if (!on) onChange(setHookEnabled(hooks, hook, true));
                            onModeChange(v === 'monitor' ? 'monitor' : 'enforce');
                          }}
                        />
                      </Table.Td>

                      <Table.Td ta="right">
                        <Text size="xs">
                          {telemetry ? telemetry.calls.toLocaleString() : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text
                          size="xs"
                          c={telemetry && telemetry.blockRatePct > 0 ? 'red.7' : 'dimmed'}
                        >
                          {telemetry ? `${telemetry.blockRatePct.toFixed(1)}%` : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="xs" c="dimmed">
                          {telemetry?.p95LatencyMs != null ? `${telemetry.p95LatencyMs} ms` : '—'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>

          {/* The detail panel sits OUTSIDE the scrolling grid on purpose: as a
              colSpan row it would slide underneath the sticky hook column, and
              its own controls would inherit a horizontal scroll they have no
              reason to have. */}
          {openHook && (
            <>
              <Divider />
              <Box p="md" style={{ background: 'var(--ds-surface-1)' }}>
                <HookDetailPanel
                  hook={openHook}
                  hooks={hooks}
                  binding={hooks.bindings?.[openHook]}
                  mode={mode}
                  onModeChange={onModeChange}
                  policies={policiesOn(openHook)}
                  issues={issuesFor(openHook)}
                  streamCost={streamCost}
                  charsPerSecond={charsPerSecond}
                  onCharsPerSecondChange={setCharsPerSecond}
                  onHookEnabledChange={(enabled) =>
                    onChange(setHookEnabled(hooks, openHook, enabled))
                  }
                  onScheduleChange={(schedule) =>
                    onChange(setHookSchedule(hooks, openHook, schedule))
                  }
                  onBindingChange={(patch) => onChange(withBinding(hooks, openHook, patch))}
                  onStreamChange={patchStream}
                  onPolicyChange={patchPolicy}
                  onOpenPolicy={onOpenPolicy}
                  onClose={() => setOpenHook(null)}
                  readOnly={readOnly}
                />
              </Box>
            </>
          )}
        </Paper>
      )}

      {allColumns.length > 0 && (
        <Text size="xs" c="dimmed">
          A filled cell runs, a hollow one could and does not, and an em-dash is a hook that policy
          cannot serve — the tooltip says why. Click a column header to open the policy, a row to
          open its hook settings. <strong>Enforcement</strong> is per hook: whether the request
          waits for the checks there, and whether a finding stops it. <strong>Mode</strong> belongs
          to the whole guardrail, so changing one row&apos;s mode changes every row; only switching
          a hook off is per row.
          {hiddenCount > 0 && ` ${hiddenCount} disabled policy${hiddenCount === 1 ? ' is' : 's are'} hidden.`}
        </Text>
      )}
    </Stack>
  );
}

// ── grid pieces ───────────────────────────────────────────────────────────

/**
 * The hook column has to stay put while the policy columns scroll: with a dozen
 * policies the grid is wider than the panel, and a matrix whose row labels scroll
 * away is unreadable at exactly the size where it starts to matter.
 */
function stickyCell(zIndex: number, highlighted = false): CSSProperties {
  return {
    position: 'sticky',
    left: 0,
    zIndex,
    background: highlighted ? 'var(--ds-surface-1)' : 'var(--ds-surface-raised)',
    boxShadow: '1px 0 0 var(--mantine-color-default-border)',
  };
}

function ColumnHeader({
  column,
  onOpenPolicy,
}: {
  column: MatrixColumn;
  onOpenPolicy?: (policyId: string) => void;
}) {
  const tooltip = (
    <Stack gap={2}>
      <Text size="xs" fw={600}>
        {column.name}
      </Text>
      <Text size="xs" ff="monospace">
        {column.family} · {column.policyId}
      </Text>
      <Text size="xs">{familyMeta(column.family)?.description}</Text>
      {!column.enabled && <Text size="xs">Disabled — it runs nowhere until it is switched on.</Text>}
      {column.lifted && (
        <Text size="xs">Derived from the legacy policy; saving promotes it to an authored policy.</Text>
      )}
      {onOpenPolicy && <Text size="xs">Click to open this policy.</Text>}
    </Stack>
  );

  const body = (
    <Stack gap={2} align="center" style={{ opacity: column.enabled ? 1 : 0.55 }}>
      <Text size="xs" fw={600} ta="center" lineClamp={2} style={{ lineHeight: 1.25 }}>
        {column.name}
      </Text>
      <Badge size="xs" variant="light" color={column.enabled ? 'blue' : 'gray'}>
        {column.family}
      </Badge>
    </Stack>
  );

  return (
    <Tooltip label={tooltip} multiline w={300} withArrow position="top" openDelay={200}>
      {onOpenPolicy ? (
        <UnstyledButton
          onClick={() => onOpenPolicy(column.policyId)}
          aria-label={`Open policy ${column.name}`}
          style={{ width: '100%', paddingBottom: 2 }}
        >
          {body}
        </UnstyledButton>
      ) : (
        <Box style={{ width: '100%', cursor: 'help' }}>{body}</Box>
      )}
    </Tooltip>
  );
}

function MatrixCellToggle({
  column,
  hook,
  state,
  blockedReason,
  hookOn,
  readOnly,
  onToggle,
}: {
  column: MatrixColumn;
  hook: HookId;
  state: MatrixCell;
  blockedReason?: string;
  hookOn: boolean;
  readOnly?: boolean;
  onToggle: (next: boolean) => void;
}) {
  const short = HOOK_META[hook].short;

  if (state === 'invalid') {
    const why =
      blockedReason ??
      `${familyLabel(column.family)} has no subject to work on at ${short}.`;
    return (
      <Tooltip label={why} multiline w={320} withArrow position="top" openDelay={200}>
        <Box style={{ cursor: 'help' }}>
          <Text size="xs" c="dimmed">
            —
          </Text>
        </Box>
      </Tooltip>
    );
  }

  // A cell that is on while the policy can no longer legally take the hook: the
  // server will reject it, so it is drawn as a warning rather than silently
  // normalised away.
  const conflicted = state === 'on' && !column.validHooks.includes(hook);
  const why = conflicted
    ? `${column.name} is bound to ${short} but can no longer run there. Fix the policy or untick this cell — the server refuses to save it as it stands.`
    : state === 'on'
      ? hookOn
        ? `${column.name} runs at ${short}. Click to unbind.`
        : `${column.name} is bound to ${short}, but that hook is switched off, so it never runs.`
      : `${column.name} does not run at ${short}. Click to bind it here.`;

  return (
    <Tooltip label={why} multiline w={300} withArrow position="top" openDelay={200}>
      <Box display="inline-flex">
        <UnstyledButton
          onClick={() => onToggle(state !== 'on')}
          disabled={readOnly}
          role="switch"
          aria-checked={state === 'on'}
          aria-label={`${column.name} at ${short}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 22,
            borderRadius: 4,
            cursor: readOnly ? 'default' : 'pointer',
          }}
        >
          <Box
            style={{
              width: 11,
              height: 11,
              borderRadius: '50%',
              background:
                state === 'on'
                  ? conflicted
                    ? 'var(--mantine-color-orange-6)'
                    : 'var(--mantine-color-teal-6)'
                  : 'transparent',
              border:
                state === 'on' ? 'none' : '1.5px solid var(--mantine-color-dimmed)',
              opacity: state === 'on' ? 1 : 0.6,
            }}
          />
        </UnstyledButton>
      </Box>
    </Tooltip>
  );
}

function EmptyMatrix({
  onAddPolicy,
  presetMenu,
  readOnly,
}: {
  onAddPolicy?: () => void;
  presetMenu: ReactNode;
  readOnly?: boolean;
}) {
  return (
    <Paper withBorder radius="md" p="xl">
      <Stack align="center" gap="xs">
        <ThemeIcon size={40} radius="md" variant="light" color="gray">
          <IconLayoutGrid size={20} />
        </ThemeIcon>
        <Text fw={600} size="sm">
          No policies to place yet
        </Text>
        <Text size="xs" c="dimmed" ta="center" maw={520}>
          This grid answers one question — <em>where does each policy run?</em> — so it needs a policy
          before it can show anything. Add one on the Policies tab and it appears here as a column you
          can bind to every hook it is able to serve, or start from a preset that arrives already
          bound.
        </Text>
        <Group gap="xs" mt="xs">
          {onAddPolicy && (
            <Button
              size="xs"
              leftSection={<IconPlus size={13} />}
              onClick={onAddPolicy}
              disabled={readOnly}
            >
              Add policy
            </Button>
          )}
          {presetMenu}
        </Group>
      </Stack>
    </Paper>
  );
}

// ── the hook detail panel ─────────────────────────────────────────────────

function HookDetailPanel({
  hook,
  hooks,
  binding,
  mode,
  onModeChange,
  policies,
  issues,
  streamCost,
  charsPerSecond,
  onCharsPerSecondChange,
  onHookEnabledChange,
  onScheduleChange,
  onBindingChange,
  onStreamChange,
  onPolicyChange,
  onOpenPolicy,
  onClose,
  readOnly,
}: {
  hook: HookId;
  hooks: GuardrailHooksConfig;
  binding: HookBinding | undefined;
  mode: GuardrailMode;
  onModeChange: (mode: GuardrailMode) => void;
  policies: GuardrailPolicy[];
  issues: HookIssue[];
  streamCost: StreamCostEstimate;
  charsPerSecond: number;
  onCharsPerSecondChange: (value: number) => void;
  onHookEnabledChange: (enabled: boolean) => void;
  onScheduleChange: (schedule: HookSchedule) => void;
  onBindingChange: (patch: Partial<HookBinding>) => void;
  onStreamChange: (patch: Partial<StreamGuardSettings>) => void;
  onPolicyChange: (policyId: string, patch: (policy: GuardrailPolicy) => GuardrailPolicy) => void;
  onOpenPolicy?: (policyId: string) => void;
  onClose: () => void;
  readOnly?: boolean;
}) {
  // `Partial<>`: `enabled` is required on the persisted shape, so a bare `{}`
  // fallback would not be assignable to it.
  const stream: Partial<StreamGuardSettings> = hooks.stream ?? {};
  const on = binding?.enabled === true;
  const schedule = scheduleFor(binding);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="sm" fw={600}>
            {HOOK_META[hook].label}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {HOOK_META[hook].short}
          </Text>
        </div>
        <Button size="compact-xs" variant="subtle" onClick={onClose}>
          Close
        </Button>
      </Group>

      <Text size="xs" c="dimmed" maw={760}>
        {HOOK_META[hook].description}
      </Text>

      {issues.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={15} />} p="xs">
          <Stack gap={2}>
            {issues.map((issue, i) => (
              <Text size="xs" key={i}>
                <Text span fw={600} size="xs">
                  {issue.policyName}
                </Text>
                {' — '}
                {issue.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Group align="flex-start" gap="lg" wrap="wrap">
        <Select
          size="xs"
          w={230}
          label="Mode"
          description="Belongs to the guardrail, not this hook. Only Off is per hook."
          data={[
            ...MODE_DATA.slice(0, 2),
            { value: 'disabled' as GuardrailMode, label: 'Off — this hook runs nothing' },
          ]}
          value={on && mode !== 'disabled' ? mode : 'disabled'}
          disabled={readOnly}
          onChange={(v) => {
            if (v === 'disabled') {
              onHookEnabledChange(false);
              return;
            }
            if (!on) onHookEnabledChange(true);
            onModeChange(v === 'monitor' ? 'monitor' : 'enforce');
          }}
        />
        {/* Was a Timing select beside an On failure select — four cells for
            three states, with the fourth greyed out. One control now; the
            mapping onto the unchanged stored `schedule` is in ENFORCEMENT_META. */}
        <Select
          size="xs"
          w={250}
          label="Enforcement"
          description="Whether the request waits for these checks, and whether a finding stops it."
          data={ENFORCEMENT_DATA_LONG}
          value={toEnforcement(schedule)}
          disabled={readOnly || !on}
          onChange={(v) => onScheduleChange(fromEnforcement(asEnforcement(v)))}
        />
        {/* `GuardrailHookBinding.timeoutMs`. Described for what it ACTUALLY is:
            this console's engine bounds a policy with `min(policy.timeoutMs,
            scope.budgetMs)` (`resolveBudgetMs`, families/llm.ts) and
            `scope.budgetMs` comes from the CALLER, not from this field — the
            only reader of this one is `summarizeHooks`, which publishes it to
            client-API consumers. Saying "wall clock for this hook" flatly, as
            this control used to, promises an enforcement that does not happen
            here. The per-policy limit is the one to reach for. */}
        <NumberInput
          size="xs"
          w={230}
          label="Time limit (ms)"
          description="Published to API clients as this hook's budget. 0 means no limit, which is what every legacy guardrail has. A policy's own time limit is what this console enforces."
          min={0}
          max={120_000}
          step={100}
          value={binding?.timeoutMs ?? 0}
          disabled={readOnly}
          onChange={(v) => onBindingChange({ timeoutMs: typeof v === 'number' ? v : 0 })}
        />
        {/* Same words as the per-policy control in the drawer, because it is
            the same question at a wider scope. The engine resolves it policy →
            binding → record (`policyFailMode(policy, binding.failMode ??
            record.failMode)`, hooks/engine), so this really is the middle rung
            and the description says so. Never about what a check FINDS — only
            about a check that could not run at all. */}
        <Select
          size="xs"
          w={230}
          label="If a check cannot run"
          description="Used by the policies here that set none of their own."
          data={[
            { value: 'open', label: 'Let the content through' },
            { value: 'closed', label: 'Block it' },
          ]}
          value={binding?.failMode ?? 'open'}
          disabled={readOnly}
          onChange={(v) => onBindingChange({ failMode: v === 'closed' ? 'closed' : 'open' })}
        />
      </Group>

      {/* ── what runs here ── */}
      <div>
        <Text size="xs" fw={600} mb={4}>
          Policies running here
        </Text>
        {policies.length === 0 ? (
          <Text size="xs" c="dimmed">
            Nothing runs at this point yet. Fill a cell in this row to bind a policy to it.
          </Text>
        ) : (
          <Stack gap={6}>
            {policies.map((policy) => (
              <Paper key={policy.id} withBorder radius="sm" p="xs">
                <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
                  <Group gap="xs" wrap="wrap">
                    <Badge size="xs" variant="light">
                      {familyLabel(policy.family)}
                    </Badge>
                    <Text size="xs" fw={600}>
                      {policyDisplayName(policy)}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {policy.id}
                    </Text>
                    {/* `policy.action`, or the note that it has none of its
                        own. NOT "guardrail default" any more: nobody sets a
                        guardrail-wide default action — the record's `action`
                        column is projected FROM these policies on save. */}
                    <Badge size="xs" variant="outline" color="gray">
                      {policy.action ?? 'follows the rest'}
                    </Badge>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    {/* `runIf` is a per-POLICY field — there is no per-hook slot
                        for it in `GuardrailHookBinding` — so it is edited here
                        against the policy, not against the hook. */}
                    {LLM_FAMILIES.has(policy.family) && (
                      <Select
                        size="xs"
                        w={290}
                        aria-label={`When to spend a model call on ${policyDisplayName(policy)}`}
                        data={RUN_IF_OPTIONS}
                        value={readRunIf(policy)}
                        disabled={readOnly}
                        onChange={(v) =>
                          onPolicyChange(policy.id, (c) =>
                            writeRunIf(c, v === 'onFinding' || v === 'onSideEffect' ? v : 'always'),
                          )
                        }
                      />
                    )}
                    {onOpenPolicy && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        rightSection={<IconExternalLink size={12} />}
                        onClick={() => onOpenPolicy(policy.id)}
                      >
                        Open
                      </Button>
                    )}
                  </Group>
                </Group>
              </Paper>
            ))}
          </Stack>
        )}
        {policies.some((policy) => LLM_FAMILIES.has(policy.family)) && (
          <Text size="xs" c="dimmed" mt={6} maw={760}>
            &ldquo;When to spend a model call&rdquo; is per policy rather than per hook — a judge on
            every request is what makes a guardrail expensive, and two LLM policies on one hook rarely
            deserve the same answer. Everything else about a policy lives on the Policies tab.
          </Text>
        )}
      </div>

      {/* ── the release window, only where it exists ── */}
      {hook === STREAM_HOOK && (
        <>
          <Divider />
          <div>
            <Group gap="xs" mb={6}>
              <IconBolt size={15} />
              <Text size="xs" fw={600}>
                Release window
              </Text>
            </Group>
            <Text size="xs" c="dimmed" maw={760} mb="sm">
              Text is withheld this far behind the model, scanned, and only then written to the
              socket. That is what makes a credential catchable before it reaches the browser — and
              it is the one guardrail setting the person waiting for the answer can feel.
            </Text>

            <Group align="flex-start" gap="lg" wrap="wrap">
              <NumberInput
                size="xs"
                w={170}
                label="Hold back (chars)"
                min={16}
                max={8000}
                step={32}
                value={stream.holdBackChars ?? DEFAULT_STREAM_SETTINGS.holdBackChars}
                disabled={readOnly}
                onChange={(v) =>
                  onStreamChange({ holdBackChars: typeof v === 'number' ? v : undefined })
                }
                error={
                  streamCost.raised
                    ? `Raised to ${streamCost.holdBackChars} to cover the longest match the bound policies can produce`
                    : undefined
                }
              />
              <NumberInput
                size="xs"
                w={170}
                label="…or after (ms)"
                description="Whichever comes first"
                min={0}
                max={5000}
                step={50}
                value={stream.holdBackMs ?? DEFAULT_STREAM_SETTINGS.holdBackMs}
                disabled={readOnly}
                onChange={(v) =>
                  onStreamChange({ holdBackMs: typeof v === 'number' ? v : undefined })
                }
              />
              <Select
                size="xs"
                w={230}
                label="When a block lands mid-stream"
                data={[
                  { value: 'truncate', label: 'Truncate — end the stream' },
                  { value: 'replace', label: 'Replace — only if nothing was sent' },
                ]}
                value={stream.onBlock ?? DEFAULT_STREAM_SETTINGS.onBlock}
                disabled={readOnly}
                onChange={(v) => onStreamChange({ onBlock: v === 'replace' ? 'replace' : 'truncate' })}
              />
              <Select
                size="xs"
                w={250}
                label="If the held region overflows"
                data={[
                  { value: 'release', label: 'Release it unscanned' },
                  { value: 'terminate', label: 'Terminate the stream' },
                ]}
                value={stream.onBudgetExceeded ?? DEFAULT_STREAM_SETTINGS.onBudgetExceeded}
                disabled={readOnly}
                onChange={(v) =>
                  onStreamChange({ onBudgetExceeded: v === 'terminate' ? 'terminate' : 'release' })
                }
              />
            </Group>

            <Paper withBorder radius="sm" p="sm" mt="md" maw={760}>
              <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
                <div>
                  <Text size="xs" fw={600}>
                    Estimated added latency
                  </Text>
                  <Text size="xs" c="dimmed" maw={520}>
                    At the assumed rate. Total completion time barely moves — the final window
                    releases everything — so the cost lands on the first token and on a constant lag.
                  </Text>
                </div>
                <NumberInput
                  size="xs"
                  w={150}
                  label="Assumed rate"
                  suffix=" chars/s"
                  min={10}
                  max={2000}
                  step={10}
                  value={charsPerSecond}
                  onChange={(v) => onCharsPerSecondChange(typeof v === 'number' ? v : 160)}
                />
              </Group>

              {streamCost.gated ? (
                <Group gap="xl" mt="sm">
                  <div>
                    <Text size="lg" fw={700} lh={1.1}>
                      +{streamCost.addedTtftMs} ms
                    </Text>
                    <Text size="xs" c="dimmed">
                      to the first character
                    </Text>
                  </div>
                  <div>
                    <Text size="lg" fw={700} lh={1.1}>
                      {streamCost.steadyLagMinMs}–{streamCost.steadyLagMaxMs} ms
                    </Text>
                    <Text size="xs" c="dimmed">
                      steady lag behind the model
                    </Text>
                  </div>
                  <div>
                    <Text size="lg" fw={700} lh={1.1}>
                      {streamCost.holdBackChars}
                    </Text>
                    <Text size="xs" c="dimmed">
                      chars withheld
                      {streamCost.requiredOverlap > 0 && ` (≥ ${streamCost.requiredOverlap} required)`}
                    </Text>
                  </div>
                </Group>
              ) : (
                <Group gap="xl" mt="sm" align="flex-start">
                  <div>
                    <Text size="lg" fw={700} lh={1.1}>
                      +0 ms
                    </Text>
                    <Text size="xs" c="dimmed">
                      nothing is held back
                    </Text>
                  </div>
                  <Text size="xs" c="dimmed" maw={480}>
                    {streamCost.notGatedReason} Bind a policy with a declared match bound here and
                    the window opens to {streamCost.holdBackChars} characters, costing about{' '}
                    <strong>+{streamCost.addedTtftMs} ms</strong> to the first character at this
                    rate.
                  </Text>
                </Group>
              )}
            </Paper>

            <Text size="xs" c="dimmed" mt="sm" maw={760}>
              Only policies that declare a bounded match length can be bound here — PII with its
              obfuscation pass off, secrets, and regex rules with a{' '}
              <Text span ff="monospace" size="xs">
                maxMatchChars
              </Text>
              . A word filter cannot: its folding is length-changing, so a match has no bound in raw
              characters and no window size could make it provably correct.
            </Text>
          </div>
        </>
      )}
    </Stack>
  );
}
