/** Shared types of the shadow-mode (C2) machinery. Type-only; no runtime imports. */

import type { GroupTenantGrant, RbacUserLike, UserServicePermissions } from '@/lib/security/rbac';

/**
 * What a recorded difference is about:
 *  - parity-mismatch    the managed engine disagreed with rbac.ts (a BUG; must stay 0)
 *  - token-groups       an API token's owner has group grants the token path ignores today
 *  - project-narrowing  the active project's role/permissions would lower the tenant-level access
 *  - unmapped-path      an authenticated caller reached an /api path no permission service covers
 */
export const SHADOW_CATEGORIES = ['parity-mismatch', 'token-groups', 'project-narrowing', 'unmapped-path'] as const;
export type ShadowCategory = typeof SHADOW_CATEGORIES[number];

export function isShadowCategory(value: unknown): value is ShadowCategory {
  return typeof value === 'string' && (SHADOW_CATEGORIES as readonly string[]).includes(value);
}

/** One concrete request behind an aggregate. Never contains bodies or query strings. */
export interface ShadowSample {
  requestId: string;
  userId: string;
  tokenId?: string;
  role: string;
  /** ISO time. */
  at: string;
  /** Short free-text (parity mismatches: the engine's reasons/errors). */
  detail?: string;
}

export interface ShadowEvent {
  category: ShadowCategory;
  service: string;
  method: string;
  route: string;
  legacyAllowed: boolean;
  targetAllowed: boolean;
  sample: ShadowSample;
}

/** A stored aggregate (one per distinct category/service/method/route/legacy/target tuple). */
export interface ShadowEntry {
  id: string;
  category: ShadowCategory;
  service: string;
  method: string;
  route: string;
  legacyAllowed: boolean;
  targetAllowed: boolean;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: ShadowSample[];
}

type RbacUserWithProjects = RbacUserLike & { projectIds?: string[] };

interface ObservationBase {
  subject: 'session' | 'token';
  tenantDbName: string;
  tenantId: string;
  requestId: string;
  method: string;
  /** Canonical request pathname (no query). */
  pathname: string;
  /** Route pattern when the framework has one, else the masked path. */
  route: string;
  /** Session user id, or the token OWNER's id. */
  userId: string;
  role: string;
  tokenId?: string;
}

/** A mapped request whose legacy decision was computed. */
export interface GateObservation extends ObservationBase {
  /** The user exactly as the legacy gate loaded it. */
  user: RbacUserWithProjects;
  /** Group grants exactly as the legacy gate used them ([] on the token path). */
  groupGrants: GroupTenantGrant[];
  /** Token scope exactly as passed to authorizeServiceRequest (undefined/null = unscoped). */
  tokenScope?: UserServicePermissions | null;
  /** active_project_id cookie (sessions) or the token's projectId. */
  activeProjectId?: string | null;
  legacy: { allowed: boolean; service: string; required?: string; level?: 'read' | 'write' | 'admin' };
}

/** An authenticated request to a path no permission service covers. */
export type UnmappedObservation = ObservationBase;
