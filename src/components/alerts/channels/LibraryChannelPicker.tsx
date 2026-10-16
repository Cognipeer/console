'use client';

import { ActionIcon, Group, Select, Text, Tooltip } from '@mantine/core';
import { IconBooks, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import { useTranslations } from '@/lib/i18n';
import type { LibraryChannelDto } from '../alertTypes';
import type { LibraryRef } from '../channelItems';
import { libraryDestinationHint } from './libraryUi';

export interface LibraryChannelPickerProps {
  value: LibraryRef[];
  onChange: (next: LibraryRef[]) => void;
  /** The tenant library (`useChannelLibrary`). */
  library: LibraryChannelDto[];
  loading?: boolean;
  error?: string | null;
  /** Another entry still fits (rule channels are capped, inline ones count too). */
  canAddMore: boolean;
  disabled?: boolean;
}

/**
 * Library channels of a rule: entries shared across the workspace. The rule stores only a reference, so the
 * destination and its secret are managed (and rotated) in one place.
 */
export default function LibraryChannelPicker({ value, onChange, library, loading, error, canAddMore, disabled }: LibraryChannelPickerProps) {
  const t = useTranslations('alerts');
  const byId = new Map(library.map((entry) => [entry.id, entry]));
  const chosen = new Set(value.map((ref) => ref.libraryId));
  const options = library.filter((entry) => !chosen.has(entry.id)).map((entry) => ({ value: entry.id, label: `${entry.name} · ${t(`channelTypes.${entry.kind}`)}` }));

  return (
    <div className="ds-col ds-gap-sm" data-testid="library-channel-picker">
      {value.map((ref) => {
        const entry = byId.get(ref.libraryId);
        const missing = !loading && !error && !entry;
        return (
          <div key={ref.libraryId} className="ds-card ds-card-pad-sm">
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <IconBooks size={16} stroke={1.7} />
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} lineClamp={1}>
                    {entry?.name ?? t('libraryUx.unknownEntry')}
                  </Text>
                  <Text size="xs" c={missing ? 'red' : 'dimmed'} className={missing ? undefined : 'ds-mono'} lineClamp={1}>
                    {entry ? `${t(`channelTypes.${entry.kind}`)} · ${libraryDestinationHint(entry) || '—'}` : missing ? t('libraryUx.missingEntry') : '…'}
                  </Text>
                </div>
              </Group>
              <Tooltip label={t('channels.remove')} withArrow>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  disabled={disabled}
                  aria-label={t('channels.remove')}
                  onClick={() => onChange(value.filter((item) => item.libraryId !== ref.libraryId))}
                >
                  <IconTrash size={14} stroke={1.7} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </div>
        );
      })}

      {error ? (
        <Text size="xs" c="red" role="alert">
          {error}
        </Text>
      ) : options.length > 0 && canAddMore ? (
        <Select
          aria-label={t('libraryUx.addFromLibrary')}
          placeholder={t('libraryUx.addFromLibrary')}
          data={options}
          value={null}
          searchable
          disabled={disabled}
          onChange={(next) => next && onChange([...value, { libraryId: next }])}
        />
      ) : (
        <Text size="xs" c="dimmed">
          {loading ? t('libraryUx.loading') : library.length === 0 ? t('libraryUx.emptyPicker') : canAddMore ? t('libraryUx.allAdded') : t('channels.max', { count: 10 })}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        <Link href="/dashboard/alerts/channels" target="_blank" rel="noreferrer">
          {t('libraryUx.manageLink')}
        </Link>
      </Text>
    </div>
  );
}
