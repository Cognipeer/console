'use client';

import { useEffect, useState } from 'react';
import { MultiSelect } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';

interface McpServerOption {
  value: string;
  label: string;
}

export interface McpServerFieldProps {
  /** Selected MCP server ids. Empty = every MCP server. */
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/**
 * The MCP server restriction of a token: a multi-select over the project's MCP servers (agent-owned servers are
 * not listed). Leaving it empty means the token may reach every MCP server.
 */
export default function McpServerField({ value, onChange, disabled }: McpServerFieldProps) {
  const t = useTranslations('iamTokens');
  const [options, setOptions] = useState<McpServerOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/mcp');
        if (!response.ok) return;
        const data = (await response.json()) as { servers?: Array<{ id?: string; name?: string; owner?: unknown }> };
        if (cancelled || !Array.isArray(data.servers)) return;
        setOptions(
          data.servers
            .filter((server) => !server.owner && typeof server.id === 'string' && server.id !== '')
            .map((server) => ({ value: server.id as string, label: server.name || (server.id as string) })),
        );
      } catch {
        // The list is a convenience; the saved restriction is unaffected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A saved id whose server is no longer listed stays visible (and removable) instead of vanishing silently.
  const known = new Set(options.map((option) => option.value));
  const data = [...options, ...value.filter((id) => !known.has(id)).map((id) => ({ value: id, label: id }))];

  return (
    <MultiSelect
      data={data}
      value={value}
      onChange={onChange}
      placeholder={value.length === 0 ? t('mcpServers.placeholder') : undefined}
      searchable
      clearable
      disabled={disabled}
      nothingFoundMessage={t('mcpServers.none')}
      aria-label={t('mcpServers.title')}
    />
  );
}
