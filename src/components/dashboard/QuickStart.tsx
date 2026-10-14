'use client';

import type { CSSProperties } from 'react';
import { Text } from '@mantine/core';
import { IconBrain, IconRobot, IconSparkles } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { CardLink } from './CardLink';
import type { QuickStartService, QuickStartTile } from './quickStartModel';

const ICONS: Record<QuickStartService, typeof IconBrain> = {
  models: IconBrain,
  prompts: IconSparkles,
  agents: IconRobot,
};

const TILE_STYLE: CSSProperties = { background: 'var(--ds-surface-1)', textAlign: 'left' };

/** Descriptions take two lines (clamped, space reserved), so tiles keep one height whatever the copy. */
const DESCRIPTION_STYLE: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.45,
  minHeight: `${1.45 * 2}em`,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
};

/**
 * "Get started": the first steps of a project, as links into the services the
 * person can open there (see quickStartModel). The caller decides whether there
 * is anything to show (`tiles` is empty when the person can open none of them).
 */
export function QuickStart({ tiles }: { tiles: readonly QuickStartTile[] }) {
  const t = useTranslations('dashboardOverview.quickStart');
  const locale = useLocale();
  if (tiles.length === 0) return null;
  return (
    <div className="ds-card ds-card-pad-lg" data-testid="quick-start" lang={locale}>
      <div className="ds-row-between" style={{ marginBottom: 14 }}>
        <div className="ds-h3">{t('title')}</div>
        <Text size="xs" c="dimmed">
          {t('subtitle')}
        </Text>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 12,
        }}
      >
        {tiles.map((tile) => {
          const Icon = ICONS[tile.service];
          return (
            <CardLink
              key={tile.service}
              href={tile.href}
              className="ds-card ds-card-pad-sm interactive"
              style={TILE_STYLE}
            >
              <div className="ds-row ds-gap-sm" style={{ marginBottom: 10 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'var(--ds-accent-soft)',
                    color: 'var(--ds-accent)',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  <Icon size={16} stroke={1.7} />
                </div>
                <span className="ds-eyebrow">{t('step', { number: tile.step })}</span>
              </div>
              <div className="ds-h4" style={{ marginBottom: 4 }}>
                {t(`steps.${tile.service}.title`)}
              </div>
              <div className="ds-muted" style={DESCRIPTION_STYLE}>
                {t(`steps.${tile.service}.description`)}
              </div>
            </CardLink>
          );
        })}
      </div>
    </div>
  );
}
