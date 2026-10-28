/**
 * Unit tests — who evaluation work reads a knowledge base as (`kbCallerForActor`).
 * A user row is a person; everything else (nobody, the evaluation placeholder,
 * the system, an agent, the public A2A caller) is an anonymous caller.
 */

import { describe, expect, it } from 'vitest';
import { kbCallerForActor } from '@/lib/services/evaluation/kbCaller';

describe('kbCallerForActor', () => {
  it('is a person for a user id', () => {
    expect(kbCallerForActor('u-123')).toEqual({ kind: 'person', userId: 'u-123' });
  });

  it('trims the id it is given', () => {
    expect(kbCallerForActor('  u-123  ')).toEqual({ kind: 'person', userId: 'u-123' });
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    'evaluation',
    ' evaluation ',
    'system',
    'system:scheduler',
    'agent:support-bot',
    'a2a-public',
  ])('is anonymous (synthetic) for %j', (actor) => {
    expect(kbCallerForActor(actor)).toEqual({ kind: 'anonymous', reason: 'synthetic' });
  });
});
