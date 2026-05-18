'use client';

import { ReactNode } from 'react';

export interface TabsBarItem {
  id: string;
  label: ReactNode;
  count?: number | string;
}

interface TabsBarProps {
  items: TabsBarItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export default function TabsBar({ items, activeId, onChange, className }: TabsBarProps) {
  return (
    <div className={`ds-tabs ${className ?? ''}`} role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={activeId === item.id}
          className={`ds-tab ${activeId === item.id ? 'active' : ''}`}
          onClick={() => onChange(item.id)}
        >
          <span>{item.label}</span>
          {item.count !== undefined ? <span className="ds-tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
