'use client';

/**
 * The bulk actions on a page of people or tokens, in one flow: a dry run first
 * (nothing is written), a small confirmation that says how many will change and
 * why the others are skipped (a typed confirmation above 20), the real run in
 * requests of at most 100 ids, and a result dialog that lists what failed.
 *
 * The server evaluates every id with the same guards as the single endpoints
 * (yourself, the owner, someone above you, already in that state, a directory
 * group...), so the counts shown before the run are the real ones.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useConfirm } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { needsTypedConfirmation, problems, reasonCounts, runChunked } from './bulkModel';
import { directoryApi, type BulkAction, type BulkResult } from './directoryApi';
import { describeError } from './errors';
import { ReasonField } from './usePeopleActions';

export interface BulkRequestSpec {
  action: BulkAction;
  ids: string[];
  /** Disable only. */
  reason?: string;
  /** The two group actions. */
  group?: { id: string; name: string };
}

interface Options {
  onDone: () => void;
  /** Display names of ids, for the failure list. */
  labelOf: (id: string) => string;
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
}

const identity = <T,>(run: () => Promise<T>) => run();

export interface BulkFlow {
  /** People: dry run, confirm, run. */
  runPeople: (spec: BulkRequestSpec) => Promise<void>;
  /** Tokens: confirm, then revoke (there is no dry run for tokens). */
  revokeTokens: (ids: string[]) => Promise<void>;
  /** Render once, near the list: the failure dialog. */
  dialog: ReactNode;
}

export function useBulkFlow({ onDone, labelOf, guard = identity }: Options): BulkFlow {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const { confirmAction } = useConfirm();
  const [failure, setFailure] = useState<{ result: BulkResult; action: string } | null>(null);
  const latest = useRef({ onDone, guard, labelOf });
  latest.current = { onDone, guard, labelOf };

  const codeText = useCallback(
    (code: string) => (BULK_CODES.has(code) ? t(`bulk.codes.${code}`) : t('bulk.codes.failed')),
    [t],
  );
  const reasonLine = useCallback((code: string, count: number) => `${count} × ${codeText(code)}`, [codeText]);

  const finish = useCallback(
    (result: BulkResult, action: string) => {
      latest.current.onDone();
      if (result.failed > 0 || result.skipped > 0) {
        if (result.ok > 0) {
          notifications.show({
            title: tCommon('success'),
            message: t('bulk.partial', { ok: result.ok, skipped: result.skipped, failed: result.failed }),
            color: result.failed > 0 ? 'orange' : 'green',
          });
        }
        if (result.failed > 0 || result.ok === 0) setFailure({ result, action });
        return;
      }
      notifications.show({ title: tCommon('success'), message: t('bulk.done', { count: result.ok }), color: 'green' });
    },
    [t, tCommon],
  );

  const runPeople = useCallback(
    async (spec: BulkRequestSpec) => {
      const base = { action: spec.action, groupId: spec.group?.id };
      const label = t(`bulk.actions.${spec.action}`, { group: spec.group?.name ?? '' });
      // Disabling asks for an optional reason, typed in the confirmation itself.
      const reason = { current: spec.reason ?? '' };
      const reasonField =
        spec.action === 'disable' ? (
          <ReasonField
            label={t('confirm.disable.reasonLabel')}
            placeholder={t('confirm.disable.reasonPlaceholder')}
            onChange={(v) => {
              reason.current = v;
            }}
          />
        ) : null;
      let outcome: BulkResult | null = null;
      // False when the check found nothing to do (or failed): the confirmation then only closes.
      let proceed = true;
      await latest.current.guard(() =>
        confirmAction({
          title: label,
          message: t('bulk.checking', { count: spec.ids.length }),
          prepareLabel: t('bulk.checkingLabel'),
          tone: 'warning',
          confirmLabel: t('bulk.run'),
          prepare: async () => {
            const dry = await runChunked(spec.ids, (chunk) => directoryApi.bulk({ ...base, ids: chunk, dryRun: true }));
            const skipped = reasonCounts(dry.results, 'skipped').concat(reasonCounts(dry.results, 'failed'));
            const skippedList =
              skipped.length > 0 ? (
                <Stack gap={2}>
                  <Text size="sm" fw={600}>
                    {t('bulk.skippedTitle', { count: dry.skipped + dry.failed })}
                  </Text>
                  {skipped.map((r) => (
                    <Text key={r.code} size="sm" c="dimmed">
                      {reasonLine(r.code, r.count)}
                    </Text>
                  ))}
                </Stack>
              ) : null;
            const details =
              skippedList || reasonField ? (
                <Stack gap="sm">
                  {skippedList}
                  {dry.ok > 0 ? reasonField : null}
                </Stack>
              ) : undefined;
            proceed = dry.ok > 0;
            if (dry.ok === 0) {
              return {
                message: t('bulk.nothing', { count: spec.ids.length }),
                details,
                confirmLabel: t('bulk.close'),
                tone: 'neutral' as const,
              };
            }
            return {
              message: t('bulk.summary', { ok: dry.ok, skipped: dry.skipped + dry.failed, total: dry.requested }),
              details,
              requireTypedText: needsTypedConfirmation(dry.ok) ? String(dry.ok) : undefined,
            };
          },
          onPrepareError: (error) => {
            proceed = false;
            return { message: describeError(error, t), confirmLabel: t('bulk.close') };
          },
          action: async () => {
            if (!proceed) return;
            try {
              const trimmed = reason.current.trim();
              outcome = await runChunked(spec.ids, (chunk) =>
                directoryApi.bulk({ ...base, ids: chunk, ...(trimmed ? { reason: trimmed } : {}) }),
              );
            } catch (error) {
              throw new Error(describeError(error, t));
            }
          },
        }),
      );
      if (outcome) finish(outcome, label);
    },
    [confirmAction, finish, reasonLine, t],
  );

  const revokeTokens = useCallback(
    async (ids: string[]) => {
      let outcome: BulkResult | null = null;
      await latest.current.guard(() =>
        confirmAction({
          title: t('bulk.actions.revokeTokens'),
          message: t('bulk.revokeTokensBody', { count: ids.length }),
          tone: 'danger',
          confirmLabel: t('bulk.revokeRun'),
          requireTypedText: needsTypedConfirmation(ids.length) ? String(ids.length) : undefined,
          action: async () => {
            try {
              const parts: BulkResult[] = [];
              for (let i = 0; i < ids.length; i += 100) {
                const chunk = ids.slice(i, i + 100);
                const r = await directoryApi.revokeTokens(chunk);
                parts.push({
                  action: 'revoke-tokens',
                  dryRun: false,
                  requested: r.requested,
                  ok: r.revoked,
                  skipped: r.skipped,
                  failed: r.failed,
                  batchId: null,
                  results: r.results,
                });
              }
              outcome = {
                action: 'revoke-tokens',
                dryRun: false,
                requested: parts.reduce((n, p) => n + p.requested, 0),
                ok: parts.reduce((n, p) => n + p.ok, 0),
                skipped: parts.reduce((n, p) => n + p.skipped, 0),
                failed: parts.reduce((n, p) => n + p.failed, 0),
                batchId: null,
                results: parts.flatMap((p) => p.results),
              };
            } catch (error) {
              throw new Error(describeError(error, t));
            }
          },
        }),
      );
      if (outcome) finish(outcome, t('bulk.actions.revokeTokens'));
    },
    [confirmAction, finish, t],
  );

  const items = failure ? problems(failure.result) : [];
  const dialog = (
    <Modal
      opened={failure !== null}
      onClose={() => setFailure(null)}
      title={failure ? t('bulk.resultTitle', { action: failure.action }) : ''}
      size="md"
      zIndex={400}
      centered
    >
      {failure ? (
        <Stack gap="sm" data-testid="bulk-result">
          <Text size="sm">
            {t('bulk.resultSummary', { ok: failure.result.ok, skipped: failure.result.skipped, failed: failure.result.failed })}
          </Text>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {items.map((item) => (
              <Group key={item.id} justify="space-between" wrap="nowrap" gap="sm" py={4} style={{ borderBottom: '1px solid var(--ds-border-soft)' }}>
                <Text size="sm" truncate>
                  {latest.current.labelOf(item.id)}
                </Text>
                <Text size="xs" c="dimmed" ta="right">
                  {item.code ? codeText(item.code) : (item.message ?? t('bulk.codes.failed'))}
                </Text>
              </Group>
            ))}
          </div>
          <Group justify="flex-end">
            <Button onClick={() => setFailure(null)}>{t('bulk.close')}</Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );

  return { runPeople, revokeTokens, dialog };
}

/** Reason codes of a skipped or failed item that have a message of their own (`iamDirectory.bulk.codes.*`). */
export const BULK_CODE_LIST = [
  'self_not_allowed',
  'owner_immutable',
  'higher_privileges',
  'user_not_found',
  'token_not_found',
  'already_in_state',
  'not_a_member',
  'directory_managed',
  'group_directory_managed',
  'failed',
] as const;

const BULK_CODES: ReadonlySet<string> = new Set(BULK_CODE_LIST);
