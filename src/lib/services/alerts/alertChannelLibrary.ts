/**
 * Tenant channel library: reusable notification channels that rules reference
 * (`{ type: 'library', libraryId }`) instead of embedding their own copy.
 *
 * Secrets are sealed with the same helpers as rule channels and every response
 * is masked. Rules resolve the entry at dispatch time (`channels/libraryResolve`).
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertDeliverableChannelInput, IAlertChannel, IAlertChannelLibraryEntry, IAlertRule } from '@/lib/database';
import { AlertApiError } from './alertApiError';
import { normalizeChannelInput, verifyChannelDestinations } from './alertService';
import { maskChannels, sealChannels } from './channels/channelSecrets';

const MAX_NAME_LENGTH = 80;
const MAX_ENTRIES = 100;
const KINDS = ['email', 'webhook', 'slack', 'teams', 'pagerduty'] as const;

export interface LibraryEntryView {
  id: string;
  name: string;
  kind: IAlertChannelLibraryEntry['kind'];
  /** Masked: hints only, never a URL, key or secret. */
  config: IAlertChannel;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
  usedBy: Array<{ ruleId: string; ruleName: string; projectId: string }>;
}

function bad(code: string, message: string): AlertApiError {
  return new AlertApiError(400, code, message);
}

function toView(entry: IAlertChannelLibraryEntry, usedBy: LibraryEntryView['usedBy'] = []): LibraryEntryView {
  const [config] = maskChannels([entry.config]);
  return {
    id: String(entry._id),
    name: entry.name,
    kind: entry.kind,
    config,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    usedBy,
  };
}

function usageIndex(rules: IAlertRule[]): Map<string, LibraryEntryView['usedBy']> {
  const index = new Map<string, LibraryEntryView['usedBy']>();
  for (const rule of rules) {
    const seen = new Set<string>();
    for (const channel of rule.channels ?? []) {
      if (channel.type !== 'library' || seen.has(channel.libraryId)) continue;
      seen.add(channel.libraryId);
      const list = index.get(channel.libraryId) ?? [];
      list.push({ ruleId: String(rule._id), ruleName: rule.name, projectId: rule.projectId });
      index.set(channel.libraryId, list);
    }
  }
  return index;
}

function readName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw bad('invalid_name', 'name is required');
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) throw bad('invalid_name', `name must be at most ${MAX_NAME_LENGTH} characters`);
  return name;
}

function assertUniqueName(entries: IAlertChannelLibraryEntry[], name: string, exceptId?: string): void {
  const lowered = name.toLowerCase();
  if (entries.some((entry) => String(entry._id) !== exceptId && entry.name.toLowerCase() === lowered)) {
    throw new AlertApiError(409, 'name_taken', 'A library channel with this name already exists');
  }
}

/** `{ kind, config }` (plaintext secrets, as the rule form sends them) → validated channel input. */
function readChannel(kind: unknown, config: unknown, stored?: IAlertChannel): AlertDeliverableChannelInput {
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    throw bad('invalid_channel', `kind must be one of: ${KINDS.join(', ')}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw bad('invalid_channel', 'config must be an object');
  }
  const input = normalizeChannelInput({ ...(config as Record<string, unknown>), type: kind, ...(stored?.id ? { id: stored.id } : {}) }, 0, stored ? ({ channels: [stored] } as IAlertRule) : null);
  return input as AlertDeliverableChannelInput;
}

async function load(tenantDbName: string, tenantId: string, id: string) {
  const db = await getTenantDatabase(tenantDbName);
  const entry = await db.findAlertChannelLibraryEntry(id);
  if (!entry || entry.tenantId !== tenantId) throw new AlertApiError(404, 'channel_not_found', 'Channel not found');
  return { db, entry };
}

export class AlertChannelLibraryService {
  static async list(tenantDbName: string, tenantId: string): Promise<LibraryEntryView[]> {
    const db = await getTenantDatabase(tenantDbName);
    const [entries, rules] = await Promise.all([db.listAlertChannelLibrary(tenantId), db.listAlertRules(tenantId)]);
    const usage = usageIndex(rules);
    return entries.map((entry) => toView(entry, usage.get(String(entry._id)) ?? []));
  }

  static async create(
    tenantDbName: string,
    tenantId: string,
    userId: string,
    body: { name?: unknown; kind?: unknown; config?: unknown },
  ): Promise<LibraryEntryView> {
    const name = readName(body.name);
    const input = readChannel(body.kind, body.config);
    await verifyChannelDestinations([input]);
    const db = await getTenantDatabase(tenantDbName);
    const entries = await db.listAlertChannelLibrary(tenantId);
    if (entries.length >= MAX_ENTRIES) throw bad('limit_reached', `A workspace can keep at most ${MAX_ENTRIES} library channels`);
    assertUniqueName(entries, name);
    const [config] = await sealChannels([input], []);
    const created = await db.createAlertChannelLibraryEntry({
      tenantId,
      name,
      kind: input.type as IAlertChannelLibraryEntry['kind'],
      config: config as IAlertChannelLibraryEntry['config'],
      createdBy: userId,
    });
    return toView(created);
  }

  /** Secrets left out of `config` keep the stored value; `kind` cannot change. */
  static async update(
    tenantDbName: string,
    tenantId: string,
    id: string,
    body: { name?: unknown; kind?: unknown; config?: unknown },
  ): Promise<LibraryEntryView> {
    const { db, entry } = await load(tenantDbName, tenantId, id);
    const patch: Partial<Pick<IAlertChannelLibraryEntry, 'name' | 'config'>> = {};
    if (body.name !== undefined) {
      patch.name = readName(body.name);
      assertUniqueName(await db.listAlertChannelLibrary(tenantId), patch.name, id);
    }
    if (body.kind !== undefined && body.kind !== entry.kind) throw bad('invalid_channel', 'kind cannot be changed; create a new channel instead');
    if (body.config !== undefined) {
      const input = readChannel(entry.kind, body.config, entry.config);
      await verifyChannelDestinations([input]);
      const [config] = await sealChannels([input], [entry.config]);
      patch.config = config as IAlertChannelLibraryEntry['config'];
    }
    const updated = await db.updateAlertChannelLibraryEntry(id, patch);
    if (!updated) throw new AlertApiError(404, 'channel_not_found', 'Channel not found');
    return toView(updated);
  }

  /** 409 with the rule names while any rule of the tenant still references the entry. */
  static async remove(tenantDbName: string, tenantId: string, id: string): Promise<void> {
    const { db } = await load(tenantDbName, tenantId, id);
    const usedBy = usageIndex(await db.listAlertRules(tenantId)).get(id) ?? [];
    if (usedBy.length > 0) {
      throw new AlertApiError(409, 'channel_in_use', 'This channel is used by alert rules; remove it from them first', {
        rules: usedBy.map((rule) => ({ id: rule.ruleId, name: rule.ruleName })),
      });
    }
    await db.deleteAlertChannelLibraryEntry(id);
  }
}
