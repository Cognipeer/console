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
 * WHAT IS NOT ASKED, AND WHAT IS SENT INSTEAD:
 *
 *   · DEFAULT ACTION (`action`) → not sent. The route defaults the column to
 *     'block'; each policy states its own action.
 *   · ROLLOUT (`mode`) → always `'monitor'`, stated in one line below rather
 *     than offered. A brand-new guardrail has no policies at all, so there is
 *     nothing for Enforce to enforce, and the asymmetry is total: an over-eager
 *     monitor guardrail produces a noisy log, an over-eager enforcing one
 *     refuses work people are trying to do. One control on the detail page
 *     flips it once the evaluation log looks right.
 *   · STREAMING → always on, which is what `emptyHooksConfig()` gives a newly
 *     created guardrail. It costs nothing until a policy is bound to the
 *     streaming hook, and the Hooks tab is where that binding — and this
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
 */

import { useEffect, useState } from 'react';
import { Text, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconShield, IconPlus } from '@tabler/icons-react';
import FormShell, {
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { GuardrailView } from '@/lib/services/guardrail/constants';
import { writeGuardrailMode } from '@/lib/services/guardrail/hooks/contract';

interface CreateGuardrailModalProps {
  opened: boolean;
  onClose: () => void;
  /**
   * `options.streamingEnabled` is carried to the detail page rather than sent
   * to the API: the server creates the guardrail with an empty configuration
   * that already has streaming on.
   *
   * It is always `true` — the default a new configuration gets — and the
   * parameter stays in the signature because the caller encodes it into the
   * `?stream=` hand-off either way.
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

export default function CreateGuardrailModal({
  opened,
  onClose,
  onCreated,
}: CreateGuardrailModalProps) {
  const [loading, setLoading] = useState(false);

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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const { values: formValues } = form;

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setLoading(true);
    try {
      const res = await fetch('/api/guardrails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
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
        message: `"${data.guardrail.name}" was created successfully`,
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
      <SummaryKV
        label="Mode"
        value={<span className="ds-badge ds-badge-info">monitor</span>}
      />
      <SummaryKV label="Policies" value={<span className="ds-faint">Chosen next</span>} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconShield size={16} />}
      title="Create guardrail"
      subtitle="Name it now, then say what it checks for. Attach it as an input or output guardrail on a model or agent."
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
              placeholder="What does this guardrail protect against?"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>

        {/* The one line the brief asks for, and the only thing this screen says
            about posture. Stated rather than offered: there is nothing to
            enforce yet. */}
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
            and nothing is blocked. Add the policies it should run, watch the evaluation log, then
            switch it to Enforce.
          </Text>
        </div>
      </FormSection>
    </FormShell>
  );
}
