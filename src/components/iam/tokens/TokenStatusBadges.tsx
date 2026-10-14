'use client';

import { Tooltip } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { tokenStatuses, type ApiTokenRow, type TokenStatusKind } from './tokenModel';

const BADGE_CLASS: Record<TokenStatusKind, string> = {
  expired: 'ds-badge ds-badge-err',
  exceedsPolicy: 'ds-badge ds-badge-warn',
  unused: 'ds-badge',
  ipRestricted: 'ds-badge ds-badge-info',
};

/** The status badges of a token row: expired, outside the tenant policy, unused for 30+ days, IP restricted. */
export default function TokenStatusBadges({ token, now }: { token: ApiTokenRow; now?: number }) {
  const t = useTranslations('iamTokens');
  const kinds = tokenStatuses(token, now);
  if (kinds.length === 0) return null;

  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {kinds.map((kind) => (
        <Tooltip
          key={kind}
          multiline
          w={260}
          withArrow
          label={t(`statusHint.${kind}`, { count: token.allowedIpRangeCount ?? token.allowedIpRanges?.length ?? 0 })}
        >
          <span className={BADGE_CLASS[kind]}>{t(`status.${kind}`)}</span>
        </Tooltip>
      ))}
    </span>
  );
}
