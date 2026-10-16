/**
 * Breadcrumbs of the Entity Health pages: the type crumb is translated through `breadcrumbs.*` and the
 * entity key is shown exactly as it is (decoded once, never title-cased).
 */
import { describe, expect, it } from 'vitest';
import { BREADCRUMB_RESOLVERS, type ResolveContext } from '@/components/layout/breadcrumbResolvers';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const resolver = () => {
  const found = BREADCRUMB_RESOLVERS.find((r) => r.id === 'custom:entity-health-key');
  if (!found) throw new Error('no resolver for the entity health detail page');
  return found;
};
const contextFor = (p: string): ResolveContext => ({ segments: p.split('/').filter(Boolean), cache: new Map() });

describe('entity health breadcrumbs', () => {
  it('labels the entity key with the decoded key, unmodified', async () => {
    expect(await resolver().resolve(contextFor('/dashboard/tracing/health/model/gpt-4o'))).toEqual([{ index: 4, label: 'gpt-4o' }]);
    expect(await resolver().resolve(contextFor('/dashboard/tracing/health/agent/pulse-main'))).toEqual([{ index: 4, label: 'pulse-main' }]);
    expect(await resolver().resolve(contextFor('/dashboard/tracing/health/kb/50%25off'))).toEqual([{ index: 4, label: '50%off' }]);
    expect(await resolver().resolve(contextFor('/dashboard/tracing/health/tool/100%'))).toEqual([{ index: 4, label: '100%' }]);
  });

  it('does nothing for other pages', async () => {
    expect(await resolver().resolve(contextFor('/dashboard/tracing/health'))).toEqual([]);
    expect(await resolver().resolve(contextFor('/dashboard/tracing/health/model'))).toEqual([]);
    expect(await resolver().resolve(contextFor('/dashboard/tracing/agents/x'))).toEqual([]);
  });

  it('has a translated word for the health segment and each entity type segment', () => {
    const source = readFileSync(path.resolve(__dirname, '../../components/layout/DashboardBreadcrumbs.tsx'), 'utf8');
    const segments: Record<string, string> = { health: 'health', agent: 'healthAgent', model: 'healthModel', kb: 'healthKb', tool: 'healthTool' };
    for (const [segment, key] of Object.entries(segments)) {
      expect(source).toContain(`${segment}: '${key}'`);
      const enWord = (en.breadcrumbs as Record<string, string>)[key];
      const trWord = (tr.breadcrumbs as Record<string, string>)[key];
      expect(enWord, `en ${key}`).toBeTruthy();
      expect(trWord, `tr ${key}`).toBeTruthy();
      expect(trWord, `tr ${key} is translated`).not.toBe(enWord);
    }
  });
});
