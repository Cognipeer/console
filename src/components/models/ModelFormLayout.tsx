'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConfirm } from '@/components/common/confirm/ConfirmProvider';
import FormShell, { type FormShellAction } from '@/components/common/ui/FormShell';

/**
 * The one layout every model create / edit screen shares: the full-screen
 * `FormShell` overlay, a sticky section nav on top of the form, a dirty-state
 * indicator next to the save button and a guard against losing edits (closing
 * the overlay or leaving the tab).
 *
 * Panels stay MOUNTED while another section is shown (`hidden`, not
 * unmounted) so a field in a hidden section keeps its value and validation.
 */
export interface ModelFormSection {
  id: string;
  label: string;
  /** Section is complete (tick) / incomplete (dot). Omit for no marker. */
  done?: boolean;
  /** Hide the tab entirely (e.g. Analytics while creating). */
  hidden?: boolean;
}

const ActiveSectionContext = createContext<string>('');

interface ModelFormLayoutProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  summary?: ReactNode;
  sections: ModelFormSection[];
  primaryAction: FormShellAction;
  footerStatus?: ReactNode;
  /** Unsaved edits exist: shows the indicator and asks before discarding them. */
  dirty?: boolean;
  /** Changes whenever the form is (re)hydrated, to return to the first section. */
  resetKey?: string | number;
  children: ReactNode;
}

export default function ModelFormLayout({
  open,
  onClose,
  title,
  subtitle,
  icon,
  summary,
  sections,
  primaryAction,
  footerStatus,
  dirty = false,
  resetKey,
  children,
}: ModelFormLayoutProps) {
  const visible = useMemo(() => sections.filter((s) => !s.hidden), [sections]);
  const [active, setActive] = useState(visible[0]?.id ?? '');

  useEffect(() => {
    setActive(visible[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on (re)hydration
  }, [resetKey]);

  // The active section can disappear (a strategy switch hides Rules or Decider).
  const activeId = visible.some((s) => s.id === active) ? active : (visible[0]?.id ?? '');

  useEffect(() => {
    if (!open || !dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [open, dirty]);

  const { confirm } = useConfirm();
  const guardedClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    void confirm({
      title: 'Discard unsaved changes?',
      message: 'Your edits to this model have not been saved.',
      confirmLabel: 'Discard',
      tone: 'danger',
    }).then((ok) => {
      if (ok) onClose();
    });
  }, [dirty, onClose, confirm]);

  return (
    <FormShell
      open={open}
      onClose={guardedClose}
      icon={icon}
      title={title}
      subtitle={subtitle}
      summary={summary}
      footerStatus={footerStatus}
      footerLeft={
        dirty ? (
          <span className="ds-muted" style={{ fontSize: 12 }} data-testid="model-form-dirty">
            ● Unsaved changes
          </span>
        ) : null
      }
      primaryAction={primaryAction}
    >
      <nav
        aria-label="Sections"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 3,
          margin: '-32px 0 20px',
          padding: '12px 0 0',
          background: 'var(--ds-surface-1, var(--mantine-color-body))',
          borderBottom: '1px solid var(--ds-border-soft)',
          display: 'flex',
          gap: 4,
          overflowX: 'auto',
        }}
      >
        {visible.map((section) => {
          const selected = section.id === activeId;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(section.id)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                padding: '8px 12px',
                fontSize: 13,
                fontWeight: selected ? 600 : 500,
                color: selected ? 'var(--ds-text, inherit)' : 'var(--ds-text-muted, #868e96)',
                borderBottom: `2px solid ${selected ? 'var(--mantine-color-teal-6, teal)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {section.label}
              {section.done === false ? (
                <span aria-label="incomplete" style={{ color: 'var(--mantine-color-orange-6, orange)' }}> •</span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <ActiveSectionContext.Provider value={activeId}>{children}</ActiveSectionContext.Provider>
    </FormShell>
  );
}

/** Content of one section; hidden (not unmounted) while another section is active. */
export function ModelFormPanel({ id, lazy = false, children }: { id: string; lazy?: boolean; children: ReactNode }) {
  const active = useContext(ActiveSectionContext);
  // `lazy`: mount only while shown (panels that fetch on mount, e.g. analytics).
  if (lazy && active !== id) return null;
  return (
    <div role="tabpanel" hidden={active !== id} className="ds-col ds-gap-md" style={{ display: active === id ? undefined : 'none' }}>
      {children}
    </div>
  );
}
