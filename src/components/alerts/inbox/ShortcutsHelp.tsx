'use client';

import { Modal } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import type { ShortcutAction } from './inboxModel';

const ROWS: Array<{ keys: string[]; action: ShortcutAction }> = [
  { keys: ['j', '↓'], action: 'next' },
  { keys: ['k', '↑'], action: 'prev' },
  { keys: ['x'], action: 'select' },
  { keys: ['a'], action: 'acknowledge' },
  { keys: ['r'], action: 'resolve' },
  { keys: ['s'], action: 'snooze' },
  { keys: ['e'], action: 'assignMe' },
  { keys: ['/'], action: 'search' },
  { keys: ['Enter'], action: 'open' },
  { keys: ['Esc'], action: 'escape' },
  { keys: ['?'], action: 'help' },
];

/** The keyboard shortcuts of the inbox. */
export default function ShortcutsHelp({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const t = useTranslations('incidents');
  return (
    <Modal opened={opened} onClose={onClose} title={t('ux.shortcuts.title')} centered size="sm">
      <p className="ds-muted" style={{ marginTop: 0, fontSize: 12.5 }}>
        {t('ux.shortcuts.note')}
      </p>
      <table className="ds-tbl">
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.action}>
              <td style={{ whiteSpace: 'nowrap', width: 110 }}>
                {row.keys.map((key, index) => (
                  <span key={key}>
                    {index > 0 ? ' / ' : ''}
                    <kbd className="ds-mono" style={{ border: '1px solid var(--ds-border)', borderRadius: 4, padding: '1px 6px', fontSize: 12 }}>
                      {key}
                    </kbd>
                  </span>
                ))}
              </td>
              <td>{t(`ux.shortcuts.actions.${row.action}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
