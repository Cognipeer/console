'use client';

import { useState } from 'react';
import { Button, Menu, Modal, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBellOff, IconBellRinging, IconChevronDown } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { AlertRuleDto } from '../alertTypes';
import { readApiError } from '../apiError';
import { MUTE_PRESETS, muteUntilForPreset, validateMuteUntil, type MutePresetId } from './ruleListUi';

export interface MuteMenuProps {
  rule: Pick<AlertRuleDto, '_id' | 'name'>;
  muted: boolean;
  /** The server's answer (`rule` of `POST /alerts/rules/:id/mute`). */
  onChanged: (rule: AlertRuleDto) => void;
  disabled?: boolean;
}

/** Local `datetime-local` value (YYYY-MM-DDTHH:mm) of an instant. */
function toLocalInput(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Mute / unmute a rule. Muting keeps evaluating and recording incidents; only the channel notifications stop (webhook
 * subscriptions still fire), so the copy says so. Presets cover the common cases; "Custom" takes any end up to 30 days.
 */
export default function MuteMenu({ rule, muted, onChanged, disabled }: MuteMenuProps) {
  const t = useTranslations('alerts');
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const [reason, setReason] = useState('');

  const send = async (until: string | null, why?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts/rules/${rule._id}/mute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until, ...(why?.trim() ? { reason: why.trim() } : {}) }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('rulesUx.muteError')));
      const data = (await res.json()) as { rule?: AlertRuleDto };
      if (data.rule) onChanged(data.rule);
      notifications.show({
        title: t(until ? 'rulesUx.muted' : 'rulesUx.unmuted'),
        message: t(until ? 'rulesUx.mutedMessage' : 'rulesUx.unmutedMessage', { name: rule.name }),
        color: 'teal',
      });
      setCustomOpen(false);
      setReason('');
    } catch (error) {
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('rulesUx.muteError'), color: 'red' });
    } finally {
      setBusy(false);
    }
  };

  const customIssue = customValue ? validateMuteUntil(new Date(customValue)) : null;

  if (muted) {
    return (
      <Button
        size="compact-xs"
        variant="default"
        leftSection={<IconBellRinging size={12} stroke={1.7} />}
        loading={busy}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          void send(null);
        }}
      >
        {t('rulesUx.unmute')}
      </Button>
    );
  }

  return (
    <>
      <Menu position="bottom-end" withinPortal shadow="md" width={230}>
        <Menu.Target>
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconBellOff size={12} stroke={1.7} />}
            rightSection={<IconChevronDown size={12} stroke={1.7} />}
            loading={busy}
            disabled={disabled}
            aria-label={t('rulesUx.muteRule', { name: rule.name })}
            onClick={(event) => event.stopPropagation()}
          >
            {t('rulesUx.mute')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
          <Menu.Label>{t('rulesUx.muteFor')}</Menu.Label>
          {MUTE_PRESETS.map((preset) => (
            <Menu.Item key={preset.id} onClick={() => void send(muteUntilForPreset(preset.id as MutePresetId))}>
              {t(`rulesUx.presets.${preset.id}`)}
            </Menu.Item>
          ))}
          <Menu.Item
            onClick={() => {
              setCustomValue(toLocalInput(Date.now() + 24 * 60 * 60 * 1000));
              setCustomOpen(true);
            }}
          >
            {t('rulesUx.presets.custom')}
          </Menu.Item>
          <Menu.Divider />
          <Text size="xs" c="dimmed" px="sm" py={4}>
            {t('rulesUx.muteNote')}
          </Text>
        </Menu.Dropdown>
      </Menu>

      <Modal opened={customOpen} onClose={() => setCustomOpen(false)} title={t('rulesUx.muteCustomTitle', { name: rule.name })} centered size="md">
        <div className="ds-col ds-gap-sm" role="presentation" onClick={(event) => event.stopPropagation()}>
          <TextInput
            type="datetime-local"
            label={t('rulesUx.muteUntil')}
            description={t('rulesUx.muteUntilHint')}
            value={customValue}
            error={customIssue ? t(`rulesUx.muteIssue.${customIssue}`) : undefined}
            onChange={(event) => setCustomValue(event.currentTarget.value)}
          />
          <TextInput
            label={t('rulesUx.muteReason')}
            placeholder={t('rulesUx.muteReasonPlaceholder')}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <Button
            color="teal"
            loading={busy}
            disabled={!customValue || validateMuteUntil(new Date(customValue)) !== null}
            onClick={() => void send(new Date(customValue).toISOString(), reason)}
          >
            {t('rulesUx.mute')}
          </Button>
        </div>
      </Modal>
    </>
  );
}
