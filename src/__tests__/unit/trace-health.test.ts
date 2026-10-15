import { describe, expect, it } from 'vitest';
import {
  countTraceErrors,
  deriveSessionStatus,
  isErrorTraceEvent,
  isExplicitClientStatus,
  traceErrorKind,
} from '@/lib/shared/traceHealth';

describe('isErrorTraceEvent', () => {
  it('treats error and failed statuses as errors', () => {
    expect(isErrorTraceEvent({ status: 'error' })).toBe(true);
    expect(isErrorTraceEvent({ status: 'FAILED' })).toBe(true);
    expect(isErrorTraceEvent({ status: ' error ' })).toBe(true);
  });

  it('does not treat skipped, retry or success as errors, even with an error payload', () => {
    expect(isErrorTraceEvent({ status: 'skipped' })).toBe(false);
    expect(isErrorTraceEvent({ status: 'retry', error: { message: 'x' } })).toBe(false);
    expect(isErrorTraceEvent({ status: 'success', error: { message: 'x' } })).toBe(false);
  });

  it('uses a non-empty error when there is no status', () => {
    expect(isErrorTraceEvent({ error: { message: 'boom' } })).toBe(true);
    expect(isErrorTraceEvent({ error: 'boom' })).toBe(true);
    expect(isErrorTraceEvent({ status: '', error: { message: 'boom' } })).toBe(true);
  });

  it('never truthiness-tests error (SQLite returns {} for none)', () => {
    expect(isErrorTraceEvent({ error: {} })).toBe(false);
    expect(isErrorTraceEvent({ error: '' })).toBe(false);
    expect(isErrorTraceEvent({ error: '   ' })).toBe(false);
    expect(isErrorTraceEvent({ error: [] })).toBe(false);
    expect(isErrorTraceEvent({ error: null })).toBe(false);
    expect(isErrorTraceEvent({})).toBe(false);
    expect(isErrorTraceEvent(null)).toBe(false);
    expect(isErrorTraceEvent(undefined)).toBe(false);
  });
});

describe('traceErrorKind', () => {
  it('classifies tool calls by type or actor scope', () => {
    expect(traceErrorKind({ type: 'tool_call' })).toBe('tool');
    expect(traceErrorKind({ type: 'span', actor: { scope: 'tool', name: 'search' } })).toBe('tool');
    // tool wins over a model name on the same event
    expect(traceErrorKind({ type: 'tool_call', model: 'gpt' })).toBe('tool');
  });

  it('classifies AI work by type or model', () => {
    for (const type of ['ai_call', 'summarization', 'reflection', 'embedding']) {
      expect(traceErrorKind({ type })).toBe('ai');
    }
    expect(traceErrorKind({ type: 'span', model: 'gpt-4o' })).toBe('ai');
  });

  it('is other for everything else', () => {
    expect(traceErrorKind({ type: 'plan' })).toBe('other');
    expect(traceErrorKind({ type: 'agent_iteration', model: '  ' })).toBe('other');
    expect(traceErrorKind(null)).toBe('other');
  });
});

describe('countTraceErrors', () => {
  it('counts errors by kind and the calls they are measured against', () => {
    const counts = countTraceErrors([
      { type: 'ai_call', status: 'success', model: 'm' },
      { type: 'ai_call', status: 'error', model: 'm' },
      { type: 'tool_call', status: 'success' },
      { type: 'tool_call', status: 'error', error: { message: 'x' } },
      { type: 'tool_call', status: 'skipped' },
      { type: 'plan', status: 'error' },
      { type: 'agent_iteration', status: 'success' },
    ]);
    expect(counts).toEqual({ errorEvents: 3, toolErrors: 1, aiErrors: 1, toolCalls: 2, aiCalls: 2 });
  });

  it('handles empty input', () => {
    expect(countTraceErrors([])).toEqual({ errorEvents: 0, toolErrors: 0, aiErrors: 0, toolCalls: 0, aiCalls: 0 });
    expect(countTraceErrors(undefined)).toEqual({ errorEvents: 0, toolErrors: 0, aiErrors: 0, toolCalls: 0, aiCalls: 0 });
  });
});

describe('deriveSessionStatus', () => {
  it('lets an explicit client status win, so a recovered session stays a success', () => {
    expect(deriveSessionStatus({ clientStatus: 'success', errorEvents: 3, nonSinkErrors: 1, ended: true })).toBe('success');
    expect(deriveSessionStatus({ clientStatus: 'error', errorEvents: 0, nonSinkErrors: 0, ended: true })).toBe('error');
    expect(deriveSessionStatus({ clientStatus: 'partial', errorEvents: 0, nonSinkErrors: 0, ended: true })).toBe('partial');
  });

  it('derives from errors when the client sent no status and the session ended', () => {
    expect(deriveSessionStatus({ errorEvents: 0, nonSinkErrors: 0, ended: true })).toBe('success');
    expect(deriveSessionStatus({ errorEvents: 1, nonSinkErrors: 0, ended: true })).toBe('error');
    expect(deriveSessionStatus({ errorEvents: 0, nonSinkErrors: 2, ended: true })).toBe('error');
    expect(deriveSessionStatus({ clientStatus: null, errorEvents: 0, nonSinkErrors: 0, ended: true })).toBe('success');
    expect(deriveSessionStatus({ clientStatus: '  ', errorEvents: 0, nonSinkErrors: 0, ended: true })).toBe('success');
  });

  it('keeps a session that has not ended in progress', () => {
    expect(deriveSessionStatus({ errorEvents: 5, nonSinkErrors: 0, ended: false })).toBe('in_progress');
    expect(deriveSessionStatus({ clientStatus: 'in_progress', errorEvents: 5, nonSinkErrors: 5, ended: false })).toBe('in_progress');
  });

  it('re-derives a stale in_progress or unknown status once the session ended', () => {
    expect(deriveSessionStatus({ clientStatus: 'in_progress', errorEvents: 0, nonSinkErrors: 0, ended: true })).toBe('success');
    expect(deriveSessionStatus({ clientStatus: 'unknown', errorEvents: 2, nonSinkErrors: 0, ended: true })).toBe('error');
  });
});

describe('isExplicitClientStatus', () => {
  it('is true only for a status deriveSessionStatus returns as-is', () => {
    for (const status of ['success', 'error', ' Partial ', 'cancelled']) {
      expect(isExplicitClientStatus(status)).toBe(true);
      expect(deriveSessionStatus({ clientStatus: status, errorEvents: 0, nonSinkErrors: 0, ended: true })).toBe(status.trim() === status ? status : status.trim());
    }
    for (const status of [undefined, null, '', '  ', 'unknown', 'UNKNOWN', 'in_progress']) {
      expect(isExplicitClientStatus(status)).toBe(false);
    }
  });
});
