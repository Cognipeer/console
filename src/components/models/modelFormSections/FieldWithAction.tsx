import type { ReactNode } from 'react';

/**
 * A form field (FormShell's `.form-field` markup) with a button at the end of its label row, such as "Back to
 * catalog" or "Fill from catalog".
 *
 * FormField's `action` is rendered inside its `<label>`, and a label without `htmlFor` takes the first button inside
 * it as its control: a click anywhere on the label row pressed the button, and screen readers announced the button
 * by the label's text. Here the button sits next to the label, and the label points at the field's own input
 * (`htmlFor`, the id the caller gives that input), so clicking the label focuses the input as on any other field.
 */
export default function FieldWithAction({
  label,
  required,
  htmlFor,
  action,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  /** The id of the input below, so a click on the label goes to the input and not to the action. */
  htmlFor: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="form-field">
      <div className="form-field-label">
        {/* The global `label` colour rule would beat the colour inherited from `.form-field-label`. */}
        <label htmlFor={htmlFor} style={{ color: 'inherit' }}>
          {label}
          {required ? <span style={{ color: 'var(--ds-err)' }}> *</span> : null}
        </label>
        {action}
      </div>
      {children}
    </div>
  );
}
