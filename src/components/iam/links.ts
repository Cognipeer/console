/**
 * Deep links of the IAM center. One place builds and reads them so every tab
 * (and any other screen) links the same way.
 *
 *   /dashboard/iam?tab=check&decisionId=<id>
 *   /dashboard/iam?tab=check&principalType=user|token&principalId=<id>&action=<action>
 *   /dashboard/iam?tab=policies&new=1[&principalType=user|group|token&principalId=<id>]
 *   /dashboard/iam?tab=policies&policyId=<id>          (opens that policy)
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

// ── Access check ─────────────────────────────────────────────────────────

export interface CheckLinkParams {
  decisionId?: string;
  principalType?: 'user' | 'token';
  principalId?: string;
  action?: string;
}

export function checkHref(params: CheckLinkParams): string {
  if (params.decisionId) return iamHref('check', { decisionId: params.decisionId });
  return iamHref('check', {
    principalType: params.principalType,
    principalId: params.principalId,
    action: params.action,
  });
}

export function parseCheckParams(params: ParamReader): CheckLinkParams {
  const type = params.get('principalType');
  return {
    decisionId: nonEmpty(params.get('decisionId')),
    principalType: type === 'user' || type === 'token' ? type : undefined,
    principalId: nonEmpty(params.get('principalId')),
    action: nonEmpty(params.get('action')),
  };
}

// ── Policies ─────────────────────────────────────────────────────────────

export interface NewPolicyLinkParams {
  principalType?: IamPrincipalType;
  principalId?: string;
}

export function newPolicyHref(params: NewPolicyLinkParams = {}): string {
  return iamHref('policies', {
    new: '1',
    principalType: params.principalId ? params.principalType : undefined,
    principalId: params.principalId,
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
}

export function parsePolicyParams(params: ParamReader): PolicyLinkParams {
  const type = params.get('principalType');
  const principalType = type === 'user' || type === 'group' || type === 'token' ? type : undefined;
  const principalId = nonEmpty(params.get('principalId'));
  return {
    isNew: params.get('new') === '1' || params.get('new') === 'true',
    policyId: nonEmpty(params.get('policyId')),
    principalType: principalId ? principalType : undefined,
    principalId: principalType ? principalId : undefined,
  };
}
