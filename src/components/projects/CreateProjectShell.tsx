'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Button, Checkbox, Select, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconFolderPlus, IconPlus, IconX } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  useAutoSlug,
} from '@/components/common/ui/FormShell';
import ProviderConfigModal from '@/components/providers/ProviderConfigModal';
import { providerRequestError } from '@/components/providers/providerFormModel';
import type { ProviderDescriptor } from '@/lib/providers';
import type { ProviderDomain } from '@/lib/database';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useCreateProject } from '@/lib/api/queries/projects';
import { useDefaultAlertRulesChoice, useProjectPeople } from '@/lib/api/queries/projectCreate';
import {
  useAddTenantProviderToList,
  useCreateTenantProvider,
  useProviderDrivers,
  useTenantProviders,
} from '@/lib/api/queries/tenantProviders';
import { useTranslations } from '@/lib/i18n';
import {
  canCreateProject,
  createReadiness,
  groupProvidersByDomain,
  roleEntries,
  type ProjectRoleValue,
} from './projectsListModel';

interface PersonOption {
  _id: string;
  name: string;
  email: string;
}
interface GroupOption {
  _id: string;
  name: string;
  memberCount?: number;
}
interface ProviderOption {
  _id: string;
  key: string;
  label: string;
  type: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The project exists: the caller routes to its Overview. */
  onCreated: (projectId: string) => void;
}

const NO_DRIVERS: ProviderDescriptor[] = [];

export default function CreateProjectShell({ open, onClose, onCreated }: Props) {
  const t = useTranslations('projectsAccess.create');
  const tRoles = useTranslations('projectsAccess.roles');
  const tDomains = useTranslations('projectsAccess.domains');

  const [name, setName] = useState('');
  const slug = useAutoSlug(name);
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<Map<string, ProjectRoleValue>>(new Map());
  const [groups, setGroups] = useState<Map<string, ProjectRoleValue>>(new Map());
  const [providerIds, setProviderIds] = useState<Set<string>>(new Set());
  const [newProviderIds, setNewProviderIds] = useState<Set<string>>(new Set());
  const createProject = useCreateProject();
  const submitting = createProject.isPending;
  // The default alert rules: on unless this installation turned the default off (read below).
  const [defaultAlerts, setDefaultAlerts] = useState(true);
  const [defaultAlertsTouched, setDefaultAlertsTouched] = useState(false);

  // People, groups and providers are read when the shell opens, not on every render of the list behind it.
  const peopleQuery = useProjectPeople(open);
  const providersQuery = useTenantProviders<ProviderOption>({ enabled: open });
  const createProvider = useCreateTenantProvider();
  const addProviderToList = useAddTenantProviderToList<ProviderOption & { _id: string }>();
  const peopleError = peopleQuery.isError;
  const providersError = providersQuery.isError || Boolean(providersQuery.data?.forbidden);
  const providers = useMemo(() => providersQuery.data?.providers ?? [], [providersQuery.data]);
  // Owners and admins already reach every project; a disabled or invited-only account cannot be added usefully.
  const people = useMemo<PersonOption[]>(
    () =>
      ((peopleQuery.data?.users ?? []) as Array<PersonOption & { role?: string; status?: string; disabledAt?: string | null }>)
        .filter((u) => u.role !== 'owner' && u.role !== 'admin' && !u.disabledAt && u.status !== 'disabled')
        .map((u) => ({ _id: String(u._id), name: u.name, email: u.email })),
    [peopleQuery.data],
  );
  const groupOptions = useMemo<GroupOption[]>(
    () => ((peopleQuery.data?.groups ?? []) as GroupOption[]).map((g) => ({ _id: String(g._id), name: g.name, memberCount: g.memberCount })),
    [peopleQuery.data],
  );

  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerDomain, setProviderDomain] = useState<ProviderDomain | null>(null);
  const driversQuery = useProviderDrivers(providerDomain);
  const drivers = driversQuery.data ?? NO_DRIVERS;
  const driversLoading = providerDomain !== null && driversQuery.isFetching;

  const reset = useCallback(() => {
    setName('');
    slug.reset();
    setDescription('');
    setMembers(new Map());
    setGroups(new Map());
    setProviderIds(new Set());
    setNewProviderIds(new Set());
    setDefaultAlertsTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const personById = useMemo(() => new Map(people.map((p) => [p._id, p])), [people]);
  const groupById = useMemo(() => new Map(groupOptions.map((g) => [g._id, g])), [groupOptions]);
  const refetchProviders = providersQuery.refetch;
  const providerById = useMemo(() => new Map(providers.map((p) => [p._id, p])), [providers]);
  const providerGroups = useMemo(() => groupProvidersByDomain(providers), [providers]);

  const domainName = (domain: string): string => {
    const label = tDomains(domain);
    return label.endsWith(`.${domain}`) ? domain : label;
  };

  const readiness = createReadiness({
    name,
    providerDomains: [...providerIds].flatMap((id) => (providerById.get(id) ? [providerById.get(id)!.type] : [])),
    roles: [...members.values(), ...groups.values()],
  });
  const done = (id: string) => readiness.find((r) => r.id === id)?.done ?? false;

  const addTo = (setter: typeof setMembers, id: string | null) => {
    if (!id) return;
    setter((prev) => (prev.has(id) ? prev : new Map(prev).set(id, 'member')));
  };
  const setRole = (setter: typeof setMembers, id: string, role: ProjectRoleValue) =>
    setter((prev) => new Map(prev).set(id, role));
  const removeFrom = (setter: typeof setMembers, id: string) =>
    setter((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

  const toggleProvider = (id: string, checked: boolean) =>
    setProviderIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleProviderCreated = useCallback(
    (provider: { id: string; name: string; domain: string }) => {
      setProviderIds((prev) => new Set(prev).add(provider.id));
      setNewProviderIds((prev) => new Set(prev).add(provider.id));
      addProviderToList({ _id: provider.id, key: provider.name, label: provider.name, type: provider.domain });
      void refetchProviders();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refetchProviders],
  );

  // The extra props are the provider form's contract for being opened from here: nothing is assigned to a
  // project yet (the project does not exist), so its own assign step is skipped and the new provider
  // comes back selected.
  const providerModalExtras = {
    skipAssignStep: true,
    initialProjectIds: [] as string[],
    onCreated: handleProviderCreated,
  };

  const defaultAlertsChoice = useDefaultAlertRulesChoice(open && !defaultAlertsTouched).data;
  useEffect(() => {
    if (defaultAlertsChoice !== undefined && !defaultAlertsTouched) setDefaultAlerts(defaultAlertsChoice);
  }, [defaultAlertsChoice, defaultAlertsTouched]);

  const submit = async () => {
    if (submitting || !canCreateProject(readiness)) return;
    try {
      const body = await createProject.mutateAsync({
        name: name.trim(),
        key: slug.value || undefined,
        description: description.trim() || undefined,
        members: roleEntries(members, 'userId'),
        groups: roleEntries(groups, 'groupId'),
        providerIds: [...providerIds],
        defaultAlertRules: defaultAlerts,
      });
      const warnings = body?.warnings ?? [];
      notifications.show({
        color: warnings.length > 0 ? 'yellow' : 'green',
        title: warnings.length > 0 ? t('createdWithWarnings') : t('created'),
        message: warnings.length > 0 ? warnings.join('\n') : name.trim(),
        autoClose: warnings.length > 0 ? 12000 : 4000,
      });
      const id = body?.project?._id ? String(body.project._id) : '';
      reset();
      if (id) onCreated(id);
      else onClose();
    } catch (err) {
      notifications.show({ color: 'red', title: t('failed'), message: errorMessage(err, t('failed')) });
    }
  };

  const roleSelect = (label: string, value: ProjectRoleValue, onChange: (role: ProjectRoleValue) => void) => (
    <select
      className="ds-select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as ProjectRoleValue)}
    >
      <option value="member">{tRoles('member')}</option>
      <option value="project_admin">{tRoles('project_admin')}</option>
    </select>
  );

  const pickedList = (
    picked: Map<string, ProjectRoleValue>,
    setter: typeof setMembers,
    label: (id: string) => { title: string; sub?: string },
    empty: string,
  ) =>
    picked.size === 0 ? (
      <Text size="sm" c="dimmed">
        {empty}
      </Text>
    ) : (
      <div className="ds-col" style={{ gap: 6 }}>
        {[...picked.entries()].map(([id, role]) => {
          const info = label(id);
          return (
            <div key={id} className="ds-row" style={{ gap: 10, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={500} lineClamp={1}>
                  {info.title}
                </Text>
                {info.sub ? (
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {info.sub}
                  </Text>
                ) : null}
              </div>
              {roleSelect(tRoles('roleLabel', { name: info.title }), role, (next) => setRole(setter, id, next))}
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t('people.remove', { name: info.title })}
                onClick={() => removeFrom(setter, id)}
              >
                <IconX size={14} />
              </ActionIcon>
            </div>
          );
        })}
      </div>
    );

  const summary = (
    <>
      <SummaryGroup title={t('summary.project')}>
        <SummaryKV label={t('summary.project')} value={name.trim() || t('summary.none')} />
        <SummaryKV label={t('summary.key')} value={slug.value || t('summary.none')} mono />
      </SummaryGroup>
      <SummaryGroup title={t('people.title')}>
        <SummaryKV label={t('summary.people')} value={members.size} />
        <SummaryKV label={t('summary.groups')} value={groups.size} />
      </SummaryGroup>
      <SummaryGroup title={t('providers.title')}>
        <SummaryKV label={t('summary.providers')} value={providerIds.size} />
      </SummaryGroup>
      <SummaryGroup title={t('readiness.title')}>
        <Checklist
          items={[
            { id: 'name', label: t('readiness.name'), done: done('name') },
            { id: 'modelProvider', label: t('readiness.modelProvider'), done: done('modelProvider') },
            { id: 'projectAdmin', label: t('readiness.projectAdmin'), done: done('projectAdmin') },
            { id: 'defaultAlerts', label: t('readiness.defaultAlerts'), done: defaultAlerts },
          ]}
        />
      </SummaryGroup>
    </>
  );

  return (
    <>
      <FormShell
        open={open && !providerModalOpen}
        onClose={close}
        icon={<IconFolderPlus size={16} />}
        title={t('title')}
        subtitle={t('subtitle')}
        summary={summary}
        primaryAction={{
          label: submitting ? t('creating') : t('submit'),
          loading: submitting,
          disabled: !canCreateProject(readiness),
          onClick: () => void submit(),
        }}
        secondaryAction={{ label: t('cancel'), variant: 'default', disabled: submitting, onClick: close }}
      >
        <FormSection number={1} title={t('details.title')} description={t('details.description')} done={done('name')}>
          <FormRow cols={2}>
            <FormField label={t('details.name')} required>
              <TextInput
                aria-label={t('details.name')}
                placeholder={t('details.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                data-autofocus
              />
            </FormField>
            <FormField label={t('details.key')} hint={t('details.keyHint')}>
              <TextInput
                aria-label={t('details.key')}
                value={slug.value}
                onChange={(e) => slug.setValue(e.currentTarget.value)}
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label={t('details.descriptionLabel')} optional>
              <Textarea
                aria-label={t('details.descriptionLabel')}
                placeholder={t('details.descriptionPlaceholder')}
                minRows={2}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
              />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection number={2} title={t('people.title')} description={t('people.description')} done={members.size + groups.size > 0}>
          {peopleError ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />}>
              {t('people.loadFailed')}
            </Alert>
          ) : null}
          <FormRow cols={1}>
            <FormField label={t('people.users')}>
              <Select
                aria-label={t('people.addUser')}
                placeholder={t('people.addUserPlaceholder')}
                searchable
                clearable={false}
                value={null}
                data={people.filter((p) => !members.has(p._id)).map((p) => ({ value: p._id, label: `${p.name} · ${p.email}` }))}
                onChange={(id) => addTo(setMembers, id)}
                mb="xs"
              />
              {pickedList(
                members,
                setMembers,
                (id) => ({ title: personById.get(id)?.name ?? id, sub: personById.get(id)?.email }),
                t('people.none'),
              )}
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label={t('people.groups')}>
              <Select
                aria-label={t('people.addGroup')}
                placeholder={t('people.addGroupPlaceholder')}
                searchable
                clearable={false}
                value={null}
                data={groupOptions.filter((g) => !groups.has(g._id)).map((g) => ({ value: g._id, label: g.name }))}
                onChange={(id) => addTo(setGroups, id)}
                mb="xs"
              />
              {pickedList(
                groups,
                setGroups,
                (id) => ({
                  title: groupById.get(id)?.name ?? id,
                  sub:
                    groupById.get(id)?.memberCount !== undefined
                      ? t('people.members', { count: groupById.get(id)!.memberCount! })
                      : undefined,
                }),
                t('people.noGroups'),
              )}
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection
          number={3}
          title={t('providers.title')}
          description={t('providers.description')}
          done={providerIds.size > 0}
        >
          {providersError ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />}>
              {t('providers.loadFailed')}
            </Alert>
          ) : null}
          {providers.length === 0 && !providersError ? (
            <Text size="sm" c="dimmed">
              {t('providers.none')}
            </Text>
          ) : null}
          <div className="ds-col" style={{ gap: 14 }}>
            {providerGroups.map((group) => (
              <div key={group.domain} className="ds-col" style={{ gap: 6 }}>
                <div className="ds-eyebrow">{domainName(group.domain)}</div>
                {group.items.map((provider) => (
                  <div key={provider._id} className="ds-row" style={{ gap: 8, alignItems: 'center' }}>
                    <Checkbox
                      checked={providerIds.has(provider._id)}
                      onChange={(e) => toggleProvider(provider._id, e.currentTarget.checked)}
                      label={provider.label || provider.key}
                    />
                    <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
                      {provider.key}
                    </span>
                    {newProviderIds.has(provider._id) ? (
                      <span className="ds-badge ds-badge-ok">{t('providers.newlyAdded')}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlus size={13} stroke={1.7} />}
              onClick={() => setProviderModalOpen(true)}
            >
              {t('providers.addNew')}
            </Button>
          </div>
        </FormSection>

        <FormSection number={4} title={t('readiness.title')} description={t('readiness.hint')} done={done('modelProvider') && done('projectAdmin')}>
          <Checklist
            items={[
              { id: 'name', label: t('readiness.name'), done: done('name') },
              { id: 'modelProvider', label: t('readiness.modelProvider'), done: done('modelProvider') },
              { id: 'projectAdmin', label: t('readiness.projectAdmin'), done: done('projectAdmin') },
              { id: 'defaultAlerts', label: t('readiness.defaultAlerts'), done: defaultAlerts },
            ]}
          />
          {!done('modelProvider') ? (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mt="xs">
              {t('readiness.modelProviderWarn')}
            </Alert>
          ) : null}
          {!done('projectAdmin') ? (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mt="xs">
              {t('readiness.projectAdminWarn')}
            </Alert>
          ) : null}
          <Switch
            mt="md"
            checked={defaultAlerts}
            onChange={(event) => {
              setDefaultAlerts(event.currentTarget.checked);
              setDefaultAlertsTouched(true);
            }}
            disabled={submitting}
            label={t('readiness.defaultAlertsTitle')}
            description={t('readiness.defaultAlertsHint')}
          />
          {defaultAlerts && !done('projectAdmin') ? (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mt="xs">
              {t('readiness.defaultAlertsNoAdmin')}
            </Alert>
          ) : null}
        </FormSection>
      </FormShell>

      <ProviderConfigModal
        opened={open && providerModalOpen}
        onClose={() => {
          setProviderModalOpen(false);
          setProviderDomain(null);
        }}
        mode="create"
        drivers={drivers}
        driversLoading={driversLoading}
        domain={providerDomain}
        onDomainChange={(domain) => {
          setProviderDomain(domain);
        }}
        onSubmit={async (options) => {
          if (!providerDomain) return;
          const body = await createProvider
            .mutateAsync({
              key: options.values.base.key,
              label: options.values.base.label,
              description: options.values.base.description,
              driver: options.driver,
              type: providerDomain,
              status: options.values.base.status,
              credentials: options.values.credentials,
              settings: options.values.settings,
              metadata: options.values.metadata,
              // Projects ticked in the form's own Projects section (existing projects only).
              ...((options as { projectIds?: string[] }).projectIds?.length
                ? { projectIds: (options as { projectIds?: string[] }).projectIds }
                : {}),
            })
            .catch((error: unknown) => {
              // The refusal names the form field it is about: the form marks it, as it does for an edit.
              if (error instanceof ApiError) throw providerRequestError(error.payload, t('providerModal.createFailed'));
              throw error;
            });
          const created = body?.provider;
          if (created?._id) {
            handleProviderCreated({
              id: String(created._id),
              name: created.label || created.key || String(created._id),
              domain: created.type || providerDomain,
            });
            notifications.show({ color: 'green', message: t('providerModal.created') });
          }
          setProviderModalOpen(false);
          setProviderDomain(null);
        }}
        {...providerModalExtras}
      />
    </>
  );
}
