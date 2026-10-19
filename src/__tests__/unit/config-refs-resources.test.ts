import { describe, expect, it } from 'vitest';
import { EDGE_KINDS, buildResolutionIndex, resolveEdge } from '@/lib/resources/references';
import { mapAgent } from '@/lib/resources/providers/core';
import { mapConfigItem, operationsResourceTypes } from '@/lib/resources/providers/operations';
import type { ResourceRecord } from '@/lib/resources/types';

const sandboxAgent = (sandbox: Record<string, unknown>, projectId = 'p1') =>
  mapAgent({ _id: 'a1', key: 'bot', name: 'Bot', projectId, status: 'active', config: { sandbox } });

describe('config reference edge kinds', () => {
  it('are registered by id with the agreed severity', () => {
    for (const kind of ['agent.configItem', 'agent.configGroup']) {
      expect(EDGE_KINDS[kind]).toMatchObject({ by: 'id', scope: 'same-project-id', severity: 'warning' });
    }
    for (const kind of ['sandboxTemplate.configItem', 'sandboxTemplate.configGroup']) {
      expect(EDGE_KINDS[kind]).toMatchObject({ fromType: 'sandbox-template', by: 'id', scope: 'tenant', severity: 'error' });
    }
    expect(EDGE_KINDS['agent.configItem'].toType).toBe('config-item');
    expect(EDGE_KINDS['sandboxTemplate.configGroup'].toType).toBe('config-group');
  });
});

describe('agent config reference edges', () => {
  it('emits an item edge per single reference and one group edge per group (bound or of a referenced item)', () => {
    const edges = sandboxAgent({
      enabled: true,
      envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } },
      secretRefs: { API_KEY: { configId: 'i2', key: 'api-key', groupId: 'g1' } },
      groupRefs: [{ groupId: 'g2', key: 'shared' }],
    }).edges ?? [];
    expect(edges.filter((e) => e.kind === 'agent.configItem').map((e) => e.target).sort()).toEqual(['i1', 'i2']);
    expect(edges.filter((e) => e.kind === 'agent.configGroup').map((e) => e.target).sort()).toEqual(['g1', 'g2']);
    expect(edges.every((e) => e.by === 'id')).toBe(true);
    expect(edges.find((e) => e.kind === 'agent.configItem' && e.target === 'i2')?.field).toBe('config.sandbox.secretRefs.API_KEY.configId');
  });

  it('lists a group once when it is bound and also holds a referenced item (bound edge wins)', () => {
    const edges = sandboxAgent({
      enabled: true,
      envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } },
      groupRefs: [{ groupId: 'g1', key: 'shared' }],
    }).edges ?? [];
    const groupEdges = edges.filter((e) => e.kind === 'agent.configGroup');
    expect(groupEdges).toHaveLength(1);
    expect(groupEdges[0].field).toBe('config.sandbox.groupRefs[0].groupId');
  });

  it('emits nothing without references and tolerates malformed ones', () => {
    expect(sandboxAgent({ enabled: true, env: { A: '1' } }).edges ?? []).toEqual([]);
    expect(sandboxAgent({ envRefs: [], secretRefs: 'x', groupRefs: [null, {}] } as never).edges ?? []).toEqual([]);
  });

  it('carries references even when the sandbox is switched off (used-by must show them)', () => {
    const edges = sandboxAgent({ enabled: false, groupRefs: [{ groupId: 'g2', key: 'shared' }] }).edges ?? [];
    expect(edges.map((e) => e.target)).toEqual(['g2']);
  });

  it('resolves by id in the agent project only', () => {
    const agent = sandboxAgent({ groupRefs: [{ groupId: 'g2', key: 'shared' }] });
    const group = (projectId: string): ResourceRecord => ({
      type: 'config-group', id: 'g2', key: 'shared', name: 'Shared', description: null, projectId, status: null,
      statusTone: 'neutral', createdBy: null, updatedBy: null, createdAt: null, updatedAt: null, attributes: [],
    });
    const edge = agent.edges![0];
    const ok = resolveEdge(buildResolutionIndex([agent, group('p1')]), agent, edge)!;
    expect(ok.status).toBe('ok');
    const elsewhere = resolveEdge(buildResolutionIndex([agent, group('p2')]), agent, edge)!;
    expect(elsewhere.status).not.toBe('ok');
    const gone = resolveEdge(buildResolutionIndex([agent]), agent, edge)!;
    expect(gone.status).toBe('missing');
  });
});

describe('config-item resource type', () => {
  const row = { _id: 'i1', tenantId: 't', projectId: 'p1', groupId: 'g1', key: 'api-key', name: 'API key', value: 'enc:SECRET-VALUE', valueType: 'string', isSecret: true, version: 3 };

  it('maps names and location, never the value', () => {
    const record = mapConfigItem(row);
    expect(record).toMatchObject({ type: 'config-item', id: 'i1', key: 'api-key', name: 'API key', projectId: 'p1' });
    expect(record.attributes).toEqual(expect.arrayContaining([
      { key: 'groupId', value: 'g1' }, { key: 'isSecret', value: true }, { key: 'version', value: 3 },
    ]));
    expect(JSON.stringify(record)).not.toContain('SECRET-VALUE');
  });

  it('links to the group page', () => {
    const def = operationsResourceTypes.find((d) => d.type === 'config-item')!;
    expect(def).toMatchObject({ service: 'config', scope: 'project-or-tenant', edition: 'community' });
    expect(def.detailUrl!(mapConfigItem(row))).toBe('/dashboard/config/g1');
    expect(def.detailUrl!(mapConfigItem({ ...row, groupId: undefined }))).toBeNull();
  });
});
