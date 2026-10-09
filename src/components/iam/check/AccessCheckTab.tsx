'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Alert,
  Anchor,
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
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  IamApiError,
  iamApi,
  type DecisionRecord,
  type IamChannel,
  type SimulateRequest,
  type SimulateResponse,
} from '../api';
import { parseCheckParams, policyHref } from '../links';
import ActionSelect from '../pickers/ActionSelect';
import PrincipalSelect from '../pickers/PrincipalSelect';
import ResourceSelect from '../pickers/ResourceSelect';
import { useProjects } from '../pickers/lookups';
import { formatDateTime } from '../timeFormat';
import { useErrorText } from '../useErrorText';
import { useIamCatalog } from '../useIamCatalog';
import { useIamLabels } from '../useIamLabels';
import {
  applyAction,
  applyPrincipalType,
  defaultChannel,
  emptyForm,
  formToRequest,
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
  const searchParams = useSearchParams();
  const errorText = useErrorText();
  const { catalog, index, error: catalogError, reload } = useIamCatalog();
  const labels = useIamLabels(catalog);
  const { projects } = useProjects();

  const [form, setForm] = useState<CheckForm>(() => emptyForm());
  const [result, setResult] = useState<CheckResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  const [decisionInput, setDecisionInput] = useState('');
  const [decision, setDecision] = useState<DecisionRecord | null>(null);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

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
        return f.resourceType && f.resource ? `${labels.resourceType(f.resourceType)}: ${f.resource.label}` : '—';
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
        setResult({
          request,
          response,
          principalLabel: f.principal?.label ?? request.principal.id,
          resourceLabel: describeResource(f),
        });
      } catch (err) {
        if (seq !== runSeq.current) return;
        setResult(null);
        setError(
          err instanceof IamApiError && err.status === 403 ? t('errors.forbidden') : errorText(err, t('check.failed')),
        );
      } finally {
        if (seq === runSeq.current) setRunning(false);
      }
    },
    [describeResource, errorText, t],
  );

  const loadDecision = useCallback(
    async (rawId: string) => {
      const id = rawId.trim();
      if (!id) return;
      setDecisionLoading(true);
      setDecisionError(null);
      try {
        const record = await iamApi.getDecision(id);
        setDecision(record);
        if (record.simulateInput) {
          const input = record.simulateInput;
          const next = applyAction(
            requestToForm(input, { principal: record.principal.label }),
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
    if (!principalId) return;

    void (async () => {
      let next = emptyForm(link.principalType ?? 'user');
      let label = principalId;
      try {
        label = (await iamApi.getPrincipal(next.principalType, principalId)).principal.label || label;
      } catch {
        /* the id is enough to run the check */
      }
      next.principal = { id: principalId, label };
      if (link.action) {
        const known = index.actionById.get(link.action);
        next = known ? applyAction(next, known) : { ...next, action: link.action };
      }
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
    () => (catalog?.channels ?? []).map((c) => ({ value: c, label: labels.channel(c) })),
    [catalog, labels],
  );

  const reset = () => {
    runSeq.current++;
    setForm(emptyForm(form.principalType));
    setResult(null);
    setError(null);
    setShowErrors(false);
    setDecision(null);
    setDecisionError(null);
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
            {decision ? (
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
                {decision.service ? (
                  <Text size="xs" c="dimmed">
                    {t('check.decisionRequires', {
                      level: labels.level(decision.required),
                      service: labels.service(decision.service),
                    })}
                  </Text>
                ) : null}
                {decision.policyIds.length > 0 ? (
                  <Group gap={6}>
                    <Text size="xs" c="dimmed">
                      {t('check.decisionPolicies')}:
                    </Text>
                    {decision.policyIds.map((id) => (
                      <Anchor key={id} component={Link} href={policyHref(id)} size="xs" ff="monospace">
                        {id}
                      </Anchor>
                    ))}
                  </Group>
                ) : null}
              </Group>
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
                onChange={(id) => setForm((f) => applyAction(f, id ? index.actionById.get(id) : undefined))}
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
                  </>
                )}
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
            <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('check.failed')}>
              {error}
            </Alert>
          ) : result ? (
            <SimulateResultCard
              request={result.request}
              result={result.response}
              labels={labels}
              principalLabel={result.principalLabel}
              resourceLabel={result.resourceLabel}
              canManage={canManage}
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
