'use client';

import { ChangeEvent, ReactNode } from 'react';
import { IconSearch } from '@tabler/icons-react';

interface ToolbarProps {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  children?: ReactNode;
  className?: string;
}

export default function Toolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Filter…',
  children,
  className,
}: ToolbarProps) {
  return (
    <div className={`ds-toolbar ${className ?? ''}`}>
      {onSearchChange ? (
        <div className="ds-toolbar-search">
          <IconSearch size={14} stroke={1.7} color="var(--ds-text-muted)" />
          <input
            placeholder={searchPlaceholder}
            value={searchValue ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
          />
        </div>
      ) : null}
      {children}
    </div>
  );
}
