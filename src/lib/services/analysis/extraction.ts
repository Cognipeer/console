/**
 * Field extraction — turns a conversation transcript into a structured record
 * defined by a field-set, via an injected model invoker. Output is parsed and
 * each field is coerced to its declared type; required fields that are missing
 * or invalid are reported.
 */

import type {
  AnalysisConversation,
  ExtractionResult,
  FieldDef,
  FieldSet,
  AnalysisMessage,
  ModelInvoker,
} from './types';
import { extractJson } from './json';

export function renderTranscript(conversation: AnalysisConversation): string {
  return conversation.transcript.map((m) => `${m.role}: ${m.content}`).join('\n');
}

function describeField(field: FieldDef): string {
  const enumPart = field.type === 'enum' && field.enumValues?.length ? `: one of ${field.enumValues.join(' | ')}` : '';
  const req = field.required ? ' [required]' : '';
  const desc = field.description ? ` — ${field.description}` : '';
  return `- "${field.key}" (${field.type}${enumPart})${req}${desc}`;
}

export function buildExtractionPrompt(
  conversation: AnalysisConversation,
  fieldSet: FieldSet,
  instructions?: string,
): AnalysisMessage[] {
  const schema = fieldSet.map(describeField).join('\n');
  const system = [
    'You extract structured information from a conversation transcript.',
    'Return ONLY a JSON object whose keys are exactly the field keys listed below.',
    'If a value is not present in the conversation, use null for that key.',
    'Do not include any text outside the JSON object.',
    '',
    'Fields:',
    schema,
  ].join('\n');

  const user = [
    instructions ? `Instructions: ${instructions}\n` : '',
    'Transcript:',
    renderTranscript(conversation),
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Coerce a raw extracted value to the field's declared type. */
export function coerceField(value: unknown, field: FieldDef): { value: unknown; valid: boolean } {
  if (value === null || value === undefined) return { value: null, valid: false };

  switch (field.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? { value: n, valid: true } : { value: null, valid: false };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { value, valid: true };
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (['true', 'yes', '1'].includes(s)) return { value: true, valid: true };
        if (['false', 'no', '0'].includes(s)) return { value: false, valid: true };
      }
      return { value: null, valid: false };
    }
    case 'enum': {
      const s = String(value).trim();
      const allowed = field.enumValues ?? [];
      const exact = allowed.find((e) => e === s);
      if (exact) return { value: exact, valid: true };
      const ci = allowed.find((e) => e.toLowerCase() === s.toLowerCase());
      return ci ? { value: ci, valid: true } : { value: null, valid: false };
    }
    default: {
      const s = typeof value === 'string' ? value : JSON.stringify(value);
      return { value: s, valid: s.trim().length > 0 };
    }
  }
}

export function parseExtraction(raw: string, fieldSet: FieldSet): ExtractionResult {
  const parsed = extractJson(raw);
  const requiredKeys = fieldSet.filter((f) => f.required).map((f) => f.key);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { fields: {}, missing: requiredKeys, error: parsed.ok ? 'extraction output is not a JSON object' : parsed.error };
  }

  const obj = parsed.value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const field of fieldSet) {
    const { value, valid } = coerceField(obj[field.key], field);
    fields[field.key] = value;
    if (field.required && !valid) missing.push(field.key);
  }
  return { fields, missing };
}

export async function extractFields(
  conversation: AnalysisConversation,
  fieldSet: FieldSet,
  instructions: string | undefined,
  invoke: ModelInvoker,
): Promise<ExtractionResult> {
  try {
    const raw = await invoke(buildExtractionPrompt(conversation, fieldSet, instructions));
    return parseExtraction(raw, fieldSet);
  } catch (err) {
    return {
      fields: {},
      missing: fieldSet.filter((f) => f.required).map((f) => f.key),
      error: (err as Error).message,
    };
  }
}
