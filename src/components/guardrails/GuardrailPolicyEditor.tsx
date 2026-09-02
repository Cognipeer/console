'use client';

/**
 * ONE policy, edited on its own.
 *
 * Same skeleton for all nine families — identity, where it runs, family
 * configuration, what happens on a finding — because the four questions are the
 * same regardless of what the policy detects, and because the previous screen's
 * per-family layouts were the reason PII and Word Filter did not line up.
 *
 * ── WHAT IS EXPOSED, AND WHY IT IS EXACTLY THIS ───────────────────────────
 * Every field on every one of the nine config interfaces in `types.domain` has
 * a control here, and NOTHING ELSE DOES. That rule is the whole point: the
 * locale switch this wave deleted from the Messages tab was a control for a
 * dimension `BlockedMessageSettings` has never had, so it changed a placeholder
 * and nothing else. A control the store cannot hold is worse than a missing
 * one — it is a promise the system will not keep.
 *
 * Three consequences worth stating, because a reader comparing this against the
 * wireframe will notice them:
 *   · the webhook block has no `includeState` / `redactBeforeSend` /
 *     `budgetMs`. `GuardrailWebhookPolicyConfig` carries `send: 'text' |
 *     'subject'` (which is the "how much do we put on the wire" question),
 *     `retries`, `credentialProviderKey` and `signingSecretRef`; the budget is
 *     `timeoutMs` on the policy base and is edited once, in "On a finding".
 *   · PII has ONE `actionOverride`, not per-category overrides. Per-category
 *     actions live on the PII policy, which owns the category catalog — that is
 *     precisely why `piiPolicyKey` replaced the old inline category grid.
 *   · there is no per-severity override. Severity is a property of a FINDING
 *     (and, for regex, of a rule); no policy-level field stores a
 *     severity-to-action map, so none is drawn.
 *
 * `schedule` is likewise not drawn here. It is stored, but the engine reads
 * only `timing` (and only to decide short-circuit participation) — the hook's
 * schedule is set on the Hooks tab and propagated down, and a second control
 * for it here would imply a per-policy effect that does not exist.
 *
 * ── WHAT THIS COMPONENT MAY NOT IMPORT ────────────────────────────────────
 * `hooks/contract` only (via `./policyFamilyMeta`). `hooks/legacy` owns the
 * authoritative `validateGuardrailHooks` and imports the `@/lib/database`
 * barrel, which constructs providers on load; `validatePolicy` below is a
 * deliberate SUBSET of it, and the server's errors are the ones that decide a
 * save.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  NumberInput,
  MultiSelect,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconInfoCircle,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import {
  MODERATION_CATEGORIES,
  PII_CATEGORIES,
  WORD_FILTER_BUILTIN_LISTS,
} from '@/lib/services/guardrail/constants';
import type {
  ModerationCategoryDefinition,
  PiiCategoryDefinition,
} from '@/lib/services/guardrail/constants';
import { REGEX_MAX_MATCH_CHARS } from '@/lib/services/guardrail/hooks/contract';
import type {
  CustomPolicyConfig,
  GuardrailPolicy,
  GuardrailFailMode,
  GuardrailMode,
  HookBinding,
  HookId,
  JsonSchemaLite,
  ModerationPolicyConfig,
  PiiPolicyConfig,
  PromptShieldPolicyConfig,
  RegexPolicyConfig,
  RegexRule,
  SafetyAction,
  SecretsPolicyConfig,
  SideEffect,
  ToolAccessPolicyConfig,
  WebhookPolicyConfig,
  WordFilterPolicyConfig,
} from '@/lib/services/guardrail/hooks/contract';
import type { PiiAction, PiiLanguage } from '@/lib/database';
import {
  HOOK_IDS,
  HOOK_META,
  canBindToHook,
  policyDisplayName,
  familyMeta,
} from './policyFamilyMeta';

// ── validation ──────────────────────────────────────────────────────────────

export interface PolicyIssue {
  /** Which block the problem is in, for the summary list. */
  field?: string;
  message: string;
}

/**
 * A SUBSET of the server's `validateGuardrailHooks`, restated because that
 * function lives behind the database barrel and cannot enter a client bundle.
 *
 * Keep it short on purpose. A client validator that drifts from the server is
 * worse than none: it either blocks a save the server would accept, or promises
 * one it would refuse. Everything here is a rule the server also enforces —
 * apart from the two ADVISORY notes at the end, which are marked as such
 * because the engine reports them at runtime rather than at save time.
 */
export function validatePolicy(
  policy: GuardrailPolicy,
  ctx?: { bindings?: Partial<Record<HookId, HookBinding>> },
): PolicyIssue[] {
  const issues: PolicyIssue[] = [];

  if (!policy.id?.trim()) {
    issues.push({ field: 'id', message: 'Every policy needs an id — it is what its findings reference.' });
  }

  if (!policy.hooks?.length) {
    issues.push({ field: 'hooks', message: 'Bound to no hook, so it can never run.' });
  }

  for (const hook of policy.hooks ?? []) {
    const eligible = canBindToHook(policy, hook);
    if (!eligible.ok) {
      issues.push({ field: 'hooks', message: `${hook}: ${eligible.reason ?? 'not valid for this family.'}` });
    } else if (policy.enabled && ctx?.bindings && ctx.bindings[hook]?.enabled !== true) {
      issues.push({
        field: 'hooks',
        message: `${hook} is switched off on the Hooks tab, so this policy never runs there.`,
      });
    }
  }

  // Mirrors the server: a DISABLED policy's configuration is not validated, so
  // an operator can park a half-built policy instead of being forced to finish
  // or delete it.
  if (!policy.enabled) return issues;

  switch (policy.family) {
    case 'pii':
      if (!policy.piiPolicyKey?.trim()) {
        issues.push({
          field: 'config',
          message: 'Pick a PII policy. An enabled PII policy needs one — categories, languages and mask strategies all live there.',
        });
      }
      break;
    case 'moderation':
    case 'prompt_shield':
    case 'custom':
      if (!policy.modelKey?.trim()) {
        issues.push({
          field: 'config',
          message: 'No model to evaluate this policy, so it reads as active while nothing runs.',
        });
      }
      if (policy.family === 'custom' && !policy.prompt?.trim()) {
        issues.push({ field: 'config', message: 'A custom policy needs a rule to evaluate.' });
      }
      break;
    case 'regex': {
      if (!policy.rules?.length) {
        issues.push({ field: 'config', message: 'A regex policy with no rules matches nothing.' });
      }
      for (const rule of policy.rules ?? []) {
        const name = rule.label || rule.id || 'rule';
        if (!compiles(rule.pattern, rule.flags)) {
          issues.push({ field: 'config', message: `"${name}" is not a valid pattern, so it can never fire.` });
        }
        const declared = Number(rule.maxMatchChars);
        if (!Number.isFinite(declared) || declared <= 0 || declared > REGEX_MAX_MATCH_CHARS) {
          issues.push({
            field: 'config',
            message: `"${name}" needs a match-length bound between 1 and ${REGEX_MAX_MATCH_CHARS}.`,
          });
        }
      }
      break;
    }
    case 'webhook':
      if (!/^https:\/\//i.test(policy.url ?? '')) {
        issues.push({
          field: 'config',
          message: 'A webhook must use https — its verdict decides whether a request is blocked, so a plaintext hop is a bypass.',
        });
      }
      break;
    default:
      break;
  }

  // ── advisory: the engine reports these at RUNTIME, not at save time ──
  if (readRunIf(policy) === 'onSideEffect') {
    const toolHooks = (policy.hooks ?? []).filter((hook) => hook === 'tool.pre' || hook === 'tool.post');
    if (toolHooks.length < (policy.hooks ?? []).length) {
      issues.push({
        field: 'finding',
        message:
          'Set to run only for tool calls with side effects, but bound to a hook that carries no tool call — it never fires there.',
      });
    }
  }

  return issues;
}

function compiles(pattern: string, flags?: string): boolean {
  try {
    new RegExp(pattern, flags ?? '');
    return true;
  } catch {
    return false;
  }
}

// ── runIf ───────────────────────────────────────────────────────────────────
/**
 * DERIVED from the declared field rather than restated, so a rename in
 * `GuardrailPolicyBase` breaks this file at compile time instead of leaving a
 * screen that writes a key nothing reads.
 *
 * `resolveRunIf` (services/guardrail/families/llm.ts) applies the same
 * three-value coercion on the way in. The read below still widens to `unknown`:
 * the value arrives from a stored JSON blob, and an unrecognised one must read
 * as 'always' (run the policy) rather than as a gate the operator cannot see.
 */
type PolicyRunIf = NonNullable<GuardrailPolicy['runIf']>;

function readRunIf(policy: GuardrailPolicy): PolicyRunIf {
  const raw: unknown = policy.runIf;
  return raw === 'onFinding' || raw === 'onSideEffect' ? raw : 'always';
}

function writeRunIf(policy: GuardrailPolicy, runIf: PolicyRunIf): GuardrailPolicy {
  return Object.assign({}, policy, { runIf });
}

const RUN_IF_OPTIONS = [
  { value: 'always', label: 'Always — a model call on every request' },
  { value: 'onFinding', label: 'Only after a deterministic policy flagged something' },
  { value: 'onSideEffect', label: 'Only for destructive or external tool calls' },
];

/**
 * `Object.assign` rather than a literal spread: `GuardrailPolicy` is a
 * nine-member discriminated union, and `{ ...policy, field }` produces a type
 * TypeScript will not take back as a `GuardrailPolicy`.
 */
function assign<T extends object>(base: T, changes: Partial<T>): T {
  return Object.assign({}, base, changes);
}

// ── the editor ──────────────────────────────────────────────────────────────

export interface GuardrailPolicyEditorProps {
  open: boolean;
  policy: GuardrailPolicy;
  /** Called with the edited policy when the operator applies it. The guardrail
   *  itself is persisted by the page's own Save. */
  onChange: (next: GuardrailPolicy) => void;
  onClose: () => void;
  /** Offered in the header — the fastest route to "the same rule, elsewhere". */
  onDuplicate?: () => void;
  /** The guardrail's `hooks.bindings`, so a policy bound to a switched-off hook
   *  can say so. Read-only here; the Hooks tab owns them. */
  bindings?: Partial<Record<HookId, HookBinding>>;
  models?: Array<{ value: string; label: string }>;
  /** What a policy with no `action` of its own inherits. */
  guardrailAction?: SafetyAction;
  /** What a policy with no `failMode` of its own inherits. */
  guardrailFailMode?: GuardrailFailMode;
  /** enforce | monitor | disabled — decides whether fail-closed can bite. */
  guardrailMode?: GuardrailMode;
  /** `hooksVersion === 0`: lifted from the legacy columns, not authored. */
  derived?: boolean;
  /** A policy added in this session and not yet persisted, whose id may still be
   *  edited. Once saved the id is fixed: findings and evaluation-log rows
   *  reference it, and renaming it orphans every one of them. */
  isNew?: boolean;
  readOnly?: boolean;
}

export default function GuardrailPolicyEditor({
  open,
  policy,
  onChange,
  onClose,
  onDuplicate,
  bindings,
  models = [],
  guardrailAction,
  guardrailFailMode,
  guardrailMode,
  derived,
  isNew,
  readOnly,
}: GuardrailPolicyEditorProps) {
  // A DRAFT, not a live write. The overlay has a Cancel, and a Cancel that does
  // not undo is a lie — the surrounding tabs edit in place because they have no
  // cancel affordance at all.
  const [draft, setDraft] = useState<GuardrailPolicy>(policy);

  useEffect(() => {
    if (open) setDraft(policy);
    // Re-seeded per opened policy, not per render: `policy` is a fresh object on
    // every parent render, and depending on it would discard keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, policy.id]);

  const meta = familyMeta(draft.family);

  // A FAMILY THIS BUILD DOES NOT KNOW — authored by a newer console, or left by
  // a family since removed. Every field below is driven off `meta`, so there is
  // no form to draw; the old code dereferenced it and threw, which took the
  // screen down and left no way to reach the policy at all.
  //
  // Shown read-only ON PURPOSE. This editor could only render the subset of the
  // config it understands, and applying that would silently drop every setting
  // it does not — so it offers no Apply, and says why.
  if (!meta) {
    return (
      <FormShell
        open={open}
        onClose={onClose}
        title={policyDisplayName(draft)}
        subtitle={`${draft.family} · ${draft.id}`}
        icon={<IconAlertTriangle size={18} />}
      >
        <FormSection title="Unknown policy family">
          <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
            <Stack gap={4}>
              <Text size="sm">
                This policy&apos;s family, <b>{draft.family}</b>, is not one this version of the
                console knows, so its settings cannot be shown.
              </Text>
              <Text size="xs" c="dimmed">
                It was most likely authored by a newer version. Its configuration is stored intact
                and is left untouched — upgrade to edit it here, or remove the policy from the list
                if it is no longer wanted.
              </Text>
            </Stack>
          </Alert>
        </FormSection>
      </FormShell>
    );
  }

  const FamilyIcon = meta.icon;
  const issues = validatePolicy(draft, { bindings });

  return (
    <FormShell
      open={open}
      onClose={onClose}
      title={policyDisplayName(draft)}
      subtitle={`${meta.label} policy · ${draft.id}`}
      icon={<FamilyIcon size={18} />}
      primaryAction={{
        label: 'Apply',
        icon: <IconCheck size={15} />,
        disabled: readOnly,
        onClick: () => {
          onChange(draft);
          onClose();
        },
      }}
      footerLeft={
        onDuplicate ? (
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
        ) : undefined
      }
      footerStatus={
        issues.length === 0
          ? 'Nothing outstanding'
          : `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before this saves`
      }
      summary={
        <>
          <SummaryGroup title="This policy">
            <SummaryKV label="Family" value={meta.label} />
            <SummaryKV label="Id" value={draft.id} mono />
            <SummaryKV label="Runs at" value={(draft.hooks ?? []).join(', ') || 'nowhere'} mono />
            <SummaryKV
              label="On a finding"
              value={draft.action ?? `${guardrailAction ?? 'block'} (inherited)`}
            />
            <SummaryKV label="Budget" value={draft.timeoutMs ? `${draft.timeoutMs} ms` : 'no timeout'} />
            {meta.needsFailMode && (
              <SummaryKV
                label="If it cannot run"
                value={
                  (draft.failMode ?? guardrailFailMode ?? 'open') === 'closed'
                    ? 'block the content'
                    : 'let it through'
                }
              />
            )}
          </SummaryGroup>
          <SummaryGroup title="Before it can save">
            <Checklist
              items={
                issues.length === 0
                  ? [{ id: 'ok', label: 'Nothing outstanding', done: true }]
                  : issues.map((issue, index) => ({ id: index, label: issue.message, done: false }))
              }
            />
          </SummaryGroup>
        </>
      }
    >
      {derived && (
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={15} />} mb="md">
          <Text size="xs">
            This policy was derived from the guardrail&apos;s legacy fields by the migration, not
            authored. It runs exactly as it does today; applying an edit and saving promotes the
            whole hook configuration to an authored one, and from then on this screen decides what
            runs.
          </Text>
        </Alert>
      )}

      {/* ── 1. Identity ── */}
      <FormSection
        number={1}
        title="Identity"
        description="What this policy is called, and the id its findings carry."
        done={Boolean(draft.label?.trim())}
      >
        <FormRow cols={2}>
          <FormField
            label="Name"
            optional
            hint="Shown in the policy list and on the hook grid. Two policies of the same family are told apart by this."
          >
            <TextInput
              placeholder={meta.label}
              value={draft.label ?? ''}
              readOnly={readOnly}
              onChange={(event) =>
                setDraft((prev) => assign(prev, { label: event.currentTarget.value || undefined }))
              }
            />
          </FormField>
          <FormField
            label="Id"
            hint={
              isNew
                ? 'Fixed once this policy is saved — findings and evaluation-log rows reference it.'
                : 'Fixed. Findings and evaluation-log rows already reference it, and renaming it would orphan every one of them.'
            }
          >
            <TextInput
              value={draft.id}
              readOnly={!isNew || readOnly}
              disabled={!isNew}
              onChange={(event) => setDraft((prev) => assign(prev, { id: event.currentTarget.value }))}
            />
          </FormField>
        </FormRow>

        <Group gap="xs" mt="xs">
          <Badge size="sm" variant="light" color={meta.color}>
            {meta.label}
          </Badge>
          <Text size="xs" c="dimmed">
            {meta.description}
          </Text>
        </Group>

        <Switch
          mt="sm"
          size="sm"
          label="Enabled"
          description="A disabled policy keeps its whole configuration and evaluates nothing."
          checked={draft.enabled}
          disabled={readOnly}
          onChange={(event) =>
            setDraft((prev) => assign(prev, { enabled: event.currentTarget.checked }))
          }
        />
      </FormSection>

      {/* ── 2. Where it runs ── */}
      <FormSection
        number={2}
        title="Where it runs"
        description="A policy evaluates at the hooks it names here — and only there. The hooks this family cannot serve are disabled, with the reason."
        done={(draft.hooks ?? []).length > 0}
      >
        <ToggleList>
          {HOOK_IDS.map((hook) => {
            const eligible = canBindToHook(draft, hook);
            const on = (draft.hooks ?? []).includes(hook);
            const unbound = on && draft.enabled && bindings && bindings[hook]?.enabled !== true;
            const row = (
              <ToggleRow
                checked={on}
                disabled={!eligible.ok || readOnly}
                label={`${HOOK_META[hook].short} — ${HOOK_META[hook].label}`}
                description={
                  eligible.ok
                    ? unbound
                      ? `${HOOK_META[hook].description} — but this hook is switched off on the Hooks tab, so nothing runs here yet.`
                      : HOOK_META[hook].description
                    : eligible.reason
                }
                onChange={(checked) =>
                  setDraft((prev) =>
                    assign(prev, {
                      hooks: checked
                        ? [...(prev.hooks ?? []), hook]
                        : (prev.hooks ?? []).filter((h) => h !== hook),
                    }),
                  )
                }
              />
            );
            return eligible.ok ? (
              <div key={hook}>{row}</div>
            ) : (
              <Tooltip key={hook} label={eligible.reason} multiline w={340} withArrow position="right">
                <div>{row}</div>
              </Tooltip>
            );
          })}
        </ToggleList>

        {(draft.hooks ?? []).length > 0 && (
          <Text size="xs" c="dimmed" mt="xs">
            Want the same rule somewhere else, but acting differently there? Duplicate this policy
            and bind the copy to the other hook — one policy has one action, wherever it runs.
          </Text>
        )}
      </FormSection>

      {/* ── 3. Family configuration ── */}
      <FormSection
        number={3}
        title={`${meta.label} configuration`}
        description={meta.description}
      >
        <FamilyConfig
          policy={draft}
          models={models}
          readOnly={readOnly}
          onChange={(next) => setDraft(next)}
        />
      </FormSection>

      {/* ── 4. On a finding ── */}
      <FormSection
        number={4}
        title="On a finding"
        description="What this policy does when it detects something, what it costs, and what happens when it cannot run at all."
      >
        <FormRow cols={2}>
          <FormField
            label="Action"
            hint="Overrides the guardrail's own action for this policy's findings only."
          >
            <Select
              data={[
                { value: '', label: `Use the guardrail default (${guardrailAction ?? 'block'})` },
                { value: 'block', label: 'Block — stop the request' },
                { value: 'redact', label: 'Redact — remove the matched values and continue' },
                { value: 'flag', label: 'Flag — allow, and record the finding' },
              ]}
              value={draft.action ?? ''}
              disabled={readOnly}
              onChange={(value) =>
                setDraft((prev) =>
                  assign(prev, {
                    action:
                      value === 'block' || value === 'redact' || value === 'flag' ? value : undefined,
                  }),
                )
              }
            />
          </FormField>
          <FormField
            label="Budget"
            hint="Wall clock for this policy. 0 means no timeout, which is what every guardrail has had until now. On expiry the policy counts as unable to run."
          >
            <NumberInput
              min={0}
              max={120_000}
              step={100}
              suffix=" ms"
              value={draft.timeoutMs ?? 0}
              disabled={readOnly}
              onChange={(value) =>
                setDraft((prev) =>
                  assign(prev, { timeoutMs: typeof value === 'number' && value > 0 ? value : undefined }),
                )
              }
            />
          </FormField>
        </FormRow>

        {meta.needsModel && (
          <FormField
            label="When to spend a model call"
            hint="Per policy, not per hook. A judge on every request is what makes a guardrail expensive."
          >
            <Select
              data={RUN_IF_OPTIONS}
              value={readRunIf(draft)}
              disabled={readOnly}
              onChange={(value) =>
                setDraft((prev) =>
                  writeRunIf(prev, value === 'onFinding' || value === 'onSideEffect' ? value : 'always'),
                )
              }
            />
          </FormField>
        )}

        {meta.needsFailMode && (
          <FailModeField
            value={draft.failMode}
            inherited={guardrailFailMode ?? 'open'}
            action={draft.action ?? guardrailAction ?? 'block'}
            mode={guardrailMode}
            family={draft.family}
            readOnly={readOnly}
            onChange={(failMode) => setDraft((prev) => assign(prev, { failMode }))}
          />
        )}

        {!meta.needsFailMode && (
          <Text size="xs" c="dimmed">
            {draft.family === 'tool_access'
              ? `This policy runs in process. The two cases it cannot decide — an argument nested past the depth cap, and a DNS lookup that fails while private networks are denied — fall back to the guardrail's own failure mode (${guardrailFailMode ?? 'open'}).`
              : 'This policy runs in memory on a string — no model, no network, no policy read — so there is no “it could not run” case to configure. If it is enabled, it runs.'}
          </Text>
        )}

        {issues.length > 0 && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={15} />} mt="sm" p="xs">
            <Stack gap={2}>
              {issues.map((issue, index) => (
                <Text size="xs" key={index}>
                  {issue.message}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
      </FormSection>
    </FormShell>
  );
}

// ── failMode, in plain words ────────────────────────────────────────────────

/**
 * "If this policy cannot run" — not "Failure Mode: open | closed".
 *
 * Three settings are routinely confused, and the words are the only thing that
 * separates them:
 *   · `action`   — the policy FOUND something. Block it?
 *   · `failMode` — the policy BROKE (model down, webhook timeout, budget spent).
 *                  Let the content through?
 *   · `mode`     — are decisions binding at all?
 *
 * The live note is not decoration. VERIFIED against
 * `buildEvaluationErrorFinding` (services/guardrail/types.ts:224): the error
 * finding blocks only when `failMode === 'closed' && action === 'block'`, and
 * the verdict is neutralised to 'allow' unless the guardrail is enforcing. So
 * fail-closed on a monitoring guardrail — or on a policy that only flags — stops
 * nothing, and someone who picks it believing they are protected is not.
 */
function FailModeField({
  value,
  inherited,
  action,
  mode,
  family,
  readOnly,
  onChange,
}: {
  value: GuardrailFailMode | undefined;
  inherited: GuardrailFailMode;
  action: SafetyAction;
  mode: GuardrailMode | undefined;
  family: GuardrailPolicy['family'];
  readOnly?: boolean;
  onChange: (next: GuardrailFailMode | undefined) => void;
}) {
  const effective = value ?? inherited;
  const closed = effective === 'closed';
  const enforcing = mode === undefined || mode === 'enforce';
  const blocking = action === 'block';
  const bites = closed && enforcing && blocking;

  const why = (): string => {
    switch (family) {
      case 'webhook':
        return 'Your endpoint can time out, refuse the connection or answer with something unparseable.';
      case 'pii':
        return 'Reading the PII policy is a database round trip, and it can fail.';
      default:
        return 'The model can be unreachable, rate-limited, or slower than the budget.';
    }
  };

  return (
    <FormField
      label="If this policy cannot run"
      hint={`${why()} This is a different question from what to do when it FINDS something — that is the Action above.`}
    >
      <Select
        data={[
          { value: '', label: `Use the guardrail default (${inherited === 'closed' ? 'block it' : 'allow the content through'})` },
          { value: 'open', label: 'Allow the content through — the policy simply did not run' },
          { value: 'closed', label: 'Block it — treat "we could not check" as "not safe"' },
        ]}
        value={value ?? ''}
        disabled={readOnly}
        onChange={(next) => onChange(next === 'open' || next === 'closed' ? next : undefined)}
      />

      {closed &&
        (bites ? (
          <Alert color="gray" variant="light" mt={6} p="xs" icon={<IconInfoCircle size={14} />}>
            <Text size="xs">
              Active: this guardrail enforces and this policy blocks, so a request whose policy could
              not run is stopped.
            </Text>
          </Alert>
        ) : (
          <Alert color="orange" variant="light" mt={6} p="xs" icon={<IconAlertTriangle size={14} />}>
            <Text size="xs">
              {!enforcing
                ? `This guardrail is in ${mode} mode, so no decision is binding. Fail-closed will be recorded and nothing will be blocked — the protection you are picking here does not exist until the guardrail enforces.`
                : `This policy's action is "${action}", not "block". A policy that cannot run is recorded at that same action, so fail-closed blocks nothing. Set the action to block if a failed policy should stop the request.`}
            </Text>
          </Alert>
        ))}
    </FormField>
  );
}

// ── family configuration ────────────────────────────────────────────────────

function FamilyConfig({
  policy,
  models,
  readOnly,
  onChange,
}: {
  policy: GuardrailPolicy;
  models: Array<{ value: string; label: string }>;
  readOnly?: boolean;
  onChange: (next: GuardrailPolicy) => void;
}) {
  switch (policy.family) {
    case 'pii':
      return <PiiConfig policy={policy} readOnly={readOnly} onChange={onChange} />;
    case 'secrets':
      return <SecretsConfig policy={policy} readOnly={readOnly} onChange={onChange} />;
    case 'word_filter':
      return <WordFilterConfig policy={policy} readOnly={readOnly} onChange={onChange} />;
    case 'regex':
      return <RegexConfig policy={policy} readOnly={readOnly} onChange={onChange} />;
    case 'moderation':
      return <ModerationConfig policy={policy} models={models} readOnly={readOnly} onChange={onChange} />;
    case 'prompt_shield':
      return <PromptShieldConfig policy={policy} models={models} readOnly={readOnly} onChange={onChange} />;
    case 'custom':
      return <CustomConfig policy={policy} models={models} readOnly={readOnly} onChange={onChange} />;
    case 'tool_access':
      return <ToolAccessConfig policy={policy} readOnly={readOnly} onChange={onChange} />;
    case 'webhook':
      return <WebhookConfig policy={policy} readOnly={readOnly} onChange={onChange} />;
  }
}

// ── pii ─────────────────────────────────────────────────────────────────────

interface PiiPolicyOption {
  key: string;
  name: string;
  defaultAction: PiiAction;
  enabled: boolean;
}

const PII_LANGUAGES: PiiLanguage[] = ['global', 'en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'ar', 'ja', 'zh'];

/**
 * A PICKER, never a category grid.
 *
 * The PII service owns the category catalog, the per-language patterns, the
 * checksum validators, the custom patterns, the per-category mask strategies
 * and the tokenise vault. None of that can be expressed on a policy, and two
 * half-descriptions of the same thing drift — a drifted PII config is one that
 * silently stops detecting a category.
 */
function PiiConfig({
  policy,
  readOnly,
  onChange,
}: {
  policy: PiiPolicyConfig;
  readOnly?: boolean;
  onChange: (next: PiiPolicyConfig) => void;
}) {
  const [policies, setPolicies] = useState<PiiPolicyOption[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const update = (changes: Partial<PiiPolicyConfig>) => onChange(assign(policy, changes));

  useEffect(() => {
    let cancelled = false;
    fetch('/api/pii/policies', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('failed');
        return res.json();
      })
      .then((data: { policies?: PiiPolicyOption[] }) => {
        if (!cancelled) setPolicies(data.policies ?? []);
      })
      // A picker that shows "no policies" when the list merely failed to load is
      // how someone concludes they must create one they already have.
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = policy.piiPolicyKey?.trim() ?? '';
  const known = policies.some((policy) => policy.key === selected);
  const options = [
    ...policies.map((policy) => ({
      value: policy.key,
      label: `${policy.name}${policy.enabled ? '' : ' (disabled)'} — ${policy.defaultAction}`,
    })),
    // An unresolved key stays visible: a policy that was deleted or lives in
    // another project is information, and blanking the field would make the
    // policy look unconfigured while the stored key keeps being scanned for.
    ...(selected && !known ? [{ value: selected, label: `${selected} (not found)` }] : []),
  ];

  const legacyCategories = PII_CATEGORIES.filter(
    (category: PiiCategoryDefinition) => policy.legacyCategories?.[category.id],
  );

  return (
    <Stack gap="sm">
      {loadFailed && (
        <Alert color="orange" variant="light" icon={<IconInfoCircle size={15} />} p="xs">
          <Text size="xs">
            The PII policy list could not be loaded. Any policy already selected is still in force —
            reload before assuming there are none.
          </Text>
        </Alert>
      )}

      <FormField
        label="PII policy"
        required
        hint="Categories, languages, custom patterns, checksum validators and mask strategies all live on the PII policy — a separate, reusable asset this guardrail policy points at. Manage them under Data protection → PII policies."
      >
        <Select
          placeholder={policies.length ? 'Select a PII policy…' : 'No PII policies yet'}
          data={options}
          value={selected || null}
          searchable
          disabled={readOnly}
          error={policy.enabled && !selected ? 'Required while this policy is enabled' : undefined}
          onChange={(value) => update({ piiPolicyKey: value ?? '' })}
        />
      </FormField>

      <FormRow cols={2}>
        <FormField
          label="Action override"
          hint="Overrides the PII policy's own default action, for this guardrail policy only. The same PII policy can be detect-only on an internal tool and blocking on a customer-facing one."
        >
          <Select
            data={[
              { value: '', label: 'Use the PII policy default' },
              { value: 'block', label: 'Block the request' },
              { value: 'redact', label: 'Redact — replace the values' },
              { value: 'mask', label: 'Mask — keep the shape, hide the value' },
              { value: 'tokenize', label: 'Tokenize — reversible placeholder' },
              { value: 'detect', label: 'Detect only — log and continue' },
            ]}
            value={policy.actionOverride ?? ''}
            disabled={readOnly}
            onChange={(value) => update({ actionOverride: value ? (value as PiiAction) : undefined })}
          />
        </FormField>
        <FormField
          label="Language"
          hint="Which language's patterns to scan with. 'global' uses the PII policy's own language set."
        >
          <Select
            data={PII_LANGUAGES.map((language) => ({ value: language, label: language }))}
            value={policy.locale ?? 'global'}
            disabled={readOnly}
            onChange={(value) =>
              update({ locale: value && value !== 'global' ? (value as PiiLanguage) : undefined })
            }
          />
        </FormField>
      </FormRow>

      <Switch
        size="sm"
        label="Also run the obfuscation pass"
        description="Catches zero-width characters, unicode look-alikes and de-obfuscated emails. It scans a normalised copy whose length differs from the raw text, so its findings carry no span — and a policy running it cannot bind to the streaming hook."
        checked={policy.detectObfuscated !== false}
        disabled={readOnly}
        onChange={(event) => update({ detectObfuscated: event.currentTarget.checked })}
      />

      {(policy.hooks ?? []).includes('output.stream.delta') && policy.detectObfuscated !== false && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={15} />} p="xs">
          <Text size="xs">
            This policy is bound to the streaming hook with the obfuscation pass on. It has no
            bounded match length in raw characters, so no hold-back window can make it correct there
            — the save will be refused.
          </Text>
        </Alert>
      )}

      {legacyCategories.length > 0 && (
        <div>
          <Text size="xs" fw={500} mb={4}>
            Migrated categories
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            The categories this guardrail carried inline before the PII service owned them. They are
            the stateless fallback used if the policy above cannot be read — set by the migration,
            not editable here, and unused once the policy resolves.
          </Text>
          <Group gap={4}>
            {legacyCategories.map((category: PiiCategoryDefinition) => (
              <Badge key={category.id} size="xs" variant="default">
                {category.label}
              </Badge>
            ))}
          </Group>
        </div>
      )}
    </Stack>
  );
}

// ── secrets ─────────────────────────────────────────────────────────────────

function SecretsConfig({
  policy,
  readOnly,
  onChange,
}: {
  policy: SecretsPolicyConfig;
  readOnly?: boolean;
  onChange: (next: SecretsPolicyConfig) => void;
}) {
  const update = (changes: Partial<SecretsPolicyConfig>) => onChange(assign(policy, changes));

  return (
    <Stack gap="sm">
      <Switch
        size="sm"
        label="Known vendor patterns"
        description="Stripe, OpenAI, AWS, GitHub, Slack, JWTs and PEM blocks. Deterministic, no database, no model."
        checked={policy.known !== false}
        disabled={readOnly}
        onChange={(event) => update({ known: event.currentTarget.checked })}
      />
      <Switch
        size="sm"
        label="Generic high-entropy strings"
        description="The \b[A-Za-z0-9-_]{32,}\b heuristic. It also fires on ordinary base64 and on UUIDs, which is why it is gated behind an entropy floor rather than shipped bare."
        checked={policy.genericHighEntropy === true}
        disabled={readOnly}
        onChange={(event) => update({ genericHighEntropy: event.currentTarget.checked })}
      />
      <FormRow cols={2}>
        <FormField
          label="Entropy floor"
          hint="Shannon bits per character a candidate must reach. Lower catches more and false-positives more."
        >
          <NumberInput
            min={0}
            max={8}
            step={0.1}
            decimalScale={2}
            value={policy.minEntropy ?? ''}
            placeholder="default"
            disabled={readOnly || policy.genericHighEntropy !== true}
            onChange={(value) =>
              update({ minEntropy: typeof value === 'number' ? value : undefined })
            }
          />
        </FormField>
        <FormField
          label="Known-safe values"
          hint="Test fixtures and documentation samples that would otherwise be redacted on every request."
        >
          <TagsInput
            placeholder="Paste a literal and press Enter"
            value={policy.allowValues ?? []}
            disabled={readOnly}
            onChange={(allowValues) => update({ allowValues })}
          />
        </FormField>
      </FormRow>
    </Stack>
  );
}

// ── word filter ─────────────────────────────────────────────────────────────

interface WordListSummary {
  key: string;
  name: string;
  wordCount: number;
}

function WordFilterConfig({
  policy,
  readOnly,
  onChange,
}: {
  policy: WordFilterPolicyConfig;
  readOnly?: boolean;
  onChange: (next: WordFilterPolicyConfig) => void;
}) {
  const [customLists, setCustomLists] = useState<WordListSummary[]>([]);
  const update = (changes: Partial<WordFilterPolicyConfig>) => onChange(assign(policy, changes));

  useEffect(() => {
    let cancelled = false;
    fetch('/api/guardrails/word-lists', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { wordLists: [] }))
      .then((data: { wordLists?: WordListSummary[] }) => {
        if (!cancelled) setCustomLists(data.wordLists ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Deleted keys stay in the select so they can be unselected.
  const listOptions = [
    ...customLists.map((list) => ({
      value: list.key,
      label: `${list.name} (${list.wordCount} words)`,
    })),
    ...(policy.customListKeys ?? [])
      .filter((key) => !customLists.some((list) => list.key === key))
      .map((key) => ({ value: key, label: `${key} (missing)` })),
  ];

  return (
    <Stack gap="sm">
      <div>
        <Text size="xs" fw={500} mb={6}>
          Built-in lists
        </Text>
        <SimpleGrid cols={2} spacing="xs">
          {WORD_FILTER_BUILTIN_LISTS.map((list) => (
            <Tooltip key={list.id} label={list.description} withArrow multiline w={240} position="top">
              <Checkbox
                size="xs"
                label={list.label}
                checked={policy.builtinLists?.[list.id] ?? false}
                disabled={readOnly}
                onChange={(event) =>
                  update({
                    builtinLists: { ...policy.builtinLists, [list.id]: event.currentTarget.checked },
                  })
                }
              />
            </Tooltip>
          ))}
        </SimpleGrid>
      </div>

      <FormField
        label="Uploaded word lists"
        hint="Tenant lists (CSV/TXT uploads). Manage them from the Guardrails page → Word lists."
      >
        <MultiSelect
          placeholder={listOptions.length ? 'Select lists…' : 'No uploaded lists yet'}
          data={listOptions}
          value={policy.customListKeys ?? []}
          disabled={readOnly}
          searchable
          clearable
          onChange={(customListKeys) => update({ customListKeys })}
        />
      </FormField>

      <FormField
        label="Words"
        hint="Matched after normalisation — case, diacritics, leetspeak and spacing — so 's p a m' and 'sp4m' hit too."
      >
        <TagsInput
          placeholder="Add a word and press Enter"
          value={policy.words ?? []}
          disabled={readOnly}
          onChange={(words) => update({ words })}
        />
      </FormField>

      <FormField
        label="Inline patterns"
        hint="One per line, evaluated case-insensitively. These are carried from the legacy word filter and produce NO span, so they cannot redact in place or run on a stream — a new pattern belongs in a regex policy instead."
      >
        <Textarea
          placeholder={'\\bcompetitor-name\\b\ninternal-codename-\\d+'}
          value={(policy.regexes ?? []).join('\n')}
          readOnly={readOnly}
          autosize
          minRows={2}
          onChange={(event) =>
            update({
              regexes: event.currentTarget.value.split('\n').filter((line) => line.trim() !== ''),
            })
          }
        />
      </FormField>
    </Stack>
  );
}

// ── regex ───────────────────────────────────────────────────────────────────

/**
 * A rule LIST, because that is what the type is: `rules: GuardrailRegexRule[]`.
 *
 * `maxMatchChars` is the field that earns the explanation. It sizes the
 * streaming hold-back window: the gate can only promise that no match straddles
 * the release frontier if the withheld tail is at least as long as the longest
 * possible match. One rule without a declared bound makes the WHOLE policy
 * unbounded (`policyMaxMatchChars` returns 0 for it), and an unbounded policy
 * cannot bind to the stream at all.
 */
function RegexConfig({
  policy,
  readOnly,
  onChange,
}: {
  policy: RegexPolicyConfig;
  readOnly?: boolean;
  onChange: (next: RegexPolicyConfig) => void;
}) {
  const rules = policy.rules ?? [];
  const update = (next: RegexRule[]) => onChange(assign(policy, { rules: next }));
  const patch = (index: number, changes: Partial<RegexRule>) =>
    update(rules.map((rule, i) => (i === index ? { ...rule, ...changes } : rule)));

  const takenRuleIds = new Set(rules.map((rule) => rule.id));
  const freshRuleId = (base: string): string => {
    if (!takenRuleIds.has(base)) return base;
    for (let n = 2; n < 500; n += 1) {
      if (!takenRuleIds.has(`${base}-${n}`)) return `${base}-${n}`;
    }
    return `${base}-${Date.now()}`;
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {rules.length} {rules.length === 1 ? 'rule' : 'rules'}. They run in order, and every match
          carries a span — which is what lets a finding redact exactly the matched characters.
        </Text>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={13} />}
          disabled={readOnly}
          onClick={() =>
            update([
              ...rules,
              {
                id: freshRuleId('rule'),
                label: '',
                pattern: '',
                category: 'custom',
                severity: 'medium',
                maxMatchChars: 64,
              },
            ])
          }
        >
          Add rule
        </Button>
      </Group>

      {rules.length === 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={15} />} p="xs">
          <Text size="xs">A regex policy with no rules matches nothing. The save will be refused.</Text>
        </Alert>
      )}

      {rules.map((rule, index) => {
        const bad = rule.pattern.length > 0 && !compiles(rule.pattern, rule.flags);
        const bound = Number(rule.maxMatchChars);
        const badBound = !Number.isFinite(bound) || bound <= 0 || bound > REGEX_MAX_MATCH_CHARS;
        return (
          <Card key={`${rule.id}-${index}`} withBorder radius="sm" p="sm">
            <Group justify="space-between" mb={6} wrap="nowrap">
              <Text size="xs" ff="monospace" c="dimmed">
                {rule.id || `rule ${index + 1}`}
              </Text>
              <Group gap={4}>
                <Tooltip label="Duplicate this rule" withArrow>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    disabled={readOnly}
                    onClick={() => {
                      const copy: RegexRule = {
                        ...rule,
                        id: freshRuleId(`${rule.id || 'rule'}-copy`),
                        label: rule.label ? `${rule.label} (copy)` : '',
                      };
                      update([...rules.slice(0, index + 1), copy, ...rules.slice(index + 1)]);
                    }}
                  >
                    <IconCopy size={13} />
                  </Button>
                </Tooltip>
                <Tooltip label="Remove this rule" withArrow>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    disabled={readOnly}
                    onClick={() => update(rules.filter((_, i) => i !== index))}
                  >
                    <IconTrash size={13} />
                  </Button>
                </Tooltip>
              </Group>
            </Group>

            <Stack gap="xs">
              <TextInput
                size="xs"
                label="Pattern"
                placeholder="\\b(?:union\\s+select|;\\s*drop\\s+table)\\b"
                styles={{ input: { fontFamily: 'monospace' } }}
                value={rule.pattern}
                readOnly={readOnly}
                error={bad ? 'Not a valid pattern — a rule that cannot compile never fires' : undefined}
                onChange={(event) => patch(index, { pattern: event.currentTarget.value })}
              />
              <Group grow align="flex-start">
                <TextInput
                  size="xs"
                  label="Name"
                  placeholder="union-select"
                  value={rule.label}
                  readOnly={readOnly}
                  onChange={(event) => patch(index, { label: event.currentTarget.value })}
                />
                <TextInput
                  size="xs"
                  label="Id"
                  description="Named on every finding this rule raises"
                  value={rule.id}
                  readOnly={readOnly}
                  onChange={(event) => patch(index, { id: event.currentTarget.value })}
                />
                <TextInput
                  size="xs"
                  label="Flags"
                  placeholder="i"
                  value={rule.flags ?? ''}
                  readOnly={readOnly}
                  onChange={(event) => patch(index, { flags: event.currentTarget.value || undefined })}
                />
              </Group>
              <Group grow align="flex-start">
                <TextInput
                  size="xs"
                  label="Category"
                  description="Grouped by this in findings and dashboards"
                  placeholder="sqli"
                  value={rule.category}
                  readOnly={readOnly}
                  onChange={(event) => patch(index, { category: event.currentTarget.value })}
                />
                <Select
                  size="xs"
                  label="Severity"
                  data={[
                    { value: 'low', label: 'low' },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                  ]}
                  value={rule.severity}
                  disabled={readOnly}
                  onChange={(value) =>
                    patch(index, {
                      severity: value === 'low' || value === 'high' ? value : 'medium',
                    })
                  }
                />
                <Select
                  size="xs"
                  label="Action"
                  description="Overrides the policy's action"
                  data={[
                    { value: '', label: "Use the policy's action" },
                    { value: 'block', label: 'Block' },
                    { value: 'redact', label: 'Redact' },
                    { value: 'flag', label: 'Flag' },
                  ]}
                  value={rule.action ?? ''}
                  disabled={readOnly}
                  onChange={(value) =>
                    patch(index, {
                      action:
                        value === 'block' || value === 'redact' || value === 'flag' ? value : undefined,
                    })
                  }
                />
              </Group>
              <Group grow align="flex-start">
                <NumberInput
                  size="xs"
                  label="Longest match (chars)"
                  description={`Required, 1–${REGEX_MAX_MATCH_CHARS}. It sizes the streaming hold-back window — a rule without it makes the whole policy unbounded, and an unbounded policy cannot bind to the stream.`}
                  min={1}
                  max={REGEX_MAX_MATCH_CHARS}
                  value={rule.maxMatchChars}
                  disabled={readOnly}
                  error={badBound ? `Must be between 1 and ${REGEX_MAX_MATCH_CHARS}` : undefined}
                  onChange={(value) =>
                    patch(index, { maxMatchChars: typeof value === 'number' ? value : 0 })
                  }
                />
                <NumberInput
                  size="xs"
                  label="Capture group"
                  description="Redact only this group instead of the whole match. Leave empty for the whole match."
                  min={0}
                  max={20}
                  value={rule.captureGroup ?? ''}
                  disabled={readOnly}
                  onChange={(value) =>
                    patch(index, { captureGroup: typeof value === 'number' ? value : undefined })
                  }
                />
              </Group>
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}

// ── the three LLM families ──────────────────────────────────────────────────

function ModelSelect({
  value,
  models,
  onChange,
  readOnly,
  hint,
}: {
  value: string | undefined;
  models: Array<{ value: string; label: string }>;
  onChange: (value: string | undefined) => void;
  readOnly?: boolean;
  hint: string;
}) {
  const none = models.length === 0;
  return (
    <FormField
      label="Model"
      required
      hint={
        none
          ? 'This project has no LLM models yet. Add one under Model Hub — without a model this policy reads as active while nothing runs.'
          : hint
      }
    >
      <Select
        placeholder={none ? 'No LLM models in this project' : 'Select an LLM model…'}
        data={models}
        value={value ?? null}
        searchable
        disabled={readOnly || none}
        error={value?.trim() ? undefined : 'Required — without a model nothing runs'}
        onChange={(next) => onChange(next ?? undefined)}
      />
    </FormField>
  );
}

function ModerationConfig({
  policy,
  models,
  readOnly,
  onChange,
}: {
  policy: ModerationPolicyConfig;
  models: Array<{ value: string; label: string }>;
  readOnly?: boolean;
  onChange: (next: ModerationPolicyConfig) => void;
}) {
  const update = (changes: Partial<ModerationPolicyConfig>) => onChange(assign(policy, changes));
  const on = Object.values(policy.categories ?? {}).filter(Boolean).length;

  return (
    <Stack gap="sm">
      <ModelSelect
        value={policy.modelKey}
        models={models}
        readOnly={readOnly}
        hint="The LLM that classifies content against the categories below."
        onChange={(modelKey) => update({ modelKey })}
      />
      <div>
        <Group justify="space-between" mb={6}>
          <Text size="xs" fw={500}>
            Categories to detect
          </Text>
          <Badge size="xs" variant="light">
            {on} enabled
          </Badge>
        </Group>
        <SimpleGrid cols={2} spacing="xs">
          {MODERATION_CATEGORIES.map((category: ModerationCategoryDefinition) => (
            <Checkbox
              key={category.id}
              size="xs"
              label={category.label}
              checked={policy.categories?.[category.id] ?? false}
              disabled={readOnly}
              onChange={(event) =>
                update({
                  categories: { ...policy.categories, [category.id]: event.currentTarget.checked },
                })
              }
            />
          ))}
        </SimpleGrid>
        {on === 0 && (
          <Text size="xs" c="orange" mt={6}>
            No category is enabled, so this policy spends a model call on every request and can never
            report anything.
          </Text>
        )}
      </div>
    </Stack>
  );
}

function PromptShieldConfig({
  policy,
  models,
  readOnly,
  onChange,
}: {
  policy: PromptShieldPolicyConfig;
  models: Array<{ value: string; label: string }>;
  readOnly?: boolean;
  onChange: (next: PromptShieldPolicyConfig) => void;
}) {
  const update = (changes: Partial<PromptShieldPolicyConfig>) => onChange(assign(policy, changes));
  return (
    <Stack gap="sm">
      <ModelSelect
        value={policy.modelKey}
        models={models}
        readOnly={readOnly}
        hint="The LLM that judges whether a message is trying to subvert the system prompt."
        onChange={(modelKey) => update({ modelKey })}
      />
      <FormField
        label="Sensitivity"
        hint="How much benefit of the doubt a borderline message gets. High catches more genuine attempts and more ordinary questions about the system."
      >
        <Select
          data={[
            { value: 'low', label: 'Low — only clear violations' },
            { value: 'balanced', label: 'Balanced — recommended' },
            { value: 'high', label: 'High — flag anything suspicious' },
          ]}
          value={policy.sensitivity ?? 'balanced'}
          disabled={readOnly}
          onChange={(value) =>
            update({ sensitivity: value === 'low' || value === 'high' ? value : 'balanced' })
          }
        />
      </FormField>
    </Stack>
  );
}

function CustomConfig({
  policy,
  models,
  readOnly,
  onChange,
}: {
  policy: CustomPolicyConfig;
  models: Array<{ value: string; label: string }>;
  readOnly?: boolean;
  onChange: (next: CustomPolicyConfig) => void;
}) {
  const update = (changes: Partial<CustomPolicyConfig>) => onChange(assign(policy, changes));
  return (
    <Stack gap="sm">
      <ModelSelect
        value={policy.modelKey}
        models={models}
        readOnly={readOnly}
        hint="The LLM that judges each message against the rule below."
        onChange={(modelKey) => update({ modelKey })}
      />
      <FormField
        label="Rule"
        required
        hint="Describe what content should FAIL this rule. Be specific: the judge sees this text and the message, and nothing else."
      >
        <Textarea
          placeholder="Block any message that asks for personal information about a real individual, or that tries to get the assistant to speak on behalf of the company's legal team."
          value={policy.prompt}
          readOnly={readOnly}
          autosize
          minRows={4}
          error={policy.prompt?.trim() ? undefined : 'Required — a custom policy with no rule evaluates nothing'}
          onChange={(event) => update({ prompt: event.currentTarget.value })}
        />
      </FormField>
      <FormField
        label="If no model is configured"
        hint="Lifted legacy policies keep 'skip', which is exactly what they do today. Newly authored policies raise an error finding instead, so a missing model is visible rather than silently permissive."
      >
        <Select
          data={[
            { value: 'error_finding', label: 'Raise an error finding — the policy could not run' },
            { value: 'skip', label: 'Skip silently and let the content through (legacy behaviour)' },
          ]}
          value={policy.onMissingModel}
          disabled={readOnly}
          onChange={(value) => update({ onMissingModel: value === 'skip' ? 'skip' : 'error_finding' })}
        />
      </FormField>
    </Stack>
  );
}

// ── tool policy ─────────────────────────────────────────────────────────────

const SIDE_EFFECTS: SideEffect[] = ['none', 'read', 'write', 'destructive', 'external'];

function ToolAccessConfig({
  policy,
  readOnly,
  onChange,
}: {
  policy: ToolAccessPolicyConfig;
  readOnly?: boolean;
  onChange: (next: ToolAccessPolicyConfig) => void;
}) {
  const update = (changes: Partial<ToolAccessPolicyConfig>) => onChange(assign(policy, changes));

  return (
    <Stack gap="md">
      {/* ── which tools ── */}
      <Stack gap="sm">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          Which tools
        </Text>
        <FormRow cols={2}>
          <FormField
            label="Allowed tools"
            hint="Canonical policy names — `serverKey/tool` for MCP, `sandbox.fs.read` for the toolbox. Empty means every tool is allowed unless denied."
          >
            <TagsInput
              placeholder="mcp-github/create_issue"
              value={policy.allow ?? []}
              disabled={readOnly}
              onChange={(allow) => update({ allow: allow.length ? allow : undefined })}
            />
          </FormField>
          <FormField label="Denied tools" hint="Checked first: a denied tool is denied even if it is also allowed.">
            <TagsInput
              placeholder="sandbox.sessions.exec"
              value={policy.deny ?? []}
              disabled={readOnly}
              onChange={(deny) => update({ deny: deny.length ? deny : undefined })}
            />
          </FormField>
        </FormRow>

        <FormField
          label="Default side effect"
          hint="What an undeclared tool counts as. Defaulting to 'external' made every unknown tool suspicious, which is why this is 'read'."
        >
          <Select
            data={SIDE_EFFECTS.map((effect) => ({ value: effect, label: effect }))}
            value={policy.defaultSideEffect ?? 'read'}
            disabled={readOnly}
            onChange={(value) =>
              update({ defaultSideEffect: (value as SideEffect | null) ?? 'read' })
            }
          />
        </FormField>

        <KeyEnumEditor
          label="Side effect per tool"
          hint="What each tool actually does. This is what the side-effect actions below key on."
          keyPlaceholder="sandbox.fs.write"
          options={SIDE_EFFECTS}
          value={policy.sideEffects ?? {}}
          readOnly={readOnly}
          onChange={(sideEffects) =>
            update({ sideEffects: Object.keys(sideEffects).length ? sideEffects : undefined })
          }
        />

        <div>
          <Text size="xs" fw={500} mb={4}>
            Action per side effect
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            Destructive and external default to warn rather than block, which reproduces today&apos;s
            ACTUAL behaviour: the adapter those rungs resolved to is a pass-through, so the tool ran
            anyway.
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {SIDE_EFFECTS.map((effect) => (
              <Select
                key={effect}
                size="xs"
                label={effect}
                data={[
                  { value: '', label: "Use the policy's action" },
                  { value: 'allow', label: 'Allow' },
                  { value: 'flag', label: 'Flag' },
                  { value: 'warn', label: 'Warn' },
                  { value: 'redact', label: 'Redact' },
                  { value: 'block', label: 'Block' },
                ]}
                value={policy.sideEffectActions?.[effect] ?? ''}
                disabled={readOnly}
                onChange={(value) => {
                  const next = { ...policy.sideEffectActions };
                  if (isSafetyAction(value)) next[effect] = value;
                  else delete next[effect];
                  update({ sideEffectActions: Object.keys(next).length ? next : undefined });
                }}
              />
            ))}
          </SimpleGrid>
        </div>

        <KeyListEditor
          label="Roles allowed per tool"
          hint="Keyed on the AUTHENTICATED actor's roles. A tool listed here is refused for anyone outside its list."
          keyPlaceholder="sandbox.sessions.exec"
          valuePlaceholder="admin"
          value={policy.allowedRoles ?? {}}
          readOnly={readOnly}
          onChange={(allowedRoles) =>
            update({ allowedRoles: Object.keys(allowedRoles).length ? allowedRoles : undefined })
          }
        />
      </Stack>

      <Divider />

      {/* ── where they may reach ── */}
      <Stack gap="sm">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          Where they may reach
        </Text>
        <FormRow cols={2}>
          <FormField label="Allowed domains" hint="Empty means any domain not explicitly denied.">
            <TagsInput
              placeholder="api.acme.com"
              value={policy.allowedDomains ?? []}
              disabled={readOnly}
              onChange={(allowedDomains) =>
                update({ allowedDomains: allowedDomains.length ? allowedDomains : undefined })
              }
            />
          </FormField>
          <FormField label="Denied domains" hint="Checked first.">
            <TagsInput
              placeholder="internal.acme.com"
              value={policy.deniedDomains ?? []}
              disabled={readOnly}
              onChange={(deniedDomains) =>
                update({ deniedDomains: deniedDomains.length ? deniedDomains : undefined })
              }
            />
          </FormField>
        </FormRow>

        <Switch
          size="sm"
          label="Deny private networks"
          description="SSRF guard on DECLARED url arguments only. It resolves DNS, so it never runs on scraped strings and never on a streaming hook."
          checked={policy.denyPrivateNetworks === true}
          disabled={readOnly}
          onChange={(event) => update({ denyPrivateNetworks: event.currentTarget.checked })}
        />

        <FormRow cols={2}>
          <FormField
            label="Allowed path prefixes"
            hint="Matched on a POSIX-normalised path — a raw startsWith lets /workspace/../etc/shadow walk straight through."
          >
            <TagsInput
              placeholder="/workspace"
              value={policy.allowedPathPrefixes ?? []}
              disabled={readOnly}
              onChange={(allowedPathPrefixes) =>
                update({
                  allowedPathPrefixes: allowedPathPrefixes.length ? allowedPathPrefixes : undefined,
                })
              }
            />
          </FormField>
          <FormField label="Denied path prefixes" hint="Checked first.">
            <TagsInput
              placeholder="/etc"
              value={policy.deniedPathPrefixes ?? []}
              disabled={readOnly}
              onChange={(deniedPathPrefixes) =>
                update({
                  deniedPathPrefixes: deniedPathPrefixes.length ? deniedPathPrefixes : undefined,
                })
              }
            />
          </FormField>
        </FormRow>

        <FormField label="Filesystem root" hint="What the path prefixes above resolve against.">
          <TextInput
            placeholder="/workspace"
            value={policy.fsRoot ?? ''}
            readOnly={readOnly}
            onChange={(event) => update({ fsRoot: event.currentTarget.value || undefined })}
          />
        </FormField>

        <KeyListEditor
          label="Which arguments carry a URL"
          hint="Per tool, as JSON pointers into the arguments. Declared paths are authoritative — scraping every string for https:// both missed real targets (//evil.com, file:, scheme-less hosts) and fired on any prose containing a slash."
          keyPlaceholder="http_request"
          valuePlaceholder="/url"
          value={policy.urlArgPaths ?? {}}
          readOnly={readOnly}
          onChange={(urlArgPaths) =>
            update({ urlArgPaths: Object.keys(urlArgPaths).length ? urlArgPaths : undefined })
          }
        />
        <KeyListEditor
          label="Which arguments carry a path"
          hint="Same, for filesystem arguments."
          keyPlaceholder="sandbox.fs.read"
          valuePlaceholder="/path"
          value={policy.pathArgPaths ?? {}}
          readOnly={readOnly}
          onChange={(pathArgPaths) =>
            update({ pathArgPaths: Object.keys(pathArgPaths).length ? pathArgPaths : undefined })
          }
        />

        <Switch
          size="sm"
          label="Also scan undeclared string arguments"
          description="The old scrape, kept as a clamped fallback: its findings are held to medium/flag and never trigger DNS resolution."
          checked={policy.scanUndeclaredStrings === true}
          disabled={readOnly}
          onChange={(event) => update({ scanUndeclaredStrings: event.currentTarget.checked })}
        />
      </Stack>

      <Divider />

      {/* ── payload shape ── */}
      <Stack gap="sm">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          Payload shape
        </Text>
        <FormRow cols={3}>
          <FormField label="Max argument bytes" hint="0 or empty = no limit.">
            <NumberInput
              min={0}
              value={policy.maxArgBytes ?? ''}
              disabled={readOnly}
              onChange={(value) =>
                update({ maxArgBytes: typeof value === 'number' && value > 0 ? value : undefined })
              }
            />
          </FormField>
          <FormField label="Max result bytes" hint="0 or empty = no limit.">
            <NumberInput
              min={0}
              value={policy.maxResultBytes ?? ''}
              disabled={readOnly}
              onChange={(value) =>
                update({ maxResultBytes: typeof value === 'number' && value > 0 ? value : undefined })
              }
            />
          </FormField>
          <FormField
            label="Max argument depth"
            hint="JSON-bomb defence, default 32. It is also the depth the scanners descend to, so lowering it leaves deeper content genuinely unscanned."
          >
            <NumberInput
              min={1}
              max={64}
              value={policy.maxArgDepth ?? ''}
              placeholder="32"
              disabled={readOnly}
              onChange={(value) =>
                update({ maxArgDepth: typeof value === 'number' ? value : undefined })
              }
            />
          </FormField>
        </FormRow>

        <JsonField
          label="Argument schemas"
          hint="Per tool. A deliberate subset of JSON Schema — type, required, properties, enum, additionalProperties — and nothing else: no $ref, no remote schemas."
          placeholder={'{\n  "send_email": {\n    "type": "object",\n    "required": ["to"]\n  }\n}'}
          value={policy.argumentSchemas}
          readOnly={readOnly}
          onChange={(argumentSchemas) => update({ argumentSchemas })}
        />
      </Stack>
    </Stack>
  );
}

function isSafetyAction(value: string | null): value is SafetyAction {
  return (
    value === 'allow' || value === 'block' || value === 'warn' || value === 'flag' || value === 'redact'
  );
}

// ── webhook ─────────────────────────────────────────────────────────────────

function WebhookConfig({
  policy,
  readOnly,
  onChange,
}: {
  policy: WebhookPolicyConfig;
  readOnly?: boolean;
  onChange: (next: WebhookPolicyConfig) => void;
}) {
  const update = (changes: Partial<WebhookPolicyConfig>) => onChange(assign(policy, changes));
  const httpsOk = /^https:\/\//i.test(policy.url ?? '');

  return (
    <Stack gap="sm">
      <FormField
        label="Endpoint"
        required
        hint="https only, enforced at save: this endpoint's answer decides whether a request is blocked, so a plaintext hop is an enforcement bypass rather than merely a privacy leak. The call goes out through the SSRF-guarded fetch."
      >
        <TextInput
          placeholder="https://legal.acme.com/guardrail"
          value={policy.url}
          readOnly={readOnly}
          error={httpsOk ? undefined : 'Must start with https://'}
          onChange={(event) => update({ url: event.currentTarget.value })}
        />
      </FormField>

      <FormField
        label="What to send"
        hint="'Text only' keeps structured personal data off the wire. The full subject carries the segments, the tool name and the arguments — useful for a policy engine, and a much larger disclosure."
      >
        <Select
          data={[
            { value: 'text', label: 'Text only — the flattened content' },
            { value: 'subject', label: 'The full subject — segments, tool name, arguments' },
          ]}
          value={policy.send ?? 'text'}
          disabled={readOnly}
          onChange={(value) => update({ send: value === 'subject' ? 'subject' : 'text' })}
        />
      </FormField>

      <FormRow cols={2}>
        <FormField
          label="Bearer credential"
          hint="Provider key holding the encrypted bearer token. The secret itself is never stored on the guardrail."
        >
          <TextInput
            placeholder="provider key"
            value={policy.credentialProviderKey ?? ''}
            readOnly={readOnly}
            onChange={(event) =>
              update({ credentialProviderKey: event.currentTarget.value || undefined })
            }
          />
        </FormField>
        <FormField
          label="Signing secret"
          hint="Config key of the HMAC secret used to sign `${timestamp}.${body}`, so your endpoint can prove the call came from here."
        >
          <TextInput
            placeholder="config key"
            value={policy.signingSecretRef ?? ''}
            readOnly={readOnly}
            onChange={(event) => update({ signingSecretRef: event.currentTarget.value || undefined })}
          />
        </FormField>
      </FormRow>

      <FormField
        label="Retries"
        hint="Each retry spends the policy's budget again. A blocking policy that retries twice can triple the latency it adds."
      >
        <Select
          data={[
            { value: '0', label: 'None' },
            { value: '1', label: '1 retry' },
            { value: '2', label: '2 retries' },
          ]}
          value={String(policy.retries ?? 0)}
          disabled={readOnly}
          onChange={(value) => update({ retries: value === '1' ? 1 : value === '2' ? 2 : 0 })}
        />
      </FormField>

      <KeyValueEditor
        label="Headers"
        hint="Sent on every call. Do not put a secret here — use the bearer credential above, which is stored encrypted."
        keyPlaceholder="x-team"
        valuePlaceholder="risk"
        value={policy.headers ?? {}}
        readOnly={readOnly}
        onChange={(headers) => update({ headers: Object.keys(headers).length ? headers : undefined })}
      />
    </Stack>
  );
}

// ── small shared editors ────────────────────────────────────────────────────

/** Record<string, string> — headers. */
function KeyValueEditor({
  label,
  hint,
  keyPlaceholder,
  valuePlaceholder,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  hint: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  value: Record<string, string>;
  readOnly?: boolean;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(value);
  const rename = (from: string, to: string) => {
    const next: Record<string, string> = {};
    for (const [key, entry] of entries) next[key === from ? to : key] = entry;
    onChange(next);
  };

  return (
    <FormField
      label={label}
      hint={hint}
      action={
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          disabled={readOnly}
          onClick={() => onChange({ ...value, '': '' })}
        >
          Add
        </Button>
      }
    >
      <Stack gap={6}>
        {entries.length === 0 && (
          <Text size="xs" c="dimmed">
            None.
          </Text>
        )}
        {entries.map(([key, entry], index) => (
          <Group key={index} gap={6} wrap="nowrap">
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              placeholder={keyPlaceholder}
              value={key}
              readOnly={readOnly}
              onChange={(event) => rename(key, event.currentTarget.value)}
            />
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              placeholder={valuePlaceholder}
              value={entry}
              readOnly={readOnly}
              onChange={(event) => onChange({ ...value, [key]: event.currentTarget.value })}
            />
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={readOnly}
              onClick={() => {
                const next = { ...value };
                delete next[key];
                onChange(next);
              }}
            >
              <IconTrash size={13} />
            </Button>
          </Group>
        ))}
      </Stack>
    </FormField>
  );
}

/** Record<string, string[]> — allowedRoles, urlArgPaths, pathArgPaths. */
function KeyListEditor({
  label,
  hint,
  keyPlaceholder,
  valuePlaceholder,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  hint: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  value: Record<string, string[]>;
  readOnly?: boolean;
  onChange: (next: Record<string, string[]>) => void;
}) {
  const entries = Object.entries(value);
  const rename = (from: string, to: string) => {
    const next: Record<string, string[]> = {};
    for (const [key, list] of entries) next[key === from ? to : key] = list;
    onChange(next);
  };

  return (
    <FormField
      label={label}
      hint={hint}
      action={
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          disabled={readOnly}
          onClick={() => onChange({ ...value, '': [] })}
        >
          Add
        </Button>
      }
    >
      <Stack gap={6}>
        {entries.length === 0 && (
          <Text size="xs" c="dimmed">
            None.
          </Text>
        )}
        {entries.map(([key, list], index) => (
          <Group key={index} gap={6} wrap="nowrap" align="flex-start">
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              placeholder={keyPlaceholder}
              value={key}
              readOnly={readOnly}
              onChange={(event) => rename(key, event.currentTarget.value)}
            />
            <TagsInput
              size="xs"
              style={{ flex: 2 }}
              placeholder={valuePlaceholder}
              value={list}
              disabled={readOnly}
              onChange={(next) => onChange({ ...value, [key]: next })}
            />
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={readOnly}
              onClick={() => {
                const next = { ...value };
                delete next[key];
                onChange(next);
              }}
            >
              <IconTrash size={13} />
            </Button>
          </Group>
        ))}
      </Stack>
    </FormField>
  );
}

/** Record<string, SideEffect> — one enum per tool. */
function KeyEnumEditor({
  label,
  hint,
  keyPlaceholder,
  options,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  hint: string;
  keyPlaceholder: string;
  options: SideEffect[];
  value: Record<string, SideEffect>;
  readOnly?: boolean;
  onChange: (next: Record<string, SideEffect>) => void;
}) {
  const entries = Object.entries(value);
  const rename = (from: string, to: string) => {
    const next: Record<string, SideEffect> = {};
    for (const [key, entry] of entries) next[key === from ? to : key] = entry;
    onChange(next);
  };

  return (
    <FormField
      label={label}
      hint={hint}
      action={
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          disabled={readOnly}
          onClick={() => onChange({ ...value, '': 'read' })}
        >
          Add
        </Button>
      }
    >
      <Stack gap={6}>
        {entries.length === 0 && (
          <Text size="xs" c="dimmed">
            None — every tool falls back to the default side effect.
          </Text>
        )}
        {entries.map(([key, effect], index) => (
          <Group key={index} gap={6} wrap="nowrap">
            <TextInput
              size="xs"
              style={{ flex: 2 }}
              placeholder={keyPlaceholder}
              value={key}
              readOnly={readOnly}
              onChange={(event) => rename(key, event.currentTarget.value)}
            />
            <Select
              size="xs"
              style={{ flex: 1 }}
              data={options.map((option) => ({ value: option, label: option }))}
              value={effect}
              disabled={readOnly}
              onChange={(next) => {
                if (!isSideEffect(next)) return;
                onChange({ ...value, [key]: next });
              }}
            />
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={readOnly}
              onClick={() => {
                const next = { ...value };
                delete next[key];
                onChange(next);
              }}
            >
              <IconTrash size={13} />
            </Button>
          </Group>
        ))}
      </Stack>
    </FormField>
  );
}

function isSideEffect(value: string | null): value is SideEffect {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'external'
  );
}

/**
 * `Record<string, JsonSchemaLite>` as JSON.
 *
 * The text is LOCAL state: parsing on every keystroke and writing only when it
 * happens to be valid would delete half of what someone is typing. The value is
 * written back on a successful parse and the error shown otherwise, so nothing
 * is lost and nothing invalid is stored.
 */
function JsonField({
  label,
  hint,
  placeholder,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: Record<string, JsonSchemaLite> | undefined;
  readOnly?: boolean;
  onChange: (next: Record<string, JsonSchemaLite> | undefined) => void;
}) {
  const [text, setText] = useState(() => (value ? JSON.stringify(value, null, 2) : ''));
  const [error, setError] = useState<string | null>(null);

  return (
    <FormField label={label} hint={hint}>
      <Textarea
        placeholder={placeholder}
        styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
        value={text}
        readOnly={readOnly}
        autosize
        minRows={4}
        error={error}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (!next.trim()) {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(next);
            if (!isSchemaRecord(parsed)) {
              setError('Expected an object mapping a tool name to a schema object.');
              return;
            }
            setError(null);
            onChange(parsed);
          } catch {
            setError('Not valid JSON yet.');
          }
        }}
      />
    </FormField>
  );
}

/**
 * A SHALLOW shape check: an object whose values are objects. It is deliberately
 * not a full JSON Schema validator — the server owns that judgement — but it
 * does stop an array or a string from being written where a schema map belongs.
 */
function isSchemaRecord(value: unknown): value is Record<string, JsonSchemaLite> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}
