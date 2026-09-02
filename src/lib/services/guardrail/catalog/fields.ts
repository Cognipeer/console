/**
 * THE FIELD SCHEMA. A declarative description of every control a guardrail
 * policy configuration needs, so the editor can render a family it has never
 * heard of.
 *
 * ── WHY A SCHEMA AND NOT NINE COMPONENTS ────────────────────────────────────
 * The editor screen today carries one hand-written component per family
 * (`PiiConfig`, `SecretsConfig`, `RegexConfig`, ...), and that is why adding the
 * tenth family is a UI project rather than a data change: a new family means a
 * new component, a new branch in the config switch, a new branch in the client
 * validator, a new row in the picker, and a new line in the summary renderer.
 * Miss any one of them and the family exists in the engine while being
 * unreachable, unvalidated or invisible in the console.
 *
 * So the shape of a family's configuration is DATA here, and the renderer is
 * generic. `families.ts` declares one spec per family; the UI walks
 * `spec.fields` and switches on `kind`, never on `family`.
 *
 * ── THE KIND SET IS DERIVED, NOT INVENTED ───────────────────────────────────
 * Every kind below exists because at least one field of the nine persisted
 * configuration interfaces in `provider/types.domain.ts` needs it. The mapping
 * is stated on each kind so a future edit can check it: a kind with no field
 * left is a kind to delete, and a field with no kind is the thing this file
 * exists to prevent.
 *
 * Only the PERSISTED configuration is described. `WebhookRuntimeOptions`
 * (families/webhook.ts) is deliberately absent for the reason that file already
 * gives: those keys round-trip through the JSON blob but are invisible to the
 * type, the save-time validator and the config screen, and that is the state
 * they were left in on purpose.
 *
 * ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
 * `hooks` and `schedule` are not family fields. They are rendered by the hooks
 * matrix, whose per-option eligibility (`canBindToHook`) has to combine
 * `POLICY_VALID_HOOKS`, `STREAM_ELIGIBLE_FAMILIES` and `policyMaxMatchChars`
 * with the guardrail's own bindings. A second copy of that rule living here is
 * exactly the drift this catalog exists to remove, so the matrix keeps it and
 * this file says nothing about it.
 *
 * ── DEPENDENCY RULE ─────────────────────────────────────────────────────────
 * Client-bundle safe: `hooks/contract` and `services/guardrail/constants` only
 * — the same two `policyFamilyMeta.ts` is allowed. Never `hooks/legacy`,
 * `hooks/engine` or `@/lib/database`, each of which constructs providers on
 * load. No React, no `@tabler/icons-react`: an icon is a NAME here (see
 * `families.ts`), which is what lets the server, a plain unit test and the
 * client all import this module.
 */

import type { GuardrailPolicy, SafetyAction, SideEffect } from '../hooks/contract';

// ── the value a control edits ───────────────────────────────────────────────

/**
 * A policy configuration as a renderer sees it: a bag of keys.
 *
 * Deliberately not `GuardrailPolicy`. A validator is handed the config it lives
 * on so it can be cross-field (`minEntropy` only matters while
 * `genericHighEntropy` is on), and a generic renderer holds the union, not one
 * member of it — narrowing at every call site would put the family switch back
 * in the UI, which is the thing being removed.
 *
 * Authoring safety comes from `fieldsFor<C>()` instead, which checks every
 * `key` against the real interface at compile time.
 */
export type PolicyFieldConfig = Readonly<Record<string, unknown>>;

/**
 * `undefined` = the value is acceptable; a string = what is wrong with it, in
 * the second person, ending in a full stop.
 *
 * A validator is NEVER responsible for emptiness — `required` is. It is called
 * only for a value that is present and non-empty (see `validatePolicyField`),
 * which is what lets a validator be written without a null guard AND lets
 * `defaults()` leave a tenant reference blank without every new policy opening
 * with a red error the operator cannot yet clear.
 */
export type PolicyFieldValidator = (
  value: unknown,
  config: PolicyFieldConfig,
) => string | undefined;

/** One option of a closed set. `value` is what is stored, not what is shown. */
export interface PolicyFieldOption {
  value: string | number;
  label: string;
  /** One line under the option, where the choice is not self-explanatory. */
  description?: string;
  disabled?: boolean;
  /**
   * A RUNG OF THE SAME CONTROL THAT MOST OPERATORS SHOULD NOT REACH FOR — the
   * option-level twin of the field-level `advanced` below, and it exists for
   * exactly one control: the action ladder.
   *
   * `SAFETY_ACTION_OPTIONS` has five rungs, three of which are the decision
   * anybody actually makes (Block, Redact, Flag) and two of which are edges —
   * 'allow' is rank 0, so whatever it finds never moves the verdict at all, and
   * 'warn' differs from 'flag' only in whether the caller is told. Offering
   * five is how "what does this policy do when it finds something" became a
   * question with no obvious answer.
   *
   * NEVER A REMOVAL, and this is the load-bearing half: an option marked
   * advanced is still a legal stored value, `validateShape` still accepts it,
   * and a renderer MUST show it whenever it is the value in hand — a policy
   * saved with 'warn' that opens on a control which cannot express 'warn' is a
   * policy the next save silently rewrites.
   */
  advanced?: boolean;
}

/** The tenant resources a policy can point at. Each is a different picker with
 *  a different "none yet" story, which is why this is an enumeration and not a
 *  free-text key. */
export type PolicyFieldResource =
  /** `IPiiPolicy.key` — categories, languages, checksums and mask strategies. */
  | 'pii_policy'
  /** A custom word list's key. */
  | 'word_list'
  /** A model key from the Model Hub. */
  | 'model'
  /**
   * A MODEL HUB LLM PROVIDER key — an OpenAI, Azure, Anthropic or Bedrock
   * record whose encrypted config holds a MODEL credential.
   *
   * That is the whole of its meaning, and it is narrower than the word
   * "provider" suggests. It is NOT a general-purpose place to keep a secret:
   * pointing a non-model field at one both offers the operator a list of
   * irrelevant things AND hands a model credential to whatever resolves it.
   * The webhook family's two secret fields used to be declared here, which is
   * exactly how a webhook signing secret came to be picked from a list of
   * Azure deployments. They point at `'secret'` now.
   */
  | 'provider'
  /**
   * A stored credential the guardrail path may open at call time — a webhook
   * bearer token, an HMAC signing key.
   *
   * SEPARATE FROM `'provider'` ON PURPOSE, and the separation is the point: a
   * model credential and a webhook signing secret must not share a box.
   *
   * The value stored on the policy is the KEY, never the secret — the same
   * shape MCP and Tools use (`sealed` ciphertext at rest, opened for the call,
   * masked on read; `@/lib/services/mcp/secretVault`). The console has no
   * enumerable secret store yet, so a field pointing here is authored as
   * `freeText` and the operator types the key; the picker appears the day a
   * caller supplies a `secret` option list.
   */
  | 'secret';

// ── the specs ───────────────────────────────────────────────────────────────

interface PolicyFieldCommon {
  /**
   * The property name on the configuration object. Flat — every field of all
   * nine interfaces is a direct own property, and a nested one would need a
   * path accessor the renderer does not have.
   */
  key: string;
  label: string;
  /**
   * The sentence under the control. Not a restatement of the label: it says
   * what the field DOES, or what it costs, or what happens when it is left
   * alone. A field whose help would only echo its label has none.
   */
  help?: string;
  placeholder?: string;
  /**
   * Required ONCE THE POLICY IS ENABLED, mirroring the server exactly:
   * `validateGuardrailHooks` returns early for a disabled policy, so an
   * operator can park a half-built one instead of being forced to finish it or
   * throw it away. `validatePolicyField` applies the same rule.
   */
  required?: boolean;
  /** Shown, never edited. Used for a value only a migration writes. */
  readOnly?: boolean;
  /**
   * THE BASIC / ADVANCED SPLIT, and every field makes it: absent means BASIC.
   *
   * Basic is the surface an operator has to read to know what this policy does
   * and whether it is right. Advanced is everything else, collapsed behind one
   * disclosure — and "everything else" is four recognisable kinds:
   *   · a knob with a correct default that most operators should not touch
   *     (`minEntropy`, `maxArgDepth`, `timeoutMs`),
   *   · an OVERRIDE of a value that is already inherited from somewhere
   *     (`failMode`, a rule's own `action`, the per-policy block `message`),
   *   · a compatibility carry-over only an upgrade writes (`legacyCategories`,
   *     `word_filter.regexes`),
   *   · a dial nobody reaches for until they have watched the policy run
   *     (`allowValues`, `runIf`, the `tool_access` argument-path declarations).
   *
   * IT LIVES HERE, NOT IN A COMPONENT, for the reason the whole catalog exists:
   * the screens get their shape from this file, so a tenth family's split
   * arrives with its fields instead of in a switch statement somebody has to
   * remember to extend. `basicFields` / `advancedFields` below are the one
   * partition, so no screen writes `.filter((f) => !f.advanced)` of its own.
   *
   * A field's advancement says NOTHING about whether it is stored, validated or
   * required — `validatePolicyFields` never reads this. An advanced `required`
   * field is legitimate (`custom.onMissingModel`); a renderer that hides a
   * failing one has to open the disclosure, not skip the issue.
   */
  advanced?: boolean;
  /**
   * WHAT A BUILT-IN SET ACTUALLY CONTAINS, listed under the control.
   *
   * For a field whose value is one word — `secrets.known` is a single switch —
   * while the thing it switches on is a list the operator cannot see anywhere
   * in the console. "Known vendor patterns" is not an answer to "does this
   * catch a GitHub token", and the operator's only route to the answer today is
   * to read `families/secrets.ts`.
   *
   * DERIVED, NEVER RETYPED. Every entry must come from the same table the
   * engine runs (`KNOWN_SECRET_PATTERNS`, and whatever a later set is called),
   * for the reason `MODERATION_CATEGORY_OPTIONS` already gives in
   * `families.ts`: a hand-written copy is a copy that will eventually promise a
   * pattern the scanner no longer has.
   *
   * Not `options`: this is not a value the operator picks. It is documentation
   * with a data source, which is why it is rendered read-only.
   */
  covers?: readonly PolicyFieldOption[];
  /** Heading this field sits under, for a form long enough to need them
   *  (`tool_access` has twenty). Fields with no group render first, in order. */
  group?: string;
  /** Progressive disclosure — hide a field whose value cannot matter yet. */
  visibleWhen?: (config: PolicyFieldConfig) => boolean;
  validate?: PolicyFieldValidator;
}

/** Single-line string. `webhook.url`, `tool_access.fsRoot`. */
export interface TextFieldSpec extends PolicyFieldCommon {
  kind: 'text';
  maxLength?: number;
  /** A url, a path, a key — render in a monospace face. */
  monospace?: boolean;
}

/**
 * Multi-line string. `custom.prompt`, and the per-policy block message.
 *
 * `templateVars` is what makes the message field renderable generically: the
 * variable set is CLOSED (`BLOCK_MESSAGE_VARS`), and a UI that cannot offer it
 * leaves an operator guessing at names that render as literal braces.
 */
export interface TextareaFieldSpec extends PolicyFieldCommon {
  kind: 'textarea';
  rows?: number;
  maxLength?: number;
  templateVars?: readonly string[];
}

/**
 * Number. `secrets.minEntropy`, the four `tool_access` limits.
 *
 * `zeroMeans` is not decoration: `timeoutMs` and `maxArgBytes` both treat 0 as
 * "no limit", and a spinner that shows a bare 0 for that is how an operator
 * ends up believing they set a limit of nothing.
 */
export interface NumberFieldSpec extends PolicyFieldCommon {
  kind: 'number';
  min?: number;
  max?: number;
  /**
   * Also the declaration of whether a FRACTION means anything: a whole-number
   * step is a field that counts things (`layer` by 10, `maxMatchChars` by 1)
   * and the renderer refuses a decimal for it, where `minEntropy`'s 0.1 accepts
   * one. A second `integer` flag would only be a way for the two to disagree.
   */
  step?: number;
  /** 'ms', 'bytes', 'characters', 'bits/char'. Rendered beside the input. */
  unit?: string;
  /** What the engine uses when the field is absent, for the placeholder. */
  defaultValue?: number;
  zeroMeans?: string;
}

/**
 * Boolean. Seven of them across `pii`, `secrets`, `tool_access` and `webhook`.
 *
 * `defaultValue` is MANDATORY and is the reason this is not just a text field
 * with two values: absence does not mean the same thing twice.
 * `detectObfuscated` and `redactBeforeSend` are true when absent,
 * `scanUndeclaredStrings` and `denyPrivateNetworks` are false, and a switch
 * that renders unset as off silently turns two security-relevant defaults off
 * the first time anyone saves the form.
 */
export interface SwitchFieldSpec extends PolicyFieldCommon {
  kind: 'switch';
  defaultValue: boolean;
}

/**
 * One value from a closed set. `pii.locale`, `prompt_shield.sensitivity`,
 * `custom.onMissingModel`, `webhook.send`, `webhook.retries`,
 * `tool_access.defaultSideEffect`, and the common `action` / `failMode`.
 *
 * An option's `value` is `string | number` because `retries` is genuinely
 * `0 | 1 | 2`; the renderer holds the option object it selected, so nothing has
 * to coerce a DOM string back to a number.
 */
export interface SelectFieldSpec extends PolicyFieldCommon {
  kind: 'select';
  options: readonly PolicyFieldOption[];
  /**
   * Absence is a meaningful third state — `action` absent means "use the
   * guardrail's action" — and `inheritLabel` is what that state is called.
   * A clearable select with no label for its empty choice reads as a bug.
   */
  clearable?: boolean;
  inheritLabel?: string;
}

/**
 * Several values from a closed, STATICALLY KNOWN set, stored as `string[]`.
 *
 * Distinct from `reference` with `multiple`, whose options come from the tenant
 * at render time, and from `flag_map`, which stores an explicit false rather
 * than an absence — the difference matters, because a flag map can say "this
 * built-in list is deliberately off" and an array cannot.
 */
export interface MultiSelectFieldSpec extends PolicyFieldCommon {
  kind: 'multi_select';
  options: readonly PolicyFieldOption[];
}

/**
 * Free-text `string[]`. Eleven of them: `secrets.allowValues`,
 * `word_filter.words` / `.regexes`, and eight lists on `tool_access`.
 */
export interface StringListFieldSpec extends PolicyFieldCommon {
  kind: 'string_list';
  itemLabel?: string;
  itemPlaceholder?: string;
  /** Per-entry check — an uncompilable pattern, a malformed domain. Called only
   *  for a non-empty entry, exactly like `validate`. */
  validateItem?: (item: string, config: PolicyFieldConfig) => string | undefined;
  /** Reject a duplicate rather than storing it twice. */
  unique?: boolean;
}

/**
 * `Record<string, boolean>`. `word_filter.builtinLists`,
 * `moderation.categories`, `pii.legacyCategories`.
 *
 * `options` present = a closed, labelled key set rendered as checkboxes.
 * `options` absent = the keys come from whatever is stored (a lifted
 * `legacyCategories` map), and the control can only list and toggle them.
 */
export interface FlagMapFieldSpec extends PolicyFieldCommon {
  kind: 'flag_map';
  options?: readonly PolicyFieldOption[];
  /** What an unlisted key means when it is absent from the map. */
  defaultValue?: boolean;
}

/** `Record<string, string>`. `webhook.headers`. */
export interface KeyValueFieldSpec extends PolicyFieldCommon {
  kind: 'key_value';
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /**
   * Mask the values and never echo one back into a log or a summary. Webhook
   * headers routinely carry an authorization token that an operator pasted
   * before noticing `credentialProviderKey` exists.
   */
  secretValues?: boolean;
}

/**
 * `Record<string, E>` for a closed `E`. `tool_access.sideEffects` (open keys,
 * one per tool name) and `tool_access.sideEffectActions` (a FIXED key set, one
 * per side effect).
 */
export interface KeyEnumFieldSpec extends PolicyFieldCommon {
  kind: 'key_enum';
  /** The values a key may take. */
  options: readonly PolicyFieldOption[];
  /** Present = the key set is closed and every key is always rendered; absent =
   *  the operator names the keys. */
  keys?: readonly PolicyFieldOption[];
  keyLabel?: string;
  keyPlaceholder?: string;
  /** The value used for a key that is not in the map, for the placeholder. */
  defaultValue?: string;
  /**
   * PER-KEY placeholder overrides, for a closed key set whose engine defaults
   * are not all the same value. `tool_access.sideEffectActions` is exactly that
   * case: `DEFAULT_SIDE_EFFECT_ACTIONS` resolves Destructive and External to
   * 'warn' and the rest to 'allow', so a single `defaultValue` had to be wrong
   * about two of the five rows — and the placeholder is the ONLY place an
   * operator learns what an unset key does.
   */
  defaultValues?: Readonly<Record<string, string>>;
}

/**
 * `Record<string, string[]>`. `tool_access.allowedRoles`, `.urlArgPaths` and
 * `.pathArgPaths` — all three are "per tool name, a list".
 */
export interface KeyListFieldSpec extends PolicyFieldCommon {
  kind: 'key_list';
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  validateItem?: (item: string, config: PolicyFieldConfig) => string | undefined;
}

/**
 * A repeating list of nested objects: `regex.rules`, and nothing else today.
 *
 * `itemFields` is the same union, so the renderer recurses instead of learning
 * what a regex rule is. `newItem` receives what is already there because a rule
 * needs an id no other rule has.
 */
export interface ItemListFieldSpec extends PolicyFieldCommon {
  kind: 'item_list';
  itemFields: readonly PolicyFieldSpec[];
  newItem: (existing: readonly PolicyFieldConfig[]) => PolicyFieldConfig;
  /** The collapsed row's heading. Never empty — a blank row reads as broken. */
  itemTitle: (item: PolicyFieldConfig, index: number) => string;
  addLabel?: string;
  /** Enforced only for an enabled policy, like `required`. */
  minItems?: number;
}

/**
 * A pointer to another tenant resource. The option list comes from the tenant
 * at render time, which is precisely why the catalog cannot supply it and why
 * `defaults()` leaves these blank.
 */
export interface ReferenceFieldSpec extends PolicyFieldCommon {
  kind: 'reference';
  resource: PolicyFieldResource;
  /** `string[]` instead of `string` — `word_filter.customListKeys`. */
  multiple?: boolean;
  /** What to say when the tenant has none of these yet. A picker with an empty
   *  dropdown and no explanation is indistinguishable from a failed fetch. */
  emptyHint?: string;
  /**
   * SHOW THE REFERENCED THING, not just its name.
   *
   * A picker plus a one-line summary is the whole of what a shared asset shows
   * today, and for `pii_policy` that means the decision an operator came here
   * to make — which categories count as personal data, and what happens to a
   * match — lives on another page. They leave the drawer, find the policy, edit
   * it, come back.
   *
   * A flag rather than a component, because this file may not import React
   * (see the dependency rule at the top). The renderer draws whatever detail
   * component its CALLER supplies for this RESOURCE — keyed by resource and
   * never by family, exactly like the option lists — so the catalog says "this
   * reference is worth expanding" and the screen decides what expanding looks
   * like. A resource with no detail renderer simply draws the picker, which is
   * what every reference did before this existed.
   */
  inlineDetail?: boolean;
  /**
   * The key may be TYPED, not only picked.
   *
   * For a resource the console cannot enumerate: the value is still a real
   * reference — `referencedResourceKeys` harvests it, an orphan is still marked
   * — but there is no list to choose from, so a picker would be an empty box
   * where a working setting used to be.
   *
   * The one user today is the webhook family's pair of `'secret'` fields, and
   * this flag is what keeps repointing them off `'provider'` from removing the
   * ability to configure a webhook credential at all: typing the key is exactly
   * what the pre-catalog editor did for both of them.
   */
  freeText?: boolean;
}

/**
 * A raw JSON value the operator edits as text: `tool_access.argumentSchemas`,
 * a `Record<string, GuardrailJsonSchemaLite>`.
 *
 * A generated form was considered and rejected: the value is a map of JSON
 * Schema documents keyed by tool name, i.e. a schema for schemas, and the
 * subset accepted is small enough to write by hand and awkward enough to
 * render as controls.
 */
export interface JsonFieldSpec extends PolicyFieldCommon {
  kind: 'json';
  rows?: number;
  /** One line naming the accepted shape, shown above the editor. */
  schemaHint?: string;
}

export type PolicyFieldSpec =
  | TextFieldSpec
  | TextareaFieldSpec
  | NumberFieldSpec
  | SwitchFieldSpec
  | SelectFieldSpec
  | MultiSelectFieldSpec
  | StringListFieldSpec
  | FlagMapFieldSpec
  | KeyValueFieldSpec
  | KeyEnumFieldSpec
  | KeyListFieldSpec
  | ItemListFieldSpec
  | ReferenceFieldSpec
  | JsonFieldSpec;

export type PolicyFieldKind = PolicyFieldSpec['kind'];

/** Every kind, derived from the union so the list cannot fall behind it — the
 *  same reason `HOOK_IDS` comes from `HOOK_SUBJECT_KIND`'s keys. */
export const POLICY_FIELD_KINDS = [
  'text',
  'textarea',
  'number',
  'switch',
  'select',
  'multi_select',
  'string_list',
  'flag_map',
  'key_value',
  'key_enum',
  'key_list',
  'item_list',
  'reference',
  'json',
] as const satisfies readonly PolicyFieldKind[];

// ── authoring ───────────────────────────────────────────────────────────────

/**
 * Compile-time key checking, and the only reason this helper exists.
 *
 * `fieldsFor<GuardrailPiiPolicyConfig>([...])` refuses a `key` that is not a
 * property of that interface, so renaming a field in `types.domain.ts` breaks
 * THIS file rather than leaving a control bound to a property nothing reads —
 * a form that saves happily and changes nothing.
 *
 * It returns the erased element type, so a renderer iterates one uniform array
 * instead of narrowing per family.
 */
export function fieldsFor<C extends object>(
  specs: readonly (PolicyFieldSpec & { key: Extract<keyof C, string> })[],
): readonly PolicyFieldSpec[] {
  return specs;
}

// ── the basic / advanced partition ──────────────────────────────────────────

/**
 * The fields a form shows FIRST. Everything not marked advanced, in declaration
 * order — absence means basic, so a family author opts a field OUT of the first
 * screen rather than having to remember to opt it in.
 */
export function basicFields(fields: readonly PolicyFieldSpec[]): readonly PolicyFieldSpec[] {
  return fields.filter((field) => field.advanced !== true);
}

/** The fields behind the one disclosure. The complement of `basicFields`, so
 *  the two together are always the whole list and never overlap. */
export function advancedFields(fields: readonly PolicyFieldSpec[]): readonly PolicyFieldSpec[] {
  return fields.filter((field) => field.advanced === true);
}

/**
 * The options a closed set offers FIRST, plus whichever advanced option is
 * ALREADY SELECTED.
 *
 * The second half is the whole reason this is a function rather than a filter.
 * A policy stored with `action: 'warn'` must open on a control that can show
 * 'warn'; a control that quietly renders the three primary rungs would display
 * the wrong one and rewrite the value on the next save. `current` is the value
 * in hand — pass what is stored, and an edge rung stays visible for exactly as
 * long as it is in use.
 *
 * FOR A BASIC CONTROL ONLY. A field that is itself `advanced` has nothing left
 * to collapse — the operator has already opened the disclosure — and one of
 * them, `tool_access.sideEffectActions`, would be actively harmed by it: its
 * per-key defaults in `DEFAULT_SIDE_EFFECT_ACTIONS` (families/toolAccess.ts)
 * ARE the two hidden rungs, 'allow' for none/read/write and 'warn' for
 * destructive/external, so hiding them would hide values already in effect.
 * Today the one basic control that uses a collapsible set is the policy's own
 * `action`, which is exactly the "Block / Redact / Flag" question.
 */
export function basicOptions(
  options: readonly PolicyFieldOption[],
  current?: unknown,
): readonly PolicyFieldOption[] {
  return options.filter((option) => option.advanced !== true || option.value === current);
}

// ── validation ──────────────────────────────────────────────────────────────

export interface PolicyFieldIssue {
  key: string;
  label: string;
  message: string;
  /**
   * 'required' — nothing is there yet. 'invalid' — something is there and it is
   * wrong.
   *
   * The split is load-bearing. `defaults()` cannot know a tenant's PII policy
   * key or model, so a fresh policy legitimately opens with 'required' issues;
   * an 'invalid' one on a value the catalog itself produced is a bug in the
   * catalog, and the unit test asserts exactly that difference.
   */
  reason: 'required' | 'invalid';
}

/**
 * Empty for this purpose: absent, blank, or a container with nothing in it.
 *
 * A `false` switch and a `0` number are NOT empty — they are decisions, and a
 * required check that swallowed them would demand the operator pick something
 * other than the answer they meant.
 */
export function isEmptyFieldValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * One field's verdict.
 *
 * Order is fixed: emptiness first, then the type-specific structural rules,
 * then the field's own `validate`. A validator therefore never sees an empty
 * value and never has to guess whether a `Record` is really an array.
 *
 * `enabled` gates ONLY the required check, and it mirrors the server: a
 * disabled policy's configuration is not validated, so a half-built policy can
 * be parked. A malformed value is still reported while disabled, because it is
 * wrong whether or not it runs.
 */
export function validatePolicyField(
  spec: PolicyFieldSpec,
  config: PolicyFieldConfig,
  options?: { enabled?: boolean },
): PolicyFieldIssue | undefined {
  const value = config[spec.key];
  const enabled = options?.enabled ?? config.enabled !== false;
  const issue = (message: string, reason: PolicyFieldIssue['reason']): PolicyFieldIssue => ({
    key: spec.key,
    label: spec.label,
    message,
    reason,
  });

  if (isEmptyFieldValue(value)) {
    if (spec.required && enabled) {
      return issue(`${spec.label} is needed before this policy can run.`, 'required');
    }
    if (spec.kind === 'item_list' && enabled && (spec.minItems ?? 0) > 0) {
      return issue(`${spec.label} has no entries, so this policy matches nothing.`, 'required');
    }
    return undefined;
  }

  const structural = validateShape(spec, value, config);
  if (structural) return issue(structural, 'invalid');

  const own = spec.validate?.(value, config);
  return own ? issue(own, 'invalid') : undefined;
}

/**
 * Every field of one policy, in declaration order.
 *
 * NOT the authority. `validateGuardrailHooks` (hooks/legacy.ts) is, and it runs
 * behind the database barrel where a client bundle cannot reach it. This is the
 * editor's immediate feedback, and every rule it applies is one the server also
 * applies — a client validator that is stricter blocks a save the server would
 * accept, and one that is looser promises a save the server will refuse.
 */
export function validatePolicyFields(
  fields: readonly PolicyFieldSpec[],
  config: PolicyFieldConfig,
  options?: { enabled?: boolean },
): PolicyFieldIssue[] {
  const issues: PolicyFieldIssue[] = [];
  for (const spec of fields) {
    const issue = validatePolicyField(spec, config, options);
    if (issue) issues.push(issue);

    // A nested item is validated against its OWN field list, so a regex rule
    // with an uncompilable pattern is reported per rule rather than as one
    // opaque "rules are invalid".
    if (spec.kind === 'item_list' && Array.isArray(config[spec.key])) {
      const items = config[spec.key] as unknown[];
      for (const [index, item] of items.entries()) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const nested of validatePolicyFields(
          spec.itemFields,
          item as PolicyFieldConfig,
          { enabled: options?.enabled ?? config.enabled !== false },
        )) {
          issues.push({
            ...nested,
            key: `${spec.key}[${index}].${nested.key}`,
            label: `${spec.itemTitle(item as PolicyFieldConfig, index)} — ${nested.label}`,
          });
        }
      }
    }
  }
  return issues;
}

/**
 * The shape rules that come free with the kind, so no individual spec has to
 * restate "this must be an array of strings".
 *
 * These fire on stored data, not just on what a form produces: `hooks` is one
 * JSON blob, a hand-written PATCH reaches the store, and a `words: "hello"`
 * that the array code silently iterates as characters is a filter that blocks
 * every letter.
 */
function validateShape(
  spec: PolicyFieldSpec,
  value: unknown,
  config: PolicyFieldConfig,
): string | undefined {
  switch (spec.kind) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') return 'This must be text.';
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return `Keep this under ${spec.maxLength} characters.`;
      }
      return undefined;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'This must be a number.';
      if (spec.min !== undefined && value < spec.min) return `Must be at least ${spec.min}.`;
      if (spec.max !== undefined && value > spec.max) return `Must be at most ${spec.max}.`;
      return undefined;
    }
    case 'switch':
      return typeof value === 'boolean' ? undefined : 'This must be on or off.';
    case 'select':
      return spec.options.some((option) => option.value === value)
        ? undefined
        : `"${String(value)}" is not one of the available choices.`;
    case 'multi_select': {
      if (!Array.isArray(value)) return 'This must be a list.';
      const unknown = value.find((item) => !spec.options.some((option) => option.value === item));
      return unknown === undefined ? undefined : `"${String(unknown)}" is not an available choice.`;
    }
    case 'string_list': {
      if (!Array.isArray(value)) return 'This must be a list.';
      if (value.some((item) => typeof item !== 'string')) return 'Every entry must be text.';
      const items = value as string[];
      if (spec.unique) {
        const seen = new Set<string>();
        for (const item of items) {
          if (seen.has(item)) return `"${item}" is listed twice.`;
          seen.add(item);
        }
      }
      if (spec.validateItem) {
        for (const item of items) {
          if (item.trim().length === 0) continue;
          const message = spec.validateItem(item, config);
          if (message) return message;
        }
      }
      return undefined;
    }
    case 'flag_map': {
      const entries = readRecord(value);
      if (!entries) return 'This must be a set of switches.';
      return entries.every(([, flag]) => typeof flag === 'boolean')
        ? undefined
        : 'Every entry must be on or off.';
    }
    case 'key_value': {
      const entries = readRecord(value);
      if (!entries) return 'This must be a set of name/value pairs.';
      return entries.every(([, item]) => typeof item === 'string')
        ? undefined
        : 'Every value must be text.';
    }
    case 'key_enum': {
      const entries = readRecord(value);
      if (!entries) return 'This must be a set of name/value pairs.';
      for (const [name, item] of entries) {
        if (!spec.options.some((option) => option.value === item)) {
          return `"${name}" is set to "${String(item)}", which is not one of the available choices.`;
        }
      }
      return undefined;
    }
    case 'key_list': {
      const entries = readRecord(value);
      if (!entries) return 'This must be a set of named lists.';
      for (const [name, list] of entries) {
        if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
          return `"${name}" must be a list of text entries.`;
        }
        if (spec.validateItem) {
          for (const item of list as string[]) {
            if (item.trim().length === 0) continue;
            const message = spec.validateItem(item, config);
            if (message) return message;
          }
        }
      }
      return undefined;
    }
    case 'item_list': {
      if (!Array.isArray(value)) return 'This must be a list.';
      return value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
        ? undefined
        : 'Every entry must be an object.';
    }
    case 'reference': {
      if (spec.multiple) {
        if (!Array.isArray(value)) return 'This must be a list.';
        return value.every((item) => typeof item === 'string')
          ? undefined
          : 'Every entry must be a key.';
      }
      return typeof value === 'string' ? undefined : 'This must be a key.';
    }
    case 'json':
      return value !== null && typeof value === 'object' ? undefined : 'This must be a JSON object.';
    default:
      return undefined;
  }
}

/** A plain object's entries, or `undefined` when the value is not one. An array
 *  is not a record here: `[]` reaching a `Record<string, …>` field means the
 *  writer confused two shapes, and reporting it beats iterating zero keys. */
function readRecord(value: unknown): Array<[string, unknown]> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.entries(value as Record<string, unknown>);
}

// ── shared option sets ──────────────────────────────────────────────────────
/**
 * Declared once here because several families reuse them, and because a second
 * copy of the action ladder is a second place for 'allow' to go missing.
 */

/**
 * WHAT A FINDING DOES. All five stored rungs, ordered strongest-first, with the
 * two edges marked advanced — see `PolicyFieldOption.advanced`.
 *
 * The three an operator picks between are Block, Redact and Flag: stop it,
 * rewrite it, or write it down. 'warn' is 'flag' plus a line on the verdict the
 * caller can read, and 'allow' is rank 0 on `SAFETY_ACTION_RANK` — the policy
 * runs, but nothing it finds can move the verdict off 'allow', so the request
 * still reads as clean. Both are real stored values (the side-effect table's
 * own defaults use them), and neither is a question worth putting in front of
 * somebody configuring their first guardrail.
 *
 * NOTHING IS REMOVED. `validateShape` still accepts every one of the five, so a
 * stored 'warn' is a valid value and not an error — it simply is not offered
 * until it is asked for, or until it is the value already in hand.
 */
export const SAFETY_ACTION_OPTIONS: readonly PolicyFieldOption[] = [
  { value: 'block' satisfies SafetyAction, label: 'Block', description: 'Stop the request and return the block message.' },
  { value: 'redact' satisfies SafetyAction, label: 'Redact', description: 'Rewrite the match in place and let the rest through.' },
  { value: 'flag' satisfies SafetyAction, label: 'Flag', description: 'Record what it found and let it through. The verdict reports it; nothing is stopped and nothing is rewritten.' },
  {
    value: 'warn' satisfies SafetyAction,
    label: 'Warn',
    description: 'Flag, and also say so on the verdict the caller reads.',
    advanced: true,
  },
  {
    value: 'allow' satisfies SafetyAction,
    label: 'Allow',
    description: 'Run the policy, but let whatever it finds not count — the verdict still reads as clean.',
    advanced: true,
  },
];

export const SIDE_EFFECT_OPTIONS: readonly PolicyFieldOption[] = [
  { value: 'none' satisfies SideEffect, label: 'None', description: 'Pure computation.' },
  { value: 'read' satisfies SideEffect, label: 'Read', description: 'Reads data and changes nothing.' },
  { value: 'write' satisfies SideEffect, label: 'Write', description: 'Creates or updates something.' },
  { value: 'destructive' satisfies SideEffect, label: 'Destructive', description: 'Deletes or overwrites; not reversible.' },
  { value: 'external' satisfies SideEffect, label: 'External', description: 'Leaves the workspace — a network call, an email, a payment.' },
];

// ── shared validators ───────────────────────────────────────────────────────

/** A pattern that does not compile is the worst kind of dead rule: the matcher
 *  swallows the error and the rule simply never fires. */
export function validateRegexPattern(pattern: string, flags?: string): string | undefined {
  try {
    new RegExp(pattern, flags ?? '');
    return undefined;
  } catch {
    return 'This is not a valid regular expression, so it can never fire.';
  }
}

/** Only the flags `RegExp` accepts, and `g`/`y` deliberately among them —
 *  the families reset `lastIndex` themselves. */
export function validateRegexFlags(flags: string): string | undefined {
  return /^[dgimsuvy]*$/.test(flags) ? undefined : 'Only the flags d, g, i, m, s, u, v and y exist.';
}

/**
 * https only, and it is an enforcement rule rather than a privacy one: a
 * webhook's verdict decides whether a request is blocked, so a plaintext hop is
 * a bypass anyone on the path can perform.
 */
export function validateHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'This must be a url.';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'This is not a valid url.';
  }
  return parsed.protocol === 'https:'
    ? undefined
    : 'A webhook must use https — its verdict decides whether a request is blocked, so a plaintext hop is a bypass.';
}

/** Guards a policy config against being handed something that is not one. */
export function isPolicyConfig(value: unknown): value is GuardrailPolicy {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { family?: unknown }).family === 'string'
  );
}
