'use client';

import type { CSSProperties } from 'react';
import { Group, Skeleton, Stack } from '@mantine/core';
import { PageHeaderSkeleton, SkeletonRegion, SkeletonText } from '@/components/common/ui/Skeletons';

/*
 * Placeholders for the dashboard home. They mirror the real card structure (same classes, paddings, grids and
 * Mantine text sizes) so the page can swap regions in place without moving its neighbours.
 */

const TILE_CARD: CSSProperties = { background: 'var(--ds-surface-1)' };

function IconBone({ size = 32 }: { size?: number }) {
  return <Skeleton width={size} height={size} radius={8} style={{ flexShrink: 0 }} />;
}

/** A card's heading (`ds-h3`). */
function CardHeaderBones({ titleWidth = 150, marginBottom = 14 }: { titleWidth?: number; marginBottom?: number }) {
  return (
    <div className="ds-h3" style={{ marginBottom }}>
      <SkeletonText width={titleWidth} />
    </div>
  );
}

function ServiceTileBones() {
  return (
    <div className="ds-card ds-card-pad-sm" style={TILE_CARD}>
      <div className="ds-row ds-gap-sm" style={{ marginBottom: 8 }}>
        <IconBone />
        <div style={{ minWidth: 0, flex: 1, fontSize: 13 }}>
          <SkeletonText width="70%" />
        </div>
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.4 }}>
        <div>
          <SkeletonText width="92%" />
        </div>
        <div>
          <SkeletonText width="58%" />
        </div>
      </div>
    </div>
  );
}

/** The home's "Your services" card while the services opened last are restored. */
export function HomeServicesSkeleton({ count = 6 }: { count?: number }) {
  return (
    <SkeletonRegion className="ds-card ds-card-pad-lg" style={{ marginBottom: 16 }}>
      <CardHeaderBones titleWidth={130} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
          gap: 10,
        }}
      >
        {Array.from({ length: count }, (_, index) => (
          <ServiceTileBones key={index} />
        ))}
      </div>
    </SkeletonRegion>
  );
}

const ACTIVITY_TEXT_WIDTHS = ['88%', '74%', '92%', '68%', '84%', '78%'];

/** Rows of the home's recent agent sessions while their first load is pending. */
export function ActivityListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <SkeletonRegion>
      <Stack gap="xs">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="ds-row" style={{ gap: 10, padding: '4px 0', fontSize: 13 }}>
            <Skeleton width={26} height={26} circle style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
              <div>
                <SkeletonText width={ACTIVITY_TEXT_WIDTHS[index % ACTIVITY_TEXT_WIDTHS.length]} />
              </div>
              <div>
                <SkeletonText width="46%" />
              </div>
            </div>
            <Skeleton width={58} height={22} radius="xl" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 11.5 }}>
              <SkeletonText width={40} />
            </span>
          </div>
        ))}
      </Stack>
    </SkeletonRegion>
  );
}

/** Route-level placeholder for `/dashboard/overview` (the home). */
export function OverviewSkeleton() {
  return (
    <SkeletonRegion className="ds-page">
      <PageHeaderSkeleton eyebrow={false} actions={0} titleWidth={300} subtitleWidth={180} />
      <div className="ds-card ds-card-pad-lg" style={{ marginBottom: 16 }}>
        <CardHeaderBones titleWidth={220} marginBottom={12} />
        <Group gap={6} mb={18}>
          {[92, 132, 104, 120].map((width) => (
            <Skeleton key={width} width={width} height={26} radius="xl" />
          ))}
        </Group>
        <ActivityListSkeleton rows={3} />
      </div>
      <HomeServicesSkeleton />
    </SkeletonRegion>
  );
}
