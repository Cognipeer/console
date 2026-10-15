/**
 * The breadcrumb of `/dashboard/tracing/agents/:name` is the agent's name itself: it is
 * resolved without a request (the overview it used to read scans the agent's whole history
 * only to return the name back).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BREADCRUMB_RESOLVERS, type ResolveContext } from '@/components/layout/breadcrumbResolvers';

const resolverFor = () => {
  const found = BREADCRUMB_RESOLVERS.find((r) => r.id === 'custom:tracing-agent');
  if (!found) throw new Error('no resolver for the tracing agent page');
  return found;
};
const contextFor = (path: string): ResolveContext => ({
  segments: path.split('/').filter(Boolean),
  cache: new Map(),
});

afterEach(() => vi.unstubAllGlobals());

describe('tracing agent breadcrumb', () => {
  it('labels the segment with the decoded agent name and never fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolverFor().resolve(contextFor('/dashboard/tracing/agents/Pulse%20Main'))).toEqual([
      { index: 3, label: 'Pulse Main' },
    ]);
    expect(await resolverFor().resolve(contextFor('/dashboard/tracing/agents/50%25off'))).toEqual([
      { index: 3, label: '50%off' },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a name with a stray percent sign as it is', async () => {
    expect(await resolverFor().resolve(contextFor('/dashboard/tracing/agents/100%'))).toEqual([
      { index: 3, label: '100%' },
    ]);
  });

  it('leaves other pages alone', async () => {
    expect(await resolverFor().resolve(contextFor('/dashboard/tracing/agents'))).toEqual([]);
    expect(await resolverFor().resolve(contextFor('/dashboard/tracing/sessions/abc'))).toEqual([]);
    expect(BREADCRUMB_RESOLVERS.some((r) => r.id === 'standard:tracing/agents')).toBe(false);
  });
});
