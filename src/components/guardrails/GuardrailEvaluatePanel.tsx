'use client';

/**
 * The guardrail Test panel.
 *
 * ── WHAT CHANGED AND WHY ──────────────────────────────────────────────────
 * This panel used to POST plain text to `/guardrails/evaluate`, which reaches
 * exactly one of five hooks and one of nine policy families' worth of subject
 * shapes. A tool-argument policy, a stream gate and a tool-result scan were
 * all unreachable from the only screen an operator has for asking "what does
 * this guardrail actually do?". It now speaks the hook plane directly:
 * `POST /api/guardrails/:key/hooks/:hook`, one sub-mode per subject kind.
 *
 * ── THE THREE THINGS THIS SCREEN MUST NOT DO ──────────────────────────────
 * 1. Show a control the API cannot honour. `readHookEvaluationOptions` accepts
 *    `only`, `shadow`, `budget_ms` and `request_id` — and nothing else. There
 *    is no mode override on the wire, so this panel does not draw one; it
 *    reports the guardrail's own posture and always shows `would_be_decision`
 *    beside `decision`, which is the information an override was for.
 * 2. Let a policy that DID NOT RUN look like a policy that found nothing. The
 *    verdict says nothing about which policies were dispatched, so the run plan
 *    is derived from the compiled config with the engine's own rules
 *    (`testPanelHelpers.planPolicies` / `summarizeRun`) and every row says which
 *    it was.
 * 3. ASK THE OPERATOR WHAT THE GUARDRAIL ALREADY DECLARES. This panel used to
 *    open with a Hook select and a policy multi-select as its two primary
 *    controls. Both were wired, so neither was dead — and both were the wrong
 *    question. The guardrail already says which hooks it binds and which
 *    policies run on each of them; asking again lets someone run a configuration
 *    that is not the one production will run, and a test panel whose verdict
 *    does not correspond to deployed behaviour is worse than no test panel.
 *
 * ── WHAT REPLACED THEM ────────────────────────────────────────────────────
 * The default is now "run this guardrail exactly as configured". The one thing
 * that genuinely cannot be inferred is the SUBJECT KIND — you cannot test a
 * tool call by typing a sentence — so the sub-mode stays and the HOOK follows
 * from it (`resolveModeHook`). Three sub-modes admit exactly one hook and say
 * so; the two text-shaped ones admit three, so the panel picks the earliest one
 * the guardrail actually serves, says which and why beside the input, and lets
 * it be changed THERE rather than from a control detached from the subject.
 *
 * Narrowing survives as a debug affordance behind a closed disclosure, and any
 * run that departs from production carries a banner saying so — on the controls
 * AND on the result, because the result is what gets screenshotted into a
 * ticket. Isolating one rule is useful; doing it silently is the problem.
 *
 * ── WHERE THE CONFIG COMES FROM ───────────────────────────────────────────
 * `GET /guardrails/:key/compiled`, fetched here rather than taken as a prop.
 * That endpoint has already run `ensureHooks`, so a LEGACY row (no `hooks`
 * column) arrives lifted and its `legacy:*` policies appear in the plan like any
 * other. It is also the SAVED config, which is the only one the server will
 * evaluate against — handing this panel the Config tab's unsaved draft would
 * make it describe a policy that does not exist yet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Collapse,
  Divider,
  FileButton,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleOff,
  IconClock,
  IconFileUpload,
  IconFilter,
  IconFlask,
  IconInfoCircle,
  IconLayoutRows,
  IconMessageReport,
  IconPlayerPlay,
  IconPlayerTrackNext,
  IconScissors,
  IconX,
} from '@tabler/icons-react';
import type {
  PolicyFamily,
  GuardrailHooksConfig,
  GuardrailMode,
  HookId,
  SafetyFinding,
} from '@/lib/services/guardrail/hooks/contract';
import {
  SKIP_REASON_TEXT,
  TEXT_SAMPLES,
  absoluteFindings,
  assignPolicyColors,
  blockMessageGap,
  buildOverlay,
  buildRequestBody,
  chunkText,
  describeDecision,
  describeNarrowing,
  describeShape,
  messageSource,
  parseBatchInput,
  parseToolArgs,
  parseToolResult,
  planPolicies,
  planStreamWindow,
  readHookVerdict,
  resolveModeHook,
  resolveStreamPlan,
  spliceWindowRedaction,
  subjectSegments,
  summarizeBatch,
  summarizeRun,
} from './testPanelHelpers';
import type {
  BatchOutcome,
  GuardrailShape,
  ModeHook,
  NarrowedRun,
  PolicyOutcomeRow,
  PolicyStatus,
  HookVerdictResponse,
  StreamWindow,
  TestMode,
  TestSubject,
} from './testPanelHelpers';

// ═══════════════════════════════════════════════════════════════════════════
// Props
// ═══════════════════════════════════════════════════════════════════════════

export interface GuardrailEvaluatePanelProps {
  /** The record's `key`, NOT its id: every hook-plane route is keyed by it. */
  guardrailKey: string;
  guardrailName: string;
  /**
   * The record-level posture, if the caller already has it. Optional and
   * advisory: `/compiled` reports the same thing and is authoritative, since
   * an unsaved change on the Configuration tab is not what the server runs.
   */
  mode?: GuardrailMode;
}

// ═══════════════════════════════════════════════════════════════════════════
// Small presentational pieces
// ═══════════════════════════════════════════════════════════════════════════

const HOOK_LABEL: Readonly<Record<HookId, string>> = {
  'prompt.pre': 'prompt.pre — the user turn, once per run',
  'input.pre': 'input.pre — before every model call',
  'output.pre': 'output.pre — before the answer goes out',
  'output.stream.delta': 'output.stream.delta — each streamed window',
  'tool.pre': 'tool.pre — before a tool runs',
  'tool.post': 'tool.post — after a tool returns',
};

const SEVERITY_COLOR: Readonly<Record<string, string>> = {
  high: 'red',
  medium: 'orange',
  low: 'yellow',
};

const STATUS_COLOR: Readonly<Record<PolicyStatus, string>> = {
  findings: 'red',
  clean: 'teal',
  degraded: 'orange',
  skipped: 'gray',
  'short-circuited': 'gray',
  gated: 'gray',
  unknown: 'gray',
};

const STATUS_LABEL: Readonly<Record<PolicyStatus, string>> = {
  findings: 'found',
  clean: 'ran, clean',
  degraded: 'could not run',
  skipped: 'did not run',
  'short-circuited': 'did not run',
  gated: 'did not run',
  unknown: 'unclear',
};

function SectionHeader({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <ThemeIcon size={30} radius="md" variant="light" color="gray">
        {icon}
      </ThemeIcon>
      <div>
        <Text fw={600} size="sm">
          {title}
        </Text>
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      </div>
    </Group>
  );
}

/**
 * WHICH HOOK, and why that one — beside the subject rather than above it.
 *
 * The hook is a property of the subject, so the place to say which one is
 * carrying it is next to the box the subject is typed into. For the three
 * sub-modes that admit exactly one hook this is a sentence and nothing more:
 * there is no decision to offer, and offering one anyway is what made the old
 * top-level select read as a setting.
 */
function HookNote({
  modeHook,
  onChange,
}: {
  modeHook: ModeHook;
  onChange: (hook: HookId | null) => void;
}) {
  const { hook, offers, fixed, chosen, served, reason } = modeHook;

  return (
    <Alert
      variant="light"
      color={served ? 'gray' : 'yellow'}
      p="xs"
      icon={served ? <IconArrowRight size={15} /> : <IconCircleOff size={15} />}
    >
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <div style={{ flex: 1, minWidth: 240 }}>
          <Text size="xs" fw={600}>
            Adjudicated at <Code fz={11}>{hook}</Code>
          </Text>
          <Text size="xs" c="dimmed">
            {reason}
          </Text>
          {chosen && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              mt={4}
              onClick={() => onChange(null)}
            >
              Back to the hook this guardrail serves
            </Button>
          )}
        </div>
        {!fixed && (
          <Select
            size="xs"
            w={320}
            aria-label="Which hook carries this subject"
            value={hook}
            data={offers.map((offer) => ({
              value: offer.hook,
              label: `${HOOK_LABEL[offer.hook]} · ${
                offer.served ? `${offer.runs} run here` : 'nothing runs here'
              }`,
            }))}
            onChange={(value) => onChange(value ? (value as HookId) : null)}
            allowDeselect={false}
          />
        )}
      </Group>
    </Alert>
  );
}

/**
 * THE BANNER. Isolating one rule is a legitimate thing to do and a dangerous
 * thing to forget you did, so every run and every result carries the difference
 * between what ran and what production runs.
 *
 * It distinguishes a filter that CHANGES the run from one that happens to
 * exclude nothing: a banner that shouts at a run which is in fact production is
 * a banner operators learn to skip, and it has to still work the day it matters.
 */
function NarrowedBanner({ narrowing, past }: { narrowing: NarrowedRun; past?: boolean }) {
  if (!narrowing.narrowed || narrowing.banner === null) return null;
  return (
    <Alert
      color={narrowing.differs ? 'red' : 'gray'}
      variant="light"
      p="xs"
      icon={<IconFilter size={16} />}
    >
      <Text size="xs" fw={700}>
        {narrowing.differs
          ? past
            ? 'This result is NOT what production would do'
            : 'This run will NOT be what production does'
          : 'A policy filter is set'}
      </Text>
      <Text size="xs">{narrowing.banner}</Text>
    </Alert>
  );
}

/**
 * The guardrail's own shape, for the hook in play.
 *
 * An operator should not have to hold the configuration in their head to read a
 * verdict, and the rule the result table obeys holds here too: A POLICY THAT
 * WILL BE SKIPPED IS LISTED WITH THE REASON, never merely absent. That is the
 * whole point of this card — "it ran and found nothing" and "it never ran" look
 * identical in a verdict, and the second one is the answer to almost every
 * "the guardrail says clean but it should have caught this".
 *
 * One flat list, in the order the engine reaches them: `describeShape` puts the
 * deterministic policies first, in stored order, then the model-backed and
 * webhook ones. Nothing else about the order is configurable, so nothing else
 * is drawn.
 */
function ShapeCard({
  shape,
  hook,
  narrowed,
}: {
  shape: GuardrailShape;
  hook: HookId;
  narrowed: boolean;
}) {
  const [open, setOpen] = useState(true);

  if (shape.total === 0) {
    return (
      <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
        This guardrail has no policies, so nothing can run on <Code fz={11}>{hook}</Code> or
        anywhere else.
      </Alert>
    );
  }

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <SectionHeader
            icon={<IconLayoutRows size={16} />}
            title="What will run"
            description={`${shape.runs} of ${shape.total} polic${
              shape.total === 1 ? 'y' : 'ies'
            } on ${hook}, in this order. ${
              shape.stopsOnBlock
                ? 'A blocking finding from a sync policy stops everything below it.'
                : 'shortCircuit is off, so every one of them runs whatever the ones above found.'
            }`}
          />
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        </Group>

        <Collapse in={open}>
          <Stack gap="xs">
            {narrowed && (
              <Text size="xs" c="red">
                A policy filter is on, so this is the FILTERED run — the rows marked “excluded by the
                policy filter” would run in production.
              </Text>
            )}
            <Paper withBorder radius="sm" p="xs">
              <Stack gap={4}>
                {shape.rows.map((row) => (
                  <Group key={row.policyId} gap={8} wrap="nowrap" align="flex-start">
                    <Box
                      style={{
                        width: 8,
                        height: 8,
                        marginTop: 5,
                        borderRadius: 2,
                        flexShrink: 0,
                        background: row.willRun
                          ? 'var(--mantine-color-teal-filled)'
                          : 'var(--mantine-color-gray-4)',
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <Group gap={6}>
                        <Text size="xs" fw={500} c={row.willRun ? undefined : 'dimmed'}>
                          {row.label}
                        </Text>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {row.family}
                        </Text>
                        {/* The one ordering fact that is NOT the stored order:
                            a remote call waits for the whole local pass and
                            then starts alongside the other remote ones. */}
                        {row.willRun && !row.deterministic && (
                          <Tooltip
                            multiline
                            w={280}
                            label="It calls out of this process, so the engine runs it after the whole local pass — together with every other model or webhook policy."
                          >
                            <Badge size="xs" variant="outline" color="gray">
                              last, together
                            </Badge>
                          </Tooltip>
                        )}
                        {row.willRun && !row.sync && (
                          <Badge size="xs" variant="outline" color="gray">
                            async
                          </Badge>
                        )}
                      </Group>
                      {/* Never blank for a policy that will not run: an
                          unexplained absence is the exact confusion this
                          screen exists to remove. */}
                      {!row.willRun && (
                        <Text size="xs" c="dimmed">
                          will not run — {SKIP_REASON_TEXT[row.skipReason ?? 'policy-disabled']}
                        </Text>
                      )}
                      {row.willRun && row.gateNote && (
                        <Text size="xs" c={row.gateUnmeetable ? 'orange' : 'dimmed'}>
                          {row.gateNote}
                        </Text>
                      )}
                    </div>
                  </Group>
                ))}
              </Stack>
            </Paper>
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}

/**
 * Findings drawn ON the text they matched.
 *
 * Colour is keyed to the POLICY, not the family — two regex policies are the
 * whole reason the config model changed, and they have to be distinguishable
 * right here. Overlapping spans are shown with a doubled underline rather than
 * one colour winning, because "both of these matched the same characters" is
 * a thing an operator is specifically trying to see.
 */
function SpanOverlay({
  segments,
  findings,
  colors,
}: {
  segments: ReadonlyArray<{ path: string; text: string }>;
  findings: readonly SafetyFinding[];
  colors: Record<string, string>;
}) {
  const overlay = useMemo(() => buildOverlay(segments, findings), [segments, findings]);
  const multiSegment = segments.length > 1;

  return (
    <Stack gap="xs">
      {overlay.segments.map((segment) => (
        <div key={segment.path}>
          {multiSegment && (
            <Text size="xs" c="dimmed" ff="monospace" mb={2}>
              {segment.path}
            </Text>
          )}
          <Box
            style={{
              fontFamily: 'var(--mantine-font-family-monospace)',
              fontSize: 12,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {segment.runs.length === 0 ? (
              <Text size="xs" c="dimmed" fs="italic">
                (empty)
              </Text>
            ) : (
              segment.runs.map((run, i) => {
                if (run.findings.length === 0) return <span key={i}>{run.text}</span>;
                const owners = run.findings
                  .map((index) => findings[index])
                  .filter((f): f is SafetyFinding => f !== undefined);
                const color = colors[owners[0]?.policyId ?? ''] ?? 'red';
                return (
                  <Tooltip
                    key={i}
                    multiline
                    w={280}
                    withArrow
                    label={owners
                      .map((f) => `${f.policyId} · ${f.category} · ${f.severity}`)
                      .join('\n')}
                  >
                    <Box
                      component="span"
                      style={{
                        background: `var(--mantine-color-${color}-light)`,
                        color: `var(--mantine-color-${color}-light-color)`,
                        borderRadius: 3,
                        padding: '1px 2px',
                        borderBottom:
                          owners.length > 1
                            ? `3px double var(--mantine-color-${color}-filled)`
                            : `2px solid var(--mantine-color-${color}-filled)`,
                      }}
                    >
                      {run.text}
                    </Box>
                  </Tooltip>
                );
              })
            )}
          </Box>
        </div>
      ))}

      {overlay.unpositioned.length > 0 && (
        <Alert color="gray" variant="light" p="xs" icon={<IconInfoCircle size={15} />}>
          <Text size="xs" fw={500}>
            {overlay.unpositioned.length} finding
            {overlay.unpositioned.length === 1 ? '' : 's'} carry no offsets
          </Text>
          <Text size="xs" c="dimmed">
            Only pii, secrets and regex report spans, and even inside pii the obfuscation pass
            scans a normalised string of a different length — so its matches cannot be pointed at
            a place in the original text. They are listed below instead.
          </Text>
        </Alert>
      )}

      {overlay.dropped.length > 0 && (
        <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={15} />}>
          <Text size="xs" fw={500}>
            {overlay.dropped.length} span could not be placed
          </Text>
          {overlay.dropped.map((entry) => (
            <Text key={entry.index} size="xs" c="dimmed">
              {findings[entry.index]?.policyId ?? `#${entry.index}`}: {entry.reason}
            </Text>
          ))}
        </Alert>
      )}
    </Stack>
  );
}

function FindingCard({ finding, color }: { finding: SafetyFinding; color: string }) {
  return (
    <Paper withBorder radius="md" p="xs">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap={6} wrap="nowrap">
          <Box
            style={{
              width: 3,
              alignSelf: 'stretch',
              borderRadius: 2,
              background: `var(--mantine-color-${color}-filled)`,
            }}
          />
          <div>
            <Group gap={6}>
              <Text size="sm" fw={600}>
                {finding.policyId}
              </Text>
              <Badge size="xs" variant="default">
                {finding.family}
              </Badge>
              <Badge size="xs" color={SEVERITY_COLOR[finding.severity] ?? 'gray'}>
                {finding.severity}
              </Badge>
              {finding.critical && (
                <Badge size="xs" color="red" variant="filled">
                  critical
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" mt={2}>
              {finding.category}
              {finding.code ? ` · ${finding.code}` : ''}
              {finding.path ? ` · ${finding.path}` : ''}
              {finding.span ? ` · ${finding.span.start}–${finding.span.end}` : ' · no span'}
            </Text>
            <Text size="xs" mt={4}>
              {finding.message}
            </Text>
          </div>
        </Group>
        <Badge size="xs" variant="light" color={finding.block ? 'red' : 'orange'}>
          {finding.block ? 'blocking' : finding.action}
        </Badge>
      </Group>
    </Paper>
  );
}

/**
 * The per-policy breakdown.
 *
 * The wireframe asks for a millisecond figure per policy. `HookVerdict` carries
 * ONE `latencyMs` for the whole hook and no per-policy timing at all, so this
 * table reports what a policy DID instead of inventing what it cost — and says
 * where the one number that does exist came from.
 */
function PolicyBreakdown({
  rows,
  latencyMs,
  latencyScope,
  colors,
}: {
  rows: readonly PolicyOutcomeRow[];
  latencyMs: number;
  /** What the one number covers — one hook call, or a whole streamed run. */
  latencyScope: string;
  colors: Record<string, string>;
}) {
  if (rows.length === 0) {
    return (
      <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
        This guardrail has no policies configured, so nothing could run.
      </Alert>
    );
  }

  return (
    <Stack gap="xs">
      <ScrollArea type="auto">
        <Table highlightOnHover verticalSpacing={6} fz="xs" miw={520}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Policy</Table.Th>
              <Table.Th w={110}>Family</Table.Th>
              <Table.Th w={110}>Outcome</Table.Th>
              <Table.Th>Why</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.policyId} opacity={row.status === 'skipped' ? 0.65 : 1}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Box
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        flexShrink: 0,
                        background: row.findingIndexes.length
                          ? `var(--mantine-color-${colors[row.policyId] ?? 'gray'}-filled)`
                          : 'var(--mantine-color-gray-4)',
                      }}
                    />
                    <Text size="xs" fw={500}>
                      {row.label}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {row.family}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="light" color={STATUS_COLOR[row.status]}>
                    {STATUS_LABEL[row.status]}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {row.detail}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Text size="xs" c="dimmed">
        <IconClock size={11} style={{ verticalAlign: -1 }} /> {latencyMs} ms {latencyScope}. The
        verdict carries one total, not a figure per policy, so none is shown — and “ran, clean” is
        an inference from “this policy was dispatched and reported nothing”, not something the
        server states.
      </Text>
    </Stack>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// The panel
// ═══════════════════════════════════════════════════════════════════════════

interface CompiledConfig {
  hooks: GuardrailHooksConfig | null;
  mode: GuardrailMode;
  /** 0 means the config was DERIVED from the legacy columns on read. */
  hooksVersion: number;
  enabled: boolean;
}

export default function GuardrailEvaluatePanel({
  guardrailKey,
  guardrailName,
  mode: modeHint,
}: GuardrailEvaluatePanelProps) {
  // ── the compiled policy ──
  const [compiled, setCompiled] = useState<CompiledConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // ── controls ──
  const [testMode, setTestMode] = useState<TestMode>('text');
  /**
   * `null` = let the guardrail's own bindings decide, which is the default and
   * the whole point. Only ever set by the chooser that sits WITH the subject,
   * and only reachable for a sub-mode whose subject several hooks can carry.
   */
  const [hookOverride, setHookOverride] = useState<HookId | null>(null);
  const [selectedPolicyIds, setSelectedPolicyIds] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [record, setRecord] = useState(false);

  const [text, setText] = useState(TEXT_SAMPLES[0]?.text ?? '');
  const [toolName, setToolName] = useState('');
  const [toolArgs, setToolArgs] = useState('{\n  "url": "https://admin.acme.internal/ops"\n}');
  const [toolResult, setToolResult] = useState('{\n  "body": "ok"\n}');
  const [streamText, setStreamText] = useState(TEXT_SAMPLES[0]?.text ?? '');
  const [chunkSize, setChunkSize] = useState<number>(24);
  const [batchInput, setBatchInput] = useState('');

  // ── results ──
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<HookVerdictResponse | null>(null);
  const [ranSubject, setRanSubject] = useState<TestSubject | null>(null);
  const [ranOnly, setRanOnly] = useState<readonly PolicyFamily[]>([]);
  /** The narrowing THIS result was produced under, captured at run time — the
   *  banner has to describe the run that is on screen, not the controls as they
   *  stand now. */
  const [ranNarrowing, setRanNarrowing] = useState<NarrowedRun | null>(null);
  const [streamRun, setStreamRun] = useState<StreamTrace | null>(null);
  const [batchOutcomes, setBatchOutcomes] = useState<BatchOutcome[] | null>(null);
  const [batchProgress, setBatchProgress] = useState(0);
  const cancelBatch = useRef(false);

  const hooks = compiled?.hooks ?? null;
  const policies = useMemo(() => hooks?.policies ?? [], [hooks]);
  const effectiveMode: GuardrailMode = compiled?.mode ?? modeHint ?? 'enforce';

  /** WHICH HOOK, derived from the subject kind rather than asked for. */
  const modeHook: ModeHook = useMemo(
    () =>
      resolveModeHook({
        mode: testMode,
        hooks,
        guardrailMode: effectiveMode,
        preferred: hookOverride,
      }),
    [testMode, hooks, effectiveMode, hookOverride],
  );
  const hook = modeHook.hook;

  /** What production runs on this hook: no filter, by construction. Everything
   *  the narrowing banner says is the difference between this and the run. */
  const productionPlan = useMemo(
    () => planPolicies({ hooks, hook, mode: effectiveMode }),
    [hooks, hook, effectiveMode],
  );

  const narrowing = useMemo(
    () => describeNarrowing({ policies, selectedPolicyIds, plan: productionPlan }),
    [policies, selectedPolicyIds, productionPlan],
  );

  const shape = useMemo(
    () => describeShape({ hooks, hook, mode: effectiveMode, only: narrowing.families }),
    [hooks, hook, effectiveMode, narrowing.families],
  );

  // ── load the compiled policy ──
  useEffect(() => {
    let cancelled = false;
    setLoadingConfig(true);
    fetch(`/api/guardrails/${encodeURIComponent(guardrailKey)}/compiled`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`compiled policy unavailable (${res.status})`);
        return (await res.json()) as {
          hooks?: GuardrailHooksConfig;
          guardrail?: { mode?: GuardrailMode | null; hooksVersion?: number; enabled?: boolean };
        };
      })
      .then((data) => {
        if (cancelled) return;
        const enabled = data.guardrail?.enabled !== false;
        setCompiled({
          hooks: data.hooks ?? null,
          // The same fold `toGuardrailMode` applies: a disabled record is
          // 'disabled' whatever its mode column says.
          mode: !enabled ? 'disabled' : (data.guardrail?.mode ?? 'enforce'),
          hooksVersion: data.guardrail?.hooksVersion ?? 0,
          enabled,
        });
        setConfigError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Not fatal: the panel can still POST a hook and render the verdict.
        // Only the derived run plan is lost, and it says so rather than
        // showing an empty table that reads as "no policies".
        setConfigError(err instanceof Error ? err.message : 'Could not load the compiled policy');
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guardrailKey]);

  /**
   * ONE hook per request, and it is the resolved one.
   *
   * The old signature worked the hook out again from `subject.kind` plus the
   * Hook select, which is a second derivation of a question `resolveModeHook`
   * now answers — and the two could disagree the moment either changed. The
   * caller passes what the screen is showing.
   */
  const post = useCallback(
    async (
      subject: TestSubject,
      families: readonly PolicyFamily[],
      target: HookId,
    ): Promise<HookVerdictResponse> => {
      const res = await fetch(
        `/api/guardrails/${encodeURIComponent(guardrailKey)}/hooks/${encodeURIComponent(target)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildRequestBody(subject, { only: families, shadow: !record }),
          ),
        },
      );
      const data: unknown = await res.json().catch(() => null);
      const parsed = readHookVerdict(data);
      if (!parsed) {
        const message =
          data && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : `Evaluation failed (${res.status})`;
        throw new Error(message);
      }
      return parsed;
    },
    [guardrailKey, record],
  );

  const resetResults = () => {
    setError(null);
    setVerdict(null);
    setRanSubject(null);
    setStreamRun(null);
    setBatchOutcomes(null);
    setRanNarrowing(null);
  };

  // ── single-shot run (text / tool call / tool result) ──
  const buildSubject = (): TestSubject | string => {
    if (testMode === 'text') {
      if (!text.trim()) return 'Enter some text to evaluate.';
      return { kind: 'text', text };
    }
    if (!toolName.trim()) return 'A tool name is required — it is what tool_access matches on.';
    const parsedArgs = parseToolArgs(toolArgs);
    if (parsedArgs.error) return `tool_args: ${parsedArgs.error}`;
    if (testMode === 'tool_call') {
      return { kind: 'tool_call', toolName: toolName.trim(), args: parsedArgs.args ?? {} };
    }
    return {
      kind: 'tool_result',
      toolName: toolName.trim(),
      args: parsedArgs.args ?? {},
      result: parseToolResult(toolResult),
    };
  };

  const runSingle = async () => {
    const subject = buildSubject();
    if (typeof subject === 'string') {
      setError(subject);
      return;
    }
    resetResults();
    setRunning(true);
    try {
      const result = await post(subject, narrowing.families, hook);
      setVerdict(result);
      setRanSubject(subject);
      setRanOnly(narrowing.families);
      setRanNarrowing(narrowing);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evaluation failed');
    } finally {
      setRunning(false);
    }
  };

  // ── streaming ──
  const streamPlan = useMemo(
    () => resolveStreamPlan(hooks, effectiveMode),
    [hooks, effectiveMode],
  );

  const runStream = async () => {
    const plan = streamPlan.plan;
    if (!plan) {
      setError('This guardrail does not gate the stream — see the note above.');
      return;
    }
    if (!streamText.trim()) {
      setError('Enter some text to stream.');
      return;
    }
    resetResults();
    setRunning(true);

    const chunks = chunkText(streamText, chunkSize);
    const trace: StreamTrace = {
      windows: [],
      buffer: '',
      releasedTo: 0,
      blockedAt: null,
      settings: plan.settings,
      requiredOverlap: plan.requiredOverlap,
      unreachableRedaction: false,
    };

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        trace.buffer += chunks[i] ?? '';
        const final = i === chunks.length - 1;
        const win = planStreamWindow({
          buffer: trace.buffer,
          releasedTo: trace.releasedTo,
          seq: trace.windows.length,
          final,
          settings: plan.settings,
        });
        if (!win) continue;

        const result = await post(
          {
            kind: 'stream',
            buffer: win.windowText,
            delta: trace.buffer.slice(trace.releasedTo),
            releasedTo: win.releasedInWindow,
            seq: win.seq,
            final: win.final,
          },
          narrowing.families,
          'output.stream.delta',
        );

        trace.windows.push({ window: win, verdict: result, chunkIndex: i });

        if (result.decision === 'block') {
          // The gate LATCHES here: `releasedTo` is frozen, so everything after
          // it is exactly the text the client never received.
          trace.blockedAt = { at: trace.releasedTo, window: win, verdict: result };
          break;
        }

        if (result.redacted_text === null) {
          trace.releasedTo = win.releaseTo;
        } else {
          const spliced = spliceWindowRedaction({
            buffer: trace.buffer,
            releasedTo: trace.releasedTo,
            window: win,
            redacted: result.redacted_text,
          });
          trace.buffer = spliced.buffer;
          if (spliced.unreachable) trace.unreachableRedaction = true;
          // Recomputed AFTER the rewrite, exactly as the gate does: a redaction
          // changes the buffer's length, so a release point computed before it
          // would be an offset into a string that no longer exists.
          trace.releasedTo = Math.max(
            trace.releasedTo,
            trace.buffer.length - (final ? 0 : plan.settings.holdBackChars),
          );
        }
      }
      setStreamRun({ ...trace });
      // The DECIDING window's verdict carries the decision, but its findings
      // and degraded entries cover one window only. A stream is one answer, so
      // the card is given the union — with spans already lifted onto the whole
      // buffer — and a latency that is the sum of the windows rather than the
      // last one's, which would read as the cost of the whole run.
      const deciding = trace.blockedAt?.verdict ?? trace.windows[trace.windows.length - 1]?.verdict;
      if (deciding) {
        setVerdict({
          ...deciding,
          findings: trace.windows.flatMap((entry) =>
            absoluteFindings(entry.verdict.findings, entry.window.windowStart),
          ),
          degraded: trace.windows.flatMap((entry) => entry.verdict.degraded),
          latency_ms: trace.windows.reduce((sum, entry) => sum + entry.verdict.latency_ms, 0),
        });
        setRanOnly(narrowing.families);
        setRanNarrowing(narrowing);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Streaming evaluation failed');
    } finally {
      setRunning(false);
    }
  };

  // ── batch ──
  const batchParse = useMemo(() => parseBatchInput(batchInput), [batchInput]);

  const runBatch = async () => {
    if (batchParse.rows.length === 0) {
      setError('Nothing to run — paste one subject per line, or a CSV/JSONL file.');
      return;
    }
    resetResults();
    setRunning(true);
    setBatchProgress(0);
    cancelBatch.current = false;

    const outcomes: BatchOutcome[] = [];
    try {
      for (let i = 0; i < batchParse.rows.length; i += 1) {
        if (cancelBatch.current) break;
        const row = batchParse.rows[i];
        if (!row) continue;
        try {
          // Sequential on purpose: a batch is a tuning run, not a load test,
          // and firing 500 LLM-family evaluations at once bills the tenant for
          // a burst nobody asked for.
          const result = await post({ kind: 'text', text: row.text }, narrowing.families, hook);
          outcomes.push({ row, verdict: result });
        } catch (err) {
          outcomes.push({ row, error: err instanceof Error ? err.message : 'failed' });
        }
        setBatchProgress(Math.round(((i + 1) / batchParse.rows.length) * 100));
        setBatchOutcomes([...outcomes]);
      }
      setBatchOutcomes(outcomes);
      setRanOnly(narrowing.families);
      setRanNarrowing(narrowing);
    } finally {
      setRunning(false);
    }
  };

  const handleBatchFile = (file: File | null) => {
    if (!file) return;
    void file.text().then((content) => setBatchInput(content));
  };

  // ── derived views of the last verdict ──
  const outcomeRows = useMemo(() => {
    if (!verdict) return [];
    return summarizeRun({
      plan: planPolicies({ hooks, hook: verdict.hook, mode: effectiveMode, only: ranOnly }),
      verdict,
      shortCircuit: hooks?.shortCircuit,
    });
  }, [verdict, hooks, effectiveMode, ranOnly]);

  const colors = useMemo(
    () => assignPolicyColors((verdict?.findings ?? []).map((f) => f.policyId)),
    [verdict],
  );

  const overlaySegments = useMemo(() => {
    if (streamRun) {
      return [{ path: '/buffer', text: streamRun.buffer }];
    }
    return ranSubject ? subjectSegments(ranSubject) : [];
  }, [ranSubject, streamRun]);

  // In stream mode these already carry offsets into the whole buffer — the
  // merge above lifted them out of their windows.
  const overlayFindings = verdict?.findings ?? [];

  const policyOptions = useMemo(
    () =>
      policies.map((policy) => ({
        value: policy.id,
        label: `${policy.label?.trim() || policy.id} · ${policy.family}${policy.enabled ? '' : ' (off)'}`,
      })),
    [policies],
  );

  const decision = verdict ? describeDecision(verdict) : null;
  const messageFinding = verdict ? messageSource(verdict) : null;

  // ═════════════════════════════════════════════════════════════════════════

  return (
    <Stack gap="md">
      {/* ── sub-mode ── */}
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
            <SectionHeader
              icon={<IconFlask size={16} />}
              title="Test"
              description={`Runs "${guardrailName}" exactly as it is configured, against a subject you control. Nothing is sent to a model or a tool — only the guardrail runs.`}
            />
            <Group gap="xs">
              <Badge variant="light" color={effectiveMode === 'enforce' ? 'teal' : 'orange'}>
                mode: {effectiveMode}
              </Badge>
              {compiled && compiled.hooksVersion === 0 && (
                <Tooltip
                  multiline
                  w={280}
                  label="This guardrail predates the hook plane. Its policies are lifted from the legacy columns on every read, so they appear below with legacy: ids."
                >
                  <Badge variant="light" color="blue">
                    derived config
                  </Badge>
                </Tooltip>
              )}
            </Group>
          </Group>

          {/* THE ONE THING THAT CANNOT BE INFERRED. The shapes genuinely
              differ — a tool call is not a sentence — so the subject kind is
              chosen and the hook follows from it. */}
          <div>
            <Text size="xs" fw={500} mb={4}>
              What are you handing it?
            </Text>
            <SegmentedControl
              fullWidth
              size="xs"
              value={testMode}
              onChange={(value) => {
                setTestMode(value as TestMode);
                // A hook picked for a text subject means nothing to a tool
                // call, and `resolveModeHook` would drop it anyway — clearing
                // it here keeps the control and the resolution from ever
                // disagreeing about what is selected.
                setHookOverride(null);
                resetResults();
              }}
              data={[
                { value: 'text', label: 'Text' },
                { value: 'tool_call', label: 'Tool call' },
                { value: 'tool_result', label: 'Tool result' },
                { value: 'stream', label: 'Streaming' },
                { value: 'batch', label: 'Batch' },
              ]}
            />
            <Text size="xs" c="dimmed" mt={4}>
              The hook follows from this. Everything else — which policies run, in what order, with
              what action — comes from the guardrail as it is saved.
            </Text>
          </div>

          <Group justify="space-between" wrap="wrap" gap="xs">
            <Checkbox
              size="xs"
              label="Record this run in the evaluation log"
              description="Off by default: a test is not traffic, and shadow runs stay off the audit trail and off the bill."
              checked={record}
              onChange={(e) => setRecord(e.currentTarget.checked)}
            />
            {loadingConfig && <Loader size={12} />}
          </Group>

          {/* There is no mode override on the wire; saying so beats a control
              that quietly does nothing. */}
          <Text size="xs" c="dimmed">
            The guardrail runs in its own <strong>{effectiveMode}</strong> mode — the evaluate
            endpoint takes no mode override. Every result below shows{' '}
            <Code fz={11}>decision</Code> beside <Code fz={11}>would_be_decision</Code>, which is
            what an override would have told you.
          </Text>
        </Stack>
      </Paper>

      {configError && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
          <Text size="xs" fw={500}>
            The compiled policy could not be loaded: {configError}
          </Text>
          <Text size="xs" c="dimmed">
            Evaluation still works, but the per-policy breakdown cannot be derived — an empty policy
            table below means “unknown”, not “no policies”.
          </Text>
        </Alert>
      )}

      {effectiveMode === 'disabled' && (
        <Alert color="yellow" variant="light" icon={<IconCircleOff size={16} />}>
          This guardrail is disabled. No policy will run and every verdict will be a vacuous{' '}
          <Code fz={11}>allow</Code> — “nothing was checked”, not “this is safe”.
        </Alert>
      )}

      {/* ── what this guardrail is, on this hook ── */}
      {/* Not while the config is missing: with no compiled policy every row
          would read "no policies", which is the one thing the error alert
          above has just said this state does NOT mean. */}
      {!loadingConfig && !configError && (
        <ShapeCard shape={shape} hook={hook} narrowed={narrowing.differs} />
      )}

      {/* ── the subject ── */}
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          {/* Every sub-mode but streaming: the stream gate has its own, richer
              explainer below, and the two would otherwise disagree — a policy
              bound to output.stream.delta is dispatchable on a direct POST
              while `stream.enabled: false` means nothing gates a live stream. */}
          {testMode !== 'stream' && (
            <HookNote
              modeHook={modeHook}
              onChange={(next) => {
                setHookOverride(next);
                resetResults();
              }}
            />
          )}

          {testMode === 'text' && (
            <>
              <Textarea
                label="Subject text"
                placeholder="Type a message to evaluate…"
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                autosize
                minRows={4}
                maxRows={14}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              />
              <Group gap={6}>
                <Text size="xs" c="dimmed">
                  Samples:
                </Text>
                {TEXT_SAMPLES.map((sample) => (
                  <Button
                    key={sample.label}
                    size="compact-xs"
                    variant="default"
                    onClick={() => setText(sample.text)}
                  >
                    {sample.label}
                  </Button>
                ))}
              </Group>
            </>
          )}

          {(testMode === 'tool_call' || testMode === 'tool_result') && (
            <>
              <TextInput
                label="Tool name"
                description="The CANONICAL policy name — mcp server/tool, or sandbox.fs.read. tool_access matches on this, so a concrete URL with ids in it will never match a rule."
                placeholder="filesystem/read_file"
                value={toolName}
                onChange={(e) => setToolName(e.currentTarget.value)}
              />
              <Textarea
                label="Arguments (JSON object)"
                description="Every string leaf becomes its own scannable segment at /args/…, which is how a PII or regex policy reaches one argument rather than the whole blob."
                value={toolArgs}
                onChange={(e) => setToolArgs(e.currentTarget.value)}
                autosize
                minRows={4}
                maxRows={14}
                error={parseToolArgs(toolArgs).error}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              />
              {testMode === 'tool_result' && (
                <Textarea
                  label="Result (any JSON)"
                  description="Scanned at /result/…. The arguments ride along for tool_access but are NOT re-scanned here — tool.pre already did that."
                  value={toolResult}
                  onChange={(e) => setToolResult(e.currentTarget.value)}
                  autosize
                  minRows={3}
                  maxRows={12}
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
                />
              )}
            </>
          )}

          {testMode === 'stream' && (
            <>
              {!streamPlan.plan ? (
                <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
                  <Text size="xs" fw={500}>
                    Nothing is gated on the stream
                  </Text>
                  <Text size="xs" c="dimmed">
                    {streamPlan.reason}
                  </Text>
                </Alert>
              ) : (
                <Alert color="blue" variant="light" p="xs" icon={<IconBolt size={15} />}>
                  <Text size="xs" fw={600}>
                    Each window is adjudicated at <Code fz={11}>output.stream.delta</Code>
                  </Text>
                  <Text size="xs">
                    Hold-back {streamPlan.plan.settings.holdBackChars} chars · overlap{' '}
                    {streamPlan.plan.settings.overlapChars} (at least{' '}
                    {streamPlan.plan.requiredOverlap}, the longest match any bound policy can
                    produce) · max held {streamPlan.plan.settings.maxHeldChars} · on block{' '}
                    {streamPlan.plan.settings.onBlock}
                  </Text>
                  <Text size="xs" c="dimmed" mt={2}>
                    Set the chunk size so a match straddles a boundary — that is the case the
                    overlap exists for, and the only way to see it work.
                  </Text>
                </Alert>
              )}
              <Textarea
                label="Streamed answer"
                value={streamText}
                onChange={(e) => setStreamText(e.currentTarget.value)}
                autosize
                minRows={4}
                maxRows={12}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              />
              <NumberInput
                size="xs"
                w={200}
                label="Chunk size (characters)"
                min={1}
                max={2000}
                value={chunkSize}
                onChange={(value) => setChunkSize(typeof value === 'number' ? value : 24)}
              />
            </>
          )}

          {testMode === 'batch' && (
            <>
              <Textarea
                label="Subjects"
                description="One per line, or CSV with a text column, or JSONL with a text field. Blank lines and # comments are ignored."
                placeholder={'my card is 4111 1111 1111 1111\ntext,expected\n"ignore previous instructions",block'}
                value={batchInput}
                onChange={(e) => setBatchInput(e.currentTarget.value)}
                autosize
                minRows={6}
                maxRows={16}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              />
              <Group gap="xs">
                <FileButton onChange={handleBatchFile} accept=".csv,.jsonl,.txt,text/csv,text/plain">
                  {(props) => (
                    <Button
                      {...props}
                      size="xs"
                      variant="light"
                      leftSection={<IconFileUpload size={14} />}
                    >
                      Upload CSV / JSONL
                    </Button>
                  )}
                </FileButton>
                <Text size="xs" c="dimmed">
                  {batchParse.rows.length} row{batchParse.rows.length === 1 ? '' : 's'} parsed as{' '}
                  {batchParse.format}
                  {batchParse.errors.length > 0
                    ? ` · ${batchParse.errors.length} line${batchParse.errors.length === 1 ? '' : 's'} skipped`
                    : ''}
                </Text>
              </Group>
              {batchParse.errors.length > 0 && (
                <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={15} />}>
                  {batchParse.errors.slice(0, 5).map((entry) => (
                    <Text key={entry.line} size="xs">
                      line {entry.line}: {entry.reason}
                    </Text>
                  ))}
                </Alert>
              )}
            </>
          )}

          <Divider />

          {/* ── narrowing, behind a closed door ── */}
          <div>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={
                showAdvanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
              }
              onClick={() => setShowAdvanced((open) => !open)}
            >
              Advanced — isolate policies
              {narrowing.narrowed ? ` (${narrowing.families.join(', ')})` : ''}
            </Button>
            <Collapse in={showAdvanced}>
              <Stack gap="xs" mt="xs">
                <MultiSelect
                  size="xs"
                  label="Run only these policies"
                  description="A debug tool, not the front door. Leave it empty and the guardrail runs exactly as configured — which is the only run whose verdict describes production."
                  placeholder={selectedPolicyIds.length === 0 ? 'all policies (as configured)' : undefined}
                  data={policyOptions}
                  value={selectedPolicyIds}
                  onChange={(value) => {
                    setSelectedPolicyIds(value);
                    resetResults();
                  }}
                  clearable
                  searchable
                  disabled={policyOptions.length === 0}
                />
                {narrowing.narrowed && (
                  <Text size="xs" c="dimmed">
                    Sent as <Code fz={11}>only=[{narrowing.families.join(', ')}]</Code>. The API
                    filters by policy FAMILY — there is no per-policy filter on the wire, which is
                    why selecting one of two regex policies still runs both.
                  </Text>
                )}
              </Stack>
            </Collapse>
          </div>

          <NarrowedBanner narrowing={narrowing} />

          <Group>
            <Button
              leftSection={<IconPlayerPlay size={15} />}
              loading={running}
              onClick={() => {
                if (testMode === 'stream') void runStream();
                else if (testMode === 'batch') void runBatch();
                else void runSingle();
              }}
              disabled={testMode === 'stream' && !streamPlan.plan}
            >
              {testMode === 'batch' ? `Run ${batchParse.rows.length}` : 'Run'}
            </Button>
            {running && testMode === 'batch' && (
              <Button
                variant="subtle"
                color="red"
                size="xs"
                leftSection={<IconX size={14} />}
                onClick={() => {
                  cancelBatch.current = true;
                }}
              >
                Stop
              </Button>
            )}
            {(verdict || batchOutcomes) && !running && (
              <Button variant="subtle" color="gray" size="xs" onClick={resetResults}>
                Clear
              </Button>
            )}
          </Group>

          {running && testMode === 'batch' && <Progress value={batchProgress} size="sm" animated />}
        </Stack>
      </Paper>

      {error && (
        <Alert color="red" title="Error" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {/* The run that produced what follows, not the controls as they stand
          now — a result read without this line is the failure the whole
          redesign is about. */}
      {ranNarrowing && (verdict || batchOutcomes) && <NarrowedBanner narrowing={ranNarrowing} past />}

      {/* ── batch results ── */}
      {batchOutcomes && batchOutcomes.length > 0 && (
        <BatchResults outcomes={batchOutcomes} />
      )}

      {/* ── stream trace ── */}
      {streamRun && <StreamTraceView trace={streamRun} />}

      {/* ── verdict ── */}
      {verdict && decision && (
        <Paper withBorder radius="md" p="md">
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Group gap="sm">
                <ThemeIcon
                  size={36}
                  radius="md"
                  variant="light"
                  color={decision.color}
                >
                  {decision.vacuous ? (
                    <IconCircleOff size={18} />
                  ) : verdict.decision === 'block' || decision.wouldHaveBlocked ? (
                    <IconAlertTriangle size={18} />
                  ) : (
                    <IconCircleCheck size={18} />
                  )}
                </ThemeIcon>
                <div>
                  <Group gap={6}>
                    <Badge color={decision.color} variant="filled" size="sm">
                      {decision.label}
                    </Badge>
                    <Badge
                      color={verdict.enforced ? 'teal' : 'gray'}
                      variant="light"
                      size="sm"
                    >
                      enforced: {String(verdict.enforced)}
                    </Badge>
                    <Badge variant="default" size="sm">
                      {verdict.latency_ms} ms
                    </Badge>
                    {verdict.risk_score > 0 && (
                      <Badge variant="default" size="sm">
                        risk {verdict.risk_score}
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed" mt={4} maw={640}>
                    {decision.detail}
                  </Text>
                </div>
              </Group>
              <Text size="xs" c="dimmed" ff="monospace">
                {verdict.hook} · {verdict.trace_id.slice(0, 8)}
              </Text>
            </Group>

            {decision.wouldHaveBlocked && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
                <Text size="sm" fw={600}>
                  Would have blocked — it did not.
                </Text>
                <Text size="xs" c="dimmed">
                  <Code fz={11}>would_be_decision: block</Code> with{' '}
                  <Code fz={11}>decision: {verdict.decision}</Code> and{' '}
                  <Code fz={11}>enforced: false</Code>. In {verdict.mode} mode the engine
                  neutralises the decision before anyone acts on it, and it drops the redactions
                  too, so live traffic like this goes through untouched.
                </Text>
              </Alert>
            )}

            {verdict.disabled && (
              <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
                No policy ran on this hook. That can be the guardrail being off, the hook’s binding
                being off, or no enabled policy naming it — the breakdown below says which.
              </Alert>
            )}

            {/* ── the subject with the findings on it ── */}
            {overlaySegments.length > 0 && (
              <div>
                <Text size="xs" fw={600} mb={6}>
                  Subject, with findings in place
                </Text>
                <Paper withBorder radius="md" p="sm" bg="var(--mantine-color-body)">
                  <SpanOverlay
                    segments={overlaySegments}
                    findings={overlayFindings}
                    colors={colors}
                  />
                </Paper>
              </div>
            )}

            {/* ── findings ── */}
            {verdict.findings.length > 0 && (
              <div>
                <Text size="xs" fw={600} mb={6}>
                  {verdict.findings.length} finding
                  {verdict.findings.length === 1 ? '' : 's'}
                </Text>
                <Stack gap={6}>
                  {verdict.findings.map((finding, i) => (
                    <FindingCard
                      key={`${finding.policyId}-${i}`}
                      finding={finding}
                      color={colors[finding.policyId] ?? 'red'}
                    />
                  ))}
                </Stack>
              </div>
            )}

            {/* Suppressed for a stream: `redacted_text` is one WINDOW's rewrite,
                and the trace above already shows the whole buffer with the
                rewrite spliced into it. */}
            {verdict.redacted_text !== null && !streamRun && (
              <div>
                <Group gap={6} mb={4}>
                  <IconArrowRight size={13} />
                  <Text size="xs" fw={600}>
                    Rewritten subject
                  </Text>
                </Group>
                <Code block fz={11}>
                  {verdict.redacted_text}
                </Code>
              </div>
            )}

            <Divider />

            {/* ── per-policy breakdown ── */}
            <div>
              <Text size="xs" fw={600} mb={6}>
                Per policy
              </Text>
              <PolicyBreakdown
                rows={outcomeRows}
                latencyMs={verdict.latency_ms}
                latencyScope={
                  streamRun
                    ? `across ${streamRun.windows.length} stream window${streamRun.windows.length === 1 ? '' : 's'}`
                    : 'for the whole hook'
                }
                colors={colors}
              />
            </div>

            {/* ── the end-user message ── */}
            <div>
              <Group gap={6} mb={6}>
                <IconMessageReport size={14} />
                <Text size="xs" fw={600}>
                  What the end user would see
                </Text>
              </Group>
              {verdict.blocked_message ? (
                <Alert color="red" variant="light" p="sm">
                  <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                    {verdict.blocked_message.body}
                  </Text>
                  <Text size="xs" c="dimmed" mt={6}>
                    Reason class <Code fz={11}>{verdict.blocked_message.reasonClass}</Code> · HTTP{' '}
                    {verdict.blocked_message.status} · delivered as{' '}
                    {verdict.blocked_message.mode}
                    {messageFinding ? (
                      <>
                        {' '}
                        · produced by <Code fz={11}>{messageFinding.policyId}</Code> (the first
                        blocking finding — block beats redact, and the message follows the policy
                        that blocked)
                      </>
                    ) : null}
                  </Text>
                </Alert>
              ) : blockMessageGap(verdict) ? (
                <Alert color="orange" variant="light" p="sm" icon={<IconInfoCircle size={15} />}>
                  <Text size="xs">
                    The policy decided block, so a message WOULD be rendered — but the engine only
                    renders one when the decision is actually enforced, and this guardrail is in{' '}
                    {verdict.mode} mode. The policy that would produce it is{' '}
                    <Code fz={11}>{messageFinding?.policyId ?? 'unknown'}</Code>. Switch the
                    guardrail to enforce to see the exact wording.
                  </Text>
                </Alert>
              ) : (
                <Text size="xs" c="dimmed">
                  Nothing. The request was not refused, so no block message is rendered.
                </Text>
              )}
            </div>

            {verdict.codes.length > 0 && (
              <Group gap={4}>
                <Text size="xs" c="dimmed">
                  codes:
                </Text>
                {verdict.codes.map((code) => (
                  <Code key={code} fz={11}>
                    {code}
                  </Code>
                ))}
              </Group>
            )}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Streaming trace
// ═══════════════════════════════════════════════════════════════════════════

interface StreamWindowRun {
  window: StreamWindow;
  verdict: HookVerdictResponse;
  chunkIndex: number;
}

interface StreamTrace {
  windows: StreamWindowRun[];
  buffer: string;
  releasedTo: number;
  blockedAt: { at: number; window: StreamWindow; verdict: HookVerdictResponse } | null;
  settings: { holdBackChars: number; overlapChars: number; maxHeldChars: number };
  requiredOverlap: number;
  unreachableRedaction: boolean;
}

/**
 * Where the stream was cut, and what had already gone out.
 *
 * A verdict alone cannot answer this: the interesting number is the release
 * frontier at the instant the gate latched, and that lives in the gate's own
 * bookkeeping, not in any single window's answer. So the panel replays the
 * gate (`planStreamWindow`, same arithmetic) and shows both halves of the
 * buffer split at that character.
 */
function StreamTraceView({ trace }: { trace: StreamTrace }) {
  const cut = trace.blockedAt?.at ?? trace.releasedTo;
  const released = trace.buffer.slice(0, cut);
  const withheld = trace.buffer.slice(cut);

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <SectionHeader
          icon={<IconPlayerTrackNext size={16} />}
          title="Stream trace"
          description={`${trace.windows.length} window${trace.windows.length === 1 ? '' : 's'} adjudicated. Only pii, secrets and regex scan a window; everything else waits for the terminal output.pre audit.`}
        />

        {trace.blockedAt ? (
          <Alert color="red" variant="light" icon={<IconScissors size={16} />}>
            <Text size="sm" fw={600}>
              Cut at character {cut} of {trace.buffer.length}
            </Text>
            <Text size="xs" c="dimmed">
              The gate latched on window #{trace.blockedAt.window.seq}. Everything before character{' '}
              {cut} had already been written to the client and cannot be recalled —{' '}
              {trace.settings.holdBackChars === 0
                ? 'nothing was held back'
                : `the hold-back of ${trace.settings.holdBackChars} characters is what kept the rest back`}
              . On block this guardrail is set to{' '}
              <Code fz={11}>{trace.blockedAt.verdict.decision}</Code>, and a replacement message
              can only be substituted while nothing has been released yet.
            </Text>
          </Alert>
        ) : (
          <Alert color="teal" variant="light" p="xs" icon={<IconCircleCheck size={15} />}>
            <Text size="xs">
              Every window cleared. {trace.buffer.length - trace.releasedTo} character
              {trace.buffer.length - trace.releasedTo === 1 ? '' : 's'} still held back at the end
              of the run.
            </Text>
          </Alert>
        )}

        {trace.unreachableRedaction && (
          <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={15} />}>
            <Text size="xs">
              A redaction targeted text that had already been released. The gate drops those — the
              finding stands but the characters went out as the model wrote them.
            </Text>
          </Alert>
        )}

        <div>
          <Text size="xs" fw={600} mb={4}>
            Released / withheld
          </Text>
          <Paper withBorder radius="md" p="sm">
            <Box
              style={{
                fontFamily: 'var(--mantine-font-family-monospace)',
                fontSize: 12,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <span>{released}</span>
              {withheld.length > 0 && (
                <>
                  <Box
                    component="span"
                    style={{
                      color: 'var(--mantine-color-red-filled)',
                      fontWeight: 700,
                      padding: '0 2px',
                    }}
                  >
                    ⟨cut@{cut}⟩
                  </Box>
                  <Box
                    component="span"
                    style={{
                      opacity: 0.45,
                      textDecoration: trace.blockedAt ? 'line-through' : 'none',
                    }}
                  >
                    {withheld}
                  </Box>
                </>
              )}
            </Box>
          </Paper>
        </div>

        <ScrollArea type="auto">
          <Table fz="xs" verticalSpacing={6} miw={560}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={60}>Window</Table.Th>
                <Table.Th w={70}>Chunk</Table.Th>
                <Table.Th>Scanned range</Table.Th>
                <Table.Th w={90}>Decision</Table.Th>
                <Table.Th w={80}>Findings</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {trace.windows.map((entry) => (
                <Table.Tr key={entry.window.seq}>
                  <Table.Td>#{entry.window.seq}</Table.Td>
                  <Table.Td>{entry.chunkIndex + 1}</Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {entry.window.windowStart}–
                      {entry.window.windowStart + entry.window.windowText.length}
                      {entry.window.releasedInWindow > 0
                        ? ` (${entry.window.releasedInWindow} of it already released — the overlap tail)`
                        : ''}
                      {entry.window.unadjudicated > 0
                        ? ` · ${entry.window.unadjudicated} chars UNSCANNED (maxHeldChars)`
                        : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="xs"
                      variant="light"
                      color={entry.verdict.decision === 'block' ? 'red' : 'teal'}
                    >
                      {entry.verdict.decision}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{entry.verdict.findings.length}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Stack>
    </Paper>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Batch results
// ═══════════════════════════════════════════════════════════════════════════

function BatchResults({ outcomes }: { outcomes: readonly BatchOutcome[] }) {
  const summary = useMemo(() => summarizeBatch(outcomes), [outcomes]);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const rows = onlyProblems
    ? outcomes.filter(
        (outcome) =>
          outcome.error !== undefined ||
          (outcome.verdict !== undefined &&
            (outcome.verdict.decision === 'block' ||
              outcome.verdict.would_be_decision === 'block' ||
              outcome.verdict.findings.length > 0)),
      )
    : outcomes;

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <SectionHeader
          icon={<IconFlask size={16} />}
          title="Batch"
          description="Blocked and would-have-blocked are counted apart — folding them together is what makes a monitor-mode guardrail look like it is protecting something."
        />

        <Group gap="xs" wrap="wrap">
          <Badge size="lg" variant="light" color="gray">
            {summary.total} run
          </Badge>
          <Badge size="lg" variant="light" color="red">
            {summary.blocked} blocked
          </Badge>
          <Badge size="lg" variant="light" color="orange">
            {summary.wouldBlock} would have blocked
          </Badge>
          <Badge size="lg" variant="light" color="blue">
            {summary.flagged} flagged only
          </Badge>
          <Badge size="lg" variant="light" color="teal">
            {summary.clean} clean
          </Badge>
          {summary.notEvaluated > 0 && (
            <Badge size="lg" variant="light" color="yellow">
              {summary.notEvaluated} not evaluated
            </Badge>
          )}
          {summary.failed > 0 && (
            <Badge size="lg" variant="light" color="red">
              {summary.failed} failed
            </Badge>
          )}
        </Group>

        <Checkbox
          size="xs"
          label="Only show rows with a finding, a block, or an error"
          checked={onlyProblems}
          onChange={(e) => setOnlyProblems(e.currentTarget.checked)}
        />

        <ScrollArea type="auto" mah={420}>
          <Table fz="xs" verticalSpacing={6} striped miw={560}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={50}>Line</Table.Th>
                <Table.Th>Subject</Table.Th>
                <Table.Th w={110}>Decision</Table.Th>
                <Table.Th w={90}>Expected</Table.Th>
                <Table.Th>Categories</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((outcome) => {
                const verdict = outcome.verdict;
                const label = outcome.error
                  ? 'error'
                  : verdict
                    ? describeDecision(verdict).label
                    : '—';
                const color = outcome.error
                  ? 'red'
                  : verdict
                    ? describeDecision(verdict).color
                    : 'gray';
                const categories = verdict
                  ? [...new Set(verdict.findings.map((f) => f.category))].join(', ')
                  : (outcome.error ?? '');
                // A mismatch is only meaningful when the file said what it
                // expected; nothing is inferred from silence.
                const mismatch =
                  outcome.row.expected !== undefined &&
                  verdict !== undefined &&
                  outcome.row.expected.toLowerCase() !== verdict.would_be_decision;
                return (
                  <Table.Tr key={outcome.row.line}>
                    <Table.Td>{outcome.row.line}</Table.Td>
                    <Table.Td>
                      <Text size="xs" lineClamp={2} ff="monospace">
                        {outcome.row.text}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={color}>
                        {label}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {outcome.row.expected ? (
                        <Badge size="xs" variant={mismatch ? 'filled' : 'default'} color={mismatch ? 'orange' : 'gray'}>
                          {outcome.row.expected}
                        </Badge>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {categories || '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Stack>
    </Paper>
  );
}
