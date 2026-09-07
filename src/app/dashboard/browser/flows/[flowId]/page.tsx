'use client';

/**
 * Flow editor — the playground with a flow attached.
 *
 * The playground is for finding out what a page does; this is for turning
 * that into something that runs without you. Same three panes, because the
 * loop is the same one — look, act, see what happened — but here every action
 * has a second effect: it lands in the flow at the insertion point, with its
 * volatile `ref` stripped and, for anything you typed, the value lifted out
 * into an input rather than baked in.
 *
 * The left rail is the flow itself, in four views that are really four
 * questions: what does it do (Steps), what does it need (Inputs), what does
 * it give back (Output), and what happened when it ran (Runs). A test run
 * takes over the same panes it was authored in, which is the point: the thing
 * you watch failing is the thing you just built, in the place you built it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChevronLeft,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconX,
} from '@tabler/icons-react';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { BrowserFlowRunView, BrowserFlowView } from '@/lib/services/browser';
import type {
  IBrowserFlowInput,
  IBrowserFlowOutput,
  IBrowserFlowStep,
  IBrowserFlowStepResult,
} from '@/lib/database';
import ActionComposer from '../../_workbench/ActionComposer';
import StagePanel from '../../_workbench/StagePanel';
import {
  EMPTY_DRAFT,
  TARGETED,
  actionForRole,
  buildAction,
  describeTarget,
  targetForNode,
  targetsOnlyByRef,
  toDurableAction,
  type ActionDraft,
} from '../../_workbench/actions';
import type { SnapshotNode } from '../../_workbench/snapshot';
import { useDriveSession, useFillMain, useWorkbenchStage } from '../../_workbench/useWorkbench';
import classes from '../../_workbench/workbench.module.css';
import InputsPanel from './_components/InputsPanel';
import OutputPanel from './_components/OutputPanel';
import RunsPanel from './_components/RunsPanel';
import StepsPanel from './_components/StepsPanel';
import StepDialog, {
  EMPTY_STEP,
  draftToStep,
  stepToDraft,
  type StepDraft,
} from './_components/StepDialog';
import InputDialog, { EMPTY_INPUT } from './_components/InputDialog';
import OutputDialog, { EMPTY_OUTPUT } from './_components/OutputDialog';
import ParametrizeDialog, { applyToAction } from './_components/ParametrizeDialog';

/** A slug that is a valid identifier and not already taken. */
function uniqueName(base: string, taken: string[]): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
  const safe = /^[a-z_]/.test(slug) ? slug : `f_${slug}`;
  let candidate = safe;
  let n = 2;
  while (taken.includes(candidate)) {
    candidate = `${safe}_${n}`;
    n += 1;
  }
  return candidate;
}

/** Fields whose name suggests a credential, so the input defaults to `secret`. */
function looksSecret(action: Record<string, unknown>): boolean {
  const haystack = `${action.name ?? ''} ${action.label ?? ''} ${action.placeholder ?? ''} ${action.testId ?? ''}`
    .toLowerCase();
  return /pass|şifre|sifre|secret|token|otp|pin|cvv/.test(haystack);
}

export default function BrowserFlowEditorPage() {
  const router = useRouter();
  const params = useParams<{ flowId: string }>();
  const flowId = params?.flowId ?? '';
  const shell = useFillMain();

  const [flow, setFlow] = useState<BrowserFlowView | null>(null);
  const [runs, setRuns] = useState<BrowserFlowRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [tab, setTab] = useState('steps');
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<ActionDraft>(EMPTY_DRAFT);
  const [autoParam, setAutoParam] = useState(true);

  const [selectedRun, setSelectedRun] = useState<BrowserFlowRunView | null>(null);
  const [watchRunId, setWatchRunId] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  const [runStarting, setRunStarting] = useState(false);

  const [stepDialog, setStepDialog] = useState<{ open: boolean; index: number | null; initial: StepDraft }>(
    { open: false, index: null, initial: EMPTY_STEP },
  );
  const [inputDialog, setInputDialog] = useState<{ open: boolean; name: string | null; initial: IBrowserFlowInput }>(
    { open: false, name: null, initial: EMPTY_INPUT },
  );
  const [outputDialog, setOutputDialog] = useState<{ open: boolean; name: string | null; initial: IBrowserFlowOutput }>(
    { open: false, name: null, initial: EMPTY_OUTPUT },
  );
  const [paramIndex, setParamIndex] = useState<number | null>(null);
  /** Armed from the Output tab: the next element picked becomes an output. */
  const [pickForOutput, setPickForOutput] = useState(false);

  const [authorKey, setAuthorKey] = useState<string | undefined>(undefined);
  // ── The authoring session's position in the flow ──────────
  // Building a flow means getting the page to where the next step's element
  // exists. `executedThrough` is how far the live session has actually been
  // driven; `captures` carries what earlier steps read, so a later
  // `{{step.x}}` resolves the same way it will in a run.
  const [authValues, setAuthValues] = useState<Record<string, string>>({});
  const [authResults, setAuthResults] = useState<Array<IBrowserFlowStepResult | undefined>>([]);
  const [captures, setCaptures] = useState<Record<string, unknown>>({});
  const [executedThrough, setExecutedThrough] = useState(-1);
  const [replayingTo, setReplayingTo] = useState<number | null>(null);

  // A finished run's session is closed server-side, so the panes fall back to
  // whatever is being authored; a running or failed one is still open (a test
  // run always asks to keep it) and worth inspecting.
  const inspectable = Boolean(
    selectedRun && (selectedRun.status === 'running' || selectedRun.status === 'failed'),
  );
  const previewKey = inspectable ? selectedRun?.sessionKey : authorKey;
  const stage = useWorkbenchStage(previewKey, { paused: Boolean(selectedRun) && !watchRunId });

  const drive = useDriveSession({
    browserId: flow?.browserId ?? '',
    name: `flow-editor:${flow?.key ?? ''}`,
    stage,
  });

  // ── Loading and saving ────────────────────────────────────

  const loadRuns = useCallback(async () => {
    const res = await fetch(`/api/browser/flow-runs?flowId=${encodeURIComponent(flowId)}&limit=25`, { cache: 'no-store' });
    if (res.ok) setRuns((await res.json()).runs ?? []);
  }, [flowId]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/browser/flows/${flowId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Flow not found');
      const { flow: loaded } = await res.json();
      setFlow(loaded);
      setCursor(loaded.steps?.length ?? 0);
      await loadRuns();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load flow',
      });
    } finally {
      setLoading(false);
    }
  }, [flowId, loadRuns]);

  useEffect(() => { if (flowId) void load(); }, [flowId, load]);

  const patch = useCallback(async (body: Record<string, unknown>, message?: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/browser/flows/${flowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setFlow(data.flow);
      if (message) notifications.show({ color: 'teal', title: 'Saved', message });
      return data.flow as BrowserFlowView;
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not save',
        message: err instanceof Error ? err.message : 'Save failed',
      });
      return null;
    } finally {
      setSaving(false);
    }
  }, [flowId]);

  // ── Authoring ─────────────────────────────────────────────

  /** Everything about where the live session is. A new session knows nothing. */
  function forgetPosition() {
    setExecutedThrough(-1);
    setCaptures({});
    setAuthResults([]);
    setCursor(flow?.steps.length ?? 0);
  }

  async function startAuthoring() {
    const session = await drive.start();
    if (!session) return null;
    setAuthorKey(session.sessionKey);
    setSelectedRun(null);
    forgetPosition();
    return session.sessionKey;
  }

  async function endAuthoring() {
    await drive.end();
    setAuthorKey(undefined);
    forgetPosition();
  }

  /** A fresh session, so a replay starts from a page nothing has touched. */
  async function restartAuthoring() {
    await drive.end();
    setAuthorKey(undefined);
    return startAuthoring();
  }

  /**
   * Put the live session into the state after `index`.
   *
   * Forward is a continuation — it runs only the steps between where the
   * session already is and where you asked for, so a form is not submitted
   * twice on the way. Backward cannot be undone in a browser, so it restarts
   * the session and replays from the top; that is also what makes ▶ on step 1
   * mean "start over".
   */
  async function runThrough(index: number) {
    if (!flow || replayingTo != null) return;

    const backwards = index <= executedThrough;
    setReplayingTo(index);
    try {
      let sessionKey = authorKey;
      if (backwards || !sessionKey) {
        const key = await (sessionKey ? restartAuthoring() : startAuthoring());
        if (!key) return;
        sessionKey = key;
      }
      const from = backwards ? 0 : executedThrough + 1;
      const carried = backwards ? {} : captures;

      const res = await fetch(`/api/browser/flows/${flow.id}/steps/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionKey,
          from,
          to: index + 1,
          inputs: authValues,
          captures: carried,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not replay the steps');

      const results = (data.results ?? []) as IBrowserFlowStepResult[];
      setAuthResults((current) => {
        const next = backwards ? [] : [...current];
        for (const result of results) next[result.index] = result;
        return next;
      });
      setCaptures(data.captures ?? {});

      const failedAt = data.failedStepIndex as number | undefined;
      const reached = failedAt === undefined ? index : failedAt - 1;
      setExecutedThrough(reached);
      setCursor(reached + 1);
      await stage.refreshFrom(sessionKey);

      notifications.show({
        color: failedAt === undefined ? 'teal' : 'red',
        title: failedAt === undefined ? `At step ${index + 1}` : `Stopped at step ${failedAt + 1}`,
        message: failedAt === undefined
          ? `${results.length} step(s) replayed — the page is where step ${index + 2} begins.`
          : data.errorMessage ?? 'See the step for details',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Replay failed',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setReplayingTo(null);
    }
  }

  /**
   * Run the composed action against the authoring session, then append what
   * ran to the flow — as a durable step, with typed values lifted into inputs.
   */
  async function runAndRecord() {
    if (!flow) return;
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
    if (!outcome?.ok) return;

    const durable = toDurableAction(action);
    if (targetsOnlyByRef(durable)) {
      notifications.show({
        color: 'orange',
        title: 'Ran, but not recorded',
        message: 'That element is only addressable by its snapshot ref — nothing durable to store. Give it a testId or use a selector.',
      });
      return;
    }

    const inputs = [...(flow.inputs ?? [])];
    const step: IBrowserFlowStep = { id: '', action: durable };
    let note: string | undefined;

    // Anything typed becomes a parameter by default: a literal password in a
    // step is a credential in the flow document, and even a harmless value is
    // usually the thing the next run wants to change.
    if (autoParam && durable.type === 'type' && typeof durable.text === 'string'
      && durable.text.length > 0 && !durable.text.includes('{{')) {
      const name = uniqueName(
        String(durable.name ?? durable.label ?? durable.placeholder ?? durable.testId ?? 'value'),
        inputs.map((item) => item.name),
      );
      inputs.push({
        name,
        label: describeTarget(durable),
        type: looksSecret(durable) ? 'secret' : 'string',
        required: true,
        description: `Value typed into ${describeTarget(durable)} while authoring.`,
      });
      durable.text = `{{input.${name}}}`;
      note = `Stored as {{input.${name}}}`;
    }

    // A read is only useful if something can point at what it read.
    let captured: unknown;
    if (durable.type === 'extract') {
      const taken = (flow.steps ?? []).map((item) => item.captureAs).filter(Boolean) as string[];
      step.captureAs = uniqueName(
        String(durable.name ?? durable.label ?? durable.testId ?? 'value'),
        taken,
      );
      note = `Captured as {{step.${step.captureAs}}}`;
      const values = outcome.result.values;
      if (Array.isArray(values) && values.length > 0) {
        captured = values.length === 1 ? values[0] : values;
        note += ` — read “${String(values[0]).slice(0, 60)}”`;
      }
    }

    const steps = [...flow.steps];
    const at = Math.min(Math.max(cursor, 0), steps.length);
    steps.splice(at, 0, step);

    const saved = await patch({ steps, inputs });
    if (saved) {
      setCursor(at + 1);
      // This step did not just get written — it just RAN, in this session. If
      // it landed where the session already was, the session is now past it,
      // and the next ▶ must not replay it.
      if (at === executedThrough + 1) {
        setExecutedThrough(at);
        setAuthResults((current) => {
          const next = [...current];
          next[at] = {
            stepId: step.id,
            index: at,
            status: 'succeeded',
            attempts: 1,
            durationMs: outcome.durationMs,
          };
          return next;
        });
        if (step.captureAs && captured !== undefined) {
          setCaptures((current) => ({ ...current, [step.captureAs as string]: captured }));
        }
      }
      // The ref just consumed belongs to a snapshot that no longer describes
      // the page, so it must not address the next action.
      setDraft((current) => ({ ...current, target: {}, value: '' }));
      if (note) notifications.show({ color: 'teal', title: 'Step recorded', message: note });
    }
  }

  /**
   * Read an element straight into an output.
   *
   * Declaring what a flow returns used to mean three separate moves — add an
   * `extract` step, give it a capture name, then point an output at that name
   * — and the element you actually wanted was on screen the whole time. This
   * does all three from one click: read it live so you can see the value,
   * record the step, and open the output form already pointing at it.
   */
  async function captureElementAsOutput(node: SnapshotNode) {
    if (!flow || !authorKey) return;
    setPickForOutput(false);

    const target = await targetForNode(authorKey, node);
    const outcome = await drive.runAction({ type: 'extract', ...target });
    if (!outcome?.ok) return;

    const durable = toDurableAction({ type: 'extract', ...target });
    if (targetsOnlyByRef(durable)) {
      notifications.show({
        color: 'orange',
        title: 'Nothing durable to store',
        message: 'That element is only addressable by its snapshot ref. Give it a testId, or add the step by hand with a selector.',
      });
      return;
    }

    const name = uniqueName(
      String(node.name ?? durable.testId ?? node.role ?? 'value'),
      [...captureNames, ...outputs.map((item) => item.name)],
    );
    const step: IBrowserFlowStep = { id: '', action: durable, captureAs: name };
    const steps = [...flow.steps];
    const at = Math.min(Math.max(cursor, 0), steps.length);
    steps.splice(at, 0, step);

    const saved = await patch({ steps });
    if (!saved) return;
    setCursor(at + 1);
    if (at === executedThrough + 1) setExecutedThrough(at);

    const values = outcome.result.values;
    const read = Array.isArray(values) && values.length > 0 ? String(values[0]) : undefined;
    if (read !== undefined) setCaptures((current) => ({ ...current, [name]: read }));

    setTab('output');
    setOutputDialog({
      open: true,
      name: null,
      initial: {
        name,
        source: `{{step.${name}}}`,
        description: read ? `Read “${read.slice(0, 80)}” while authoring.` : undefined,
      },
    });
  }

  // ── Step / input / output edits ───────────────────────────

  const saveSteps = (steps: IBrowserFlowStep[], message?: string) => patch({ steps }, message);

  const moveStep = (index: number, delta: number) => {
    if (!flow) return;
    const next = [...flow.steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void saveSteps(next);
  };

  const removeStep = (index: number) => {
    if (!flow) return;
    void saveSteps(flow.steps.filter((_, i) => i !== index), 'Step removed');
  };

  const submitStep = (stepDraft: StepDraft) => {
    if (!flow) return;
    const steps = [...flow.steps];
    if (stepDialog.index === null) {
      const at = Math.min(Math.max(cursor, 0), steps.length);
      steps.splice(at, 0, draftToStep(stepDraft));
      setCursor(at + 1);
    } else {
      steps[stepDialog.index] = draftToStep(stepDraft, steps[stepDialog.index]);
    }
    void saveSteps(steps, stepDialog.index === null ? 'Step added' : 'Step saved')
      .then((ok) => { if (ok) setStepDialog({ open: false, index: null, initial: EMPTY_STEP }); });
  };

  const submitInput = (input: IBrowserFlowInput) => {
    if (!flow) return;
    const inputs = [...(flow.inputs ?? [])];
    const at = inputs.findIndex((item) => item.name === inputDialog.name);
    if (at >= 0) inputs[at] = input;
    else inputs.push(input);
    void patch({ inputs }, at >= 0 ? 'Input saved' : 'Input added')
      .then((ok) => { if (ok) setInputDialog({ open: false, name: null, initial: EMPTY_INPUT }); });
  };

  const submitOutput = (output: IBrowserFlowOutput) => {
    if (!flow) return;
    const outputs = [...(flow.outputs ?? [])];
    const at = outputs.findIndex((item) => item.name === outputDialog.name);
    if (at >= 0) outputs[at] = output;
    else outputs.push(output);
    void patch({ outputs }, at >= 0 ? 'Output saved' : 'Output added')
      .then((ok) => { if (ok) setOutputDialog({ open: false, name: null, initial: EMPTY_OUTPUT }); });
  };

  const submitParametrize = (change: { path: string; placeholder: string; newInput?: IBrowserFlowInput }) => {
    if (!flow || paramIndex === null) return;
    const steps = [...flow.steps];
    const step = steps[paramIndex];
    steps[paramIndex] = {
      ...step,
      action: applyToAction(step.action as Record<string, unknown>, change.path, change.placeholder),
    };
    const inputs = change.newInput ? [...(flow.inputs ?? []), change.newInput] : flow.inputs;
    void patch({ steps, inputs }, `Bound to ${change.placeholder}`)
      .then((ok) => { if (ok) setParamIndex(null); });
  };

  // ── Test runs ─────────────────────────────────────────────

  async function startRun() {
    if (!flow) return;
    setRunStarting(true);
    try {
      const res = await fetch(`/api/browser/flows/${flow.id}/run/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inputs: runValues,
          // A failed run's session is otherwise closed immediately, and the
          // whole point of watching it here is seeing the page it broke on.
          keepSessionOpen: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start the run');
      setRunOpen(false);
      setSelectedRun(data.run);
      setWatchRunId(data.run.id);
      setTab('steps');
      stage.reset();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not start run',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setRunStarting(false);
    }
  }

  // Poll the run while it is in progress. Each new step result refreshes the
  // preview and element list, so the run lands one step at a time rather than
  // appearing finished.
  const refreshFrom = stage.refreshFrom;
  const lastSteps = useRef(-1);
  useEffect(() => {
    if (!watchRunId) return;
    let cancelled = false;
    lastSteps.current = -1;

    const tick = async () => {
      const res = await fetch(`/api/browser/flow-runs/${watchRunId}`, { cache: 'no-store' });
      if (!res.ok || cancelled) return;
      const { run } = (await res.json()) as { run: BrowserFlowRunView };
      if (cancelled) return;
      setSelectedRun(run);

      const count = run.stepResults?.length ?? 0;
      if (run.sessionKey && count !== lastSteps.current) {
        lastSteps.current = count;
        await refreshFrom(run.sessionKey);
      }

      if (run.status !== 'running') {
        setWatchRunId(null);
        void loadRuns();
        notifications.show({
          color: run.status === 'succeeded' ? 'teal' : 'red',
          title: run.status === 'succeeded' ? 'Flow succeeded' : `Flow ${run.status}`,
          message: run.status === 'succeeded'
            ? `${run.stepResults?.length ?? 0} step(s) in ${run.durationMs ?? 0}ms`
            : run.errorMessage ?? 'See the step list for details',
        });
      }
    };

    const timer = setInterval(() => { void tick(); }, 800);
    void tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [watchRunId, refreshFrom, loadRuns]);

  // ── Derived ───────────────────────────────────────────────

  const captureNames = useMemo(
    () => (flow?.steps ?? []).map((step) => step.captureAs).filter(Boolean) as string[],
    [flow],
  );
  const inputNames = useMemo(() => (flow?.inputs ?? []).map((item) => item.name), [flow]);
  // Stable identities: these are props of components whose effects would
  // otherwise re-run on every render of this page.
  const inputs = useMemo(() => flow?.inputs ?? [], [flow]);
  const outputs = useMemo(() => flow?.outputs ?? [], [flow]);

  if (loading) {
    return <div style={{ padding: 24 }}><Text c="dimmed">Loading…</Text></div>;
  }
  if (!flow) {
    return <div style={{ padding: 24 }}><Text c="dimmed">Flow not found.</Text></div>;
  }

  const watching = Boolean(watchRunId);
  const showingRun = Boolean(selectedRun);

  return (
    <div ref={shell.ref} className={classes.shell} style={shell.style}>
      {/* ── Header ─────────────────────────────────────────── */}
      <header className={classes.header}>
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Tooltip label="All flows">
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label="All flows"
              onClick={() => router.push('/dashboard/browser/flows')}
            >
              <IconChevronLeft size={16} />
            </ActionIcon>
          </Tooltip>
          <IconRoute size={18} stroke={1.7} />
          <Text fw={600} size="sm" truncate>{flow.name}</Text>
          <Badge size="sm" variant="light" color="gray">v{flow.version}</Badge>
          {watching && selectedRun ? (
            <Badge size="sm" variant="light" color="blue" leftSection={<Loader size={9} color="blue" />}>
              running
            </Badge>
          ) : drive.session ? (
            <>
              <Badge size="sm" variant="light" color="teal">authoring</Badge>
              <Code style={{ fontSize: 11 }}>{drive.session.sessionKey}</Code>
            </>
          ) : null}
        </Group>

        <Group gap="xs" wrap="nowrap">
          <Select
            size="xs"
            w={120}
            value={flow.status}
            data={[
              { value: 'draft', label: 'Draft' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ]}
            onChange={(value) => value && patch({ status: value }, `Flow is now ${value}`)}
            aria-label="Flow status"
          />
          {drive.session ? (
            <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={endAuthoring}>
              End session
            </Button>
          ) : (
            <Button
              size="xs"
              variant="light"
              color="teal"
              loading={drive.starting}
              leftSection={<IconPlayerPlay size={14} />}
              onClick={startAuthoring}
            >
              Author live
            </Button>
          )}
          <Button
            size="xs"
            color="blue"
            loading={runStarting}
            disabled={flow.steps.length === 0 || watching}
            leftSection={<IconRoute size={14} />}
            onClick={() => {
              const seed: Record<string, string> = {};
              for (const item of flow.inputs ?? []) {
                // Whatever you have been authoring with is almost always what
                // you want to test with; the declared default is the fallback.
                seed[item.name] = authValues[item.name]
                  ?? (item.default === undefined ? '' : String(item.default));
              }
              setRunValues(seed);
              setRunOpen(true);
            }}
          >
            Test run
          </Button>
        </Group>
      </header>

      <div className={classes.body}>
        {/* ── Left: the flow ───────────────────────────────── */}
        <aside className={classes.left}>
          <div className={classes.rightHead}>
            <SegmentedControl
              size="xs"
              fullWidth
              value={tab}
              onChange={setTab}
              data={[
                { value: 'steps', label: `Steps (${flow.steps.length})` },
                { value: 'inputs', label: `Inputs (${flow.inputs?.length ?? 0})` },
                { value: 'output', label: `Output (${flow.outputs?.length ?? 0})` },
                { value: 'runs', label: 'Runs' },
              ]}
            />
          </div>

          {tab === 'steps' && drive.session ? (
            <>
              <div className={classes.panelHead}>
                <Text size="xs" fw={600} tt="uppercase" c="dimmed">Act, and record it</Text>
                <Switch
                  size="xs"
                  label="Parametrize typed values"
                  checked={autoParam}
                  onChange={(event) => setAutoParam(event.currentTarget.checked)}
                />
              </div>
              <ActionComposer
                draft={draft}
                onChange={setDraft}
                onSubmit={runAndRecord}
                busy={drive.busy || saving}
                disabled={!drive.session}
                submitLabel="Run & add step"
                hint={`Lands at position ${Math.min(cursor, flow.steps.length) + 1}.`}
              />
            </>
          ) : null}

          {tab === 'steps' ? (
            <div className={classes.panelHead}>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                Steps{showingRun ? ` · run ${selectedRun?.id.slice(0, 8)}` : ''}
              </Text>
              <Group gap={4}>
                {showingRun ? (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => { setSelectedRun(null); setWatchRunId(null); }}
                  >
                    Clear run
                  </Button>
                ) : null}
                {!showingRun && flow.steps.length > 0 ? (
                  <Tooltip label="Replay the whole flow into this session, leaving it open at the end">
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="teal"
                      loading={replayingTo != null}
                      leftSection={<IconPlayerPlay size={12} />}
                      onClick={() => runThrough(flow.steps.length - 1)}
                    >
                      Replay all
                    </Button>
                  </Tooltip>
                ) : null}
                {!showingRun && drive.session && executedThrough >= 0 ? (
                  <Tooltip label="Throw this session away and start from a blank page">
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<IconRefresh size={12} />}
                      onClick={() => { void restartAuthoring(); }}
                    >
                      Reset
                    </Button>
                  </Tooltip>
                ) : null}
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconPlus size={12} />}
                  onClick={() => setStepDialog({ open: true, index: null, initial: EMPTY_STEP })}
                >
                  Add
                </Button>
              </Group>
            </div>
          ) : null}

          <ScrollArea className={classes.logScroll}>
            {tab === 'steps' ? (
              <StepsPanel
                steps={flow.steps}
                results={showingRun ? selectedRun?.stepResults : (authResults.length > 0 ? authResults : undefined)}
                running={watching}
                onRunTo={showingRun ? undefined : runThrough}
                executedThrough={showingRun ? -1 : executedThrough}
                replayingTo={replayingTo}
                cursor={cursor}
                onCursor={setCursor}
                onMove={moveStep}
                onRemove={removeStep}
                onEdit={(index) => setStepDialog({
                  open: true,
                  index,
                  initial: stepToDraft(flow.steps[index]),
                })}
                onParametrize={setParamIndex}
                saving={saving}
              />
            ) : null}

            {tab === 'inputs' ? (
              <InputsPanel
                inputs={inputs}
                steps={flow.steps}
                values={authValues}
                onValue={(name, value) => setAuthValues((current) => ({ ...current, [name]: value }))}
                saving={saving}
                onAdd={() => setInputDialog({ open: true, name: null, initial: EMPTY_INPUT })}
                onEdit={(name) => setInputDialog({
                  open: true,
                  name,
                  initial: inputs.find((item) => item.name === name) ?? EMPTY_INPUT,
                })}
                onDeclare={(name) => setInputDialog({
                  open: true,
                  name: null,
                  initial: { ...EMPTY_INPUT, name },
                })}
                onRemove={(name) => patch(
                  { inputs: inputs.filter((item) => item.name !== name) },
                  'Input removed',
                )}
              />
            ) : null}

            {tab === 'output' ? (
              <OutputPanel
                outputs={outputs}
                captureNames={captureNames}
                run={selectedRun ?? runs[0] ?? null}
                saving={saving}
                picking={pickForOutput}
                onPickFromPage={drive.session ? () => setPickForOutput((armed) => !armed) : undefined}
                onAdd={() => setOutputDialog({ open: true, name: null, initial: EMPTY_OUTPUT })}
                onEdit={(name) => setOutputDialog({
                  open: true,
                  name,
                  initial: outputs.find((item) => item.name === name) ?? EMPTY_OUTPUT,
                })}
                onRemove={(name) => patch(
                  { outputs: outputs.filter((item) => item.name !== name) },
                  'Output removed',
                )}
              />
            ) : null}

            {tab === 'runs' ? (
              <RunsPanel
                runs={runs}
                selectedId={selectedRun?.id}
                onSelect={(run) => { setSelectedRun(run); setTab('steps'); }}
              />
            ) : null}
          </ScrollArea>
        </aside>

        {/* ── Right: the page ──────────────────────────────── */}
        <StagePanel
          stage={stage}
          sessionKey={previewKey}
          emptyHint={
            showingRun
              ? 'That run has finished and its session is closed.'
              : 'Start an authoring session, or run the flow, to see the page.'
          }
          pickHint={pickForOutput
            ? 'Pick the element to read — it becomes a step and an output field.'
            : undefined}
          onPickElement={drive.session ? (node) => {
            if (pickForOutput) {
              void captureElementAsOutput(node);
              return;
            }
            // Respond immediately with what the snapshot knows, then upgrade
            // to a durable target once the page has been asked.
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
            if (!authorKey) return;
            void targetForNode(authorKey, node).then((target) => {
              setDraft((current) => (current.target.ref === node.ref ? { ...current, target } : current));
            });
          } : undefined}
        />
      </div>

      <StepDialog
        open={stepDialog.open}
        initial={stepDialog.initial}
        editing={stepDialog.index !== null}
        saving={saving}
        onClose={() => setStepDialog({ open: false, index: null, initial: EMPTY_STEP })}
        onSubmit={submitStep}
      />

      <InputDialog
        open={inputDialog.open}
        initial={inputDialog.initial}
        editing={inputDialog.name !== null}
        saving={saving}
        onClose={() => setInputDialog({ open: false, name: null, initial: EMPTY_INPUT })}
        onSubmit={submitInput}
      />

      <OutputDialog
        open={outputDialog.open}
        initial={outputDialog.initial}
        editing={outputDialog.name !== null}
        saving={saving}
        captureNames={captureNames}
        inputNames={inputNames}
        onClose={() => setOutputDialog({ open: false, name: null, initial: EMPTY_OUTPUT })}
        onSubmit={submitOutput}
      />

      <ParametrizeDialog
        open={paramIndex !== null}
        step={paramIndex === null ? null : flow.steps[paramIndex]}
        inputs={inputs}
        saving={saving}
        onClose={() => setParamIndex(null)}
        onSubmit={submitParametrize}
      />

      <FormShell
        open={runOpen}
        onClose={() => setRunOpen(false)}
        title={`Test ${flow.name}`}
        subtitle="Runs in its own fresh session, shown here step by step as it goes."
        icon={<IconRoute size={18} stroke={1.7} />}
        primaryAction={{ label: 'Run now', color: 'blue', loading: runStarting, onClick: startRun }}
        secondaryAction={{ label: 'Cancel', onClick: () => setRunOpen(false) }}
      >
        <FormSection title="Inputs">
          {(flow.inputs?.length ?? 0) === 0 ? (
            <Text size="sm" c="dimmed">This flow takes no inputs.</Text>
          ) : (
            flow.inputs?.map((item) => (
              <FormRow key={item.name} cols={1}>
                <FormField
                  label={item.label || item.name}
                  required={item.required}
                  hint={item.description}
                >
                  <TextInput
                    type={item.type === 'secret' ? 'password' : 'text'}
                    placeholder={item.type === 'secret' ? 'Supplied per run, never stored' : undefined}
                    value={runValues[item.name] ?? ''}
                    onChange={(event) => {
                      // Read the value HERE, not inside the updater: React
                      // runs a functional update during the next render, by
                      // which time the synthetic event's `currentTarget` is
                      // null — and reading `.value` off it throws inside
                      // render, which the dashboard's error boundary turns
                      // into "Dashboard could not be loaded".
                      const value = event.currentTarget.value;
                      setRunValues((values) => ({ ...values, [item.name]: value }));
                    }}
                  />
                </FormField>
              </FormRow>
            ))
          )}
        </FormSection>
        {(flow.outputs?.length ?? 0) > 0 ? (
          <FormSection title="Returns">
            <Text size="xs" c="dimmed">
              {(flow.outputs ?? []).map((item) => item.name).join(', ')}
            </Text>
          </FormSection>
        ) : null}
      </FormShell>
    </div>
  );
}
