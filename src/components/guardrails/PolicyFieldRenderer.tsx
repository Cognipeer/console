'use client';

/**
 * ONE `PolicyFieldSpec`, rendered as a control.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 * This file switches on `spec.kind` and on NOTHING ELSE. There is no
 * `policy.family` in it, no `if (key === 'piiPolicyKey')`, no family import.
 * That is not a style preference: it is the entire reason the catalog exists.
 * The screen it replaces carried one hand-written component per family, which
 * is why a tenth family was a UI project rather than a data change — a new
 * family meant a new component, a new branch in the config switch, a new branch
 * in the client validator and a new row in the picker, and missing any one of
 * them left the family reachable by the engine and invisible in the console.
 *
 * The practical consequence, and the thing to hold onto when editing this file:
 * if a control here needs to know something family-specific, the FIELD SPEC is
 * missing a property. Add it to `catalog/fields.ts` and read it here. A family
 * branch added to this switch is the catalog quietly dying.
 *
 * ── THE ONE RULE, APPLIED TO A HARD CASE ────────────────────────────────────
 * "Show the referenced PII policy's categories under the picker" is the exact
 * shape of request that puts a family branch in here — the categories belong to
 * `pii`, so `if (family === 'pii')` writes itself. It is resolved the way the
 * rule says to resolve it: the FIELD SPEC was missing a property. A `reference`
 * field now declares `inlineDetail`, and the CALLER supplies a detail component
 * per RESOURCE (`resourceDetails`), exactly as it already supplies option lists
 * per resource. This file learns neither what a PII policy is nor which family
 * owns one; it renders `resourceDetails[spec.resource]` when the spec asks for
 * it. The same mechanism serves `word_list` the day a screen passes one in.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * · It does not lay the form out. `advanced`, `group` and the section a field
 *   belongs to are the DRAWER's business (`GuardrailPolicyDrawer`), because
 *   they are about the shape of a page and this is about the shape of a value.
 *   Nor does it FILTER on any of them: a field handed to this component is
 *   drawn, whatever bucket the drawer took it from. The basic/advanced split
 *   is the catalog's own `basicFields` / `advancedFields`, applied once, by the
 *   drawer — never re-decided per control, which is how a control ends up
 *   visible in one screen and hidden in another for the same policy.
 * · It does not validate. `validatePolicyField(s)` in the catalog does, and the
 *   drawer hands the verdict back down as `issues` — one validator, one set of
 *   words, whether the message ends up under a control or in the summary list.
 * · It does not decide hook eligibility. `canBindToHook` owns that and needs
 *   the guardrail's bindings, which a field renderer has no business holding.
 *
 * ── `visibleWhen` ───────────────────────────────────────────────────────────
 * Honoured here AND in the drawer's `visiblePolicyFields`, on purpose: this
 * component must be safe to drop anywhere, and the drawer needs the same answer
 * without rendering to compute a section's contents and its "done" state. Both
 * call the same predicate on the spec, so they cannot disagree.
 */

import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  JsonInput,
  MultiSelect,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import type { ComboboxItem, ComboboxLikeRenderOptionInput } from '@mantine/core';
import { IconCheck, IconPlus, IconTrash } from '@tabler/icons-react';
import { FormField } from '@/components/common/ui/FormShell';
import type {
  PolicyFieldConfig,
  PolicyFieldIssue,
  PolicyFieldOption,
  PolicyFieldResource,
  PolicyFieldSpec,
} from '@/lib/services/guardrail/catalog';

// ── pure helpers (exported for the unit test) ───────────────────────────────

/**
 * The path a nested field's issue is keyed by.
 *
 * It must match `validatePolicyFields` EXACTLY (`rules[0].pattern`), because
 * that is the only thing joining a validator's verdict to the control that
 * produced it. A mismatch is silent: every nested error renders in the summary
 * list and none of them appears under the box the operator is looking at.
 */
export function fieldPath(path: string | undefined, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** The issue for one field, or `undefined`. Exported because "which control
 *  shows which error" is a rule worth pinning rather than eyeballing. */
export function issueForField(
  issues: readonly PolicyFieldIssue[] | undefined,
  path: string | undefined,
  key: string,
): PolicyFieldIssue | undefined {
  if (!issues || issues.length === 0) return undefined;
  const full = fieldPath(path, key);
  return issues.find((issue) => issue.key === full);
}

/**
 * A `switch`'s rendered state.
 *
 * `defaultValue` is mandatory on the spec for exactly this line. Three of the
 * seven booleans in the catalog are TRUE when absent (`detectObfuscated`,
 * `redactBeforeSend`), and a control that renders "unset" as off turns two
 * security-relevant defaults off the first time anyone opens the form and
 * saves it, with nothing on screen having changed.
 */
export function switchValue(value: unknown, defaultValue: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

/**
 * Mantine's `data` for a closed option set, plus the reverse lookup.
 *
 * Options carry `string | number` values (`webhook.retries` is genuinely
 * `0 | 1 | 2`), and the DOM only speaks strings. Stringifying on the way out
 * and looking the OPTION back up on the way in means nothing ever has to guess
 * whether `"0"` should be stored as a number — a guess that stores a retry
 * count the shape validator then rejects.
 */
export function selectData(
  options: readonly PolicyFieldOption[],
): Array<{ value: string; label: string; disabled?: boolean }> {
  return options.map((option) => ({
    value: String(option.value),
    label: option.label,
    disabled: option.disabled,
  }));
}

export function optionValueOf(
  options: readonly PolicyFieldOption[],
  raw: string | null,
): string | number | undefined {
  if (raw === null) return undefined;
  return options.find((option) => String(option.value) === raw)?.value;
}

/**
 * The placeholder for a number whose absence means something.
 *
 * `zeroMeans` is the load-bearing half: `timeoutMs` and `maxArgBytes` both
 * treat 0 as "no limit", and a spinner showing a bare 0 for that is how an
 * operator ends up believing they set a limit of nothing.
 */
export function numberPlaceholder(spec: {
  defaultValue?: number;
  zeroMeans?: string;
  unit?: string;
}): string | undefined {
  if (spec.defaultValue !== undefined) {
    return `${spec.defaultValue}${spec.unit ? ` ${spec.unit}` : ''}`;
  }
  if (spec.zeroMeans) return spec.zeroMeans;
  return undefined;
}

/** A record's entries in a stable order, so a row does not jump while its key
 *  is being typed. Insertion order is what JSON round-trips, so that is what is
 *  used; a sort would reorder the operator's own list under them. */
export function recordEntries(value: unknown): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>);
}

/**
 * The keys a `reference` field currently points at, whether it holds one or
 * many.
 *
 * Read STRUCTURALLY rather than from `spec.multiple`, deliberately, and for the
 * same reason `referencedResourceKeys` does it that way: a row written before
 * the flag existed still has to be recovered. Blanks are dropped, so an empty
 * select never asks a detail panel to load "".
 */
export function referencedKeys(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * The `description` an option was authored with, looked up by its stringified
 * value.
 *
 * Every closed option set in the catalog carries prose — what Destructive
 * means, what Redact does to a match — and until now a `select` threw all of it
 * away: `selectData` maps to Mantine's `{value,label}` and nothing else. The
 * text existed, was maintained, and reached nobody. This is the lookup that
 * puts it back under the option, and it is keyed by the stringified value
 * because that is what the DOM hands back.
 */
export function optionDescription(
  options: readonly PolicyFieldOption[],
  raw: string,
): string | undefined {
  return options.find((option) => String(option.value) === raw)?.description;
}

/** Rename a key while KEEPING ITS POSITION. `delete` + re-add sends the row to
 *  the bottom of the list mid-keystroke, which reads as the form losing it. */
export function renameKey(
  record: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  if (from === to) return record;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === from) out[to] = value;
    else out[key] = value;
  }
  return out;
}

// ── props ───────────────────────────────────────────────────────────────────

/** Option lists that only the caller can supply, keyed by RESOURCE and never by
 *  family — a `reference` field names the kind of thing it points at, and this
 *  map answers exactly that question. */
export type PolicyFieldResources = Partial<
  Record<PolicyFieldResource, readonly PolicyFieldOption[]>
>;

/** What a detail renderer is handed: the keys the field points at right now,
 *  and whether the form is read-only. Nothing family-shaped — a detail panel
 *  belongs to a RESOURCE, so it is told what it points at and nothing else. */
export interface PolicyResourceDetailProps {
  /** One entry for a single reference, several for a `multiple` one. Never
   *  empty: the renderer does not mount a detail with nothing to show. */
  keys: readonly string[];
  readOnly?: boolean;
}

/**
 * The in-place view of a referenced asset, supplied by the CALLER and keyed by
 * resource.
 *
 * This is what keeps `inlineDetail` from becoming a family branch. The catalog
 * says a reference is worth expanding; this map says what expanding a
 * `pii_policy` looks like; and the switch below still tests `spec.kind` and
 * `spec.resource` — never `policy.family`, which this component does not
 * receive and must never learn.
 *
 * A resource with no entry renders the picker alone, which is what every
 * reference field did before this existed.
 */
export type PolicyFieldResourceDetails = Partial<
  Record<PolicyFieldResource, ComponentType<PolicyResourceDetailProps>>
>;

export interface PolicyFieldRendererProps {
  spec: PolicyFieldSpec;
  /** The object this field lives on: a policy, or ONE ITEM of an `item_list`.
   *  Cross-field validators and `visibleWhen` both read it, which is why the
   *  whole object travels rather than just the value. */
  config: PolicyFieldConfig;
  /** `(key, value)` on the object above. `undefined` clears the property, which
   *  is how "follow the guardrail's setting" is stored — absence, not a
   *  sentinel string. */
  onChange: (key: string, value: unknown) => void;
  resources?: PolicyFieldResources;
  /** In-place views for the resources a `reference` field may expand. */
  resourceDetails?: PolicyFieldResourceDetails;
  /** Every issue for the whole policy, keyed by path. Each control picks its
   *  own out; the drawer shows the rest in its summary. */
  issues?: readonly PolicyFieldIssue[];
  /** Path prefix for a nested item (`rules[0]`). Empty at the top level. */
  path?: string;
  readOnly?: boolean;
  /** Nesting depth, so a catalog that ever nests an `item_list` inside one says
   *  so instead of recursing until the stack gives out. */
  depth?: number;
}

const MAX_NEST_DEPTH = 2;

export default function PolicyFieldRenderer({
  spec,
  config,
  onChange,
  resources,
  resourceDetails,
  issues,
  path,
  readOnly,
  depth = 0,
}: PolicyFieldRendererProps) {
  if (spec.visibleWhen && !spec.visibleWhen(config)) return null;

  const issue = issueForField(issues, path, spec.key);
  const error = issue?.message;
  const value = config[spec.key];
  const set = (next: unknown) => onChange(spec.key, next);
  const disabled = readOnly || spec.readOnly;

  return (
    <FormField
      label={spec.label}
      required={spec.required}
      hint={
        error ? (
          <Text size="xs" c="red">
            {error}
          </Text>
        ) : (
          spec.help
        )
      }
    >
      {renderControl()}
      {/* `covers` is documentation with a data source, so it hangs off EVERY
          kind rather than living inside one arm of the switch: the next field
          that turns on a set the operator cannot see may not be a switch. */}
      {spec.covers && spec.covers.length > 0 && <CoversList options={spec.covers} />}
    </FormField>
  );

  function renderControl() {
    switch (spec.kind) {
      case 'text':
        return (
          <TextInput
            value={typeof value === 'string' ? value : ''}
            placeholder={spec.placeholder}
            maxLength={spec.maxLength}
            readOnly={disabled}
            disabled={spec.readOnly}
            error={Boolean(error)}
            styles={spec.monospace ? { input: { fontFamily: 'var(--mantine-font-family-monospace)' } } : undefined}
            onChange={(event) => set(event.currentTarget.value || undefined)}
          />
        );

      case 'textarea':
        return (
          <Stack gap={6}>
            <Textarea
              value={typeof value === 'string' ? value : ''}
              placeholder={spec.placeholder}
              maxLength={spec.maxLength}
              autosize
              minRows={spec.rows ?? 3}
              readOnly={disabled}
              error={Boolean(error)}
              onChange={(event) => set(event.currentTarget.value || undefined)}
            />
            {spec.templateVars && spec.templateVars.length > 0 && (
              <Group gap={4}>
                <Text size="xs" c="dimmed">
                  Variables:
                </Text>
                {spec.templateVars.map((name) => (
                  // The set is CLOSED, and an operator who does not know that
                  // writes `{{value}}`, sees literal braces reach an end user
                  // and has no way to find out why. Offering the list is the
                  // cheapest possible fix; clicking appends rather than
                  // inserting at the caret, which is honest about being a
                  // shortcut rather than an editor.
                  <Badge
                    key={name}
                    size="xs"
                    variant="light"
                    style={{ cursor: disabled ? 'default' : 'pointer' }}
                    onClick={() => {
                      if (disabled) return;
                      const current = typeof value === 'string' ? value : '';
                      set(`${current}{{${name}}}`);
                    }}
                  >
                    {`{{${name}}}`}
                  </Badge>
                ))}
              </Group>
            )}
          </Stack>
        );

      case 'number':
        return (
          <NumberInput
            value={typeof value === 'number' ? value : ''}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            // A whole-number step IS the statement that a fraction is
            // meaningless here — `maxMatchChars` steps by 1, `minEntropy` by
            // 0.1. Read from the spec rather than added as a second flag
            // saying the same thing twice.
            allowDecimal={spec.step === undefined || !Number.isInteger(spec.step)}
            suffix={spec.unit ? ` ${spec.unit}` : undefined}
            placeholder={numberPlaceholder(spec)}
            description={spec.zeroMeans ? `0 means ${spec.zeroMeans}.` : undefined}
            readOnly={disabled}
            error={Boolean(error)}
            onChange={(next) => set(typeof next === 'number' && Number.isFinite(next) ? next : undefined)}
          />
        );

      case 'switch':
        return (
          <Switch
            size="sm"
            checked={switchValue(value, spec.defaultValue)}
            disabled={disabled}
            // Said ONLY while the value is genuinely absent, because that is the
            // only state an operator can misread. Once they have decided, the
            // toggle position is the whole answer and a caption restating the
            // default is noise. Turning the switch on then off stores `false`,
            // which is a decision and is why the caption goes away for good.
            label={
              typeof value === 'boolean'
                ? undefined
                : spec.defaultValue
                  ? 'Not set — on by default'
                  : 'Not set — off by default'
            }
            onChange={(event) => set(event.currentTarget.checked)}
          />
        );

      case 'select':
        return (
          <Select
            data={selectData(spec.options)}
            value={value === undefined || value === null ? null : String(value)}
            placeholder={spec.inheritLabel ?? spec.placeholder}
            clearable={spec.clearable}
            disabled={disabled}
            error={Boolean(error)}
            allowDeselect={spec.clearable}
            renderOption={describedOption(spec.options)}
            onChange={(next) => set(optionValueOf(spec.options, next))}
          />
        );

      case 'multi_select':
        return (
          <MultiSelect
            data={selectData(spec.options)}
            value={Array.isArray(value) ? value.map((item) => String(item)) : []}
            placeholder={spec.placeholder}
            disabled={disabled}
            error={Boolean(error)}
            renderOption={describedOption(spec.options)}
            onChange={(next) =>
              set(next.map((raw) => optionValueOf(spec.options, raw)).filter((item) => item !== undefined))
            }
          />
        );

      case 'string_list':
        return (
          <TagsInput
            value={Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []}
            placeholder={spec.itemPlaceholder ?? spec.placeholder}
            allowDuplicates={!spec.unique}
            disabled={disabled}
            error={Boolean(error)}
            onChange={(next) => set(next.length > 0 ? next : undefined)}
          />
        );

      case 'flag_map':
        return (
          <FlagMapControl
            spec={spec}
            value={value}
            disabled={disabled}
            onChange={set}
          />
        );

      case 'key_value':
        return <KeyValueControl spec={spec} value={value} disabled={disabled} onChange={set} />;

      case 'key_enum':
        return <KeyEnumControl spec={spec} value={value} disabled={disabled} onChange={set} />;

      case 'key_list':
        return <KeyListControl spec={spec} value={value} disabled={disabled} onChange={set} />;

      case 'item_list':
        if (depth >= MAX_NEST_DEPTH) {
          return (
            <Alert color="orange" variant="light" p="xs">
              <Text size="xs">
                This list is nested deeper than this form draws. Edit it through the API.
              </Text>
            </Alert>
          );
        }
        return (
          <ItemListControl
            spec={spec}
            value={value}
            issues={issues}
            path={fieldPath(path, spec.key)}
            resources={resources}
            resourceDetails={resourceDetails}
            readOnly={readOnly}
            depth={depth + 1}
            onChange={set}
          />
        );

      case 'reference': {
        const options = resources?.[spec.resource] ?? [];
        // The detail hangs under whichever control is drawn, and only once
        // something is actually pointed at — a panel that loads "" is a spinner
        // over an empty picker.
        const Detail = spec.inlineDetail ? resourceDetails?.[spec.resource] : undefined;
        const keys = referencedKeys(value);
        // Returns the control UNWRAPPED when there is no detail to hang under
        // it, so the three references that have none render exactly the markup
        // they rendered before this existed.
        const withDetail = (control: ReactNode) =>
          Detail && keys.length > 0 ? (
            <Stack gap={8}>
              {control}
              <Detail keys={keys} readOnly={readOnly} />
            </Stack>
          ) : (
            control
          );

        if (options.length === 0) {
          // A resource with no list is two different situations, and the spec
          // is what separates them. `freeText`: the console cannot enumerate
          // these (a stored secret's key), so the operator types it and the
          // hint explains why there is nothing to pick. Otherwise: the tenant
          // genuinely has none of these yet, and a text box would only invite a
          // key that resolves to nothing.
          if (spec.freeText) {
            return withDetail(
              <Stack gap={4}>
                {/* `multiple` is honoured here too, or a `freeText` list field
                    would quietly store a bare string where the shape validator
                    demands an array. */}
                {spec.multiple ? (
                  <TagsInput
                    value={referencedKeys(value)}
                    placeholder={spec.placeholder}
                    disabled={disabled}
                    error={Boolean(error)}
                    onChange={(next) => set(next.length > 0 ? next : undefined)}
                  />
                ) : (
                  <TextInput
                    value={typeof value === 'string' ? value : ''}
                    placeholder={spec.placeholder}
                    readOnly={disabled}
                    disabled={spec.readOnly}
                    error={Boolean(error)}
                    styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                    onChange={(event) => set(event.currentTarget.value || undefined)}
                  />
                )}
                {spec.emptyHint && (
                  <Text size="xs" c="dimmed">
                    {spec.emptyHint}
                  </Text>
                )}
              </Stack>,
            );
          }
          return withDetail(
            <Alert color="gray" variant="light" p="xs">
              <Text size="xs">{spec.emptyHint ?? 'Nothing to pick yet.'}</Text>
            </Alert>,
          );
        }
        return withDetail(
          spec.multiple ? (
            <MultiSelect
              data={selectData(options)}
              value={Array.isArray(value) ? value.map((item) => String(item)) : []}
              placeholder={spec.placeholder}
              searchable
              disabled={disabled}
              error={Boolean(error)}
              renderOption={describedOption(options)}
              onChange={(next) => set(next.length > 0 ? next : undefined)}
            />
          ) : (
            <Select
              data={selectData(options)}
              value={typeof value === 'string' ? value : null}
              placeholder={spec.placeholder}
              searchable
              clearable
              disabled={disabled}
              error={Boolean(error)}
              renderOption={describedOption(options)}
              onChange={(next) => set(next ?? undefined)}
            />
          ),
        );
      }

      case 'json':
        return <JsonControl spec={spec} value={value} disabled={disabled} error={error} onChange={set} />;

      default:
        // Unreachable while `PolicyFieldSpec` is exhaustive. It is a NOTE and
        // not a throw: a spec kind this build does not know is a catalog that
        // moved ahead of the bundle, and the rest of the form is still worth
        // showing.
        return (
          <Text size="xs" c="dimmed">
            This setting has no control in this version of the console.
          </Text>
        );
    }
  }
}

// ── the composite controls ──────────────────────────────────────────────────

/**
 * An option row that carries its authored `description`.
 *
 * Returned as a factory rather than written inline at four call sites, because
 * the lookup needs the SPEC's options (which carry the prose) and Mantine hands
 * back a `ComboboxItem` (which does not).
 *
 * `checked` is drawn explicitly: supplying `renderOption` replaces Mantine's
 * whole option body, and a MultiSelect whose selected rows lose their tick is a
 * control that no longer says what is on.
 *
 * EXPORTED for the two controls a `PolicyFieldSpec` cannot describe — the
 * drawer's enforcement select, whose screen value and stored value are
 * different shapes. It takes a `PolicyFieldOption[]` and nothing else, so
 * sharing it teaches this file nothing about who is calling: the alternative
 * was a second, plainer option row where the authored prose silently stops
 * appearing.
 */
export function describedOption(
  options: readonly PolicyFieldOption[],
): (input: ComboboxLikeRenderOptionInput<ComboboxItem>) => ReactNode {
  return function renderOption({ option, checked }) {
    const description = optionDescription(options, option.value);
    return (
      <Group gap={6} wrap="nowrap" align="flex-start" style={{ flex: 1 }}>
        <IconCheck
          size={14}
          style={{ marginTop: 3, flexShrink: 0, opacity: checked ? 1 : 0 }}
        />
        <div>
          <Text size="sm">{option.label}</Text>
          {description && (
            <Text size="xs" c="dimmed">
              {description}
            </Text>
          )}
        </div>
      </Group>
    );
  };
}

/**
 * What a control's built-in set contains, read-only.
 *
 * Collapsed by default and counted in the summary line: seven vendor patterns
 * under a switch is exactly the amount of detail that is invaluable once and
 * noise on every later visit.
 */
function CoversList({ options }: { options: readonly PolicyFieldOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap={4} mt={4}>
      <Anchor
        component="button"
        type="button"
        size="xs"
        style={{ alignSelf: 'flex-start' }}
        onClick={(event) => {
          event.preventDefault();
          setOpen((prev) => !prev);
        }}
      >
        {open ? 'Hide' : 'Show'} what this covers ({options.length})
      </Anchor>
      {open && (
        <Group gap={6}>
          {options.map((option) => (
            <Badge key={String(option.value)} size="xs" variant="light" color="gray">
              {option.label}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  );
}

function FlagMapControl({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: Extract<PolicyFieldSpec, { kind: 'flag_map' }>;
  value: unknown;
  disabled?: boolean;
  onChange: (next: unknown) => void;
}) {
  const map = recordEntries(value);
  const current = Object.fromEntries(map) as Record<string, unknown>;
  const fallback = spec.defaultValue ?? false;

  // `options` present = a closed, labelled key set. Absent = the keys are
  // whatever is stored (a lifted `legacyCategories` map), and all the control
  // can honestly do is list and toggle them.
  const rows: PolicyFieldOption[] = spec.options
    ? [...spec.options]
    : map.map(([key]) => ({ value: key, label: key }));

  if (rows.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        Nothing set.
      </Text>
    );
  }

  return (
    <Stack gap={6}>
      {rows.map((option) => {
        const key = String(option.value);
        const stored = current[key];
        return (
          <Checkbox
            key={key}
            size="xs"
            checked={typeof stored === 'boolean' ? stored : fallback}
            disabled={disabled}
            label={option.label}
            description={option.description}
            onChange={(event) =>
              // Writes an explicit false rather than deleting the key: a flag
              // map can say "this list is deliberately off", and an absence
              // cannot. That difference is the reason this kind exists at all
              // instead of a `multi_select`.
              onChange({ ...current, [key]: event.currentTarget.checked })
            }
          />
        );
      })}
    </Stack>
  );
}

function KeyValueControl({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: Extract<PolicyFieldSpec, { kind: 'key_value' }>;
  value: unknown;
  disabled?: boolean;
  onChange: (next: unknown) => void;
}) {
  const entries = recordEntries(value);
  const current = Object.fromEntries(entries) as Record<string, unknown>;

  return (
    <Stack gap={6}>
      {entries.map(([key, item]) => (
        <Group key={key} gap={6} wrap="nowrap" align="flex-start">
          <TextInput
            // Uncontrolled and committed on blur. A controlled key input
            // rewrites the record on every keystroke, which re-keys the row
            // mid-word and takes the focus with it.
            key={`k-${key}`}
            defaultValue={key}
            placeholder={spec.keyPlaceholder ?? spec.keyLabel}
            readOnly={disabled}
            style={{ flex: 1 }}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (!next || next === key) return;
              onChange(renameKey(current, key, next));
            }}
          />
          {spec.secretValues ? (
            <PasswordInput
              value={typeof item === 'string' ? item : ''}
              placeholder={spec.valuePlaceholder ?? spec.valueLabel}
              readOnly={disabled}
              style={{ flex: 1 }}
              onChange={(event) => onChange({ ...current, [key]: event.currentTarget.value })}
            />
          ) : (
            <TextInput
              value={typeof item === 'string' ? item : ''}
              placeholder={spec.valuePlaceholder ?? spec.valueLabel}
              readOnly={disabled}
              style={{ flex: 1 }}
              onChange={(event) => onChange({ ...current, [key]: event.currentTarget.value })}
            />
          )}
          <ActionIcon
            variant="subtle"
            color="red"
            disabled={disabled}
            aria-label={`Remove ${key}`}
            onClick={() => {
              const next = { ...current };
              delete next[key];
              onChange(Object.keys(next).length > 0 ? next : undefined);
            }}
          >
            <IconTrash size={15} />
          </ActionIcon>
        </Group>
      ))}
      <AddKeyRow
        disabled={disabled}
        placeholder={spec.keyPlaceholder ?? spec.keyLabel ?? 'name'}
        exists={(key) => key in current}
        onAdd={(key) => onChange({ ...current, [key]: '' })}
      />
    </Stack>
  );
}

function KeyEnumControl({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: Extract<PolicyFieldSpec, { kind: 'key_enum' }>;
  value: unknown;
  disabled?: boolean;
  onChange: (next: unknown) => void;
}) {
  const entries = recordEntries(value);
  const current = Object.fromEntries(entries) as Record<string, unknown>;

  // `keys` present = the key set is CLOSED and every key is always drawn, so a
  // side effect nobody has configured still shows what it resolves to. Absent =
  // the operator names the keys (one per tool).
  const rows: PolicyFieldOption[] = spec.keys ? [...spec.keys] : entries.map(([key]) => ({ value: key, label: key }));

  return (
    <Stack gap={6}>
      {rows.map((row) => {
        const key = String(row.value);
        const stored = current[key];
        return (
          <Group key={key} gap={6} wrap="nowrap" align="flex-start">
            {spec.keys ? (
              <Text size="xs" style={{ flex: 1, paddingTop: 8 }}>
                {row.label}
              </Text>
            ) : (
              <TextInput
                key={`k-${key}`}
                defaultValue={key}
                placeholder={spec.keyPlaceholder ?? spec.keyLabel}
                readOnly={disabled}
                style={{ flex: 1 }}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim();
                  if (!next || next === key) return;
                  onChange(renameKey(current, key, next));
                }}
              />
            )}
            <Select
              data={selectData(spec.options)}
              value={stored === undefined || stored === null ? null : String(stored)}
              placeholder={((): string | undefined => {
                // Per-key first: a closed key set may have different engine
                // defaults per row, and the placeholder is where the operator
                // reads what an unset key resolves to.
                const fallback = spec.defaultValues?.[key] ?? spec.defaultValue;
                return fallback ? `${fallback} (the default)` : undefined;
              })()}
              clearable
              disabled={disabled}
              style={{ flex: 1 }}
              // The side-effect classes are the live example: "Destructive" and
              // "External" have authored prose saying what they mean, and a
              // table of bare words is where an operator guesses instead.
              renderOption={describedOption(spec.options)}
              onChange={(next) => {
                const picked = optionValueOf(spec.options, next);
                if (picked === undefined) {
                  const cleared = { ...current };
                  delete cleared[key];
                  onChange(Object.keys(cleared).length > 0 ? cleared : undefined);
                  return;
                }
                onChange({ ...current, [key]: picked });
              }}
            />
            {!spec.keys && (
              <ActionIcon
                variant="subtle"
                color="red"
                disabled={disabled}
                aria-label={`Remove ${key}`}
                onClick={() => {
                  const next = { ...current };
                  delete next[key];
                  onChange(Object.keys(next).length > 0 ? next : undefined);
                }}
              >
                <IconTrash size={15} />
              </ActionIcon>
            )}
          </Group>
        );
      })}
      {!spec.keys && (
        <AddKeyRow
          disabled={disabled}
          placeholder={spec.keyPlaceholder ?? spec.keyLabel ?? 'name'}
          exists={(key) => key in current}
          onAdd={(key) => onChange({ ...current, [key]: spec.options[0]?.value })}
        />
      )}
    </Stack>
  );
}

function KeyListControl({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: Extract<PolicyFieldSpec, { kind: 'key_list' }>;
  value: unknown;
  disabled?: boolean;
  onChange: (next: unknown) => void;
}) {
  const entries = recordEntries(value);
  const current = Object.fromEntries(entries) as Record<string, unknown>;

  return (
    <Stack gap={8}>
      {entries.map(([key, list]) => (
        <Group key={key} gap={6} wrap="nowrap" align="flex-start">
          <TextInput
            key={`k-${key}`}
            defaultValue={key}
            placeholder={spec.keyPlaceholder ?? spec.keyLabel}
            readOnly={disabled}
            style={{ flex: 1 }}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (!next || next === key) return;
              onChange(renameKey(current, key, next));
            }}
          />
          <TagsInput
            value={Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []}
            placeholder={spec.valuePlaceholder ?? spec.valueLabel}
            disabled={disabled}
            style={{ flex: 2 }}
            onChange={(next) => onChange({ ...current, [key]: next })}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            disabled={disabled}
            aria-label={`Remove ${key}`}
            onClick={() => {
              const next = { ...current };
              delete next[key];
              onChange(Object.keys(next).length > 0 ? next : undefined);
            }}
          >
            <IconTrash size={15} />
          </ActionIcon>
        </Group>
      ))}
      <AddKeyRow
        disabled={disabled}
        placeholder={spec.keyPlaceholder ?? spec.keyLabel ?? 'name'}
        exists={(key) => key in current}
        onAdd={(key) => onChange({ ...current, [key]: [] })}
      />
    </Stack>
  );
}

function ItemListControl({
  spec,
  value,
  issues,
  path,
  resources,
  resourceDetails,
  readOnly,
  depth,
  onChange,
}: {
  spec: Extract<PolicyFieldSpec, { kind: 'item_list' }>;
  value: unknown;
  issues?: readonly PolicyFieldIssue[];
  path: string;
  resources?: PolicyFieldResources;
  resourceDetails?: PolicyFieldResourceDetails;
  readOnly?: boolean;
  depth: number;
  onChange: (next: unknown) => void;
}) {
  const items: PolicyFieldConfig[] = Array.isArray(value)
    ? value.filter(
        (item): item is PolicyFieldConfig =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];

  const replace = (index: number, next: PolicyFieldConfig) =>
    onChange(items.map((item, position) => (position === index ? next : item)));

  return (
    <Stack gap={8}>
      {items.map((item, index) => (
        <Card key={index} withBorder padding="sm" radius="sm">
          <Group justify="space-between" mb={6}>
            <Text size="xs" fw={600}>
              {spec.itemTitle(item, index)}
            </Text>
            <ActionIcon
              variant="subtle"
              color="red"
              disabled={readOnly}
              aria-label={`Remove ${spec.itemTitle(item, index)}`}
              onClick={() => onChange(items.filter((_, position) => position !== index))}
            >
              <IconTrash size={15} />
            </ActionIcon>
          </Group>
          <Stack gap={8}>
            {spec.itemFields.map((nested) => (
              <PolicyFieldRenderer
                key={nested.key}
                spec={nested}
                config={item}
                issues={issues}
                path={`${path}[${index}]`}
                resources={resources}
                resourceDetails={resourceDetails}
                readOnly={readOnly}
                depth={depth}
                onChange={(key, next) => replace(index, { ...item, [key]: next })}
              />
            ))}
          </Stack>
        </Card>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={readOnly}
          onClick={() => onChange([...items, spec.newItem(items)])}
        >
          {spec.addLabel ?? 'Add'}
        </Button>
        {spec.minItems !== undefined && items.length < spec.minItems && (
          <Text size="xs" c="dimmed">
            At least {spec.minItems} needed.
          </Text>
        )}
      </Group>
    </Stack>
  );
}

function JsonControl({
  spec,
  value,
  disabled,
  error,
  onChange,
}: {
  spec: Extract<PolicyFieldSpec, { kind: 'json' }>;
  value: unknown;
  disabled?: boolean;
  error?: string;
  onChange: (next: unknown) => void;
}) {
  // Local text, because a half-typed object is not parseable and the config may
  // only ever hold a parsed one. Committing only on a successful parse is what
  // keeps an invalid intermediate state out of the policy entirely.
  const [text, setText] = useState(() =>
    value === undefined || value === null ? '' : JSON.stringify(value, null, 2),
  );
  const [invalid, setInvalid] = useState(false);

  return (
    <Stack gap={4}>
      {spec.schemaHint && (
        <Text size="xs" c="dimmed">
          {spec.schemaHint}
        </Text>
      )}
      <JsonInput
        value={text}
        autosize
        minRows={spec.rows ?? 4}
        formatOnBlur
        readOnly={disabled}
        error={invalid ? 'This is not valid JSON, so it has not been saved yet.' : Boolean(error)}
        onChange={(next) => {
          setText(next);
          if (next.trim().length === 0) {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(next));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </Stack>
  );
}

/** The one "add a row" affordance, shared by the three keyed kinds. Its own
 *  state, so typing a new key never touches the stored record — an empty or
 *  duplicate key would otherwise silently overwrite a row. */
function AddKeyRow({
  disabled,
  placeholder,
  exists,
  onAdd,
}: {
  disabled?: boolean;
  placeholder: string;
  exists: (key: string) => boolean;
  onAdd: (key: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const duplicate = trimmed.length > 0 && exists(trimmed);

  const commit = () => {
    if (trimmed.length === 0 || duplicate) return;
    onAdd(trimmed);
    setDraft('');
  };

  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <TextInput
        value={draft}
        placeholder={placeholder}
        readOnly={disabled}
        style={{ flex: 1 }}
        error={duplicate ? 'Already listed.' : undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commit();
        }}
      />
      <Anchor
        component="button"
        type="button"
        size="xs"
        style={{ paddingTop: 8, opacity: disabled || trimmed.length === 0 || duplicate ? 0.5 : 1 }}
        onClick={(event) => {
          event.preventDefault();
          if (disabled) return;
          commit();
        }}
      >
        Add
      </Anchor>
    </Group>
  );
}
