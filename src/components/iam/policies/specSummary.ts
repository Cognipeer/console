/**
 * Plain-language description of a policy spec: who, what, where, when. Used by
 * the policies table, the read-only drawer and the editor's summary pane.
 * Pure: the translator and the id -> name maps come from the caller.
 */

import type { PolicySpec } from '../api';
import type { IamLabels, TranslateFn } from '../useIamLabels';
import { summarizeSpec } from './specModel';

export interface SpecLines {
  who: string;
  what: string;
  where: string;
  /** `null` when the policy has no condition. */
  when: string | null;
}

export interface SummaryContext {
  /** Translator namespaced to `iamCenter`. */
  t: TranslateFn;
  labels: IamLabels;
  groupNames?: ReadonlyMap<string, string>;
  /** Known names of users / tokens (the editor has them; tables usually do not and show counts). */
  userNames?: ReadonlyMap<string, string>;
  tokenNames?: ReadonlyMap<string, string>;
  projectNames?: ReadonlyMap<string, string>;
  /** How many names are listed before "+N" (default 3). */
  maxNames?: number;
  formatDate?: (iso: string) => string;
}

export function listWithMore(items: readonly string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max}`;
}

const defaultDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function describeSpec(spec: PolicySpec, ctx: SummaryContext): SpecLines {
  const { t, labels } = ctx;
  const max = ctx.maxNames ?? 3;
  const date = ctx.formatDate ?? defaultDate;
  const s = summarizeSpec(spec);

  // who
  const who: string[] = [];
  if (s.whoAny) {
    who.push(t('summary.everyone'));
  } else {
    if (s.anyUser) who.push(t('summary.anyUser'));
    if (s.anyToken) who.push(t('summary.anyToken'));
    if (s.groupIds.length > 0) {
      const names = s.groupIds.map((id) => ctx.groupNames?.get(id)).filter((x): x is string => !!x);
      who.push(
        names.length === s.groupIds.length
          ? t('summary.groups', { names: listWithMore(names, max) })
          : t('summary.groupsCount', { count: s.groupIds.length }),
      );
    }
    if (s.userIds.length > 0) {
      const names = s.userIds.map((id) => ctx.userNames?.get(id)).filter((x): x is string => !!x);
      who.push(
        names.length === s.userIds.length
          ? t('summary.users', { names: listWithMore(names, max) })
          : t('summary.usersCount', { count: s.userIds.length }),
      );
    }
    if (s.tokenIds.length > 0) {
      const names = s.tokenIds.map((id) => ctx.tokenNames?.get(id)).filter((x): x is string => !!x);
      who.push(
        names.length === s.tokenIds.length
          ? t('summary.tokens', { names: listWithMore(names, max) })
          : t('summary.tokensCount', { count: s.tokenIds.length }),
      );
    }
  }

  // what
  const what = listWithMore(s.actions.map((id) => labels.action(id)), max);

  // where
  const where: string[] = [];
  if (s.whereMode === 'any') {
    where.push(t('summary.whereAny'));
  } else {
    if (s.services.length > 0) {
      where.push(t('summary.whereServices', { names: listWithMore(s.services.map((id) => labels.service(id)), max) }));
    }
    if (s.projects.length > 0) {
      const names = s.projects.map((id) => ctx.projectNames?.get(id)).filter((x): x is string => !!x);
      where.push(
        names.length === s.projects.length
          ? t('summary.whereProjects', { names: listWithMore(names, max) })
          : t('summary.whereProjectsCount', { count: s.projects.length }),
      );
    }
    if (s.resources.length > 0) {
      where.push(t('summary.whereResources', { count: s.resources.length }));
    }
  }

  // when
  const when: string[] = [];
  if (s.validFrom) when.push(t('summary.from', { date: date(s.validFrom) }));
  if (s.validUntil) when.push(t('summary.until', { date: date(s.validUntil) }));
  if (s.ipRanges.length > 0) when.push(t('summary.ip', { ranges: listWithMore(s.ipRanges, 2) }));
  if (s.channels.length > 0) {
    when.push(t('summary.channels', { names: s.channels.map((c) => labels.channel(c)).join(', ') }));
  }

  return {
    who: who.join(' · '),
    what,
    where: where.join(' · '),
    when: when.length > 0 ? when.join(' · ') : null,
  };
}
