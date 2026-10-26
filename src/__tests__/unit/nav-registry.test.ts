/**
 * The navigation registry after people moved into the IAM center: no "Members"
 * entry, the IAM entry findable by what people look for, and no entry of the
 * center for an end user.
 */
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ORDER,
  settingsSectionKeys,
} from '@/components/layout/DashboardLayout';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import {
  ALL_DASHBOARD_SERVICES,
  findDashboardService,
  getDashboardServices,
} from '@/lib/utils/dashboardServices';

const ids = (list: ReadonlyArray<{ id: string }>) => list.map((s) => s.id);

describe('the services registry', () => {
  it('has no Members entry: people are managed in the IAM center', () => {
    expect(ids(ALL_DASHBOARD_SERVICES)).not.toContain('members');
    expect(ALL_DASHBOARD_SERVICES.some((s) => s.href.startsWith('/dashboard/members'))).toBe(false);
    expect(ALL_DASHBOARD_SERVICES.some((s) => s.href.includes('tenant-settings'))).toBe(false);
  });

  it('keeps the IAM entry admin-only and finds it by what people search for', () => {
    const iam = findDashboardService('iam')!;
    expect(iam.tenantAdminOnly).toBe(true);
    expect(iam.href).toBe('/dashboard/iam');
    const keywords = iam.searchKeywords.map((k) => k.toLowerCase());
    for (const word of ['members', 'users', 'invite', 'roles', 'tenant', 'üyeler']) {
      expect(keywords, word).toContain(word);
    }
    expect(iam.tags).toEqual(expect.arrayContaining(['members', 'users', 'invite', 'roles']));
  });

  it('lists in the Settings navigation only services that exist', () => {
    const known = new Set(ids(ALL_DASHBOARD_SERVICES));
    for (const id of SETTINGS_NAV_ORDER) expect(known.has(id), id).toBe(true);
    expect(SETTINGS_NAV_ORDER).not.toContain('members');
    expect(SETTINGS_NAV_ORDER).toContain('iam');
    expect(SETTINGS_NAV_ORDER).toContain('tokens');
  });

  it('orders every Settings entry, so none jumps ahead of Projects and takes over the gear link', () => {
    const settings = ALL_DASHBOARD_SERVICES.filter((s) => s.isSettings).map((s) => s.id);
    for (const id of settings) expect(SETTINGS_NAV_ORDER, id).toContain(id);
    expect(SETTINGS_NAV_ORDER[0]).toBe('projects');
  });

  it('keeps configuration and platform pages in Settings, not in the launcher', () => {
    for (const id of ['config', 'automations', 'cluster']) {
      expect(findDashboardService(id)?.isSettings, id).toBe(true);
    }
    // nothing of the Admin category is left in the launcher, so it shows no Admin tab
    const launcherAdmin = ALL_DASHBOARD_SERVICES.filter((s) => s.category === 'admin' && !s.isSettings);
    expect(ids(launcherAdmin)).toEqual([]);
    // Alerts is daily operations work and stays a service
    expect(findDashboardService('alerts')?.isSettings).toBeFalsy();
  });

  it('names every Settings group heading in both languages', () => {
    for (const { sectionKey } of SETTINGS_NAV_GROUPS) {
      expect((en.navigation as Record<string, string>)[sectionKey], sectionKey).toBeTruthy();
      expect((tr.navigation as Record<string, string>)[sectionKey], sectionKey).toBeTruthy();
    }
  });
});

describe('the Settings group headings', () => {
  it('heads the first entry the viewer has of each group', () => {
    expect(settingsSectionKeys(SETTINGS_NAV_ORDER).filter(Boolean)).toEqual(
      SETTINGS_NAV_GROUPS.map((group) => group.sectionKey),
    );
    // an end user without the admin pages: one heading over what is left
    expect(settingsSectionKeys(['projects', 'config', 'tokens'])).toEqual(['settingsWorkspace', undefined, undefined]);
    expect(settingsSectionKeys(['tokens', 'audit', 'license'])).toEqual([
      'settingsWorkspace',
      'settingsGovernance',
      'settingsPlatform',
    ]);
  });

  it('gives an entry no group names no heading', () => {
    expect(settingsSectionKeys(['projects', 'unlisted'])).toEqual(['settingsWorkspace', undefined]);
  });
});

describe('who is offered the IAM center', () => {
  const offered = (options: Parameters<typeof getDashboardServices>[0]) => ids(getDashboardServices(options));

  it('an end user is offered neither the center nor a Members page', () => {
    const list = offered({ role: 'user', servicePermissions: {} });
    expect(list).not.toContain('iam');
    expect(list).not.toContain('members');
    // the personal token page is theirs
    expect(list).toContain('tokens');
  });

  it('a project admin is not offered it either', () => {
    expect(offered({ role: 'project_admin', servicePermissions: {} })).not.toContain('iam');
  });

  it('owners and admins are', () => {
    expect(offered({ role: 'owner', isTenantAdmin: true })).toContain('iam');
    expect(offered({ role: 'admin', isTenantAdmin: true })).toContain('iam');
  });

  it('a person with an admin grant on the center is offered it (the engine\'s own answer wins over the role)', () => {
    expect(offered({ role: 'user', servicePermissions: { iam: 'admin' } })).toContain('iam');
    expect(offered({ role: 'user', servicePermissions: {}, effectivePermissions: { iam: 'admin' } })).toContain('iam');
    expect(offered({ role: 'admin', isTenantAdmin: true, effectivePermissions: { iam: 'none' } })).not.toContain('iam');
  });
});
