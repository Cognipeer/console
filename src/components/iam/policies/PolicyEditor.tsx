'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconCode,
  IconDeviceFloppy,
  IconShieldCheck,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormSection,
  SourceCard,
  SourceToggle,
  SummaryGroup,
  SummaryKV,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { useConfirm } from '@/components/common/confirm';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useTranslations } from '@/lib/i18n';
import {
  IamApiError,
  iamApi,
  type IamCatalog,
  type IamPrincipalType,
  type PolicyRow,
  type PolicySource,
  type PolicyWriteBody,
  type ValidationDetail,
} from '../api';
import type { CatalogIndex } from '../catalogModel';
import { resolvePrincipalLabels, resolveResourceLabels } from '../pickers/principalLabels';
import { useProjects } from '../pickers/lookups';
import { useErrorText } from '../useErrorText';
import type { IamLabels } from '../useIamLabels';
import ActionMatrix from './ActionMatrix';
import CedarView, { IssueList } from './CedarView';
import ConditionsSection from './ConditionsSection';
import ImpactPanel, { coverageKind, type PreviewState } from './ImpactPanel';
import WhereSection from './WhereSection';
import WhoSection from './WhoSection';
import { describeSpec } from './specSummary';
import {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  copyName,
  draftFromRow,
  draftSignature,
  draftToSpec,
  emptyDraft,
  hasIssue,
  resourceKey,
  summarizeSpec,
  validateDraft,
  withPrincipal,
  withResource,
  type PolicyDraft,
  type PrincipalRef,
  type ResourceRef,
} from './specModel';
import { splitWarnings } from './issues';
import { useCompile } from './useCompile';
import classes from './policyEditor.module.css';

export interface PolicyEditorTarget {
  kind: 'create' | 'edit' | 'duplicate';
  /** The policy being edited / copied. */
  policy?: PolicyRow;
  /** Deep-link prefill: the new policy is about this principal. */
  prefill?: { type: IamPrincipalType; ref: PrincipalRef };
  /** Deep-link prefill: the new policy is about this resource (a portal to block someone from). */
  resourcePrefill?: ResourceRef;
}

interface PolicyEditorProps {
  target: PolicyEditorTarget;
  catalog: IamCatalog;
  index: CatalogIndex;
  labels: IamLabels;
  onClose: () => void;
  onSaved: (row: PolicyRow, kind: PolicyEditorTarget['kind']) => void;
}

const CEDAR_STARTER = [
  '// Write one or more permit / forbid statements. Example:',
  '// forbid (',
  '//   principal in Group::"<group id>",',
  '//   action in Action::"Write",',
  '//   resource',
  '// ) when { resource.service == "agents" };',
  '',
].join('\n');

function initialDraft(target: PolicyEditorTarget, copySuffix: string): PolicyDraft {
  if (target.kind === 'create' || !target.policy) {
    let draft = emptyDraft();
    if (target.resourcePrefill) draft = withResource(draft, target.resourcePrefill);
    return target.prefill ? withPrincipal(draft, target.prefill.type, target.prefill.ref) : draft;
  }
  const draft = draftFromRow(target.policy);
  if (target.kind === 'duplicate') {
    // A copy starts disabled: it is a draft until someone looks at it and switches it on.
    return { ...draft, name: copyName(draft.name, copySuffix), enabled: false };
  }
  return draft;
}

function relabel(refs: PrincipalRef[], names: Map<string, string>): PrincipalRef[] {
  return refs.map((r) => ({ ...r, label: names.get(r.id) ?? r.label }));
}

export default function PolicyEditor({
  target,
  catalog,
  index,
  labels,
  onClose,
  onSaved,
}: PolicyEditorProps) {
  const t = useTranslations('iamCenter');
  const { confirm } = useConfirm();
  const errorText = useErrorText();
  const { projects } = useProjects();
  const shellUser = useDashboardUser();
  // Only owners and admins can turn on a rule that allows access (the server enforces it; this is the heads-up).
  const mayEnablePermits = !shellUser?.role || shellUser.role === 'owner' || shellUser.role === 'admin';

  const isEdit = target.kind === 'edit' && !!target.policy;
  const policy = target.policy;

  // Everything the editor starts from, computed once: a stored raw policy opens in Cedar mode.
  const [init] = useState(() => {
    const initial = initialDraft(target, t('editor.copySuffix'));
    const rawText = target.policy && !target.policy.spec && target.kind !== 'create' ? target.policy.cedar : null;
    return { draft: initial, rawText, signature: `${draftSignature(initial)}|${rawText ?? ''}` };
  });
  const [draft, setDraft] = useState<PolicyDraft>(init.draft);
  // Raw Cedar mode: a form policy can switch to it (one way).
  const [raw, setRaw] = useState<{ text: string } | null>(init.rawText !== null ? { text: init.rawText } : null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; details: ValidationDetail[] } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const closing = useRef(false);

  const patch = useCallback((change: Partial<PolicyDraft>) => setDraft((d) => ({ ...d, ...change })), []);

  // The spec stores ids; look the names up (once) so the chips read as people, not ids.
  useEffect(() => {
    const spec = target.policy?.spec;
    if (!spec || target.kind === 'create') return;
    let cancelled = false;
    const s = summarizeSpec(spec);
    void Promise.all([
      resolvePrincipalLabels('user', s.userIds),
      resolvePrincipalLabels('group', s.groupIds),
      resolvePrincipalLabels('token', s.tokenIds),
      resolveResourceLabels(s.resources),
    ]).then(([users, groups, tokens, resources]) => {
      if (cancelled) return;
      setDraft((d) => ({
        ...d,
        users: relabel(d.users, users),
        groups: relabel(d.groups, groups),
        tokens: relabel(d.tokens, tokens),
        resources: d.resources.map((r) => ({ ...r, label: resources.get(resourceKey(r)) ?? r.label })),
      }));
    });
    return () => {
      cancelled = true;
    };
    // Runs once for the policy this editor was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const issues = useMemo(() => validateDraft(draft), [draft]);
  const specIssues = useMemo(() => issues.filter((i) => i.code !== 'name'), [issues]);
  const spec = useMemo(() => (raw ? null : draftToSpec(draft)), [raw, draft]);

  const source = useMemo<PolicySource | null>(
    () => (raw ? (raw.text.trim() ? { cedar: raw.text } : null) : specIssues.length === 0 && spec ? { spec } : null),
    [raw, specIssues, spec],
  );
  const compile = useCompile(source);
  const { inert: inertWarnings, other: otherWarnings } = useMemo(() => splitWarnings(compile.warnings), [compile.warnings]);
  const lineLabel = useCallback(
    (line: number, col?: number) => (col ? t('editor.lineCol', { line, col }) : t('editor.line', { line })),
    [t],
  );

  const dirty = `${draftSignature(draft)}|${raw ? raw.text : ''}` !== init.signature;

  // Any edit makes an earlier preview stale.
  const lastSourceKey = useRef('');
  const sourceKey = source ? JSON.stringify(source) : '';
  useEffect(() => {
    if (lastSourceKey.current === sourceKey) return;
    lastSourceKey.current = sourceKey;
    setPreview((p) => (p.status === 'done' ? { ...p, stale: true } : p));
  }, [sourceKey]);

  const nameOk = draft.name.trim() !== '';
  const formComplete = raw ? raw.text.trim() !== '' : issues.length === 0;
  const canPreview = !!source && compile.status !== 'invalid' && compile.status !== 'checking';

  const lastConfirmAt = useRef(0);
  const requestClose = useCallback(async () => {
    if (closing.current || saving) return;
    if (dirty) {
      closing.current = true;
      const ok = await confirm({
        title: t('editor.discardTitle'),
        message: t('editor.discardMessage'),
        confirmLabel: t('editor.discard'),
        cancelLabel: t('editor.keepEditing'),
        tone: 'warning',
      });
      closing.current = false;
      lastConfirmAt.current = Date.now();
      if (!ok) return;
    }
    onClose();
  }, [confirm, dirty, onClose, saving, t]);

  // Escape leaves the editor, but not when it is only meant for something on top of it: an open
  // list (Select, MultiSelect, date picker) closes itself on Escape, and a confirmation closes on
  // Escape without the same keystroke then also closing (or re-opening) the discard question.
  useEffect(() => {
    // Mantine keeps a closed list in the DOM with `display: none` on its wrapper: look up the tree.
    const isShown = (el: Element) => {
      for (let node: HTMLElement | null = el as HTMLElement; node; node = node.parentElement) {
        if (node.hidden || node.style.display === 'none') return false;
      }
      return true;
    };
    // Capture phase: the state is read before the list (or modal) reacts to the same keystroke.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ([...document.querySelectorAll('.mantine-Popover-dropdown, .mantine-Combobox-dropdown, [role="listbox"]')].some(isShown)) return;
      if ([...document.querySelectorAll('.mantine-Modal-root')].some(isShown)) return;
      if (Date.now() - lastConfirmAt.current < 400) return;
      void requestClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

  const switchToCedar = useCallback(async () => {
    const ok = await confirm({
      title: t('editor.rawConfirmTitle'),
      message: t('editor.rawConfirmMessage'),
      confirmLabel: t('editor.rawConfirm'),
      tone: 'warning',
    });
    if (!ok) return;
    const text =
      compile.status === 'ok' && compile.cedar
        ? compile.cedar
        : isEdit && policy && !dirty
          ? policy.cedar
          : CEDAR_STARTER;
    setRaw({ text });
    setSaveError(null);
  }, [compile.cedar, compile.status, confirm, dirty, isEdit, policy, t]);

  const runPreview = useCallback(async () => {
    if (!source) return;
    setPreview({ status: 'loading' });
    try {
      const data = await iamApi.previewPolicy({
        ...(isEdit && policy ? { policyId: policy.policyId } : {}),
        ...('spec' in source ? { spec: source.spec } : { cedar: source.cedar }),
      });
      setPreview({ status: 'done', data, stale: false });
    } catch (err) {
      setPreview({ status: 'error', message: errorText(err, t('impact.failed')) });
    }
  }, [errorText, isEdit, policy, source, t]);

  const save = useCallback(async () => {
    setShowErrors(true);
    if (!nameOk || !formComplete) return; // the inline errors say what is missing
    if (compile.status === 'invalid') {
      setSaveError({ message: t('editor.fixCedar'), details: compile.errors });
      return;
    }
    setSaveError(null);

    // A rule the engine can never match: say so before it is saved, whatever else is true of it.
    if (inertWarnings.length > 0) {
      const ok = await confirm({
        title: t('editor.inertConfirmTitle'),
        message: t('editor.inertConfirmMessage'),
        details: (
          <IssueList items={inertWarnings} tone="warning" lineLabel={lineLabel} />
        ),
        confirmLabel: t('editor.inertConfirmAction'),
        tone: 'warning',
      });
      if (!ok) return;
    }

    // An enabled policy decides real requests from the moment it is saved.
    const takesEffectNow = draft.enabled && (!isEdit || !policy?.enabled || dirty);
    if (takesEffectNow) {
      const flips = preview.status === 'done' && !preview.stale ? preview.data.flips : null;
      const sampled = preview.status === 'done' && !preview.stale && coverageKind(preview.data.principals) !== 'all';
      const ok = await confirm({
        title: t('editor.applyConfirmTitle'),
        message: t('editor.applyConfirmMessage'),
        details: flips ? (
          <Text size="sm">
            {t('editor.applyConfirmFlips', { deny: flips.allowToDeny, allow: flips.denyToAllow })}
            {sampled && preview.status === 'done'
              ? ` ${t('editor.applyConfirmSample', { evaluated: preview.data.principals.evaluated })}`
              : ''}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            {t('editor.applyConfirmNoPreview')}
          </Text>
        ),
        confirmLabel: t('editor.applyConfirmAction'),
        tone: 'warning',
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      const description = draft.description.trim();
      const body: PolicyWriteBody = {
        name: draft.name.trim(),
        // PUT replaces: an empty string clears the description. POST simply omits it.
        ...(isEdit || description ? { description } : {}),
        enabled: draft.enabled,
        ...(raw ? { cedar: raw.text } : { spec: draftToSpec(draft) }),
      };
      const row = isEdit && policy ? await iamApi.updatePolicy(policy.policyId, body) : await iamApi.createPolicy(body);
      notifications.show({
        color: 'green',
        message: isEdit ? t('editor.saved') : t('editor.created'),
      });
      onSaved(row, target.kind);
    } catch (err) {
      setSaveError({
        message: err instanceof IamApiError && err.status === 403 ? t('errors.forbidden') : errorText(err, t('editor.saveFailed')),
        details: err instanceof IamApiError ? err.details : [],
      });
    } finally {
      setSaving(false);
    }
  }, [compile.errors, compile.status, confirm, dirty, draft, errorText, formComplete, inertWarnings, isEdit, lineLabel, nameOk, onSaved, policy, preview, raw, t, target.kind]);

  // ── summary pane ───────────────────────────────────────────────────────

  const lines = useMemo(() => {
    if (!spec) return null;
    return describeSpec(spec, {
      t,
      labels,
      groupNames: new Map(draft.groups.map((g) => [g.id, g.label])),
      userNames: new Map(draft.users.map((u) => [u.id, u.label])),
      tokenNames: new Map(draft.tokens.map((x) => [x.id, x.label])),
      projectNames: new Map(projects.map((p) => [p.id, p.name])),
    });
  }, [spec, t, labels, draft.groups, draft.users, draft.tokens, projects]);

  const cedarErrors = useMemo<ValidationDetail[]>(() => {
    const fromServer = saveError?.details ?? [];
    return compile.errors.length > 0 ? compile.errors : fromServer;
  }, [compile.errors, saveError]);

  const cedarStatus =
    compile.status === 'checking' ? (
      <Group gap={6}>
        <Loader size={12} />
        <Text size="xs" c="dimmed">
          {t('editor.cedar.checking')}
        </Text>
      </Group>
    ) : compile.status === 'ok' ? (
      <Badge color="green" variant="light" leftSection={<IconCheck size={11} />}>
        {t('editor.cedar.valid')}
      </Badge>
    ) : compile.status === 'invalid' ? (
      <Badge color="red" variant="light">
        {t('editor.cedar.invalid')}
      </Badge>
    ) : compile.status === 'failed' ? (
      <Badge color="orange" variant="light">
        {t('editor.cedar.unavailable')}
      </Badge>
    ) : null;

  // Problems and warnings belong in the form, not only in the side pane: on a phone the pane is collapsed.
  const problems =
    compile.status === 'invalid' && compile.errors.length > 0 ? (
      <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title={t('editor.problems')}>
        <IssueList items={compile.errors} tone="error" lineLabel={lineLabel} />
      </Alert>
    ) : null;
  // A rule that can never match is the loudest thing on the page: saving it changes nothing.
  const inertAlert =
    inertWarnings.length > 0 ? (
      <Alert
        color="orange"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title={t('editor.inertTitle')}
        data-testid="inert-warning"
      >
        <Stack gap={4}>
          <Text size="sm">{t('editor.inertIntro')}</Text>
          <IssueList items={inertWarnings} tone="warning" lineLabel={lineLabel} />
        </Stack>
      </Alert>
    ) : null;
  const warnings =
    otherWarnings.length > 0 ? (
      <Alert color="yellow" variant="light" title={t('editor.warnings')}>
        <IssueList items={otherWarnings} tone="warning" lineLabel={lineLabel} />
      </Alert>
    ) : null;

  const checklist = [
    { id: 'name', label: t('editor.check.name'), done: nameOk },
    { id: 'who', label: t('editor.check.who'), done: raw ? true : !hasIssue(issues, 'who') },
    { id: 'what', label: t('editor.check.what'), done: raw ? true : !hasIssue(issues, 'actions') },
    {
      id: 'where',
      label: t('editor.check.where'),
      done: raw ? true : !(hasIssue(issues, 'services') || hasIssue(issues, 'projects') || hasIssue(issues, 'resources')),
    },
    { id: 'cedar', label: t('editor.check.cedar'), done: compile.status === 'ok' || compile.status === 'failed' },
  ];
  const readyCount = checklist.filter((c) => c.done).length;

  const summary = (
    <>
      <SummaryGroup title={t('editor.summary.policy')}>
        <SummaryKV label={t('editor.effect')} value={raw ? t('editor.inCedar') : labels.effect(draft.effect)} />
        <SummaryKV label={t('editor.status')} value={draft.enabled ? t('editor.enabled') : t('editor.disabled')} />
      </SummaryGroup>

      {lines ? (
        <SummaryGroup title={t('editor.summary.applies')}>
          <SummaryKV label={t('summary.who')} value={lines.who || <span className="ds-faint">—</span>} />
          <SummaryKV label={t('summary.what')} value={lines.what || <span className="ds-faint">—</span>} />
          <SummaryKV label={t('summary.where')} value={lines.where || <span className="ds-faint">—</span>} />
          {lines.when ? <SummaryKV label={t('summary.when')} value={lines.when} /> : null}
        </SummaryGroup>
      ) : null}

      <SummaryGroup title={t('editor.summary.cedar')}>
        <Group justify="space-between" mb={8}>
          <Text size="xs" c="dimmed">
            {raw ? t('editor.cedar.yourPolicy') : t('editor.cedar.generated')}
          </Text>
          {cedarStatus}
        </Group>
        <CedarView
          code={raw ? raw.text : compile.cedar}
          errors={cedarErrors}
          maxHeight={300}
          empty={<span>{t('editor.cedar.empty')}</span>}
        />
        {compile.failure ? (
          <Text size="xs" c="dimmed" mt={6}>
            {compile.failure}
          </Text>
        ) : null}
        {!raw ? (
          <Button
            variant="default"
            size="compact-sm"
            mt={8}
            leftSection={<IconCode size={14} />}
            onClick={() => void switchToCedar()}
            disabled={saving}
          >
            {t('editor.editAsCedar')}
          </Button>
        ) : null}
      </SummaryGroup>

      <SummaryGroup title={t('editor.summary.preflight')}>
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const title = isEdit
    ? t('editor.titleEdit')
    : target.kind === 'duplicate'
      ? t('editor.titleDuplicate')
      : t('editor.titleCreate');

  return (
    <FormShell
      open
      onClose={() => void requestClose()}
      icon={<IconShieldCheck size={16} />}
      title={title}
      subtitle={t('editor.subtitle')}
      disableEscape
      summary={summary}
      footerStatus={t('editor.ready', { done: readyCount, total: checklist.length })}
      primaryAction={{
        label: isEdit ? t('editor.saveChanges') : t('editor.createPolicy'),
        icon: <IconDeviceFloppy size={14} />,
        loading: saving,
        disabled: saving,
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: () => void requestClose() }}
    >
      <Stack gap={0}>
        {saveError ? (
          <Alert
            color="red"
            variant="light"
            mb="lg"
            icon={<IconAlertTriangle size={16} />}
            title={t('editor.saveFailed')}
          >
            <Stack gap={4}>
              <Text size="sm">{saveError.message}</Text>
              {saveError.details.length > 0 ? (
                <IssueList items={saveError.details} tone="error" lineLabel={lineLabel} />
              ) : null}
            </Stack>
          </Alert>
        ) : null}

        {!raw && (problems || inertAlert || warnings) ? (
          <Stack gap="sm" mb="lg">
            {problems}
            {inertAlert}
            {warnings}
          </Stack>
        ) : null}

        <FormSection number={1} title={t('editor.basics')} description={t('editor.basicsHelp')} done={nameOk}>
          <Stack gap="md">
            <FormField label={t('editor.name')} required>
              <TextInput
                value={draft.name}
                onChange={(e) => patch({ name: e.currentTarget.value })}
                placeholder={t('editor.namePlaceholder')}
                maxLength={NAME_MAX_LENGTH}
                error={showErrors && !nameOk ? t('validation.name') : undefined}
                data-autofocus
              />
            </FormField>
            <FormField label={t('editor.description')} optional>
              <Textarea
                value={draft.description}
                onChange={(e) => patch({ description: e.currentTarget.value })}
                placeholder={t('editor.descriptionPlaceholder')}
                maxLength={DESCRIPTION_MAX_LENGTH}
                autosize
                minRows={2}
                maxRows={5}
              />
            </FormField>
            <ToggleRow
              label={t('editor.enabledLabel')}
              description={t('editor.enabledHelp')}
              checked={draft.enabled}
              onChange={(enabled) => patch({ enabled })}
            />
            {!mayEnablePermits && !raw && draft.effect === 'permit' && draft.enabled ? (
              <Alert color="blue" variant="light" data-testid="permit-admin-hint">
                {t('editor.permitNeedsAdmin')}
              </Alert>
            ) : null}
          </Stack>
        </FormSection>

        {raw ? (
          <FormSection number={2} title={t('editor.cedarSection')} description={t('editor.cedarSectionHelp')} done={compile.status === 'ok'}>
            <Stack gap="xs">
              <Textarea
                className={classes.rawEditor}
                value={raw.text}
                onChange={(e) => setRaw({ text: e.currentTarget.value })}
                autosize
                minRows={14}
                maxRows={32}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={t('editor.cedarSection')}
                error={showErrors && raw.text.trim() === '' ? t('validation.cedar') : undefined}
              />
              {catalog.contextAttrs.length > 0 ? (
                <Text size="xs" c="dimmed">
                  {t('editor.contextAttrs', { attrs: catalog.contextAttrs.map((a) => `context.${a}`).join(', ') })}
                </Text>
              ) : null}
              <Text size="xs" c="dimmed">
                {t('editor.cedarNoManaged')}
              </Text>
              {problems}
              {inertAlert}
              {warnings}
            </Stack>
          </FormSection>
        ) : (
          <>
            <FormSection number={2} title={t('editor.effectSection')} description={t('editor.effectHelp')} done>
              <SourceToggle>
                <SourceCard
                  selected={draft.effect === 'permit'}
                  onClick={() => patch({ effect: 'permit' })}
                  icon={<IconShieldCheck size={16} />}
                  title={t('effects.permit')}
                  description={t('editor.effectPermitHelp')}
                />
                <SourceCard
                  selected={draft.effect === 'forbid'}
                  onClick={() => patch({ effect: 'forbid' })}
                  icon={<IconBan size={16} />}
                  title={t('effects.forbid')}
                  description={t('editor.effectForbidHelp')}
                />
              </SourceToggle>
            </FormSection>

            <FormSection
              number={3}
              title={t('editor.whoSection')}
              description={t('editor.whoHelp')}
              done={!hasIssue(issues, 'who')}
            >
              <WhoSection draft={draft} patch={patch} showError={showErrors && hasIssue(issues, 'who')} />
            </FormSection>

            <FormSection
              number={4}
              title={t('editor.whatSection')}
              description={t('editor.whatHelp')}
              done={!hasIssue(issues, 'actions')}
            >
              <ActionMatrix
                catalog={catalog}
                index={index}
                labels={labels}
                effect={draft.effect}
                value={draft.actions}
                onChange={(actions) => patch({ actions })}
                error={showErrors && hasIssue(issues, 'actions') ? t('validation.actions') : undefined}
              />
            </FormSection>

            <FormSection
              number={5}
              title={t('editor.whereSection')}
              description={t('editor.whereHelp')}
              done={!(hasIssue(issues, 'services') || hasIssue(issues, 'projects') || hasIssue(issues, 'resources'))}
            >
              <WhereSection draft={draft} patch={patch} catalog={catalog} labels={labels} showError={showErrors} />
            </FormSection>

            <FormSection
              number={6}
              title={t('editor.conditionsSection')}
              description={t('editor.conditionsHelp')}
              collapsible
              defaultOpen={
                !!(draft.validFrom || draft.validUntil || draft.ipRanges.length > 0 || draft.channels.length > 0)
              }
              done={!hasIssue(issues, 'timeOrder') && !hasIssue(issues, 'ip')}
            >
              <ConditionsSection draft={draft} patch={patch} catalog={catalog} labels={labels} issues={issues} />
            </FormSection>
          </>
        )}

        <FormSection
          number={raw ? 3 : 7}
          title={t('editor.impactSection')}
          description={t('editor.impactHelp')}
        >
          <ImpactPanel state={preview} labels={labels} canRun={canPreview} onRun={() => void runPreview()} />
        </FormSection>
      </Stack>
    </FormShell>
  );
}
