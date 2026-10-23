'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Collapse,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import dayjs from 'dayjs';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconInfoCircle,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  AGENT_APPROVERS,
  IamApiError,
  iamApi,
  type AgentApprovers,
  type DecisionPolicy,
  type DecisionRecord,
  type IamChannel,
  type SimulateRequest,
  type SimulateResponse,
} from '../api';
import { iamHref, parseCheckParams, policyHref } from '../links';
import ActionSelect from '../pickers/ActionSelect';
import PrincipalSelect from '../pickers/PrincipalSelect';
import ResourceSelect from '../pickers/ResourceSelect';
import { useProjects } from '../pickers/lookups';
import { formatDateTime } from '../timeFormat';
import { useErrorText } from '../useErrorText';
import { useIamCatalog } from '../useIamCatalog';
import { useIamLabels } from '../useIamLabels';
import {
  APPROVE_ACTION,
  INVOKE_ACTION,
  applyAction,
  applyPortal,
  applyPrincipalType,
  defaultChannel,
  emptyForm,
  formToRequest,
  isSessionAction,
  requestToForm,
  validateForm,
  type CheckForm,
  type CheckIssue,
  type CheckPrincipalType,
} from './checkModel';
import SimulateResultCard from './SimulateResultCard';

interface AccessCheckTabProps {
  canManage: boolean;
}

interface CheckResult {
  request: SimulateRequest;
  response: SimulateResponse;
  principalLabel: string;
  resourceLabel: string;
  /** The service the checked action belongs to, and the level it asks for. */
  service: string | null;
  level: 'read' | 'write' | 'admin' | null;
}

/** A refusal because the engine could not decide (not a policy answer): shown as such, with a way to check on it. */
const UNAVAILABLE_CODES = ['engine_unavailable', 'authorization_unavailable'];

interface CheckFailure {
  message: string;
  unavailable: boolean;
}

const toIso = (value: Date | string | null): string | null => {
  if (!value) return null;
  const d = dayjs(value);
  return d.isValid() ? d.toDate().toISOString() : null;
};

const fromIso = (iso: string | null): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

export default function AccessCheckTab({ canManage }: AccessCheckTabProps) {
  const t = useTranslations('iamCenter');
  const locale = useLocale();
  const searchParams = useSearchParams()!;
  const errorText = useErrorText();
  const { catalog, index, error: catalogError, reload } = useIamCatalog();
  const labels = useIamLabels(catalog);
  const { projects } = useProjects();

  const [form, setForm] = useState<CheckForm>(() => emptyForm());
  const [result, setResult] = useState<CheckResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<CheckFailure | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  const [decisionInput, setDecisionInput] = useState('');
  const [decision, setDecision] = useState<DecisionRecord | null>(null);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // A decision that was not a policy answer at all: the engine could not decide that request (HTTP 503).
  const [decisionUnavailable, setDecisionUnavailable] = useState(false);

  const runSeq = useRef(0);

  const issues = useMemo(() => validateForm(form), [form]);
  const selectedAction = form.action && index ? index.actionById.get(form.action) : undefined;
  const has = (issue: CheckIssue) => showErrors && issues.includes(issue);

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? id,
    [projects],
  );

  const describeResource = useCallback(
    (f: CheckForm): string => {
      if (f.resourceKind === 'service') return f.service ? labels.service(f.service) : '—';
      if (f.resourceKind === 'resource') {
        if (!f.resourceType || !f.resource) return '—';
        const what = `${labels.resourceType(f.resourceType)}: ${f.resource.label}`;
        return f.portal && f.action === INVOKE_ACTION ? `${what} · ${labels.resourceType('portal')}: ${f.portal.label}` : what;
      }
      return f.projectResource
        ? t('check.targetNewIn', {
            type: f.resourceType ? labels.resourceType(f.resourceType) : '',
            project: projectName(f.projectResource),
          })
        : '—';
    },
    [labels, projectName, t],
  );

  const run = useCallback(
    async (f: CheckForm) => {
      setShowErrors(true);
      const request = formToRequest(f);
      if (!request) return;
      const seq = ++runSeq.current;
      setRunning(true);
      setError(null);
      try {
        const response = await iamApi.simulate(request);
        if (seq !== runSeq.current) return;
        const checked = index?.actionById.get(request.action);
        setResult({
          request,
          response,
          principalLabel: f.principal?.label ?? request.principal.id,
          resourceLabel: describeResource(f),
          service: checked?.service ?? null,
          level: checked && checked.kind !== 'group' ? checked.level : null,
        });
      } catch (err) {
        if (seq !== runSeq.current) return;
        setResult(null);
        setError({
          message:
            err instanceof IamApiError && err.status === 403 ? t('errors.forbidden') : errorText(err, t('check.failed')),
          unavailable:
            err instanceof IamApiError && (err.status === 503 || UNAVAILABLE_CODES.includes(err.code ?? '')),
        });
      } finally {
        if (seq === runSeq.current) setRunning(false);
      }
    },
    [describeResource, errorText, index, t],
  );

  const loadDecision = useCallback(
    async (rawId: string) => {
      const id = rawId.trim();
      if (!id) return;
      setDecisionLoading(true);
      setDecisionError(null);
      setDecisionUnavailable(false);
      try {
        const record = await iamApi.getDecision(id);
        setDecision(record);
        if (record.code === 'authorization_unavailable') {
          // The engine could not decide this request; there was no policy answer to replay.
          setDecisionUnavailable(true);
          setResult(null);
        } else if (record.simulateInput) {
          const input = record.simulateInput;
          const next = applyAction(
            requestToForm(input, { principal: record.principal.label, resource: record.resource?.label }),
            index?.actionById.get(input.action),
          );
          setForm(next);
          setContextOpen(!!record.simulateInput.context);
          await run(next);
        } else {
          setDecisionError(t('check.decisionNoInput'));
        }
      } catch (err) {
        setDecision(null);
        setDecisionError(
          err instanceof IamApiError && err.status === 404 ? t('check.decisionNotFound') : errorText(err, t('check.failed')),
        );
      } finally {
        setDecisionLoading(false);
      }
    },
    [errorText, index, run, t],
  );

  // ── deep links: ?decisionId=  and  ?principalType&principalId[&action] ──────────

  const handled = useRef('');
  useEffect(() => {
    if (!index) return;
    const key = searchParams.toString();
    if (handled.current === key) return;
    handled.current = key;
    const link = parseCheckParams(searchParams);

    if (link.decisionId) {
      setDecisionInput(link.decisionId);
      void loadDecision(link.decisionId);
      return;
    }
    const principalId = link.principalId;
    // A link may also name only what is checked (a portal page: "check a person"): the form opens prefilled, ready for the person.
    if (!principalId && !link.action) return;

    void (async () => {
      let next = emptyForm(link.principalType ?? 'user');
      if (principalId) {
        let label = principalId;
        try {
          label = (await iamApi.getPrincipal(next.principalType, principalId)).principal.label || label;
        } catch {
          /* the id is enough to run the check */
        }
        next.principal = { id: principalId, label };
      }
      if (link.action) {
        const known = index.actionById.get(link.action);
        next = known ? applyAction(next, known) : { ...next, action: link.action };
      }
      if (link.resourceType && link.resourceId && next.resourceKind === 'resource' && next.resourceType === link.resourceType) {
        next.resource = { type: link.resourceType, id: link.resourceId, label: link.resourceLabel || link.resourceId };
      }
      if (link.channel && !(link.channel === 'portal' && next.principalType === 'token')) next.channel = link.channel;
      if (link.portalId) next.portal = { type: 'portal', id: link.portalId, label: link.portalLabel || link.portalId };
      setForm(next);
      setResult(null);
      setDecision(null);
      if (formToRequest(next)) await run(next);
    })();
  }, [index, searchParams, loadDecision, run]);

  // ── handlers ─────────────────────────────────────────────────────────────

  const patch = (change: Partial<CheckForm>) => setForm((f) => ({ ...f, ...change }));

  const projectOptions = useMemo(() => projects.map((p) => ({ value: p.id, label: p.name })), [projects]);
  const channelOptions = useMemo(
    () =>
      (catalog?.channels ?? [])
        .filter((c) => !(c === 'portal' && form.principalType === 'token'))
        // The Slack / Teams runtime is decided by a deployment's access list, which the check does not rebuild (yet).
        .filter((c) => c !== 'messaging')
        .map((c) => ({ value: c, label: labels.channel(c) })),
    [catalog, labels, form.principalType],
  );

  const reset = () => {
    runSeq.current++;
    setForm(emptyForm(form.principalType));
    setResult(null);
    setError(null);
    setShowErrors(false);
    setDecision(null);
    setDecisionError(null);
    setDecisionUnavailable(false);
    setDecisionInput('');
  };

  if (catalogError) {
    return (
      <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('errors.catalog')}>
        <Group justify="space-between">
          <Text size="sm">{catalogError}</Text>
          <Button size="xs" variant="light" onClick={reload}>
            {t('common.retry')}
          </Button>
        </Group>
      </Alert>
    );
  }

  if (!catalog || !index) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  return (
    <Stack gap="lg">
      <div>
        <Text fw={600}>{t('check.title')}</Text>
        <Text size="sm" c="dimmed" maw={760}>
          {t('check.description')}
        </Text>
      </div>

      {/* Decision lookup */}
      <Paper withBorder radius="md" p="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void loadDecision(decisionInput);
          }}
        >
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              {t('check.decisionTitle')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('check.decisionHelp')}
            </Text>
            <Group gap="xs" align="flex-start" wrap="wrap">
              <TextInput
                style={{ flex: '1 1 260px' }}
                size="sm"
                leftSection={<IconSearch size={14} />}
                placeholder={t('check.decisionPlaceholder')}
                value={decisionInput}
                onChange={(e) => setDecisionInput(e.currentTarget.value)}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('check.decisionTitle')}
              />
              <Button type="submit" variant="default" loading={decisionLoading} disabled={!decisionInput.trim()}>
                {t('check.decisionLoad')}
              </Button>
            </Group>
            {decisionError ? (
              <Text size="sm" c="red">
                {decisionError}
              </Text>
            ) : null}
            {decisionUnavailable ? (
              <Alert
                color="orange"
                variant="light"
                icon={<IconAlertTriangle size={16} />}
                title={t('check.decisionUnavailableTitle')}
                data-testid="decision-unavailable"
              >
                <Stack gap={6} align="flex-start">
                  <Text size="sm">{t('check.decisionUnavailable')}</Text>
                  <Anchor component={Link} href={iamHref('overview')} size="sm">
                    {t('check.openOverview')}
                  </Anchor>
                </Stack>
              </Alert>
            ) : null}
            {decision ? (
              <Stack gap="xs">
                <Group gap="md" wrap="wrap">
                  <Text size="xs" c="dimmed">
                    {t('check.decisionAt', { date: formatDateTime(decision.at, locale) })}
                  </Text>
                  {decision.method || decision.route ? (
                    <Text size="xs" ff="monospace">
                      {decision.method} {decision.route}
                    </Text>
                  ) : null}
                  {decision.code ? (
                    <Text size="xs" c="dimmed">
                      {t('check.decisionCode', { code: decision.code })}
                    </Text>
                  ) : null}
                  {decision.resource && decision.simulateInput ? (
                    <Text size="xs" c="dimmed" data-testid="decision-resource">
                      {t('check.decisionResource', {
                        action: labels.action(decision.simulateInput.action),
                        resource: `${labels.resourceType(decision.resource.type)}: ${decision.resource.label ?? decision.resource.id}`,
                      })}
                    </Text>
                  ) : decision.service && decision.channel !== 'portal' ? (
                    <Text size="xs" c="dimmed">
                      {t('check.decisionRequires', {
                        level: labels.level(decision.required),
                        service: labels.service(decision.service),
                      })}
                    </Text>
                  ) : null}
                  {decision.portal ? (
                    <Text size="xs" c="dimmed" data-testid="decision-portal">
                      {t('check.decisionPortal', { portal: decision.portal.label ?? decision.portal.key ?? decision.portal.id })}
                    </Text>
                  ) : null}
                  {decision.channel ? (
                    <Text size="xs" c="dimmed">
                      {t('check.decisionChannel', { channel: labels.channel(decision.channel) })}
                    </Text>
                  ) : null}
                  {decision.policies.length > 0 ? (
                    <Group gap={6} data-testid="decision-policies">
                      <Text size="xs" c="dimmed">
                        {t('check.decisionPolicies')}:
                      </Text>
                      {decision.policies.map((policy) => (
                        <DecidingPolicy key={policy.policyId} policy={policy} />
                      ))}
                    </Group>
                  ) : null}
                </Group>
                <StalePolicies policies={decision.policies} replay={result?.response ?? null} />
              </Stack>
            ) : null}
          </Stack>
        </form>
      </Paper>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg" verticalSpacing="lg">
        {/* Request */}
        <Paper withBorder radius="md" p="md" style={{ alignSelf: 'start' }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(form);
            }}
          >
            <Stack gap="md">
              <Text fw={600}>{t('check.requestTitle')}</Text>

              <Stack gap="xs">
                <Text size="sm" fw={500}>
                  {t('check.principal')}
                </Text>
                <SegmentedControl
                  size="xs"
                  value={form.principalType}
                  onChange={(v) => setForm((f) => applyPrincipalType(f, v as CheckPrincipalType))}
                  data={[
                    { value: 'user', label: t('check.typeUser') },
                    { value: 'token', label: t('check.typeToken') },
                  ]}
                />
                <PrincipalSelect
                  key={form.principalType}
                  type={form.principalType}
                  value={form.principal}
                  onChange={(principal) => patch({ principal })}
                  placeholder={form.principalType === 'user' ? t('check.userPlaceholder') : t('check.tokenPlaceholder')}
                  error={has('principal') ? t('check.requirePrincipal') : undefined}
                />
              </Stack>

              <ActionSelect
                index={index}
                labels={labels}
                label={t('check.action')}
                value={form.action}
                onChange={(id) =>
                  setForm((f) => applyAction(f, id ? index.actionById.get(id) : undefined, f.action ? index.actionById.get(f.action) : undefined))
                }
                error={has('action') ? t('check.requireAction') : undefined}
              />

              <Stack gap="xs">
                <Text size="sm" fw={500}>
                  {t('check.target')}
                </Text>
                {!selectedAction ? (
                  <Text size="sm" c="dimmed">
                    {t('check.targetChooseAction')}
                  </Text>
                ) : selectedAction.kind === 'service' ? (
                  <Text size="sm">
                    {t('check.targetService', { service: labels.service(selectedAction.service ?? '') })}
                  </Text>
                ) : (
                  <>
                    <SegmentedControl
                      size="xs"
                      value={form.resourceKind === 'project' ? 'project' : 'resource'}
                      onChange={(v) => patch({ resourceKind: v === 'project' ? 'project' : 'resource' })}
                      data={[
                        { value: 'resource', label: t('check.targetExisting') },
                        { value: 'project', label: t('check.targetNew') },
                      ]}
                    />
                    {form.resourceKind === 'project' ? (
                      <Select
                        description={t('check.targetNewHelp')}
                        placeholder={t('check.projectPlaceholder')}
                        data={projectOptions}
                        value={form.projectResource}
                        onChange={(projectResource) => patch({ projectResource })}
                        searchable
                        clearable
                        maxDropdownHeight={260}
                        error={has('project') ? t('check.requireProject') : undefined}
                      />
                    ) : (
                      <ResourceSelect
                        type={selectedAction.resourceType ?? null}
                        label={labels.resourceType(selectedAction.resourceType ?? '')}
                        value={form.resource}
                        onChange={(resource) => patch({ resource })}
                        error={has('resource') ? t('check.requireResource') : undefined}
                      />
                    )}
                    {/* Only where portals exist (the catalog says the action is checked there), or when the portal channel was chosen by hand. */}
                    {(selectedAction.id === INVOKE_ACTION || selectedAction.id === APPROVE_ACTION) && form.resourceKind === 'resource'
                      && (form.channel === 'portal' || (selectedAction.id === INVOKE_ACTION && selectedAction.enforcedIn?.includes('portal'))) ? (
                      <ResourceSelect
                        type="portal"
                        label={t('check.ctxPortal')}
                        description={t('check.ctxPortalHelp')}
                        placeholder={t('check.portalPlaceholder')}
                        value={form.portal}
                        onChange={(portal) => setForm((f) => applyPortal(f, portal))}
                        error={has('portal') ? t('check.requirePortal') : undefined}
                      />
                    ) : null}
                    {/* A session action depends on the session: who started it, and (for a pending request) whom the agent accepts. */}
                    {isSessionAction(selectedAction.id) ? (
                      <Stack gap="xs" data-testid="session-inputs">
                        <PrincipalSelect
                          type="user"
                          label={t('check.sessionOwner')}
                          description={t('check.sessionOwnerHelp')}
                          placeholder={t('check.sessionOwnerPlaceholder')}
                          value={form.sessionOwner}
                          onChange={(sessionOwner) => patch({ sessionOwner })}
                        />
                        {selectedAction.id === APPROVE_ACTION ? (
                          <Select
                            label={t('check.approvers')}
                            description={t('check.approversHelp')}
                            placeholder={t('check.approversDefault')}
                            data={AGENT_APPROVERS.map((value) => ({ value, label: t(`result.approvers.${value}`) }))}
                            value={form.approvers}
                            onChange={(value) => patch({ approvers: (value as AgentApprovers | null) ?? null })}
                            clearable
                          />
                        ) : null}
                      </Stack>
                    ) : null}
                  </>
                )}
                {form.principalType === 'token' && selectedAction?.enforcedIn?.includes('portal') ? (
                  <Text size="xs" c="dimmed" data-testid="token-portal-note">
                    {t('check.tokenPortalNote')}
                  </Text>
                ) : null}
              </Stack>

              <div>
                <UnstyledButton onClick={() => setContextOpen((o) => !o)} aria-expanded={contextOpen}>
                  <Group gap={4}>
                    {contextOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    <Text size="sm" fw={500}>
                      {t('check.context')}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t('check.contextHint')}
                    </Text>
                  </Group>
                </UnstyledButton>
                <Collapse in={contextOpen}>
                  <Stack gap="sm" mt="sm">
                    <Select
                      label={t('check.ctxProject')}
                      description={t('check.ctxProjectHelp')}
                      data={projectOptions}
                      value={form.ctxProjectId}
                      onChange={(ctxProjectId) => patch({ ctxProjectId })}
                      searchable
                      clearable
                      maxDropdownHeight={220}
                    />
                    <Select
                      label={t('check.ctxChannel')}
                      description={t('check.ctxChannelHelp')}
                      data={channelOptions}
                      value={form.channel}
                      onChange={(c) => patch({ channel: (c as IamChannel | null) ?? null })}
                      clearable
                      placeholder={labels.channel(defaultChannel(form.principalType))}
                    />
                    <TextInput
                      label={t('check.ctxIp')}
                      description={t('check.ctxIpHelp')}
                      placeholder="203.0.113.7"
                      value={form.ip}
                      onChange={(e) => patch({ ip: e.currentTarget.value })}
                      error={has('ip') ? t('check.invalidIp') : undefined}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <DateTimePicker
                      label={t('check.ctxTime')}
                      description={t('check.ctxTimeHelp')}
                      placeholder={t('check.now')}
                      value={fromIso(form.at)}
                      onChange={(v) => patch({ at: toIso(v) })}
                      clearable
                      valueFormat="DD MMM YYYY HH:mm"
                    />
                  </Stack>
                </Collapse>
              </div>

              <Group gap="xs">
                <Button
                  type="submit"
                  leftSection={<IconPlayerPlay size={14} />}
                  loading={running}
                >
                  {t('check.run')}
                </Button>
                <Button
                  type="button"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconRefresh size={14} />}
                  onClick={reset}
                  disabled={running}
                >
                  {t('check.reset')}
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>

        {/* Result */}
        <div>
          {error ? (
            <Alert
              color={error.unavailable ? 'orange' : 'red'}
              icon={<IconAlertTriangle size={16} />}
              title={error.unavailable ? t('check.unavailableTitle') : t('check.failed')}
              data-testid={error.unavailable ? 'check-unavailable' : 'check-failed'}
            >
              <Stack gap={6} align="flex-start">
                <Text size="sm">{error.message}</Text>
                {error.unavailable ? (
                  <Anchor component={Link} href={iamHref('overview')} size="sm">
                    {t('check.openOverview')}
                  </Anchor>
                ) : null}
              </Stack>
            </Alert>
          ) : result ? (
            <SimulateResultCard
              request={result.request}
              result={result.response}
              labels={labels}
              principalLabel={result.principalLabel}
              resourceLabel={result.resourceLabel}
              canManage={canManage}
              service={result.service}
              level={result.level}
            />
          ) : (
            <Paper withBorder radius="md" p="xl">
              <Stack align="center" gap={6}>
                {running ? <Loader size="sm" /> : null}
                <Text size="sm" c="dimmed" ta="center" maw={360}>
                  {running ? t('check.running') : t('check.placeholder')}
                </Text>
              </Stack>
            </Paper>
          )}
        </div>
      </SimpleGrid>
    </Stack>
  );
}

/** A policy that decided a request: its name (linked while it exists), and what became of it. */
function DecidingPolicy({ policy }: { policy: DecisionPolicy }) {
  const t = useTranslations('iamCenter');
  // A policy that is gone and whose name nobody kept is told by a short id; one that still exists by its id in full.
  const name = policy.name ?? (policy.status === 'deleted' ? policy.policyId.slice(0, 8) : policy.policyId);
  const label = (
    <Text size="xs" component="span" c={policy.name ? undefined : 'dimmed'} ff={policy.name ? undefined : 'monospace'} title={policy.policyId}>
      {name}
    </Text>
  );
  return (
    <Group gap={4} wrap="nowrap" data-testid="decision-policy" data-status={policy.status}>
      {policy.status === 'deleted' ? (
        label
      ) : (
        <Anchor component={Link} href={policyHref(policy.policyId)} size="xs">
          {name}
        </Anchor>
      )}
      {policy.status !== 'active' ? (
        <Badge size="xs" variant="light" color={policy.status === 'deleted' ? 'red' : 'gray'}>
          {t(`check.policyState.${policy.status}`)}
        </Badge>
      ) : null}
    </Group>
  );
}

/**
 * A replay runs against the policies as they are now. When a policy that decided
 * the request was switched off or deleted since, say so - and what the current
 * policies make of the same request.
 */
function StalePolicies({ policies, replay }: { policies: readonly DecisionPolicy[]; replay: SimulateResponse | null }) {
  const t = useTranslations('iamCenter');
  const names = (status: DecisionPolicy['status']) =>
    policies.filter((p) => p.status === status).map((p) => p.name ?? (status === 'deleted' ? p.policyId.slice(0, 8) : p.policyId)).join(', ');
  const disabled = names('disabled');
  const deleted = names('deleted');
  if (!disabled && !deleted) return null;
  return (
    <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} title={t('check.decisionStale.title')} data-testid="decision-stale">
      <Stack gap={2}>
        {deleted ? <Text size="sm">{t('check.decisionStale.deleted', { names: deleted })}</Text> : null}
        {disabled ? <Text size="sm">{t('check.decisionStale.disabled', { names: disabled })}</Text> : null}
        {replay ? (
          <Text size="sm" fw={600} data-testid="decision-stale-verdict">
            {replay.allowed ? t('check.decisionStale.allowedNow') : t('check.decisionStale.stillDenied')}
          </Text>
        ) : null}
      </Stack>
    </Alert>
  );
}
