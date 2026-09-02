'use client';

/**
 * ONE policy's whole form, in a right-hand drawer.
 *
 * ── WHY A DRAWER AND NOT A `FormShell` ──────────────────────────────────────
 * The repo rule is that every create/edit screen is a full-screen `FormShell`
 * overlay and a small `Modal` is only for a confirm. This is a DELIBERATE
 * divergence, asked for directly: the policies live on cards, and clicking a
 * card should open that card rather than replace the page it sits on. Losing
 * the list is what makes the existing full-screen editor feel like a detour
 * from the guardrail rather than a part of it, and the operator's next action
 * after editing one policy is almost always to look at the next one.
 *
 * The two things `FormShell` gives that a bare `Drawer` does not are rebuilt
 * here rather than abandoned, because they are the reasons the rule exists:
 *   · a Cancel that actually cancels — the drawer edits a DRAFT, and closing
 *     with changes asks before throwing them away;
 *   · an outstanding-work summary — `collectPolicyIssues` is shown in the
 *     footer and beside the section each issue belongs to.
 * `FormSection` / `FormRow` / `FormField` / `ToggleRow` are reused verbatim, so
 * a field in here looks like a field everywhere else in the console.
 *
 * ── FOUR QUESTIONS, THEN ONE DISCLOSURE ─────────────────────────────────────
 * The form used to ask for roughly fourteen decisions at once, several of them
 * saying the same thing in different words. It now asks FOUR, and everything
 * else is behind a single collapsed section:
 *   1. Name          — what this policy is shown as.
 *   2. Where it runs — the six hooks, with the ineligible ones DISABLED AND
 *                      EXPLAINED. Never silently greyed: a greyed toggle with
 *                      no reason is indistinguishable from a broken screen, and
 *                      every reason `canBindToHook` gives is one an operator can
 *                      act on. This is the WHOLE of placement — the order among
 *                      the policies sharing a hook is the stored order of
 *                      `hooks.policies`, which the Config tab's grid owns.
 *   3. Config        — `basicFields(spec.fields)`. Generic. No family branch. A
 *                      `reference` field the catalog marks `inlineDetail` also
 *                      draws the referenced asset, from `RESOURCE_DETAILS`
 *                      below — keyed by resource, so still no family branch.
 *   4. When it finds
 *      something     — `action`, offered as Block / Redact / Flag, plus any
 *                      family field that decides an outcome on its own.
 *
 * ── AND THE DISCLOSURE ──────────────────────────────────────────────────────
 * ONE, not one per block, because two collapsed sections is the same "where is
 * that setting" problem in a smaller font. It holds: how it runs (the three-
 * value enforcement control that replaces timing x onFail), what happens when
 * it cannot run, when it may spend a model call, its time limit, the family's
 * own advanced fields, the block-message override, the enabled switch and the
 * id.
 *
 * TWO RULES MAKE IT SAFE TO CLOSE, and both are the difference between a
 * disclosure and a hiding place:
 *   · IT SAYS WHAT IS IN IT. `advancedContentsLine` names the controls, and
 *     `policyAdvancedChanges` shows a badge per setting that is NOT at its
 *     default — so a policy with a custom fail mode says so with the section
 *     shut. A section whose contents an operator cannot predict is a section
 *     they open every time, which is the same as not having one.
 *   · IT OPENS ITSELF ON AN ISSUE. `validatePolicyFields` does not read
 *     `advanced`, so an advanced field can be required and can fail; a form
 *     with an error nobody can reach is worse than a form with no disclosure.
 *
 * The partition itself is the CATALOG's (`basicFields` / `advancedFields`), not
 * this file's — a tenth family's split arrives with its fields.
 *
 * ── WHAT THIS FILE MAY NOT IMPORT ───────────────────────────────────────────
 * The catalog, `hooks/contract`, `hooks/messages` and `./policyFamilyMeta`.
 * Never `hooks/legacy` or `hooks/engine`: both import the `@/lib/database`
 * barrel, which constructs providers on load, and pulling either into a client
 * bundle is a build failure. The consequence is that `collectPolicyIssues` is a
 * SUBSET of `validateGuardrailHooks` and the server's errors are the ones that
 * decide a save.
 *
 * ── EVERY EXPORT BELOW THE COMPONENT IS PURE ────────────────────────────────
 * No React, no Mantine, no DOM — which is what lets `guardrail-policy-drawer.
 * test.ts` assert the three things that are actually easy to get wrong: which
 * fields a given policy renders, how issues aggregate, and which message is in
 * force.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Divider,
  Drawer,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconCopy,
  IconInfoCircle,
  IconRotate,
  IconShieldQuestion,
} from '@tabler/icons-react';
import {
  FormField,
  FormRow,
  FormSection,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import PolicyFieldRenderer, {
  describedOption,
  selectData,
} from '@/components/guardrails/PolicyFieldRenderer';
import type {
  PolicyFieldResourceDetails,
  PolicyFieldResources,
} from '@/components/guardrails/PolicyFieldRenderer';
import PiiCategoryEditor from '@/components/guardrails/PiiCategoryEditor';
import {
  COMMON_POLICY_FIELDS,
  SAFETY_ACTION_OPTIONS,
  advancedFields,
  basicFields,
  basicOptions,
  catalogFor,
  defaultPolicy,
  familyNeedsModel,
  validatePolicyFields,
} from '@/lib/services/guardrail/catalog';
import type {
  AnyPolicyFamilySpec,
  PolicyFieldConfig,
  PolicyFieldIssue,
  PolicyFieldOption,
  PolicyFieldSpec,
} from '@/lib/services/guardrail/catalog';
import {
  BLOCK_MESSAGE_VARS,
  GUARDRAIL_ENFORCEMENTS,
  HOOK_IDS,
  POLICY_FAMILIES,
  fromEnforcement,
  toEnforcement,
} from '@/lib/services/guardrail/hooks/contract';
// The one home for the three enforcement words; see the banner above
// ENFORCEMENT_OPTIONS.
import { ENFORCEMENT_VOCABULARY, enforcementSummaryLabel } from './guardrailVocabulary';
import type {
  BlockedMessageSettings,
  BlockReasonClass,
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
  BLOCK_REASON_FOR_FAMILY,
  describePolicyBlockMessage,
} from '@/lib/services/guardrail/hooks/messages';
import type {
  BlockMessageSource,
  BlockMessageTemplates,
} from '@/lib/services/guardrail/hooks/messages';
import { HOOK_META, canBindToHook, familyLabel, familyMeta, policyDisplayName } from './policyFamilyMeta';

// ════════════════════════════════════════════════════════════════════════════
// PURE HELPERS — everything the unit test exercises
// ════════════════════════════════════════════════════════════════════════════

/** The common fields, by key, so a section can name the one it wants without
 *  restating its label, help or options. */
const COMMON_BY_KEY: ReadonlyMap<string, PolicyFieldSpec> = new Map(
  COMMON_POLICY_FIELDS.map((field) => [field.key, field]),
);

/**
 * A policy as the renderer's bag-of-keys view.
 *
 * The two-step cast is REQUIRED, not laziness: the nine configuration
 * interfaces deliberately have no index signature, because an index signature
 * would defeat `fieldsFor<C>()`'s compile-time key check — the one thing that
 * makes renaming a field in `types.domain.ts` break the catalog instead of
 * leaving a control bound to a property nothing reads. Widening happens here,
 * once, with a name on it.
 */
export function asFieldConfig(policy: GuardrailPolicy): PolicyFieldConfig {
  return policy as unknown as PolicyFieldConfig;
}

/** One of `GuardrailPolicyBase`'s fields, straight from the catalog. Returns
 *  `undefined` rather than throwing so a renamed base field is a missing
 *  control and a failing test, not a blank drawer. */
export function commonField(key: string): PolicyFieldSpec | undefined {
  return COMMON_BY_KEY.get(key);
}

/**
 * The fields that are actually drawn for a config as it stands right now.
 *
 * `visibleWhen` is progressive disclosure — `secrets.minEntropy` means nothing
 * while `genericHighEntropy` is off — and it is applied HERE as well as in the
 * renderer so a section can count its own contents and decide whether it is
 * worth a heading without rendering anything first.
 */
export function visiblePolicyFields(
  fields: readonly PolicyFieldSpec[],
  config: PolicyFieldConfig,
): PolicyFieldSpec[] {
  return fields.filter((field) => !field.visibleWhen || field.visibleWhen(config));
}

/**
 * Is this family field about the OUTCOME rather than the detection?
 *
 * Generic by construction: the test is whether the field chooses from the
 * SHARED action ladder — identity against the very array `catalog/fields.ts`
 * exports, not a family name and not a key name. A tenth family that adds a
 * top-level "what to do when this matches" select lands in block 4 with no
 * change here.
 *
 * The two extra conditions are what stop it doing damage:
 *   · a field carrying a `group` stays where its family put it. The one real
 *     example today is `tool_access.sideEffectActions`, which is an action map
 *     that is meaningless without the `sideEffects` classification directly
 *     above it under the same heading; lifting it into block 4 would separate a
 *     table from its key.
 *   · a NESTED field (a regex rule's `action`) is not liftable at all — it
 *     belongs to one item of a list.
 *
 * Consequence worth stating plainly: today this lifts NOTHING. Every existing
 * action-choosing family field is either grouped or nested, and PII's
 * `actionOverride` chooses a rendering strategy rather than a safety action, so
 * it has its own option set and correctly stays in Config. The predicate is the
 * extension point, and `outcomeFieldsElsewhere` is what keeps block 4 honest in
 * the meantime.
 */
export function isOutcomeField(spec: PolicyFieldSpec): boolean {
  if (spec.group !== undefined) return false;
  if (spec.kind !== 'select' && spec.kind !== 'key_enum') return false;
  return spec.options === SAFETY_ACTION_OPTIONS;
}

export interface PolicyFormLayout {
  /** The family's own configuration, in declaration order — block 3, open. */
  config: PolicyFieldSpec[];
  /** The same family's fields that the CATALOG marks advanced. They render
   *  inside the one disclosure, under the family's own name. */
  configAdvanced: PolicyFieldSpec[];
  /** Family fields that belong in "When it finds something" instead. */
  outcome: PolicyFieldSpec[];
}

/**
 * Which fields this policy renders, and where they go.
 *
 * Everything here is derived from the catalog: the family's own `fields`, the
 * `visibleWhen` predicates evaluated against THIS policy, `isOutcomeField`, and
 * — for the basic/advanced split — `basicFields` / `advancedFields`, which are
 * the ONE partition. This file deliberately does not write its own
 * `.filter((f) => !f.advanced)`: a second copy of that rule is a screen that
 * eventually disagrees with the catalog about what an operator has to read.
 *
 * A family with no catalog entry gets three empty lists rather than an
 * exception — a policy of an unknown family is still worth showing an id, a
 * name and its hooks for.
 */
export function policyFormLayout(policy: GuardrailPolicy): PolicyFormLayout {
  const spec = catalogFor(policy.family);
  const layout: PolicyFormLayout = { config: [], configAdvanced: [], outcome: [] };
  if (!spec) return layout;

  const visible = visiblePolicyFields(spec.fields, asFieldConfig(policy));
  // Outcome first: a lifted action field is neither basic config nor advanced
  // config, it is block 4. The two catalog partitions then split what is left,
  // and declaration order survives both passes.
  layout.outcome = visible.filter(isOutcomeField);
  const rest = visible.filter((field) => !isOutcomeField(field));
  layout.config = [...basicFields(rest)];
  layout.configAdvanced = [...advancedFields(rest)];
  return layout;
}

/** Config fields under a heading, in the catalog's own order, with the ungrouped
 *  ones first — which is exactly what `PolicyFieldCommon.group` promises. */
export function groupConfigFields(
  fields: readonly PolicyFieldSpec[],
): Array<{ group: string | undefined; fields: PolicyFieldSpec[] }> {
  const out: Array<{ group: string | undefined; fields: PolicyFieldSpec[] }> = [];
  for (const field of fields) {
    const last = out[out.length - 1];
    if (last && last.group === field.group) last.fields.push(field);
    else out.push({ group: field.group, fields: [field] });
  }
  return out.sort((a, b) => Number(a.group !== undefined) - Number(b.group !== undefined));
}

export interface OutcomeFieldElsewhere {
  label: string;
  /** Where it sits, in the words of the thing it sits under. */
  where: string;
  /** True when reaching it means opening the disclosure first — either because
   *  the field itself is advanced, or because the list it belongs to is. Block
   *  4's note says so, since "under Side effects" is not directions to a
   *  control that is currently collapsed. */
  advanced: boolean;
}

/**
 * Action-choosing fields that block 4 could NOT lift — grouped or nested ones.
 *
 * Block 4 is titled "When it finds something", and an operator who reads it as
 * the whole answer while a per-side-effect action table sits inside the
 * disclosure has been misled by the layout. So block 4 names them and says
 * where they are. Derived with the same option-identity test, so it cannot fall
 * behind the catalog.
 */
export function outcomeFieldsElsewhere(policy: GuardrailPolicy): OutcomeFieldElsewhere[] {
  const spec = catalogFor(policy.family);
  if (!spec) return [];
  const out: OutcomeFieldElsewhere[] = [];

  for (const field of spec.fields) {
    // A nested action is reached through its OWN list, so what decides whether
    // it is behind the disclosure is the list's advancement, not its own.
    const advanced = field.advanced === true;
    if (field.kind === 'item_list') {
      for (const nested of field.itemFields) {
        if (nested.kind !== 'select' && nested.kind !== 'key_enum') continue;
        if (nested.options !== SAFETY_ACTION_OPTIONS) continue;
        out.push({
          label: nested.label,
          where: `per ${field.label.toLowerCase().replace(/s$/, '')}`,
          advanced,
        });
      }
      continue;
    }
    if (field.kind !== 'select' && field.kind !== 'key_enum') continue;
    if (field.options !== SAFETY_ACTION_OPTIONS) continue;
    if (field.group === undefined) continue; // that one is lifted, not elsewhere
    out.push({ label: field.label, where: `under ${field.group}`, advanced });
  }
  return out;
}

/**
 * Is this a family THIS BUILD knows about?
 *
 * It happens: an older console rendering a tenant whose hooks were authored by
 * a newer one, or a family definition lost to a bad merge. The catalog already
 * degrades for exactly this case — `catalogFor` and `fieldsOf` return
 * `undefined` and `[]` rather than throwing, so a missing family is a missing
 * card and a failing test, not nine screens dying on a null label.
 *
 * `policyFamilyMeta` does NOT degrade: `familyMeta` indexes a frozen record and
 * `canBindToHook` dereferences the result, so an unknown family throws a
 * TypeError from inside the render. This predicate is the drawer's guard in
 * front of it, and the fix belongs upstream in that file.
 */
export function isKnownFamily(family: string): family is PolicyFamily {
  return (POLICY_FAMILIES as readonly string[]).includes(family);
}

export interface PolicyHookOption {
  hook: HookId;
  label: string;
  description: string;
  checked: boolean;
  /** From `canBindToHook`. */
  eligible: boolean;
  /** NEVER absent while `eligible` is false. */
  reason?: string;
  /** Bound, eligible, and the hook itself is switched off on the Hooks tab —
   *  so this policy is configured correctly and still runs nowhere. */
  hookDisabled: boolean;
}

/**
 * The six toggles, resolved.
 *
 * The description an ineligible hook shows is `canBindToHook`'s reason, not
 * `HOOK_META`'s prose: the operator's question at that moment is "why can't
 * I?", and the hook's own description does not answer it.
 */
export function policyHookOptions(
  policy: GuardrailPolicy,
  bindings?: Partial<Record<HookId, HookBinding>>,
): PolicyHookOption[] {
  const unknownFamily = !isKnownFamily(policy.family);

  return HOOK_IDS.map((hook) => {
    const eligible = unknownFamily
      ? {
          ok: false,
          reason: `This version of the console does not know the “${policy.family}” family, so it cannot say where that policy may run. Its configuration is untouched — upgrade, or edit it through the API.`,
        }
      : canBindToHook(policy, hook);
    const checked = (policy.hooks ?? []).includes(hook);
    const hookDisabled =
      checked && eligible.ok && policy.enabled && Boolean(bindings) && bindings?.[hook]?.enabled !== true;
    return {
      hook,
      label: `${HOOK_META[hook].short} — ${HOOK_META[hook].label}`,
      description: eligible.ok
        ? hookDisabled
          ? `${HOOK_META[hook].description} — but this hook is switched off on the Hooks tab, so nothing runs here yet.`
          : HOOK_META[hook].description
        : (eligible.reason ?? 'Not available for this family.'),
      checked,
      eligible: eligible.ok,
      reason: eligible.reason,
      hookDisabled,
    };
  });
}

/** Which block an issue belongs to, so it can be shown beside the control that
 *  causes it as well as in the footer count. */
export type PolicySection = 'identity' | 'placement' | 'config' | 'outcome' | 'message';

export interface PolicyDrawerIssue extends PolicyFieldIssue {
  section: PolicySection;
}

/**
 * A template variable the interpolator will leave as literal braces.
 *
 * The renderer's behaviour is deliberate — an unrecognised `{{something}}` is
 * left VERBATIM rather than blanked, so an operator learns the set is closed
 * instead of shipping a message with a hole in it — but the learning should
 * happen at save time, not in a stranger's chat window. `validateGuardrailHooks`
 * rejects one on the server; this is the same rule, said earlier.
 */
export function unknownMessageVars(message: string | undefined): string[] {
  if (typeof message !== 'string' || message.length === 0) return [];
  const allowed = new Set<string>(BLOCK_MESSAGE_VARS);
  const found = new Set<string>();
  for (const match of message.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g)) {
    const name = match[1];
    if (!allowed.has(name)) found.add(name);
  }
  return [...found];
}

/**
 * Everything wrong with this policy, in one list.
 *
 * Aggregates four sources that were previously three separate hand-written
 * switches: identity, hook binding, the catalog's own per-field validators, and
 * the block-message rule. `enabled` gates only the REQUIRED checks, mirroring
 * the server exactly — a disabled policy's configuration is not validated, so a
 * half-built one can be parked rather than finished or thrown away — while a
 * malformed value is reported either way, because it is wrong whether or not it
 * runs today.
 *
 * A SUBSET of `validateGuardrailHooks`. Every rule here is one the server also
 * applies: a client validator that is stricter blocks a save the server would
 * accept, and a looser one promises a save the server will refuse.
 */
export function collectPolicyIssues(
  policy: GuardrailPolicy,
  ctx?: { bindings?: Partial<Record<HookId, HookBinding>> },
): PolicyDrawerIssue[] {
  const issues: PolicyDrawerIssue[] = [];
  const enabled = policy.enabled !== false;

  if (!policy.id?.trim()) {
    issues.push({
      section: 'identity',
      key: 'id',
      label: 'Id',
      reason: 'required',
      message: 'Every policy needs an id — it is what its findings reference.',
    });
  }

  if (!policy.hooks?.length) {
    issues.push({
      section: 'placement',
      key: 'hooks',
      label: 'Where it runs',
      reason: 'required',
      message: 'Bound to no hook, so it can never run.',
    });
  }

  for (const option of policyHookOptions(policy, ctx?.bindings)) {
    if (!option.checked) continue;
    if (!option.eligible) {
      issues.push({
        section: 'placement',
        key: `hooks.${option.hook}`,
        label: option.hook,
        reason: 'invalid',
        message: `${option.hook}: ${option.reason ?? 'not valid for this family.'}`,
      });
    } else if (option.hookDisabled) {
      issues.push({
        section: 'placement',
        key: `hooks.${option.hook}`,
        label: option.hook,
        reason: 'invalid',
        message: `${option.hook} is switched off on the Hooks tab, so this policy never runs there.`,
      });
    }
  }

  const spec = catalogFor(policy.family);
  if (spec) {
    for (const issue of validatePolicyFields(spec.fields, asFieldConfig(policy), { enabled })) {
      issues.push({ ...issue, section: isTopLevelOutcomeIssue(spec, issue) ? 'outcome' : 'config' });
    }
  }

  const unknown = unknownMessageVars(policy.message);
  if (unknown.length > 0) {
    issues.push({
      section: 'message',
      key: 'message',
      label: 'Block message',
      reason: 'invalid',
      message: `${unknown.map((name) => `{{${name}}}`).join(', ')} ${
        unknown.length === 1 ? 'is not a variable' : 'are not variables'
      } a block message can use. The set is ${BLOCK_MESSAGE_VARS.join(', ')} — anything else reaches the end user as literal braces.`,
    });
  }

  return issues;
}

/** An issue on a lifted outcome field belongs beside the control, which block 4
 *  now owns. Nested issues (`rules[0].action`) stay in config with their rule. */
function isTopLevelOutcomeIssue(spec: AnyPolicyFamilySpec, issue: PolicyFieldIssue): boolean {
  const field = spec.fields.find((candidate) => candidate.key === issue.key);
  return field !== undefined && isOutcomeField(field);
}

/** Issues for one block. */
export function issuesForSection(
  issues: readonly PolicyDrawerIssue[],
  section: PolicySection,
): PolicyDrawerIssue[] {
  return issues.filter((issue) => issue.section === section);
}

// ════════════════════════════════════════════════════════════════════════════
// THE ONE DISCLOSURE
//
// ── SCREEN TO STORAGE, IN FULL ──────────────────────────────────────────────
// Every control on this form, and the exact property it writes. Nothing here
// is a new stored field and nothing stops being stored; what changed is how
// many of them a human is asked about, and in what words.
//
//   SCREEN                        STORED ON `GuardrailPolicy`
//   Name                          label
//   Where it runs                 hooks[]
//   When it finds something       action  (absent = inherit; the five rungs are
//                                 all still legal, three are offered — see
//                                 `basicOptions`)
//   How it runs                   schedule: { timing, onFail } — ONE select,
//                                 via fromEnforcement / toEnforcement. Block =
//                                 sync+block, Observe = sync+log, Observe
//                                 without waiting = async+log.
//   If it cannot run              failMode ('closed' = block it, 'open' = let
//                                 it through; absent = inherit). Only for a
//                                 family that can fail — the catalog's
//                                 `needsFailMode`, read through the field's own
//                                 `visibleWhen`.
//   Only run when                 runIf
//   Time limit                    timeoutMs (ms; 0/absent = no limit)
//   Enabled                       enabled
//   Block message                 message (blank = inherit)
//   Id                            id
//   the family's own fields       their own keys, from the catalog
//
// The basic/advanced partition itself stores NOTHING. `PolicyFieldSpec.advanced`
// is read only by `basicFields` / `advancedFields`; `validatePolicyFields` never
// looks at it, so hiding a control changes nothing about what saves or what
// validates — which is exactly why the disclosure has to open itself on an
// issue.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The enforcement control's three values, in words.
 *
 * ONE control where the form showed two. `timing` x `onFail` reads as four
 * combinations and `GuardrailHookSchedule` has only THREE, because an async
 * policy has already let the response go and cannot stop anything — so the
 * fourth cell was a setting nobody was refused, it was a setting that cannot
 * exist.
 *
 * STORED FIELD, UNCHANGED: `GuardrailPolicy.schedule`, still
 * `{ timing, onFail }`, written through `fromEnforcement` and read through
 * `toEnforcement` (hooks/contract). Nothing about the wire moves.
 *
 * Built by mapping the CONTRACT's own ordered list, so a fourth enforcement
 * value would be a compile error here rather than an option that silently never
 * renders. The words are deliberately the guardrail-level vocabulary at a
 * smaller scope: a guardrail in monitor mode is every one of its policies set
 * to observe, and the two are one idea rather than two features.
 *
 * The copy is NOT written here. It comes from `./guardrailVocabulary`, the one
 * home these three words have — this drawer used to carry its own phrasing of
 * them and the hooks matrix another, which is the product owner's original
 * complaint (the same thing said in different words in different places)
 * reproduced inside the fix for it. `long` is the register with room to say
 * what the option does, which is what a full-width select in a disclosure has.
 */
export const ENFORCEMENT_OPTIONS: readonly PolicyFieldOption[] = ENFORCEMENT_VOCABULARY.map(
  ({ value, long, description }) => ({ value, label: long, description }),
);

export { enforcementSummaryLabel };

/** Which band of the disclosure a control sits in. Four bands, each with a
 *  divider, so a long section is still something an eye can walk. */
export type PolicyAdvancedSection = 'behaviour' | 'family' | 'message' | 'identity';

export const ADVANCED_SECTION_TITLE: Readonly<Record<PolicyAdvancedSection, string>> = {
  behaviour: 'How it runs',
  family: 'More configuration',
  message: 'Block message',
  identity: 'This policy',
};

/** Drawing order. `as const satisfies` so a fifth band added to the union
 *  without being placed here is a compile error rather than a section that
 *  quietly never renders. */
export const ADVANCED_SECTION_ORDER = [
  'behaviour',
  'family',
  'message',
  'identity',
] as const satisfies readonly PolicyAdvancedSection[];

export interface PolicyAdvancedControl {
  /**
   * THE STORED PROPERTY THIS CONTROL WRITES.
   *
   * `schedule` for the enforcement control — one screen value, one stored
   * `{ timing, onFail }` — and `id` for identity, which is not configuration at
   * all. Every other key is a catalog field's own key, which is also how an
   * issue is matched back to the disclosure it lives in.
   */
  key: string;
  label: string;
  /** Which of the five renderings this control needs. `field` is the generic
   *  one; the other four are the ones the catalog cannot describe. */
  kind: 'enforcement' | 'failMode' | 'message' | 'id' | 'field';
  section: PolicyAdvancedSection;
  /** The catalog spec, for everything the generic renderer draws. */
  field?: PolicyFieldSpec;
  /** The catalog's own heading within the family band. */
  group?: string;
}

/**
 * EVERYTHING BEHIND THE DISCLOSURE, in the order it is drawn.
 *
 * One list, walked twice — once by the header to say what is in there and what
 * is set, once by the body to draw it. That is the whole reason it is a
 * function rather than a run of JSX: a header that names a control the body
 * does not draw (or misses one it does) is worse than no header, and this makes
 * the two the same list by construction.
 *
 * WHAT DECIDES MEMBERSHIP IS THE CATALOG, not this file:
 *   · the common half is `advancedFields(COMMON_POLICY_FIELDS)`, filtered by
 *     each field's own `visibleWhen` — which is how `failMode` being a question
 *     only for a family that can actually fail arrives here as DATA rather than
 *     as a rule this screen has to remember;
 *   · the family half is `policyFormLayout(...).configAdvanced`;
 *   · `runIf` is the one extra condition, and it is still catalog-derived:
 *     `familyNeedsModel` is computed from the family's own fields, and a family
 *     that calls no model does not read `runIf` at all.
 *
 * The enforcement control and the id are the two that are NOT catalog fields —
 * the first because its screen value and its stored value are different shapes,
 * the second because identity is not configuration.
 */
export function policyAdvancedControls(policy: GuardrailPolicy): PolicyAdvancedControl[] {
  const controls: PolicyAdvancedControl[] = [];
  const config = asFieldConfig(policy);
  const known = isKnownFamily(policy.family);

  controls.push({
    key: 'schedule',
    label: 'How it runs',
    kind: 'enforcement',
    section: 'behaviour',
  });

  for (const field of visiblePolicyFields(advancedFields(COMMON_POLICY_FIELDS), config)) {
    if (field.key === 'runIf' && known && !familyNeedsModel(policy.family)) continue;
    const kind: PolicyAdvancedControl['kind'] =
      field.key === 'failMode' ? 'failMode' : field.key === 'message' ? 'message' : 'field';
    const section: PolicyAdvancedSection =
      field.key === 'message' ? 'message' : field.key === 'enabled' ? 'identity' : 'behaviour';
    controls.push({ key: field.key, label: field.label, kind, section, field });
  }

  for (const field of policyFormLayout(policy).configAdvanced) {
    controls.push({
      key: field.key,
      label: field.label,
      kind: 'field',
      section: 'family',
      field,
      group: field.group,
    });
  }

  controls.push({ key: 'id', label: 'Id', kind: 'id', section: 'identity' });
  return controls;
}

/** The controls of one band, in order. */
export function advancedSection(
  controls: readonly PolicyAdvancedControl[],
  section: PolicyAdvancedSection,
): PolicyAdvancedControl[] {
  return controls.filter((control) => control.section === section);
}

/** The same controls in the order the bands draw them, which is the order the
 *  "In here: …" line has to name them in — a table of contents that disagrees
 *  with the page is worse than none. */
export function advancedInDrawOrder(
  controls: readonly PolicyAdvancedControl[],
): PolicyAdvancedControl[] {
  return ADVANCED_SECTION_ORDER.flatMap((section) => advancedSection(controls, section));
}

/**
 * What a value reads as in a summary badge — short, and in the control's own
 * words wherever the control has any.
 *
 * Generic over `PolicyFieldSpec`, so a tenth family's advanced field is
 * summarised without an edit here. An option-bearing control answers with its
 * OPTION LABEL rather than the stored token, because "Block it" is what the
 * operator chose and `closed` is what the database holds.
 */
export function describeFieldValue(spec: PolicyFieldSpec | undefined, value: unknown): string {
  if (value === undefined || value === null) return 'not set';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`;
  if (typeof value === 'object') {
    const size = Object.keys(value as object).length;
    return `${size} ${size === 1 ? 'entry' : 'entries'}`;
  }
  if (spec && (spec.kind === 'select' || spec.kind === 'key_enum' || spec.kind === 'multi_select')) {
    const option = spec.options.find((candidate) => candidate.value === value);
    if (option) return option.label;
  }
  if (typeof value === 'number' && spec?.kind === 'number' && spec.unit) {
    return `${value} ${spec.unit}`;
  }
  const text = String(value).trim().replace(/\s+/g, ' ');
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export interface PolicyAdvancedChange {
  key: string;
  label: string;
  /** What it is set to now. */
  value: string;
}

/**
 * THE SETTINGS IN THERE THAT ARE NOT AT THEIR DEFAULT.
 *
 * The half of the disclosure that stops it being a hiding place: a policy with
 * a fail mode of its own, or a time limit, or an enforcement of `observe`, says
 * so on the closed header instead of behind a chevron nobody clicks.
 *
 * "DEFAULT" IS THE CATALOG'S OWN `defaults()`, not a table restated here —
 * `defaultPolicy(family)` is the same fresh policy the picker mints, so
 * `custom.onMissingModel: 'error_finding'` and `moderation.categories`'s full
 * map read as untouched, which is what they are. A family this build does not
 * know has no defaults to compare against, so anything present counts as set:
 * over-reporting an unknown policy's settings is the safe direction.
 *
 * The id is deliberately never listed. It is always present and it is identity
 * rather than a setting, so a badge saying "Id: pii-outbound" on every policy
 * would be noise that makes the real badges harder to see.
 */
export function policyAdvancedChanges(
  policy: GuardrailPolicy,
  controls: readonly PolicyAdvancedControl[] = policyAdvancedControls(policy),
): PolicyAdvancedChange[] {
  const base = isKnownFamily(policy.family) ? defaultPolicy(policy.family) : undefined;
  const current = asFieldConfig(policy);
  const fallback = base ? asFieldConfig(base) : undefined;
  const out: PolicyAdvancedChange[] = [];

  for (const control of controls) {
    if (control.kind === 'id') continue;

    if (control.kind === 'enforcement') {
      const now = toEnforcement(policy.schedule);
      if (now === toEnforcement(base?.schedule)) continue;
      out.push({ key: control.key, label: control.label, value: enforcementSummaryLabel(now) });
      continue;
    }

    const value = current[control.key];
    if (same(value, fallback?.[control.key])) continue;
    out.push({
      key: control.key,
      label: control.label,
      value: describeFieldValue(control.field, value),
    });
  }
  return out;
}

/** The same normalisation `policyDraftIsDirty` compares with: key order and a
 *  cleared optional are not differences, so "set" means genuinely set. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

/**
 * "In here: …" — the closed section's own table of contents.
 *
 * A collapsed section an operator cannot predict the contents of is a section
 * they open every time, which is the same as not having one. Capped, because a
 * list of eleven labels is not a sentence anybody reads either.
 */
export function advancedContentsLine(
  controls: readonly PolicyAdvancedControl[],
  max = 5,
): string {
  const labels = controls.map((control) => control.label.toLowerCase());
  if (labels.length <= max) return labels.join(', ');
  const shown = labels.slice(0, max).join(', ');
  const rest = labels.length - max;
  return `${shown}, and ${rest} more`;
}

/**
 * Does this issue belong to a control behind the disclosure?
 *
 * By KEY, not by `PolicySection`: the sections are about which rule failed and
 * are pinned by tests that describe validation, while this is about which
 * chevron the operator has to open. Nested paths count with their owner
 * (`rules[0].pattern` belongs to `rules`), so an advanced `item_list` cannot
 * hide a broken row.
 */
export function isAdvancedIssue(
  controls: readonly PolicyAdvancedControl[],
  issue: PolicyFieldIssue,
): boolean {
  return controls.some(
    (control) =>
      issue.key === control.key ||
      issue.key.startsWith(`${control.key}[`) ||
      issue.key.startsWith(`${control.key}.`),
  );
}

/** The two lists the form draws from: what shows beside a basic block, and what
 *  shows inside the disclosure (and forces it open). */
export function partitionIssuesByDisclosure(
  controls: readonly PolicyAdvancedControl[],
  issues: readonly PolicyDrawerIssue[],
): { basic: PolicyDrawerIssue[]; advanced: PolicyDrawerIssue[] } {
  const basic: PolicyDrawerIssue[] = [];
  const advanced: PolicyDrawerIssue[] = [];
  for (const issue of issues) {
    if (isAdvancedIssue(controls, issue)) advanced.push(issue);
    else basic.push(issue);
  }
  return { basic, advanced };
}

// ── the message block's words ───────────────────────────────────────────────

/**
 * Reason-class labels.
 *
 * A KNOWING DUPLICATE of `REASON_LABEL` in `GuardrailMessagesEditor.tsx`, which
 * is module-private there. Two copies of a label set is one copy that will
 * eventually disagree, and the disagreement here is expensive in a specific
 * way: this drawer says "inherited from the Personal data default" and the
 * Messages tab is where the operator then goes looking for a row by that name.
 * It belongs in `hooks/messages.ts` beside `BLOCK_REASON_FOR_FAMILY`, which is
 * already the server-safe home of everything else keyed by reason class.
 */
export const BLOCK_REASON_LABEL: Readonly<Record<BlockReasonClass, string>> = {
  pii: 'Personal data',
  secrets: 'Credentials',
  profanity: 'Banned wording',
  moderation: 'Content policy',
  injection: 'Prompt injection',
  tool_denied: 'Tool not permitted',
  custom: 'Workspace policy',
  unavailable: 'A policy could not run',
};

/** Where an inherited message comes from, in words an operator can act on —
 *  each one names a place they can go and change it. */
export function blockMessageSourceLabel(
  source: BlockMessageSource,
  reasonClass: BlockReasonClass,
): string {
  const reason = BLOCK_REASON_LABEL[reasonClass] ?? reasonClass;
  switch (source) {
    case 'policy':
      return 'this policy';
    case 'category':
    case 'locale_category':
      return `the “${reason}” message on the Messages tab`;
    case 'policy_template':
    case 'locale_policy':
      return 'a message supplied for this policy id';
    case 'default':
    case 'locale_default':
      return 'the workspace-wide default message';
    case 'builtin':
    default:
      return `the built-in “${reason}” message`;
  }
}

export interface MessageInheritance {
  reasonClass: BlockReasonClass;
  reasonLabel: string;
  /** True when this policy's own `message` is what a block would show. */
  overridden: boolean;
  /** The one-line answer to "is this string mine?" — the label the block wears. */
  statusLabel: string;
  /** The sentence under it. */
  statusHelp: string;
  /** What is shown right now. */
  effective: string;
  /** What would be shown with this policy's message removed. The textarea's
   *  placeholder, and what Reset restores. */
  placeholder: string;
  inheritedFrom: BlockMessageSource;
  inheritedFromLabel: string;
  canReset: boolean;
  /**
   * The other families that land on this same reason class.
   *
   * This is the whole reason `GuardrailPolicy.message` exists: `regex`,
   * `custom` and `webhook` all collapse onto 'custom', so editing "the regex
   * policy's message" on the Messages tab silently rewrote the webhook
   * policy's too. Naming the neighbours is what makes that visible before the
   * operator edits the wrong one.
   */
  sharedWith: PolicyFamily[];
}

/**
 * The message block's entire vocabulary, resolved once.
 *
 * The resolution itself is `describePolicyBlockMessage`'s — deliberately, since
 * it resolves TWICE (as configured, and again with this policy's message taken
 * away) rather than re-implementing the layer order. A drawer that computed the
 * inherited value its own way is a drawer that describes a different resolution
 * from the one the engine performs, which is a worse failure than showing
 * nothing.
 */
export function describeMessageInheritance(input: {
  policy: Pick<GuardrailPolicy, 'family' | 'id' | 'message'>;
  settings?: BlockedMessageSettings;
  templates?: BlockMessageTemplates;
  locale?: string;
}): MessageInheritance {
  const origin = describePolicyBlockMessage({
    family: input.policy.family,
    message: input.policy.message,
    policyId: input.policy.id,
    settings: input.settings,
    templates: input.templates,
    locale: input.locale,
  });

  const reasonLabel = BLOCK_REASON_LABEL[origin.reasonClass] ?? origin.reasonClass;
  const inheritedFromLabel = blockMessageSourceLabel(origin.inheritedFrom, origin.reasonClass);
  const sharedWith = (Object.keys(BLOCK_REASON_FOR_FAMILY) as PolicyFamily[]).filter(
    (family) => family !== input.policy.family && BLOCK_REASON_FOR_FAMILY[family] === origin.reasonClass,
  );

  return {
    reasonClass: origin.reasonClass,
    reasonLabel,
    overridden: origin.overridden,
    statusLabel: origin.overridden
      ? 'This policy overrides it'
      : `Inherited from the ${reasonLabel} default`,
    statusHelp: origin.overridden
      ? `What someone is told when THIS policy blocks something. Clear the box to go back to ${inheritedFromLabel}.`
      : `Nothing is set here, so a block from this policy shows ${inheritedFromLabel}. Write something to override it for this policy alone.`,
    effective: origin.effective,
    placeholder: origin.inherited,
    inheritedFrom: origin.inheritedFrom,
    inheritedFromLabel,
    canReset: origin.overridden,
    sharedWith,
  };
}

// ── the draft ───────────────────────────────────────────────────────────────

/** Key order and `undefined` both normalised away: `{ a: 1 }` and
 *  `{ a: 1, b: undefined }` are the same policy, and a form that clears an
 *  optional field back to absent has not changed anything. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      out[key] = stableValue(item);
    }
    return out;
  }
  return value;
}

/**
 * Has the draft moved?
 *
 * The whole basis of "ask before closing". A comparison that reported a false
 * positive would nag on every close; one that reported a false negative would
 * throw an operator's work away silently, which is why key order and cleared
 * optionals are normalised rather than compared by reference.
 */
export function policyDraftIsDirty(a: GuardrailPolicy, b: GuardrailPolicy): boolean {
  return JSON.stringify(stableValue(a)) !== JSON.stringify(stableValue(b));
}

/**
 * The generic sentence for "what can go wrong that makes this policy unable to
 * run".
 *
 * It is generic because the CATALOG does not carry a per-family answer — the
 * one field that would say it (`failModeReason`) does not exist on
 * `PolicyFamilySpec`, and inventing a family switch here to get a better
 * sentence would be the first family branch in a screen whose entire point is
 * having none. What is said instead is true of every family with
 * `needsFailMode`, by that flag's own definition: they are exactly the families
 * that reach out of this process.
 */
const FAIL_MODE_WHY =
  'This policy depends on something outside this process — a model, an endpoint or a stored policy — and that dependency can be unreachable, throttled or slower than the budget. This is a different question from what to do when it FINDS something, which is the Action above.';

/**
 * The in-place views for `reference` fields that ask to be expanded.
 *
 * KEYED BY RESOURCE, never by family, which is the whole reason this can live
 * in a generic drawer at all: the catalog says `pii.piiPolicyKey` points at a
 * `pii_policy` and is worth expanding, and this map says what a `pii_policy`
 * looks like when it is. A tenth family referencing a PII policy is expanded
 * with no edit here, and `word_list` joins the map the day something can draw
 * one — `word_filter.customListKeys` already declares `inlineDetail`.
 *
 * Module-level so its identity is stable: it is a prop on every field, and a
 * fresh object per render would remount the panel — and its unsaved draft with
 * it — on every keystroke elsewhere in the form.
 */
const RESOURCE_DETAILS: PolicyFieldResourceDetails = {
  pii_policy: PiiCategoryEditor,
};

const NO_FAIL_MODE_WHY =
  'This policy runs in memory on the subject — no model, no network, no policy read — so there is no “it could not run” case to configure. Anything it genuinely cannot decide falls back to the guardrail’s own failure mode';

// ════════════════════════════════════════════════════════════════════════════
// THE COMPONENT
// ════════════════════════════════════════════════════════════════════════════

export interface GuardrailPolicyDrawerProps {
  opened: boolean;
  /** The policy to edit. Copied into a draft on open; the drawer never writes
   *  through to it. */
  policy: GuardrailPolicy;
  /** The edited policy, when the operator applies it. The guardrail itself is
   *  persisted by the page's own Save — this is an in-memory apply, exactly
   *  like the full-screen editor's. */
  onApply: (next: GuardrailPolicy) => void;
  onClose: () => void;
  /** Offered in the footer — the fastest route to "the same rule, elsewhere",
   *  which is the answer to "one policy has one action, wherever it runs". */
  onDuplicate?: () => void;
  /** The guardrail's `hooks.bindings`, so a policy bound to a switched-off hook
   *  can say so. Read-only here; the Hooks tab owns them. */
  bindings?: Partial<Record<HookId, HookBinding>>;
  /**
   * Option lists for `reference` fields, keyed by RESOURCE.
   *
   * `pii_policy`, `word_list`, `model`, `provider`, `secret` — the tenant
   * resources a policy can point at. Keyed by resource and never by family,
   * which is what lets a tenth family reference a model without the page
   * learning its name. `secret` has no list today and its fields are authored
   * `freeText`, so they draw a typed key rather than an empty picker.
   * A resource with no entry renders the field's own `emptyHint`, so "you have
   * no word lists yet" and "the fetch failed" do not look the same.
   */
  resources?: PolicyFieldResources;
  /** What a policy with no `action` of its own inherits. */
  guardrailAction?: SafetyAction;
  /** What a policy with no `failMode` of its own inherits. */
  guardrailFailMode?: GuardrailFailMode;
  /** enforce | monitor | disabled — decides whether fail-closed can bite. */
  guardrailMode?: GuardrailMode;
  /** The guardrail's `blockedMessage`, for the inherited wording behind block 5.
   *  Absent means the built-ins, which is the common case. */
  blockedMessage?: BlockedMessageSettings;
  /** Extra in-process template layers (a preset, a red-team preview). Never
   *  outranks the workspace's own wording — see `resolveBlockMessageTemplate`. */
  templates?: BlockMessageTemplates;
  locale?: string;
  /** `hooksVersion === 0`: lifted from the legacy columns, not authored. */
  derived?: boolean;
  /** Added in this session and not yet persisted, so the id may still change.
   *  Once saved it is fixed: findings and evaluation-log rows reference it. */
  isNew?: boolean;
  readOnly?: boolean;
}

export default function GuardrailPolicyDrawer({
  opened,
  policy,
  onApply,
  onClose,
  onDuplicate,
  bindings,
  resources,
  guardrailAction,
  guardrailFailMode,
  guardrailMode,
  blockedMessage,
  templates,
  locale,
  derived,
  isNew,
  readOnly,
}: GuardrailPolicyDrawerProps) {
  const [draft, setDraft] = useState<GuardrailPolicy>(policy);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (opened) {
      setDraft(policy);
      setConfirmDiscard(false);
      // Shut for a newly opened policy: the four basic questions are the whole
      // form until somebody asks for more. The effect below re-opens it if this
      // policy has something outstanding in there.
      setShowAdvanced(false);
    }
    // Re-seeded per OPENED POLICY, not per render: `policy` is a fresh object
    // on every parent render, and depending on it would discard keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, policy.id]);

  const spec = catalogFor(draft.family);
  // `familyMeta` now ANSWERS `undefined` for a family this build does not know
  // rather than promising a value it cannot supply, so this is a normal absent
  // case instead of the crash it used to be — a drawer that died on open left
  // the operator with no way to even READ the policy. `isKnownFamily` still
  // gates the parts that need a family the catalog can describe.
  const known = isKnownFamily(draft.family);
  const meta = known ? familyMeta(draft.family) : undefined;
  const FamilyIcon = meta?.icon ?? IconShieldQuestion;
  // The shared degradation, not a local copy of it: `familyLabel` falls back to
  // the raw family id, which is the only string that lets an operator recognise
  // the policy they need to remove.
  const draftFamilyLabel = familyLabel(draft.family);

  const layout = useMemo(() => policyFormLayout(draft), [draft]);
  const issues = useMemo(() => collectPolicyIssues(draft, { bindings }), [draft, bindings]);
  const hookOptions = useMemo(() => policyHookOptions(draft, bindings), [draft, bindings]);
  const elsewhere = useMemo(() => outcomeFieldsElsewhere(draft), [draft]);

  // The one list the disclosure's header and its body are both built from.
  const advanced = useMemo(() => policyAdvancedControls(draft), [draft]);
  const changed = useMemo(() => policyAdvancedChanges(draft, advanced), [draft, advanced]);
  const split = useMemo(
    () => partitionIssuesByDisclosure(advanced, issues),
    [advanced, issues],
  );

  /**
   * A disclosure holding a failing control is a form with an error nobody can
   * reach: `validatePolicyFields` never reads `advanced`, so an advanced field
   * can be required (`custom.onMissingModel`) and can fail. Opening is ONE-WAY
   * — it never shuts itself under someone who opened it deliberately — and the
   * dependency is the count, so a second issue on an already-open section does
   * not fight the operator for the scroll position.
   */
  useEffect(() => {
    if (split.advanced.length > 0) setShowAdvanced(true);
  }, [split.advanced.length]);

  const message = useMemo(
    () =>
      describeMessageInheritance({
        policy: draft,
        settings: blockedMessage,
        templates,
        locale,
      }),
    [draft, blockedMessage, templates, locale],
  );

  /**
   * Two specs the drawer re-labels before handing them to the generic renderer.
   *
   * A spec is plain data, so narrowing it and spreading a new value onto it is
   * the sanctioned way to say something the catalog cannot know: what the
   * GUARDRAIL's action is, and what this policy's block message would say if it
   * had none. Neither is a family branch — both would read identically for a
   * tenth family — and both keep the control itself generic.
   */
  const actionSpec = useMemo(() => {
    const base = commonField('action');
    if (!base || base.kind !== 'select') return base;
    const inherited = SAFETY_ACTION_OPTIONS.find((option) => option.value === guardrailAction);
    return {
      ...base,
      // WRITES `GuardrailPolicy.action`; cleared is absent, which is inherit.
      // BLOCK / REDACT / FLAG, and the two edge rungs only while one of them is
      // the value in hand. `basicOptions` is what re-promotes them, so a policy
      // stored with 'warn' opens on a control that can show 'warn' instead of
      // displaying the wrong rung and rewriting it on the next save.
      //
      // NOT an option-identity hazard: `isOutcomeField` and
      // `outcomeFieldsElsewhere` test `options === SAFETY_ACTION_OPTIONS` on the
      // CATALOG's own field list, and this narrowed copy never goes near either
      // — it is handed straight to the renderer. A derived options array on a
      // FAMILY field would silently stop being an action field; this one is a
      // common field and is not walked by them at all.
      options: basicOptions(base.options, draft.action),
      // The guardrail-level default action is no longer something a human sets:
      // the `action` column is PROJECTED from these policies on save, for the
      // readers that still enforce from it. So "inherit" now means "whatever the
      // rest of this guardrail does", and naming today's projected value is a
      // statement of fact rather than a pointer at a control on another tab.
      inheritLabel: inherited
        ? `Whatever the rest of this guardrail does (${inherited.label.toLowerCase()} today)`
        : base.inheritLabel,
    };
  }, [guardrailAction, draft.action]);

  const messageSpec = useMemo(() => {
    const base = commonField('message');
    if (!base || base.kind !== 'textarea') return base;
    return {
      ...base,
      label: 'Message',
      // The INHERITED wording as the placeholder, which is the single most
      // useful thing this box can show: an empty field displaying what an end
      // user would actually see makes "leave it alone" a visible, informed
      // choice rather than a blank.
      placeholder: message.placeholder,
      help: undefined,
    };
  }, [message.placeholder]);

  const dirty = policyDraftIsDirty(draft, policy);

  const set = (key: string, value: unknown) =>
    setDraft((prev) => ({ ...prev, [key]: value }) as GuardrailPolicy);

  const requestClose = () => {
    if (dirty && !readOnly) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const renderField = (field: PolicyFieldSpec) => (
    <PolicyFieldRenderer
      key={field.key}
      spec={field}
      config={asFieldConfig(draft)}
      issues={issues}
      resources={resources}
      resourceDetails={RESOURCE_DETAILS}
      readOnly={readOnly}
      onChange={set}
    />
  );

  const issueAlert = (found: readonly PolicyDrawerIssue[]) => {
    if (found.length === 0) return null;
    return (
      <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />} mt="sm" p="xs">
        <Stack gap={2}>
          {found.map((issue) => (
            <Text size="xs" key={issue.key}>
              {issue.message}
            </Text>
          ))}
        </Stack>
      </Alert>
    );
  };

  /** A basic block shows only the issues an operator can act on WITHOUT opening
   *  the disclosure. The rest are listed inside it, which is also where the
   *  control that causes them lives. */
  const sectionIssues = (section: PolicySection) =>
    issueAlert(issuesForSection(split.basic, section));

  // ── the disclosure's body ─────────────────────────────────────────────────

  const hasAdvanced = (key: string) => advanced.some((control) => control.key === key);

  /** The family band, as specs, so `groupConfigFields` can keep the catalog's
   *  own headings inside it. */
  const familyAdvancedFields = advancedSection(advanced, 'family')
    .map((control) => control.field)
    .filter((field): field is PolicyFieldSpec => field !== undefined);

  /**
   * Why a control an operator might look for is NOT in the band.
   *
   * A missing control with no explanation is the same failure as a greyed
   * toggle with no reason: indistinguishable from a broken screen. Both
   * sentences are conditions the CATALOG decided — `familyNeedsModel` and
   * `failMode`'s own `visibleWhen` — so neither is a family branch.
   */
  const behaviourNotes =
    hasAdvanced('runIf') && hasAdvanced('failMode') ? null : (
      <Stack gap={4}>
        {!hasAdvanced('runIf') && (
          <Text size="xs" c="dimmed">
            When to spend a model call is not a question here — this family runs a pass over a
            string and calls no model, so it always runs when it is bound.
          </Text>
        )}
        {!hasAdvanced('failMode') && (
          <Text size="xs" c="dimmed">
            {NO_FAIL_MODE_WHY} ({guardrailFailMode ?? 'open'}).
          </Text>
        )}
      </Stack>
    );

  /**
   * The block-message override, with the inherited wording as the placeholder
   * and a label saying which of the two is in force.
   *
   * A local rather than a component: it needs the resolved inheritance, the
   * re-labelled spec and the same `set` every other control writes through, and
   * three props of plumbing to move it out of the closure would buy nothing.
   */
  const messageBlock = (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <Badge
          size="sm"
          variant={message.overridden ? 'filled' : 'light'}
          color={message.overridden ? 'blue' : 'gray'}
        >
          {message.statusLabel}
        </Badge>
        {message.canReset && !readOnly && (
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconRotate size={13} />}
            onClick={() => set('message', undefined)}
          >
            Reset to inherited
          </Button>
        )}
      </Group>

      <Text size="xs" c="dimmed">
        {message.statusHelp}
      </Text>

      {messageSpec && renderField(messageSpec)}

      {!message.overridden && (
        <Alert color="gray" variant="light" p="xs">
          <Text size="xs">
            In force: “{message.effective}” — from {message.inheritedFromLabel}.
          </Text>
        </Alert>
      )}

      {message.sharedWith.length > 0 && (
        <Text size="xs" c="dimmed">
          {message.reasonLabel} is also the reason class for{' '}
          {message.sharedWith.map((family) => familyLabel(family)).join(', ')}. Editing the message
          on the Messages tab changes theirs too; a message written here changes only this
          policy&apos;s.
        </Text>
      )}
    </Stack>
  );

  /**
   * One control of the disclosure.
   *
   * Four of the five kinds are the ones the catalog cannot describe: a control
   * whose screen value and stored value are different shapes (`enforcement`),
   * one that has to say whether its setting can bite (`failMode`), one that
   * shows an inherited value it is overriding (`message`), and one that is not
   * configuration at all (`id`). Everything else is `field`, and goes to the
   * same generic renderer as block 3.
   */
  const renderAdvancedControl = (control: PolicyAdvancedControl) => {
    switch (control.kind) {
      case 'enforcement':
        return (
          <EnforcementField
            key={control.key}
            value={toEnforcement(draft.schedule)}
            hookCount={(draft.hooks ?? []).length}
            readOnly={readOnly}
            // WRITES `GuardrailPolicy.schedule` — the whole `{ timing, onFail }`
            // object, from `fromEnforcement`, which returns a fresh one per
            // call. Nothing on the wire changes shape.
            onChange={(next) => set('schedule', fromEnforcement(next))}
          />
        );
      case 'failMode':
        return (
          <FailModeField
            key={control.key}
            value={draft.failMode}
            inherited={guardrailFailMode ?? 'open'}
            action={draft.action ?? guardrailAction ?? 'block'}
            mode={guardrailMode}
            readOnly={readOnly}
            onChange={(next) => set('failMode', next)}
          />
        );
      case 'message':
        return <div key={control.key}>{messageBlock}</div>;
      case 'id':
        return (
          <FormField
            key={control.key}
            label="Id"
            required
            hint={
              isNew
                ? 'Fixed once this policy is saved — findings and evaluation-log rows reference it.'
                : 'Fixed. Findings and evaluation-log rows already reference it, and renaming it would orphan every one of them.'
            }
          >
            {/* Hand-drawn rather than a catalog field on purpose: `id` is
                deliberately excluded from `COMMON_POLICY_FIELDS` because
                identity is not configuration, and its editability depends on
                something the catalog has no way to know — whether the policy
                has ever been saved. */}
            <PolicyIdInput
              value={draft.id}
              editable={Boolean(isNew) && !readOnly}
              onChange={(next) => set('id', next)}
            />
          </FormField>
        );
      case 'field':
      default:
        return control.field ? renderField(control.field) : null;
    }
  };

  return (
    <>
      <Drawer
        opened={opened}
        onClose={requestClose}
        position="right"
        size="lg"
        padding="md"
        scrollAreaComponent={ScrollArea.Autosize}
        title={
          <Group gap={8}>
            <FamilyIcon size={18} />
            <div>
              <Text size="sm" fw={600}>
                {known ? policyDisplayName(draft) : (draft.label?.trim() || draft.id)}
              </Text>
              <Text size="xs" c="dimmed">
                {draftFamilyLabel} policy · {draft.id || 'no id yet'}
              </Text>
            </div>
          </Group>
        }
      >
        <Stack gap="md">
          {derived && (
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={15} />} p="xs">
              <Text size="xs">
                This policy was derived from the guardrail&apos;s legacy fields by the migration, not
                authored. It runs exactly as it does today; applying an edit and saving promotes the
                whole hook configuration to an authored one, and from then on this screen decides
                what runs.
              </Text>
            </Alert>
          )}

          {/* ── 1. Name ── */}
          <FormSection
            number={1}
            title="Name"
            description="What this policy is shown as. Its id — the string every finding carries — is under Advanced, because it is identity rather than a setting."
            done={Boolean(draft.label?.trim())}
          >
            <FormRow cols={1}>
              {commonField('label') && renderField(commonField('label') as PolicyFieldSpec)}
            </FormRow>

            <Group gap="xs" mt="xs">
              <Badge size="sm" variant="light" color={meta?.color ?? 'gray'}>
                {draftFamilyLabel}
              </Badge>
              <Text size="xs" c="dimmed">
                {spec?.description ?? meta?.description ?? 'This version of the console does not know this family.'}
              </Text>
            </Group>

            {sectionIssues('identity')}
          </FormSection>

          {/* ── 2. Where it runs ── */}
          <FormSection
            number={2}
            title="Where it runs"
            description="A policy evaluates at the hooks it names here — and only there. The hooks this policy cannot serve are disabled, with the reason."
            done={(draft.hooks ?? []).length > 0}
          >
            <ToggleList>
              {hookOptions.map((option) => {
                const row = (
                  <ToggleRow
                    checked={option.checked}
                    disabled={!option.eligible || readOnly}
                    label={option.label}
                    description={option.description}
                    onChange={(checked) =>
                      set(
                        'hooks',
                        checked
                          ? [...(draft.hooks ?? []), option.hook]
                          : (draft.hooks ?? []).filter((hook) => hook !== option.hook),
                      )
                    }
                  />
                );
                // The reason is in the row's own description AND in a tooltip:
                // the description is truncated by the row's layout for the
                // longer ones, and a disabled control the operator cannot read
                // the reason for is the exact failure this is avoiding.
                return option.eligible ? (
                  <div key={option.hook}>{row}</div>
                ) : (
                  <Tooltip
                    key={option.hook}
                    label={option.reason}
                    multiline
                    w={340}
                    withArrow
                    position="left"
                  >
                    <div>{row}</div>
                  </Tooltip>
                );
              })}
            </ToggleList>
            {(draft.hooks ?? []).length > 0 && (
              <Text size="xs" c="dimmed" mt="xs">
                Want the same rule somewhere else, but acting differently there? Duplicate this
                policy and bind the copy to the other hook — one policy has one action, wherever it
                runs.
              </Text>
            )}

            {sectionIssues('placement')}
          </FormSection>

          {/* ── 3. Config ── */}
          <FormSection
            number={3}
            title={`${draftFamilyLabel} configuration`}
            description={spec?.description ?? 'This family has no configuration in this version of the console.'}
          >
            {layout.config.length === 0 && layout.configAdvanced.length === 0 ? (
              <Text size="xs" c="dimmed">
                Nothing to configure — this policy works out of the box.
              </Text>
            ) : (
              <Stack gap="sm">
                {layout.config.length === 0 && (
                  <Text size="xs" c="dimmed">
                    Nothing here needs a decision. This family&apos;s settings all have defaults that
                    work, and they are under Advanced.
                  </Text>
                )}
                {groupConfigFields(layout.config).map((section) => (
                  <Stack gap="sm" key={section.group ?? '_'}>
                    {section.group && (
                      <Divider
                        label={
                          <Text size="xs" fw={600} tt="uppercase">
                            {section.group}
                          </Text>
                        }
                        labelPosition="left"
                      />
                    )}
                    {section.fields.map(renderField)}
                  </Stack>
                ))}
              </Stack>
            )}
            {sectionIssues('config')}
          </FormSection>

          {/* ── 4. When it finds something ── */}
          <FormSection
            number={4}
            title="When it finds something"
            description="The one outcome decision: stop it, rewrite it, or write it down. Everything about cost, timing and failure is under Advanced."
          >
            <Stack gap="sm">
              {actionSpec && renderField(actionSpec)}

              {/* Family fields that decide an outcome and stand on their own. */}
              {layout.outcome.map(renderField)}

              {elsewhere.length > 0 && (
                <Text size="xs" c="dimmed">
                  This family also decides outcomes elsewhere on this form:{' '}
                  {elsewhere
                    .map(
                      (entry) =>
                        `${entry.label} (${entry.advanced ? 'under Advanced, ' : ''}${entry.where})`,
                    )
                    .join(', ')}
                  .
                </Text>
              )}
            </Stack>
            {sectionIssues('outcome')}
          </FormSection>

          {/* ── the one disclosure ─────────────────────────────────────────
              It says what is in it, badges what is SET in it, and opens itself
              when something in it is outstanding. Without those three it is a
              place settings go to be forgotten, which is what the fourteen
              controls this form used to show were already doing. */}
          <Stack gap={6}>
            <Group justify="space-between" wrap="nowrap" align="center">
              <Button
                variant="subtle"
                size="xs"
                justify="flex-start"
                leftSection={
                  showAdvanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
                }
                onClick={() => setShowAdvanced((prev) => !prev)}
              >
                {showAdvanced ? 'Hide' : 'Show'} advanced ({advanced.length})
              </Button>
              {split.advanced.length > 0 && (
                <Badge
                  size="sm"
                  color="orange"
                  variant="light"
                  leftSection={<IconAlertTriangle size={11} />}
                >
                  {split.advanced.length} to fix in here
                </Badge>
              )}
            </Group>

            <Text size="xs" c="dimmed">
              In here: {advancedContentsLine(advancedInDrawOrder(advanced))}.
            </Text>

            {/* The half that stops a closed section hiding a decision. A policy
                with its own fail mode, time limit or enforcement says so with
                the chevron shut. */}
            {changed.length > 0 && (
              <Group gap={6} align="center">
                <Text size="xs" c="dimmed">
                  Not at the default:
                </Text>
                {changed.map((entry) => (
                  <Badge key={entry.key} size="xs" variant="light" color="blue">
                    {entry.label}: {entry.value}
                  </Badge>
                ))}
              </Group>
            )}

            <Collapse in={showAdvanced}>
              <Stack gap="md" pt="xs">
                {issueAlert(split.advanced)}

                {ADVANCED_SECTION_ORDER.map((section) => {
                  const controls = advancedSection(advanced, section);
                  const notes = section === 'behaviour' ? behaviourNotes : null;
                  if (controls.length === 0 && !notes) return null;
                  return (
                    <Stack gap="sm" key={section}>
                      <Divider
                        label={
                          <Text size="xs" fw={600} tt="uppercase">
                            {section === 'family'
                              ? `${ADVANCED_SECTION_TITLE.family} — ${draftFamilyLabel}`
                              : ADVANCED_SECTION_TITLE[section]}
                          </Text>
                        }
                        labelPosition="left"
                      />
                      {section === 'family'
                        ? // The family's own advanced fields keep the catalog's
                          // headings inside the band, so a grouped control is
                          // still next to the classification it belongs to.
                          groupConfigFields(familyAdvancedFields).map((group) => (
                            <Stack gap="sm" key={group.group ?? '_'}>
                              {group.group && (
                                <Text size="xs" c="dimmed" fw={600}>
                                  {group.group}
                                </Text>
                              )}
                              {group.fields.map(renderField)}
                            </Stack>
                          ))
                        : controls.map(renderAdvancedControl)}
                      {notes}
                    </Stack>
                  );
                })}
              </Stack>
            </Collapse>
          </Stack>

          <Divider />

          <Group justify="space-between">
            <Group gap="xs">
              {onDuplicate && (
                <Button
                  size="sm"
                  variant="default"
                  leftSection={<IconCopy size={15} />}
                  disabled={readOnly}
                  onClick={() => {
                    onDuplicate();
                    onClose();
                  }}
                >
                  Duplicate
                </Button>
              )}
              <Text size="xs" c="dimmed">
                {issues.length === 0
                  ? 'Nothing outstanding'
                  : `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before this saves`}
              </Text>
            </Group>
            <Group gap="xs">
              <Button size="sm" variant="subtle" onClick={requestClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                leftSection={<IconCheck size={15} />}
                disabled={readOnly}
                onClick={() => {
                  onApply(draft);
                  onClose();
                }}
              >
                Apply
              </Button>
            </Group>
          </Group>
        </Stack>
      </Drawer>

      {/* A small Modal is what the repo rule reserves for a confirm, so this one
          is in the rule rather than another divergence from it. */}
      <Modal
        opened={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard your changes?"
        centered
        size="sm"
      >
        <Stack gap="sm">
          <Text size="sm">
            This policy has edits that have not been applied. Closing now throws them away.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button size="sm" variant="subtle" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              size="sm"
              color="red"
              onClick={() => {
                setConfirmDiscard(false);
                onClose();
              }}
            >
              Discard
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

// ── the id, and the failure mode ────────────────────────────────────────────

function PolicyIdInput({
  value,
  editable,
  onChange,
}: {
  value: string;
  editable: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <TextInput
      value={value}
      readOnly={!editable}
      disabled={!editable}
      placeholder="pii-outbound"
      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/**
 * "How it runs" — ONE select where the form used to show `timing` and `onFail`.
 *
 * The pair advertised four combinations and the stored type has three: an async
 * policy has already let the response go, so `{ timing: 'async', onFail:
 * 'block' }` is not a setting anybody was refused, it is a setting that cannot
 * exist. The old screens said it out loud anyway, as two selects with one cell
 * greyed out and a paragraph explaining why.
 *
 * WRITES `GuardrailPolicy.schedule`, unchanged: `fromEnforcement` returns the
 * same `{ timing, onFail }` the wire has always carried, and `toEnforcement`
 * reads one back — including the shapes the type forbids but a hand-written row
 * can still hold, where it answers what the ENGINE will do rather than what the
 * row claims.
 */
function EnforcementField({
  value,
  hookCount,
  readOnly,
  onChange,
}: {
  value: GuardrailEnforcement;
  /** How many hooks this policy is bound to. One schedule covers all of them. */
  hookCount: number;
  readOnly?: boolean;
  onChange: (next: GuardrailEnforcement) => void;
}) {
  return (
    <FormField
      label="How it runs"
      hint="Whether the request waits for this policy, and whether what it finds is allowed to stop anything. Set on the hook as well — the Hooks tab pushes a hook's setting down onto every policy bound to it, so a change there replaces what is chosen here."
    >
      <Stack gap={6}>
        <Select
          data={selectData(ENFORCEMENT_OPTIONS)}
          value={value}
          disabled={readOnly}
          allowDeselect={false}
          renderOption={describedOption(ENFORCEMENT_OPTIONS)}
          onChange={(next) => {
            // Matched against the CONTRACT's own list rather than cast, so a
            // value the DOM hands back that is not an enforcement is dropped
            // instead of stored.
            const picked = GUARDRAIL_ENFORCEMENTS.find((candidate) => candidate === next);
            if (picked) onChange(picked);
          }}
        />

        {value === 'observe_no_wait' && (
          <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={14} />}>
            <Text size="xs">
              Nothing waits for this policy, so nothing it finds can be blocked or redacted — the
              response has already gone. Its findings are recorded after the fact. The action above
              still decides how they are reported.
            </Text>
          </Alert>
        )}
        {value === 'observe' && (
          <Text size="xs" c="dimmed">
            The request still waits for this policy, so it still costs what it costs — what changes
            is that a finding is recorded rather than acted on.
          </Text>
        )}
        {hookCount > 1 && (
          <Text size="xs" c="dimmed">
            One setting for all {hookCount} hooks this policy is bound to. Want it to block in one
            place and only observe in another? Duplicate the policy.
          </Text>
        )}
      </Stack>
    </FormField>
  );
}

/**
 * "If this policy cannot run" — not "Failure Mode: open | closed".
 *
 * WRITES `GuardrailPolicy.failMode`: 'closed' is "Block it", 'open' is "Let the
 * content through", and CLEARED IS ABSENT — inherit the guardrail's own, which
 * is what the first option says in words rather than as an empty select.
 *
 * Three settings are routinely confused, and the words are the only thing that
 * separates them:
 *   · `action`   — the policy FOUND something. Block it?
 *   · `failMode` — the policy BROKE (model down, webhook timeout, budget spent).
 *                  Let the content through?
 *   · `mode`     — are decisions binding at all?
 *
 * The live note is not decoration. It matches `buildEvaluationErrorFinding`:
 * the error finding blocks only when `failMode === 'closed' && action ===
 * 'block'`, and the verdict is neutralised to 'allow' unless the guardrail is
 * enforcing. So fail-closed on a monitoring guardrail — or on a policy that
 * only flags — stops nothing, and someone who picks it believing they are
 * protected is not.
 *
 * No `family` prop, unlike the full-screen editor's version of this control.
 * That switch is the one thing this rebuild refuses to carry over: see
 * `FAIL_MODE_WHY`.
 */
function FailModeField({
  value,
  inherited,
  action,
  mode,
  readOnly,
  onChange,
}: {
  value: GuardrailFailMode | undefined;
  inherited: GuardrailFailMode;
  action: SafetyAction;
  mode: GuardrailMode | undefined;
  readOnly?: boolean;
  onChange: (next: GuardrailFailMode | undefined) => void;
}) {
  const effective = value ?? inherited;
  const closed = effective === 'closed';
  const enforcing = mode === undefined || mode === 'enforce';
  const blocking = action === 'block';
  const bites = closed && enforcing && blocking;

  return (
    <FormField label="If this policy cannot run" hint={FAIL_MODE_WHY}>
      <Stack gap={6}>
        <Select
          data={[
            {
              value: '',
              label: `Use the guardrail default (${inherited === 'closed' ? 'block it' : 'allow the content through'})`,
            },
            { value: 'open', label: 'Allow the content through — the policy simply did not run' },
            { value: 'closed', label: 'Block it — treat “we could not check” as “not safe”' },
          ]}
          value={value ?? ''}
          disabled={readOnly}
          allowDeselect={false}
          onChange={(next) => onChange(next === 'open' || next === 'closed' ? next : undefined)}
        />

        {closed &&
          (bites ? (
            <Alert color="gray" variant="light" p="xs" icon={<IconInfoCircle size={14} />}>
              <Text size="xs">
                Active: this guardrail enforces and this policy blocks, so a request whose policy
                could not run is stopped.
              </Text>
            </Alert>
          ) : (
            <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={14} />}>
              <Text size="xs">
                {!enforcing
                  ? `This guardrail is in ${mode} mode, so no decision is binding. Fail-closed will be recorded and nothing will be blocked — the protection you are picking here does not exist until the guardrail enforces.`
                  : `This policy's action is "${action}", not "block". A policy that cannot run is recorded at that same action, so fail-closed blocks nothing. Set the action to block if a failed policy should stop the request.`}
              </Text>
            </Alert>
          ))}
      </Stack>
    </FormField>
  );
}
