'use client';

import { useMemo, useState } from 'react';
import { Button, Group, Menu, Modal, Stack, Text } from '@mantine/core';
import { IconBellOff, IconBellRinging, IconChevronDown, IconClock } from '@tabler/icons-react';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  SNOOZE_PRESETS,
  checkUntil,
  parseLocalDateTime,
  snoozePresetUntil,
  toLocalDateTimeValue,
  type SnoozePreset,
} from '../inbox/inboxModel';

interface SnoozeDialogProps {
  opened: boolean;
  onClose: () => void;
  /** Receives the chosen end. */
  onConfirm: (until: Date) => void;
  /** How many incidents the choice applies to (shown in the title when more than one). */
  count?: number;
  loading?: boolean;
}

/** Pick an end for a snooze: a preset or a custom date and time (at most 30 days ahead). */
export function SnoozeDialog({ opened, onClose, onConfirm, count = 1, loading }: SnoozeDialogProps) {
  const t = useTranslations('incidents');
  const [custom, setCustom] = useState('');
  const parsed = useMemo(() => parseLocalDateTime(custom), [custom]);
  const check = custom ? checkUntil(parsed) : 'invalid';
  const error = custom && check !== 'ok' ? t(check === 'tooFar' ? 'ux.snooze.tooFar' : 'ux.snooze.invalid') : null;

  return (
    <Modal opened={opened} onClose={onClose} title={count > 1 ? t('ux.snooze.titleMany', { count }) : t('ux.snooze.title')} centered size="sm">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('ux.snooze.explain')}
        </Text>
        <Stack gap={6}>
          {SNOOZE_PRESETS.map((preset) => (
            <Button key={preset} variant="default" justify="space-between" disabled={loading} onClick={() => onConfirm(snoozePresetUntil(preset))}>
              {t(`ux.snooze.preset.${preset}`)}
            </Button>
          ))}
        </Stack>
        <div>
          <label htmlFor="snooze-custom" className="ds-label" style={{ display: 'block', marginBottom: 4, fontSize: 12.5 }}>
            {t('ux.snooze.custom')}
          </label>
          <input
            id="snooze-custom"
            type="datetime-local"
            className="ds-input"
            value={custom}
            min={toLocalDateTimeValue(new Date())}
            onChange={(event) => setCustom(event.currentTarget.value)}
            style={{ width: '100%' }}
          />
          {error ? (
            <Text size="xs" c="red" mt={4} role="alert">
              {error}
            </Text>
          ) : null}
        </div>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" size="sm" onClick={onClose}>
            {t('ux.cancel')}
          </Button>
          <Button size="sm" loading={loading} disabled={check !== 'ok' || !parsed} onClick={() => parsed && onConfirm(parsed)}>
            {t('ux.snooze.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface SnoozeMenuProps {
  snoozedUntil?: string | null;
  /** `null` clears the snooze. */
  onSnooze: (until: Date | null) => void | Promise<void>;
  loading?: boolean;
  disabled?: boolean;
}

/** The detail page's Snooze control: presets, a custom time, and clearing an active snooze. */
export default function SnoozeMenu({ snoozedUntil, onSnooze, loading, disabled }: SnoozeMenuProps) {
  const t = useTranslations('incidents');
  const locale = useLocale();
  const [dialog, setDialog] = useState(false);
  const active = Boolean(snoozedUntil);

  return (
    <>
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            variant="default"
            size="sm"
            loading={loading}
            disabled={disabled}
            leftSection={active ? <IconBellOff size={13} stroke={1.7} /> : <IconClock size={13} stroke={1.7} />}
            rightSection={<IconChevronDown size={12} />}
          >
            {active ? t('ux.snooze.snoozedUntil', { time: formatDateTime(snoozedUntil, locale) }) : t('ux.snooze.button')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t('ux.snooze.menuLabel')}</Menu.Label>
          {SNOOZE_PRESETS.map((preset: SnoozePreset) => (
            <Menu.Item key={preset} onClick={() => void onSnooze(snoozePresetUntil(preset))}>
              {t(`ux.snooze.preset.${preset}`)}
            </Menu.Item>
          ))}
          <Menu.Item onClick={() => setDialog(true)}>{t('ux.snooze.customItem')}</Menu.Item>
          {active ? (
            <>
              <Menu.Divider />
              <Menu.Item leftSection={<IconBellRinging size={13} />} onClick={() => void onSnooze(null)}>
                {t('ux.snooze.clear')}
              </Menu.Item>
            </>
          ) : null}
        </Menu.Dropdown>
      </Menu>
      <SnoozeDialog
        opened={dialog}
        onClose={() => setDialog(false)}
        onConfirm={(until) => {
          setDialog(false);
          void onSnooze(until);
        }}
      />
    </>
  );
}
