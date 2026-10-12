'use client';

import { useCallback } from 'react';
import { Stack, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import ResourceUsagePanel from '@/components/resources/ResourceUsagePanel';
import { useConfirm } from './ConfirmProvider';
import { edgesBrokenByKeyChange, fetchResourceUsage, keyChanged } from './resourceUsage';

export interface ConfirmKeyChangeOptions {
  /** Registry type id of the resource whose key is being edited ('model', 'mcp-server', 'realtime-model'...). */
  type: string;
  id: string;
  /** i18n'd label of the resource ("model", "MCP server"). */
  noun: string;
  originalKey: string | null | undefined;
  nextKey: string | null | undefined;
}

/**
 * Rename guard for resources that other resources reference BY KEY (agent
 * bindings, model replicas...). Call it right before saving an edit form:
 *
 *   if (!(await confirmKeyChange({ type: 'model', id, noun, originalKey, nextKey }))) return;
 *
 * Resolves true when the key did not change, nothing references it, the usage
 * check failed (never blocks a save) or the user confirmed; false only when the
 * user cancelled the warning.
 */
export function useConfirmKeyChange(): (options: ConfirmKeyChangeOptions) => Promise<boolean> {
  const { confirm } = useConfirm();
  const t = useTranslations('common.confirm');

  return useCallback(
    async ({ type, id, noun, originalKey, nextKey }: ConfirmKeyChangeOptions) => {
      if (!keyChanged(originalKey, nextKey)) return true;
      let usage;
      try {
        usage = await fetchResourceUsage(type, id);
      } catch {
        return true;
      }
      const broken = edgesBrokenByKeyChange(usage);
      if (broken.length === 0 && usage.hiddenUsedByCount === 0) return true;

      return confirm({
        tone: 'warning',
        title: t('rename.title', { noun }),
        message: t('rename.message', { noun, from: (originalKey ?? '').trim(), to: (nextKey ?? '').trim() }),
        confirmLabel: t('rename.confirm'),
        details: (
          <Stack gap="xs">
            {broken.length > 0 ? (
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                <ResourceUsagePanel usedBy={broken} compact hideUses />
              </div>
            ) : null}
            {usage.hiddenUsedByCount > 0 ? (
              <Text size="sm" c="dimmed">{t('rename.hiddenUses', { count: usage.hiddenUsedByCount })}</Text>
            ) : null}
          </Stack>
        ),
      });
    },
    [confirm, t],
  );
}
