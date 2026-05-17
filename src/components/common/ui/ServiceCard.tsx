'use client';

import { type ReactNode } from 'react';
import type { ServiceCatalogEntry } from '@/lib/services/serviceCatalog';
import { DOMAIN_LABELS, serviceGlyph } from '@/lib/services/serviceCatalog';

export interface ServiceCardProps {
  service: ServiceCatalogEntry;
  selected?: boolean;
  onClick?: (service: ServiceCatalogEntry) => void;
  /** Optional trailing slot (e.g. status pill, count badge). */
  trailing?: ReactNode;
  /** Compact variant — smaller padding/typography for grids of many items. */
  compact?: boolean;
}

export default function ServiceCard({
  service,
  selected,
  onClick,
  trailing,
  compact,
}: ServiceCardProps) {
  const clickable = Boolean(onClick);
  const interactiveProps = clickable
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onClick?.(service),
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.(service);
          }
        },
      }
    : {};
  return (
    <div
      className={[
        'service-card',
        selected ? 'selected' : '',
        compact ? 'compact' : '',
        clickable ? 'clickable' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...interactiveProps}
    >
      <div
        className="service-card-glyph"
        style={{
          background: service.color,
          color: '#fff',
        }}
      >
        {serviceGlyph(service)}
      </div>
      <div className="service-card-body">
        <div className="service-card-head">
          <span className="service-card-name">{service.name}</span>
          {trailing}
        </div>
        <div className="service-card-tagline">{service.tagline}</div>
        <div className="service-card-meta">
          {service.domains.map((d) => (
            <span key={d} className="ds-badge ds-badge-info">
              {DOMAIN_LABELS[d] ?? d}
            </span>
          ))}
          {service.tags.includes('popular') ? (
            <span className="ds-badge ds-badge-warn">★ popular</span>
          ) : null}
          {service.tags.includes('managed') ? (
            <span className="ds-badge ds-badge-teal">managed</span>
          ) : null}
          {service.tags.includes('self-hosted') ? (
            <span className="ds-badge">self-hosted</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
