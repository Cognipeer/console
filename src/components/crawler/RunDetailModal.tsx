'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Badge, Button, Code, Loader, Modal, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCopy,
  IconExternalLink,
  IconFile,
  IconFileText,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import StatusBadge from '@/components/common/ui/StatusBadge';
import type { CrawlJobView, CrawlResultView } from '@/lib/services/crawler';

interface RunDetailModalProps {
  job: CrawlJobView | null;
  results: CrawlResultView[];
  loading: boolean;
  canceling: boolean;
  onCancel: (jobId: string) => void;
  onClose: () => void;
}

const TYPE_META: Record<
  CrawlResultView['type'],
  { label: string; color: string; icon: typeof IconFileText }
> = {
  html: { label: 'Page', color: 'teal', icon: IconFileText },
  file: { label: 'File', color: 'grape', icon: IconFile },
  error: { label: 'Error', color: 'red', icon: IconAlertTriangle },
};

function ragColor(status?: string): string {
  if (status === 'indexed') return 'teal';
  if (status === 'failed') return 'red';
  if (status === 'pending') return 'blue';
  return 'gray';
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RunDetailModal({
  job,
  results,
  loading,
  canceling,
  onCancel,
  onClose,
}: RunDetailModalProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'html' | 'file' | 'error'>('all');
  const [ragFilter, setRagFilter] = useState<'all' | 'indexed' | 'pending' | 'skipped' | 'failed' | 'none'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset transient view state whenever a different job is opened.
  useEffect(() => {
    setQuery('');
    setTypeFilter('all');
    setRagFilter('all');
    setSelectedId(null);
  }, [job?.id]);

  const counts = useMemo(() => {
    let html = 0;
    let file = 0;
    let error = 0;
    for (const r of results) {
      if (r.type === 'html') html += 1;
      else if (r.type === 'file') file += 1;
      else if (r.type === 'error') error += 1;
    }
    return { html, file, error };
  }, [results]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return results.filter((r) => {
      if (typeFilter !== 'all' && r.type !== typeFilter) return false;
      if (ragFilter !== 'all') {
        if (ragFilter === 'none' ? Boolean(r.ragStatus) : r.ragStatus !== ragFilter) return false;
      }
      if (q) {
        const hay = `${r.url} ${r.title ?? ''} ${r.errorMessage ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [results, query, typeFilter, ragFilter]);

  // Keep a valid selection: default to the first filtered row, and drop a
  // selection that the current filter has hidden.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((r) => r.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selected = useMemo(
    () => filtered.find((r) => r.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  const active = job?.status === 'queued' || job?.status === 'running';

  const copyBody = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notifications.show({ color: 'teal', title: 'Copied', message: 'Markdown copied to clipboard' });
    } catch {
      notifications.show({ color: 'red', title: 'Copy failed', message: 'Clipboard is unavailable' });
    }
  };

  return (
    <Modal
      opened={job !== null}
      onClose={onClose}
      fullScreen
      radius={0}
      withCloseButton={false}
      padding={0}
      styles={{ body: { padding: 0, height: '100vh' } }}
    >
      {job && (
        <div className="ds-col" style={{ height: '100vh', minHeight: 0 }}>
          {/* Header */}
          <div
            className="ds-row-between"
            style={{
              padding: '12px 18px',
              borderBottom: '1px solid var(--ds-border-soft)',
              gap: 12,
            }}
          >
            <div className="ds-col" style={{ gap: 6, minWidth: 0 }}>
              <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap' }}>
                <span className="ds-h3">Run details</span>
                <span className="ds-faint ds-mono" style={{ fontSize: 12 }}>
                  {job.id}
                </span>
                <StatusBadge status={job.status} />
                <Badge size="xs" variant="light" color="gray">
                  {job.trigger}
                </Badge>
                {job.limitReached ? (
                  <Badge size="xs" variant="light" color="orange">
                    limit reached
                  </Badge>
                ) : null}
              </div>
              <div className="ds-faint" style={{ fontSize: 12.5 }}>
                {job.pagesProcessed} pages · {job.filesProcessed} files · {job.errorsCount} errors
                {job.durationMs ? ` · ${(job.durationMs / 1000).toFixed(1)}s` : ''}
                {job.startedAt ? ` · started ${new Date(job.startedAt).toLocaleString()}` : ''}
              </div>
            </div>
            <div className="ds-row ds-gap-sm">
              {active ? (
                <Button
                  color="red"
                  variant="light"
                  size="xs"
                  loading={canceling}
                  onClick={() => onCancel(job.id)}
                >
                  Cancel job
                </Button>
              ) : null}
              <Tooltip label="Close" withArrow>
                <ActionIcon variant="subtle" color="gray" radius="md" size="lg" onClick={onClose} aria-label="Close">
                  <IconX size={18} />
                </ActionIcon>
              </Tooltip>
            </div>
          </div>

          {job.errorMessage ? (
            <div style={{ padding: '10px 18px 0' }}>
              <Code block color="red">{job.errorMessage}</Code>
            </div>
          ) : null}

          {/* Body: master-detail */}
          <div className="ds-row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch' }}>
            {/* Left: results list */}
            <div
              className="ds-col"
              style={{
                width: 400,
                flexShrink: 0,
                borderRight: '1px solid var(--ds-border-soft)',
                minHeight: 0,
              }}
            >
              <div className="ds-col" style={{ gap: 8, padding: 12, borderBottom: '1px solid var(--ds-border-soft)' }}>
                <div className="ds-toolbar-search" style={{ width: '100%' }}>
                  <IconSearch size={14} stroke={1.7} color="var(--ds-text-muted)" />
                  <input
                    placeholder="Search URL, title, error…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="ds-row ds-gap-sm">
                  <select
                    className="ds-select"
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
                    style={{ flex: 1 }}
                    aria-label="Filter by type"
                  >
                    <option value="all">All types ({results.length})</option>
                    <option value="html">Pages ({counts.html})</option>
                    <option value="file">Files ({counts.file})</option>
                    <option value="error">Errors ({counts.error})</option>
                  </select>
                  <select
                    className="ds-select"
                    value={ragFilter}
                    onChange={(e) => setRagFilter(e.target.value as typeof ragFilter)}
                    style={{ flex: 1 }}
                    aria-label="Filter by RAG status"
                  >
                    <option value="all">All RAG</option>
                    <option value="indexed">Indexed</option>
                    <option value="pending">Pending</option>
                    <option value="skipped">Skipped</option>
                    <option value="failed">Failed</option>
                    <option value="none">No RAG</option>
                  </select>
                </div>
              </div>

              <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                {loading ? (
                  <div className="ds-col" style={{ alignItems: 'center', padding: 40 }}>
                    <Loader size="sm" color="teal" />
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="ds-faint" style={{ padding: 20, fontSize: 13 }}>
                    {results.length === 0 ? 'No results in this run yet.' : 'No results match your filters.'}
                  </div>
                ) : (
                  filtered.map((r) => {
                    const meta = TYPE_META[r.type];
                    const Icon = meta.icon;
                    const isSel = r.id === selectedId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setSelectedId(r.id)}
                        className="ds-col"
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          gap: 4,
                          padding: '10px 12px',
                          border: 'none',
                          borderBottom: '1px solid var(--ds-border-soft)',
                          borderLeft: isSel ? '2px solid var(--ds-accent, teal)' : '2px solid transparent',
                          background: isSel ? 'var(--ds-surface-2, rgba(0,0,0,0.04))' : 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        <div className="ds-row ds-gap-sm" style={{ minWidth: 0 }}>
                          <Icon size={14} color={`var(--mantine-color-${meta.color}-6)`} style={{ flexShrink: 0 }} />
                          <span
                            style={{
                              fontSize: 12.5,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: 'var(--ds-text)',
                            }}
                            title={r.url}
                          >
                            {r.title || r.url}
                          </span>
                        </div>
                        <div className="ds-faint ds-mono" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span>d{r.depth}</span>
                          {r.httpStatus ? <span>{r.httpStatus}</span> : null}
                          <span>{formatBytes(r.bytes)}</span>
                          {r.ragStatus ? (
                            <span style={{ color: `var(--mantine-color-${ragColor(r.ragStatus)}-6)` }}>
                              {r.ragStatus}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              <div
                className="ds-faint"
                style={{
                  padding: '8px 12px',
                  borderTop: '1px solid var(--ds-border-soft)',
                  fontSize: 12,
                }}
              >
                Showing {filtered.length} of {results.length}
              </div>
            </div>

            {/* Right: preview */}
            <div className="ds-col" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
              {selected ? (
                <>
                  <div
                    className="ds-col"
                    style={{ gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--ds-border-soft)' }}
                  >
                    <div className="ds-row-between" style={{ gap: 12 }}>
                      <a
                        href={selected.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ds-mono"
                        style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={selected.url}
                      >
                        {selected.url}
                      </a>
                      <div className="ds-row ds-gap-sm" style={{ flexShrink: 0 }}>
                        {selected.bodyMarkdown ? (
                          <Tooltip label="Copy markdown" withArrow>
                            <ActionIcon
                              variant="default"
                              radius="md"
                              onClick={() => void copyBody(selected.bodyMarkdown ?? '')}
                              aria-label="Copy markdown"
                            >
                              <IconCopy size={15} />
                            </ActionIcon>
                          </Tooltip>
                        ) : null}
                        <Tooltip label="Open URL" withArrow>
                          <ActionIcon
                            component="a"
                            href={selected.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="default"
                            radius="md"
                            aria-label="Open URL"
                          >
                            <IconExternalLink size={15} />
                          </ActionIcon>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="ds-row ds-gap-sm" style={{ flexWrap: 'wrap' }}>
                      <Badge size="xs" variant="light" color={TYPE_META[selected.type].color}>
                        {TYPE_META[selected.type].label}
                      </Badge>
                      {selected.httpStatus ? (
                        <Badge size="xs" variant="light" color={selected.httpStatus < 400 ? 'gray' : 'red'}>
                          HTTP {selected.httpStatus}
                        </Badge>
                      ) : null}
                      <Badge size="xs" variant="light" color="gray">
                        depth {selected.depth}
                      </Badge>
                      <Badge size="xs" variant="light" color="gray">
                        {formatBytes(selected.bytes)}
                      </Badge>
                      {selected.contentType ? (
                        <Badge size="xs" variant="light" color="gray">
                          {selected.contentType.split(';')[0]}
                        </Badge>
                      ) : null}
                      {selected.ragStatus ? (
                        <Badge size="xs" variant="light" color={ragColor(selected.ragStatus)}>
                          rag: {selected.ragStatus}
                        </Badge>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 18 }}>
                    {selected.errorMessage ? (
                      <Code block color="red" style={{ marginBottom: selected.bodyMarkdown ? 12 : 0 }}>
                        {selected.errorMessage}
                      </Code>
                    ) : null}
                    {selected.bodyMarkdown ? (
                      <pre
                        className="ds-mono"
                        style={{
                          margin: 0,
                          fontSize: 12.5,
                          lineHeight: 1.55,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: 'var(--ds-text)',
                        }}
                      >
                        {selected.bodyMarkdown}
                      </pre>
                    ) : selected.type === 'file' ? (
                      <div className="ds-faint" style={{ fontSize: 13 }}>
                        Binary file — no markdown body. Use “Open URL” to download it.
                      </div>
                    ) : !selected.errorMessage ? (
                      <div className="ds-faint" style={{ fontSize: 13 }}>
                        (no markdown body)
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="ds-faint" style={{ padding: 40, fontSize: 13 }}>
                  {loading ? 'Loading results…' : 'Select a result on the left to preview it.'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
