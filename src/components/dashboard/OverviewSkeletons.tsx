'use client';

import type { CSSProperties } from 'react';
import { Group, Skeleton, Stack, Text } from '@mantine/core';
import {
  PageHeaderSkeleton,
  SkeletonRegion,
  SkeletonText,
  StatGridSkeleton,
} from '@/components/common/ui/Skeletons';

/*
 * Placeholders for the community Overview page. They mirror the real card
 * structure (same classes, paddings, grids and Mantine text sizes) so the
 * page can swap regions in place without moving its neighbours.
 */

const TWO_COLUMN_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
  gap: 16,
};

const TILE_CARD: CSSProperties = { background: 'var(--ds-surface-1)' };

function IconBone({ size = 32 }: { size?: number }) {
  return <Skeleton width={size} height={size} radius={8} style={{ flexShrink: 0 }} />;
}

function CardHeaderBones({
  titleWidth = 150,
  subtitle = false,
  action,
  actionWidth = 90,
  marginBottom = 14,
}: {
  titleWidth?: number;
  subtitle?: boolean;
  action?: 'button' | 'text';
  /** Width of the `xs` header button (28px tall). */
  actionWidth?: number;
  marginBottom?: number;
}) {
  return (
    <div className="ds-row-between" style={{ marginBottom }}>
      <div>
        <div className="ds-h3">
          <SkeletonText width={titleWidth} />
        </div>
        {subtitle ? (
          <div style={{ fontSize: 12.5, marginTop: 2 }}>
            <SkeletonText width={190} />
          </div>
        ) : null}
      </div>
      {action === 'button' ? <Skeleton width={actionWidth} height={28} radius="md" /> : null}
      {action === 'text' ? (
        <Text size="xs" component="div">
          <SkeletonText width={150} />
        </Text>
      ) : null}
    </div>
  );
}

function ServiceTileBones() {
  return (
    <div className="ds-card ds-card-pad-sm" style={TILE_CARD}>
      <div className="ds-row ds-gap-sm" style={{ marginBottom: 8 }}>
        <IconBone />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13 }}>
            <SkeletonText width="70%" />
          </div>
          <div style={{ fontSize: 10.5 }}>
            <SkeletonText width="40%" />
          </div>
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

/** Tiles of the "Your services" grid (pinned services + "Add service"). */
export function PinnedServiceTilesSkeleton({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <ServiceTileBones key={index} />
      ))}
      {/* "Add service": one line of `Text size="sm"`, centred. */}
      <div
        className="ds-card ds-card-pad-sm"
        style={{
          background: 'transparent',
          borderStyle: 'dashed',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Text size="sm" component="div">
          <SkeletonText width={96} />
        </Text>
      </div>
    </>
  );
}

/** "Your services" card while launcher preferences are restored. */
export function PinnedServicesSkeleton({ count = 6 }: { count?: number }) {
  return (
    <SkeletonRegion className="ds-card ds-card-pad-lg" style={{ marginBottom: 16 }}>
      <CardHeaderBones subtitle action="button" actionWidth={95} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
          gap: 10,
        }}
      >
        <PinnedServiceTilesSkeleton count={count} />
      </div>
    </SkeletonRegion>
  );
}

const ACTIVITY_TEXT_WIDTHS = ['88%', '74%', '92%', '68%', '84%', '78%'];

/** Rows of the Overview "Activity" card while its first load is pending. */
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

function ResourceRowBones() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        border: '1px solid var(--ds-border-soft)',
        borderRadius: 'var(--ds-r-sm)',
      }}
    >
      <IconBone />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" component="div">
          <SkeletonText width="42%" />
        </Text>
        <Text size="xs" component="div">
          <SkeletonText width="64%" />
        </Text>
      </div>
      <Text size="lg" component="div">
        <SkeletonText width={28} />
      </Text>
    </div>
  );
}

/** Route-level placeholder for `/dashboard/overview`. */
export function OverviewSkeleton() {
  return (
    <SkeletonRegion className="ds-page">
      <PageHeaderSkeleton actions={[140, 220, 140]} titleWidth={300} />
      <StatGridSkeleton count={4} spark style={{ marginBottom: 16 }} />
      <PinnedServicesSkeleton />

      <div className="ds-grid-two" style={TWO_COLUMN_GRID}>
        <div className="ds-card ds-card-pad-lg">
          <CardHeaderBones titleWidth={170} action="button" actionWidth={140} marginBottom={12} />
          <ActivityListSkeleton rows={5} />
        </div>
        <div className="ds-card ds-card-pad-lg">
          <CardHeaderBones titleWidth={100} marginBottom={12} />
          <Stack gap="xs">
            <ResourceRowBones />
            <ResourceRowBones />
            <Group gap={8} mt={4}>
              <Text size="xs" component="div">
                <SkeletonText width={44} />
              </Text>
              <Skeleton width={72} height={18} radius="xl" />
            </Group>
          </Stack>
        </div>
      </div>
    </SkeletonRegion>
  );
}
