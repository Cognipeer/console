/**
 * Re-using engine answers between people who are the same to the engine.
 *
 * With only the built-in policies in force, the engine's answer for a service
 * depends on nothing but the principal's level sets, its project limits and (for
 * a token) its caps: not on who the person is, which groups they are in or which
 * project the request runs in. Thousands of members who share a role and the
 * same group grants therefore share one answer, and asking the engine once per
 * distinct combination turns a run over a large directory from tens of minutes
 * into a few.
 *
 * The signature is built from the principal AS THE REQUEST GATE BUILT IT, so a
 * wiring mistake in how a person's levels are assembled still shows up (it
 * produces a different signature and is compared with the independent
 * arithmetic like any other). It is not used when the workspace has custom
 * policies: those can name people, groups, projects and addresses.
 */

import type { Checks } from './model';

export interface SignedPrincipal {
  kind: 'user' | 'token';
  sets: { readSvcs: readonly string[]; writeSvcs: readonly string[]; adminSvcs: readonly string[] };
  projDeny?: { read: readonly string[]; write: readonly string[]; admin: readonly string[] };
  token?: { scoped: boolean; capRead: readonly string[]; capWrite: readonly string[]; capAdmin: readonly string[] };
}

/** Everything the built-in policies read, as one string. */
export function decisionSignature(channel: string, p: SignedPrincipal): string {
  return JSON.stringify([
    channel,
    p.kind,
    p.sets.readSvcs,
    p.sets.writeSvcs,
    p.sets.adminSvcs,
    p.projDeny ? [p.projDeny.read, p.projDeny.write, p.projDeny.admin] : null,
    p.token ? [p.token.scoped, p.token.capRead, p.token.capWrite, p.token.capAdmin] : null,
  ]);
}

export class DecisionMemo {
  private readonly bySignature = new Map<string, Map<string, Checks>>();
  hits = 0;
  misses = 0;

  /** `maxSignatures` bounds memory on a directory where nobody is alike; past it, answers are simply not kept. */
  constructor(private readonly maxSignatures = 20_000) {}

  get(signature: string, service: string): Checks | undefined {
    const hit = this.bySignature.get(signature)?.get(service);
    if (hit) this.hits++;
    else this.misses++;
    return hit ? { ...hit } : undefined;
  }

  set(signature: string, service: string, checks: Checks): void {
    let services = this.bySignature.get(signature);
    if (!services) {
      if (this.bySignature.size >= this.maxSignatures) return;
      services = new Map();
      this.bySignature.set(signature, services);
    }
    services.set(service, { ...checks });
  }

  get signatures(): number {
    return this.bySignature.size;
  }
}
