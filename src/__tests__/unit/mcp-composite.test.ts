/**
 * Unit tests — composite MCP server domain logic (no DB, no execution).
 * Covers the naming/collision algorithm and the config accessors. DB-backed
 * create/execute/reconcile behavior is covered in
 * `src/__tests__/integration/mcp-composite.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  allocateExposedNames,
  assertMemberUsable,
  defaultMemberPrefix,
  getCompositeConfig,
  getCompositeMemberSummaries,
  isInternalSourced,
  metadataWithComposite,
  sanitizeCompositePrefix,
  type CompositeToolEntry,
} from '@/lib/services/mcp/composite';
import type { IMcpServer } from '@/lib/database';

describe('allocateExposedNames', () => {
  const entry = (over: Partial<CompositeToolEntry>): CompositeToolEntry => ({
    serverId: 's1',
    serverKey: 'server-1',
    realName: 'search',
    prefixBase: 'server_1',
    alwaysPrefix: false,
    ...over,
  });

  it('keeps the real name when there is no collision', () => {
    const names = allocateExposedNames([
      entry({ serverId: 's1', realName: 'search' }),
      entry({ serverId: 's2', serverKey: 'server-2', prefixBase: 'server_2', realName: 'fetch' }),
    ]);
    expect(names).toEqual(['search', 'fetch']);
  });

  it('prefixes both sides of a collision, then falls back to a counter', () => {
    const names = allocateExposedNames([
      entry({ serverId: 's1', serverKey: 'server-1', prefixBase: 'server_1', realName: 'search' }),
      entry({ serverId: 's2', serverKey: 'server-2', prefixBase: 'server_1', realName: 'search' }),
    ]);
    // Both entries prefix to the same base ("server_1_search") because they
    // share a prefixBase — the second falls back to a numbered suffix.
    expect(names).toEqual(['server_1_search', 'server_1_search_2']);
  });

  it('prefixes distinct members independently on collision', () => {
    const names = allocateExposedNames([
      entry({ serverId: 's1', serverKey: 'server-1', prefixBase: 'server_1', realName: 'search' }),
      entry({ serverId: 's2', serverKey: 'server-2', prefixBase: 'server_2', realName: 'search' }),
    ]);
    expect(names).toEqual(['server_1_search', 'server_2_search']);
  });

  it('always prefixes when alwaysPrefix is set, even without a collision', () => {
    const names = allocateExposedNames([
      entry({ serverId: 's1', realName: 'search', alwaysPrefix: true }),
    ]);
    expect(names).toEqual(['server_1_search']);
  });

  it('keeps a tool\'s previous exposed name stable across a rebuild', () => {
    const previous = [
      { name: 'server_1_search', origin: { serverId: 's1', serverKey: 'server-1', realName: 'search' } },
    ];
    // No longer colliding this round (the other member's tool is gone) —
    // without stability this would fall back to the bare "search".
    const names = allocateExposedNames(
      [entry({ serverId: 's1', realName: 'search' })],
      previous,
    );
    expect(names).toEqual(['server_1_search']);
  });

  it('does not reuse a previous name if another entry already claimed it this round', () => {
    const previous = [
      { name: 'search', origin: { serverId: 's1', serverKey: 'server-1', realName: 'search' } },
    ];
    const names = allocateExposedNames(
      [
        // A brand-new entry naturally wants the bare name...
        entry({ serverId: 's2', serverKey: 'server-2', prefixBase: 'server_2', realName: 'search' }),
        // ...and s1 is trying to reclaim its old bare name too — collision.
        entry({ serverId: 's1', serverKey: 'server-1', prefixBase: 'server_1', realName: 'search' }),
      ],
      previous,
    );
    const used = new Set(names);
    expect(used.size).toBe(2);
  });

  it('sanitizes characters outside the tool-name charset', () => {
    const names = allocateExposedNames([
      entry({ serverId: 's1', prefixBase: 'srv', realName: 'weird name!!', alwaysPrefix: true }),
    ]);
    expect(names[0]).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('isInternalSourced', () => {
  it('is true for a direct internal server', () => {
    expect(isInternalSourced({ sourceType: 'internal', metadata: {} })).toBe(true);
  });

  it('is true for a composite whose config marks hasInternalMember', () => {
    expect(isInternalSourced({
      sourceType: 'composite',
      metadata: { composite: { members: [], hasInternalMember: true } },
    })).toBe(true);
  });

  it('is false for a composite with no internal member', () => {
    expect(isInternalSourced({
      sourceType: 'composite',
      metadata: { composite: { members: [], hasInternalMember: false } },
    })).toBe(false);
  });

  it('is false for openapi/remote/stdio', () => {
    expect(isInternalSourced({ sourceType: 'openapi', metadata: {} })).toBe(false);
    expect(isInternalSourced({ sourceType: undefined, metadata: {} })).toBe(false);
  });
});

describe('assertMemberUsable', () => {
  const self = { id: 'composite-1', tenantId: 'tenant-1', projectId: 'project-1' };
  const baseMember = {
    _id: 'member-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'Member One',
    sourceType: 'openapi',
  } as unknown as IMcpServer;

  it('accepts a well-formed candidate', () => {
    expect(() => assertMemberUsable(self, baseMember, 'member-1')).not.toThrow();
  });

  it('rejects a missing member', () => {
    expect(() => assertMemberUsable(self, null, 'ghost')).toThrow(/no longer exists/i);
  });

  it('rejects the composite referencing itself', () => {
    const asSelf = { ...baseMember, _id: 'composite-1' } as unknown as IMcpServer;
    expect(() => assertMemberUsable(self, asSelf, 'composite-1')).toThrow(/itself/i);
  });

  it('rejects a nested composite member', () => {
    const nested = { ...baseMember, sourceType: 'composite' } as unknown as IMcpServer;
    expect(() => assertMemberUsable(self, nested, 'member-1')).toThrow(/nested/i);
  });

  it('rejects a member from a different tenant', () => {
    const other = { ...baseMember, tenantId: 'tenant-2' } as unknown as IMcpServer;
    expect(() => assertMemberUsable(self, other, 'member-1')).toThrow(/tenant/i);
  });

  it('rejects a member from a different project', () => {
    const other = { ...baseMember, projectId: 'project-2' } as unknown as IMcpServer;
    expect(() => assertMemberUsable(self, other, 'member-1')).toThrow(/project/i);
  });
});

describe('sanitizeCompositePrefix / defaultMemberPrefix', () => {
  it('accepts a well-formed prefix', () => {
    expect(sanitizeCompositePrefix('kb_1')).toBe('kb_1');
  });

  it('rejects an empty or invalid prefix', () => {
    expect(sanitizeCompositePrefix('')).toBeUndefined();
    expect(sanitizeCompositePrefix('has space')).toBeUndefined();
    expect(sanitizeCompositePrefix(42)).toBeUndefined();
  });

  it('slugifies a server key into a default prefix', () => {
    expect(defaultMemberPrefix('My Cool API')).toBe('my_cool_api');
  });
});

describe('getCompositeConfig / getCompositeMemberSummaries / metadataWithComposite round-trip', () => {
  it('round-trips members + hasInternalMember + summaries through metadata', () => {
    const metadata = metadataWithComposite(
      { unrelated: true },
      {
        members: [{ serverId: 's1', serverKey: 'server-1', toolPrefix: undefined, alwaysPrefix: false }],
        hasInternalMember: true,
      },
      [{ serverId: 's1', serverKey: 'server-1', name: 'Server One', sourceType: 'internal', status: 'active', toolCount: 3 }],
    );
    expect(metadata.unrelated).toBe(true);
    const config = getCompositeConfig({ metadata });
    expect(config.members).toEqual([{ serverId: 's1', serverKey: 'server-1', toolPrefix: undefined, alwaysPrefix: false }]);
    expect(config.hasInternalMember).toBe(true);
    expect(getCompositeMemberSummaries({ metadata })).toEqual([
      { serverId: 's1', serverKey: 'server-1', name: 'Server One', sourceType: 'internal', status: 'active', toolCount: 3 },
    ]);
  });

  it('defaults to empty when metadata has no composite block', () => {
    expect(getCompositeConfig({ metadata: undefined })).toEqual({ members: [], hasInternalMember: false });
    expect(getCompositeMemberSummaries({ metadata: undefined })).toEqual([]);
  });
});
