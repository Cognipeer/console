import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_SUBPAGES } from '@/lib/utils/dashboardServices';
import { SUBNAV_CONFIG } from '@/components/layout/launcher/ServiceSubNav';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import {
  authorizeServiceRequest,
  getPermissionServiceForPath,
  isPermissionService,
  RBAC_SERVICE_DEFINITIONS,
} from '@/lib/security/rbac';
import { SERVICE_REQUIRES } from '@/lib/services/availability/catalog';
import { getEnterpriseModuleForPath } from '@/lib/license/enterprise-access';
import { channelFromSource, ROUTING_CHANNELS } from '@/lib/services/models/routingCallerContext';
import { CHANNEL_OPTIONS } from '@/components/models/DynamicCallerConditions';
import { isContinuableSession, sessionSourceLabel } from '@/components/agents/studio/SessionList';

const read = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('channels nav entry (community build)', () => {
  const page = DASHBOARD_SUBPAGES.find((s) => s.id === 'channels');

  it('is a page of the Agents menu backed by the admin-only channels RBAC service', () => {
    expect(page).toMatchObject({
      parent: 'agents',
      service: 'channels',
      href: '/dashboard/agents/channels',
      navLabelKey: 'agentChannels',
      navDescriptionKey: 'agentChannelsDescription',
    });
    expect(page!.searchKeywords).toEqual(expect.arrayContaining(['slack', 'teams', 'kanal']));
    expect(isPermissionService('channels')).toBe(true);
    expect(RBAC_SERVICE_DEFINITIONS.find((s) => s.id === 'channels')).toMatchObject({
      category: 'admin',
      adminService: true,
    });
  });

  it('agrees with the sub-nav about where it lives and which service gates it', () => {
    const entry = SUBNAV_CONFIG.agents.find((e) => e.id === 'channels')!;
    expect(entry.href).toBe(page!.href);
    expect(entry.requiresService).toBe('channels');
    expect(entry.labelKey).toBe(page!.navLabelKey);
  });

  it('has nav and breadcrumb words in both locales', () => {
    for (const messages of [en, tr]) {
      expect(messages.navigation.agentChannels).toBeTruthy();
      expect(messages.navigation.agentChannelsDescription).toBeTruthy();
      expect(messages.breadcrumbs.channels).toBeTruthy();
    }
    expect(tr.navigation.agentChannels).toBe('Kanallar');
    expect(en.navigation.agentChannels).toBe('Channels');
  });

  it('is excluded from the agent-id breadcrumb resolver and labelled in the breadcrumb map', () => {
    // The agents resolver must not read `channels` as an agent id; the rest of its list belongs to other pages.
    expect(read('components/layout/breadcrumbResolvers.ts')).toMatch(/path: \['agents'\],[\s\S]*?excludeValues: \[[^\]]*'channels'[^\]]*\]/);
    expect(read('components/layout/DashboardBreadcrumbs.tsx')).toContain("channels: 'channels'");
  });
});

describe('channels RBAC, licence and availability wiring', () => {
  it('maps the admin API only, owner/admin by default', () => {
    expect(getPermissionServiceForPath('/api/channels/connections')).toBe('channels');
    expect(getPermissionServiceForPath('/api/channel-identities')).toBeNull();
    expect(getPermissionServiceForPath('/api/public/channels/teams/t/c')).toBeNull();
    expect(authorizeServiceRequest({ role: 'user' }, 'GET', '/api/channels/connections').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'admin' }, 'POST', '/api/channels/connections').allowed).toBe(true);
  });

  it('is an enterprise module covering the admin and identity APIs', () => {
    expect(getEnterpriseModuleForPath('/api/channels/connections')).toBe('channels');
    expect(getEnterpriseModuleForPath('/api/channel-identities')).toBe('channels');
  });

  it('requires the agents service', () => {
    expect(SERVICE_REQUIRES.channels).toEqual(['agents']);
  });
});

// The Enterprise overlay replaces both stubs with the real screens (covered by the overlay's channels-ui tests);
// detect the composed EE tree by a file only the overlay ships.
const isEeTree = existsSync(join(__dirname, '../..', 'app/dashboard/agents/channels/_lib/api.ts'));

describe('channels community stubs', () => {
  it.skipIf(isEeTree)('the page shows the enterprise upsell for the channels module', () => {
    const page = read('app/dashboard/agents/channels/page.tsx');
    expect(page).toContain('<EnterpriseUpsell module="channels" />');
    expect(read('components/enterprise/EnterpriseUpsell.tsx')).toContain("channels: 'Channels'");
  });

  it('the account page renders the overlay seam', () => {
    expect(read('app/dashboard/account/page.tsx')).toContain('<EnterpriseAccountSections />');
    expect(read('components/account/EnterpriseAccountSections.tsx')).toContain("'use client'");
  });

  it.skipIf(isEeTree)('the seam is empty in community', () => {
    expect(read('components/account/EnterpriseAccountSections.tsx')).toContain('return null;');
  });
});

describe('messaging run channel plumbing', () => {
  it('is accepted wherever runs and routing enumerate channels', () => {
    expect(read('server/api/plugins/client-agent-runs.ts')).toMatch(/RUN_CHANNELS[^;]*'messaging'/);
    expect(read('server/api/plugins/agents.ts')).toMatch(/RUN_CHANNEL_VALUES[^;]*'messaging'/);
    expect(read('lib/services/runtimeContext.ts')).toContain("'messaging'");
    expect(read('lib/iam/consoleIdentity.ts')).toContain("'messaging'");
  });

  it('routes a messaging run to the messaging Dynamic-LLM channel, which the rule editor offers', () => {
    expect(channelFromSource('messaging')).toBe('messaging');
    expect(ROUTING_CHANNELS).toContain('messaging');
    expect(CHANNEL_OPTIONS.map((o) => o.value)).toContain('messaging');
  });

  it('shows Slack and Teams sessions with their own badge and keeps them read-only in Studio', () => {
    expect(sessionSourceLabel('slack')).toBe('Slack');
    expect(sessionSourceLabel('teams')).toBe('Teams');
    expect(isContinuableSession('slack')).toBe(false);
    expect(isContinuableSession('teams')).toBe(false);
  });
});
