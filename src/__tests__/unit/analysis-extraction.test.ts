/**
 * Unit tests — analysis field extraction.
 * Covers type coercion, required-field detection, JSON parsing (incl. fenced),
 * prompt construction, and graceful failure.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildExtractionPrompt,
  coerceField,
  parseExtraction,
  extractFields,
} from '@/lib/services/analysis/extraction';
import type { AnalysisConversation, FieldSet } from '@/lib/services/analysis/types';

const FIELDS: FieldSet = [
  { key: 'intent', type: 'enum', enumValues: ['billing', 'support'], required: true },
  { key: 'resolved', type: 'boolean' },
  { key: 'amount', type: 'number' },
  { key: 'summary', type: 'string' },
];

const CONV: AnalysisConversation = {
  id: 'c1',
  transcript: [
    { role: 'caller', content: 'I was double charged.' },
    { role: 'agent', content: 'I refunded 50 dollars.' },
  ],
};

describe('coerceField', () => {
  it('coerces numbers from strings', () => {
    expect(coerceField('42', { key: 'n', type: 'number' })).toEqual({ value: 42, valid: true });
    expect(coerceField('nan', { key: 'n', type: 'number' })).toEqual({ value: null, valid: false });
  });
  it('coerces booleans from yes/no/true', () => {
    expect(coerceField('yes', { key: 'b', type: 'boolean' }).value).toBe(true);
    expect(coerceField(false, { key: 'b', type: 'boolean' })).toEqual({ value: false, valid: true });
    expect(coerceField('maybe', { key: 'b', type: 'boolean' }).valid).toBe(false);
  });
  it('matches enums case-insensitively and rejects unknowns', () => {
    expect(coerceField('Billing', { key: 'e', type: 'enum', enumValues: ['billing', 'support'] })).toEqual({ value: 'billing', valid: true });
    expect(coerceField('other', { key: 'e', type: 'enum', enumValues: ['billing'] }).valid).toBe(false);
  });
  it('treats null/empty as invalid', () => {
    expect(coerceField(null, { key: 's', type: 'string' }).valid).toBe(false);
    expect(coerceField('', { key: 's', type: 'string' }).valid).toBe(false);
  });
});

describe('parseExtraction', () => {
  it('parses and coerces a complete object', () => {
    const r = parseExtraction('{"intent":"billing","resolved":"yes","amount":"50","summary":"refund"}', FIELDS);
    expect(r.error).toBeUndefined();
    expect(r.missing).toEqual([]);
    expect(r.fields).toEqual({ intent: 'billing', resolved: true, amount: 50, summary: 'refund' });
  });
  it('flags missing required fields', () => {
    const r = parseExtraction('{"resolved":true}', FIELDS);
    expect(r.missing).toEqual(['intent']);
    expect(r.fields.intent).toBeNull();
  });
  it('reports an error for non-JSON / non-object output', () => {
    expect(parseExtraction('totally not json', FIELDS).error).toBeTruthy();
    expect(parseExtraction('[1,2,3]', FIELDS).error).toMatch(/not a JSON object/);
    expect(parseExtraction('not json', FIELDS).missing).toEqual(['intent']);
  });
  it('extracts JSON from a fenced block', () => {
    const r = parseExtraction('```json\n{"intent":"support"}\n```', FIELDS);
    expect(r.fields.intent).toBe('support');
  });
});

describe('buildExtractionPrompt', () => {
  it('includes the field schema, transcript and instructions', () => {
    const messages = buildExtractionPrompt(CONV, FIELDS, 'Focus on refunds.');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('"intent"');
    expect(messages[0].content).toContain('billing | support');
    expect(messages[1].content).toContain('Focus on refunds.');
    expect(messages[1].content).toContain('caller: I was double charged.');
  });
});

describe('extractFields', () => {
  it('returns coerced fields from the invoker output', async () => {
    const invoke = vi.fn().mockResolvedValue('{"intent":"billing","resolved":true,"amount":50,"summary":"x"}');
    const r = await extractFields(CONV, FIELDS, undefined, invoke);
    expect(invoke).toHaveBeenCalledOnce();
    expect(r.fields.intent).toBe('billing');
    expect(r.missing).toEqual([]);
  });
  it('fails gracefully when the model throws', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('timeout'));
    const r = await extractFields(CONV, FIELDS, undefined, invoke);
    expect(r.error).toMatch(/timeout/);
    expect(r.missing).toEqual(['intent']);
  });
});
