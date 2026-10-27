/**
 * Switching the active project from a page that shows one record of the old project goes back to
 * that record's list; any other page reloads where it is.
 */
import { describe, expect, it } from 'vitest';
import { pathAfterProjectSwitch } from '@/components/projects/projectSwitchPath';

describe('pathAfterProjectSwitch', () => {
  it('sends a record page back to its list', () => {
    expect(pathAfterProjectSwitch('/dashboard/agents/66f1a2b3c4d5e6f708192a3b', { agentId: '66f1a2b3c4d5e6f708192a3b' }))
      .toBe('/dashboard/agents');
    expect(pathAfterProjectSwitch('/dashboard/guardrails/g1', { id: 'g1' })).toBe('/dashboard/guardrails');
    expect(pathAfterProjectSwitch('/dashboard/rag/handbook', { key: 'handbook' })).toBe('/dashboard/rag');
  });

  it('keeps the static part of a nested list', () => {
    expect(pathAfterProjectSwitch('/dashboard/agents/tools/t1', { id: 't1' })).toBe('/dashboard/agents/tools');
    expect(pathAfterProjectSwitch('/dashboard/alerts/incidents/i1', { incidentId: 'i1' })).toBe('/dashboard/alerts/incidents');
    expect(pathAfterProjectSwitch('/dashboard/evaluations/datasets/d1', { id: 'd1' })).toBe('/dashboard/evaluations/datasets');
  });

  it('cuts at the first record of a page that names several', () => {
    expect(pathAfterProjectSwitch('/dashboard/agents/a1/sessions/s1', { agentId: 'a1', sessionId: 's1' }))
      .toBe('/dashboard/agents');
    expect(pathAfterProjectSwitch('/dashboard/vector/pinecone-main/idx-9', { providerKey: 'pinecone-main', externalId: 'idx-9' }))
      .toBe('/dashboard/vector');
  });

  it('matches a record keyed like its module, and an encoded key', () => {
    expect(pathAfterProjectSwitch('/dashboard/rag/rag', { key: 'rag' })).toBe('/dashboard/rag');
    expect(pathAfterProjectSwitch('/dashboard/rag/%C3%BCr%C3%BCn%20kb', { key: 'ürün kb' })).toBe('/dashboard/rag');
    expect(pathAfterProjectSwitch('/dashboard/rag/%C3%BCr%C3%BCn%20kb', { key: '%C3%BCr%C3%BCn%20kb' })).toBe('/dashboard/rag');
  });

  it('takes a catch-all value', () => {
    expect(pathAfterProjectSwitch('/dashboard/files/docs/a/b', { bucketKey: 'docs', path: ['a', 'b'] })).toBe('/dashboard/files');
  });

  it('reloads in place on a page without a record', () => {
    expect(pathAfterProjectSwitch('/dashboard/agents', {})).toBeNull();
    expect(pathAfterProjectSwitch('/dashboard/settings/general', {})).toBeNull();
    expect(pathAfterProjectSwitch('/dashboard/agents', null)).toBeNull();
    expect(pathAfterProjectSwitch('/dashboard', undefined)).toBeNull();
  });

  it('leaves pages outside the dashboard alone', () => {
    expect(pathAfterProjectSwitch('/p/hr', { portalKey: 'hr' })).toBeNull();
  });
});
