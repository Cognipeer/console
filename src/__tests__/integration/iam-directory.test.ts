/**
 * IAM directory queries (the paged, searchable listings behind the
 * Authorization center) - the same contract on BOTH backends: users, groups,
 * member counts, API tokens and audit rows; tenant isolation of each.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('IAM directory queries', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let otherTenantId: string;
  let dbName: string;
  const userIds: string[] = [];
  const groupIds: Record<string, string> = {};
  const tokenIds: string[] = [];

  beforeAll(async () => {
    db = getDb();
    const slug = `iamdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Dir', slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    const other = `iamdir-o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    otherTenantId = String((await db.createTenant({ companyName: 'Other', slug: other, dbName: `tenant_${other}`, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(dbName);

    // 25 people: names sort as written, three admins, two disabled
    for (let i = 1; i <= 25; i++) {
      const n = String(i).padStart(2, '0');
      const user = await db.createUser({
        tenantId,
        email: `person${n}@corp.example`,
        name: `Person ${n}`,
        password: 'secret-hash',
        role: i <= 3 ? 'admin' : 'user',
        licenseId: 'FREE',
        features: [],
        ...(i === 4 || i === 5 ? { status: 'disabled' as const } : {}),
      });
      userIds.push(String(user._id));
    }
    // awkward names for search escaping
    for (const [name, email] of [['100% Real_Name', 'pct@corp.example'], ['Dot.Star (x)', 'dot@corp.example']] as const) {
      userIds.push(String((await db.createUser({ tenantId, email, name, password: 'h', role: 'user', licenseId: 'FREE', features: [] }))._id));
    }
    // a row of ANOTHER tenant in the same database must never be listed
    await db.createUser({ tenantId: otherTenantId, email: 'intruder@other.example', name: 'Person Intruder', password: 'h', role: 'user', licenseId: 'FREE', features: [] });

    const mkGroup = async (name: string, description?: string) => {
      const g = await db.createGroup({ tenantId, name, description, createdBy: 't', source: 'local' } as never);
      groupIds[name] = String(g._id);
      return g;
    };
    await mkGroup('Engineering', 'All engineers');
    await mkGroup('Operations');
    await mkGroup('Empty team');
    for (const id of userIds.slice(0, 12)) await db.addGroupMember({ groupId: groupIds.Engineering, userId: id, tenantId, role: 'member' });
    for (const id of userIds.slice(10, 14)) await db.addGroupMember({ groupId: groupIds.Operations, userId: id, tenantId, role: 'member' });

    // tokens of this tenant (owned by person01 / person02) and one of the other tenant
    for (const [owner, label, prefix] of [[0, 'CI deploy', 'cp_ci01'], [0, 'Notebook', 'cp_nb02'], [1, 'Batch job', 'cp_bj03']] as const) {
      const t = await db.createApiToken({ tenantId, userId: userIds[owner], label, tokenHash: `hash-${label}-${Math.random()}`, tokenPrefix: prefix, createdBy: userIds[owner] } as never);
      tokenIds.push(String(t._id));
    }
    await db.createApiToken({ tenantId: otherTenantId, userId: 'someone', label: 'Foreign', tokenHash: `hash-foreign-${Math.random()}`, tokenPrefix: 'cp_fx', createdBy: 'someone' } as never);

    // audit rows
    const base = { tenantId, actorType: 'user' as const, action: 'admin' as const, outcome: 'success' as const };
    await db.createAuditLog({ ...base, service: 'iam', event: 'iam.policy.create', actorUserId: userIds[0], resourceType: 'iam-policy', resourceId: 'p1', metadata: { iamChange: true, policyId: 'p1' } });
    await db.createAuditLog({ ...base, service: 'iam', event: 'iam.settings.update', actorUserId: userIds[1], resourceType: 'iam-settings', metadata: { iamChange: true } });
    await db.createAuditLog({ ...base, service: 'agents', action: 'write', outcome: 'denied', event: 'POST /api/agents', actorUserId: userIds[5], metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-0001' } });
    await db.createAuditLog({ ...base, service: 'models', action: 'read', outcome: 'denied', event: 'GET /api/models', actorUserId: userIds[6], apiTokenId: tokenIds[0], actorType: 'api_token', metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-0002', count: 3 } });
    await db.createAuditLog({ ...base, service: 'models', action: 'read', outcome: 'denied', event: 'GET /api/models', actorUserId: userIds[6], metadata: { plain: true } });
    await db.createAuditLog({ ...base, tenantId: otherTenantId, service: 'agents', outcome: 'denied', event: 'foreign', metadata: { iamEnforce: true, decisionId: 'dec-foreign' } });
  });

  describe('users', () => {
    it('pages ordered by name, reports hasMore and never returns the password', async () => {
      const first = await db.iamListUsers({ tenantId, limit: 10 });
      expect(first.items).toHaveLength(10);
      expect(first.hasMore).toBe(true);
      expect(first.items.every((u) => u.password === '')).toBe(true);
      const second = await db.iamListUsers({ tenantId, limit: 10, offset: 10 });
      const third = await db.iamListUsers({ tenantId, limit: 10, offset: 20 });
      const names = [...first.items, ...second.items, ...third.items].map((u) => u.name);
      expect(new Set(names).size).toBe(names.length); // pages do not overlap
      expect(names).toEqual([...names].sort()); // plain binary order
      expect(third.hasMore).toBe(false);
      expect(third.items).toHaveLength(7); // 27 of this tenant in total
      const all = await db.iamListUsers({ tenantId, limit: 200 });
      expect(all.items).toHaveLength(27);
      expect(all.items.map((u) => u.email)).not.toContain('intruder@other.example');
    });

    it('searches name and email case-insensitively, treating wildcards and regex characters literally', async () => {
      expect((await db.iamListUsers({ tenantId, q: 'PERSON 07', limit: 50 })).items.map((u) => u.name)).toEqual(['Person 07']);
      expect((await db.iamListUsers({ tenantId, q: 'person1', limit: 50 })).items).toHaveLength(10); // 10..19
      expect((await db.iamListUsers({ tenantId, q: '100%', limit: 50 })).items.map((u) => u.name)).toEqual(['100% Real_Name']);
      expect((await db.iamListUsers({ tenantId, q: '%', limit: 50 })).items.map((u) => u.name)).toEqual(['100% Real_Name']);
      expect((await db.iamListUsers({ tenantId, q: 'Real_N', limit: 50 })).items).toHaveLength(1);
      expect((await db.iamListUsers({ tenantId, q: 'l_N', limit: 50 })).items).toHaveLength(1);
      expect((await db.iamListUsers({ tenantId, q: '.S', limit: 50 })).items.map((u) => u.name)).toEqual(['Dot.Star (x)']);
      expect((await db.iamListUsers({ tenantId, q: 'D.t', limit: 50 })).items).toEqual([]); // '.' is not a wildcard
      expect((await db.iamListUsers({ tenantId, q: '.*', limit: 50 })).items).toEqual([]);
      expect((await db.iamListUsers({ tenantId, q: '(x)', limit: 50 })).items).toHaveLength(1);
      expect((await db.iamListUsers({ tenantId, q: 'corp.example', limit: 50 })).items).toHaveLength(27);
      expect((await db.iamListUsers({ tenantId, q: 'nobody-like-this', limit: 50 })).items).toEqual([]);
    });

    it('filters by role, status and ids', async () => {
      expect((await db.iamListUsers({ tenantId, roles: ['admin'], limit: 50 })).items).toHaveLength(3);
      expect((await db.iamListUsers({ tenantId, roles: ['admin', 'owner'], limit: 50 })).items).toHaveLength(3);
      expect((await db.iamListUsers({ tenantId, status: 'disabled', limit: 50 })).items.map((u) => u.name)).toEqual(['Person 04', 'Person 05']);
      expect((await db.iamListUsers({ tenantId, status: 'active', limit: 50 })).items).toHaveLength(25);
      const some = await db.iamListUsers({ tenantId, ids: [userIds[2], userIds[7], 'not-an-id', 'ffffffffffffffffffffffff'], limit: 50 });
      expect(some.items.map((u) => String(u._id)).sort()).toEqual([userIds[2], userIds[7]].sort());
      expect((await db.iamListUsers({ tenantId, ids: [], limit: 50 })).items).toEqual([]);
      expect((await db.iamListUsers({ tenantId: otherTenantId, limit: 50 })).items.map((u) => u.name)).toEqual(['Person Intruder']);
    });

    it('clamps absurd limits and offsets', async () => {
      expect((await db.iamListUsers({ tenantId, limit: 100_000 })).items.length).toBeLessThanOrEqual(200);
      expect((await db.iamListUsers({ tenantId, limit: 0 })).items.length).toBeGreaterThanOrEqual(1);
      expect((await db.iamListUsers({ tenantId, limit: 5, offset: -4 })).items).toHaveLength(5);
    });
  });

  describe('groups', () => {
    it('lists by name with search, ids and tenant isolation', async () => {
      expect((await db.iamListGroups({ tenantId, limit: 10 })).items.map((g) => g.name)).toEqual(['Empty team', 'Engineering', 'Operations']);
      expect((await db.iamListGroups({ tenantId, q: 'engineers', limit: 10 })).items.map((g) => g.name)).toEqual(['Engineering']); // description matches too
      expect((await db.iamListGroups({ tenantId, q: 'OPER', limit: 10 })).items.map((g) => g.name)).toEqual(['Operations']);
      expect((await db.iamListGroups({ tenantId, ids: [groupIds.Operations], limit: 10 })).items).toHaveLength(1);
      expect((await db.iamListGroups({ tenantId: otherTenantId, limit: 10 })).items).toEqual([]);
      const page = await db.iamListGroups({ tenantId, limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.items[0].source).toBe('local');
    });

    it('counts members per group (empty groups are 0) and pages member ids', async () => {
      expect(await db.iamCountGroupMembers([groupIds.Engineering, groupIds.Operations, groupIds['Empty team']])).toEqual({
        [groupIds.Engineering]: 12,
        [groupIds.Operations]: 4,
        [groupIds['Empty team']]: 0,
      });
      expect(await db.iamCountGroupMembers([])).toEqual({});
      const page = await db.iamListGroupMemberIds(groupIds.Engineering, { limit: 5 });
      expect(page.items).toHaveLength(5);
      expect(page.hasMore).toBe(true);
      const rest = await db.iamListGroupMemberIds(groupIds.Engineering, { limit: 100, offset: 5 });
      expect(rest.items).toHaveLength(7);
      expect(new Set([...page.items, ...rest.items])).toEqual(new Set(userIds.slice(0, 12)));
    });
  });

  describe('tokens', () => {
    it('lists only this tenant, newest first, with search, owner and ids filters, and no secrets', async () => {
      const all = await db.iamListTokens({ tenantId, limit: 50 });
      expect(all.items.map((t) => t.label).sort()).toEqual(['Batch job', 'CI deploy', 'Notebook']);
      expect(all.items.some((t) => t.label === 'Foreign')).toBe(false);
      for (const t of all.items) {
        expect(t.tokenHash).toBeUndefined();
        expect(t.token).toBeUndefined();
        expect(String(t._id)).toBeTruthy();
      }
      expect((await db.iamListTokens({ tenantId, q: 'ci dep', limit: 50 })).items.map((t) => t.label)).toEqual(['CI deploy']);
      expect((await db.iamListTokens({ tenantId, q: 'cp_nb', limit: 50 })).items.map((t) => t.label)).toEqual(['Notebook']);
      expect((await db.iamListTokens({ tenantId, userId: userIds[0], limit: 50 })).items).toHaveLength(2);
      expect((await db.iamListTokens({ tenantId, ids: [tokenIds[2], 'zzz'], limit: 50 })).items.map((t) => t.label)).toEqual(['Batch job']);
      expect((await db.iamListTokens({ tenantId: otherTenantId, limit: 50 })).items.map((t) => t.label)).toEqual(['Foreign']);
      const page = await db.iamListTokens({ tenantId, limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
    });
  });

  describe('audit events', () => {
    it('lists this tenant newest first and filters by service, outcome, actor, token and resource type', async () => {
      const all = await db.iamListAuditEvents({ tenantId, limit: 50 });
      expect(all.items).toHaveLength(5);
      expect(all.items.some((r) => r.event === 'foreign')).toBe(false);
      const times = all.items.map((r) => new Date(r.createdAt!).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));

      expect((await db.iamListAuditEvents({ tenantId, service: 'iam', limit: 50 })).items).toHaveLength(2);
      expect((await db.iamListAuditEvents({ tenantId, outcome: 'denied', limit: 50 })).items).toHaveLength(3);
      expect((await db.iamListAuditEvents({ tenantId, actorUserId: userIds[6], limit: 50 })).items).toHaveLength(2);
      expect((await db.iamListAuditEvents({ tenantId, actorUserIds: [userIds[0], userIds[1]], limit: 50 })).items).toHaveLength(2);
      expect((await db.iamListAuditEvents({ tenantId, actorUserIds: [], limit: 50 })).items).toEqual([]);
      expect((await db.iamListAuditEvents({ tenantId, apiTokenId: tokenIds[0], limit: 50 })).items).toHaveLength(1);
      expect((await db.iamListAuditEvents({ tenantId, resourceTypes: ['iam-policy', 'iam-settings'], limit: 50 })).items).toHaveLength(2);
      expect((await db.iamListAuditEvents({ tenantId, resourceTypes: ['iam-mode'], limit: 50 })).items).toEqual([]);
    });

    it('matches one top-level metadata key (boolean, string, number) and refuses a malformed key', async () => {
      expect((await db.iamListAuditEvents({ tenantId, metadata: { key: 'iamEnforce', value: true }, limit: 50 })).items).toHaveLength(2);
      expect((await db.iamListAuditEvents({ tenantId, metadata: { key: 'decisionId', value: 'dec-0002' }, limit: 5 })).items.map((r) => r.event)).toEqual(['GET /api/models']);
      expect((await db.iamListAuditEvents({ tenantId, metadata: { key: 'count', value: 3 }, limit: 50 })).items).toHaveLength(1);
      expect((await db.iamListAuditEvents({ tenantId, metadata: { key: 'decisionId', value: 'dec-foreign' }, limit: 50 })).items).toEqual([]); // another tenant's decision
      expect((await db.iamListAuditEvents({ tenantId, metadata: { key: 'iamEnforce', value: false }, limit: 50 })).items).toEqual([]);
      await expect(db.iamListAuditEvents({ tenantId, metadata: { key: "x') OR 1=1 --", value: 'a' }, limit: 5 })).rejects.toThrow(/Invalid metadata key/);
      await expect(db.iamListAuditEvents({ tenantId, metadata: { key: 'a.b', value: 'a' }, limit: 5 })).rejects.toThrow(/Invalid metadata key/);
    });

    it('filters by time and pages', async () => {
      const all = await db.iamListAuditEvents({ tenantId, limit: 50 });
      const newest = new Date(all.items[0].createdAt!);
      expect((await db.iamListAuditEvents({ tenantId, from: new Date(newest.getTime() + 60_000), limit: 50 })).items).toEqual([]);
      expect((await db.iamListAuditEvents({ tenantId, to: new Date(newest.getTime() + 60_000), limit: 50 })).items).toHaveLength(5);
      expect((await db.iamListAuditEvents({ tenantId, to: new Date(0), limit: 50 })).items).toEqual([]);
      const page1 = await db.iamListAuditEvents({ tenantId, limit: 2 });
      const page2 = await db.iamListAuditEvents({ tenantId, limit: 2, offset: 2 });
      const page3 = await db.iamListAuditEvents({ tenantId, limit: 2, offset: 4 });
      expect([page1.hasMore, page2.hasMore, page3.hasMore]).toEqual([true, true, false]);
      expect(new Set([...page1.items, ...page2.items, ...page3.items].map((r) => String(r._id))).size).toBe(5);
    });
  });
});

describe('directory contract', () => {
  it('is declared on the provider interface', async () => {
    const { SQLiteProvider } = await import('@/lib/database/sqlite.provider');
    for (const method of ['iamListUsers', 'iamListGroups', 'iamCountGroupMembers', 'iamListGroupMemberIds', 'iamListTokens', 'iamListAuditEvents']) {
      expect(typeof (SQLiteProvider.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });
});

// ── search is the same on both backends for names outside ASCII ──────────────
// SQLite's LIKE only folds the case of ASCII letters; MongoDB's case-insensitive $regex folds Unicode. A person
// typing "şule" must find "Şule" on an on-prem SQLite install exactly as on MongoDB (a function folds both
// sides there; accents are not stripped on either backend). The four letters of the Turkish i family (I, İ, i, ı)
// are one letter for the search (see the next block).
describeForEachProvider('IAM directory search: names beyond ASCII', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;

  beforeAll(async () => {
    db = getDb();
    const slug = `iamdir-tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Dir TR', slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(dbName);
    for (const [name, email] of [
      ['Şule Yıldız', 'sule@corp.example'],
      ['İbrahim Çelik', 'ibrahim@corp.example'],
      ['Özlem Öztürk', 'ozlem@corp.example'],
      ['Ayşe Ünal', 'ayse@corp.example'],
      ['Ünsal ÇAĞLAR', 'unsal@corp.example'],
      ['Zoë Müller', 'zoe@corp.example'],
      ['ÅSA Ångström', 'asa@corp.example'],
    ] as const) {
      await db.createUser({ tenantId, email, name, password: 'h', role: 'user', licenseId: 'FREE', features: [] });
    }
    await db.createGroup({ tenantId, name: 'Çözüm Ekibi', description: 'Şirket içi', createdBy: 't', source: 'local' } as never);
    await db.createApiToken({ tenantId, userId: 'someone', label: 'Çevrimiçi Token', tokenHash: `hash-${Math.random()}`, tokenPrefix: 'cp_tr01', createdBy: 'someone' } as never);
  });

  const names = async (q: string) => (await db.iamListUsers({ tenantId, q, limit: 50 })).items.map((u) => u.name).sort();

  it('finds a name whatever the case of its non-ASCII letters, in the query or in the data', async () => {
    expect(await names('şule')).toEqual(['Şule Yıldız']);
    expect(await names('ŞULE')).toEqual(['Şule Yıldız']);
    expect(await names('çelik')).toEqual(['İbrahim Çelik']);
    expect(await names('ÇELİK')).toEqual(['İbrahim Çelik']); // the dotted capital İ meets the plain i, on either backend
    expect(await names('özlem')).toEqual(['Özlem Öztürk']);
    expect(await names('öztürk')).toEqual(['Özlem Öztürk']);
    expect(await names('ünal')).toEqual(['Ayşe Ünal']);
    expect(await names('çağlar')).toEqual(['Ünsal ÇAĞLAR']);
    expect(await names('ÇAĞLAR')).toEqual(['Ünsal ÇAĞLAR']);
    expect(await names('müller')).toEqual(['Zoë Müller']);
    expect(await names('åsa')).toEqual(['ÅSA Ångström']);
    expect(await names('ångström')).toEqual(['ÅSA Ångström']);
  });

  it('does not fold accents away (neither backend does), and ASCII search is unchanged', async () => {
    expect(await names('sule yildiz')).toEqual([]);
    expect(await names('SULE@CORP')).toEqual(['Şule Yıldız']); // the e-mail is ASCII
    expect(await names('corp.example')).toHaveLength(7);
  });

  it('applies to groups (name and description) and tokens (label) the same way', async () => {
    expect((await db.iamListGroups({ tenantId, q: 'çözüm', limit: 10 })).items.map((g) => g.name)).toEqual(['Çözüm Ekibi']);
    expect((await db.iamListGroups({ tenantId, q: 'ŞİRKET', limit: 10 })).items.map((g) => g.name)).toEqual(['Çözüm Ekibi']);
    expect((await db.iamListGroups({ tenantId, q: 'şirket', limit: 10 })).items.map((g) => g.name)).toEqual(['Çözüm Ekibi']);
    expect((await db.iamListTokens({ tenantId, q: 'çevrimiçi', limit: 10 })).items.map((t) => t.label)).toEqual(['Çevrimiçi Token']);
    expect((await db.iamListTokens({ tenantId, q: 'ÇEVRİMİÇİ', limit: 10 })).items.map((t) => t.label)).toEqual(['Çevrimiçi Token']);
  });
});

// ── the Turkish i family ───────────────────────────────────────────────────────
// "İstanbul" lower-cases to "i" + a combining dot, which no typed "istanbul" ever matched, and "ISPARTA" is "Isparta"
// = "ısparta" in Turkish but "isparta" on an English keyboard. So I, İ, i and ı meet at "i" in the search on both
// backends (SQLite folds both sides in iam_fold; MongoDB's pattern lists the four), whatever the case typed or stored.
describeForEachProvider('IAM directory search: the Turkish i family', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;

  beforeAll(async () => {
    db = getDb();
    const slug = `iamdir-i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Dir I', slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(dbName);
    for (const [name, email] of [
      ['İsmail Işık', 'ismail@corp.example'],
      ['Işıl Demir', 'isil@corp.example'],
      ['IRMAK ISPARTA', 'irmak@corp.example'],
      ['Ilgaz Inan', 'ilgaz@corp.example'],
      ['Tülin Çiçek', 'tc1@corp.example'], // an address that does not spell the name, so only the name can be found
      ['Ali Veli', 'ali@corp.example'],
    ] as const) {
      await db.createUser({ tenantId, email, name, password: 'h', role: 'user', licenseId: 'FREE', features: [] });
    }
    await db.createGroup({ tenantId, name: 'İSTANBUL Ekibi', description: 'Işık Grubu', createdBy: 't', source: 'local' } as never);
    await db.createGroup({ tenantId, name: 'Isparta Ekibi', createdBy: 't', source: 'local' } as never);
    await db.createApiToken({ tenantId, userId: 'someone', label: 'İşlem Anahtarı', tokenHash: `hash-${Math.random()}`, tokenPrefix: 'cp_ISL', createdBy: 'someone' } as never);
  });

  const names = async (q: string) => (await db.iamListUsers({ tenantId, q, limit: 50 })).items.map((u) => u.name).sort();
  const groupNames = async (q: string) => (await db.iamListGroups({ tenantId, q, limit: 50 })).items.map((g) => g.name).sort();
  const labels = async (q: string) => (await db.iamListTokens({ tenantId, q, limit: 50 })).items.map((t) => t.label).sort();

  it('finds a dotted capital İ with the plain i, the dotless ı and every case of them', async () => {
    for (const q of ['ismail', 'ISMAIL', 'İsmail', 'İSMAİL', 'ısmaıl', 'Ismail']) expect(await names(q), q).toEqual(['İsmail Işık']);
  });

  it('finds a dotless ı however it is typed', async () => {
    for (const q of ['ışık', 'IŞIK', 'işik', 'İŞİK', 'Işık']) expect(await names(q), q).toEqual(['İsmail Işık']);
    for (const q of ['ışıl', 'IŞIL', 'işil', 'İŞİL']) expect(await names(q), q).toEqual(['Işıl Demir']);
  });

  it('finds a capital I that stands for the dotless letter - "ISPARTA" is "ısparta" - with all of its spellings', async () => {
    for (const q of ['ISPARTA', 'isparta', 'ısparta', 'İsparta', 'Isparta']) expect(await names(q), q).toEqual(['IRMAK ISPARTA']);
    for (const q of ['ilgaz', 'ILGAZ', 'ılgaz', 'İlgaz']) expect(await names(q), q).toEqual(['Ilgaz Inan']);
  });

  it('finds the other Turkish letters as before, and still does not strip accents', async () => {
    for (const q of ['çiçek', 'ÇİÇEK', 'çıçek', 'Çiçek']) expect(await names(q), q).toEqual(['Tülin Çiçek']);
    expect(await names('tülin')).toEqual(['Tülin Çiçek']);
    expect(await names('TÜLİN')).toEqual(['Tülin Çiçek']);
    expect(await names('tulin')).toEqual([]); // ü is not u
    expect(await names('cicek')).toEqual([]); // ç is not c
  });

  it('finds the i family in an e-mail address too, and leaves plain ASCII search as it was', async () => {
    expect(await names('IRMAK@CORP')).toEqual(['IRMAK ISPARTA']);
    expect(await names('ıRMAK@corp')).toEqual(['IRMAK ISPARTA']);
    expect(await names('ali')).toEqual(['Ali Veli']);
    expect(await names('CORP.EXAMPLE')).toHaveLength(6);
  });

  it('treats the characters a pattern would read as syntax as plain text', async () => {
    for (const q of ['%', '_', 'i%', '\\', 'i.', '(i', '[i]', 'i|a', '.*']) expect(await names(q), q).toEqual([]);
  });

  it('applies to groups (name and description) and tokens (label and prefix) the same way', async () => {
    for (const q of ['istanbul', 'İSTANBUL', 'ıstanbul']) expect(await groupNames(q), q).toEqual(['İSTANBUL Ekibi']);
    for (const q of ['ışık', 'IŞIK', 'işik']) expect(await groupNames(q), q).toEqual(['İSTANBUL Ekibi']); // the description
    for (const q of ['isparta', 'ISPARTA', 'ısparta']) expect(await groupNames(q), q).toEqual(['Isparta Ekibi']);
    for (const q of ['işlem', 'İŞLEM', 'ışlem']) expect(await labels(q), q).toEqual(['İşlem Anahtarı']);
    for (const q of ['cp_isl', 'CP_ISL', 'cp_ısl']) expect(await labels(q), q).toEqual(['İşlem Anahtarı']); // the prefix
    expect(await labels('islem')).toEqual([]); // ş is not s
  });

  it('counts what it lists', async () => {
    expect(await db.iamCountUsers({ tenantId, q: 'ısparta' })).toBe(1);
    expect(await db.iamCountUsers({ tenantId, q: 'İSMAİL' })).toBe(1);
    expect(await db.iamCountGroups({ tenantId, q: 'ıstanbul' })).toBe(1);
  });
});

// ── an audit actor filter takes a whole group, and a few events can join the IAM change scope ──
describeForEachProvider('IAM directory audit filters: big actor lists and extra events', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;

  beforeAll(async () => {
    db = getDb();
    const slug = `iamdir-au-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Dir Audit', slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(dbName);
  });

  it('matches thousands of actors in one query (a group of 3,000 people), and only those', async () => {
    const actors = Array.from({ length: 3_000 }, (_, i) => `actor-${String(i).padStart(5, '0')}`);
    for (const id of actors.slice(0, 700)) {
      await db.createAuditLog({ tenantId, actorType: 'user', actorUserId: id, service: 'agents', action: 'write', outcome: 'denied', event: 'POST /api/agents', metadata: { iamEnforce: true } });
    }
    await db.createAuditLog({ tenantId, actorType: 'user', actorUserId: 'stranger', service: 'agents', action: 'write', outcome: 'denied', event: 'POST /api/agents', metadata: { iamEnforce: true } });
    let offset = 0;
    let seen = 0;
    for (;;) {
      const page = await db.iamListAuditEvents({ tenantId, actorUserIds: actors, outcome: 'denied', limit: 200, offset });
      seen += page.items.length;
      expect(page.items.every((r) => r.actorUserId?.startsWith('actor-'))).toBe(true);
      if (!page.hasMore) break;
      offset += 200;
    }
    expect(seen).toBe(700);
    // an explicit actor AND a list must both hold
    expect((await db.iamListAuditEvents({ tenantId, actorUserId: 'actor-00003', actorUserIds: actors, limit: 10 })).items).toHaveLength(1);
    expect((await db.iamListAuditEvents({ tenantId, actorUserId: 'stranger', actorUserIds: actors, limit: 10 })).items).toHaveLength(0);
  });

  it('alsoEvents adds rows of other services to a service + resource-type scope, keeping every other filter', async () => {
    const base = { tenantId, actorType: 'user' as const, action: 'admin' as const };
    await db.createAuditLog({ ...base, service: 'iam', event: 'iam.policy.create', outcome: 'success', actorUserId: 'a1', resourceType: 'iam-policy', resourceId: 'p1' });
    await db.createAuditLog({ ...base, service: 'tokens', event: 'token.restrictions.updated', outcome: 'success', actorUserId: 'a1', resourceType: 'api_token', resourceId: 't1' });
    await db.createAuditLog({ ...base, service: 'tokens', event: 'token.restrictions.updated', outcome: 'success', actorUserId: 'a2', resourceType: 'api_token', resourceId: 't2' });
    await db.createAuditLog({ ...base, service: 'tokens', event: 'POST /api/tokens', outcome: 'success', actorUserId: 'a1' });
    await db.createAuditLog({ ...base, service: 'iam', event: 'iam.policy.delete', outcome: 'failure', actorUserId: 'a1', resourceType: 'iam-policy' });
    const scope = { tenantId, service: 'iam', outcome: 'success' as const, resourceTypes: ['iam-policy', 'iam-settings', 'iam-mode'], limit: 50 };
    expect((await db.iamListAuditEvents(scope)).items.map((r) => r.event)).toEqual(['iam.policy.create']);
    const widened = (await db.iamListAuditEvents({ ...scope, alsoEvents: ['token.restrictions.updated'] })).items.map((r) => r.event).sort();
    expect(widened).toEqual(['iam.policy.create', 'token.restrictions.updated', 'token.restrictions.updated']);
    // the actor filter applies to both sides of the OR
    const mine = (await db.iamListAuditEvents({ ...scope, alsoEvents: ['token.restrictions.updated'], actorUserId: 'a2' })).items.map((r) => r.event);
    expect(mine).toEqual(['token.restrictions.updated']);
    // an empty resource-type list matches nothing by itself, but not when extra events are asked for
    expect((await db.iamListAuditEvents({ ...scope, resourceTypes: [] })).items).toEqual([]);
    expect((await db.iamListAuditEvents({ ...scope, resourceTypes: [], alsoEvents: ['token.restrictions.updated'] })).items).toHaveLength(2);
  });
});
