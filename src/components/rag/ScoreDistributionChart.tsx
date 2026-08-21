'use client';

import { useMemo } from 'react';
import { Center, Loader, Text } from '@mantine/core';
import { BarChart } from '@mantine/charts';

export interface ScoreBucket {
  bucket: string;
  count: number;
}

interface ScoreDistributionChartProps {
  buckets: ScoreBucket[];
  /** The module's current minimum score, drawn as the cut-off marker. */
  minScore: number;
  loading?: boolean;
}

/**
 * Best-score-per-query histogram, split at the module's minimum score.
 *
 * The split is the point of the chart: everything left of the marker is a query
 * whose matches the threshold threw away, which is what makes the min-score
 * slider settable against the module's real distribution instead of guessed at.
 * Position carries the split as well as colour, so the two classes stay
 * distinguishable without relying on hue.
 */
export default function ScoreDistributionChart({
  buckets,
  minScore,
  loading,
}: ScoreDistributionChartProps) {
  const { data, belowCount, total, peak, markerBucket } = useMemo(() => {
    // A histogram only reads left-to-right if it is ordered; the aggregation
    // makes no promise about the order it returns its buckets in.
    const ordered = [...buckets].sort((a, b) => Number(a.bucket) - Number(b.bucket));

    // The marker sits on the lowest bucket the threshold still keeps. With no
    // such bucket there is nothing on the axis to anchor it to.
    const kept = ordered.find((entry) => Number(entry.bucket) >= minScore);

    const rows = ordered.map((entry) => {
      const below = Number(entry.bucket) < minScore;
      return {
        bucket: entry.bucket,
        above: below ? 0 : entry.count,
        below: below ? entry.count : 0,
      };
    });

    return {
      data: rows,
      belowCount: rows.reduce((sum, row) => sum + row.below, 0),
      total: ordered.reduce((sum, entry) => sum + entry.count, 0),
      peak: ordered.reduce<ScoreBucket | null>(
        (best, entry) => (best === null || entry.count > best.count ? entry : best),
        null,
      ),
      markerBucket: kept?.bucket,
    };
  }, [buckets, minScore]);

  if (loading) {
    return <Center h={240}><Loader size="sm" color="violet" /></Center>;
  }

  if (total === 0) {
    return (
      <Center h={240}>
        <Text size="sm" c="dimmed">No scored queries yet — run a few searches to see the distribution.</Text>
      </Center>
    );
  }

  return (
    <>
      <BarChart
        h={240}
        data={data}
        dataKey="bucket"
        type="stacked"
        series={[
          { name: 'below', label: `Below ${minScore.toFixed(2)}`, color: 'gray.6' },
          { name: 'above', label: `Kept at ${minScore.toFixed(2)}`, color: 'violet.6' },
        ]}
        referenceLines={
          markerBucket !== undefined && minScore > 0
            ? [{ x: markerBucket, color: 'gray.7', label: `min ${minScore.toFixed(2)}` }]
            : undefined
        }
        barProps={{ radius: [4, 4, 0, 0] }}
        gridAxis="y"
        withLegend
        xAxisLabel="Best score of the query"
        yAxisLabel="Queries"
        tooltipAnimationDuration={200}
      />
      <Text size="xs" c="dimmed" mt="xs">
        {belowCount} of {total} logged queries landed in a bucket below the current
        {' '}{minScore.toFixed(2)} minimum
        {peak ? `; the commonest score is around ${peak.bucket}` : ''}.
      </Text>
    </>
  );
}
