'use client';

import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import {
  normalizeTracingStatus,
  tracingStatusBadgeKey,
  tracingStatusLabelId,
} from './sessionStatus';

/** A session / thread status as a badge, in the viewer's language; the single status look of the tracing pages. */
export default function SessionStatusBadge({ status }: { status?: string | null }) {
  const t = useTranslations('tracingHealth');
  const labelId = tracingStatusLabelId(status);
  const label = labelId ? t(`status.${labelId}`) : normalizeTracingStatus(status).replace(/_/g, ' ');
  return <StatusBadge status={tracingStatusBadgeKey(status)} label={label} />;
}
