'use client';

/**
 * Agents → Templates: the gallery. Search, a category filter and capability
 * chips narrow the catalog; a card opens the detail drawer, whose "Use template"
 * opens the full-screen create form.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Loader, TextInput, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconSearch, IconStar } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { useTranslations } from '@/lib/i18n';
import {
  AGENT_TEMPLATE_CAPABILITIES,
  AGENT_TEMPLATE_CATEGORIES,
  type AgentTemplateCapability,
  type AgentTemplateCategory,
  type AgentTemplateSummary,
} from '@/lib/services/agents/templates/types';
import styles from './AgentTemplatesPage.module.css';
import { TemplateIcon } from './templateIcons';
import TemplateDetailDrawer from './TemplateDetailDrawer';
import UseAgentTemplateShell from './UseAgentTemplateShell';
import { EMPTY_GALLERY_FILTER, filterTemplates, groupTemplates, isFilterActive, type GalleryFilter } from './templatesModel';

const MAX_CARD_CHIPS = 4;
const BADGE_COLOR = { ready: 'teal', needs_setup: 'yellow', unavailable: 'gray' } as const;

export default function AgentTemplatesPage() {
  const router = useRouter();
  const t = useTranslations('agentTemplates');
  const [templates, setTemplates] = useState<AgentTemplateSummary[]>([]);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_GALLERY_FILTER);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [useKey, setUseKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch('/api/agents/templates', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTemplates(data.templates ?? []);
      setCatalogVersion(data.catalogVersion ?? 0);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const searchText = useCallback(
    (template: AgentTemplateSummary) =>
      `${template.key} ${t(`items.${template.key}.name`)} ${t(`items.${template.key}.summary`)}`,
    [t],
  );
  const visible = useMemo(() => filterTemplates(templates, filter, searchText), [templates, filter, searchText]);
  const groups = useMemo(() => groupTemplates(visible), [visible]);
  const showFeatured = !isFilterActive(filter) && groups.featured.length > 0;

  const toggleCapability = (capability: AgentTemplateCapability) => {
    const next = new Set(filter.capabilities);
    if (next.has(capability)) next.delete(capability);
    else next.add(capability);
    setFilter({ ...filter, capabilities: next });
  };

  const renderCard = (template: AgentTemplateSummary) => {
    const name = t(`items.${template.key}.name`);
    const shown = template.capabilities.slice(0, MAX_CARD_CHIPS);
    const extra = template.capabilities.length - shown.length;
    const status = template.availability.status;
    return (
      <button
        type="button"
        key={template.key}
        className={styles.card}
        aria-label={t('ui.page.openTemplate', { name })}
        onClick={() => setOpenKey(template.key)}
      >
        <span className={styles.cardHead}>
          <span className={styles.cardIcon}><TemplateIcon name={template.icon} /></span>
          <span className={styles.cardName}>{name}</span>
          {status !== 'ready' ? (
            <Badge size="xs" variant="light" color={BADGE_COLOR[status]}>{t(`availability.status.${status}`)}</Badge>
          ) : null}
        </span>
        <span className={styles.cardSummary}>{t(`items.${template.key}.summary`)}</span>
        <span className={styles.cardFoot}>
          {shown.map((capability) => (
            <Badge key={capability} size="xs" variant="outline" color="gray">{t(`capabilities.${capability}`)}</Badge>
          ))}
          {extra > 0 ? <Badge size="xs" variant="outline" color="gray">{t('ui.page.moreCapabilities', { count: extra })}</Badge> : null}
          <span className={styles.where}>{template.surfaces.map((surface) => t(`surfaces.${surface}`)).join(' · ')}</span>
        </span>
      </button>
    );
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('ui.page.eyebrow')}
        title={t('ui.page.title')}
        subtitle={t('ui.page.subtitle')}
        actions={
          <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/agents')}>
            {t('ui.page.back')}
          </Button>
        }
      />

      <div className={styles.toolbar}>
        <div className="ds-row ds-gap-sm">
          <TextInput
            style={{ flex: 1, maxWidth: 420 }}
            leftSection={<IconSearch size={14} />}
            placeholder={t('ui.page.searchPlaceholder')}
            aria-label={t('ui.page.searchLabel')}
            value={filter.query}
            onChange={(event) => setFilter({ ...filter, query: event.currentTarget.value })}
          />
          {templates.length > 0 ? (
            <span className="ds-muted" style={{ fontSize: 12 }}>
              {t('ui.page.count', { count: templates.length, version: catalogVersion })}
            </span>
          ) : null}
        </div>
        <div className={styles.chips} role="group" aria-label={t('ui.page.categoryFilter')}>
          {(['all', ...AGENT_TEMPLATE_CATEGORIES] as Array<AgentTemplateCategory | 'all'>).map((category) => (
            <Button
              key={category}
              size="compact-sm"
              radius="xl"
              variant={filter.category === category ? 'filled' : 'default'}
              color={filter.category === category ? 'teal' : 'gray'}
              aria-pressed={filter.category === category}
              onClick={() => setFilter({ ...filter, category })}
            >
              {category === 'all' ? t('ui.page.all') : t(`categories.${category}`)}
            </Button>
          ))}
        </div>
        <div className={styles.chips} role="group" aria-label={t('ui.page.capabilityFilter')}>
          <span className={styles.chipLabel}>{t('ui.page.capabilityFilter')}</span>
          {AGENT_TEMPLATE_CAPABILITIES.map((capability) => {
            const active = filter.capabilities.has(capability);
            return (
              <Button
                key={capability}
                size="compact-xs"
                radius="xl"
                variant={active ? 'light' : 'default'}
                color={active ? 'teal' : 'gray'}
                aria-pressed={active}
                onClick={() => toggleCapability(capability)}
              >
                {t(`capabilities.${capability}`)}
              </Button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="ds-empty"><Loader size="sm" /></div>
      ) : failed ? (
        <Alert color="red" title={t('ui.page.loadFailed')}>
          <Button size="xs" variant="default" onClick={() => void load()}>{t('ui.page.retry')}</Button>
        </Alert>
      ) : visible.length === 0 ? (
        <div className="ds-empty">
          <div className="ds-h4" style={{ marginBottom: 4 }}>{t('ui.page.noResults')}</div>
          <p className="ds-muted" style={{ fontSize: 13, marginBottom: 12 }}>{t('ui.page.noResultsHint')}</p>
          <Button size="xs" variant="default" onClick={() => setFilter(EMPTY_GALLERY_FILTER)}>{t('ui.page.clearFilters')}</Button>
        </div>
      ) : (
        <>
          {showFeatured ? (
            <section className={styles.section} aria-label={t('ui.page.featured')}>
              <h2 className={styles.sectionTitle}>
                <Tooltip label={t('ui.page.featured')}><IconStar size={13} style={{ verticalAlign: -2, marginRight: 4 }} /></Tooltip>
                {t('ui.page.featured')}
              </h2>
              <div className={styles.grid}>{groups.featured.map(renderCard)}</div>
            </section>
          ) : null}
          {groups.categories.map((group) => (
            <section key={group.category} className={styles.section} aria-label={t(`categories.${group.category}`)}>
              <h2 className={styles.sectionTitle}>{t(`categories.${group.category}`)}</h2>
              <div className={styles.grid}>{group.templates.map(renderCard)}</div>
            </section>
          ))}
        </>
      )}

      <TemplateDetailDrawer
        templateKey={openKey}
        onClose={() => setOpenKey(null)}
        onUse={(key) => { setOpenKey(null); setUseKey(key); }}
      />
      <UseAgentTemplateShell
        templateKey={useKey}
        onClose={() => setUseKey(null)}
        onOpenAgent={(agentId) => router.push(`/dashboard/agents/${agentId}`)}
      />
    </PageContainer>
  );
}
