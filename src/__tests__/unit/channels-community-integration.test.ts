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

describe('channels are not a page (community build)', () => {
  it('has no sub-page entry, left-menu entry or route: channels live in the agent\'s Ship tab', () => {
    expect(DASHBOARD_SUBPAGES.find((s) => s.id === 'channels')).toBeUndefined();
    expect(SUBNAV_CONFIG.agents.find((e) => e.id === 'channels')).toBeUndefined();
    expect(existsSync(join(__dirname, '../..', 'app/dashboard/agents/channels/page.tsx'))).toBe(false);
  });

  it('keeps the admin-only channels RBAC service', () => {
    expect(isPermissionService('channels')).toBe(true);
    expect(RBAC_SERVICE_DEFINITIONS.find((s) => s.id === 'channels')).toMatchObject({ category: 'admin', adminService: true });
  });
});

describe('channels RBAC, licence and availability wiring', () => {
  it('maps the admin API only, owner/admin by default', () => {
    expect(getPermissionServiceForPath('/api/channels/connections')).toBe('channels');
    expect(getPermissionServiceForPath('/api/public/channels/teams/t/c')).toBeNull();
    expect(authorizeServiceRequest({ role: 'user' }, 'GET', '/api/channels/connections').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'admin' }, 'POST', '/api/channels/connections').allowed).toBe(true);
  });

  it('is an enterprise module covering the admin API', () => {
    expect(getEnterpriseModuleForPath('/api/channels/connections')).toBe('channels');
  });

  it('requires the agents service', () => {
    expect(SERVICE_REQUIRES.channels).toEqual(['agents']);
  });
});

// The Enterprise overlay replaces both stubs with the real screens (covered by the overlay's channels-ui tests);
// detect the composed EE tree by a file only the overlay ships.
const isEeTree = existsSync(join(__dirname, '../..', 'app/dashboard/agents/channels/_lib/api.ts'));

describe('channels community stubs', () => {
  it('the agent Ship tab renders the overlay seam, empty in community', () => {
    expect(read('components/agents/AgentDetailPage.tsx')).toContain('<EnterpriseAgentShipSections');
    expect(read('components/agents/EnterpriseAgentShipSections.tsx')).toContain("'use client'");
    if (!isEeTree) expect(read('components/agents/EnterpriseAgentShipSections.tsx')).toContain('return null;');
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
