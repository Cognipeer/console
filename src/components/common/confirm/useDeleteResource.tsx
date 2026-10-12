'use client';

import { useCallback, type ReactNode } from 'react';
import { Stack, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import ResourceUsagePanel from '@/components/resources/ResourceUsagePanel';
import { tryTranslate } from '@/components/resources/i18nLookup';
import { useConfirm, type ConfirmOptions } from './ConfirmProvider';
import {
  fetchResourceUsage,
  groupByImpact,
  needsTypedConfirmation,
  totalUses,
  typedConfirmationText,
  ResourceUsageError,
  type ImpactGroup,
  type ResourceUsageResponse,
} from './resourceUsage';

export interface DeleteResourceOptions {
  /** i18n'd label of WHAT is deleted ("agent", "tool"...), used in the title and the usage sentence. */
  noun: string;
  /** Display name of the resource; also what the user types when dependents would fail. */
  name?: string | null;
  /** Registry type id (e.g. 'agent', 'tool', 'mcp-server'); with `id` it enables the used-by check. */
  type?: string;
  id?: string;
  /** Performs the delete. Throw to keep the dialog open with the error; resolve = success. */
  action: () => Promise<void>;
  /** Extra warning shown in the dialog (e.g. "its sessions and files are deleted too"). */
  extraWarning?: ReactNode;
  /** Overrides the delete button label. */
  confirmLabel?: ReactNode;
}

function useTypeLabel() {
  const t = useTranslations('resources');
  return (type: string) => tryTranslate(t, `types.${type}`) ?? type;
}

/**
 * The unified delete confirmation. With `type` + `id` it first asks
 * GET /api/resource-usage/:type/:id (spinner inside the dialog) and shows where
 * the resource is used and what would break; without them it is a plain danger
 * confirm. A failed usage lookup never blocks the delete.
 */
export function useDeleteResource(): (options: DeleteResourceOptions) => Promise<boolean> {
  const { confirmAction } = useConfirm();
  const t = useTranslations('common.confirm');
  const typeLabel = useTypeLabel();

  return useCallback(
    (opts: DeleteResourceOptions) => {
      const name = opts.name?.trim() || null;
      const base: ConfirmOptions = {
        title: t('deleteDialog.title', { noun: opts.noun }),
        message: (
          <Stack gap={6}>
            <span>
              {name
                ? t('deleteDialog.message', { name })
                : t('deleteDialog.messageNoName', { noun: opts.noun })}
            </span>
            {opts.extraWarning ? <span>{opts.extraWarning}</span> : null}
          </Stack>
        ),
        tone: 'danger',
        confirmLabel: opts.confirmLabel ?? t('delete'),
      };

      const checkable = Boolean(opts.type && opts.id);
      const options: ConfirmOptions = checkable
        ? {
            ...base,
            prepareLabel: t('deleteDialog.checking'),
            prepare: async () => {
              const usage = await fetchResourceUsage(opts.type as string, opts.id as string);
              return describeUsage(usage, {
                noun: opts.noun,
                fallbackName: name,
                t,
                typeLabel,
              });
            },
            onPrepareError: (error) => ({
              // 404: the resource is gone or not ours to inspect; nothing worth warning about.
              details:
                error instanceof ResourceUsageError && error.status === 404 ? undefined : (
                  <Text size="sm" c="dimmed">{t('deleteDialog.usageUnavailable')}</Text>
                ),
            }),
          }
        : base;

      return confirmAction({ ...options, action: opts.action });
    },
    [confirmAction, t, typeLabel],
  );
}

type Translate = (key: string, values?: Record<string, string | number | undefined | null>) => string;

function formatGroups(groups: ImpactGroup[], typeLabel: (type: string) => string): string {
  return groups.map((g) => `${typeLabel(g.type)} (${g.count})`).join(', ');
}

/** The dialog content derived from a usage response. Exported for tests of the wording rules. */
export function describeUsage(
  usage: ResourceUsageResponse,
  ctx: { noun: string; fallbackName: string | null; t: Translate; typeLabel: (type: string) => string },
): Partial<ConfirmOptions> {
  const { t, typeLabel, noun } = ctx;
  const total = totalUses(usage);
  if (total === 0) return {};

  const failing = groupByImpact(usage, 'error');
  const degrading = groupByImpact(usage, 'warning');
  const typed = needsTypedConfirmation(usage);
  const visibleImpacted = [...failing, ...degrading].reduce((sum, g) => sum + g.count, 0);
  // Dependents the caller cannot see still count toward the severity summary.
  const hiddenImpacted = usage.summary.error + usage.summary.warning - visibleImpacted;

  const details = (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {total === 1
          ? t('deleteDialog.usedInOne', { noun })
          : t('deleteDialog.usedInMany', { noun, count: total })}
      </Text>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        <ResourceUsagePanel usedBy={usage.usedBy} compact hideUses />
      </div>
      {usage.usedByTruncated ? <Text size="xs" c="dimmed">{t('deleteDialog.truncated')}</Text> : null}
      {usage.hiddenUsedByCount > 0 ? (
        <Text size="sm" c="dimmed">{t('deleteDialog.hiddenUses', { count: usage.hiddenUsedByCount })}</Text>
      ) : null}
      {failing.length > 0 ? (
        <Text size="sm" fw={500} style={{ color: 'var(--ds-err, #c93b3b)' }}>
          {t('deleteDialog.willFail', { list: formatGroups(failing, typeLabel) })}
        </Text>
      ) : null}
      {degrading.length > 0 ? (
        <Text size="sm" fw={500} style={{ color: 'var(--ds-warn, #b7791f)' }}>
          {t('deleteDialog.willDegrade', { list: formatGroups(degrading, typeLabel) })}
        </Text>
      ) : null}
      {hiddenImpacted > 0 ? (
        <Text size="xs" c="dimmed">{t('deleteDialog.hiddenMayBreak')}</Text>
      ) : null}
      {typed ? <Text size="sm">{t('deleteDialog.typedRequired')}</Text> : null}
    </Stack>
  );

  const requireTypedText = typed
    ? typedConfirmationText({ name: ctx.fallbackName ?? usage.resource.name, key: usage.resource.key, id: usage.resource.id })
    : undefined;

  return { details, ...(requireTypedText ? { requireTypedText } : {}) };
}
