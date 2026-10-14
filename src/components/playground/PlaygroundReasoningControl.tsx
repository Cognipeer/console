'use client';

import { useTranslations } from '@/lib/i18n';
import { reasoningBudget, type ReasoningEffort } from '@/lib/services/models/reasoning';
import type { PlaygroundReasoningControl as Control, PlaygroundReasoningHint } from './playgroundReasoning';

interface PlaygroundReasoningControlProps {
  control: Control;
  /** '' = "Model default": nothing is sent. */
  value: '' | ReasoningEffort;
  onChange: (next: '' | ReasoningEffort) => void;
}

/**
 * Compact "Reasoning" picker for the model playgrounds: "Model default", then the levels
 * that fit the model. When the model carries a Model Hub default it wins over any request,
 * so the control shows that value, locked, and says where to change it.
 */
export default function PlaygroundReasoningControl({ control, value, onChange }: PlaygroundReasoningControlProps) {
  const t = useTranslations('modelReasoning');
  const label = (effort: ReasoningEffort) =>
    control.kind === 'toggle' ? t(`toggle.${effort}`) : t(`effort.${effort}`);

  if (control.pinned) {
    const { effort, budgetTokens } = control.pinned;
    const budget = reasoningBudget(control.pinned);
    const text = effort
      ? label(effort)
      : budgetTokens && budget
        ? t('detail.budget', { tokens: budget.toLocaleString() })
        : t('playground.control.modelDefault');
    return (
      <div data-testid="playground-reasoning-control">
        <div className="ds-eyebrow" style={{ marginBottom: 6 }}>{t('playground.control.label')}</div>
        <select
          className="ds-select"
          value="pinned"
          disabled
          aria-label={t('playground.control.label')}
          style={{ width: '100%' }}
        >
          <option value="pinned">{text}</option>
        </select>
        <div className="ds-faint" style={{ fontSize: 11.5, marginTop: 4 }} data-testid="playground-reasoning-pinned">
          {t('playground.control.pinned')}
        </div>
      </div>
    );
  }

  const selected = control.efforts.includes(value as ReasoningEffort) ? value : '';
  return (
    <div data-testid="playground-reasoning-control">
      <div className="ds-eyebrow" style={{ marginBottom: 6 }}>{t('playground.control.label')}</div>
      <select
        className="ds-select"
        value={selected}
        aria-label={t('playground.control.label')}
        onChange={(event) => onChange(event.target.value as '' | ReasoningEffort)}
        style={{ width: '100%' }}
      >
        <option value="">{t('playground.control.modelDefault')}</option>
        {control.efforts.map((effort) => (
          <option key={effort} value={effort}>{label(effort)}</option>
        ))}
      </select>
      <div className="ds-faint" style={{ fontSize: 11.5, marginTop: 4 }}>{t('playground.control.hint')}</div>
    </div>
  );
}

/** The short note under an answer that billed reasoning tokens but showed no reasoning text. */
export function PlaygroundReasoningHintNote({ hint }: { hint: PlaygroundReasoningHint | null }) {
  const t = useTranslations('modelReasoning');
  if (!hint) return null;
  return (
    <div className="ds-faint" style={{ fontSize: 12, fontStyle: 'italic', marginTop: 8 }} data-testid="playground-reasoning-hint">
      {t(`playground.hint.${hint}`)}
    </div>
  );
}
