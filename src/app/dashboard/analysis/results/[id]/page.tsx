'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Button, Group, Loader, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconExternalLink } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import ResultDetail from '@/components/analysis/ResultDetail';
import type { AnalysisResultDetailResponse, AnalysisResultRowView } from '@/components/analysis/types';

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

  const [data, setData] = useState<AnalysisResultDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!resultId) return;
    let cancelled = false;
    // Drop the previous item so a quick Save cannot post its draft to the next one.
    setData(null);
    setLoading(true);
    setNotFound(false);
    (async () => {
      try {
        const res = await fetch(`/api/analysis/results/${encodeURIComponent(resultId)}`, { cache: 'no-store' });
        if (cancelled) return;
        if (!res.ok) { setNotFound(true); return; }
        setData(await res.json());
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [resultId]);

  const queueHref = queueKey ? `/dashboard/analysis/review?definition=${encodeURIComponent(queueKey)}` : '/dashboard/analysis/review';

  /** Open the next flagged result of the queue (lowest confidence first), or go back when it is empty. */
  const goNext = useCallback(async (skipped: string[]) => {
    if (!queueKey || !resultId) return;
    const exclude = new Set([resultId, ...skipped]);
    const qs = new URLSearchParams({
      definitionKey: queueKey,
      needsReview: 'true',
      sort: 'confidence',
      limit: String(Math.min(200, 2 + skipped.length)),
    });
    const res = await fetch(`/api/analysis/results?${qs.toString()}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not load the next item');
    const next = ((body.results ?? []) as AnalysisResultRowView[]).find((r) => !exclude.has(r.id));
    if (!next) {
      notifications.show({ title: 'Queue is empty', message: 'Nothing left to review.', color: 'teal' });
      router.push(queueHref);
      return;
    }
    const nextQs = new URLSearchParams({ queue: queueKey });
    if (skipped.length > 0) nextQs.set('skipped', skipped.join(','));
    router.push(`/dashboard/analysis/results/${next.id}?${nextQs.toString()}`);
  }, [queueKey, resultId, router, queueHref]);

  const onSave = async (values: Record<string, string | boolean>) => {
    if (!resultId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/analysis/results/${encodeURIComponent(resultId)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not save the review');
      notifications.show({ title: 'Review saved', message: 'Your answers were recorded.', color: 'teal' });
      if (queueKey) {
        await goNext(parseSkipped(skippedParam));
      } else if (body.result) {
        setData((prev) => (prev ? { ...prev, result: body.result } : prev));
      }
    } catch (err) {
      notifications.show({ title: 'Save failed', message: err instanceof Error ? err.message : 'Save failed', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const onSkip = async () => {
    if (!resultId) return;
    try {
      await goNext([...parseSkipped(skippedParam), resultId]);
    } catch (err) {
      notifications.show({ title: 'Skip failed', message: err instanceof Error ? err.message : 'Skip failed', color: 'red' });
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
