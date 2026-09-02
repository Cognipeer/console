'use client';

/**
 * THE CONFIG TAB, AS A GRID OF CARDS.
 *
 * One card per policy, and a catalog behind the "Add policy" button. It
 * replaces a stacked list of wide rows, and the change is not cosmetic: a row
 * that spans the window spends most of its width on nothing, so a guardrail
 * with eight policies read as a wall of near-identical bars and the one fact an
 * operator opens this screen for — WHAT each policy is actually configured to
 * do — was the part that got clipped. A card gives that line two rows of its
 * own and puts three policies where one used to be.
 *
 * ── NOTHING HERE KNOWS WHAT A FAMILY IS ─────────────────────────────────────
 * No family name, label, colour, icon, summary, hook list or starting
 * configuration is written in this file. All of it comes from
 * `catalog/families.ts`:
 *
 *   · the card's icon, colour and family badge   → `catalogFor(family)`
 *   · the card's one-line summary                → `spec.summarise(policy)`
 *   · the family filter's options and order      → `catalogEntries()`
 *   · what the search box can match              → `fieldsOf(family)` +
 *                                                  `COMMON_POLICY_FIELDS`
 *   · a brand-new policy                         → `spec.defaults()`, via
 *                                                  `PolicyCatalogModal`
 *
 * So a tenth family appears here — filterable, searchable, summarised and
 * addable — the moment it has a catalog entry, with no edit to this file.
 * `guardrail-policy-cards.test.ts` scans this source for family literals and
 * fails if one appears.
 *
 * The two things the catalog deliberately does NOT own are read from where they
 * do live: `canBindToHook` and `HOOK_META` (`./policyFamilyMeta`), because
 * whether a policy may bind to the streaming hook depends on the guardrail's
 * bindings and on the policy's own match bound, and a second copy of that rule
 * is precisely the drift the catalog exists to remove.
 *
 * ── ONE GRID, IN STORED ORDER ───────────────────────────────────────────────
 * The array IS the order. `hooks.policies` is what the engine walks — the
 * deterministic families one after another in exactly this sequence, then the
 * model-backed and webhook ones — and it is the order the findings come back
 * in, which `logEvaluation` then persists as `findings[0].message`. So the grid
 * renders that array and NOTHING here sorts it; see `filterPolicyCards`, which
 * filters and never reorders.
 *
 * WHERE A POLICY RUNS IS THE POLICY'S OWN `hooks` FIELD, and there is no second
 * answer. A card shows the hooks it names, says which of them are switched off
 * on the Hooks tab, and that is the whole of "when does this run?". "Add policy"
 * is therefore ONE button: a new policy lands at the end of the array, and the
 * drawer that opens on it is where its hooks are chosen.
 *
 * ── WHAT SEARCH MATCHES, AND WHY IT MATTERS ─────────────────────────────────
 * Name, family, hook AND CONFIG CONTENT. "Where does this pattern run?" is the
 * question an operator actually has — they remember the regular expression, the
 * webhook host or the policy key they typed, not the name someone else gave the
 * policy — and a search over names alone answers it with an empty grid. The
 * content half is harvested through the field schema, so it covers a family
 * nobody has written yet, and it skips the values of a field marked
 * `secretValues`.
 *
 * ── WHAT THIS COMPONENT MAY NOT IMPORT ──────────────────────────────────────
 * `catalog/*`, `hooks/contract` and `./policyFamilyMeta`. `hooks/legacy` (which
 * owns the authoritative `validateGuardrailHooks`) and `hooks/engine` both
 * import the `@/lib/database` barrel and construct providers on load; either one
 * in a client bundle is a build failure.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Menu,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCopy,
  IconDots,
  IconEye,
  IconEyeOff,
  IconInfoCircle,
  IconLayoutGrid,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { HOOK_IDS, toEnforcement } from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailEnforcement,
  GuardrailFailMode,
  GuardrailMode,
  GuardrailPolicy,
  HookBinding,
  HookId,
  PolicyFamily,
  SafetyAction,
} from '@/lib/services/guardrail/hooks/contract';
import {
  COMMON_POLICY_FIELDS,
  catalogEntries,
  catalogFor,
  fieldsOf,
  summarisePolicy,
} from '@/lib/services/guardrail/catalog';
import type { PolicyFieldConfig, PolicyFieldSpec } from '@/lib/services/guardrail/catalog';
import GuardrailPolicyDrawer from './GuardrailPolicyDrawer';
import type { GuardrailPolicyDrawerProps } from './GuardrailPolicyDrawer';
// The three enforcement words, from the file that owns them. Taken from the
// vocabulary module rather than re-exported through the hooks matrix: this
// screen needs a label table, not a grid, and reaching through a 90KB client
// component for three strings is how the words end up with two homes again.
// `enforcementSummaryLabel` is the SHORT register, which is what a badge needs.
import { enforcementSummaryLabel } from './guardrailVocabulary';
import PolicyCatalogModal, { policyFamilyIcon } from './PolicyCatalogModal';
// Only the four exports the catalog deliberately does not restate. The family
// half of this module (`POLICY_FAMILY_META`, `FAMILY_PICKER_ORDER`) is the half
// the catalog replaces, and nothing here reaches for it.
import { HOOK_META, boundHooks, canBindToHook } from './policyFamilyMeta';

// ── names ───────────────────────────────────────────────────────────────────

/** The family's display name, or its id for a family with no catalog entry —
 *  never an empty badge, which reads as a broken card. */
export function policyFamilyLabel(family: PolicyFamily): string {
  return catalogFor(family)?.label ?? family;
}

/** The name a card shows: the operator's own, falling back to the family plus
 *  the policy id. Never empty. */
export function policyCardName(policy: GuardrailPolicy): string {
  const label = policy.label?.trim();
  if (label) return label;
  const family = policyFamilyLabel(policy.family);
  return policy.id ? `${family} · ${policy.id}` : family;
}

// ── search ──────────────────────────────────────────────────────────────────

/**
 * An interface is not assignable to `Record<string, unknown>` in TypeScript —
 * only a type alias gets an implicit index signature — and every policy config
 * is an interface. The schema walk is index-based by nature, so this is where
 * that fact is absorbed, once, instead of at every field.
 */
function asConfig(value: object): PolicyFieldConfig {
  return value as unknown as PolicyFieldConfig;
}

/**
 * Every string reachable from a value, plus the NAMES of the things it holds.
 *
 * Numbers and booleans are skipped on purpose. They are the terms an operator
 * never searches for and always matches by accident: with a substring haystack,
 * a query of `3` would hit an entropy floor, a match bound and a nesting limit
 * on unrelated policies, and the one useful hit would be somewhere in the
 * middle of them.
 */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 5) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectStrings(item, out, depth + 1);
    }
  }
}

/**
 * One field's searchable text, decided by its KIND — never by its family, which
 * is what makes this work for a family that does not exist yet.
 *
 * Three kinds are treated specially, and each for a reason a generic walk would
 * get wrong:
 *   · a secret-valued map contributes its NAMES only. A token an operator
 *     pasted into a header must not become a term that matches a policy, and a
 *     search index is still a place a value gets copied to.
 *   · a JSON blob contributes its top-level names only. Walking a map of JSON
 *     Schema documents would make `object`, `string` and `required` match
 *     nearly every tool-access policy on the guardrail.
 *   · a list of nested items is walked through its OWN field list, so a rule's
 *     pattern is searchable and its bookkeeping numbers are not.
 */
function collectField(spec: PolicyFieldSpec, config: PolicyFieldConfig, out: string[]): void {
  const value = config[spec.key];
  if (value === undefined || value === null) return;

  switch (spec.kind) {
    case 'json': {
      if (typeof value === 'object' && !Array.isArray(value)) {
        out.push(...Object.keys(value as Record<string, unknown>));
      }
      return;
    }
    case 'key_value': {
      if (spec.secretValues) {
        if (typeof value === 'object' && !Array.isArray(value)) {
          out.push(...Object.keys(value as Record<string, unknown>));
        }
        return;
      }
      collectStrings(value, out);
      return;
    }
    case 'item_list': {
      if (!Array.isArray(value)) return;
      for (const item of value) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const nested of spec.itemFields) collectField(nested, asConfig(item), out);
      }
      return;
    }
    default:
      collectStrings(value, out);
  }
}

/**
 * Everything the search box may match on one policy, lower-cased and joined
 * with a separator no query can contain.
 *
 * Built from the field schema rather than from a switch over families, so the
 * tenth family is searchable by its configuration the day it is declared —
 * which is the day it becomes findable at all, since nobody remembers the name
 * they gave a policy six weeks ago.
 */
export function policyCardSearchText(policy: GuardrailPolicy): string {
  const config = asConfig(policy);
  const parts: string[] = [
    policy.id,
    policy.family,
    policyFamilyLabel(policy.family),
    summarisePolicy(policy),
  ];

  // The common half covers `label`, `hooks`, `action`, `failMode`, `runIf` and
  // the per-policy block message, so none of them is listed by hand here.
  for (const spec of COMMON_POLICY_FIELDS) collectField(spec, config, parts);
  for (const spec of fieldsOf(policy.family)) collectField(spec, config, parts);

  return parts.join(' \u0000 ').toLowerCase();
}

export interface PolicyCardsQuery {
  /** Free text over name, family, hook id AND config content. */
  query?: string;
  family?: PolicyFamily | null;
  hook?: HookId | null;
}

/**
 * Filter, never sort. The stored order of `policies` IS the execution order and
 * the finding order — `logEvaluation` persists `findings[0].message` — so a grid
 * that re-sorted would show a different sequence from the one that runs.
 *
 * Every whitespace-separated term must match, so a query narrows instead of
 * widening: "regex tool" is the regular-expression policies that run on a tool
 * hook, not the union of everything regular and everything tooled.
 */
export function filterPolicyCards(
  policies: GuardrailPolicy[],
  q: PolicyCardsQuery,
): GuardrailPolicy[] {
  const needle = q.query?.trim().toLowerCase() ?? '';
  const terms = needle.length > 0 ? needle.split(/\s+/) : [];

  return policies.filter((policy) => {
    if (q.family && policy.family !== q.family) return false;
    if (q.hook && !(policy.hooks ?? []).includes(q.hook)) return false;
    if (terms.length === 0) return true;
    const haystack = policyCardSearchText(policy);
    return terms.every((term) => haystack.includes(term));
  });
}

// ── ids and copies ──────────────────────────────────────────────────────────

/**
 * A free id near `base` that no existing policy holds.
 *
 * Ids appear on every finding and in every evaluation-log row, so two policies
 * sharing one makes a finding untraceable to the rule that raised it — and the
 * server refuses the save. This is the only place a new id is minted, including
 * for a policy the catalog just made: `spec.defaults()` derives a SEED from the
 * family name and has no idea what else is on the guardrail.
 */
export function nextPolicyId(base: string, takenIds: Iterable<string>): string {
  const taken = new Set(takenIds);
  const seed = base.trim() || 'policy';
  if (!taken.has(seed)) return seed;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${seed}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable in practice; a timestamp beats throwing inside a click handler.
  return `${seed}-${Date.now()}`;
}

/**
 * A copy of a policy, with a FRESH id.
 *
 * Duplicate is the load-bearing menu item, not a convenience. `hooks.policies`
 * is an array and every element carries its own `hooks`, so "look for SQL
 * injection in tool arguments, look for internal-URL leaks in the answer" is
 * two policies of one family bound to different hooks — and this is how an
 * operator gets the second one without rebuilding a pattern list by hand.
 *
 * The `legacy:` prefix is dropped because a copy is an authored policy: it was
 * not lifted from anything, and carrying the prefix would tell the next reader
 * the migration produced it.
 *
 * JSON round-trip rather than a spread: rules, category maps, role maps and
 * argument schemas are all nested, and a shallow copy leaves the two policies
 * editing the same arrays — the classic "I changed one and both moved". The
 * blob is JSON by definition (it lives in one column), so nothing is lost.
 */
export function duplicatePolicy(
  policy: GuardrailPolicy,
  takenIds: Iterable<string>,
): GuardrailPolicy {
  const clone: GuardrailPolicy = JSON.parse(JSON.stringify(policy)) as GuardrailPolicy;
  const base = `${policy.id.replace(/^legacy:/, '') || policy.family}-copy`;
  const label = policy.label?.trim();
  return Object.assign(clone, {
    id: nextPolicyId(base, takenIds),
    label: label ? `${label} (copy)` : undefined,
  });
}

/** Hooks a policy names whose binding is switched off, i.e. where it silently
 *  never runs. The Hooks tab owns the bindings, so a card can only report it. */
export function unboundHooks(
  policy: GuardrailPolicy,
  bindings: Partial<Record<HookId, HookBinding>> | undefined,
): HookId[] {
  if (!bindings || !policy.enabled) return [];
  return (policy.hooks ?? []).filter((hook) => bindings[hook]?.enabled !== true);
}

// ── the card, as data ───────────────────────────────────────────────────────

/**
 * `neutral` it runs · `off` the hook is switched off on the Hooks tab ·
 * `ineligible` this policy cannot serve that hook at all and the server will
 * refuse the configuration.
 */
export type HookBadgeTone = 'neutral' | 'off' | 'ineligible';

export interface PolicyHookBadge {
  hook: HookId;
  tone: HookBadgeTone;
  /** Never empty. A badge that is coloured for a reason nobody states is a
   *  badge an operator cannot act on. */
  reason: string;
}

/**
 * THE EXCEPTION, AND ONLY THE EXCEPTION.
 *
 * Every policy carries a `schedule`, and `setHookSchedule` copies the hook's
 * onto every policy bound to it — so on a configuration nobody has hand-edited
 * they all agree, and a badge on every card would be nine repetitions of one
 * fact. What is worth a card's width is the policy that does NOT agree: the
 * engine reads `policy.schedule ?? binding.schedule` (`policyTiming`,
 * hooks/engine), so that policy quietly overrides the hook it runs on, and
 * nothing else on this screen would say so.
 *
 * `value` is always populated — it is what the policy stores, and the drawer
 * needs it. `differsReason` is what makes a badge appear.
 */
export interface PolicyEnforcementView {
  /** `toEnforcement(policy.schedule)` — presentation only; the stored field is
   *  still `schedule: { timing, onFail }`, untouched. */
  value: GuardrailEnforcement;
  label: string;
  /** Present ONLY when this policy is scheduled differently from a hook it
   *  actually runs on. Absent is the common case, and stays silent. */
  differsReason?: string;
}

export interface PolicyCardView {
  id: string;
  name: string;
  family: PolicyFamily;
  familyLabel: string;
  /** Mantine colour token, from the catalog. */
  color: string;
  /** The catalog's icon NAME. Resolve it with `policyFamilyIcon`. */
  icon: string;
  /** `spec.summarise(policy)` — what this policy is configured to DO. */
  summary: string;
  enabled: boolean;
  /** Lifted from the legacy columns by the migration rather than authored. */
  migrated: boolean;
  action: SafetyAction;
  /** False when the policy sets its own `action`; true when it takes the
   *  guardrail's. Two different facts, and an operator changing one needs to
   *  know which they are looking at. */
  actionInherited: boolean;
  /** How this policy is scheduled, and whether that is worth saying. */
  enforcement: PolicyEnforcementView;
  calls: number | undefined;
  /** '—' for absent telemetry. "No counts loaded" and "ran zero times" are
   *  different facts, and rendering the first as `0` invents the second. */
  callsLabel: string;
  hooks: PolicyHookBadge[];
  /** A policy bound to no hook can never run; the server refuses to save it. */
  noHook: boolean;
}


/**
 * The policy's own scheduling, and the one case where it earns a badge.
 *
 * Compared ONLY against hooks whose binding is switched on. A policy sitting on
 * a dead hook already carries an `off` badge saying it never runs there, and a
 * second badge about how that dead hook is scheduled is noise stacked on noise.
 * A disabled policy is skipped for the same reason.
 */
export function describeEnforcement(
  policy: GuardrailPolicy,
  bindings: Partial<Record<HookId, HookBinding>> | undefined,
): PolicyEnforcementView {
  const value = toEnforcement(policy.schedule);
  const view: PolicyEnforcementView = { value, label: enforcementSummaryLabel(value) };
  if (!bindings || policy.enabled === false) return view;

  const differing = boundHooks(policy).find((hook) => {
    const binding = bindings[hook];
    return binding?.enabled === true && toEnforcement(binding.schedule) !== value;
  });
  if (differing === undefined) return view;

  return {
    ...view,
    differsReason: `${view.label} on this policy, ${enforcementSummaryLabel(
      toEnforcement(bindings[differing]?.schedule),
    )} at ${HOOK_META[differing].short}. A policy's own schedule overrides the hook's, so ${
      view.label
    } is what runs.`,
  };
}

export function describePolicyCard(
  policy: GuardrailPolicy,
  options?: {
    bindings?: Partial<Record<HookId, HookBinding>>;
    guardrailAction?: SafetyAction;
    calls?: number;
  },
): PolicyCardView {
  const spec = catalogFor(policy.family);
  const dead = unboundHooks(policy, options?.bindings);
  const hooks = boundHooks(policy).map<PolicyHookBadge>((hook) => {
    const eligible = canBindToHook(policy, hook);
    if (!eligible.ok) {
      return {
        hook,
        tone: 'ineligible',
        reason: eligible.reason ?? `${policyFamilyLabel(policy.family)} cannot run at ${hook}.`,
      };
    }
    if (dead.includes(hook)) {
      return {
        hook,
        tone: 'off',
        reason: `${HOOK_META[hook].short} is switched off on the Hooks tab, so this policy never runs there.`,
      };
    }
    return { hook, tone: 'neutral', reason: HOOK_META[hook].label };
  });

  return {
    id: policy.id,
    name: policyCardName(policy),
    family: policy.family,
    familyLabel: policyFamilyLabel(policy.family),
    color: spec?.color ?? 'gray',
    icon: spec?.icon ?? '',
    summary: summarisePolicy(policy),
    enabled: policy.enabled !== false,
    migrated: policy.id.startsWith('legacy:'),
    action: policy.action ?? options?.guardrailAction ?? 'block',
    actionInherited: policy.action === undefined,
    enforcement: describeEnforcement(policy, options?.bindings),
    calls: options?.calls,
    callsLabel: options?.calls === undefined ? '—' : formatCount(options.calls),
    hooks,
    noHook: hooks.length === 0,
  };
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function actionColor(action: SafetyAction): string {
  switch (action) {
    case 'block':
      return 'red';
    case 'redact':
      return 'orange';
    case 'warn':
      return 'yellow';
    case 'flag':
      return 'blue';
    default:
      return 'gray';
  }
}

const HOOK_TONE_COLOR: Readonly<Record<HookBadgeTone, string | undefined>> = {
  neutral: undefined,
  off: 'orange',
  ineligible: 'red',
};

// ── the grid ────────────────────────────────────────────────────────────────

/**
 * What the grid holds on the drawer's behalf and hands straight back to it.
 *
 * `Pick`ed from the drawer's own props rather than restated: the grid is the
 * drawer's host, it has no opinion about any of these, and a second declaration
 * of `resources` here is a second place for the model list to fall behind the
 * four tenant resources a policy can point at.
 */
type PolicyDrawerPassThrough = Pick<
  GuardrailPolicyDrawerProps,
  'resources' | 'blockedMessage' | 'templates' | 'locale'
>;

export interface GuardrailPolicyCardsProps extends PolicyDrawerPassThrough {
  /** The guardrail's `hooks.policies`, in stored order (= execution order). */
  policies: GuardrailPolicy[];
  /**
   * The guardrail's `hooks.bindings`. Read-only here — the Hooks tab owns them
   * — but a policy bound to a switched-off hook has to SAY so, because that is
   * the silent no-op the whole hook plane exists to make visible.
   */
  bindings?: Partial<Record<HookId, HookBinding>>;
  /**
   * Calls in the last 24 hours, keyed by policy id. Passed IN: this component
   * never fetches. Absent, or a missing key, renders '—' rather than 0.
   */
  callCounts?: Record<string, number>;
  /** The guardrail's own action — what a policy with no `action` inherits. */
  guardrailAction?: SafetyAction;
  /** The guardrail's own failMode — what a policy with no `failMode` inherits. */
  guardrailFailMode?: GuardrailFailMode;
  /** The guardrail's mode, for the drawer's fail-mode note. */
  guardrailMode?: GuardrailMode;
  /** True when `hooksVersion === 0`: these policies were LIFTED from the legacy
   *  columns rather than authored, and saving promotes them. */
  derived?: boolean;
  /**
   * Any value that CHANGES when the guardrail is successfully saved — a
   * timestamp, a revision, the response's `updatedAt`.
   *
   * It exists for one rule: a policy's id may be edited only until it is
   * persisted, because from then on findings and evaluation-log rows reference
   * it and a rename orphans every one of them. This component can see a policy
   * being ADDED but has no way to see the page save it, so without this signal
   * a policy added in this session keeps an editable id for the rest of the
   * session. Optional, and everything else works without it.
   */
  savedSignal?: unknown;
  onChange: (policies: GuardrailPolicy[]) => void;
  readOnly?: boolean;
}

export default function GuardrailPolicyCards({
  policies,
  bindings,
  callCounts,
  resources,
  guardrailAction,
  guardrailFailMode,
  guardrailMode,
  blockedMessage,
  templates,
  locale,
  derived,
  savedSignal,
  onChange,
  readOnly,
}: GuardrailPolicyCardsProps) {
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<PolicyFamily | null>(null);
  const [hook, setHook] = useState<HookId | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  /**
   * Policies added in this session and not yet persisted. Only these may still
   * have their id edited: once a policy is saved, findings and evaluation-log
   * rows reference its id and renaming it orphans every one of them.
   */
  const [unsavedIds, setUnsavedIds] = useState<readonly string[]>([]);

  // Everything on screen has now been persisted, so no id is editable any more.
  useEffect(() => setUnsavedIds([]), [savedSignal]);

  const visible = useMemo(
    () => filterPolicyCards(policies, { query, family, hook }),
    [policies, query, family, hook],
  );

  const filtering = query.trim().length > 0 || family !== null || hook !== null;

  const editing = policies.find((policy) => policy.id === editingId) ?? null;
  const takenIds = policies.map((policy) => policy.id);

  const replace = (id: string, next: GuardrailPolicy) => {
    onChange(policies.map((policy) => (policy.id === id ? next : policy)));
    if (next.id !== id) {
      // The id is editable only while a policy is unsaved, so follow the rename
      // rather than losing track of it and freezing the field mid-edit.
      setUnsavedIds((prev) => (prev.includes(id) ? [...prev.filter((v) => v !== id), next.id] : prev));
      if (editingId === id) setEditingId(next.id);
    }
  };

  const insertAfter = (anchorId: string | null, created: GuardrailPolicy) => {
    const next = [...policies];
    const at = anchorId === null ? -1 : policies.findIndex((policy) => policy.id === anchorId);
    if (at === -1) next.push(created);
    else next.splice(at + 1, 0, created);
    onChange(next);
    setUnsavedIds((prev) => [...prev, created.id]);
    setEditingId(created.id);
  };

  const handleDuplicate = (policy: GuardrailPolicy) => {
    // Inserted directly after its original rather than appended: the array is
    // the execution order, and a copy an operator is about to point at a
    // different hook belongs where they were looking.
    insertAfter(policy.id, duplicatePolicy(policy, takenIds));
  };

  // Options and their ORDER come from the catalog, so the filter lists a tenth
  // family with no edit here — and lists it where the catalog says it belongs.
  const familyOptions = useMemo(
    () => catalogEntries().map((spec) => ({ value: spec.family, label: spec.label })),
    [],
  );
  const hookOptions = HOOK_IDS.map((id) => ({ value: id, label: HOOK_META[id].short }));

  return (
    <Stack gap="md">
      <Card withBorder radius="md" p="md">
        {/* ONE add button, because there is one place a policy can land: the end
            of `policies`. Where it then RUNS is the hooks it names, chosen in
            the drawer that opens on it. */}
        <Group gap="xs" wrap="nowrap" mb="sm" align="flex-start">
          <ThemeIcon size={28} radius="sm" variant="light" color="blue">
            <IconLayoutGrid size={15} />
          </ThemeIcon>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text fw={600} size="sm">
              Policies
            </Text>
            <Text size="xs" c="dimmed" maw={620}>
              Each policy is named, configured on its own, and bound to the hooks it should run on.
              They run in this order — the local checks one after another, then the model and
              webhook ones together at the end — and their findings come back in it.
            </Text>
          </div>
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            disabled={readOnly}
            onClick={() => setCatalogOpen(true)}
          >
            Add policy
          </Button>
        </Group>

        <Group gap="xs" wrap="wrap">
          <TextInput
            size="xs"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="Search policies — a name, a hook, a pattern, a host, anything you configured"
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Select
            size="xs"
            w={160}
            placeholder="Any family"
            data={familyOptions}
            value={family}
            clearable
            onChange={(value) => setFamily((value as PolicyFamily | null) ?? null)}
          />
          <Select
            size="xs"
            w={185}
            placeholder="Any hook"
            data={hookOptions}
            value={hook}
            clearable
            onChange={(value) => setHook((value as HookId | null) ?? null)}
          />
        </Group>

        {/* A count, so a filtered grid never reads as a guardrail that lost
            policies. Matching nothing is said below, in the grid's own place —
            and it is a different sentence from the empty state, because a
            guardrail with no policies at all is a different fact. */}
        {filtering && (
          <Text size="xs" c="dimmed" mt={8}>
            {visible.length} of {policies.length}{' '}
            {policies.length === 1 ? 'policy' : 'policies'} shown.
          </Text>
        )}
      </Card>

      {derived && (
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={15} />} p="xs">
          <Text size="xs">
            These policies were derived from this guardrail&apos;s legacy fields, not authored. They
            run exactly as they do today; editing one and saving promotes the whole configuration to
            an authored one, and from then on these cards decide what runs.
          </Text>
        </Alert>
      )}

      {policies.length === 0 ? (
        <Card withBorder radius="md" p="xl" style={{ borderStyle: 'dashed' }}>
          <Stack gap={6} align="center">
            <ThemeIcon size={34} radius="md" variant="light" color="gray">
              <IconLayoutGrid size={18} />
            </ThemeIcon>
            <Text size="sm" fw={600}>
              No policies yet
            </Text>
            <Text size="xs" c="dimmed" ta="center" maw={460}>
              A guardrail with no policies evaluates nothing and allows everything. Add one to say
              what to look for, and bind it to the hooks it should look at.
            </Text>
            <Button
              size="xs"
              mt={4}
              leftSection={<IconPlus size={14} />}
              disabled={readOnly}
              onClick={() => setCatalogOpen(true)}
            >
              Add policy
            </Button>
          </Stack>
        </Card>
      ) : visible.length === 0 ? (
        // NOT the empty-state copy: this guardrail HAS policies, the search is
        // simply hiding them. Telling an operator it has none is how somebody
        // writes a rule that already exists a second time.
        <Text size="xs" c="dimmed" ta="center" py="lg">
          None of the {policies.length} {policies.length === 1 ? 'policy' : 'policies'} on this
          guardrail matches the current search.
        </Text>
      ) : (
        // ONE GRID, IN STORED ORDER — which is the order they run in and the
        // order their findings come back in. `filterPolicyCards` filters and
        // never sorts, so what is on screen is a subsequence of what runs.
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="sm">
          {visible.map((policy) => (
            <PolicyCard
              key={policy.id}
              view={describePolicyCard(policy, {
                bindings,
                guardrailAction,
                calls: callCounts?.[policy.id],
              })}
              readOnly={readOnly}
              onEdit={() => setEditingId(policy.id)}
              onDuplicate={() => handleDuplicate(policy)}
              onToggleEnabled={() =>
                replace(policy.id, Object.assign({}, policy, { enabled: policy.enabled === false }))
              }
              onDelete={() => onChange(policies.filter((other) => other.id !== policy.id))}
            />
          ))}
        </SimpleGrid>
      )}

      <PolicyCatalogModal
        opened={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onSelect={(created) => {
          setCatalogOpen(false);
          // A fresh policy is configured with nothing, so an active search or
          // family filter would hide the card the operator just added — which
          // reads as "the button did not work".
          setQuery('');
          setFamily(null);
          setHook(null);
          // The catalog derives a SEED id from the family name and stops there;
          // it has no idea what else is on this guardrail. Minting the free id
          // is the caller's job, and this is the caller.
          //
          // Appended, never inserted: a new policy has nothing configured yet,
          // so there is no honest place for it among rules that do — and the
          // end of the array is where an operator watching the grid will look.
          insertAfter(null, Object.assign(created, { id: nextPolicyId(created.id, takenIds) }));
        }}
      />

      {editing && (
        <GuardrailPolicyDrawer
          // Keyed on the policy: the drawer copies the policy into a draft on
          // open, and swapping the prop under a mounted instance would show the
          // previous policy's unapplied edits against the new policy's name.
          key={editing.id}
          opened
          policy={editing}
          bindings={bindings}
          resources={resources}
          guardrailAction={guardrailAction}
          guardrailFailMode={guardrailFailMode}
          guardrailMode={guardrailMode}
          blockedMessage={blockedMessage}
          templates={templates}
          locale={locale}
          derived={derived}
          isNew={unsavedIds.includes(editing.id)}
          readOnly={readOnly}
          onApply={(next) => replace(editing.id, next)}
          onDuplicate={() => handleDuplicate(editing)}
          onClose={() => setEditingId(null)}
        />
      )}
    </Stack>
  );
}

// ── one card ────────────────────────────────────────────────────────────────

function PolicyCard({
  view,
  readOnly,
  onEdit,
  onDuplicate,
  onToggleEnabled,
  onDelete,
}: {
  view: PolicyCardView;
  readOnly?: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const FamilyIcon = policyFamilyIcon(view.icon);

  return (
    <Card
      withBorder
      radius="md"
      p="md"
      h="100%"
      // The whole card opens the drawer for the mouse. It deliberately does NOT
      // become a `role="button"`: it contains a menu button, and a control
      // nested inside a control is unreachable to a screen reader and a keyboard
      // — the card's NAME is a real button instead, so both routes exist.
      onClick={onEdit}
      style={{
        cursor: 'pointer',
        // Dimmed, never hidden. A disabled policy is still part of the
        // configuration an operator is reading, and hiding it is how someone
        // concludes a rule was deleted and writes it a second time.
        opacity: view.enabled ? undefined : 0.55,
      }}
    >
      <Stack gap="xs" h="100%" justify="space-between">
        <Stack gap="xs">
          <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
            <Group gap="sm" align="flex-start" wrap="nowrap" style={{ minWidth: 0 }}>
              <ThemeIcon size={30} radius="sm" variant="light" color={view.color}>
                <FamilyIcon size={16} />
              </ThemeIcon>
              <div style={{ minWidth: 0 }}>
                <UnstyledButton
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit();
                  }}
                  style={{ minWidth: 0, textAlign: 'left', display: 'block' }}
                >
                  <Text fw={600} size="sm" lineClamp={1}>
                    {view.name}
                  </Text>
                </UnstyledButton>
                <Group gap={4} mt={3} wrap="wrap">
                  <Badge size="xs" variant="light" color={view.color}>
                    {view.familyLabel}
                  </Badge>
                  {!view.enabled && (
                    <Badge size="xs" variant="default">
                      disabled
                    </Badge>
                  )}
                  {view.migrated && (
                    <Tooltip
                      label="Derived from this guardrail's legacy fields by the migration, not authored here."
                      withArrow
                      multiline
                      w={260}
                    >
                      <Badge size="xs" variant="outline" color="gray">
                        migrated
                      </Badge>
                    </Tooltip>
                  )}
                </Group>
              </div>
            </Group>

            {/* The menu lives inside a clickable card, so the click stops here
                rather than also opening the drawer behind it. */}
            <Box onClick={(event) => event.stopPropagation()}>
              <Menu shadow="md" width={200} position="bottom-end">
                <Menu.Target>
                  <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${view.name}`}>
                    <IconDots size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconPencil size={14} />} onClick={onEdit}>
                    Edit
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconCopy size={14} />}
                    disabled={readOnly}
                    onClick={onDuplicate}
                  >
                    Duplicate
                  </Menu.Item>
                  <Menu.Item
                    leftSection={view.enabled ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    disabled={readOnly}
                    onClick={onToggleEnabled}
                  >
                    {view.enabled ? 'Disable' : 'Enable'}
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={14} />}
                    disabled={readOnly}
                    onClick={onDelete}
                  >
                    Delete
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Box>
          </Group>

          {/* The line the grid exists for: what this policy is configured to
              do, not what kind of thing it is. */}
          <Text size="xs" c="dimmed" lineClamp={2}>
            {view.summary}
          </Text>
        </Stack>

        <Stack gap="xs">
          <Group gap={4} wrap="wrap">
            {view.noHook ? (
              <Tooltip
                label="A policy bound to no hook can never run. The server refuses to save it."
                withArrow
                multiline
                w={240}
              >
                <Badge
                  size="xs"
                  color="orange"
                  variant="light"
                  leftSection={<IconAlertTriangle size={9} />}
                >
                  no hook
                </Badge>
              </Tooltip>
            ) : (
              view.hooks.map((badge) => (
                <Tooltip key={badge.hook} label={badge.reason} withArrow multiline w={280} position="top">
                  <Badge
                    size="xs"
                    variant={badge.tone === 'neutral' ? 'default' : 'light'}
                    color={HOOK_TONE_COLOR[badge.tone]}
                    style={{ fontFamily: 'monospace', textTransform: 'none' }}
                  >
                    {badge.hook}
                  </Badge>
                </Tooltip>
              ))
            )}
          </Group>

          <Group justify="space-between" align="center" wrap="nowrap">
            <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
              {/* WHAT IT DOES WHEN IT FINDS SOMETHING — always shown, because it
                  is the one thing a policy is for. An outline badge means the
                  policy names no action of its own; nobody authors a
                  guardrail-wide default any more, so what it follows is the
                  record's `action` column, which is itself worked out from the
                  policies that DO name one. */}
              <Tooltip
                label={
                  view.actionInherited
                    ? 'No action of its own — it follows the rest of this guardrail.'
                    : 'Set on this policy.'
                }
                withArrow
                multiline
                w={240}
              >
                <Badge
                  size="sm"
                  variant={view.actionInherited ? 'outline' : 'light'}
                  color={actionColor(view.action)}
                >
                  {view.action}
                </Badge>
              </Tooltip>

              {/* …and how it is scheduled, ONLY where that departs from the hook
                  it runs on. See `describeEnforcement`: the common case is
                  agreement, and a badge on every card would say nothing. */}
              {view.enforcement.differsReason && (
                <Tooltip label={view.enforcement.differsReason} withArrow multiline w={300}>
                  <Badge
                    size="sm"
                    variant="light"
                    color="violet"
                    leftSection={<IconAlertTriangle size={9} />}
                  >
                    {view.enforcement.label}
                  </Badge>
                </Tooltip>
              )}
            </Group>

            <Tooltip label="Evaluations in the last 24 hours" withArrow>
              <Group gap={4} align="baseline" wrap="nowrap">
                <Text size="sm" fw={600} lh={1.1}>
                  {view.callsLabel}
                </Text>
                <Text size="10px" c="dimmed">
                  24h
                </Text>
              </Group>
            </Tooltip>
          </Group>
        </Stack>
      </Stack>
    </Card>
  );
}
