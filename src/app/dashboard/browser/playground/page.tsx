'use client';

/**
 * Browser playground — drive a real session and see what the page does.
 *
 * Scope is the point: this page opens a browser, acts on it, and shows the
 * result. It does not build anything. Flows live in the flow editor, which is
 * the same workbench with a flow attached — so the one thing this page does
 * produce is a hand-off: `Record as flow` freezes what you just discovered
 * into a draft and sends you there.
 *
 * The layout is the argument for doing this in a UI at all: controls on the
 * left, the page on the right, permanently. Driving a browser is a loop of
 * *look, then act*, and a form that hides the page while you fill it breaks
 * that loop. The element list beside the preview is CLICKABLE — picking a row
 * fills the composer with that element's target.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowsSplit,
  IconCircleCheck,
  IconCircleX,
  IconPlayerPlay,
  IconTrash,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { BrowserSessionView, BrowserView } from '@/lib/services/browser';
import ActionComposer from '../_workbench/ActionComposer';
import StagePanel from '../_workbench/StagePanel';
import {
  EMPTY_DRAFT,
  TARGETED,
  actionForRole,
  buildAction,
  describeAction,
  targetForNode,
  type ActionDraft,
} from '../_workbench/actions';
import { useDriveSession, useFillMain, useWorkbenchStage } from '../_workbench/useWorkbench';
import classes from '../_workbench/workbench.module.css';

interface LogEntry {
  id: number;
  label: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

export default function BrowserPlaygroundPage() {
  const router = useRouter();
  const shell = useFillMain();

  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [browserId, setBrowserId] = useState('');
  const [sessionKey, setSessionKey] = useState<string | undefined>(undefined);

  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);
  const [draft, setDraft] = useState<ActionDraft>(EMPTY_DRAFT);

  const [recordOpen, setRecordOpen] = useState(false);
  const [recordName, setRecordName] = useState('');
  const [recording, setRecording] = useState(false);

  const stage = useWorkbenchStage(sessionKey);
  const drive = useDriveSession({
    browserId,
    name: 'playground',
    stage,
    onStarted: () => setLog([]),
  });

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/browser/browsers?status=active', { cache: 'no-store' });
      if (!res.ok) return;
      const list: BrowserView[] = (await res.json()).browsers ?? [];
      setBrowsers(list);
      if (list.length === 0) return;
      // The overview links here with the profile you clicked from. Read it off
      // the URL rather than through `useSearchParams`, which would need a
      // Suspense boundary to survive `next build`.
      const wanted = new URLSearchParams(window.location.search).get('browserId');
      const preselected = wanted && list.some((item) => item.id === wanted) ? wanted : list[0].id;
      setBrowserId((current) => current || preselected);
    })();
  }, []);

  async function startSession() {
    const session = await drive.start();
    if (session) setSessionKey(session.sessionKey);
  }

  async function endSession() {
    await drive.end();
    setSessionKey(undefined);
  }

  async function runStep() {
    const action = buildAction(draft);
    if (!action) {
      notifications.show({
        color: 'orange',
        title: 'Nothing to run',
        message: TARGETED.has(draft.type)
          ? 'Pick an element from the list on the right first.'
          : 'Fill in the action first.',
      });
      return;
    }

    const outcome = await drive.runAction(action);
    if (!outcome) return;

    logId.current += 1;
    setLog((entries) => [
      {
        id: logId.current,
        label: describeAction(action),
        ok: outcome.ok,
        detail: outcome.detail,
        durationMs: outcome.durationMs,
      },
      ...entries,
    ]);

    // A ref belongs to the snapshot that produced it; the one just consumed is
    // now stale, so clear it rather than let the next action silently address
    // the wrong element.
    if (outcome.ok) setDraft((current) => ({ ...current, target: {} }));
  }

  async function recordFlow() {
    const session: BrowserSessionView | null = drive.session;
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
        message: `${data.flow.steps.length} step(s) captured — opening the editor`,
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

  return (
    <div ref={shell.ref} className={classes.shell} style={shell.style}>
      {/* ── Header ─────────────────────────────────────────── */}
      <header className={classes.header}>
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconWorld size={18} stroke={1.7} />
          <Text fw={600} size="sm">Browser playground</Text>
          {drive.session ? (
            <>
              <Badge size="sm" variant="light" color="teal">live</Badge>
              <Code style={{ fontSize: 11 }}>{drive.session.sessionKey}</Code>
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
            disabled={Boolean(drive.session)}
            aria-label="Browser"
          />
          {drive.session ? (
            <>
              <Button
                size="xs"
                variant="light"
                color="grape"
                leftSection={<IconArrowsSplit size={14} />}
                disabled={log.length === 0}
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
              loading={drive.starting}
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

          <ActionComposer
            draft={draft}
            onChange={setDraft}
            onSubmit={runStep}
            busy={drive.busy}
            disabled={!drive.session}
            submitLabel="Run step"
          />

          <div className={classes.panelHead}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Steps run {log.length > 0 ? `(${log.length})` : ''}
            </Text>
            {log.length > 0 ? (
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
        <StagePanel
          stage={stage}
          sessionKey={sessionKey}
          emptyHint="Start a session to see the page."
          onPickElement={(node) => {
            // Respond immediately with what the snapshot already knows, then
            // upgrade to a durable target once the page has been asked.
            setDraft((current) => ({
              ...current,
              target: {
                ref: node.ref,
                role: node.role,
                ...(node.name ? { name: node.name } : {}),
                ...(node.ambiguous ? { nth: node.nth } : {}),
              },
              type: actionForRole(node.role, current.type),
            }));
            if (!sessionKey) return;
            void targetForNode(sessionKey, node).then((target) => {
              setDraft((current) => (current.target.ref === node.ref ? { ...current, target } : current));
            });
          }}
        />
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
            <FormField label="Name" hint={`${log.length} step(s) run in this session.`}>
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
            into the flow. The draft opens in the flow editor, where you can parametrize the rest
            and declare what it returns.
          </Text>
        </FormSection>
      </FormShell>
    </div>
  );
}
