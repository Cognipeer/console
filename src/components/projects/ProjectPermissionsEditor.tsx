'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Group, Loader, SegmentedControl, Text, TextInput, Tooltip } from '@mantine/core';
import { IconArrowRight, IconInfoCircle, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import FormShell, { SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useConfirm } from '@/components/common/confirm';
import { iamApi, isAbortError, type IamLevel } from '@/components/iam/api';
import { useTranslations } from '@/lib/i18n';
import type { ServicePermissionLevel, UserServicePermissions } from '@/lib/security/rbac';
import {
  changedServices,
  effectiveLevel,
  exceedsWorkspace,
  GRANTABLE_SERVICES,
  ignoredEntries,
  inferIgnoredNone,
  limitCount,
  PROJECT_CHOICES,
  readStored,
  toPermissions,
  type ProjectChoice,
} from './projectPermissionsModel';

export interface PermissionsEditorMember {
  userId: string;
  name: string;
  email: string;
  /** Workspace role. */
  role: string;
  /** Stored project levels. */
  servicePermissions?: UserServicePermissions | null;
  /**
   * Services whose stored "no access" the engine reads as not set, when the
   * members API says so. Absent: the editor works it out from the member's
   * effective permissions in this project, if it may read them.
   */
  ignoredServices?: string[];
}

interface ProjectPermissionsEditorProps {
  member: PermissionsEditorMember;
  /** The project the limits are for. */
  projectId: string;
  saving: boolean;
  onClose: () => void;
  onSave: (permissions: UserServicePermissions) => void;
}

const LEVEL_COLOR: Record<ServicePermissionLevel, string> = { none: 'gray', read: 'blue', write: 'orange', admin: 'red' };

type FilterMode = 'all' | 'limited';

interface PrincipalView {
  /** Level per service (for one project when asked for one, else for the whole workspace). */
  levels: Record<string, IamLevel>;
  /** Services where a project setting narrows the level (the effective-permissions table names the project as a source). */
  limitedByProject: ReadonlySet<string>;
}

/**
 * What the IAM center knows about a person: their level per service and which of
 * those levels a project setting narrows. `view` stays `null` while it loads, and
 * when the caller cannot read the IAM center - the editor then works without it.
 */
function usePrincipalView(
  userId: string,
  projectId: string | undefined,
  enabled: boolean,
): { view: PrincipalView | null; loading: boolean } {
  const [state, setState] = useState<{ view: PrincipalView | null; loading: boolean }>({ view: null, loading: enabled });
  useEffect(() => {
    if (!enabled) {
      setState({ view: null, loading: false });
      return;
    }
    const controller = new AbortController();
    setState({ view: null, loading: true });
    iamApi
      .getPrincipal('user', userId, projectId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        const levels: Record<string, IamLevel> = {};
        const limitedByProject = new Set<string>();
        for (const row of detail.effective) {
          levels[row.service] = row.level;
          if (row.sources.some((source) => source.kind === 'project')) limitedByProject.add(row.service);
        }
        setState({ view: { levels, limitedByProject }, loading: false });
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setState({ view: null, loading: false });
      });
    return () => controller.abort();
  }, [userId, projectId, enabled]);
  return state;
}

function LevelBadge({ level, label }: { level: ServicePermissionLevel; label: string }) {
  return (
    <Badge variant={level === 'none' ? 'default' : 'light'} color={LEVEL_COLOR[level]}>
      {label}
    </Badge>
  );
}

const asInherit = (services: readonly string[]): Record<string, ProjectChoice> =>
  Object.fromEntries(services.map((id) => [id, 'inherit' as const]));

/**
 * Per-service project levels of one member, as a full-screen editor. Each service
 * is either "Inherit" (nothing is stored; the workspace level stands) or an
 * explicit level - including an explicit "No access". Unset is never shown as
 * "None", and only what was chosen is saved.
 */
export default function ProjectPermissionsEditor({ member, projectId, saving, onClose, onSave }: ProjectPermissionsEditorProps) {
  const t = useTranslations('projectMembers');
  const root = useTranslations();
  const { confirm } = useConfirm();

  const declaredIgnored = member.ignoredServices;
  const initial = useMemo(
    () => readStored(member.servicePermissions, declaredIgnored ?? []),
    [member.servicePermissions, declaredIgnored],
  );
  // The choices as stored (the baseline of "unsaved changes") and as edited.
  const [baseline, setBaseline] = useState<Record<string, ProjectChoice>>(initial.choices);
  const [draft, setDraft] = useState<Record<string, ProjectChoice>>(initial.choices);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<FilterMode>('all');

  const { view: workspaceView, loading: workspaceLoading } = usePrincipalView(member.userId, undefined, true);
  const workspace = workspaceView?.levels ?? null;

  // A "No access" saved before project levels were enforced is not enforced: the engine reads it as not set. The
  // members API names those services when it can (`ignoredServices`). When it does not, the member's effective
  // permissions in this project tell: a "No access" that no project setting narrows, on a service the member does
  // reach in the workspace, has no effect.
  const storedNone = useMemo(
    () => GRANTABLE_SERVICES.filter((s) => initial.choices[s.id] === 'none').map((s) => s.id),
    [initial.choices],
  );
  const infer = declaredIgnored === undefined && storedNone.length > 0;
  const { view: projectView } = usePrincipalView(member.userId, projectId, infer);
  const inferredIgnored = useMemo(
    () => (infer && workspace && projectView ? inferIgnoredNone(storedNone, workspace, projectView.limitedByProject) : []),
    [infer, storedNone, workspace, projectView],
  );
  useEffect(() => {
    if (inferredIgnored.length === 0) return;
    setBaseline((current) => ({ ...current, ...asInherit(inferredIgnored) }));
    // A choice somebody already changed by hand is left alone.
    setDraft((current) => ({ ...current, ...asInherit(inferredIgnored.filter((id) => current[id] === 'none')) }));
  }, [inferredIgnored]);
  const ignoredCount = ignoredEntries(member.servicePermissions, declaredIgnored ?? []).length + inferredIgnored.length;

  const changed = useMemo(() => changedServices(baseline, draft), [baseline, draft]);
  const dirty = changed.length > 0;
  // An ignored entry is dropped by any save, so a member with some can always save (to clean them up).
  const canSave = dirty || ignoredCount > 0;
  const limited = limitCount(draft);

  const serviceLabel = useCallback(
    (id: string, fallback: string) => {
      const key = `iamApi.services.${id}`;
      const text = root(key);
      return text === key ? fallback : text;
    },
    [root],
  );
  const levelLabel = useCallback((choice: ProjectChoice) => t(`editor.levels.${choice}`), [t]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GRANTABLE_SERVICES.filter((service) => {
      if (mode === 'limited' && (draft[service.id] ?? 'inherit') === 'inherit') return false;
      if (!q) return true;
      return service.id.toLowerCase().includes(q) || serviceLabel(service.id, service.label).toLowerCase().includes(q);
    });
  }, [draft, mode, query, serviceLabel]);

  const asking = useRef(false);
  const lastAnswerAt = useRef(0);
  const requestClose = useCallback(async () => {
    if (saving || asking.current) return;
    if (dirty) {
      asking.current = true;
      const ok = await confirm({
        title: t('editor.discardTitle'),
        message: t('editor.discardMessage'),
        confirmLabel: t('editor.discard'),
        cancelLabel: t('editor.keepEditing'),
        tone: 'warning',
      });
      asking.current = false;
      lastAnswerAt.current = Date.now();
      if (!ok) return;
    }
    onClose();
  }, [confirm, dirty, onClose, saving, t]);

  // Escape leaves the editor - but not when it is only meant for the question on top of it: the confirmation
  // closes on Escape by itself, and the same keystroke must not also ask it again.
  useEffect(() => {
    // Mantine can keep a closed dialog in the DOM with `display: none` on a wrapper: look up the tree.
    const isShown = (el: Element) => {
      for (let node: HTMLElement | null = el as HTMLElement; node; node = node.parentElement) {
        if (node.hidden || node.style.display === 'none') return false;
      }
      return true;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A dialog other than this form (the discard question) is open: Escape is meant for it.
      if ([...document.querySelectorAll('[role="dialog"]:not(.form-overlay)')].some(isShown)) return;
      if (Date.now() - lastAnswerAt.current < 400) return;
      void requestClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

  const showWorkspace = workspace !== null;
  const roleLabel = t(`tenantRoles.${member.role}`);

  const summary = (
    <>
      <SummaryGroup title={t('editor.summary.member')}>
        <SummaryKV label={t('editor.summary.name')} value={member.name || member.email} />
        <SummaryKV label={t('editor.summary.email')} value={member.email} />
        <SummaryKV label={t('editor.summary.workspaceRole')} value={roleLabel} />
      </SummaryGroup>
      <SummaryGroup title={t('editor.summary.limits')}>
        {limited === 0 ? (
          <Text size="xs" c="dimmed" data-testid="summary-no-limits">
            {t('editor.summary.noLimits')}
          </Text>
        ) : (
          GRANTABLE_SERVICES.filter((s) => (draft[s.id] ?? 'inherit') !== 'inherit').map((s) => (
            <SummaryKV key={s.id} label={serviceLabel(s.id, s.label)} value={levelLabel(draft[s.id] ?? 'inherit')} />
          ))
        )}
      </SummaryGroup>
      <SummaryGroup title={t('editor.summary.changes')}>
        {changed.length === 0 ? (
          <Text size="xs" c="dimmed">
            {t('editor.summary.noChanges')}
          </Text>
        ) : (
          changed.map((id) => {
            const service = GRANTABLE_SERVICES.find((s) => s.id === id);
            return (
              <Text key={id} size="xs" data-testid="summary-change">
                {t('editor.summary.change', {
                  service: serviceLabel(id, service?.label ?? id),
                  from: levelLabel(baseline[id] ?? 'inherit'),
                  to: levelLabel(draft[id] ?? 'inherit'),
                })}
              </Text>
            );
          })
        )}
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open
      onClose={() => void requestClose()}
      icon={<IconShieldCheck size={16} />}
      title={t('editor.title', { name: member.name || member.email })}
      subtitle={t('editor.subtitle')}
      disableEscape
      summary={summary}
      footerStatus={t('editor.footer', { count: limited })}
      primaryAction={{
        label: t('editor.save'),
        loading: saving,
        disabled: saving || !canSave,
        onClick: () => onSave(toPermissions(draft, initial.kept)),
      }}
      secondaryAction={{ label: t('editor.cancel'), onClick: () => void requestClose(), disabled: saving }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />} title={t('editor.enforcedTitle')}>
          <Text size="sm">{t('editor.enforcedBody')}</Text>
          <Text size="xs" c="dimmed" mt={4}>
            {t('editor.groupNote')}
          </Text>
        </Alert>

        {ignoredCount > 0 ? (
          <Alert color="gray" variant="light" data-testid="ignored-note">
            <Text size="sm">{t('editor.ignoredNote', { count: ignoredCount })}</Text>
          </Alert>
        ) : null}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextInput
            size="xs"
            leftSection={<IconSearch size={14} />}
            placeholder={t('editor.searchPlaceholder')}
            aria-label={t('editor.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            style={{ flex: '1 1 220px', maxWidth: 320 }}
          />
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => setMode(v as FilterMode)}
            data={[
              { value: 'all', label: t('editor.filterAll') },
              { value: 'limited', label: t('editor.filterLimited', { count: limited }) },
            ]}
          />
          {workspaceLoading ? <Loader size="xs" aria-label={t('editor.loadingWorkspace')} /> : null}
        </div>

        {!workspaceLoading && !showWorkspace ? (
          <Text size="xs" c="dimmed" data-testid="workspace-unavailable">
            {t('editor.workspaceUnavailable')}
          </Text>
        ) : null}

        <div className="ds-tbl-wrap" style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8, overflowX: 'auto' }}>
          <table className="ds-tbl" data-testid="permission-table">
            <thead>
              <tr>
                <th>{t('editor.columns.service')}</th>
                {showWorkspace ? <th style={{ width: 170 }}>{t('editor.columns.workspace')}</th> : null}
                <th style={{ width: 330 }}>{t('editor.columns.project')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={showWorkspace ? 3 : 2}>
                    <Text size="sm" c="dimmed" ta="center" py="md">
                      {t('editor.empty')}
                    </Text>
                  </td>
                </tr>
              ) : (
                rows.map((service) => {
                  const choice = draft[service.id] ?? 'inherit';
                  const ws = workspace ? (workspace[service.id] ?? 'none') : null;
                  const result = effectiveLevel(ws, choice);
                  const label = serviceLabel(service.id, service.label);
                  return (
                    <tr key={service.id} data-service={service.id}>
                      <td>
                        <Text size="sm" fw={500}>
                          {label}
                        </Text>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {service.id}
                        </Text>
                      </td>
                      {showWorkspace ? (
                        <td>
                          {ws && result ? (
                            <Group gap={6} wrap="nowrap" data-testid="level-cell">
                              <LevelBadge level={ws} label={levelLabel(ws)} />
                              {result !== ws ? (
                                <>
                                  <IconArrowRight size={12} aria-hidden />
                                  <LevelBadge level={result} label={levelLabel(result)} />
                                </>
                              ) : null}
                              {exceedsWorkspace(ws, choice) ? (
                                <Tooltip label={t('editor.noEffect')} multiline w={240}>
                                  <Text size="xs" c="dimmed" data-testid="no-effect">
                                    {t('editor.noEffectShort')}
                                  </Text>
                                </Tooltip>
                              ) : null}
                            </Group>
                          ) : null}
                        </td>
                      ) : null}
                      <td>
                        <SegmentedControl
                          size="xs"
                          fullWidth
                          value={choice}
                          aria-label={`${label}: ${t('editor.columns.project')}`}
                          onChange={(value) => setDraft((current) => ({ ...current, [service.id]: value as ProjectChoice }))}
                          data={PROJECT_CHOICES.map((c) => ({ value: c, label: levelLabel(c) }))}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </FormShell>
  );
}
