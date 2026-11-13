'use client';

/**
 * CREATE A GUARDRAIL: A NAME, AND NOTHING ELSE.
 *
 * This modal used to ask five questions before a guardrail existed — a type, a
 * name, a default action, a rollout posture and a streaming toggle — plus a
 * prompt and a model on one branch. Four of them had a defensible default, and
 * a question with a defensible default asked before the thing exists is a
 * question asked at the worst possible moment: nobody knows yet what this
 * guardrail will contain, so nobody can answer it well.
 *
 * WHAT IS NO LONGER ASKED, AND WHAT IS SENT INSTEAD:
 *
 *   · TYPE (`type`) → always `'preset'`. The API requires the field, so it is
 *     still sent; it is no longer a decision. The model-judged rule that used
 *     to live behind this fork is now the `custom` policy in the Add-policy
 *     catalog — configured on a screen that can show it next to everything
 *     else the guardrail does, and with a per-policy model instead of the one
 *     record-level `modelKey` the fork gave it.
 *
 *     WHAT THAT COSTS, STATED PLAINLY, because a comment that overclaims here
 *     is worse than the fork was. `projectHooksToLegacy` DOES compute
 *     `type: 'custom'` for a config whose only enabled policy is a custom one,
 *     and `POST /api/guardrails` writes it (`type: legacy?.type ?? body.type`)
 *     — but `PATCH` does not: `UpdateGuardrailInput` (services/guardrail/
 *     types.ts) has no `type` slot, so the projected value is dropped on every
 *     save. A guardrail created here is therefore `type: 'preset'` for life.
 *     `type: 'custom'` remains a legal stored value and is still reachable —
 *     `POST /api/client/v1/guardrails` accepts it, and the partner SDK wire is
 *     unchanged — it is the CONSOLE that no longer authors one. Nothing in the
 *     hook plane reads the column (the engine runs `hooks.policies`); the two
 *     readers that do are `moderationApi`'s discovery scan, for which
 *     `'preset'` is the permissive value, and the EE gateway's `llmBacked`
 *     hint, which will under-report a preset row whose LLM policy is a custom
 *     one. Restoring the fork means restoring one `FormSection` and the two
 *     fields it gated; making the projection stick instead means adding `type`
 *     to `UpdateGuardrailInput` and both provider mixins, which is a storage
 *     change and not one this pass is entitled to make.
 *   · DEFAULT ACTION (`action`) → not sent. The route defaults the column to
 *     'block', and the first save from the detail page recomputes it from the
 *     policies. There is no guardrail-level default action to author any more;
 *     each policy states its own.
 *   · ROLLOUT (`mode`) → always `'monitor'`, stated in one line below rather
 *     than offered. A brand-new guardrail has no policies at all, so there is
 *     nothing for Enforce to enforce, and the asymmetry is total: an over-eager
 *     monitor guardrail produces a noisy log, an over-eager enforcing one
 *     refuses work people are trying to do. One control on the detail page
 *     flips it once the evaluation log looks right.
 *   · STREAMING → always on, which is what `emptyHooksConfig()` gives a newly
 *     authored configuration anyway. It costs nothing until a policy is bound
 *     to the streaming hook, and the Hooks tab is where that binding — and this
 *     switch — actually live.
 *   · MODEL / CUSTOM PROMPT → not asked. They belong to the policy that needs
 *     them, where the drawer can say which model evaluates which rule.
 *
 * BOTH HALVES OF THE MODE PAIR ARE SENT, from `writeGuardrailMode` — the same
 * function the detail page's Mode control and the list's pause/resume use.
 * `enabled` used to be left to the route's `?? true` default, which happened to
 * agree with `mode: 'monitor'`; that is a coupling to a default in another file
 * rather than a stated intent, and the day it changed every new guardrail would
 * have been created reading as monitoring while evaluating nothing. The pair is
 * assembled in exactly one place, here as everywhere else.
 *
 * START FROM A TEMPLATE. "Blank" is still the default and still sends the
 * request above. Choosing a template instead calls
 * `POST /api/guardrails/templates/:key/apply`, which creates the guardrail with
 * the template's policies already in place (and the template's PII policy,
 * when it needs one) through the same write path, in the same `monitor` mode.
 * The template list is only an offer: if it cannot be loaded, Blank still works.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Text, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconBrain,
  IconFileDots,
  IconLock,
  IconMessageCircle,
  IconPlus,
  IconShield,
  IconShieldCheck,
  IconTool,
} from '@tabler/icons-react';
import FormShell, {
  FormField,
  FormRow,
  FormSection,
  SourceCard,
  SourceToggle,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { GuardrailView } from '@/lib/services/guardrail/constants';
import { writeGuardrailMode } from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailTemplateItem,
  GuardrailTemplateList,
} from '@/lib/services/guardrail/templates/service';

interface CreateGuardrailModalProps {
  opened: boolean;
  onClose: () => void;
  /**
   * `options.streamingEnabled` is carried to the detail page rather than sent
   * to the API: a create call has no hook configuration to attach it to, and
   * posting one with an empty `policies` array would mark the guardrail AUTHORED
   * and stop its freshly built preset policy from ever being lifted — a
   * guardrail that exists, looks configured and evaluates nothing.
   *
   * It is now always `true` — the default a newly authored configuration gets
   * — and the parameter stays in the signature because the caller encodes it
   * into the `?stream=` hand-off either way, and because turning the default
   * back into a question would only mean editing this file rather than the
   * caller.
   */
  onCreated: (guardrail: GuardrailView, options: { streamingEnabled: boolean }) => void;
}

/** The posture every new guardrail starts in. Not a form value: nothing on
 *  this screen can change it, and a state nobody can set is a state that
 *  belongs in one place. */
const INITIAL_MODE = 'monitor' as const;

interface FormValues {
  name: string;
  description: string;
}

/** The "Blank" choice in the Start-from section. Not a template key: keys are kebab-case. */
const BLANK = '';

const CATEGORY_ICONS: Record<string, ReactNode> = {
  baseline: <IconShieldCheck size={15} />,
  data: <IconLock size={15} />,
  security: <IconBrain size={15} />,
  agents: <IconTool size={15} />,
  content: <IconMessageCircle size={15} />,
};

const TARGET_LABELS: Record<string, string> = {
  model: 'models',
  agent: 'agents',
  mcp: 'MCP servers',
};

function TemplateCardBody({ template }: { template: GuardrailTemplateItem }) {
  return (
    <>
      {template.description}
      <span style={{ display: 'block', marginTop: 6 }} className="ds-faint">
        For {template.attachTo.map((t) => TARGET_LABELS[t] ?? t).join(', ')}
        {template.usedBy > 0 ? ` · used ${template.usedBy}× in this project` : ''}
      </span>
    </>
  );
}

export default function CreateGuardrailModal({
  opened,
  onClose,
  onCreated,
}: CreateGuardrailModalProps) {
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<GuardrailTemplateList | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [templateKey, setTemplateKey] = useState<string>(BLANK);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
      setTemplateKey(BLANK);
      return;
    }
    // Re-read on every open: `usedBy` and the reusable PII policy change as
    // guardrails are created.
    let cancelled = false;
    setCatalogError(false);
    fetch('/api/guardrails/templates')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as GuardrailTemplateList;
      })
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setCatalogError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const { values: formValues } = form;

  const template = useMemo(
    () => catalog?.templates.find((t) => t.key === templateKey) ?? null,
    [catalog, templateKey],
  );

  const chooseTemplate = (next: GuardrailTemplateItem | null) => {
    // Follow the choice with the name until the operator types their own.
    const current = form.getValues().name.trim();
    const previousDefault = template?.name ?? '';
    if (!current || current === previousDefault) {
      form.setFieldValue('name', next?.name ?? '');
    }
    setTemplateKey(next?.key ?? BLANK);
  };

  const groups = useMemo(() => {
    if (!catalog) return [];
    return catalog.categories
      .map((category) => ({
        ...category,
        templates: catalog.templates.filter((t) => t.category === category.id),
      }))
      .filter((group) => group.templates.length > 0);
  }, [catalog]);

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setLoading(true);
    try {
      const res = template
        ? await fetch(`/api/guardrails/templates/${encodeURIComponent(template.key)}/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The route starts every template guardrail in monitor itself, and
            // falls back to the template's description when none is given.
            body: JSON.stringify({
              name: values.name,
              description: values.description || undefined,
            }),
          })
        : await fetch('/api/guardrails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: values.name,
              description: values.description || undefined,
              // Required by the route (`VALID_TYPES` is checked before anything
              // else), and no longer a question — see the note at the top.
              type: 'preset',
              // `{ mode: 'monitor', enabled: true }` — never one without the other.
              ...writeGuardrailMode(INITIAL_MODE),
            }),
          });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create guardrail');
      }

      const data = await res.json();
      notifications.show({
        title: 'Guardrail created',
        message: data.piiPolicy?.created
          ? `"${data.guardrail.name}" was created, with the PII policy "${data.piiPolicy.name}"`
          : `"${data.guardrail.name}" was created successfully`,
        color: 'teal',
      });
      onCreated(data.guardrail, { streamingEnabled: true });
      onClose();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to create guardrail',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const validName = Boolean(formValues.name.trim());

  const summary = (
    <SummaryGroup title="Guardrail">
      <SummaryKV
        label="Name"
        value={formValues.name || <span className="ds-faint">—</span>}
      />
      <SummaryKV label="Start from" value={template ? template.name : 'Blank'} />
      <SummaryKV
        label="Mode"
        value={<span className="ds-badge ds-badge-info">monitor</span>}
      />
      <SummaryKV
        label="Policies"
        value={
          template ? (
            template.policies.join(', ')
          ) : (
            <span className="ds-faint">Chosen next</span>
          )
        }
      />
      {template?.piiPolicy ? (
        <SummaryKV
          label="PII policy"
          value={
            template.piiPolicy.existingKey
              ? `${template.piiPolicy.name} (existing)`
              : `${template.piiPolicy.name} (created)`
          }
        />
      ) : null}
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconShield size={16} />}
      title="Create guardrail"
      subtitle="Start blank or from a template, name it, then attach it as an input or output guardrail on a model or agent."
      summary={summary}
      footerStatus={validName ? 'Ready' : 'Needs a name'}
      primaryAction={{
        label: 'Create guardrail',
        icon: <IconPlus size={13} />,
        loading,
        disabled: !validName,
        onClick: handleSubmit,
      }}
    >
      <FormSection
        number={1}
        title="Start from"
        description="A template is a finished set of policies for one job. It is copied into the new guardrail, which you can then edit like any other."
        done
      >
        <SourceToggle>
          <SourceCard
            selected={!template}
            onClick={() => chooseTemplate(null)}
            icon={<IconFileDots size={15} />}
            title="Blank"
            description="No policies yet. You add them on the guardrail's Hooks tab."
          />
        </SourceToggle>
        {groups.map((group) => (
          <div key={group.id} data-testid={`guardrail-template-group-${group.id}`}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={6}>
              {group.label}
            </Text>
            <SourceToggle>
              {group.templates.map((item) => (
                <SourceCard
                  key={item.key}
                  selected={templateKey === item.key}
                  onClick={() => chooseTemplate(item)}
                  icon={CATEGORY_ICONS[item.category] ?? <IconShield size={15} />}
                  title={
                    <>
                      {item.name}
                      {item.recommended ? (
                        <span className="ds-badge ds-badge-teal" style={{ marginLeft: 8 }}>
                          recommended
                        </span>
                      ) : null}
                    </>
                  }
                  description={<TemplateCardBody template={item} />}
                />
              ))}
            </SourceToggle>
          </div>
        ))}
        {!catalog && !catalogError ? (
          <Text size="xs" c="dimmed">Loading templates…</Text>
        ) : null}
        {catalogError ? (
          <Text size="xs" c="dimmed">Templates could not be loaded. You can still start blank.</Text>
        ) : null}
      </FormSection>

      <FormSection
        number={2}
        title="Identity"
        description="How the guardrail surfaces in dashboards and audit logs. Everything else is configured on the guardrail itself, next to the policies it will run."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput
              placeholder="e.g. Block PII leak"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder={template ? template.description : 'What does this guardrail protect against?'}
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>

        {/* The one line the brief asks for, and the only thing this screen says
            about posture. Stated rather than offered. */}
        <div
          className="ds-card ds-card-pad-sm"
          style={{
            background: 'var(--ds-surface-1)',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            marginTop: 8,
          }}
        >
          <IconShield
            size={14}
            style={{ color: 'var(--mantine-color-blue-6)', marginTop: 2 }}
          />
          <Text size="xs" c="dimmed">
            It starts in <strong>Monitor</strong>: everything it checks is evaluated and recorded,
            and nothing is blocked.{' '}
            {template
              ? 'Attach it, watch the evaluation log, then switch it to Enforce.'
              : 'Add the policies it should run, watch the evaluation log, then switch it to Enforce.'}
          </Text>
        </div>
      </FormSection>
    </FormShell>
  );
}
