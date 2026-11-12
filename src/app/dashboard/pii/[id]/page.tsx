'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Center,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ResourceUsageSection, useDeleteResource } from '@/components/common/confirm';
import {
  IconPlayerPlay,
  IconShieldLock,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import PageContainer from '@/components/common/ui/PageContainer';
import PiiPolicyEditor, { type PiiCustomPatternForm } from '@/components/pii/PiiPolicyEditor';
import PiiTestPanel from '@/components/pii/PiiTestPanel';
import PiiApiUsage from '@/components/pii/PiiApiUsage';
import { useLocale, useTranslations } from '@/lib/i18n';
import { errorMessage, isApiError } from '@/lib/api/client';
import {
  useDeletePiiPolicy,
  useLoadPiiCatalog,
  usePiiCatalog,
  usePiiPolicy,
  useTogglePiiPolicy,
  useUpdatePiiPolicy,
} from '@/lib/api/queries/pii';
import type { CategoryCatalogEntry, PiiAction, PiiEngine } from '@/lib/services/pii/types';

const NO_CATALOG: CategoryCatalogEntry[] = [];
const NO_DEFAULTS: Record<string, boolean> = {};

export default function PiiPolicyDetailPage() {
  const params = useParams<{ id: string }>()!;
  const router = useRouter();
  const t = useTranslations('pii');
  const tSafe = useTranslations('common.confirm.dataSafety');
  const deleteResource = useDeleteResource();
  const tAct = useTranslations('pii.actions');
  const tEngine = useTranslations('pii.engines');
  const locale = useLocale();

  const policyQuery = usePiiPolicy(params.id);
  const policy = policyQuery.data ?? null;
  /** The policy the form below was last filled from: the form is ready once it matches the loaded policy. */
  const [filledFrom, setFilledFrom] = useState<typeof policy>(null);
  const ready = policy !== null && filledFrom === policy;
  const updatePolicy = useUpdatePiiPolicy();
  const togglePolicy = useTogglePiiPolicy();
  const deletePolicy = useDeletePiiPolicy();
  const loadCatalog = useLoadPiiCatalog();
  const [activeTab, setActiveTab] = useState<string>('config');

  // editable state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [defaultAction, setDefaultAction] = useState<PiiAction>('detect');
  const [engine, setEngine] = useState<PiiEngine>('regex');
  const [categories, setCategories] = useState<Record<string, boolean>>({});
  const [customPatterns, setCustomPatterns] = useState<PiiCustomPatternForm[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [minConfidence, setMinConfidence] = useState(0);
  const [contextBoost, setContextBoost] = useState(true);

  const catalogQuery = usePiiCatalog(locale, ready ? engine : undefined);
  const catalog = useMemo(() => catalogQuery.data?.categories ?? NO_CATALOG, [catalogQuery.data]);
  const defaultCategories = catalogQuery.data?.defaults ?? NO_DEFAULTS;

  // The form starts from the policy the server has now, and starts over whenever the policy is read again with
  // different content (after a save).
  useEffect(() => {
    if (!policy) return;
    setName(policy.name);
    setDescription(policy.description ?? '');
    setEnabled(policy.enabled);
    setDefaultAction(policy.defaultAction);
    setEngine(policy.engine ?? 'regex');
    setCategories(policy.categories ?? {});
    setCustomPatterns(
      (policy.customPatterns ?? []).map((cp) => ({
        ...cp,
        id: cp.id ?? Math.random().toString(36).slice(2),
      })),
    );
    setLanguages(policy.languages ?? []);
    setMinConfidence(policy.detection?.minConfidence ?? 0);
    setContextBoost(policy.detection?.contextBoost !== false);
    setFilledFrom(policy);
  }, [policy]);

  const loadError = policyQuery.error;
  useEffect(() => {
    if (!loadError) return;
    if (isApiError(loadError) && loadError.status === 404) {
      router.replace('/dashboard/pii');
      return;
    }
    notifications.show({
      title: t('notifications.loadError'),
      message: errorMessage(loadError, ''),
      color: 'red',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadError]);

  const catalogError = catalogQuery.error;
  useEffect(() => {
    if (!catalogError) return;
    notifications.show({
      title: t('notifications.loadError'),
      message: errorMessage(catalogError, ''),
      color: 'red',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogError]);

  /**
   * Switching engines is a full reset of category selection, not a merge —
   * the two engines don't share a category id vocabulary (`tc_kimlik` vs
   * `tckn`, etc. — see `PiiEngine`'s own doc comment), so a category map
   * built under one engine is meaningless under the other. Falls straight
   * back to that engine's own defaults, matching what a brand-new policy
   * created with this engine would start with.
   */
  const handleEngineChange = async (next: PiiEngine) => {
    setEngine(next);
    try {
      const { defaults } = await loadCatalog(locale, next);
      setCategories(defaults);
    } catch {
      // The catalog query of the new engine reports the failure (see `catalogError`).
    }
  };

  // Make sure all catalog ids exist in `categories` map (default for new keys)
  useEffect(() => {
    if (!catalog.length) return;
    setCategories((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of catalog) {
        if (next[c.id] === undefined) {
          next[c.id] = defaultCategories[c.id] ?? c.defaultEnabled;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [catalog, defaultCategories, filledFrom]);

  const save = async () => {
    if (!policy) return;
    try {
      await updatePolicy.mutateAsync({
        id: policy.id,
        name,
        description,
        enabled,
        defaultAction,
        engine,
        categories,
        customPatterns,
        languages,
        detection: { minConfidence, contextBoost },
      });
      notifications.show({
        title: t('notifications.updated'),
        message: name,
        color: 'teal',
      });
    } catch (err) {
      notifications.show({
        title: t('notifications.saveError'),
        message: errorMessage(err, ''),
        color: 'red',
      });
    }
  };

  const handleDelete = async () => {
    if (!policy) return;
    await deleteResource({
      noun: tSafe('nouns.piiPolicy'),
      name: policy.name,
      type: 'pii-policy',
      id: policy.id,
      action: async () => {
        await deletePolicy.mutateAsync(policy.id);
        notifications.show({ title: t('notifications.deleted'), message: name, color: 'red' });
        router.push('/dashboard/pii');
      },
    });
  };

  const handleToggleEnabled = async () => {
    if (!policy) return;
    setEnabled(!enabled);
    try {
      await togglePolicy.mutateAsync({ id: policy.id, enabled: !enabled });
    } catch {
      setEnabled(enabled);
    }
  };

  if (!policy || !ready || (catalogQuery.isPending && !catalogQuery.isError)) {
    return (
      <PageContainer>
        <Center mih={240}><Loader /></Center>
      </PageContainer>
    );
  }

  const tabs = [
    { id: 'config', label: t('detail.tabs.config') },
    { id: 'test', label: t('detail.tabs.test') },
    { id: 'api', label: t('detail.tabs.api') },
  ];

  const actions = (
    <>
      <Button
        variant="default"
        size="sm"
        leftSection={enabled ? <IconShieldOff size={14} stroke={1.7} /> : <IconPlayerPlay size={14} stroke={1.7} />}
        onClick={() => void handleToggleEnabled()}
      >
        {enabled ? t('detail.actions.toggleDisable') : t('detail.actions.toggleEnable')}
      </Button>
      <Button
        color="red"
        variant="light"
        size="sm"
        leftSection={<IconTrash size={14} stroke={1.7} />}
        onClick={() => void handleDelete()}
      >
        {t('detail.actions.delete')}
      </Button>
    </>
  );

  return (
    <DetailShell
      backHref="/dashboard/pii"
      backLabel={t('detail.backToList')}
      icon={
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: 'var(--ds-accent-soft)',
            color: 'var(--ds-accent)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <IconShieldLock size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
            {name}
          </h1>
          <StatusBadge
            status={enabled ? 'ok' : 'paused'}
            label={enabled ? 'Enabled' : 'Disabled'}
          />
          <span className="ds-badge ds-badge-info">{tAct(defaultAction)}</span>
          <span className="ds-badge">{tEngine(engine)}</span>
        </>
      }
      meta={
        <>
          <span className="ds-mono">{policy.key}</span>
          {description ? (
            <>
              <span className="ds-faint">·</span>
              <span>{description}</span>
            </>
          ) : null}
        </>
      }
      actions={actions}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {activeTab === 'config' ? (
        <Stack gap="md">
          <Paper p="md" withBorder radius="sm">
            <Stack gap="xs">
              <TextInput
                label={t('detail.basics.name')}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
              <Textarea
                label={t('detail.basics.description')}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                autosize
                minRows={2}
              />
              <Group>
                <Switch
                  label={t('detail.basics.enabled')}
                  checked={enabled}
                  onChange={(e) => setEnabled(e.currentTarget.checked)}
                />
                <Group gap={4}>
                  <Text size="xs" c="dimmed">{t('detail.basics.key')}</Text>
                  <Code>{policy.key}</Code>
                </Group>
              </Group>
            </Stack>
          </Paper>

          <PiiPolicyEditor
            categories={categories}
            onCategoriesChange={setCategories}
            customPatterns={customPatterns}
            onCustomPatternsChange={setCustomPatterns}
            languages={languages}
            onLanguagesChange={setLanguages}
            defaultAction={defaultAction}
            onDefaultActionChange={setDefaultAction}
            engine={engine}
            onEngineChange={(next) => void handleEngineChange(next)}
            catalog={catalog}
            minConfidence={minConfidence}
            onMinConfidenceChange={setMinConfidence}
            contextBoost={contextBoost}
            onContextBoostChange={setContextBoost}
          />

          <Group justify="flex-end">
            <Button color="teal" onClick={() => void save()} loading={updatePolicy.isPending}>
              {updatePolicy.isPending ? t('detail.actions.saving') : t('detail.actions.save')}
            </Button>
          </Group>

          <Paper p="md" withBorder radius="sm">
            <ResourceUsageSection type="pii-policy" id={policy.id} />
          </Paper>
        </Stack>
      ) : null}

      {activeTab === 'test' ? (
        <PiiTestPanel
          categories={categories}
          customPatterns={customPatterns}
          languages={languages}
          engine={engine}
          minConfidence={minConfidence}
          contextBoost={contextBoost}
        />
      ) : null}

      {activeTab === 'api' ? (
        <PiiApiUsage
          policyKey={policy.key}
          policyName={policy.name}
          defaultAction={defaultAction}
        />
      ) : null}
    </DetailShell>
  );
}
