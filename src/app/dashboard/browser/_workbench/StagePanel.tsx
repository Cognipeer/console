'use client';

/**
 * The right-hand half of a workbench: what the page is doing.
 *
 * Preview, elements and console are one component rather than three because
 * they are three views of one session and share its header — the URL line,
 * the refresh, the live toggle. The element list is the only interactive
 * part: picking a row is how a target gets into an action, in the playground
 * and in the flow editor alike.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconRefresh, IconTargetArrow, IconWorld } from '@tabler/icons-react';
import { INTERACTIVE_ROLES, type SnapshotNode } from './snapshot';
import type { WorkbenchStage } from './useWorkbench';
import classes from './workbench.module.css';

export default function StagePanel({
  stage,
  sessionKey,
  onPickElement,
  emptyHint = 'Start a session to see the page.',
  pickHint,
}: {
  stage: WorkbenchStage;
  sessionKey?: string;
  onPickElement?: (node: SnapshotNode) => void;
  emptyHint?: string;
  /** Set while a caller is waiting for a pick, so the list says what for. */
  pickHint?: string;
}) {
  const [tab, setTab] = useState('preview');
  const [interactiveOnly, setInteractiveOnly] = useState(true);
  const [query, setQuery] = useState('');

  // Keep the list live while it is the thing on screen. The preview has
  // always refreshed itself; the element list did not, so a page that moved
  // on its own — a login redirect, a client-side route change — left it
  // describing a page that is no longer there. Scoped to this tab so nothing
  // pays for an aria tree it is not looking at.
  // Being asked for a pick means the list is the thing to be looking at.
  useEffect(() => { if (pickHint) setTab('elements'); }, [pickHint]);

  const { poll, autoRefresh, awaitingContent } = stage;
  useEffect(() => {
    if (!sessionKey || !autoRefresh) return;
    void poll(sessionKey);

    // Polling runs whether or not this tab is the one on screen. Scoping it
    // to the visible tab meant the list was only ever as fresh as the last
    // time you looked at it: drive the page from Preview, switch to Elements,
    // and you were handed the page BEFORE the last step until the switch
    // itself refreshed it. Cheap enough to just keep warm.
    //
    // A client-rendered route answers its navigation with an empty shell and
    // paints a beat later, so while there is nothing to pick, ask again
    // quickly; otherwise stay lazy, and lazier still when nobody is looking.
    const every = awaitingContent ? 700 : tab === 'elements' ? 3000 : 6000;
    const timer = setInterval(() => { void poll(sessionKey); }, every);
    return () => clearInterval(timer);
  }, [tab, sessionKey, autoRefresh, awaitingContent, poll]);

  const visibleNodes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return stage.nodes.filter((node) => {
      if (interactiveOnly && !INTERACTIVE_ROLES.has(node.role)) return false;
      if (!needle) return true;
      // Search the value too: on a form of six textboxes the accessible name
      // is the least distinctive thing about the one you are looking for.
      return node.role.includes(needle)
        || (node.name ?? '').toLowerCase().includes(needle)
        || (node.value ?? '').toLowerCase().includes(needle);
    });
  }, [stage.nodes, interactiveOnly, query]);

  return (
    <main className={classes.right}>
      <div className={classes.rightHead}>
        <SegmentedControl
          size="xs"
          value={tab}
          onChange={(next) => {
            setTab(next);
            if (next === 'console') void stage.loadDiagnostics();
          }}
          data={[
            { value: 'preview', label: 'Preview' },
            { value: 'elements', label: `Elements${stage.nodes.length ? ` (${visibleNodes.length})` : ''}` },
            { value: 'console', label: 'Console' },
          ]}
        />
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
            {stage.pageTitle ? `${stage.pageTitle} — ` : ''}{stage.pageUrl || 'about:blank'}
          </Text>
          <Tooltip label="Refresh">
            <ActionIcon size="sm" variant="subtle" aria-label="Refresh preview" onClick={stage.refresh}>
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
          <Switch
            size="xs"
            label="Live"
            checked={stage.autoRefresh}
            onChange={(event) => stage.setAutoRefresh(event.currentTarget.checked)}
          />
        </Group>
      </div>

      {tab === 'preview' ? (
        <div className={classes.preview}>
          {!sessionKey ? (
            <div className={classes.placeholder}>
              <IconWorld size={30} stroke={1.4} />
              <Text size="sm" c="dimmed">{emptyHint}</Text>
            </div>
          ) : stage.shotUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={stage.shotUrl} alt="Live browser preview" className={classes.shot} />
          ) : (
            <div className={classes.placeholder}>
              <Loader size="sm" />
              <Text size="sm" c="dimmed">Navigate somewhere to see the page.</Text>
            </div>
          )}
        </div>
      ) : null}

      {tab === 'elements' ? (
        <div className={classes.elements}>
          {pickHint ? (
            <div className={classes.pickHint}>
              <IconTargetArrow size={14} />
              <Text size="xs" fw={600}>{pickHint}</Text>
            </div>
          ) : null}
          <Group gap="xs" p="xs" wrap="nowrap">
            <TextInput
              size="xs"
              placeholder="Filter elements…"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
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
              <Group gap={8} p="sm" wrap="nowrap">
                {awaitingContent && sessionKey ? <Loader size="xs" /> : null}
                <Text size="xs" c="dimmed" fs="italic">
                  {!sessionKey
                    ? 'No session — start one to see the page.'
                    : awaitingContent
                      // Says what is actually true, instead of leaving the
                      // user to guess whether the panel is broken.
                      ? 'The page has arrived but has not painted anything to pick yet. This keeps checking.'
                      : stage.snapshot
                        ? 'Nothing matches. Turn off “interactive only” to see the whole tree.'
                        : 'No snapshot yet — navigate somewhere first.'}
                </Text>
              </Group>
            ) : (
              <Stack gap={0}>
                {visibleNodes.map((node) => (
                  <button
                    key={node.ref}
                    type="button"
                    className={classes.elementRow}
                    disabled={!onPickElement}
                    onClick={() => onPickElement?.(node)}
                    title={node.value ? `${node.role} “${node.name ?? ''}” — ${node.value}` : undefined}
                  >
                    {/* Left: how the step will address it. Right: what is in
                        it right now — the half you scan for. */}
                    <span className={classes.elementTarget}>
                      <Badge size="xs" variant="light" color={INTERACTIVE_ROLES.has(node.role) ? 'blue' : 'gray'}>
                        {node.role}
                      </Badge>
                      <span className={classes.elementName}>
                        {node.name || (
                          // No accessible name: say where it sits instead of
                          // "unnamed", which describes every one of them.
                          <span className={classes.elementPath}>{node.path ?? node.role}</span>
                        )}
                      </span>
                      {node.ambiguous ? (
                        <Badge size="xs" variant="light" color="orange">#{node.nth}</Badge>
                      ) : null}
                    </span>
                    <span className={classes.elementValue}>{node.value ?? ''}</span>
                    <span className={classes.elementRef}>{node.ref}</span>
                  </button>
                ))}
              </Stack>
            )}
          </ScrollArea>
        </div>
      ) : null}

      {tab === 'console' ? (
        <ScrollArea className={classes.console}>
          {!stage.diagnostics ? (
            <Text size="xs" c="dimmed" fs="italic" p="sm">No diagnostics yet.</Text>
          ) : (
            <Stack gap={2} p="xs">
              {stage.diagnostics.networkFailures.map((entry, index) => (
                <Group key={`net-${index}`} gap="xs" wrap="nowrap">
                  <Badge size="xs" variant="light" color="red">network</Badge>
                  <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                    {entry.url} — {entry.failure ?? 'failed'}
                  </Text>
                </Group>
              ))}
              {stage.diagnostics.console.map((entry, index) => (
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
              {stage.diagnostics.console.length === 0 && stage.diagnostics.networkFailures.length === 0 ? (
                <Text size="xs" c="dimmed" fs="italic">The page has logged nothing.</Text>
              ) : null}
            </Stack>
          )}
        </ScrollArea>
      ) : null}
    </main>
  );
}
