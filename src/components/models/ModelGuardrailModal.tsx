'use client';

/**
 * Guardrail binding for one model.
 *
 * It used to be two Selects writing `inputGuardrailKey` / `outputGuardrailKey`.
 * It is now the binding LIST — several guardrails, each naming the hooks it
 * covers here — because one slot per direction cannot compose two reusable
 * guardrails and has nowhere to put a tool binding at all.
 *
 * A full-screen `FormShell` rather than the small `Modal` it was: per the repo
 * rule every create/edit screen is a full-screen overlay, and this one now has
 * a variable number of rows, five checkboxes each and per-row warnings — it
 * outgrew a centred `size="md"` dialog.
 *
 * A model still on the legacy slots is SEEDED from them and editable straight
 * away. There used to be a read-only "Migrate to list" step first; it protected
 * against a conversion losing the stream binding, which measurement showed it
 * cannot — see the note in `GuardrailBindingList`. Two ways to bind one
 * guardrail on one screen was the confusion, not the safeguard.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Group, Loader, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck, IconShield } from '@tabler/icons-react';
import FormShell, { FormSection } from '@/components/common/ui/FormShell';
import GuardrailBindingList, {
  bindingRowsFromStored,
  type GuardrailBindingOption,
  type GuardrailBindingRow,
} from '@/components/guardrails/GuardrailBindingList';

interface ModelGuardrailModalProps {
  opened: boolean;
  modelId: string;
  modelName: string;
  /** Legacy slots, as the list page already has them. Used only as the seed
   *  until the authoritative record arrives from `GET /api/models/:id`. */
  initialInputGuardrailKey?: string;
  initialOutputGuardrailKey?: string;
  onClose: () => void;
  onSaved: (bindings: GuardrailBindingRow[]) => void;
}

/**
 * The legacy slots, as the equivalent binding list.
 *
 * The output slot seeds `output.pre` ONLY, not `output.stream.delta`, even
 * though `resolveBindings` projects the legacy key onto both. A guardrail
 * written before the hook plane declares no streaming binding, so the stream
 * gate evaluates nothing for it today — seeding a hook the guardrail cannot
 * serve would render as a ticked box that does nothing, and the server would
 * reject it. The checkbox becomes available the moment the guardrail itself
 * enables streaming.
 */
function seedFromLegacySlots(
  inputKey: string | undefined,
  outputKey: string | undefined,
): GuardrailBindingRow[] {
  // Materialised rows: a legacy slot names ONE direction, so "wherever the
  // guardrail declares" (an absent `hooks`) is not what it meant — the
  // conversion has to be the exact equivalent of the two slots or it is not a
  // conversion.
  const rows: Array<Required<GuardrailBindingRow>> = [];
  const bind = (key: string | undefined, hook: Required<GuardrailBindingRow>['hooks'][number]) => {
    if (!key) return;
    const existing = rows.find((row) => row.key === key);
    if (existing) {
      if (!existing.hooks.includes(hook)) existing.hooks.push(hook);
      return;
    }
    rows.push({ key, hooks: [hook] });
  };
  bind(inputKey, 'input.pre');
  bind(outputKey, 'output.pre');
  return rows;
}

export default function ModelGuardrailModal({
  opened,
  modelId,
  modelName,
  initialInputGuardrailKey,
  initialOutputGuardrailKey,
  onClose,
  onSaved,
}: ModelGuardrailModalProps) {
  const [options, setOptions] = useState<GuardrailBindingOption[]>([]);
  const [bindings, setBindings] = useState<GuardrailBindingRow[]>([]);
  /** True while the model is still on the legacy slots and the operator has not
   *  converted. The list is read-only until then, so the one-way conversion is
   *  an explicit act and not a side effect of saving an unrelated change. */
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [guardrailRes, modelRes] = await Promise.all([
        // Unfiltered on purpose: a guardrail disabled AFTER it was bound must
        // still render as a (badged) row. `GuardrailBindingList` keeps disabled
        // ones out of the picker instead.
        fetch('/api/guardrails', { cache: 'no-store' }),
        // The record, not the list page's row: `guardrails` is what decides
        // whether this model is on the list or still on the legacy slots, and
        // the list page does not carry it.
        fetch(`/api/models/${modelId}`, { cache: 'no-store' }),
      ]);

      if (guardrailRes.ok) {
        const data = await guardrailRes.json();
        setOptions((data.guardrails ?? []) as GuardrailBindingOption[]);
      }

      const model = modelRes.ok
        ? ((await modelRes.json()).model as {
          guardrails?: GuardrailBindingRow[];
          inputGuardrailKey?: string;
          outputGuardrailKey?: string;
        })
        : undefined;

      const stored = model?.guardrails;
      if (Array.isArray(stored)) {
        // Already on the list — including an explicitly empty one, which is a
        // real operator decision ("bound to nothing") and not a legacy row.
        //
        // Shared mapping: an absent `hooks` must stay absent, or "wherever the
        // guardrail declares" becomes "runs nowhere" on the next Save.
        setBindings(bindingRowsFromStored(stored));
        return;
      }

      const inputKey = model?.inputGuardrailKey ?? initialInputGuardrailKey;
      const outputKey = model?.outputGuardrailKey ?? initialOutputGuardrailKey;
      const seeded = seedFromLegacySlots(inputKey || undefined, outputKey || undefined);
      setBindings(seeded);
      // A model with neither slot set is simply unbound, not legacy: showing it
      // a migration banner would ask an operator to convert nothing.
    } catch (err) {
      console.error('[model-guardrail-modal]', err);
    } finally {
      setLoading(false);
    }
  }, [modelId, initialInputGuardrailKey, initialOutputGuardrailKey]);

  useEffect(() => {
    if (!opened) return;
    void load();
  }, [opened, load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Only `guardrails` is sent: the API derives the deprecated slots from it
      // so an older console binary on the same tenant DB keeps enforcing, and
      // sending both would let the two disagree.
      const res = await fetch(`/api/models/${modelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guardrails: bindings }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? 'Failed to save');
      }
      notifications.show({
        title: 'Guardrails saved',
        message: `Guardrail bindings updated for "${modelName}"`,
        color: 'teal',
        icon: <IconCheck size={16} />,
      });
      onSaved(bindings);
      onClose();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to save',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconShield size={16} />}
      title="Guardrail bindings"
      subtitle={modelName}
      primaryAction={{
        label: 'Save',
        icon: <IconShield size={14} />,
        loading: saving,
        // Not gated on `options.length`: a binding whose guardrail was deleted
        // (or whose list failed to load) still has to be removable, and a Save
        // the operator cannot press after removing it is a dead end.
        disabled: loading,
        onClick: handleSave,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
      footerStatus={`${bindings.length} guardrail${bindings.length === 1 ? '' : 's'} attached`}
    >
      <FormSection
        number={1}
        title="Attached guardrails"
        description="Guardrails run automatically on every request to this model. Each one covers the hooks you tick — the prompt before the model sees it, the answer before it reaches the caller, or the answer while it streams."
        done={bindings.length > 0}
      >
        {loading ? (
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        ) : (
          <GuardrailBindingList
            options={options}
            value={bindings}
            onChange={setBindings}
            surface="model"
          />
        )}
      </FormSection>

      <FormSection
        title="How binding works"
        description="Why a hook may be unavailable here."
      >
        <Alert icon={<IconAlertCircle size={16} />} color="blue" variant="light" p="sm">
          <Text size="xs">
            A hook can only be ticked when the guardrail has an enabled policy bound to it.
            If a box is greyed out, open the guardrail and enable a policy on that hook
            first — a binding to a hook the guardrail does not serve would look configured
            and never run.
          </Text>
        </Alert>
      </FormSection>
    </FormShell>
  );
}
