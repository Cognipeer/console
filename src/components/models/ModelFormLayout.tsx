'use client';

import { useCallback, useEffect, type ReactNode } from 'react';
import { useConfirm } from '@/components/common/confirm/ConfirmProvider';
import FormShell, { type FormShellAction } from '@/components/common/ui/FormShell';

/**
 * The one layout every model create / edit screen shares: the full-screen
 * `FormShell` overlay with its numbered sections stacked in one scrolling
 * column (as on every other create / edit screen), a dirty-state indicator next
 * to the save button and a guard against losing edits (closing the overlay or
 * leaving the tab).
 */
interface ModelFormLayoutProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  summary?: ReactNode;
  primaryAction: FormShellAction;
  footerStatus?: ReactNode;
  /** Unsaved edits exist: shows the indicator and asks before discarding them. */
  dirty?: boolean;
  children: ReactNode;
}

export default function ModelFormLayout({
  open,
  onClose,
  title,
  subtitle,
  icon,
  summary,
  primaryAction,
  footerStatus,
  dirty = false,
  children,
}: ModelFormLayoutProps) {
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
      {children}
    </FormShell>
  );
}
