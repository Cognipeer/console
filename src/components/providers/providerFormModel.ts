/**
 * View-model logic of the generic provider form: which fields apply right now (`visibleWhen`), which values
 * the form submits, which required fields are still empty, and which credential fields a saved provider already
 * stores. Pure functions, no React, so they are unit tested.
 *
 * The form keeps one flat set of values keyed by field name; a field that does not apply keeps its value in the
 * form (switching back restores it) but takes no part in validation, a test or a save.
 */

import type { ProviderFormField, ProviderFormSchema, ProviderFormSection } from '@/lib/providers';

export type FormValueMap = Record<string, unknown>;

export interface FieldBuckets {
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** Nothing was entered: unset, cleared, whitespace only (or a number input that holds no number). */
export function isBlankValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

/** Every field of the schema, section by section. */
export function allFields(schema: ProviderFormSchema | null | undefined): ProviderFormField[] {
  return schema ? schema.sections.flatMap((section) => section.fields) : [];
}

/** The scope a field's value is stored under. */
export function fieldScope(field: ProviderFormField): 'credentials' | 'settings' | 'metadata' {
  return field.scope ?? 'credentials';
}

/** Whether the conditions of a field lead back to the field itself (a contract mistake, not something a form can honour). */
function conditionsLoop(field: ProviderFormField, fields: readonly ProviderFormField[]): boolean {
  const seen = new Set<string>();
  let current: ProviderFormField | undefined = field;
  while (current?.visibleWhen) {
    if (seen.has(current.name)) return true;
    seen.add(current.name);
    const next: string = current.visibleWhen.field;
    current = fields.find((candidate) => candidate.name === next);
  }
  return false;
}

/**
 * What a condition compares: the value entered in the field it reads, or that field's own default until something is
 * entered. A switch is `'true'` while it is drawn checked and `'false'` otherwise, whether it holds `false`, nothing
 * or a default-less blank (the form draws an unset switch off, and it must then count as off).
 */
function conditionValue(source: ProviderFormField, entered: unknown): string {
  const current = isBlankValue(entered) ? source.defaultValue : entered;
  if (source.type === 'switch') return String(Boolean(current));
  return String(current ?? '');
}

/**
 * Whether a field applies to the form as it stands. A field with `visibleWhen` shows while the field it names holds
 * one of the listed values; that field's own default stands in until something is entered (a switch compares as
 * `'true'` / `'false'`). A condition on a field that is itself hidden is not met - its value belongs to a form that is
 * no longer in play - and one that names a field the form does not have, or whose conditions loop back on themselves,
 * never hides anything (a contract mistake must not hide the form).
 */
export function isFieldVisible(
  field: ProviderFormField,
  values: FormValueMap,
  fields: readonly ProviderFormField[],
): boolean {
  const rule = field.visibleWhen;
  if (!rule) return true;
  const source = fields.find((candidate) => candidate.name === rule.field);
  if (!source || conditionsLoop(field, fields)) return true;
  if (!isFieldVisible(source, values, fields)) return false;

  const wanted = Array.isArray(rule.equals) ? rule.equals : [rule.equals];
  return wanted.includes(conditionValue(source, values[source.name]));
}

/** The fields of a section that apply right now. */
export function visibleFieldsOf(
  section: ProviderFormSection,
  values: FormValueMap,
  fields: readonly ProviderFormField[],
): ProviderFormField[] {
  return section.fields.filter((field) => isFieldVisible(field, values, fields));
}

export interface VisibleSection {
  section: ProviderFormSection;
  fields: ProviderFormField[];
}

/** The sections that still have something to show (a section whose fields are all hidden is left out). */
export function visibleSections(schema: ProviderFormSchema | null | undefined, values: FormValueMap): VisibleSection[] {
  if (!schema) return [];
  const fields = allFields(schema);
  return schema.sections
    .map((section) => ({ section, fields: visibleFieldsOf(section, values, fields) }))
    .filter((entry) => entry.fields.length > 0);
}

/** What a saved provider holds in the scopes the form shows its values from (credentials are never read back). */
export interface StoredFormValues {
  settings?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/** A value the form opened with because the field has a default, not because the record holds it. */
function isUntouchedDefault(field: ProviderFormField, value: unknown, saved: Record<string, unknown> | null | undefined): boolean {
  if (field.defaultValue === undefined || (saved && field.name in saved)) return false;
  if (value === field.defaultValue) return true;
  const primitive = (candidate: unknown) => ['string', 'number', 'boolean'].includes(typeof candidate);
  return primitive(value) && primitive(field.defaultValue) && String(value) === String(field.defaultValue);
}

/**
 * What the form submits: the entered values of the fields that apply, by scope. A hidden field - and so a hidden
 * credential - contributes nothing, whatever it still holds.
 *
 * Editing a saved provider passes what it holds (`stored`): a setting that merely shows the field's default, because
 * the record has no such key, is left out - the settings replace the stored ones wholesale, so submitting it would
 * write a key nobody touched and make a label-only edit look like a change of the connection.
 */
export function partitionProviderValues(
  schema: ProviderFormSchema | null | undefined,
  values: FormValueMap,
  stored?: StoredFormValues,
): FieldBuckets {
  const buckets: FieldBuckets = { credentials: {}, settings: {}, metadata: {} };
  const fields = allFields(schema);
  for (const field of fields) {
    if (!isFieldVisible(field, values, fields)) continue;
    const value = values[field.name];
    if (isBlankValue(value)) continue;
    const scope = fieldScope(field);
    if (stored && scope !== 'credentials' && isUntouchedDefault(field, value, stored[scope])) continue;
    buckets[scope][field.name] = value;
  }
  return buckets;
}

export interface MissingRequiredField {
  name: string;
  label: string;
}

export interface RequiredCheckOptions {
  /**
   * The credential fields the provider being edited already stores (`storedCredentialFields`). The API never returns
   * them, so such a field opens blank and a blank one means "keep what is stored" (the server merges it that way): it
   * may stay empty. A credential the record does not store - the secret of a way to sign in it never used - is asked for.
   */
  storedCredentialFields?: ReadonlySet<string>;
}

/** Required fields that apply and are still empty. A switch always holds a value, so it is never missing. */
export function missingRequiredFields(
  schema: ProviderFormSchema | null | undefined,
  values: FormValueMap,
  options: RequiredCheckOptions = {},
): MissingRequiredField[] {
  const fields = allFields(schema);
  return fields
    .filter((field) => {
      if (!field.required || field.type === 'switch') return false;
      if (!isFieldVisible(field, values, fields)) return false;
      if (fieldScope(field) === 'credentials' && options.storedCredentialFields?.has(field.name)) return false;
      return isBlankValue(values[field.name]);
    })
    .map((field) => ({ name: field.name, label: field.label }));
}

/** What a read of a saved provider says about its credentials (see `ProviderConfigView`). */
export interface StoredCredentialSource {
  hasCredentials?: boolean;
  /** The names of the credential fields it stores a value for, when the read names them. */
  credentialFields?: readonly string[];
}

/**
 * The credential fields of the schema that a saved provider already stores a value for. When the read names them, those
 * are the stored ones. A read that only says whether some credentials are stored (a list row) cannot tell which, and
 * then every credential field counts as stored: an edit never demands a secret that may be there. A provider without
 * credentials stores none.
 */
export function storedCredentialFields(
  schema: ProviderFormSchema | null | undefined,
  provider: StoredCredentialSource | null | undefined,
): ReadonlySet<string> {
  const stored = new Set<string>();
  if (!provider) return stored;
  const named = Array.isArray(provider.credentialFields) ? new Set(provider.credentialFields) : null;
  if (!named && !provider.hasCredentials) return stored;
  for (const field of allFields(schema)) {
    if (fieldScope(field) !== 'credentials') continue;
    if (!named || named.has(field.name)) stored.add(field.name);
  }
  return stored;
}

/** Input types that show a placeholder text in an empty box. */
const PLACEHOLDER_TYPES: ReadonlySet<string> = new Set(['password', 'text', 'textarea']);

/**
 * A credential field the provider being edited already stores says so instead of looking empty - whatever its input
 * type - and one it does not store never claims to.
 */
export function showsStoredSecretCue(field: ProviderFormField, stored: ReadonlySet<string> | undefined): boolean {
  if (!stored?.has(field.name) || fieldScope(field) !== 'credentials') return false;
  // A field of an unknown type is drawn as a text box.
  return !field.type || PLACEHOLDER_TYPES.has(field.type);
}

/** The fields other fields' conditions read (their dropdown must always hold a value). */
export function visibilitySourceNames(fields: readonly ProviderFormField[]): Set<string> {
  const names = new Set<string>();
  for (const field of fields) {
    if (field.visibleWhen) names.add(field.visibleWhen.field);
  }
  return names;
}

/** A refusal of the provider API, with the form field it is about when it names one (`{ error, field }`). */
export class ProviderRequestError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ProviderRequestError';
    this.field = field;
  }
}

/** The error to throw for a refused provider request: the text of the refusal, and the field it names. */
export function providerRequestError(body: unknown, fallback: string): ProviderRequestError {
  const reply = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof reply.error === 'string' && reply.error.trim() ? reply.error : fallback;
  const field = typeof reply.field === 'string' && reply.field ? reply.field : undefined;
  return new ProviderRequestError(message, field);
}
