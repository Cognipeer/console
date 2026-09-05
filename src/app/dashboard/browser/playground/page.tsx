'use client';

/**
 * Browser playground — drive a real session and record what you did.
 *
 * The layout is the argument: controls on the left, the page on the right.
 * Driving a browser is a loop of *look, then act*, and a form that hides the
 * page while you fill it breaks that loop. So the preview never leaves the
 * screen, and the element list beside it is CLICKABLE — picking a row fills
 * the action composer with that element's durable target, which is the same
 * descriptor a recorded flow step will store.
 *
 * That is the whole point of doing this in a UI rather than with curl: you
 * discover the steps once, here, and then `Record as flow` freezes them into
 * something that replays without a model.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsSplit,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTerminal2,
  IconTrash,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { BrowserSessionView, BrowserView } from '@/lib/services/browser';
import classes from './playground.module.css';

/** One node of the aria snapshot, flattened for the element list. */
interface SnapshotNode {
  ref: string;
  role: string;
  name?: string;
  depth: number;
  /** True when role+name repeats, so `nth` is load-bearing. */
  ambiguous: boolean;
  nth: number;
}

interface LogEntry {
  id: number;
  label: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

/**
 * Parse `ariaSnapshot({ mode: 'ai' })` output into addressable rows.
 *
 * Mirrors `indexAriaRefs` on the server: role first, quoted accessible name
 * if present, `[ref=…]` marker last. `nth` is assigned in document order
 * among nodes sharing a role+name, and only marked load-bearing when that
 * pair actually repeats — a redundant `nth: 0` breaks the moment the page
 * grows a second match above the recorded one.
 */
function parseSnapshot(snapshot: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  const groups = new Map<string, number>();

  for (const line of snapshot.split('\n')) {
    const refMatch = line.match(/\[ref=([A-Za-z0-9_-]+)\]/);
    if (!refMatch) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const body = line.replace(/^\s*-\s*/, '').split(/\s*\[/)[0] ?? '';
    const roleMatch = body.match(/^([A-Za-z][A-Za-z0-9_-]*)/);
    if (!roleMatch) continue;
    const nameMatch = body.match(/"((?:[^"\\]|\\.)*)"/);
    const role = roleMatch[1];
    const name = nameMatch ? nameMatch[1].replace(/\\(.)/g, '$1') : undefined;
    const key = `${role} ${name ?? ''}`;
    const seen = groups.get(key) ?? 0;
    groups.set(key, seen + 1);
    nodes.push({ ref: refMatch[1], role, name, depth: Math.floor(indent / 2), ambiguous: false, nth: seen });
  }

  for (const node of nodes) {
    if ((groups.get(`${node.role} ${node.name ?? ''}`) ?? 0) > 1) node.ambiguous = true;
  }
  return nodes;
}

/** Roles worth showing by default — the rest is layout scaffolding. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'tab', 'switch', 'searchbox', 'slider', 'spinbutton',
]);

const ACTION_TYPES = [
  { value: 'goto', label: 'Navigate' },
  { value: 'click', label: 'Click' },
  { value: 'type', label: 'Type' },
  { value: 'select', label: 'Select option' },
  { value: 'check', label: 'Check / uncheck' },
  { value: 'press', label: 'Press key' },
  { value: 'hover', label: 'Hover' },
  { value: 'scroll', label: 'Scroll' },
  { value: 'wait', label: 'Wait' },
  { value: 'extract', label: 'Read value' },
];

const TARGETED = new Set(['click', 'type', 'select', 'check', 'press', 'hover', 'scroll', 'extract']);

export default function BrowserPlaygroundPage() {
  const router = useRouter();

  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [browserId, setBrowserId] = useState<string>('');
  // Fills exactly the dashboard's <main> content area — see the CSS module
  // header for why this can't be `position: absolute`. `null` until the
  // first measurement lands, so the shell renders at its natural (collapsed)
  // size for one frame rather than flashing at 0 height.
  const shellRef = useRef<HTMLDivElement>(null);
  const [fill, setFill] = useState<{ height: number; margin: string } | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    const main = shell?.closest('main');
    if (!shell || !main) return;

    const measure = () => {
      const mainRect = main.getBoundingClientRect();
      const mainStyle = getComputedStyle(main);
      const padLeft = parseFloat(mainStyle.paddingLeft) || 0;
      const padRight = parseFloat(mainStyle.paddingRight) || 0;
      const padBottom = parseFloat(mainStyle.paddingBottom) || 0;
      // The shell's own top is stable regardless of its height — it's fixed
      // by whatever sits above it (the dashboard's breadcrumb row) — so this
      // isn't circular: measure top, then derive height from it.
      const top = shell.getBoundingClientRect().top;
      setFill({
        // Reaches <main>'s outer bottom edge (into its bottom padding); the
        // matching negative bottom margin below keeps that from overflowing.
        height: Math.max(0, mainRect.bottom - top),
        margin: `0 -${padRight}px -${padBottom}px -${padLeft}px`,
      });
    };

    measure();
    // ResizeObserver over window resize: also fires when the service sub-nav
    // collapses/expands and changes <main>'s width without a resize event.
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  const [session, setSession] = useState<BrowserSessionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);

  const [snapshot, setSnapshot] = useState('');
  const [nodes, setNodes] = useState<SnapshotNode[]>([]);
  const [pageUrl, setPageUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [shotUrl, setShotUrl] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rightTab, setRightTab] = useState('preview');
  const [interactiveOnly, setInteractiveOnly] = useState(true);
  const [elementQuery, setElementQuery] = useState('');
  const [diagnostics, setDiagnostics] = useState<{ console: Array<{ type: string; text: string }>; networkFailures: Array<{ url: string; failure?: string }> } | null>(null);

  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  // ── Action composer ───────────────────────────────────────
  const [actionType, setActionType] = useState('goto');
  const [url, setUrl] = useState('');
  const [value, setValue] = useState('');
  const [keyName, setKeyName] = useState('Enter');
  const [waitMs, setWaitMs] = useState('1000');
  const [waitText, setWaitText] = useState('');
  const [checked, setChecked] = useState(true);
  const [scrollY, setScrollY] = useState('600');
  const [target, setTarget] = useState<Record<string, string | number>>({});

  const [recordOpen, setRecordOpen] = useState(false);
  const [recordName, setRecordName] = useState('');
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/browser/browsers?status=active', { cache: 'no-store' });
      if (!res.ok) return;
      const list: BrowserView[] = (await res.json()).browsers ?? [];
      setBrowsers(list);
      if (list.length > 0) setBrowserId((current) => current || list[0].id);
    })();
  }, []);

  const refreshShot = useCallback(() => {
    if (!session) return;
    // Cache-busted rather than polled through JSON: the endpoint returns the
    // image itself with `cache-control: no-store`, so the <img> is the
    // cheapest live view available.
    setShotUrl(`/api/browser/sessions/${encodeURIComponent(session.sessionKey)}/screenshot/live?ts=${Date.now()}`);
  }, [session]);

  const refreshSnapshot = useCallback(async () => {
    if (!session) return;
    const res = await fetch(`/api/browser/sessions/${encodeURIComponent(session.sessionKey)}/snapshot`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setSnapshot(data.ariaSnapshot ?? '');
    setNodes(parseSnapshot(data.ariaSnapshot ?? ''));
    setPageUrl(data.url ?? '');
  }, [session]);

  useEffect(() => {
    if (!session || !autoRefresh) return;
    const timer = setInterval(refreshShot, 3000);
    return () => clearInterval(timer);
  }, [session, autoRefresh, refreshShot]);

  async function startSession() {
    if (!browserId) return;
    setStarting(true);
    try {
      const res = await fetch('/api/browser/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browserId, name: 'playground' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start a session');
      setSession(data.session);
      setLog([]);
      setSnapshot('');
      setNodes([]);
      notifications.show({ color: 'teal', title: 'Session started', message: data.session.sessionKey });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setStarting(false);
    }
  }

  async function endSession() {
    if (!session) return;
    await fetch(`/api/browser/sessions/${encodeURIComponent(session.sessionKey)}`, { method: 'DELETE' })
      .catch(() => undefined);
    setSession(null);
    setShotUrl('');
    setSnapshot('');
    setNodes([]);
  }

  /** Build the action payload the API expects from the composer state. */
  function buildAction(): Record<string, unknown> | null {
    const action: Record<string, unknown> = { type: actionType };
    if (TARGETED.has(actionType)) {
      if (Object.keys(target).length === 0) return null;
      Object.assign(action, target);
    }
    if (actionType === 'goto') {
      if (!url.trim()) return null;
      action.url = url.trim();
    }
    if (actionType === 'type') action.text = value;
    if (actionType === 'select') action.labels = [value];
    if (actionType === 'press') action.key = keyName;
    if (actionType === 'check') action.checked = checked;
    if (actionType === 'scroll') action.y = Number(scrollY) || 0;
    if (actionType === 'wait') {
      if (waitText.trim()) action.text = waitText.trim();
      else action.ms = Number(waitMs) || 1000;
    }
    return action;
  }

  async function run() {
    if (!session) return;
    const action = buildAction();
    if (!action) {
      notifications.show({
        color: 'orange',
        title: 'Nothing to run',
        message: TARGETED.has(actionType)
          ? 'Pick an element from the list on the right first.'
          : 'Fill in the action first.',
      });
      return;
    }

    setBusy(true);
    const started = Date.now();
    try {
      // `extract` reads rather than acts, so it has its own endpoint — but to
      // the person driving, it is one more step in the same sequence.
      const isRead = actionType === 'extract';
      const endpoint = isRead ? 'extract' : 'actions';
      const body = isRead ? { ...action, type: undefined } : action;
      const res = await fetch(
        `/api/browser/sessions/${encodeURIComponent(session.sessionKey)}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))),
        },
      );
      const data = await res.json().catch(() => ({}));
      const result = data.result ?? data;
      const ok = res.ok && result?.ok !== false;

      logId.current += 1;
      setLog((entries) => [
        {
          id: logId.current,
          label: describeAction(action),
          ok,
          detail: isRead
            ? (result?.values ?? []).join(' · ').slice(0, 200)
            : result?.errorMessage ?? data.error,
          durationMs: Date.now() - started,
        },
        ...entries,
      ]);

      if (!ok) {
        notifications.show({
          color: 'red',
          title: 'Action failed',
          message: result?.errorMessage ?? data.error ?? 'Failed',
        });
      } else {
        if (result?.url) setPageUrl(result.url);
        if (result?.pageTitle) setPageTitle(result.pageTitle);
        if (typeof result?.ariaSnapshot === 'string' && result.ariaSnapshot) {
          setSnapshot(result.ariaSnapshot);
          setNodes(parseSnapshot(result.ariaSnapshot));
        } else {
          await refreshSnapshot();
        }
        refreshShot();
        // A ref belongs to the snapshot that produced it; the one just
        // consumed is now stale, so clear it rather than let the next action
        // silently address the wrong element.
        setTarget({});
      }
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setBusy(false);
    }
  }

  async function loadDiagnostics() {
    if (!session) return;
    const res = await fetch(`/api/browser/sessions/${encodeURIComponent(session.sessionKey)}/diagnostics`, { cache: 'no-store' });
    if (res.ok) setDiagnostics(await res.json());
  }

  async function recordFlow() {
    if (!session) return;
    setRecording(true);
    try {
      const res = await fetch('/api/browser/flows/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          name: recordName.trim() || 'Playground flow',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Recording failed');
      notifications.show({
        color: 'teal',
        title: 'Flow recorded',
        message: `${data.flow.steps.length} step(s) captured`,
      });
      router.push(`/dashboard/browser/flows/${data.flow.id}`);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not record',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setRecording(false);
    }
  }

  const visibleNodes = useMemo(() => {
    const needle = elementQuery.toLowerCase();
    return nodes.filter((node) => {
      if (interactiveOnly && !INTERACTIVE_ROLES.has(node.role)) return false;
      if (!needle) return true;
      return node.role.includes(needle) || (node.name ?? '').toLowerCase().includes(needle);
    });
  }, [nodes, interactiveOnly, elementQuery]);

  const targetLabel = useMemo(() => {
    if (Object.keys(target).length === 0) return null;
    if (target.name) return `${target.role ?? 'element'} “${target.name}”`;
    if (target.testId) return `testId=${target.testId}`;
    if (target.selector) return String(target.selector);
    return String(target.role ?? 'element');
  }, [target]);

  const actionCount = log.length;

  return (
    <div
      ref={shellRef}
      className={classes.shell}
      style={fill ? { height: fill.height, margin: fill.margin } : undefined}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <header className={classes.header}>
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconWorld size={18} stroke={1.7} />
          <Text fw={600} size="sm">Browser playground</Text>
          {session ? (
            <>
              <Badge size="sm" variant="light" color="teal">live</Badge>
              <Code style={{ fontSize: 11 }}>{session.sessionKey}</Code>
            </>
          ) : (
            <Badge size="sm" variant="light" color="gray">no session</Badge>
          )}
        </Group>

        <Group gap="xs" wrap="nowrap">
          <Select
            size="xs"
            w={200}
            placeholder={browsers.length === 0 ? 'No active browsers' : 'Pick a browser'}
            data={browsers.map((b) => ({ value: b.id, label: b.name }))}
            value={browserId || null}
            onChange={(next) => setBrowserId(next ?? '')}
            disabled={Boolean(session)}
            aria-label="Browser"
          />
          {session ? (
            <>
              <Button
                size="xs"
                variant="light"
                color="grape"
                leftSection={<IconArrowsSplit size={14} />}
                disabled={actionCount === 0}
                onClick={() => setRecordOpen(true)}
              >
                Record as flow
              </Button>
              <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={endSession}>
                End session
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              color="teal"
              loading={starting}
              disabled={!browserId}
              leftSection={<IconPlayerPlay size={14} />}
              onClick={startSession}
            >
              Start session
            </Button>
          )}
        </Group>
      </header>

      <div className={classes.body}>
        {/* ── Left: what you do ────────────────────────────── */}
        <aside className={classes.left}>
          <div className={classes.panelHead}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">Action</Text>
          </div>

          <Stack gap="xs" p="sm">
            <Select
              size="xs"
              label="Step"
              data={ACTION_TYPES}
              value={actionType}
              onChange={(next) => next && setActionType(next)}
            />

            {actionType === 'goto' ? (
              <TextInput
                size="xs"
                label="URL"
                placeholder="https://example.com"
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void run(); }}
              />
            ) : null}

            {actionType === 'type' || actionType === 'select' ? (
              <TextInput
                size="xs"
                label={actionType === 'type' ? 'Text' : 'Option label'}
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
            ) : null}

            {actionType === 'press' ? (
              <TextInput
                size="xs"
                label="Key"
                placeholder="Enter"
                value={keyName}
                onChange={(event) => setKeyName(event.currentTarget.value)}
              />
            ) : null}

            {actionType === 'check' ? (
              <Switch
                size="sm"
                label={checked ? 'Check it' : 'Uncheck it'}
                checked={checked}
                onChange={(event) => setChecked(event.currentTarget.checked)}
              />
            ) : null}

            {actionType === 'scroll' ? (
              <TextInput
                size="xs"
                label="Scroll down (px)"
                value={scrollY}
                onChange={(event) => setScrollY(event.currentTarget.value)}
              />
            ) : null}

            {actionType === 'wait' ? (
              <>
                <TextInput
                  size="xs"
                  label="Until text appears"
                  placeholder="Leave empty for a fixed delay"
                  value={waitText}
                  onChange={(event) => setWaitText(event.currentTarget.value)}
                />
                {!waitText.trim() ? (
                  <TextInput
                    size="xs"
                    label="Delay (ms)"
                    value={waitMs}
                    onChange={(event) => setWaitMs(event.currentTarget.value)}
                  />
                ) : null}
              </>
            ) : null}

            {TARGETED.has(actionType) ? (
              <div className={classes.targetSlot}>
                <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>Element</Text>
                {targetLabel ? (
                  <Group gap="xs" wrap="nowrap">
                    <Badge size="sm" variant="light" color="teal" style={{ maxWidth: '100%' }}>
                      {targetLabel}
                    </Badge>
                    <ActionIcon size="xs" variant="subtle" aria-label="Clear element" onClick={() => setTarget({})}>
                      <IconX size={12} />
                    </ActionIcon>
                  </Group>
                ) : (
                  <Text size="xs" c="dimmed" fs="italic">
                    Pick one from the Elements list →
                  </Text>
                )}
              </div>
            ) : null}

            <Button
              size="xs"
              color="teal"
              loading={busy}
              disabled={!session}
              leftSection={<IconChevronRight size={14} />}
              onClick={run}
            >
              Run step
            </Button>
          </Stack>

          <div className={classes.panelHead}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Steps run {actionCount > 0 ? `(${actionCount})` : ''}
            </Text>
            {actionCount > 0 ? (
              <ActionIcon size="xs" variant="subtle" aria-label="Clear log" onClick={() => setLog([])}>
                <IconTrash size={12} />
              </ActionIcon>
            ) : null}
          </div>

          <ScrollArea className={classes.logScroll}>
            {log.length === 0 ? (
              <Text size="xs" c="dimmed" fs="italic" p="sm">
                Nothing yet. Navigate somewhere, then pick an element and act on it.
              </Text>
            ) : (
              <Stack gap={0}>
                {log.map((entry) => (
                  <div key={entry.id} className={classes.logRow}>
                    {entry.ok
                      ? <IconCircleCheck size={13} className={classes.okIcon} />
                      : <IconCircleX size={13} className={classes.errIcon} />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Text size="xs">{entry.label}</Text>
                      {entry.detail ? (
                        <Text size="xs" c="dimmed" lineClamp={2}>{entry.detail}</Text>
                      ) : null}
                    </div>
                    <Text size="xs" c="dimmed" ff="monospace">{entry.durationMs}ms</Text>
                  </div>
                ))}
              </Stack>
            )}
          </ScrollArea>
        </aside>

        {/* ── Right: what the page is doing ────────────────── */}
        <main className={classes.right}>
          <div className={classes.rightHead}>
            <SegmentedControl
              size="xs"
              value={rightTab}
              onChange={(next) => {
                setRightTab(next);
                if (next === 'console') void loadDiagnostics();
              }}
              data={[
                { value: 'preview', label: 'Preview' },
                { value: 'elements', label: `Elements${nodes.length ? ` (${visibleNodes.length})` : ''}` },
                { value: 'console', label: 'Console' },
              ]}
            />
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
                {pageTitle ? `${pageTitle} — ` : ''}{pageUrl || 'about:blank'}
              </Text>
              <Tooltip label="Refresh preview">
                <ActionIcon size="sm" variant="subtle" aria-label="Refresh preview" onClick={() => { refreshShot(); void refreshSnapshot(); }}>
                  <IconRefresh size={14} />
                </ActionIcon>
              </Tooltip>
              <Switch
                size="xs"
                label="Live"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
              />
            </Group>
          </div>

          {rightTab === 'preview' ? (
            <div className={classes.preview}>
              {!session ? (
                <div className={classes.placeholder}>
                  <IconWorld size={30} stroke={1.4} />
                  <Text size="sm" c="dimmed">Start a session to see the page.</Text>
                </div>
              ) : shotUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={shotUrl} alt="Live browser preview" className={classes.shot} />
              ) : (
                <div className={classes.placeholder}>
                  <Loader size="sm" />
                  <Text size="sm" c="dimmed">Navigate somewhere to see the page.</Text>
                </div>
              )}
            </div>
          ) : null}

          {rightTab === 'elements' ? (
            <div className={classes.elements}>
              <Group gap="xs" p="xs" wrap="nowrap">
                <TextInput
                  size="xs"
                  placeholder="Filter elements…"
                  value={elementQuery}
                  onChange={(event) => setElementQuery(event.currentTarget.value)}
                  style={{ flex: 1 }}
                />
                <Switch
                  size="xs"
                  label="Interactive only"
                  checked={interactiveOnly}
                  onChange={(event) => setInteractiveOnly(event.currentTarget.checked)}
                />
              </Group>

              <ScrollArea style={{ flex: 1 }}>
                {visibleNodes.length === 0 ? (
                  <Text size="xs" c="dimmed" fs="italic" p="sm">
                    {snapshot
                      ? 'Nothing matches. Turn off “interactive only” to see the whole tree.'
                      : 'No snapshot yet — navigate somewhere first.'}
                  </Text>
                ) : (
                  <Stack gap={0}>
                    {visibleNodes.map((node) => (
                      <button
                        key={node.ref}
                        type="button"
                        className={classes.elementRow}
                        onClick={() => {
                          // Store BOTH: the ref makes this exact click land on
                          // the element you just saw, and the durable
                          // role+name is what survives into a recorded step.
                          const next: Record<string, string | number> = { ref: node.ref, role: node.role };
                          if (node.name) next.name = node.name;
                          if (node.ambiguous) next.nth = node.nth;
                          setTarget(next);
                          if (node.role === 'textbox' || node.role === 'searchbox') setActionType('type');
                          else if (node.role === 'checkbox' || node.role === 'radio') setActionType('check');
                          else if (node.role === 'combobox') setActionType('select');
                          else if (actionType === 'goto') setActionType('click');
                        }}
                      >
                        <Badge size="xs" variant="light" color={INTERACTIVE_ROLES.has(node.role) ? 'blue' : 'gray'}>
                          {node.role}
                        </Badge>
                        <span className={classes.elementName}>{node.name || <em>unnamed</em>}</span>
                        {node.ambiguous ? (
                          <Badge size="xs" variant="light" color="orange">#{node.nth}</Badge>
                        ) : null}
                        <span className={classes.elementRef}>{node.ref}</span>
                      </button>
                    ))}
                  </Stack>
                )}
              </ScrollArea>
            </div>
          ) : null}

          {rightTab === 'console' ? (
            <ScrollArea className={classes.console}>
              {!diagnostics ? (
                <Text size="xs" c="dimmed" fs="italic" p="sm">No diagnostics yet.</Text>
              ) : (
                <Stack gap={2} p="xs">
                  {diagnostics.networkFailures.map((entry, index) => (
                    <Group key={`net-${index}`} gap="xs" wrap="nowrap">
                      <Badge size="xs" variant="light" color="red">network</Badge>
                      <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                        {entry.url} — {entry.failure ?? 'failed'}
                      </Text>
                    </Group>
                  ))}
                  {diagnostics.console.map((entry, index) => (
                    <Group key={`log-${index}`} gap="xs" wrap="nowrap" align="flex-start">
                      <Badge
                        size="xs"
                        variant="light"
                        color={entry.type === 'error' || entry.type === 'pageerror' ? 'red' : 'gray'}
                      >
                        {entry.type}
                      </Badge>
                      <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word' }}>{entry.text}</Text>
                    </Group>
                  ))}
                  {diagnostics.console.length === 0 && diagnostics.networkFailures.length === 0 ? (
                    <Text size="xs" c="dimmed" fs="italic">The page has logged nothing.</Text>
                  ) : null}
                </Stack>
              )}
            </ScrollArea>
          ) : null}
        </main>
      </div>

      <FormShell
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        title="Record this session as a flow"
        subtitle="The steps you just ran become an ordered list you can replay without a model."
        icon={<IconArrowsSplit size={18} stroke={1.7} />}
        primaryAction={{
          label: 'Record flow',
          color: 'teal',
          loading: recording,
          onClick: recordFlow,
        }}
        secondaryAction={{ label: 'Cancel', onClick: () => setRecordOpen(false) }}
      >
        <FormSection title="Flow">
          <FormRow cols={1}>
            <FormField label="Name" hint={`${actionCount} step(s) run in this session.`}>
              <TextInput
                placeholder="Playground flow"
                value={recordName}
                onChange={(event) => setRecordName(event.currentTarget.value)}
              />
            </FormField>
          </FormRow>
          <Text size="xs" c="dimmed">
            Element references are replaced with durable ones, and anything you typed becomes a
            flow input rather than a stored value — so a password you entered here is not saved
            into the flow.
          </Text>
        </FormSection>
      </FormShell>
    </div>
  );
}

function describeAction(action: Record<string, unknown>): string {
  const type = String(action.type ?? 'extract');
  const name = action.name ? `“${action.name}”` : action.selector ?? action.testId ?? '';
  if (type === 'goto') return `Navigate to ${action.url}`;
  if (type === 'wait') return action.text ? `Wait for “${action.text}”` : `Wait ${action.ms}ms`;
  if (type === 'scroll') return `Scroll ${action.y}px`;
  if (type === 'type') return `Type into ${name}`;
  if (type === 'undefined' || type === 'extract') return `Read ${name}`;
  return `${type} ${name}`;
}
