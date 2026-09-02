'use client';

/**
 * The consumer side of the hook plane: which guardrails a MODEL or an AGENT
 * attaches, and which of the five hooks each one covers there.
 *
 * `GuardrailHooksMatrix` edits one guardrail's own configuration (families x
 * hooks). This edits the binding LIST that points at guardrails — the shape
 * that replaced the single `inputGuardrailKey` / `outputGuardrailKey` slots.
 * The two are different questions and deliberately different controls: a
 * guardrail declares where it CAN run, a binding decides where it DOES.
 *
 * Shared by `ModelGuardrailModal` and the agent detail page rather than
 * duplicated, because the divergence would be invisible: two screens writing
 * the same column with different rules produce rows that only one of them can
 * round-trip.
 *
 * ── WHAT THIS COMPONENT MAY NOT IMPORT ────────────────────────────────────
 * `hooks/contract` only — the leaf of the hook plane (types plus pure
 * constants). `hooks/legacy` and `hooks/engine` both pull in the
 * `@/lib/database` barrel, which constructs providers on load. `declaredHooks`
 * below therefore RE-DERIVES what the server computes in
 * `declaredGuardrailHooks` (`server/api/plugins/guardrail-bindings.ts`); the
 * server stays authoritative and its 400 is what an operator sees if the two
 * ever disagree. Same trade-off, and same reason, as `describeIssues()` in
 * `GuardrailHooksMatrix`.
 */

import { useMemo } from 'react';
import {
  ActionIcon,
  Badge,
  Checkbox,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import { HOOK_IDS } from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailHooksConfig, HookId } from '@/lib/services/guardrail/hooks/contract';

// ── vocabulary ────────────────────────────────────────────────────────────

/** Short enough for a checkbox label; the full sentence lives in the tooltip. */
const HOOK_LABEL: Readonly<Record<HookId, string>> = {
  // "Prompt" rather than "User turn": the pairing that has to read clearly at a
  // glance is Prompt/Input, and the hint carries the once-per-run distinction.
  'prompt.pre': 'Prompt',
  'input.pre': 'Input',
  'output.pre': 'Output',
  'output.stream.delta': 'Streaming output',
  'tool.pre': 'Before a tool',
  'tool.post': 'After a tool',
};

const HOOK_HINT: Readonly<Record<HookId, string>> = {
  'prompt.pre':
    'What the person typed, once per run. Emitted by a remote enforcement point (an SDK) — no console surface emits it yet, so a binding here is inert until one does.',
  'input.pre': 'The prompt and history, before every model call.',
  'output.pre': 'The complete answer, before it reaches the caller.',
  'output.stream.delta':
    'Text held back and adjudicated while it streams, so a block lands before the bytes leave.',
  'tool.pre': 'A tool call and its arguments, before the tool runs.',
  'tool.post': 'A tool result, before the model sees it.',
};

/**
 * What a guardrail written before the hook plane covers.
 *
 * Mirrors `liftLegacyBindings()` exactly: a legacy row was bindable to the two
 * direction slots and nothing else, so those are the two hooks it declares once
 * lifted. Rendering such a guardrail as covering NOTHING would disable every
 * checkbox on the one guardrail most consumers are actually bound to.
 */
const LEGACY_DECLARED_HOOKS: readonly HookId[] = ['input.pre', 'output.pre'];

const TOOL_HOOKS: readonly HookId[] = ['tool.pre', 'tool.post'];

// ── data in ───────────────────────────────────────────────────────────────

/** One row of `GET /api/guardrails`, narrowed to what a binding decision needs. */
export interface GuardrailBindingOption {
  key: string;
  name: string;
  type?: 'preset' | 'custom';
  action?: string;
  enabled?: boolean;
  hooks?: GuardrailHooksConfig;
  hooksVersion?: number;
}

/**
 * `IGuardrailBinding` verbatim, ABSENT `hooks` included.
 *
 * An omitted list is not the same as an empty one and must survive an edit
 * round-trip: absent means "wherever this guardrail declares it runs", so a
 * later change to the guardrail's own policies reaches every consumer bound that
 * way, while `[]` means "attached but parked, runs nowhere". Materialising the
 * former into the latter on load is a silent disarm — the guardrail keeps its
 * row in the UI and stops enforcing on the next save of an unrelated field —
 * so this type mirrors the persisted shape rather than normalising it.
 *
 * Nothing renders "all five" as a result: the control knows what each guardrail
 * declares (`declaredHooks`) and ticks exactly those boxes for an absent list.
 */
export interface GuardrailBindingRow {
  key: string;
  hooks?: HookId[];
}

export interface GuardrailBindingListProps {
  /** Every guardrail the operator may bind (already project-scoped by the API). */
  options: GuardrailBindingOption[];
  value: GuardrailBindingRow[];
  onChange: (next: GuardrailBindingRow[]) => void;
  /**
   * Models never call tools — the tool hooks are emitted by the agent runtime,
   * the MCP seam and the sandbox toolbox. Binding one on a model is accepted
   * (the column is the same shape) but warned about, because it is config that
   * can never fire.
   */
  surface: 'model' | 'agent';
}

/*
 * THERE IS NO LONGER A `legacy` PROP, and the omission is deliberate.
 *
 * A consumer still on `inputGuardrailKey` / `outputGuardrailKey` used to get
 * these rows read-only plus a "Migrate to list" button, so converting was an
 * explicit act. The protection it was built for does not exist: `resolveBindings`
 * projects the legacy output slot onto `output.pre` AND `output.stream.delta`
 * (binding.ts:48-55) while the seed writes only `output.pre` — but a
 * pre-hook-plane guardrail is lifted with `stream: { enabled: false }` and no
 * policy on the stream hook (legacy.ts:537), so that extra projection resolves
 * to a key with nothing to run. Converting loses no enforcement.
 *
 * So the ceremony only ever cost the operator a step and left two different
 * ways to bind one guardrail on screen at once. Seed from the slots, let them
 * edit, and let the API keep the deprecated columns in sync for an older
 * binary on the same tenant database.
 */

// ── derivations ───────────────────────────────────────────────────────────

/**
 * Hooks this guardrail will ACTUALLY do something on: the hook needs an enabled
 * binding in the guardrail's own config AND an enabled policy naming it. Either
 * half missing is the "configured and never runs" state, and offering it as a
 * tickable box is how an operator ends up believing it is protected.
 */
export function declaredHooks(option: GuardrailBindingOption): HookId[] {
  const config = option.hooks;
  // Same fail-safe the engine's `ensureHooks` applies: a version marker with no
  // usable `policies` array is treated as absent rather than trusted.
  if ((option.hooksVersion ?? 0) < 1 || !config || !Array.isArray(config.policies)) {
    return [...LEGACY_DECLARED_HOOKS];
  }
  const policies = config.policies;
  return HOOK_IDS.filter(
    (hook) =>
      config.bindings?.[hook]?.enabled === true &&
      policies.some((policy) => policy.enabled && policy.hooks?.includes(hook)),
  );
}

/** The master switch on the guardrail. A stream binding with this off is
 *  post-hoc audit only — the text has already reached the client. */
function streamingEnabled(option: GuardrailBindingOption): boolean {
  return option.hooks?.stream?.enabled === true;
}

/**
 * Stored `guardrails` JSON -> editable rows.
 *
 * Lives here, not in each screen, because both screens write the SAME column:
 * two copies of this two-line mapping is exactly the divergence this module's
 * header warns about, and the first copy to write `hooks: row.hooks ?? []`
 * silently converts every absent list into a parked binding — a guardrail that
 * stops enforcing while its row still renders as attached.
 *
 * Copies the array so editing a row cannot mutate the loaded response, and
 * omits the property entirely when it was absent.
 */
export function bindingRowsFromStored(
  stored: ReadonlyArray<{ key: string; hooks?: HookId[] }>,
): GuardrailBindingRow[] {
  return stored.map((row) => (
    row.hooks ? { key: row.key, hooks: [...row.hooks] } : { key: row.key }
  ));
}

/**
 * The hooks a row runs on right now — the same question `resolveBindings` and
 * `bindingCoversHook` answer on the server, asked of one guardrail.
 *
 * An absent list delegates to the guardrail, so it resolves to whatever that
 * guardrail declares TODAY; an unknown key declares nothing and therefore
 * resolves to nothing, which is also what the server would do with it.
 */
export function effectiveHooks(
  row: GuardrailBindingRow,
  option: GuardrailBindingOption | undefined,
): HookId[] {
  if (row.hooks) return row.hooks;
  return option ? declaredHooks(option) : [];
}

// ── component ─────────────────────────────────────────────────────────────

export default function GuardrailBindingList({
  options,
  value,
  onChange,
  surface,
}: GuardrailBindingListProps) {

  const byKey = useMemo(() => {
    const map = new Map<string, GuardrailBindingOption>();
    for (const option of options) map.set(option.key, option);
    return map;
  }, [options]);

  /**
   * Attachable: not already bound, and not disabled. A disabled guardrail is
   * inert everywhere, so offering it in the picker would let an operator
   * "protect" a consumer with something that cannot run — but one that was
   * disabled AFTER being bound still renders as a row below, badged, because
   * hiding an existing binding is how it gets forgotten.
   */
  const unbound = useMemo(
    () => options.filter(
      (option) => option.enabled !== false && !value.some((row) => row.key === option.key),
    ),
    [options, value],
  );

  const addBinding = (key: string | null) => {
    if (!key || value.some((row) => row.key === key)) return;
    const option = byKey.get(key);
    // Seeded with everything the guardrail can serve: attaching a guardrail and
    // then having to tick a box before it does anything is the same silent
    // no-op this control exists to prevent.
    onChange([...value, { key, hooks: option ? declaredHooks(option) : [] }]);
  };

  const setHooks = (key: string, hooks: HookId[]) => {
    onChange(value.map((row) => (row.key === key ? { ...row, hooks } : row)));
  };

  const removeBinding = (key: string) => {
    onChange(value.filter((row) => row.key !== key));
  };

  // Only when there is nothing to show AND nothing to attach. Returning this
  // whenever `options` is empty would hide existing bindings the moment the
  // guardrail list failed to load.
  if (options.length === 0 && value.length === 0) {
    return (
      <Stack align="center" gap="sm" py="md">
        <IconShieldOff size={20} />
        <Text size="sm" c="dimmed" ta="center">
          No guardrails defined yet.{' '}
          <Text component="a" href="/dashboard/guardrails" size="sm" c="teal">
            Create one first.
          </Text>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      {value.length === 0 ? (
        <Text size="xs" c="dimmed">
          No guardrails attached — every request to this {surface} passes unchecked.
        </Text>
      ) : null}

      {value.map((row) => {
        const option = byKey.get(row.key);
        const declared = option ? declaredHooks(option) : [];
        // What the row RUNS on, absent-list rows included, so every warning
        // below fires on the same set the server will enforce.
        const effective = effectiveHooks(row, option);
        const boundToStream = effective.includes('output.stream.delta');
        const boundToTools = effective.some((hook) => TOOL_HOOKS.includes(hook));

        return (
          <Paper key={row.key} withBorder radius="md" p="sm">
            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="wrap">
                  <Text size="sm" fw={600}>{option?.name ?? row.key}</Text>
                  {option ? (
                    <>
                      {option.type ? (
                        <Badge
                          size="xs"
                          variant="light"
                          color={option.type === 'preset' ? 'violet' : 'teal'}
                        >
                          {option.type}
                        </Badge>
                      ) : null}
                      {option.action ? (
                        <Badge
                          size="xs"
                          variant="light"
                          color={
                            { block: 'red', warn: 'orange', flag: 'blue' }[option.action] ?? 'gray'
                          }
                        >
                          {option.action}
                        </Badge>
                      ) : null}
                      {option.enabled === false ? (
                        <Badge size="xs" variant="light" color="gray">disabled</Badge>
                      ) : null}
                    </>
                  ) : (
                    // A key with no matching guardrail: either it was deleted or
                    // it belongs to another project. Kept visible rather than
                    // dropped — silently discarding it on the next save would
                    // remove a binding the operator never chose to remove.
                    <Badge size="xs" variant="light" color="red">unknown key</Badge>
                  )}
                </Group>
                {(
                  <Tooltip label="Remove this guardrail" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => removeBinding(row.key)}
                      aria-label={`Remove ${option?.name ?? row.key}`}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>

              <Group gap="lg" wrap="wrap">
                {HOOK_IDS.map((hook) => {
                  const supported = declared.includes(hook);
                  const checked = effective.includes(hook);
                  // A hook already ticked but no longer declared stays
                  // enabled so it can be UNticked — locking the operator out
                  // of clearing stale config would be the worse failure.
                  const disabled = !supported && !checked;
                  const tip = supported
                    ? HOOK_HINT[hook]
                    : `${option?.name ?? row.key} has no enabled policy bound to ${hook}. Add one on the guardrail to bind it here.`;

                  return (
                    <Tooltip key={hook} label={tip} withArrow multiline w={260}>
                      <div>
                        <Checkbox
                          size="xs"
                          label={HOOK_LABEL[hook]}
                          checked={checked}
                          disabled={disabled}
                          // Built from `effective`, so the first tick on a row
                          // whose list was absent materialises the guardrail's
                          // declared hooks plus/minus this one — the operator
                          // sees the boxes they are about to persist. Editing a
                          // binding is the one moment pinning the declaration
                          // is right; loading one is not.
                          onChange={(event) =>
                            setHooks(
                              row.key,
                              event.currentTarget.checked
                                ? [...HOOK_IDS].filter(
                                  (id) => id === hook || effective.includes(id),
                                )
                                : effective.filter((id) => id !== hook),
                            )
                          }
                        />
                      </div>
                    </Tooltip>
                  );
                })}
              </Group>

              {effective.length === 0 ? (
                <Text size="xs" c="dimmed">
                  {row.hooks
                    ? 'Bound to no hook — attached but parked, it will not run anywhere.'
                    : 'Follows the guardrail, which currently has no enabled policy on any hook — '
                      + 'it will start running here as soon as one is added.'}
                </Text>
              ) : null}

              {option?.enabled === false ? (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                  <Text size="xs" c="orange">
                    This guardrail is disabled, so it runs nowhere — the binding is kept,
                    but nothing is enforced until you enable it.
                  </Text>
                </Group>
              ) : null}

              {/*
                * The two streaming warnings are mutually exclusive by surface, and
                * deliberately so: on an agent there is no socket to gate, so telling
                * the operator to "turn streaming on in the guardrail" would send them
                * to a switch that changes nothing here.
                */}
              {boundToStream && surface === 'agent' ? (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                  <Text size="xs" c="orange">
                    Agents cannot gate a stream — the agent SDK has no awaitable stream
                    hook, so this hook does nothing here.{' '}
                    {effective.includes('output.pre')
                      ? 'The answer is still checked by “Model output” after it is generated.'
                      : 'Tick “Model output” as well, or this guardrail checks nothing on the way out.'}
                    {' '}Streaming IS enforced on Model Hub bindings.
                  </Text>
                </Group>
              ) : null}

              {boundToStream && surface === 'model' && option && !streamingEnabled(option) ? (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                  <Text size="xs" c="orange">
                    Streaming enforcement is off on this guardrail, so a streamed answer is
                    only audited after it has already reached the caller. Turn it on in the
                    guardrail&apos;s hook settings.
                  </Text>
                </Group>
              ) : null}

              {boundToTools && surface === 'model' ? (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                  <Text size="xs" c="orange">
                    Models do not call tools — the tool hooks fire on agents, the MCP seam
                    and the sandbox toolbox. This binding will never run here.
                  </Text>
                </Group>
              ) : null}
            </Stack>
          </Paper>
        );
      })}

      {(
        <Select
          placeholder={
            unbound.length > 0 ? 'Attach a guardrail…' : 'Every guardrail is already attached'
          }
          data={unbound.map((option) => ({
            value: option.key,
            label: option.type && option.action
              ? `${option.name} [${option.type} · ${option.action}]`
              : option.name,
          }))}
          value={null}
          onChange={addBinding}
          disabled={unbound.length === 0}
          searchable
        />
      )}
    </Stack>
  );
}
