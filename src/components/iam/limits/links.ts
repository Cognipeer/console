/**
 * Deep links into the Limits tab (pure: no React / Next imports).
 *
 *   /dashboard/iam?tab=limits&new=1&principalType=group&principalId=<groupId>[&domain=agent][&groupMode=shared][&projectId=<id>]
 *
 * opens the limit editor on a NEW limit for that person / group / API token —
 * what the Principals tab links to from its "Add limit" button. `principalType`
 * and `principalId` are named like the Policies tab's links so one screen can
 * offer both.
 */
import { QUOTA_DOMAINS, QUOTA_GROUP_MODES, QUOTA_SCOPES, type QuotaDomain, type QuotaGroupMode, type QuotaScope } from '@/lib/quota/types';
import { iamHref, type ParamReader } from '../links';

export type LimitPrincipalType = 'user' | 'group' | 'token';

export interface NewLimitLinkParams {
  principalType?: LimitPrincipalType;
  principalId?: string;
  domain?: QuotaDomain;
  groupMode?: QuotaGroupMode;
  projectId?: string;
}

export function newLimitHref(params: NewLimitLinkParams = {}): string {
  return iamHref('limits', {
    new: '1',
    principalType: params.principalId ? params.principalType : undefined,
    principalId: params.principalId,
    domain: params.domain,
    groupMode: params.principalType === 'group' ? params.groupMode : undefined,
    projectId: params.projectId,
  });
}

/** What the editor starts from. */
export interface LimitSeed {
  scope?: QuotaScope;
  scopeId?: string;
  domain?: QuotaDomain;
  groupMode?: QuotaGroupMode;
  projectId?: string;
}

export interface LimitLink {
  /** `new=1`: open the editor on a new limit. */
  isNew: boolean;
  seed: LimitSeed;
}

const nonEmpty = (value: string | null): string | undefined => (value && value.trim() !== '' ? value.trim() : undefined);

export function parseLimitLink(params: ParamReader): LimitLink {
  const isNew = params.get('new') === '1' || params.get('new') === 'true';

  // `scope` / `scopeId` say it in the quota API's own words and win over the
  // IAM-center spelling (`principalType` / `principalId`).
  const scopeParam = nonEmpty(params.get('scope'));
  const principalType = nonEmpty(params.get('principalType'));
  const scope = (scopeParam && (QUOTA_SCOPES as readonly string[]).includes(scopeParam)
    ? scopeParam
    : principalType === 'user' || principalType === 'group' || principalType === 'token'
      ? principalType
      : undefined) as QuotaScope | undefined;
  const scopeId = nonEmpty(params.get('scopeId')) ?? nonEmpty(params.get('principalId'));

  const domain = nonEmpty(params.get('domain'));
  const groupMode = nonEmpty(params.get('groupMode'));
  const projectId = nonEmpty(params.get('projectId'));

  return {
    isNew,
    seed: {
      ...(scope ? { scope } : {}),
      ...(scope && scope !== 'tenant' && scopeId ? { scopeId } : {}),
      ...(domain && (QUOTA_DOMAINS as readonly string[]).includes(domain) ? { domain: domain as QuotaDomain } : {}),
      ...(scope === 'group' && groupMode && (QUOTA_GROUP_MODES as readonly string[]).includes(groupMode)
        ? { groupMode: groupMode as QuotaGroupMode }
        : {}),
      ...(projectId ? { projectId } : {}),
    },
  };
}
