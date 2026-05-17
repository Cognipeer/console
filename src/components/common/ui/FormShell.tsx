'use client';

import {
  ReactNode,
  useEffect,
  useState,
  Children,
  isValidElement,
} from 'react';
import { Button, ActionIcon } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';

/* ──────────────────────────────────────────────────────────────────
   FormShell — full-screen overlay form layout.
   Mirrors the new_design/page-model-form pattern but generic.
   Two-pane: form (left) + summary (right, optional).
   ────────────────────────────────────────────────────────────────── */

export interface FormShellAction {
  label: ReactNode;
  icon?: ReactNode;
  color?: 'teal' | 'red' | 'orange' | 'blue' | 'gray';
  variant?: 'filled' | 'default' | 'subtle' | 'outline';
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

export interface FormShellProps {
  /** Render the overlay. */
  open: boolean;
  /** Close handler (called on backdrop/escape/header X). */
  onClose: () => void;
  /** Page-style title in the header. */
  title: ReactNode;
  /** Optional subtitle line under title. */
  subtitle?: ReactNode;
  /** Optional icon shown next to title in the header. */
  icon?: ReactNode;
  /** Main form content (use Section/Field/etc). */
  children: ReactNode;
  /** Right-pane summary content. Renders without aside when omitted. */
  summary?: ReactNode;
  /** Primary footer action (e.g. Save). */
  primaryAction?: FormShellAction;
  /** Secondary footer action (defaults to Cancel). */
  secondaryAction?: FormShellAction;
  /** Extra footer items, rendered before the actions. */
  footerLeft?: ReactNode;
  /** Status indicator (e.g. "3 of 5 ready"). */
  footerStatus?: ReactNode;
  /** Disable Esc-to-close behavior. */
  disableEscape?: boolean;
}

export default function FormShell({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  summary,
  primaryAction,
  secondaryAction,
  footerLeft,
  footerStatus,
  disableEscape = false,
}: FormShellProps) {
  useEffect(() => {
    if (!open || disableEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, disableEscape]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="form-overlay" role="dialog" aria-modal="true">
      <div className="form-header">
        <ActionIcon
          variant="subtle"
          color="gray"
          radius="md"
          onClick={onClose}
          aria-label="Close"
        >
          <IconX size={16} />
        </ActionIcon>
        <div className="form-header-main">
          {icon ? <div className="form-header-icon">{icon}</div> : null}
          <div className="form-header-text">
            <div className="form-header-title">{title}</div>
            {subtitle ? <div className="form-header-sub">{subtitle}</div> : null}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div className="form-header-hint">
          Press <span className="form-kbd">ESC</span> to cancel
        </div>
      </div>

      <div
        className="form-body"
        style={{
          gridTemplateColumns: summary ? '1fr 380px' : '1fr',
        }}
      >
        <div className="form-form" data-no-summary={summary ? undefined : 'true'}>
          {children}
        </div>
        {summary ? <aside className="form-summary">{summary}</aside> : null}
      </div>

      <div className="form-footer">
        {footerLeft}
        <div style={{ flex: 1 }} />
        {footerStatus ? (
          <span className="ds-muted" style={{ fontSize: 12 }}>
            {footerStatus}
          </span>
        ) : null}
        <Button
          variant={secondaryAction?.variant ?? 'default'}
          size="sm"
          leftSection={secondaryAction?.icon}
          color={secondaryAction?.color}
          loading={secondaryAction?.loading}
          disabled={secondaryAction?.disabled}
          onClick={secondaryAction?.onClick ?? onClose}
        >
          {secondaryAction?.label ?? 'Cancel'}
        </Button>
        {primaryAction ? (
          <Button
            variant={primaryAction.variant ?? 'filled'}
            size="sm"
            color={primaryAction.color ?? 'teal'}
            leftSection={primaryAction.icon}
            loading={primaryAction.loading}
            disabled={primaryAction.disabled}
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────── */

export function FormSection({
  number,
  title,
  description,
  done,
  children,
}: {
  number?: number | string;
  title: ReactNode;
  description?: ReactNode;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="form-section">
      <header className="form-section-header">
        {number != null ? (
          <div className={`form-section-num ${done ? 'done' : ''}`}>
            {done ? <IconCheck size={11} stroke={3} /> : number}
          </div>
        ) : null}
        <div className="form-section-title">{title}</div>
      </header>
      {description ? (
        <div className="form-section-desc">{description}</div>
      ) : null}
      <div className="form-section-body">{children}</div>
    </section>
  );
}

export function FormRow({
  children,
  cols = 2,
}: {
  children: ReactNode;
  cols?: 1 | 2 | 3;
}) {
  const validChildren = Children.toArray(children).filter(isValidElement);
  const colStyle: Record<number, string> = {
    1: '1fr',
    2: '1fr 1fr',
    3: '1fr 1fr 1fr',
  };
  return (
    <div
      className="form-row"
      style={{ gridTemplateColumns: colStyle[cols] ?? '1fr 1fr' }}
    >
      {validChildren}
    </div>
  );
}

export function FormField({
  label,
  hint,
  required,
  optional,
  action,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  optional?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        <span>
          {label}
          {required ? <span style={{ color: 'var(--ds-err)' }}> *</span> : null}
          {optional ? (
            <span className="ds-faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              {' · optional'}
            </span>
          ) : null}
        </span>
        {action}
      </label>
      {children}
      {hint ? <div className="form-field-hint">{hint}</div> : null}
    </div>
  );
}

export function ChipPicker<T extends string>({
  options,
  value,
  onChange,
  multiple = false,
}: {
  options: Array<{ value: T; label: ReactNode; icon?: ReactNode }>;
  value: T | Set<T>;
  onChange: (next: T | Set<T>) => void;
  multiple?: boolean;
}) {
  const isSet = value instanceof Set;
  const toggle = (v: T) => {
    if (multiple && isSet) {
      const next = new Set(value as Set<T>);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      onChange(next);
    } else {
      onChange(v);
    }
  };
  const isSelected = (v: T) =>
    isSet ? (value as Set<T>).has(v) : value === v;
  return (
    <div className="form-chips">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`form-chip ${isSelected(opt.value) ? 'selected' : ''}`}
          onClick={() => toggle(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className="form-toggle-row"
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}
    >
      <input
        type="checkbox"
        className="ds-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="form-toggle-tx">
        <div className="form-toggle-name">{label}</div>
        {description ? (
          <div className="form-toggle-desc">{description}</div>
        ) : null}
      </div>
    </label>
  );
}

export function ToggleList({ children }: { children: ReactNode }) {
  return <div className="form-toggle-list">{children}</div>;
}

export function SliderField({
  value,
  onChange,
  min,
  max,
  step = 1,
  formatValue,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  formatValue?: (v: number) => string;
}) {
  return (
    <div className="form-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="form-slider-val">
        {formatValue ? formatValue(value) : value}
      </div>
    </div>
  );
}

export function SummaryGroup({
  title,
  children,
}: {
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="form-summary-group">
      {title ? <h3 className="form-summary-title">{title}</h3> : null}
      <div className="form-summary-block">{children}</div>
    </div>
  );
}

export function SummaryKV({
  label,
  value,
  mono = false,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="form-kv">
      <span className="form-kv-k">{label}</span>
      <span className={`form-kv-v ${mono ? 'ds-mono' : ''}`}>{value}</span>
    </div>
  );
}

export function Checklist({
  items,
}: {
  items: Array<{ id: string | number; label: ReactNode; done: boolean }>;
}) {
  return (
    <ul className="form-checklist">
      {items.map((item) => (
        <li key={item.id} className={item.done ? 'done' : 'todo'}>
          <span className="form-checklist-dot">
            {item.done ? <IconCheck size={9} stroke={3} /> : null}
          </span>
          <span style={{ color: item.done ? 'var(--ds-text)' : 'var(--ds-text-muted)' }}>
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SourceCard({
  selected,
  onClick,
  icon,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`form-source-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className="form-source-head">
        {icon}
        <span className="form-source-name">{title}</span>
      </div>
      <div className="form-source-desc">{description}</div>
    </button>
  );
}

export function SourceToggle({ children }: { children: ReactNode }) {
  return <div className="form-source-toggle">{children}</div>;
}

/* Hook used by callers that need uncontrolled "edited" tracking for
   slugified IDs (display name → auto slug). */
export function useAutoSlug(seed: string) {
  const [value, setValue] = useState('');
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) {
      setValue(
        (seed || '')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40),
      );
    }
  }, [seed, edited]);
  return {
    value,
    setValue: (v: string) => {
      setValue(v);
      setEdited(true);
    },
    reset: () => setEdited(false),
    edited,
  };
}
