'use client';

import { Skeleton } from '@mantine/core';
import {
  CardSkeleton,
  PageHeaderSkeleton,
  SkeletonRegion,
  SkeletonText,
  StatGridSkeleton,
  TableSkeleton,
  TabsSkeleton,
} from '@/components/common/ui/Skeletons';

/** Date filter (period select + range picker) as rendered in page headers. */
const DATE_FILTER_WIDTHS = [140, 220] as const;
const MODEL_COLUMN_COUNT = 8;

function UsageBlockBones({ rows }: { rows: number }) {
  return (
    <div
      style={{
        border: '1px solid var(--ds-border-soft)',
        borderRadius: 'var(--ds-r-sm)',
        padding: 14,
      }}
    >
      <div className="ds-row ds-gap-sm" style={{ marginBottom: 10 }}>
        <Skeleton width={26} height={26} radius="md" />
        <div className="ds-h4">
          <SkeletonText width={150} />
        </div>
      </div>
      <div className="ds-col" style={{ gap: 10 }}>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} style={{ fontSize: 12 }}>
            <SkeletonText width={`${88 - index * 9}%`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Body of the models "Usage analytics" card while its first load is pending. */
export function ModelUsageSkeleton() {
  return (
    <SkeletonRegion className="ds-col ds-gap-md">
      <StatGridSkeleton count={4} delta />
      <div className="ds-grid-two">
        <UsageBlockBones rows={5} />
        <UsageBlockBones rows={5} />
      </div>
    </SkeletonRegion>
  );
}

/** Route-level placeholder for `/dashboard/models`. */
export function ModelsListSkeleton() {
  return (
    <SkeletonRegion className="ds-page">
      <PageHeaderSkeleton actions={[...DATE_FILTER_WIDTHS, 150, 112]} titleWidth={140} />
      <StatGridSkeleton count={4} style={{ marginBottom: 16 }} />
      <div style={{ marginBottom: 16 }}>
        <TableSkeleton
          selectable
          columns={MODEL_COLUMN_COUNT}
          filters={[150, 160]}
          footer="pagination"
        />
      </div>
      <div className="ds-card ds-card-pad-lg">
        <div className="ds-row-between" style={{ marginBottom: 14 }}>
          <div>
            <div className="ds-h3">
              <SkeletonText width={150} />
            </div>
            <div style={{ fontSize: 12.5, marginTop: 2 }}>
              <SkeletonText width={260} />
            </div>
          </div>
          <Skeleton width={84} height={30} radius="sm" />
        </div>
        <ModelUsageSkeleton />
      </div>
    </SkeletonRegion>
  );
}

/**
 * Placeholder for `/dashboard/models/[id]`: mirrors the model header (icon,
 * name + badges, meta row, actions), the tab bar and the overview tab grid.
 */
export function ModelDetailSkeleton() {
  return (
    <SkeletonRegion className="ds-page">
      <div className="ds-page-header" style={{ alignItems: 'center' }}>
        <div className="ds-row ds-gap-md" style={{ flex: 1, minWidth: 0 }}>
          <Skeleton width={52} height={52} radius={12} style={{ flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 4,
              }}
            >
              <div className="ds-h2 ds-mono">
                <SkeletonText width={200} />
              </div>
              <Skeleton width={60} height={22} radius="xl" />
              <Skeleton width={44} height={22} radius="xl" />
            </div>
            <div style={{ fontSize: 12.5 }}>
              <SkeletonText width="clamp(160px, 32vw, 340px)" />
            </div>
          </div>
        </div>
        <div className="ds-row ds-gap-sm" style={{ flexShrink: 0 }}>
          <Skeleton width={34} height={34} radius="md" />
          <Skeleton width={104} height={36} radius="sm" />
          <Skeleton width={74} height={36} radius="sm" />
          <Skeleton width={34} height={34} radius="md" />
        </div>
      </div>

      <TabsSkeleton count={6} icons />

      <div
        className="ds-detail-grid"
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16 }}
      >
        <div className="ds-col ds-gap-md">
          <CardSkeleton lines={2} blockHeight={140} />
          <CardSkeleton lines={0} blockHeight={132} />
        </div>
        <div className="ds-col ds-gap-md">
          <CardSkeleton lines={8} />
          <CardSkeleton lines={2} />
        </div>
      </div>
    </SkeletonRegion>
  );
}
