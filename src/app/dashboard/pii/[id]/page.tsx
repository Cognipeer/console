'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconPlayerPlay,
  IconShieldLock,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import PageContainer from '@/components/common/ui/PageContainer';
import PiiPolicyEditor, {
  type PiiCatalogEntry,
  type PiiCustomPatternForm,
} from '@/components/pii/PiiPolicyEditor';
import PiiTestPanel from '@/components/pii/PiiTestPanel';
import PiiApiUsage from '@/components/pii/PiiApiUsage';
import { useLocale, useTranslations } from '@/lib/i18n';

interface PolicyView {
  id: string;
  key: string;
  name: string;
  description?: string;
  defaultAction: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize';
  categories: Record<string, boolean>;
  customPatterns?: PiiCustomPatternForm[];
  languages?: string[];
  enabled: boolean;
}

export default function PiiPolicyDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations('pii');
  const tAct = useTranslations('pii.actions');
  const locale = useLocale();

  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [catalog, setCatalog] = useState<PiiCatalogEntry[]>([]);
  const [defaultCategories, setDefaultCategories] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('config');

  // editable state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [defaultAction, setDefaultAction] = useState<PolicyView['defaultAction']>('detect');
  const [categories, setCategories] = useState<Record<string, boolean>>({});
  const [customPatterns, setCustomPatterns] = useState<PiiCustomPatternForm[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const [polRes, catRes] = await Promise.all([
        fetch(`/api/pii/policies/${params.id}`, { cache: 'no-store' }),
        fetch(`/api/pii/categories?locale=${encodeURIComponent(locale)}`, { cache: 'no-store' }),
      ]);
      if (!polRes.ok) {
        if (polRes.status === 404) {
          router.replace('/dashboard/pii');
          return;
        }
        throw new Error('Failed to load policy');
      }
      const polData = await polRes.json();
      const p: PolicyView = polData.policy;
      setPolicy(p);
      setName(p.name);
      setDescription(p.description ?? '');
      setEnabled(p.enabled);
      setDefaultAction(p.defaultAction);
      setCategories(p.categories ?? {});
      setCustomPatterns(
        (p.customPatterns ?? []).map((cp) => ({
          ...cp,
          id: cp.id ?? Math.random().toString(36).slice(2),
        })),
      );
      setLanguages(p.languages ?? []);

      if (catRes.ok) {
        const catData = await catRes.json();
        setCatalog(catData.categories ?? []);
        setDefaultCategories(catData.defaults ?? {});
      }
    } catch (err) {
      notifications.show({
        title: t('notifications.loadError'),
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [params.id, locale]);

  // Reload catalog when locale changes so labels update without full reload
  useEffect(() => {
    if (!policy) return;
    void fetch(`/api/pii/categories?locale=${encodeURIComponent(locale)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.categories) setCatalog(d.categories);
        if (d?.defaults) setDefaultCategories(d.defaults);
      })
      .catch(() => {});
  }, [locale]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [catalog, defaultCategories]);

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/pii/policies/${policy.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          enabled,
          defaultAction,
          categories,
          customPatterns,
          languages,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed');
      }
      notifications.show({
        title: t('notifications.updated'),
        message: name,
        color: 'teal',
      });
      await load();
    } catch (err) {
      notifications.show({
        title: t('notifications.saveError'),
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!policy) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/pii/policies/${policy.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed');
      notifications.show({ title: t('notifications.deleted'), message: name, color: 'red' });
      router.push('/dashboard/pii');
    } catch (err) {
      notifications.show({
        title: t('notifications.saveError'),
        message: err instanceof Error ? err.message : '',
        color: 'red',
      });
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!policy) return;
    setEnabled(!enabled);
    try {
      await fetch(`/api/pii/policies/${policy.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
    } catch {
      setEnabled(enabled);
    }
  };

  if (loading || !policy) {
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
        onClick={() => setDeleteOpen(true)}
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
            catalog={catalog}
          />

          <Group justify="flex-end">
            <Button color="teal" onClick={() => void save()} loading={saving}>
              {saving ? t('detail.actions.saving') : t('detail.actions.save')}
            </Button>
          </Group>
        </Stack>
      ) : null}

      {activeTab === 'test' ? (
        <PiiTestPanel
          categories={categories}
          customPatterns={customPatterns}
          languages={languages}
        />
      ) : null}

      {activeTab === 'api' ? (
        <PiiApiUsage
          policyKey={policy.key}
          policyName={policy.name}
          defaultAction={defaultAction}
        />
      ) : null}

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title={t('deleteModal.title')} centered size="sm">
        <Text size="sm" mb="lg">{t('deleteModal.body', { name })}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>{t('deleteModal.cancel')}</Button>
          <Button color="red" loading={deleting} onClick={handleDelete}>{t('deleteModal.confirm')}</Button>
        </Group>
      </Modal>
    </DetailShell>
  );
}
