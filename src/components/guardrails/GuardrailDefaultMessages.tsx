'use client';

/**
 * THE WORKSPACE'S DEFAULT WORDING — one message for every policy that blocks
 * for the same reason.
 *
 * ── WHERE THIS CAME FROM, AND WHY IT SHRANK ─────────────────────────────────
 * This was the Error Messages TAB (`GuardrailMessagesEditor`). It folded into
 * the Config tab as a collapsed panel when per-policy messages arrived: a
 * policy now carries its own `message`, edited on its own card, so the tab's
 * per-reason rows stopped being the only place wording is written and a whole
 * tab for eight textareas stopped being worth its cost in navigation.
 *
 * What did NOT fold away is the reason this layer exists at all: it is the only
 * place an operator can say one thing for EVERY PII policy at once — three
 * policies, three hooks, one sentence — and the only place the delivery shape
 * (`error` vs `replace`) and the trace id are set. Writing the same override on
 * three cards is not the same capability; it is the same sentence three times,
 * and it drifts the first time someone edits one of them.
 *
 * ── THE RESOLUTION ORDER THIS PANEL SITS IN ─────────────────────────────────
 *     policy.message  →  locale.byCategory  →  locale.byPolicy  →
 *     locale.default  →  byCategory  →  byPolicy  →  default  →  built-in
 * The rows below are `byCategory` — the reason-class layer. A policy's own
 * message outranks them, which is why each row says how many policies have
 * taken themselves out of it. Nobody should have to discover that by editing a
 * default and watching nothing change.
 *
 * ── TWO THINGS THIS SCREEN IS HONEST ABOUT ──────────────────────────────────
 * 1. Overrides are keyed by REASON CLASS, not by policy family. Several
 *    families deliberately collapse into one reason (`regex`, `custom` and
 *    `webhook` all land on 'custom') because an authored regex rule could be
 *    about anything and guessing a specific reason produces a message that is
 *    confidently wrong. So the rows are labelled with every family that feeds
 *    them, and an operator can never think they are editing two independent
 *    strings when there is only one.
 * 2. There is ONE language. `BlockedMessageSettings.templates` has no locale
 *    dimension and the evaluator never reads one, so a language switch here
 *    could only ever change which placeholder was displayed — it offered a
 *    capability the product does not have. It was removed rather than left
 *    looking functional.
 *
 * Every field is EMPTY by default and the built-in appears as the placeholder:
 * an editor that pre-fills the textarea with the default cannot distinguish
 * "kept the default" from "typed the default", and the first save would freeze
 * today's wording into every guardrail forever.
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Collapse,
  Divider,
  Group,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconInfoCircle,
  IconMessage2,
  IconRotate,
} from '@tabler/icons-react';
import { BLOCK_MESSAGE_VARS } from '@/lib/services/guardrail/hooks/contract';
import type {
  BlockedMessageSettings,
  BlockReasonClass,
  GuardrailPolicy,
  PolicyFamily,
} from '@/lib/services/guardrail/hooks/contract';
import {
  BLOCK_REASON_FOR_FAMILY,
  BUILTIN_BLOCK_MESSAGES,
  DEFAULT_BLOCK_MESSAGE_LOCALE,
  renderBlockMessage,
} from '@/lib/services/guardrail/hooks/messages';
// The label an operator navigates by. Imported rather than restated: the policy
// drawer says "inherited from the Personal data default" and this panel is
// where they then come looking for that row, so the two strings have to be the
// same string. (`BLOCK_REASON_LABEL`'s doc-comment in the drawer still calls
// itself a knowing duplicate of this file's copy — it is now the only copy.)
import { BLOCK_REASON_LABEL } from './GuardrailPolicyDrawer';

/** Reason-class order, most-often-seen first, so the row an operator came here
 *  to change is at the top rather than alphabetically buried. */
const REASON_ORDER: readonly BlockReasonClass[] = [
  'pii',
  'secrets',
  'profanity',
  'moderation',
  'injection',
  'tool_denied',
  'custom',
  'unavailable',
];

/**
 * A note per reason class where the wording is load-bearing rather than
 * cosmetic. Only three carry one, because only three have a rule an operator
 * can break without noticing.
 */
const REASON_NOTE: Partial<Record<BlockReasonClass, string>> = {
  injection:
    'The built-in says nothing about why on purpose. Telling someone probing the guardrail that injection was detected is the single most useful piece of feedback you could give them.',
  secrets:
    'The built-in warns as well as refuses: a key that reached this point has been typed into a chat box, and telling the person to rotate it is worth more than the block itself.',
  tool_denied:
    'The only reason that names what triggered it. A tool name is what someone needs in order to ask for access, and it cannot be used to evade anything.',
};

/** Sample values for the live preview. Deliberately obvious stand-ins — a
 *  preview that looks like real data invites someone to read it as real. */
const PREVIEW_VARS: Partial<Record<(typeof BLOCK_MESSAGE_VARS)[number], string>> = {
  guardrailName: 'Outbound safety',
  guardrailKey: 'outbound-safety',
  categories: 'email, phone',
  codes: 'pii_detected',
  toolName: 'files.write',
  requestId: 'req_9f2c1a',
  traceId: 'gr_7b41e0c2',
};

const familiesFor = (reason: BlockReasonClass): PolicyFamily[] =>
  (Object.keys(BLOCK_REASON_FOR_FAMILY) as PolicyFamily[]).filter(
    (family) => BLOCK_REASON_FOR_FAMILY[family] === reason,
  );

/**
 * How many policies have written a message of their own for each reason class.
 *
 * Exported because it is the one fact this panel cannot be honest without: a
 * policy's own message BEATS the default below it, so an operator editing the
 * PII row while all three PII policies carry their own wording would be editing
 * a string nobody will ever read.
 */
export function policyMessageOverrides(
  policies: readonly GuardrailPolicy[] | undefined,
): Partial<Record<BlockReasonClass, number>> {
  const out: Partial<Record<BlockReasonClass, number>> = {};
  for (const policy of policies ?? []) {
    if (!policy.message?.trim()) continue;
    const reason = BLOCK_REASON_FOR_FAMILY[policy.family];
    // A family this build does not know has no reason class; counting it under
    // `undefined` would put a phantom note on a row picked at random.
    if (!reason) continue;
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}

export interface GuardrailDefaultMessagesProps {
  settings: BlockedMessageSettings | undefined;
  onChange: (settings: BlockedMessageSettings) => void;
  /** Families this guardrail actually runs, so the reasons it can produce are
   *  badged and shown first. Everything stays reachable — a guardrail gains
   *  policies later, and hiding a row for good would make its message look
   *  unset when it is not. */
  activeFamilies?: readonly PolicyFamily[];
  /** The guardrail's policies, so a row can say how many of them have taken
   *  themselves out of this layer with a message of their own. */
  policies?: readonly GuardrailPolicy[];
  /** `hooksVersion === 0`: saving anything here also promotes a derived
   *  configuration to an authored one, which is not a side effect anyone should
   *  meet by surprise. */
  derived?: boolean;
  readOnly?: boolean;
  /** Open on first render. The panel is collapsed by default — it is a setting
   *  most guardrails never touch, sitting above the policies most of them do. */
  defaultOpen?: boolean;
}

export default function GuardrailDefaultMessages({
  settings,
  onChange,
  activeFamilies = [],
  policies,
  derived,
  readOnly,
  defaultOpen,
}: GuardrailDefaultMessagesProps) {
  const [open, setOpen] = useState(defaultOpen === true);
  const [showAll, setShowAll] = useState(false);
  const [previewOf, setPreviewOf] = useState<BlockReasonClass | null>(null);

  const templates = settings?.templates ?? {};
  const overrides = useMemo(() => policyMessageOverrides(policies), [policies]);

  const reachable = useMemo(() => {
    const set = new Set(activeFamilies.map((family) => BLOCK_REASON_FOR_FAMILY[family]));
    // `unavailable` is never produced by a family — it is what a fail-closed
    // guardrail says when a policy could not run at all — so it is reachable
    // whenever anything is configured.
    if (activeFamilies.length > 0) set.add('unavailable');
    return set;
  }, [activeFamilies]);

  const customised = REASON_ORDER.filter((reason) => (templates[reason] ?? '') !== '');

  /**
   * Which rows are drawn.
   *
   * The reasons this guardrail can actually produce, plus any that already
   * carry an override — a customised row stays visible even after the policy
   * that needed it was deleted, because a message nobody can find is a message
   * nobody can clear. Everything else is one click away rather than gone.
   */
  const relevant = REASON_ORDER.filter(
    (reason) => reachable.has(reason) || (templates[reason] ?? '') !== '',
  );
  const visible = showAll || relevant.length === 0 ? REASON_ORDER : relevant;
  const hidden = REASON_ORDER.length - visible.length;

  const setTemplate = (reason: BlockReasonClass, value: string) => {
    const next = { ...templates };
    // An empty field means "use the built-in", so the key is REMOVED rather
    // than stored as ''. A stored empty string would win the resolution order
    // and blank the message.
    if (value.trim() === '') delete next[reason];
    else next[reason] = value;
    onChange({ ...settings, templates: next });
  };

  return (
    <Paper withBorder radius="md" p="md">
      <UnstyledButton
        onClick={() => setOpen((value) => !value)}
        style={{ width: '100%' }}
        aria-expanded={open}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon size={28} radius="sm" variant="light" color="gray">
              <IconMessage2 size={15} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm">
                Default messages
              </Text>
              <Text size="xs" c="dimmed" maw={640}>
                What an end user reads when this guardrail stops something — one message for every
                policy that blocks for the same reason.
              </Text>
            </div>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Badge size="xs" variant={customised.length > 0 ? 'light' : 'default'} color="gray">
              {customised.length > 0
                ? `${customised.length} customised`
                : 'built-in wording'}
            </Badge>
            {settings?.mode === 'replace' && (
              <Badge size="xs" variant="light" color="blue">
                replaces the answer
              </Badge>
            )}
            {settings?.includeTraceId === false && (
              <Badge size="xs" variant="light" color="orange">
                no trace id
              </Badge>
            )}
            {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          </Group>
        </Group>
      </UnstyledButton>

      <Collapse in={open}>
        <Stack gap="sm" mt="md">
          {/* Where the per-policy half went. Without this line, an operator who
              remembers writing a message for one policy comes here looking for
              it and concludes it was lost. */}
          <Text size="xs" c="dimmed" maw={760}>
            A single policy can say something narrower on its own card, under <em>Error message</em>
            {' '}— that wins over the default here. These are the guardrail-wide defaults, and the
            only place one sentence covers every policy that blocks for the same reason at once.
          </Text>

          {derived && (
            <Text size="xs" c="dimmed" maw={760}>
              This guardrail&apos;s configuration is still derived from its legacy fields. Saving a
              message here promotes it to an authored one — from then on the policy cards decide
              what runs, not those columns.
            </Text>
          )}

          <Group gap="md" align="flex-end" wrap="wrap">
            <Select
              size="xs"
              w={280}
              label="Delivery"
              data={[
                { value: 'error', label: 'Error response — what clients parse today' },
                { value: 'replace', label: 'Replace the answer — what a chat UI can render' },
              ]}
              value={settings?.mode ?? 'error'}
              disabled={readOnly}
              onChange={(v) => onChange({ ...settings, mode: v === 'replace' ? 'replace' : 'error' })}
            />
            <Switch
              size="sm"
              label="Include a trace id"
              checked={settings?.includeTraceId !== false}
              disabled={readOnly}
              onChange={(e) => onChange({ ...settings, includeTraceId: e.currentTarget.checked })}
            />
          </Group>

          {settings?.includeTraceId === false && (
            <Alert color="orange" variant="light" icon={<IconInfoCircle size={15} />} p="xs">
              <Text size="xs">
                Without a trace id, &ldquo;the assistant refused and I don&apos;t know why&rdquo; is
                unsupportable — nobody can find the evaluation that caused it.
              </Text>
            </Alert>
          )}

          <Divider />

          <Stack gap="md">
            {visible.map((reason) => {
              const builtin = BUILTIN_BLOCK_MESSAGES[DEFAULT_BLOCK_MESSAGE_LOCALE][reason];
              const value = templates[reason] ?? '';
              const note = REASON_NOTE[reason];
              const preview = previewOf === reason;
              const overriddenBy = overrides[reason] ?? 0;

              return (
                <div key={reason}>
                  <Group justify="space-between" align="center" mb={4} wrap="wrap" gap="xs">
                    <Group gap={6}>
                      <Text size="xs" fw={600}>
                        {BLOCK_REASON_LABEL[reason]}
                      </Text>
                      {reachable.has(reason) && (
                        <Badge size="xs" variant="light" color="teal">
                          in use
                        </Badge>
                      )}
                      {familiesFor(reason).map((family) => (
                        <Badge key={family} size="xs" variant="default">
                          {family}
                        </Badge>
                      ))}
                    </Group>
                    <Group gap={4}>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => setPreviewOf(preview ? null : reason)}
                      >
                        {preview ? 'Hide preview' : 'Preview'}
                      </Button>
                      {value !== '' && !readOnly && (
                        <Tooltip label="Clear the override and go back to the built-in" withArrow>
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="gray"
                            leftSection={<IconRotate size={12} />}
                            onClick={() => setTemplate(reason, '')}
                          >
                            Reset
                          </Button>
                        </Tooltip>
                      )}
                    </Group>
                  </Group>

                  {note && (
                    <Text size="xs" c="dimmed" mb={6} maw={760}>
                      {note}
                    </Text>
                  )}

                  <Textarea
                    size="xs"
                    autosize
                    minRows={1}
                    placeholder={builtin}
                    value={value}
                    readOnly={readOnly}
                    onChange={(e) => setTemplate(reason, e.currentTarget.value)}
                  />

                  {overriddenBy > 0 && (
                    <Text size="xs" c="dimmed" mt={4}>
                      {overriddenBy === 1
                        ? '1 policy writes its own message for this reason and will not read this one.'
                        : `${overriddenBy} policies write their own message for this reason and will not read this one.`}
                    </Text>
                  )}

                  {preview && (
                    <Paper withBorder radius="sm" p="xs" mt={6} bg="var(--ds-surface-1)">
                      <Text size="xs" c="dimmed" mb={2}>
                        With sample values:
                      </Text>
                      <Text size="xs">{renderBlockMessage(value || builtin, PREVIEW_VARS)}</Text>
                    </Paper>
                  )}
                </div>
              );
            })}
          </Stack>

          {hidden > 0 && (
            <Group>
              <Button size="compact-xs" variant="subtle" onClick={() => setShowAll(true)}>
                Show {hidden} more {hidden === 1 ? 'reason' : 'reasons'} this guardrail cannot
                produce today
              </Button>
            </Group>
          )}

          <Divider />

          <div>
            <Group gap={6} mb={6} wrap="wrap">
              <Text size="xs" fw={600}>
                Variables
              </Text>
              {BLOCK_MESSAGE_VARS.map((name) => (
                <Code key={name} fz="xs">{`{{${name}}}`}</Code>
              ))}
            </Group>
            <Text size="xs" c="dimmed" maw={760}>
              The set is closed. There is deliberately no <Code fz="xs">{'{{value}}'}</Code> or{' '}
              <Code fz="xs">{'{{text}}'}</Code>: these messages are shown to end users, so a variable
              carrying the matched text would turn the guardrail into an exfiltration channel for the
              data it exists to protect. Anything else in braces is left in the output exactly as you
              typed it, so a typo shows up rather than silently blanking.
            </Text>
          </div>
        </Stack>
      </Collapse>
    </Paper>
  );
}
