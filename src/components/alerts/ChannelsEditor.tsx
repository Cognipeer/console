'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Button, Checkbox, Group, PasswordInput, TagsInput, Text, TextInput, Tooltip } from '@mantine/core';
import {
  IconBellRinging,
  IconBrandSlack,
  IconBrandTeams,
  IconMail,
  IconPlus,
  IconSend,
  IconTrash,
  IconWebhook,
  type Icon as TablerIcon,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { ALL_CHANNEL_TYPES, type AlertChannelType, type ChannelTestResult } from './alertTypes';
import {
  channelEditsSecrets,
  isStoredChannel,
  newChannelItem,
  validateChannel,
  type ChannelIssue,
  type ChannelItem,
} from './channelItems';

export const MAX_CHANNELS = 10;

/**
 * The editor lives in full-screen forms, which are portaled out of the app shell: the design system's colour for subtle
 * buttons does not reach them and Mantine's gray is the near-invisible border tone, so the quiet text buttons set it.
 */
const KEEP_STORED_COLOR = 'var(--ds-text-muted)';

const CHANNEL_ICONS: Record<AlertChannelType, TablerIcon> = {
  email: IconMail,
  webhook: IconWebhook,
  slack: IconBrandSlack,
  teams: IconBrandTeams,
  pagerduty: IconBellRinging,
};

export interface ChannelsEditorProps {
  /** UI channel items (stored ones carry their id and masked hints, never a secret). */
  value: ChannelItem[];
  onChange: (next: ChannelItem[]) => void;
  /** Channel types offered in the "add" bar; default all five. */
  allowedTypes?: AlertChannelType[];
  /** Sends a test message through one channel. Without it the Test button is not shown. */
  onTest?: (channel: ChannelItem) => Promise<ChannelTestResult>;
  /** Whether a channel can be tested right now (default: no validation issue). */
  canTest?: (channel: ChannelItem) => boolean;
  maxChannels?: number;
  disabled?: boolean;
  /** One fixed channel (the channel library form): no remove button and no "add" bar. */
  single?: boolean;
  /** Offers "also notify the project's admins" on email channels; `count` is how many there are (null: unknown). */
  adminAudience?: { count: number | null };
}

type TestState = { status: 'loading' } | { status: 'done'; ok: boolean; message: string };

export default function ChannelsEditor({
  value,
  onChange,
  allowedTypes = ALL_CHANNEL_TYPES,
  onTest,
  canTest,
  maxChannels = MAX_CHANNELS,
  disabled = false,
  single = false,
  adminAudience,
}: ChannelsEditorProps) {
  const t = useTranslations('alerts');
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = (key: string, patch: Partial<ChannelItem>) =>
    onChange(value.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  const remove = (key: string) => onChange(value.filter((item) => item.key !== key));
  const add = (type: AlertChannelType) => onChange([...value, newChannelItem(type)]);

  const runTest = async (item: ChannelItem) => {
    if (!onTest) return;
    setTests((prev) => ({ ...prev, [item.key]: { status: 'loading' } }));
    let state: TestState;
    try {
      const result = await onTest(item);
      state = { status: 'done', ok: Boolean(result.success), message: result.success ? '' : (result.error ?? '') };
    } catch (error) {
      state = { status: 'done', ok: false, message: error instanceof Error ? error.message : '' };
    }
    if (mounted.current) setTests((prev) => ({ ...prev, [item.key]: state }));
  };

  const issueText = (issue: ChannelIssue): string => {
    switch (issue.code) {
      case 'invalidEmail':
        return t('channels.invalidEmail', { value: issue.value });
      case 'urlRequired':
        return t('channels.urlRequired');
      case 'urlInvalid':
        return t('channels.urlInvalid');
      case 'routingKeyRequired':
        return t('channels.routingKeyRequired');
      case 'routingKeyInvalid':
        return t('channels.routingKeyInvalid');
    }
  };

  const canAddMore = value.length < maxChannels;

  return (
    <div className="ds-col ds-gap-sm" data-testid="channels-editor">
      {value.length === 0 && !single ? (
        <Text size="sm" c="dimmed">
          {t('channels.empty')}
        </Text>
      ) : null}

      {value.map((item) => {
        const Icon = CHANNEL_ICONS[item.type] ?? IconMail;
        const stored = isStoredChannel(item);
        const editing = channelEditsSecrets(item);
        const issue = validateChannel(item);
        const test = tests[item.key];
        const testable = onTest ? (canTest ? canTest(item) : !issue) : false;
        return (
          <div key={item.key} className="ds-card ds-card-pad-sm" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8} wrap="nowrap">
                <Icon size={16} stroke={1.7} />
                <Text size="sm" fw={600}>
                  {t(`channelTypes.${item.type}`)}
                </Text>
                {stored ? <span className="ds-badge ds-badge-info">{t('channels.saved')}</span> : null}
              </Group>
              <Group gap={6} wrap="nowrap">
                {onTest ? (
                  <Button
                    size="compact-xs"
                    variant="default"
                    leftSection={<IconSend size={12} stroke={1.7} />}
                    loading={test?.status === 'loading'}
                    disabled={disabled || !testable}
                    onClick={() => void runTest(item)}
                  >
                    {t('channels.sendTest')}
                  </Button>
                ) : null}
                {single ? null : (
                <Tooltip label={t('channels.remove')} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    disabled={disabled}
                    aria-label={t('channels.remove')}
                    onClick={() => remove(item.key)}
                  >
                    <IconTrash size={14} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
                )}
              </Group>
            </Group>

            {item.type === 'email' ? (
              <TagsInput
                label={t('channels.recipients')}
                description={t('channels.recipientsHint')}
                placeholder={t('channels.recipientsPlaceholder')}
                splitChars={[',', ';', ' ']}
                value={item.recipients}
                disabled={disabled}
                error={issue?.code === 'invalidEmail' ? issueText(issue) : undefined}
                onChange={(recipients) => update(item.key, { recipients })}
              />
            ) : null}

            {item.type === 'email' && adminAudience ? (
              <div>
                <Checkbox
                  size="xs"
                  label={
                    adminAudience.count === null
                      ? t('channels.audienceProjectAdmins')
                      : t('channels.audienceProjectAdminsCount', { count: adminAudience.count })
                  }
                  checked={item.audience === 'project_admins'}
                  disabled={disabled}
                  onChange={(event) => update(item.key, { audience: event.currentTarget.checked ? 'project_admins' : undefined })}
                />
                <Text size="xs" c="dimmed" mt={4}>
                  {t('channels.audienceHint')}
                </Text>
              </div>
            ) : null}

            {item.type === 'webhook' || item.type === 'slack' || item.type === 'teams' ? (
              <>
                {!editing ? (
                  <StoredValue
                    label={t('channels.url')}
                    hint={item.urlHint ?? ''}
                    disabled={disabled}
                    action={t('channels.replace')}
                    onAction={() => update(item.key, { replace: true })}
                    extra={
                      item.type === 'webhook' ? (
                        <span className={`ds-badge ${item.hasSecret ? 'ds-badge-ok' : ''}`}>
                          {item.hasSecret ? t('channels.secretSet') : t('channels.noSecret')}
                        </span>
                      ) : null
                    }
                  />
                ) : (
                  <>
                    <TextInput
                      label={t('channels.url')}
                      description={stored ? t('channels.keepEmptyToKeep') : t(`channels.urlHint.${item.type}`)}
                      placeholder="https://"
                      autoComplete="off"
                      value={item.url ?? ''}
                      disabled={disabled}
                      error={issue && (issue.code === 'urlRequired' || issue.code === 'urlInvalid') ? issueText(issue) : undefined}
                      onChange={(event) => update(item.key, { url: event.currentTarget.value })}
                    />
                    {item.type === 'webhook' ? (
                      <PasswordInput
                        label={t('channels.secret')}
                        description={t('channels.secretHint')}
                        autoComplete="new-password"
                        value={item.secret ?? ''}
                        disabled={disabled || Boolean(item.clearSecret)}
                        onChange={(event) => update(item.key, { secret: event.currentTarget.value })}
                      />
                    ) : null}
                    {stored && item.type === 'webhook' && item.hasSecret ? (
                      <Checkbox
                        size="xs"
                        label={t('channels.removeSecret')}
                        checked={Boolean(item.clearSecret)}
                        disabled={disabled}
                        onChange={(event) => update(item.key, { clearSecret: event.currentTarget.checked, secret: '' })}
                      />
                    ) : null}
                    {stored && item.type === 'webhook' && item.hasSecret && item.url?.trim() && !item.clearSecret && !item.secret?.trim() ? (
                      <Text size="xs" c="orange" data-testid="webhook-secret-kept">
                        {t('channels.secretKeptNote')}
                      </Text>
                    ) : null}
                    {stored ? (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        style={{ alignSelf: 'flex-start', color: KEEP_STORED_COLOR }}
                        onClick={() => update(item.key, { replace: false, url: '', secret: '', clearSecret: false })}
                      >
                        {t('channels.keepStored')}
                      </Button>
                    ) : null}
                  </>
                )}
              </>
            ) : null}

            {item.type === 'pagerduty' ? (
              !editing ? (
                <StoredValue
                  label={t('channels.routingKey')}
                  hint={item.keyHint ?? ''}
                  disabled={disabled}
                  action={t('channels.replace')}
                  onAction={() => update(item.key, { replace: true })}
                />
              ) : (
                <>
                  <PasswordInput
                    label={t('channels.routingKey')}
                    description={stored ? t('channels.keepEmptyToKeep') : t('channels.routingKeyHint')}
                    autoComplete="new-password"
                    value={item.routingKey ?? ''}
                    disabled={disabled}
                    error={issue && (issue.code === 'routingKeyRequired' || issue.code === 'routingKeyInvalid') ? issueText(issue) : undefined}
                    onChange={(event) => update(item.key, { routingKey: event.currentTarget.value })}
                  />
                  {stored ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      style={{ alignSelf: 'flex-start', color: KEEP_STORED_COLOR }}
                      onClick={() => update(item.key, { replace: false, routingKey: '' })}
                    >
                      {t('channels.keepStored')}
                    </Button>
                  ) : null}
                </>
              )
            ) : null}

            {test?.status === 'done' ? (
              <Text size="xs" c={test.ok ? 'teal' : 'red'} role="status">
                {test.ok ? t('channels.testOk') : t('channels.testFailed', { error: test.message || t('channels.testNoDetail') })}
              </Text>
            ) : null}
          </div>
        );
      })}

      {single ? null : canAddMore ? (
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            {t('channels.add')}
          </Text>
          {allowedTypes.map((type) => {
            const Icon = CHANNEL_ICONS[type] ?? IconMail;
            return (
              <Button
                key={type}
                size="compact-xs"
                variant="default"
                disabled={disabled}
                leftSection={<IconPlus size={12} stroke={1.7} />}
                rightSection={<Icon size={12} stroke={1.7} />}
                onClick={() => add(type)}
              >
                {t(`channelTypes.${type}`)}
              </Button>
            );
          })}
        </Group>
      ) : (
        <Text size="xs" c="dimmed">
          {t('channels.max', { count: maxChannels })}
        </Text>
      )}
    </div>
  );
}

function StoredValue({
  label,
  hint,
  action,
  onAction,
  extra,
  disabled,
}: {
  label: string;
  hint: string;
  action: string;
  onAction: () => void;
  extra?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <div style={{ minWidth: 0 }}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Group gap={8} wrap="nowrap">
          <Text size="sm" className="ds-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hint || '—'}
          </Text>
          {extra}
        </Group>
      </div>
      <Button size="compact-xs" variant="default" disabled={disabled} onClick={onAction}>
        {action}
      </Button>
    </Group>
  );
}
