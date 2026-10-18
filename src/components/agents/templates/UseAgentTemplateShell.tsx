'use client';

/**
 * Templates → Use template: the full-screen form that turns a template into an
 * agent, and (in the same shell) the page that says what is left to do - with
 * the webhook URL and secret, which the server returns this once.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Button, Checkbox, Code, MultiSelect, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconCopy } from '@tabler/icons-react';
import FormShell, {
  FormField,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import type { InstantiateTemplateResult } from '@/lib/services/agents/templates/types';
import styles from './AgentTemplatesPage.module.css';
import { TemplateIcon } from './templateIcons';
import {
  browserTimezone,
  buildInstantiateBody,
  describeContents,
  describeTrigger,
  formBlockers,
  initialForm,
  instantiateTemplateRequest,
  webhookTriggers,
  type FormBlocker,
  type UseTemplateForm,
} from './templatesModel';
import { useTemplateDetail } from './useTemplateDetail';

interface Option { value: string; label: string }

interface ProjectFacts {
  loaded: boolean;
  models: Option[];
  knowledge: Option[];
  guardrails: Option[];
  sandboxTemplates: Option[];
}

const NO_FACTS: ProjectFacts = { loaded: false, models: [], knowledge: [], guardrails: [], sandboxTemplates: [] };

async function getList<T>(url: string, pick: (data: Record<string, unknown>) => T[]): Promise<T[]> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? pick(await res.json()) : [];
  } catch {
    return [];
  }
}

function timezoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  return [...new Set([current, 'UTC', ...zones])];
}

/** Copies to the clipboard; reports whether it worked (the clipboard can be blocked). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyRow({ label, value, copyLabel, copiedLabel, secret = false }: { label: string; value: string; copyLabel: string; copiedLabel: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="ds-muted" style={{ fontSize: 11, marginBottom: 2 }}>{label}</div>
      <div className="ds-row ds-gap-sm">
        <Code className={secret ? styles.secret : undefined} style={{ flex: 1, wordBreak: 'break-all' }}>{value}</Code>
        <Button
          size="compact-xs"
          variant="default"
          leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          onClick={() => { void copyText(value).then((ok) => setCopied(ok)); }}
        >
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
    </div>
  );
}

export interface UseAgentTemplateShellProps {
  /** The template to use; null keeps the form closed. */
  templateKey: string | null;
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
}

export default function UseAgentTemplateShell({ templateKey, onClose, onOpenAgent }: UseAgentTemplateShellProps) {
  const t = useTranslations('agentTemplates');
  const { template, loading: detailLoading } = useTemplateDetail(templateKey);
  const [facts, setFacts] = useState<ProjectFacts>(NO_FACTS);
  const [form, setForm] = useState<UseTemplateForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InstantiateTemplateResult | null>(null);

  // The project's models, knowledge bases, guardrails and (for sandbox templates) sandbox templates.
  useEffect(() => {
    if (!template) return;
    let cancelled = false;
    setFacts(NO_FACTS);
    setForm(null);
    setResult(null);
    setError(null);
    void (async () => {
      const [models, knowledge, guardrails, sandbox] = await Promise.all([
        getList<Option>('/api/models?category=llm', (d) =>
          ((d.models ?? []) as Array<{ key: string; name: string; modelId: string }>).map((m) => ({ value: m.key, label: `${m.name} (${m.modelId})` }))),
        template.requires.knowledge
          ? getList<Option>('/api/rag/modules?status=active', (d) =>
            ((d.modules ?? []) as Array<{ key: string; name: string }>).map((m) => ({ value: m.key, label: m.name })))
          : Promise.resolve([] as Option[]),
        getList<Option>('/api/guardrails', (d) =>
          ((d.guardrails ?? []) as Array<{ key: string; name?: string; enabled?: boolean }>)
            .filter((g) => g.enabled !== false)
            .map((g) => ({ value: g.key, label: g.name ?? g.key }))),
        template.requires.sandbox
          ? getList<Option>('/api/agents/sandbox/capabilities', (d) =>
            ((d.templates ?? []) as Array<{ key: string; name?: string }>).map((s) => ({ value: s.key, label: s.name ?? s.key })))
          : Promise.resolve([] as Option[]),
      ]);
      if (cancelled) return;
      setFacts({ loaded: true, models, knowledge, guardrails, sandboxTemplates: sandbox });
      setForm(initialForm(template, { models: models.map((m) => m.value), sandboxTemplates: sandbox.map((s) => s.value) }));
    })();
    return () => { cancelled = true; };
  }, [template]);

  const submitForm = form;
  const blockers: FormBlocker[] = template && submitForm ? formBlockers(template, submitForm) : [];
  const contents = template ? describeContents(template) : null;
  const patch = (next: Partial<UseTemplateForm>) => setForm((current) => (current ? { ...current, ...next } : current));
  const zones = useMemo(() => timezoneOptions(form?.timezone ?? browserTimezone()), [form?.timezone]);

  const close = () => {
    setResult(null);
    onClose();
  };

  const submit = async () => {
    if (!template || !submitForm || blockers.length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(await instantiateTemplateRequest(template.key, buildInstantiateBody(template, submitForm)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ui.form.createFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!templateKey) return null;
  const templateName = template ? t(`items.${template.key}.name`) : '';
  const icon = template ? <TemplateIcon name={template.icon} size={16} /> : undefined;

  // ── Created ──────────────────────────────────────────────────────────
  if (result && template) {
    const agentName = result.agent.name;
    const hooks = webhookTriggers(result);
    return (
      <FormShell
        open
        onClose={close}
        icon={icon}
        title={t('ui.created.title', { name: agentName })}
        subtitle={t('ui.form.subtitle', { name: templateName, version: result.template.version })}
        primaryAction={{ label: t('ui.created.openAgent'), color: 'teal', onClick: () => onOpenAgent(String(result.agent._id)) }}
        secondaryAction={{ label: t('ui.created.backToTemplates'), variant: 'default', onClick: close }}
      >
        <FormSection title={t('ui.created.nextSteps')} description={[
          result.agent.publishedVersion ? t('ui.created.summaryPublished') : t('ui.created.summaryDraft'),
          result.agent.config?.skills?.length ? t('ui.created.summarySkills', { count: result.agent.config.skills.length }) : null,
          result.triggers.length ? t('ui.created.summaryTriggers', { count: result.triggers.length }) : null,
        ].filter(Boolean).join(' · ')} done>
          <Stack gap="md">
            {hooks.map((trigger) => (
              <div key={trigger.id}>
                <Text size="sm" fw={600} mb={6}>{t('ui.created.webhook', { name: trigger.name })}</Text>
                <CopyRow label={t('ui.created.payloadUrl')} value={trigger.webhook!.url} copyLabel={t('ui.created.copy')} copiedLabel={t('ui.created.copied')} />
                {trigger.webhook!.secret ? (
                  <CopyRow label={t('ui.created.secret')} value={trigger.webhook!.secret} copyLabel={t('ui.created.copy')} copiedLabel={t('ui.created.copied')} secret />
                ) : (
                  <Text size="xs" c="dimmed">{t('ui.created.secretGone')}</Text>
                )}
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={14} />} p="xs">{t('ui.created.secretOnce')}</Alert>
              </div>
            ))}
            {result.setup.length > 0 ? (
              <div>
                <Text size="sm" fw={600} mb={6}>{t('ui.created.setupTitle')}</Text>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {result.setup.map((item) => (
                    <li key={item.code}>
                      {t(`setup.${item.code}`, { tools: item.detail ?? '', names: item.detail ?? '' })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {template.tryIt?.message ? (
              <div>
                <Text size="sm" fw={600} mb={6}>{t('ui.created.tryIt')}</Text>
                <CopyRow label="" value={template.tryIt.message} copyLabel={t('ui.created.copy')} copiedLabel={t('ui.created.copied')} />
              </div>
            ) : null}
            {result.warnings.length > 0 ? (
              <Alert color="gray" variant="light" title={t('ui.created.warnings')}>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                  {result.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}
                </ul>
              </Alert>
            ) : null}
            <Anchor component={Link} href={`/dashboard/agents/${String(result.agent._id)}`} size="sm">{t('ui.created.openAgent')}</Anchor>
          </Stack>
        </FormSection>
      </FormShell>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────
  const blockerText: Record<FormBlocker, string> = {
    name: t('ui.form.blockerName'),
    model: t('ui.form.blockerModel'),
    knowledge: t('ui.form.blockerKnowledge'),
    sandbox: t('ui.form.blockerSandbox'),
    key: t('ui.form.blockerKey'),
    unavailable: t('ui.form.blockerUnavailable'),
  };
  const ready = Boolean(template && form) && blockers.length === 0;
  const webSearchLine = !template?.requires.webSearch
    ? t('ui.form.webSearchUnused')
    : template.availability.items.some((item) => item.code === 'web_search_unavailable')
      ? t('ui.form.webSearchMissing')
      : t('ui.form.webSearchOk');
  let section = 1;

  return (
    <FormShell
      open
      onClose={close}
      icon={icon}
      title={t('ui.form.title')}
      subtitle={template ? t('ui.form.subtitle', { name: templateName, version: template.version }) : undefined}
      summary={template && form && contents ? (
        <>
          <SummaryGroup title={t('ui.form.summary')}>
            <SummaryKV label={t('ui.form.summaryTemplate')} value={`${templateName} v${template.version}`} />
            <SummaryKV label={t('ui.form.summaryModel')} value={facts.models.find((m) => m.value === form.modelKey)?.label ?? t('ui.form.none')} />
            {contents.skills.length > 0 ? <SummaryKV label={t('ui.form.summarySkills')} value={t('ui.form.created', { count: contents.skills.length })} /> : null}
            {contents.subagents.length > 0 ? <SummaryKV label={t('ui.form.summarySubagents')} value={contents.subagents.length} /> : null}
            {contents.variables.length > 0 ? <SummaryKV label={t('ui.form.summaryVariables')} value={contents.variables.length} /> : null}
            {contents.outputFields.length > 0 ? <SummaryKV label={t('ui.form.summaryStructured')} value={t('ui.form.yes')} /> : null}
            {template.triggers.length > 0 ? (
              <SummaryKV label={t('ui.form.summaryTriggers')} value={form.createTriggers ? t('ui.form.triggersDisabled', { count: template.triggers.length }) : t('ui.form.none')} />
            ) : null}
            <SummaryKV label={t('ui.form.summaryState')} value={form.publish ? t('ui.form.statePublished') : t('ui.form.stateDraft')} />
          </SummaryGroup>
        </>
      ) : undefined}
      footerStatus={error ?? (ready ? t('ui.form.ready') : blockers[0] ? blockerText[blockers[0]] : t('ui.form.loading'))}
      primaryAction={{
        label: t('ui.form.create'),
        color: 'teal',
        loading: submitting,
        disabled: !ready,
        onClick: () => { void submit(); },
      }}
      secondaryAction={{ label: t('ui.form.cancel'), variant: 'default', onClick: close }}
    >
      {!template || !form || !contents || detailLoading || !facts.loaded ? (
        <Text size="sm" c="dimmed">{t('ui.form.loading')}</Text>
      ) : (
        <>
          {error ? <Alert color="red" mb="md">{error}</Alert> : null}
          {contents.clientTools.length > 0 ? (
            <Alert color="blue" variant="light" mb="md">{t('hints.clientTools', { tools: contents.clientTools.join(', ') })}</Alert>
          ) : null}

          <FormSection number={section++} title={t('ui.form.basics')} description={t('ui.form.basicsDesc')} done={Boolean(form.name.trim())}>
            <FormRow2>
              <FormField label={t('ui.form.name')} required>
                <TextInput
                  value={form.name}
                  placeholder={templateName}
                  onChange={(event) => patch({ name: event.currentTarget.value })}
                />
              </FormField>
              <FormField label={t('ui.form.key')} hint={t('ui.form.keyHint', { key: template.key })}>
                <TextInput
                  value={form.key}
                  placeholder={template.key}
                  error={blockers.includes('key') ? t('ui.form.keyInvalid') : undefined}
                  onChange={(event) => patch({ key: event.currentTarget.value })}
                />
              </FormField>
            </FormRow2>
          </FormSection>

          <FormSection number={section++} title={t('ui.form.model')} description={t('ui.form.modelDesc')} done={Boolean(form.modelKey)}>
            {facts.models.length === 0 ? (
              <Alert color="yellow" variant="light">{t('ui.form.modelNone')}</Alert>
            ) : (
              <FormField label={t('ui.form.model')} required hint={t(`modelHints.${template.modelHint}`)}>
                <Select
                  data={facts.models}
                  value={form.modelKey}
                  searchable
                  placeholder={t('ui.form.modelPlaceholder')}
                  onChange={(value) => patch({ modelKey: value })}
                />
              </FormField>
            )}
          </FormSection>

          {template.requires.knowledge ? (
            <FormSection number={section++} title={t('ui.form.knowledge')} description={t('ui.form.knowledgeDesc')} done={form.knowledgeKeys.length > 0 || form.knowledgeLater}>
              <Stack gap="xs">
                <MultiSelect
                  data={facts.knowledge}
                  value={form.knowledgeKeys}
                  searchable
                  placeholder={t('ui.form.knowledgePlaceholder')}
                  nothingFoundMessage={t('ui.form.knowledgeNone')}
                  disabled={form.knowledgeLater}
                  onChange={(value) => patch({ knowledgeKeys: value })}
                />
                <Text size="xs" c="dimmed">
                  {facts.knowledge.length === 0 ? `${t('ui.form.knowledgeNone')} ` : ''}
                  <Anchor component={Link} href="/dashboard/rag" size="xs">{t('ui.form.knowledgeCreate')}</Anchor>
                </Text>
                {template.requires.knowledge === 'required' ? (
                  <Checkbox
                    label={t('ui.form.knowledgeLater')}
                    description={t('ui.form.knowledgeLaterHint')}
                    checked={form.knowledgeLater}
                    onChange={(event) => patch({ knowledgeLater: event.currentTarget.checked, knowledgeKeys: event.currentTarget.checked ? [] : form.knowledgeKeys })}
                  />
                ) : null}
              </Stack>
            </FormSection>
          ) : null}

          {contents.needsSandbox ? (
            <FormSection number={section++} title={t('ui.form.sandbox')} description={t('ui.form.sandboxDesc')} done={Boolean(form.sandboxTemplateKey)}>
              {facts.sandboxTemplates.length === 0 ? (
                <Alert color="yellow" variant="light">
                  {t('ui.form.sandboxNone')}{' '}
                  <Anchor component={Link} href="/dashboard/sandbox/templates" size="sm">{t('ui.form.sandboxCreate')}</Anchor>
                </Alert>
              ) : (
                <FormField label={t('ui.form.sandboxTemplate')} required>
                  <Select
                    data={facts.sandboxTemplates}
                    value={form.sandboxTemplateKey}
                    searchable
                    placeholder={t('ui.form.sandboxPlaceholder')}
                    onChange={(value) => patch({ sandboxTemplateKey: value })}
                  />
                </FormField>
              )}
            </FormSection>
          ) : null}

          <FormSection number={section++} title={t('ui.form.tools')} description={t('ui.form.toolsDesc')} done>
            <Stack gap="sm">
              <Text size="sm">{webSearchLine}</Text>
              <FormField
                label={t('ui.form.guardrails')}
                optional
                hint={contents.guardrailsRecommended ? t('ui.form.guardrailsRecommendedHint') : t('ui.form.guardrailsOptionalHint')}
              >
                <MultiSelect
                  data={facts.guardrails}
                  value={form.guardrailKeys}
                  searchable
                  placeholder={t('ui.form.guardrailsPlaceholder')}
                  onChange={(value) => patch({ guardrailKeys: value })}
                />
              </FormField>
            </Stack>
          </FormSection>

          {template.triggers.length > 0 ? (
            <FormSection number={section++} title={t('ui.form.triggers')} description={t('ui.form.triggersDesc')} done={form.createTriggers}>
              <Stack gap="sm">
                <Checkbox
                  label={t('ui.form.createTriggers')}
                  checked={form.createTriggers}
                  onChange={(event) => patch({ createTriggers: event.currentTarget.checked })}
                />
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {template.triggers.map((trigger) => {
                    const line = describeTrigger(trigger);
                    return (
                      <li key={trigger.name}>
                        <strong>{trigger.name}</strong>{' '}
                        <span className="ds-muted">
                          {line.kind === 'schedule'
                            ? t('ui.trigger.schedule', { cron: line.cron })
                            : line.kind === 'webhook'
                              ? t('ui.trigger.webhook', { preset: line.preset })
                              : t('ui.trigger.manual')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <FormField label={t('ui.form.timezone')} hint={t('ui.form.timezoneHint')}>
                  <Select data={zones} value={form.timezone} searchable onChange={(value) => patch({ timezone: value ?? 'UTC' })} />
                </FormField>
              </Stack>
            </FormSection>
          ) : null}

          <FormSection number={section++} title={t('ui.form.publish')} done={form.publish}>
            <ToggleRow label={t('ui.form.publish')} description={t('ui.form.publishDesc')} checked={form.publish} onChange={(checked) => patch({ publish: checked })} />
          </FormSection>
        </>
      )}
    </FormShell>
  );
}

/** Two fields side by side. */
function FormRow2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>{children}</div>;
}
