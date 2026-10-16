'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Group, Menu, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBellOff, IconBellRinging, IconChevronDown, IconVolume } from '@tabler/icons-react';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import { readApiError } from '../apiError';
import type { AlertRuleDto } from '../alertTypes';
import { MUTE_PRESETS, checkUntil, mutePresetUntil, parseLocalDateTime, toLocalDateTimeValue } from '../inbox/inboxModel';

interface MuteRuleMenuProps {
  ruleId: string;
  rule: AlertRuleDto | null;
  onChanged: (rule: AlertRuleDto) => void;
}

function isMuted(rule: AlertRuleDto | null): boolean {
  if (!rule?.mutedUntil) return false;
  return Date.parse(rule.mutedUntil) > Date.now();
}

/**
 * Mute the rule behind an incident (`POST /alerts/rules/:id/mute`). A mute is not a snooze: it silences the
 * rule's channel notifications for every incident of the rule while evaluation and incidents carry on, and
 * webhook subscriptions still receive the events.
 */
export default function MuteRuleMenu({ ruleId, rule, onChanged }: MuteRuleMenuProps) {
  const t = useTranslations('incidents');
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const muted = isMuted(rule);
  const parsed = useMemo(() => parseLocalDateTime(custom), [custom]);
  const check = custom ? checkUntil(parsed) : 'invalid';

  const submit = async (until: Date | null, why?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts/rules/${encodeURIComponent(ruleId)}/mute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: until ? until.toISOString() : null, ...(why?.trim() ? { reason: why.trim() } : {}) }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('ux.mute.failed')));
      const data = (await res.json()) as { rule: AlertRuleDto };
      onChanged(data.rule);
      setDialog(false);
      setCustom('');
      setReason('');
      notifications.show({
        color: 'teal',
        title: t('ux.mute.doneTitle'),
        message: until ? t('ux.mute.done', { time: formatDateTime(until.toISOString(), locale) }) : t('ux.mute.undone'),
      });
    } catch (error) {
      notifications.show({ color: 'red', title: t('error'), message: error instanceof Error ? error.message : t('ux.mute.failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            variant="default"
            size="sm"
            loading={busy}
            disabled={!rule}
            leftSection={muted ? <IconBellOff size={13} stroke={1.7} /> : <IconVolume size={13} stroke={1.7} />}
            rightSection={<IconChevronDown size={12} />}
          >
            {muted ? t('ux.mute.mutedUntil', { time: formatDateTime(rule?.mutedUntil, locale) }) : t('ux.mute.button')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t('ux.mute.menuLabel')}</Menu.Label>
          {MUTE_PRESETS.map((preset) => (
            <Menu.Item key={preset} onClick={() => void submit(mutePresetUntil(preset))}>
              {t(`ux.mute.preset.${preset}`)}
            </Menu.Item>
          ))}
          <Menu.Item onClick={() => setDialog(true)}>{t('ux.mute.customItem')}</Menu.Item>
          {muted ? (
            <>
              <Menu.Divider />
              <Menu.Item leftSection={<IconBellRinging size={13} />} onClick={() => void submit(null)}>
                {t('ux.mute.clear')}
              </Menu.Item>
            </>
          ) : null}
        </Menu.Dropdown>
      </Menu>

      <Modal opened={dialog} onClose={() => setDialog(false)} title={t('ux.mute.title', { rule: rule?.name ?? '' })} centered size="md">
        <Stack gap="sm">
          <Alert color="blue" variant="light">
            {t('ux.mute.explain')}
          </Alert>
          <div>
            <label htmlFor="mute-custom" style={{ display: 'block', marginBottom: 4, fontSize: 12.5 }}>
              {t('ux.mute.until')}
            </label>
            <input
              id="mute-custom"
              type="datetime-local"
              className="ds-input"
              value={custom}
              min={toLocalDateTimeValue(new Date())}
              onChange={(event) => setCustom(event.currentTarget.value)}
              style={{ width: '100%' }}
            />
            {custom && check !== 'ok' ? (
              <Text size="xs" c="red" mt={4} role="alert">
                {t(check === 'tooFar' ? 'ux.mute.tooFar' : 'ux.mute.invalid')}
              </Text>
            ) : null}
          </div>
          <Textarea
            label={t('ux.mute.reason')}
            placeholder={t('ux.mute.reasonPlaceholder')}
            maxLength={500}
            autosize
            minRows={2}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" size="sm" onClick={() => setDialog(false)}>
              {t('ux.cancel')}
            </Button>
            <Button size="sm" loading={busy} disabled={check !== 'ok' || !parsed} onClick={() => parsed && void submit(parsed, reason)}>
              {t('ux.mute.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
