'use client';

import { useCallback, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Button, Group, Loader, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconExternalLink } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import ResultDetail from '@/components/analysis/ResultDetail';
import { errorMessage } from '@/lib/api/client';
import { useAnalysisResult, useLoadAnalysisResults, useReviewAnalysisResult } from '@/lib/api/queries/analysis';

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

/** The queue keeps skipped ids in the URL so Skip moves forward instead of bouncing between two items. */
function parseSkipped(raw: string | null): string[] {
  return raw ? raw.split(',').filter(Boolean) : [];
}

export default function AnalysisResultDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const resultId = params?.id;
  const queueKey = searchParams?.get('queue') || null;
  const skippedParam = searchParams?.get('skipped') ?? null;

  const resultQuery = useAnalysisResult(resultId);
  const reviewResult = useReviewAnalysisResult();
  const loadResults = useLoadAnalysisResults();
  const data = resultQuery.data ?? null;
  // The previous item is not kept while the next loads, so a quick Save cannot post its draft to the next one.
  const loading = resultQuery.isPending;
  const notFound = resultQuery.isError;
  // Stays on until the queue has moved on, not only until the review is stored.
  const [saving, setSaving] = useState(false);

  const queueHref = queueKey ? `/dashboard/analysis/review?definition=${encodeURIComponent(queueKey)}` : '/dashboard/analysis/review';

  /** Open the next flagged result of the queue (lowest confidence first), or go back when it is empty. */
  const goNext = useCallback(async (skipped: string[]) => {
    if (!queueKey || !resultId) return;
    const exclude = new Set([resultId, ...skipped]);
    let page;
    try {
      page = await loadResults({
        definitionKey: queueKey,
        needsReview: true,
        sort: 'confidence',
        limit: Math.min(200, 2 + skipped.length),
      });
    } catch (err) {
      throw new Error(errorMessage(err, 'Could not load the next item'));
    }
    const next = page.results.find((r) => !exclude.has(r.id));
    if (!next) {
      notifications.show({ title: 'Queue is empty', message: 'Nothing left to review.', color: 'teal' });
      router.push(queueHref);
      return;
    }
    const nextQs = new URLSearchParams({ queue: queueKey });
    if (skipped.length > 0) nextQs.set('skipped', skipped.join(','));
    router.push(`/dashboard/analysis/results/${next.id}?${nextQs.toString()}`);
  }, [queueKey, resultId, router, queueHref, loadResults]);

  const onSave = async (values: Record<string, string | boolean>) => {
    if (!resultId) return;
    setSaving(true);
    try {
      await reviewResult.mutateAsync({ id: resultId, values });
      notifications.show({ title: 'Review saved', message: 'Your answers were recorded.', color: 'teal' });
      if (queueKey) {
        await goNext(parseSkipped(skippedParam));
      }
    } catch (err) {
      notifications.show({ title: 'Save failed', message: errorMessage(err, 'Save failed'), color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const onSkip = async () => {
    if (!resultId) return;
    try {
      await goNext([...parseSkipped(skippedParam), resultId]);
    } catch (err) {
      notifications.show({ title: 'Skip failed', message: errorMessage(err, 'Skip failed'), color: 'red' });
    }
  };

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push(queueHref)}>
      {queueKey ? 'Back to queue' : 'Back'}
    </Button>
  );

  if (loading && !data) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (notFound || !data) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Analysis" title="Result not found" actions={backButton} />
        <Text c="dimmed" size="sm">This analysis result could not be found.</Text>
      </PageContainer>
    );
  }

  const { result, source } = data;
  const subtitleParts = [
    result.agentKey ?? source.agentKey ?? null,
    source.messageCount !== undefined ? `${source.messageCount} messages` : null,
    `analyzed ${fmtDate(result.analyzedAt)}`,
  ].filter(Boolean);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Analysis · Result"
        title={source.title || result.title || 'Untitled session'}
        subtitle={
          <span>
            {subtitleParts.join(' · ')}{' '}
            {result.needsReview ? <span className="ds-badge ds-badge-warn">Needs review</span> : null}{' '}
            {result.reviewReason === 'spot_check' ? <span className="ds-badge">Spot-check</span> : null}{' '}
            {result.reviewed ? <span className="ds-badge ds-badge-teal">Reviewed</span> : null}
          </span>
        }
        actions={
          <Group gap="xs">
            {source.href ? (
              <Button variant="default" size="sm" leftSection={<IconExternalLink size={14} />} onClick={() => router.push(source.href!)}>
                Open session
              </Button>
            ) : null}
            {backButton}
          </Group>
        }
      />

      {/* Keyed by result so the draft answers reset when the queue moves on. */}
      <ResultDetail
        key={`${result.id}:${result.review?.at ?? ''}`}
        data={data}
        queue={!!queueKey}
        saving={saving}
        onSave={(values) => void onSave(values)}
        onSkip={() => void onSkip()}
      />
    </PageContainer>
  );
}
