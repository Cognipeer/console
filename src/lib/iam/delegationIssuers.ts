/**
 * The issuers a workspace trusts to vouch for people of its host applications: the `trust.issuer` of every token delegation
 * (`iam_delegations`, see tokenDelegation.ts). An administrator adding an external person by hand picks one of these.
 *
 * Reads only the public part of each document - never the sealed secrets - and is a read of the workspace's few delegation
 * documents, not of any account.
 */

import { runWithTenantScope } from '@/lib/database';

const COLLECTION = 'iam_delegations' as const;

export interface DelegationIssuer {
  issuer: string;
  /** At least one delegation of this issuer is switched on. */
  enabled: boolean;
  /** How many tokens trust this issuer. */
  tokens: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The distinct issuers configured in the workspace, by name. */
export async function listDelegationIssuers(tenantDbName: string): Promise<DelegationIssuer[]> {
  const docs = await runWithTenantScope(tenantDbName, (db) => db.iamDocList(COLLECTION, { limit: 5000 }));
  const byIssuer = new Map<string, DelegationIssuer>();
  for (const doc of docs) {
    const trust = doc.data.trust;
    const issuer = isRecord(trust) && typeof trust.issuer === 'string' ? trust.issuer.trim() : '';
    if (!issuer) continue;
    const entry = byIssuer.get(issuer) ?? { issuer, enabled: false, tokens: 0 };
    entry.tokens += 1;
    if (doc.data.enabled === true) entry.enabled = true;
    byIssuer.set(issuer, entry);
  }
  return [...byIssuer.values()].sort((a, b) => a.issuer.localeCompare(b.issuer));
}

/** Whether the workspace has a delegation for this issuer (an exact match of the stored name). */
export async function isDelegationIssuer(tenantDbName: string, issuer: string): Promise<boolean> {
  return (await listDelegationIssuers(tenantDbName)).some((entry) => entry.issuer === issuer);
}
