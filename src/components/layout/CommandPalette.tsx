'use client';

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  IconArrowRight,
  IconBrain,
  IconBulb,
  IconCommand,
  IconCornerDownLeft,
  IconFolder,
  IconPlug,
  IconRobot,
  IconSearch,
  IconShield,
  IconSparkles,
  IconTool,
  IconVectorBezier,
  IconWorld,
  IconX,
  type Icon as TablerIcon,
} from '@tabler/icons-react';
import {
  ALL_DASHBOARD_SERVICES,
  type DashboardServiceDefinition,
} from '@/lib/utils/dashboardServices';
import { useTranslations } from '@/lib/i18n';

/* ──────────────────────────────────────────────────────────────────────
   Public API: <CommandPalette /> mounted globally + openCommandPalette()
   ────────────────────────────────────────────────────────────────────── */

type GroupId =
  | 'services'
  | 'models'
  | 'providers'
  | 'prompts'
  | 'agents'
  | 'tools'
  | 'mcp'
  | 'vector'
  | 'memory'
  | 'files'
  | 'rag'
  | 'browser'
  | 'guardrails'
  | 'pii';

interface ResultItem {
  id: string;
  group: GroupId;
  label: string;
  sublabel?: string;
  href: string;
  icon: ReactNode;
  /** Lower-cased haystack for client-side filtering. */
  haystack: string;
}

const GROUP_META: Record<
  GroupId,
  { label: string; icon: TablerIcon; order: number }
> = {
  services: { label: 'Services', icon: IconCommand, order: 0 },
  models: { label: 'Models', icon: IconBrain, order: 1 },
  providers: { label: 'Providers', icon: IconPlug, order: 2 },
  agents: { label: 'Agents', icon: IconRobot, order: 3 },
  prompts: { label: 'Prompts', icon: IconSparkles, order: 4 },
  tools: { label: 'Tools', icon: IconTool, order: 5 },
  mcp: { label: 'MCP servers', icon: IconPlug, order: 6 },
  rag: { label: 'RAG modules', icon: IconFolder, order: 7 },
  vector: { label: 'Vector indexes', icon: IconVectorBezier, order: 8 },
  memory: { label: 'Memory stores', icon: IconBulb, order: 9 },
  files: { label: 'File buckets', icon: IconFolder, order: 10 },
  browser: { label: 'Browsers', icon: IconWorld, order: 11 },
  guardrails: { label: 'Guardrails', icon: IconShield, order: 12 },
  pii: { label: 'PII policies', icon: IconShield, order: 13 },
};

/* ──────────────────────────────────────────────────────────────────────
   Global open/close — event-based so any component can trigger.
   ────────────────────────────────────────────────────────────────────── */

const OPEN_EVENT = 'command-palette:open';

export function openCommandPalette() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/* ──────────────────────────────────────────────────────────────────────
   API fetchers — each returns lightweight items for the palette.
   They run only when the query is non-empty (debounced).
   ────────────────────────────────────────────────────────────────────── */

interface FetchSource<T> {
  group: GroupId;
  url: string;
  /** Extract array from JSON response (e.g. data.models, data.policies). */
  pick: (data: any) => T[];
  toItem: (row: T) => ResultItem | null;
}

const FETCH_SOURCES: FetchSource<any>[] = [
  {
    group: 'models',
    url: '/api/models',
    pick: (d) => d?.models ?? [],
    toItem: (m) => ({
      id: `model:${m._id}`,
      group: 'models',
      label: m.name || m.key,
      sublabel: `${m.modelId ?? m.key} · ${m.category ?? 'llm'}`,
      href: `/dashboard/models/${m._id}`,
      icon: <IconBrain size={15} stroke={1.7} />,
      haystack: `${m.name} ${m.key} ${m.modelId} ${m.providerKey ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'providers',
    url: '/api/providers?scope=tenant',
    pick: (d) => d?.providers ?? [],
    toItem: (p) => ({
      id: `provider:${p._id}`,
      group: 'providers',
      label: p.label || p.key,
      sublabel: `${p.type} · ${p.driver}`,
      href: `/dashboard/providers/${p._id}`,
      icon: <IconPlug size={15} stroke={1.7} />,
      haystack: `${p.label} ${p.key} ${p.type} ${p.driver}`.toLowerCase(),
    }),
  },
  {
    group: 'agents',
    url: '/api/agents',
    pick: (d) => d?.agents ?? [],
    toItem: (a) => ({
      id: `agent:${a._id}`,
      group: 'agents',
      label: a.name || a.key,
      sublabel: a.config?.modelKey ? `model: ${a.config.modelKey}` : undefined,
      href: `/dashboard/agents/${a._id}`,
      icon: <IconRobot size={15} stroke={1.7} />,
      haystack: `${a.name} ${a.key} ${a.config?.modelKey ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'prompts',
    url: '/api/prompts',
    pick: (d) => d?.prompts ?? [],
    toItem: (p) => ({
      id: `prompt:${p._id}`,
      group: 'prompts',
      label: p.name || p.key,
      sublabel: p.description || p.key,
      href: `/dashboard/prompts/${p._id}`,
      icon: <IconSparkles size={15} stroke={1.7} />,
      haystack: `${p.name} ${p.key} ${p.description ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'tools',
    url: '/api/tools',
    pick: (d) => d?.tools ?? [],
    toItem: (t) => ({
      id: `tool:${t.id}`,
      group: 'tools',
      label: t.name || t.key,
      sublabel: t.type ?? undefined,
      href: `/dashboard/agents/tools/${t.id}`,
      icon: <IconTool size={15} stroke={1.7} />,
      haystack: `${t.name} ${t.key} ${t.type ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'mcp',
    url: '/api/mcp',
    pick: (d) => d?.servers ?? d?.mcp ?? [],
    toItem: (s) => ({
      id: `mcp:${s._id ?? s.id}`,
      group: 'mcp',
      label: s.name || s.key,
      sublabel: s.url ?? s.baseUrl,
      href: `/dashboard/mcp/${s._id ?? s.id}`,
      icon: <IconPlug size={15} stroke={1.7} />,
      haystack: `${s.name} ${s.key} ${s.url ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'memory',
    url: '/api/memory/stores',
    pick: (d) => d?.stores ?? [],
    toItem: (s) => ({
      id: `memory:${s.key}`,
      group: 'memory',
      label: s.name || s.key,
      sublabel: s.vectorProviderKey
        ? `vector: ${s.vectorProviderKey}`
        : undefined,
      href: `/dashboard/memory/${encodeURIComponent(s.key)}`,
      icon: <IconBulb size={15} stroke={1.7} />,
      haystack: `${s.name} ${s.key} ${s.vectorProviderKey ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'rag',
    url: '/api/rag/modules',
    pick: (d) => d?.modules ?? [],
    toItem: (m) => ({
      id: `rag:${m.key}`,
      group: 'rag',
      label: m.name || m.key,
      sublabel: m.embeddingModelKey
        ? `embedding: ${m.embeddingModelKey}`
        : undefined,
      href: `/dashboard/rag/${encodeURIComponent(m.key)}`,
      icon: <IconFolder size={15} stroke={1.7} />,
      haystack: `${m.name} ${m.key} ${m.embeddingModelKey ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'files',
    url: '/api/files/buckets',
    pick: (d) => d?.buckets ?? [],
    toItem: (b) => ({
      id: `bucket:${b.key}`,
      group: 'files',
      label: b.name || b.key,
      sublabel: b.providerKey ? `provider: ${b.providerKey}` : undefined,
      href: `/dashboard/files/${encodeURIComponent(b.key)}`,
      icon: <IconFolder size={15} stroke={1.7} />,
      haystack: `${b.name} ${b.key} ${b.providerKey ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'browser',
    url: '/api/browser',
    pick: (d) => d?.browsers ?? [],
    toItem: (b) => ({
      id: `browser:${b._id ?? b.key}`,
      group: 'browser',
      label: b.name || b.key,
      sublabel: b.modelKey ? `model: ${b.modelKey}` : undefined,
      href: `/dashboard/browser/${b._id ?? b.key}`,
      icon: <IconWorld size={15} stroke={1.7} />,
      haystack: `${b.name} ${b.key} ${b.modelKey ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'guardrails',
    url: '/api/guardrails',
    pick: (d) => d?.guardrails ?? [],
    toItem: (g) => ({
      id: `guardrail:${g._id}`,
      group: 'guardrails',
      label: g.name || g.key,
      sublabel: g.type ?? g.action,
      href: `/dashboard/guardrails/${g._id}`,
      icon: <IconShield size={15} stroke={1.7} />,
      haystack: `${g.name} ${g.key} ${g.type ?? ''} ${g.action ?? ''}`.toLowerCase(),
    }),
  },
  {
    group: 'pii',
    url: '/api/pii/policies',
    pick: (d) => d?.policies ?? [],
    toItem: (p) => ({
      id: `pii:${p.id ?? p._id}`,
      group: 'pii',
      label: p.name || p.key,
      sublabel: p.defaultAction ? `action: ${p.defaultAction}` : undefined,
      href: `/dashboard/pii/${p.id ?? p._id}`,
      icon: <IconShield size={15} stroke={1.7} />,
      haystack: `${p.name} ${p.key} ${p.defaultAction ?? ''}`.toLowerCase(),
    }),
  },
];

/* ──────────────────────────────────────────────────────────────────────
   Recent items — persisted in localStorage.
   ────────────────────────────────────────────────────────────────────── */

const RECENTS_KEY = 'cognipeer:cmd-palette:recents';
const MAX_RECENTS = 6;

function loadRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  if (typeof window === 'undefined') return;
  try {
    const existing = loadRecents().filter((x) => x !== id);
    const next = [id, ...existing].slice(0, MAX_RECENTS);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Main component
   ────────────────────────────────────────────────────────────────────── */

interface CommandPaletteProps {
  isTenantAdmin?: boolean;
}

export default function CommandPalette({ isTenantAdmin = false }: CommandPaletteProps) {
  const router = useRouter();
  const tNav = useTranslations('navigation');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<GroupId | 'all'>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [dynamicItems, setDynamicItems] = useState<ResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);

  /* ── Open / Close handlers ───────────────────────────────────────── */

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === '/' && !open) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        const editable = target?.isContentEditable;
        if (tag !== 'input' && tag !== 'textarea' && !editable) {
          e.preventDefault();
          setOpen(true);
        }
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveGroup('all');
      setActiveIndex(0);
      setRecentIds(loadRecents());
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  /* ── Static service items ────────────────────────────────────────── */

  const services = useMemo<ResultItem[]>(() => {
    return ALL_DASHBOARD_SERVICES.filter(
      (s: DashboardServiceDefinition) =>
        !s.tenantAdminOnly || isTenantAdmin,
    ).map((s: DashboardServiceDefinition) => {
      const ServiceIcon = s.icon;
      const label = tNav(s.navLabelKey);
      const description = tNav(s.navDescriptionKey);
      return {
        id: `service:${s.id}`,
        group: 'services' as GroupId,
        label,
        sublabel: description,
        href: s.href,
        icon: <ServiceIcon size={15} stroke={1.7} />,
        haystack: [
          label,
          description,
          ...(s.searchKeywords ?? []),
          ...(s.tags ?? []),
        ]
          .join(' ')
          .toLowerCase(),
      };
    });
  }, [isTenantAdmin, tNav]);

  /* ── Dynamic API fetch (debounced) ───────────────────────────────── */

  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!open) {
      setDynamicItems([]);
      return;
    }
    if (!trimmedQuery) {
      setDynamicItems([]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      const out: ResultItem[] = [];
      await Promise.all(
        FETCH_SOURCES.map(async (src) => {
          try {
            const res = await fetch(src.url, {
              cache: 'no-store',
              signal: controller.signal,
            });
            if (!res.ok) return;
            const data = await res.json();
            const rows = src.pick(data);
            for (const row of rows) {
              const item = src.toItem(row);
              if (!item) continue;
              if (item.haystack.includes(trimmedQuery.toLowerCase())) {
                out.push(item);
              }
            }
          } catch {
            // ignore aborted / failed fetch — the source just doesn't contribute
          }
        }),
      );
      if (!controller.signal.aborted) {
        setDynamicItems(out);
        setLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
      setLoading(false);
    };
  }, [open, trimmedQuery]);

  /* ── Filter + group results ──────────────────────────────────────── */

  const filteredServices = useMemo(() => {
    if (!trimmedQuery) return services;
    const q = trimmedQuery.toLowerCase();
    return services.filter((s) => s.haystack.includes(q));
  }, [services, trimmedQuery]);

  const allItems = useMemo(() => {
    if (!trimmedQuery) return services;
    return [...filteredServices, ...dynamicItems];
  }, [filteredServices, dynamicItems, services, trimmedQuery]);

  const scopedItems = useMemo(() => {
    if (activeGroup === 'all') return allItems;
    return allItems.filter((it) => it.group === activeGroup);
  }, [allItems, activeGroup]);

  const groupedResults = useMemo(() => {
    const groups: Array<{ id: GroupId; label: string; items: ResultItem[] }> = [];
    for (const g of Object.keys(GROUP_META) as GroupId[]) {
      const items = scopedItems.filter((it) => it.group === g);
      if (items.length === 0) continue;
      groups.push({ id: g, label: GROUP_META[g].label, items });
    }
    return groups;
  }, [scopedItems]);

  /* Flat ordered list used for keyboard navigation. */
  const flatItems = useMemo(
    () => groupedResults.flatMap((g) => g.items),
    [groupedResults],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmedQuery, activeGroup]);

  /* ── Recent items (shown only when query is empty + all groups) ──── */

  const recentItems = useMemo(() => {
    if (trimmedQuery || activeGroup !== 'all') return [];
    const lookup = new Map(services.map((s) => [s.id, s]));
    return recentIds
      .map((id) => lookup.get(id))
      .filter((it): it is ResultItem => Boolean(it));
  }, [recentIds, services, trimmedQuery, activeGroup]);

  /* ── Selection handler ───────────────────────────────────────────── */

  const select = useCallback(
    (item: ResultItem) => {
      pushRecent(item.id);
      setOpen(false);
      router.push(item.href);
    },
    [router],
  );

  /* ── Keyboard navigation on the list ─────────────────────────────── */

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) =>
          flatItems.length > 0 ? (i + 1) % flatItems.length : 0,
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) =>
          flatItems.length > 0
            ? (i - 1 + flatItems.length) % flatItems.length
            : 0,
        );
      } else if (e.key === 'Enter') {
        const next = flatItems[activeIndex];
        if (next) {
          e.preventDefault();
          select(next);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flatItems, activeIndex, select]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-cmd-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  /* ── Group counts (for sidebar) ──────────────────────────────────── */

  const groupCounts = useMemo(() => {
    const counts: Record<GroupId | 'all', number> = {
      all: allItems.length,
      services: 0,
      models: 0,
      providers: 0,
      prompts: 0,
      agents: 0,
      tools: 0,
      mcp: 0,
      vector: 0,
      memory: 0,
      files: 0,
      rag: 0,
      browser: 0,
      guardrails: 0,
      pii: 0,
    };
    for (const it of allItems) counts[it.group] += 1;
    return counts;
  }, [allItems]);

  const visibleGroups = useMemo(() => {
    const order = (Object.keys(GROUP_META) as GroupId[]).sort(
      (a, b) => GROUP_META[a].order - GROUP_META[b].order,
    );
    return order.filter((g) => groupCounts[g] > 0);
  }, [groupCounts]);

  if (!open) return null;

  let flatCursor = 0;

  return (
    <div
      className="cmd-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <button
        type="button"
        className="cmd-backdrop"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
        tabIndex={-1}
      />
      <div className="cmd-shell">
        <div className="cmd-header">
          <IconSearch size={17} stroke={1.7} className="cmd-search-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services, models, providers, agents…"
            className="cmd-input"
            aria-label="Search"
          />
          {loading ? (
            <span className="cmd-loading" aria-label="Loading">
              <span className="cmd-spinner" />
            </span>
          ) : null}
          <span className="cmd-kbd">ESC</span>
          <button
            type="button"
            className="cmd-close"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <IconX size={15} />
          </button>
        </div>

        <div className="cmd-body">
          <aside className="cmd-sidebar">
            <button
              type="button"
              className={`cmd-cat ${activeGroup === 'all' ? 'active' : ''}`}
              onClick={() => setActiveGroup('all')}
            >
              <span>All</span>
              <span className="cmd-cat-count">{groupCounts.all}</span>
            </button>
            <div className="cmd-sidebar-divider" />
            {visibleGroups.map((g) => {
              const meta = GROUP_META[g];
              const GroupIcon = meta.icon;
              return (
                <button
                  key={g}
                  type="button"
                  className={`cmd-cat ${activeGroup === g ? 'active' : ''}`}
                  onClick={() => setActiveGroup(g)}
                >
                  <GroupIcon size={13} stroke={1.7} />
                  <span>{meta.label}</span>
                  <span className="cmd-cat-count">{groupCounts[g]}</span>
                </button>
              );
            })}
          </aside>

          <div className="cmd-main" ref={listRef}>
            {!trimmedQuery && recentItems.length > 0 && activeGroup === 'all' ? (
              <>
                <div className="cmd-section-title">Recently visited</div>
                <div className="cmd-recent">
                  {recentItems.map((it) => (
                    <button
                      key={`recent-${it.id}`}
                      type="button"
                      className="cmd-recent-chip"
                      onClick={() => select(it)}
                    >
                      <span className="cmd-recent-chip-icon">{it.icon}</span>
                      {it.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {groupedResults.length === 0 ? (
              <div className="cmd-empty">
                {loading ? (
                  <span className="ds-muted" style={{ fontSize: 13 }}>
                    Searching…
                  </span>
                ) : trimmedQuery ? (
                  <>
                    <IconSearch size={22} stroke={1.6} />
                    <div>
                      No results for &ldquo;
                      <strong>{trimmedQuery}</strong>&rdquo;
                    </div>
                    <div className="ds-faint" style={{ fontSize: 12 }}>
                      Try a shorter term or another category.
                    </div>
                  </>
                ) : (
                  <span className="ds-muted" style={{ fontSize: 13 }}>
                    Start typing to search across services and instances.
                  </span>
                )}
              </div>
            ) : (
              groupedResults.map((group) => (
                <div key={group.id} className="cmd-group">
                  <div className="cmd-section-title">
                    <GroupHeader group={group.id} count={group.items.length} />
                  </div>
                  <div className="cmd-results">
                    {group.items.map((it) => {
                      const idx = flatCursor;
                      flatCursor += 1;
                      const active = idx === activeIndex;
                      return (
                        <button
                          key={it.id}
                          type="button"
                          data-cmd-index={idx}
                          className={`cmd-row ${active ? 'active' : ''}`}
                          onMouseMove={() => setActiveIndex(idx)}
                          onClick={() => select(it)}
                        >
                          <span className="cmd-row-icon">{it.icon}</span>
                          <span className="cmd-row-body">
                            <span className="cmd-row-label">
                              {highlight(it.label, trimmedQuery)}
                            </span>
                            {it.sublabel ? (
                              <span className="cmd-row-sub">
                                {it.sublabel}
                              </span>
                            ) : null}
                          </span>
                          <span className="cmd-row-type">
                            {GROUP_META[it.group].label}
                          </span>
                          {active ? (
                            <IconCornerDownLeft
                              size={12}
                              stroke={1.7}
                              className="cmd-row-enter"
                            />
                          ) : (
                            <IconArrowRight
                              size={12}
                              stroke={1.7}
                              className="cmd-row-arrow"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="cmd-footer">
          <span>
            <span className="cmd-kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="cmd-kbd">⏎</span> open
          </span>
          <span>
            <span className="cmd-kbd">ESC</span> close
          </span>
          <span className="cmd-footer-spacer" />
          <span className="cmd-footer-hint">
            Searches services + their instances in real time
          </span>
        </div>
      </div>
    </div>
  );
}

function GroupHeader({ group, count }: { group: GroupId; count: number }) {
  const meta = GROUP_META[group];
  const GroupIcon = meta.icon;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <GroupIcon size={11} stroke={1.7} />
      {meta.label}
      <span className="cmd-section-count">{count}</span>
    </span>
  );
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="cmd-mark">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
