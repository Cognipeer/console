'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Checkbox, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconPlug } from '@tabler/icons-react';
import FormShell, {
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { DOMAIN_LABELS } from '@/lib/services/serviceCatalog';
import {
  diffAssignment,
  filterProjects,
  groupAssignCandidates,
  modelFlowHref,
  pickModelFlowProject,
  providersInDomain,
  setAll,
  toggleId,
  type AccessProject,
} from './providerAccessModel';

/** The tenant's projects with their per-domain provider counts (`GET /api/projects?include=stats`). */
export function useTenantProjects(enabled = true) {
  const [projects, setProjects] = useState<AccessProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let aborted = false;
    setLoading(true);
    setError(null);
    fetch('/api/projects?include=stats', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || 'Failed to load projects');
        }
        return (await res.json()) as { projects?: AccessProject[]; activeProjectId?: string };
      })
      .then((data) => {
        if (aborted) return;
        setProjects(data.projects ?? []);
        setActiveProjectId(data.activeProjectId);
      })
      .catch((e: unknown) => {
        if (!aborted) setError(e instanceof Error ? e.message : 'Failed to load projects');
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [enabled]);

  return { projects, activeProjectId, loading, error };
}

export interface ProjectPickerProps {
  projects: AccessProject[];
  domain: string;
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Group projects without a provider of the domain first, as "Recommended". */
  groupRecommended?: boolean;
}

/** Searchable, grouped multi-select of tenant projects. Shared by the create form and the assign step. */
export function ProjectPicker({
  projects,
  domain,
  selected,
  onChange,
  groupRecommended = true,
}: ProjectPickerProps) {
  const t = useTranslations('providerAccess.projects');
  const [query, setQuery] = useState('');
  const domainLabel = DOMAIN_LABELS[domain as keyof typeof DOMAIN_LABELS] ?? domain;

  const groups = useMemo(() => {
    if (groupRecommended) return groupAssignCandidates(projects, domain, { query });
    return {
      recommended: [] as AccessProject[],
      others: filterProjects(projects, query).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [projects, domain, query, groupRecommended]);

  const shownIds = [...groups.recommended, ...groups.others].map((p) => p._id);

  if (projects.length === 0) {
    return (
      <div className="ds-empty" style={{ padding: 24 }}>
        <span className="ds-muted" style={{ fontSize: 13 }}>
          {t('noneYet')}
        </span>
      </div>
    );
  }

  const renderRow = (p: AccessProject) => {
    const count = providersInDomain(p, domain);
    return (
      <div
        key={p._id}
        className="ds-row-between"
        style={{ padding: '8px 0', borderBottom: '1px solid var(--ds-border)', gap: 12 }}
      >
        <Checkbox
          color="teal"
          checked={selected.has(p._id)}
          onChange={() => onChange(toggleId(selected, p._id))}
          label={
            <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
              <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
                {p.key}
              </span>
            </span>
          }
        />
        <span className="ds-faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {count > 0 ? t('providersIn', { count, domain: domainLabel }) : t('none')}
        </span>
      </div>
    );
  };

  return (
    <div>
      <div
        className="ds-toolbar"
        style={{ marginBottom: 8, padding: 0, border: 'none', background: 'transparent' }}
      >
        <div className="ds-toolbar-search" style={{ flex: 1, maxWidth: 380 }}>
          <input
            placeholder={t('searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('search')}
          />
        </div>
        <Button
          variant="subtle"
          size="xs"
          color="teal"
          onClick={() => onChange(setAll(selected, shownIds, true))}
          disabled={shownIds.length === 0}
        >
          {t('selectAll')}
        </Button>
        <Button
          variant="subtle"
          size="xs"
          color="gray"
          onClick={() => onChange(setAll(selected, shownIds, false))}
          disabled={shownIds.length === 0}
        >
          {t('clear')}
        </Button>
      </div>

      {shownIds.length === 0 ? (
        <div className="ds-empty" style={{ padding: 24 }}>
          <span className="ds-muted" style={{ fontSize: 13 }}>
            {t('empty')}
          </span>
        </div>
      ) : null}

      {groups.recommended.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <div className="ds-row" style={{ gap: 8, margin: '8px 0 2px' }}>
            <span className="ds-badge ds-badge-teal">{t('recommended')}</span>
            <span className="ds-faint" style={{ fontSize: 12 }}>
              {t('recommendedHint', { domain: domainLabel })}
            </span>
          </div>
          {groups.recommended.map(renderRow)}
        </div>
      ) : null}

      {groups.others.length > 0 ? (
        <div>
          {groupRecommended && groups.recommended.length > 0 ? (
            <div className="ds-muted" style={{ fontSize: 12, margin: '8px 0 2px' }}>
              {t('others')}
            </div>
          ) : null}
          {groups.others.map(renderRow)}
        </div>
      ) : null}
    </div>
  );
}

export interface ProviderAssignTarget {
  id: string;
  name: string;
  key?: string;
  domain: string;
}

export interface ProviderAssignStepProps {
  opened: boolean;
  provider: ProviderAssignTarget;
  /** `created`: step 2 right after create (Skip for now); `existing`: assigning a stored provider. */
  variant: 'created' | 'existing';
  /** Projects the provider is assigned to already (existing variant). */
  initialProjectIds?: string[];
  /** Deployments the connection test found, listed for the model domain. */
  foundDeployments?: string[];
  /** Closes the shell (skip, cancel or after a successful assignment). */
  onClose: () => void;
  /** Called after the assignment was saved, with the resulting project ids. */
  onAssigned?: (projectIds: string[]) => void;
}

/**
 * "Assign to projects": the second step of provider creation and, standalone, the assign flow of an
 * existing provider. The whole assignment is written with `PATCH /api/providers/:id?scope=tenant`.
 */
export default function ProviderAssignStep({
  opened,
  provider,
  variant,
  initialProjectIds,
  foundDeployments,
  onClose,
  onAssigned,
}: ProviderAssignStepProps) {
  const t = useTranslations('providerAccess.assign');
  const tp = useTranslations('providerAccess.projects');
  const router = useRouter();
  const { projects, activeProjectId, loading, error } = useTenantProjects(opened);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<'assign' | 'models' | null>(null);
  const before = useMemo(() => initialProjectIds ?? [], [initialProjectIds]);

  useEffect(() => {
    if (opened) setSelected(new Set(before));
  }, [opened, before]);

  const isModel = provider.domain === 'model';
  const domainLabel = DOMAIN_LABELS[provider.domain as keyof typeof DOMAIN_LABELS] ?? provider.domain;
  const diff = diffAssignment(before, [...selected]);
  const changed = diff.added.length > 0 || diff.removed.length > 0;

  const save = async (): Promise<string[] | null> => {
    const res = await fetch(`/api/providers/${encodeURIComponent(provider.id)}?scope=tenant`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectIds: diff.next }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      notifications.show({
        color: 'red',
        title: t('assignFailed'),
        message: body?.error || t('assignFailed'),
      });
      return null;
    }
    notifications.show({
      color: 'teal',
      title: provider.name,
      message: t('assigned', { count: diff.next.length }),
    });
    onAssigned?.(diff.next);
    return diff.next;
  };

  const handleAssign = async () => {
    setSaving('assign');
    try {
      if ((await save()) !== null) onClose();
    } finally {
      setSaving(null);
    }
  };

  const handleAssignAndAddModels = async () => {
    setSaving('models');
    try {
      const ids = await save();
      if (ids === null) return;
      const target = pickModelFlowProject(ids, activeProjectId);
      if (!target) {
        onClose();
        return;
      }
      if (target.needsSwitch) {
        const res = await fetch('/api/projects/active', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: target.projectId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          notifications.show({
            color: 'red',
            title: provider.name,
            message: body?.error || t('assignFailed'),
          });
          onClose();
          return;
        }
        // The active project is a cookie the whole shell reads: reload into the models page.
        window.location.assign(modelFlowHref(provider.key ?? provider.id));
        return;
      }
      onClose();
      router.push(modelFlowHref(provider.key ?? provider.id));
    } finally {
      setSaving(null);
    }
  };

  const created = variant === 'created';
  const nothingSelected = selected.size === 0;

  const summary = (
    <>
      <SummaryGroup title={provider.name}>
        <SummaryKV label="Domain" value={domainLabel} />
        {provider.key ? <SummaryKV label="Key" value={provider.key} mono /> : null}
        <SummaryKV label={tp('sectionTitle')} value={tp('selected', { count: selected.size })} />
      </SummaryGroup>
      {!created && diff.removed.length > 0 ? (
        <SummaryGroup title={t('assign')}>
          <span className="ds-muted" style={{ fontSize: 12.5 }}>
            {t('unassignNotice', { count: diff.removed.length })}
          </span>
        </SummaryGroup>
      ) : null}
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconPlug size={16} />}
      title={t('title')}
      subtitle={
        created
          ? t('subtitle', { name: provider.name })
          : t('subtitleExisting', { name: provider.name })
      }
      summary={summary}
      footerStatus={created ? t('stepLabel') : tp('selected', { count: selected.size })}
      footerLeft={
        isModel && created ? (
          <Button
            variant="default"
            size="sm"
            disabled={nothingSelected || saving !== null}
            loading={saving === 'models'}
            onClick={() => void handleAssignAndAddModels()}
          >
            {t('assignAndAdd')}
          </Button>
        ) : null
      }
      secondaryAction={
        created
          ? { label: t('skip'), variant: 'default', onClick: onClose }
          : undefined
      }
      primaryAction={{
        label: created ? t('assign') : t('save'),
        loading: saving === 'assign',
        disabled: created ? nothingSelected || saving !== null : !changed || saving !== null,
        onClick: () => void handleAssign(),
      }}
    >
      <FormSection
        number={1}
        title={tp('sectionTitle')}
        description={created ? t('unassignedWarning') : tp('sectionDescription')}
        done={!nothingSelected}
      >
        {loading ? (
          <div className="ds-empty" style={{ padding: 24 }}>
            <Loader size="sm" color="teal" />
          </div>
        ) : error ? (
          <Alert icon={<IconAlertCircle size={16} />} color="red" title={tp('loadFailed')}>
            {error}
          </Alert>
        ) : (
          <ProjectPicker
            projects={projects}
            domain={provider.domain}
            selected={selected}
            onChange={setSelected}
          />
        )}
      </FormSection>

      {isModel && foundDeployments && foundDeployments.length > 0 ? (
        <FormSection number={2} title={t('modelsFound')}>
          <div className="ds-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {foundDeployments.slice(0, 30).map((d) => (
              <span key={d} className="ds-badge ds-badge-info ds-mono">
                {d}
              </span>
            ))}
            {foundDeployments.length > 30 ? (
              <span className="ds-faint" style={{ fontSize: 12 }}>
                +{foundDeployments.length - 30}
              </span>
            ) : null}
          </div>
        </FormSection>
      ) : null}
    </FormShell>
  );
}

/** Standalone assign flow of an existing provider (list row action, detail page). */
export function AssignProviderShell(props: Omit<ProviderAssignStepProps, 'variant'>) {
  return <ProviderAssignStep {...props} variant="existing" />;
}
