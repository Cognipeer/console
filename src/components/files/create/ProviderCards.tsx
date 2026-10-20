'use client';

import { useId, useState } from 'react';
import { Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { serviceGlyphFontSize } from '@/lib/services/serviceCatalog';
import type { FileProviderListItem } from '../filesApi';
import { driverInfo, isLocalDiskProvider, isProviderUsable } from '../list/providerModel';
import { ProviderHealthChip, providerHref } from '../shared';

export interface ProviderCardsProps {
  providers: readonly FileProviderListItem[];
  /** The key of the provider chosen; `''` = none. */
  value: string;
  onChange: (providerKey: string) => void;
  /** The person may open the Providers area: a provider with a problem links there (in a new tab). */
  canManageProviders: boolean;
  /** The reason the choice was refused, shown under the cards. */
  error?: string | null;
}

/** A card takes the keyboard focus ring only when the focus came from the keyboard. */
function focusCameFromKeyboard(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * The file providers of the project as radio cards. A bucket can only be created on a provider that is switched on:
 * those are selectable; the others are listed with the reason and a link to the provider (opened in a new tab, so
 * the form keeps what was typed). A provider whose last test failed, or that was never tested, can still be chosen:
 * its card says so, the decision stays with the person.
 */
export function ProviderCards({ providers, value, onChange, canManageProviders, error }: ProviderCardsProps) {
  const t = useTranslations('files.create');
  const groupName = useId();
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  return (
    <div>
      <div
        role="radiogroup"
        aria-label={t('provider.groupLabel')}
        aria-required="true"
        aria-invalid={error ? true : undefined}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))', gap: 10 }}
      >
        {providers.map((provider) => (
          <ProviderCard
            key={provider.key}
            provider={provider}
            groupName={groupName}
            selected={value === provider.key && isProviderUsable(provider)}
            focused={focusedKey === provider.key}
            canManageProviders={canManageProviders}
            onSelect={onChange}
            onFocusChange={(focused) => setFocusedKey(focused ? provider.key : null)}
          />
        ))}
      </div>
      {error ? (
        <Text size="xs" c="red" mt={6} role="alert">
          {error}
        </Text>
      ) : null}
    </div>
  );
}

interface ProviderCardProps {
  provider: FileProviderListItem;
  groupName: string;
  selected: boolean;
  focused: boolean;
  canManageProviders: boolean;
  onSelect: (providerKey: string) => void;
  onFocusChange: (focused: boolean) => void;
}

function ProviderCard({ provider, groupName, selected, focused, canManageProviders, onSelect, onFocusChange }: ProviderCardProps) {
  const t = useTranslations('files.create');
  const tCommon = useTranslations('files.common');
  const ids = useId();
  const nameId = `${ids}-name`;
  const detailsId = `${ids}-details`;

  const usable = isProviderUsable(provider);
  const driver = driverInfo(provider);
  const state = provider.providerHealth?.state;
  const hasProblem = !usable || state === 'failed' || state === 'inactive' || state === 'untested';
  const href = canManageProviders && hasProblem ? providerHref(provider) : null;
  // A provider that is off for a reason the health does not name (its status says it is not active).
  const unnamedReason = !usable && state !== 'inactive';

  return (
    <label
      className={`form-source-card${selected ? ' selected' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        minWidth: 0,
        cursor: usable ? 'pointer' : 'default',
        background: usable ? undefined : 'var(--ds-surface-1)',
        boxShadow: focused ? '0 0 0 2px var(--ds-accent)' : undefined,
      }}
    >
      <input
        type="radio"
        name={groupName}
        value={provider.key}
        checked={selected}
        disabled={!usable}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        onChange={() => onSelect(provider.key)}
        onFocus={(event) => onFocusChange(focusCameFromKeyboard(event.currentTarget))}
        onBlur={() => onFocusChange(false)}
        style={{ marginTop: 8, flexShrink: 0, accentColor: 'var(--ds-accent)' }}
      />
      <span
        className="service-card-glyph"
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          background: driver.color,
          color: '#fff',
          fontSize: serviceGlyphFontSize(driver.glyph, 12.5),
        }}
      >
        {driver.glyph}
      </span>
      <div className="ds-col" style={{ gap: 4, minWidth: 0, flex: 1 }}>
        <span id={nameId} className="form-source-name" style={{ overflowWrap: 'anywhere' }}>
          {provider.label}
        </span>
        <div id={detailsId} className="ds-col" style={{ gap: 4 }}>
          <span className="form-source-desc">{driver.name}</span>
          <ProviderHealthChip health={provider.providerHealth} showReason />
          {isLocalDiskProvider(provider) ? <span className="form-source-desc">{t('provider.localDisk')}</span> : null}
          {unnamedReason ? <span className="form-source-desc">{t('provider.notActive')}</span> : null}
        </div>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: 'var(--ds-link-text)', width: 'fit-content' }}
          >
            {tCommon('health.openProvider')}
          </a>
        ) : null}
      </div>
    </label>
  );
}
