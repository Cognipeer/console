/**
 * The pages that managed people used to live on are gone. Their old URLs are
 * answered by redirects in the Next config (no stub pages), temporary for now.
 */
import { describe, expect, it } from 'vitest';
import nextConfig from '../../../next.config.mjs';

describe('next.config redirects', async () => {
  const rules = (await nextConfig.redirects?.()) ?? [];

  it('sends the old member and tenant-settings URLs to the IAM center and the project pages', () => {
    expect(rules.map((r) => [r.source, r.destination])).toEqual([
      ['/dashboard/members', '/dashboard/iam?tab=principals&principalType=user'],
      ['/dashboard/members/:userId', '/dashboard/iam?tab=principals&principalType=user&principalId=:userId'],
      ['/dashboard/tenant-settings', '/dashboard/iam?tab=principals&principalType=user'],
      ['/dashboard/tenant-settings/projects', '/dashboard/projects'],
      ['/dashboard/tenant-settings/projects/:projectId', '/dashboard/projects/:projectId'],
    ]);
  });

  it('are temporary (307): browsers cache a permanent redirect for a long time', () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule.permanent, rule.source).toBe(false);
  });

  it('only use route parameters the source declares, so a bookmark lands on the person\'s drawer', () => {
    for (const rule of rules) {
      const declared = new Set([...rule.source.matchAll(/:(\w+)/g)].map((m) => m[1]));
      const used = [...rule.destination.matchAll(/:(\w+)/g)].map((m) => m[1]);
      for (const name of used) expect(declared.has(name), `${rule.source} -> :${name}`).toBe(true);
    }
    const member = rules.find((r) => r.source === '/dashboard/members/:userId');
    expect(member?.destination).toContain('principalId=:userId');
  });
});
