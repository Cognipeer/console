'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Group, Loader, NumberInput, Paper, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconInfoCircle, IconKey, IconLock, IconNetwork, IconRefresh } from '@tabler/icons-react';
import { IamApiError, errorMessage, iamApi, isAbortError, type IamSettings } from '@/components/iam/api';
import { NO_POLICY, normalizeTokenPolicy, type TokenPolicyView } from '@/components/iam/tokens/tokenModel';
import { useTranslations } from '@/lib/i18n';

/** The server accepts 1..3650; a workspace cannot ask for more than ten years. */
const MAX_LIFETIME_DAYS = 3650;

interface Draft {
  /** '' = no maximum. */
  maxLifetimeDays: number | '';
  requireExpiry: boolean;
}

function toDraft(settings: IamSettings): Draft {
  return {
    maxLifetimeDays: settings.tokens.maxLifetimeDays ?? '',
    requireExpiry: settings.tokens.requireExpiry,
  };
}

function lifetimeValid(value: number | ''): boolean {
  return value === '' || (Number.isInteger(value) && value >= 1 && value <= MAX_LIFETIME_DAYS);
}

/**
 * IAM center, Settings tab: the workspace-wide rules that are not policies.
 * Today that is the API token policy (maximum lifetime, required expiry) plus a
 * note on per-token IP allowlists. Everyone who can open the center can read
 * it; changing it needs the `iam` admin permission (`canManage`), and the
 * server checks that again.
 */
export default function IamSettingsTab({ canManage }: { canManage: boolean }) {
  const t = useTranslations('iamTokens');
  const tCommon = useTranslations('common');

  const [saved, setSaved] = useState<IamSettings | null>(null);
  const [draft, setDraft] = useState<Draft>({ maxLifetimeDays: '', requireExpiry: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // How the server resolves a caller's address, for the allowlist note (best effort).
  const [network, setNetwork] = useState<TokenPolicyView>(NO_POLICY);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const settings = await iamApi.getSettings(signal);
      setSaved(settings);
      setDraft(toDraft(settings));
    } catch (error) {
      if (isAbortError(error)) return;
      setLoadError(
        error instanceof IamApiError && error.status === 403
          ? t('settings.forbidden')
          : errorMessage(error, t('settings.loadFailed')),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    fetch('/api/tokens/policy', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setNetwork(normalizeTokenPolicy(body)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  const valid = lifetimeValid(draft.maxLifetimeDays);
  const dirty = useMemo(() => {
    if (!saved) return false;
    const current = toDraft(saved);
    return current.maxLifetimeDays !== draft.maxLifetimeDays || current.requireExpiry !== draft.requireExpiry;
  }, [saved, draft]);

  // A maximum lifetime implies an expiry: the switch shows on (and is locked)
  // while one is set, and returns to the stored choice when the maximum is cleared.
  const maxSet = draft.maxLifetimeDays !== '';
  const effectiveRequired = draft.requireExpiry || maxSet;

  const save = async () => {
    if (!canManage || !dirty || !valid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await iamApi.updateSettings({
        tokens: {
          maxLifetimeDays: draft.maxLifetimeDays === '' ? null : draft.maxLifetimeDays,
          requireExpiry: draft.requireExpiry,
        },
      });
      setSaved(next);
      setDraft(toDraft(next));
      notifications.show({ color: 'green', message: t('settings.tokens.saved') });
    } catch (error) {
      setSaveError(errorMessage(error, t('settings.tokens.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !saved) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  if (loadError && !saved) {
    return (
      <Alert color="red" title={t('settings.loadFailed')} icon={<IconAlertTriangle size={16} />}>
        <Stack gap="xs">
          <Text size="sm">{loadError}</Text>
          <div>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void load()}>
              {t('settings.retry')}
            </Button>
          </div>
        </Stack>
      </Alert>
    );
  }

  const effect = !effectiveRequired
    ? t('settings.tokens.effect.none')
    : maxSet
      ? t('settings.tokens.effect.maximum', { days: draft.maxLifetimeDays })
      : t('settings.tokens.effect.required');

  return (
    <Stack gap="lg" maw={820}>
      {!canManage ? (
        <Alert color="gray" variant="light" icon={<IconLock size={16} />}>
          <Text size="sm">{t('settings.readOnly')}</Text>
        </Alert>
      ) : null}

      <Paper withBorder p="md" radius="md">
        <Stack gap="md">
          <Group gap="sm" align="flex-start" wrap="nowrap">
            <IconKey size={18} style={{ marginTop: 3, flexShrink: 0 }} />
            <div>
              <Text fw={600}>{t('settings.tokens.title')}</Text>
              <Text size="sm" c="dimmed">
                {t('settings.tokens.description')}
              </Text>
            </div>
          </Group>

          <NumberInput
            label={t('settings.tokens.maxLifetime.label')}
            description={t('settings.tokens.maxLifetime.description')}
            placeholder={t('settings.tokens.maxLifetime.placeholder')}
            value={draft.maxLifetimeDays}
            onChange={(value) =>
              setDraft((current) => ({ ...current, maxLifetimeDays: typeof value === 'number' ? value : '' }))
            }
            min={1}
            max={MAX_LIFETIME_DAYS}
            allowDecimal={false}
            allowNegative={false}
            clampBehavior="none"
            rightSection={
              <Text size="xs" c="dimmed" pr="xs">
                {t('settings.tokens.maxLifetime.unit')}
              </Text>
            }
            rightSectionWidth={56}
            disabled={!canManage || saving}
            error={valid ? undefined : t('settings.tokens.maxLifetime.invalid', { max: MAX_LIFETIME_DAYS })}
            w={{ base: '100%', sm: 320 }}
          />

          <Switch
            label={t('settings.tokens.requireExpiry.label')}
            description={maxSet ? t('settings.tokens.requireExpiry.implied') : t('settings.tokens.requireExpiry.description')}
            checked={effectiveRequired}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setDraft((current) => ({ ...current, requireExpiry: checked }));
            }}
            disabled={!canManage || saving || maxSet}
            // Locked on by the maximum lifetime: keep the text readable instead of washed out.
            styles={maxSet ? { label: { color: 'var(--mantine-color-text)' }, description: { color: 'var(--mantine-color-dimmed)' } } : undefined}
          />

          <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
            <Text size="sm">{effect}</Text>
          </Alert>

          {saveError ? (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">{saveError}</Text>
            </Alert>
          ) : null}

          {canManage ? (
            <Group gap="xs">
              <Button onClick={() => void save()} loading={saving} disabled={!dirty || !valid}>
                {t('settings.tokens.save')}
              </Button>
              <Button
                variant="default"
                disabled={!dirty || saving}
                onClick={() => {
                  if (saved) setDraft(toDraft(saved));
                  setSaveError(null);
                }}
              >
                {t('settings.tokens.discard')}
              </Button>
            </Group>
          ) : null}
        </Stack>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <Group gap="sm" align="flex-start" wrap="nowrap">
            <IconNetwork size={18} style={{ marginTop: 3, flexShrink: 0 }} />
            <div>
              <Text fw={600}>{t('settings.network.title')}</Text>
              <Text size="sm" c="dimmed">
                {t('settings.network.description')}
              </Text>
            </div>
          </Group>
          <Text size="sm" c="dimmed">
            {t('settings.network.proxy')}
          </Text>
          {network.trustsForwardedHeaders ? (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">{t('settings.network.openProxy')}</Text>
            </Alert>
          ) : null}
          <div>
            <Button component={Link} href="/dashboard/tokens" size="xs" variant="light" leftSection={<IconKey size={14} />}>
              {t('settings.network.manage')}
            </Button>
          </div>
        </Stack>
      </Paper>

      {loading && saved ? (
        <Text size="xs" c="dimmed">
          {tCommon('loading')}
        </Text>
      ) : null}
    </Stack>
  );
}
