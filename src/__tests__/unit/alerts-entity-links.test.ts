import { afterEach, describe, expect, it } from 'vitest';
import { entityHref, entityLinkKey } from '@/components/alerts/alertCatalog';
import { coreEntityPath, resolveEntityPath } from '@/lib/services/alerts/entityLinks';
import { __resetAlertExtensionsForTests, getEntityLinkResolver, registerEntityLinkResolver } from '@/enterprise/alert-extensions';

const db = (records: { model?: string; mcp?: string; tool?: string } = {}) => ({
  findModelByKey: async (key: string) => (records.model && key === 'gpt' ? { _id: records.model } : null),
  findMcpServerByKey: async (key: string) => (records.mcp && key === 'files' ? { _id: records.mcp } : null),
  findToolByKey: async (key: string) => (records.tool && key === 'search' ? { _id: records.tool } : null),
}) as never;

afterEach(() => __resetAlertExtensionsForTests());

describe('coreEntityPath', () => {
  it('maps every entity type to its core management page and encodes the segment', () => {
    expect(coreEntityPath('agent', 'My Agent')).toBe('/dashboard/tracing/agents/My%20Agent');
    expect(coreEntityPath('kb', 'docs')).toBe('/dashboard/rag/docs');
    expect(coreEntityPath('model', 'm1')).toBe('/dashboard/models/m1');
    expect(coreEntityPath('mcp', 'm2')).toBe('/dashboard/mcp/m2');
    expect(coreEntityPath('tool', 't1')).toBe('/dashboard/agents/tools/t1');
    expect(coreEntityPath('crawler', 'x')).toBeNull();
    expect(coreEntityPath('model', '')).toBeNull();
  });
});

describe('resolveEntityPath', () => {
  it('finds the record id behind a model, MCP server or tool key', async () => {
    const d = db({ model: 'mod-1', mcp: 'mcp-1', tool: 'tool-1' });
    expect(await resolveEntityPath(d, 'p', 'model', 'gpt')).toBe('/dashboard/models/mod-1');
    expect(await resolveEntityPath(d, 'p', 'mcp', 'files')).toBe('/dashboard/mcp/mcp-1');
    expect(await resolveEntityPath(d, 'p', 'tool', 'search')).toBe('/dashboard/agents/tools/tool-1');
    expect(await resolveEntityPath(d, 'p', 'kb', 'docs')).toBe('/dashboard/rag/docs');
    expect(await resolveEntityPath(d, 'p', 'agent', 'bot')).toBe('/dashboard/tracing/agents/bot');
  });

  it('has no link for entities without a console record, and never throws', async () => {
    expect(await resolveEntityPath(db(), 'p', 'model', 'traces-only')).toBeNull();
    const broken = { findModelByKey: async () => { throw new Error('db down'); } } as never;
    expect(await resolveEntityPath(broken, 'p', 'model', 'gpt')).toBeNull();
    expect(await resolveEntityPath(db(), 'p', 'kb', '')).toBeNull();
  });

  it('lets the registered resolver (enterprise health pages) win, falling back to the core page on null', async () => {
    registerEntityLinkResolver((type, key) => (type === 'model' ? `/dashboard/tracing/health/model/${key}` : null));
    expect(getEntityLinkResolver()).not.toBeNull();
    expect(await resolveEntityPath(db(), 'p', 'model', 'traces-only')).toBe('/dashboard/tracing/health/model/traces-only');
    expect(await resolveEntityPath(db(), 'p', 'kb', 'docs')).toBe('/dashboard/rag/docs');
    registerEntityLinkResolver(() => { throw new Error('boom'); });
    expect(await resolveEntityPath(db(), 'p', 'kb', 'docs')).toBeNull();
  });
});

describe('entityHref (client)', () => {
  it('links agents and knowledge bases by key and leaves id-addressed entities unlinked without a lookup', () => {
    expect(entityHref('agent', 'Pulse Main')).toBe('/dashboard/tracing/agents/Pulse%20Main');
    expect(entityHref('kb', 'docs')).toBe('/dashboard/rag/docs');
    expect(entityHref('model', 'gpt')).toBeNull();
    expect(entityHref('mcp', 'files')).toBeNull();
    expect(entityHref('tool', 'search')).toBeNull();
    expect(entityHref(null, 'x')).toBeNull();
    expect(entityHref('kb', '')).toBeNull();
  });

  it('uses the server-resolved links, which win over the built-in guess', () => {
    const links = {
      [entityLinkKey('model', 'gpt')]: '/dashboard/models/mod-1',
      [entityLinkKey('tool', 'search')]: null,
      [entityLinkKey('kb', 'docs')]: '/dashboard/tracing/health/kb/docs',
    };
    expect(entityHref('model', 'gpt', links)).toBe('/dashboard/models/mod-1');
    expect(entityHref('tool', 'search', links)).toBeNull();
    expect(entityHref('kb', 'docs', links)).toBe('/dashboard/tracing/health/kb/docs');
    expect(entityHref('agent', 'bot', links)).toBe('/dashboard/tracing/agents/bot');
  });
});
