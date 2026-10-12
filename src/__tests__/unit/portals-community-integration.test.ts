import { describe, expect, it } from 'vitest';
import { ALL_DASHBOARD_SERVICES, resolveIcon } from '@/lib/utils/dashboardServices';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { isPermissionService } from '@/lib/security/rbac';

type Tree = { [key: string]: string | Tree };

function leafPaths(node: Tree, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : leafPaths(v, `${prefix}${k}.`),
  );
}

describe('portals nav entry', () => {
  const entry = ALL_DASHBOARD_SERVICES.find((s) => s.id === 'portals');

  it('is an enterprise-gated, tenant-admin-only service backed by an RBAC service', () => {
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      href: '/dashboard/portals',
      requiresEnterprise: true,
      enterpriseModule: 'portals',
      tenantAdminOnly: true,
    });
    expect(isPermissionService('portals')).toBe(true);
  });

  it('has nav labels in both locales and a registered icon', () => {
    for (const messages of [en, tr]) {
      expect(messages.navigation.portals).toBeTruthy();
      expect(messages.navigation.portalsDescription).toBeTruthy();
    }
    expect(resolveIcon(entry!.iconName).displayName).not.toBe('IconCube');
  });
});

describe('portals i18n', () => {
  it('has the same keys in en and tr, all non-empty', () => {
    const enKeys = leafPaths(en.portals as Tree).sort();
    expect(enKeys.length).toBeGreaterThan(50);
    expect(leafPaths(tr.portals as Tree).sort()).toEqual(enKeys);
    for (const messages of [en, tr]) {
      for (const path of leafPaths(messages.portals as Tree)) {
        const value = path.split('.').reduce<unknown>((n, k) => (n as Tree)[k], messages.portals);
        expect(value, path).toBeTruthy();
      }
    }
  });

  it('labels the portal resource type and its edge kind in both locales', () => {
    for (const messages of [en, tr]) {
      expect(messages.resources.types.portal).toBeTruthy();
      expect(messages.resources.edgeKinds['portal.agent']).toBeTruthy();
    }
  });

  it('does not leave the Turkish portal copy identical to English', () => {
    expect(tr.portals.title).not.toBe(en.portals.title);
    expect(tr.portals.runtime).not.toEqual(en.portals.runtime);
  });
});
