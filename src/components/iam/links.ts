/**
 * Deep links of the IAM center. One place builds and reads them so every tab
 * (and any other screen) links the same way.
 *
 *   /dashboard/iam?tab=check&decisionId=<id>
 *   /dashboard/iam?tab=check&principalType=user|token&principalId=<id>&action=<action>
 *   /dashboard/iam?tab=policies&new=1[&principalType=user|group|token&principalId=<id>]
 *   /dashboard/iam?tab=policies&policyId=<id>          (opens that policy)
 *
 * and the places OUTSIDE the center where a setting that decides access is
 * changed (a person's workspace role, a project member's project limits, a token).
 *
 * Pure module (no React / Next imports).
 */

import type { IamPrincipalType } from './api';

export const IAM_PATH = '/dashboard/iam';

export const IAM_TAB_IDS = [
  'overview',
  'policies',
  'principals',
  'check',
  'audit',
  'limits',
  'settings',
] as const;

export type IamTabId = (typeof IAM_TAB_IDS)[number];

export const DEFAULT_IAM_TAB: IamTabId = 'overview';

export function isIamTabId(value: unknown): value is IamTabId {
  return typeof value === 'string' && (IAM_TAB_IDS as readonly string[]).includes(value);
}

export function parseTabId(raw: string | null | undefined): IamTabId {
  return isIamTabId(raw) ? raw : DEFAULT_IAM_TAB;
}

/** Anything with `get(name)`: `URLSearchParams`, Next's `ReadonlyURLSearchParams`. */
export interface ParamReader {
  get(name: string): string | null;
}

type ParamValues = Record<string, string | null | undefined>;

export function iamHref(tab: IamTabId, params: ParamValues = {}): string {
  const search = new URLSearchParams();
  search.set('tab', tab);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  return `${IAM_PATH}?${search.toString()}`;
}

const nonEmpty = (v: string | null): string | undefined => (v && v.trim() !== '' ? v.trim() : undefined);

// ── Where access settings are changed (outside the center) ────────────────

/** A person's drawer in the IAM center (Principals tab): workspace role, access, groups, projects and tokens. */
export function memberHref(userId: string): string {
  return iamHref('principals', { principalType: 'user', principalId: userId });
}

/**
 * A project's page, on its Users tab. With `memberId` the project permission
 * editor of that member opens straight away.
 */
export function projectMembersHref(projectId: string, memberId?: string | null): string {
  const base = `/dashboard/projects/${encodeURIComponent(projectId)}`;
  return memberId ? `${base}?member=${encodeURIComponent(memberId)}` : base;
}

/** The personal API tokens page: the signed-in person's own tokens (everyone else's are managed in the IAM center). */
export const TOKENS_HREF = '/dashboard/tokens';

/** The account page of the signed-in person (profile, password, link to their tokens). */
export const ACCOUNT_HREF = '/dashboard/account';

/** A portal's page, where its access list is edited. */
export function portalHref(portalId: string): string {
  return `/dashboard/portals/${encodeURIComponent(portalId)}`;
}

// ── Access check ─────────────────────────────────────────────────────────

export interface CheckLinkParams {
  decisionId?: string;
  principalType?: 'user' | 'token';
  principalId?: string;
  action?: string;
  /** What the action is about: a registry resource (a portal for `portal.use`, an agent for `agent.invoke`). */
  resourceType?: string;
  resourceId?: string;
  /** Display name of the resource, so the picker does not show a bare id. */
  resourceLabel?: string;
  channel?: 'dashboard' | 'api' | 'portal';
  /** The portal an agent is run through (`agent.invoke` in the portal channel). */
  portalId?: string;
  portalLabel?: string;
}

export function checkHref(params: CheckLinkParams): string {
  if (params.decisionId) return iamHref('check', { decisionId: params.decisionId });
  return iamHref('check', {
    principalType: params.principalType,
    principalId: params.principalId,
    action: params.action,
    resourceType: params.resourceId ? params.resourceType : undefined,
    resourceId: params.resourceType ? params.resourceId : undefined,
    resourceLabel: params.resourceId ? params.resourceLabel : undefined,
    channel: params.channel,
    portalId: params.portalId,
    portalLabel: params.portalId ? params.portalLabel : undefined,
  });
}

export function parseCheckParams(params: ParamReader): CheckLinkParams {
  const type = params.get('principalType');
  const channel = params.get('channel');
  const resourceType = nonEmpty(params.get('resourceType'));
  const resourceId = nonEmpty(params.get('resourceId'));
  return {
    decisionId: nonEmpty(params.get('decisionId')),
    principalType: type === 'user' || type === 'token' ? type : undefined,
    principalId: nonEmpty(params.get('principalId')),
    action: nonEmpty(params.get('action')),
    resourceType: resourceId ? resourceType : undefined,
    resourceId: resourceType ? resourceId : undefined,
    resourceLabel: resourceType && resourceId ? nonEmpty(params.get('resourceLabel')) : undefined,
    channel: channel === 'dashboard' || channel === 'api' || channel === 'portal' ? channel : undefined,
    portalId: nonEmpty(params.get('portalId')),
    portalLabel: nonEmpty(params.get('portalId')) ? nonEmpty(params.get('portalLabel')) : undefined,
  };
}

// ── Policies ─────────────────────────────────────────────────────────────

export interface NewPolicyLinkParams {
  principalType?: IamPrincipalType;
  principalId?: string;
  /** A resource the new rule is about (a portal: "block someone from this portal"); the editor presets the rule for its kind. */
  resourceType?: string;
  resourceId?: string;
  resourceLabel?: string;
}

export function newPolicyHref(params: NewPolicyLinkParams = {}): string {
  return iamHref('policies', {
    new: '1',
    principalType: params.principalId ? params.principalType : undefined,
    principalId: params.principalId,
    resourceType: params.resourceId ? params.resourceType : undefined,
    resourceId: params.resourceType ? params.resourceId : undefined,
    resourceLabel: params.resourceType && params.resourceId ? params.resourceLabel : undefined,
  });
}

export function policyHref(policyId: string): string {
  return iamHref('policies', { policyId });
}

export interface PolicyLinkParams {
  isNew: boolean;
  policyId?: string;
  principalType?: IamPrincipalType;
  principalId?: string;
  resourceType?: string;
  resourceId?: string;
  resourceLabel?: string;
}

export function parsePolicyParams(params: ParamReader): PolicyLinkParams {
  const type = params.get('principalType');
  const principalType = type === 'user' || type === 'group' || type === 'token' ? type : undefined;
  const principalId = nonEmpty(params.get('principalId'));
  const resourceType = nonEmpty(params.get('resourceType'));
  const resourceId = nonEmpty(params.get('resourceId'));
  return {
    isNew: params.get('new') === '1' || params.get('new') === 'true',
    policyId: nonEmpty(params.get('policyId')),
    principalType: principalId ? principalType : undefined,
    principalId: principalType ? principalId : undefined,
    resourceType: resourceId ? resourceType : undefined,
    resourceId: resourceType ? resourceId : undefined,
    resourceLabel: resourceType && resourceId ? nonEmpty(params.get('resourceLabel')) : undefined,
  };
}
