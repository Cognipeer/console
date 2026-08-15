'use client';

/**
 * DatasetItemEditor — full-screen FormShell overlay editing ONE evaluation
 * dataset item with full tool fidelity: conversation turns (incl. assistant
 * toolCalls and tool-result turns), per-item tool definitions, expectations
 * (reference / expected tool calls / assertions), canned toolResults, and a
 * two-way raw-JSON tab for power users.
 *
 * The editor is persistence-agnostic: it returns the finished item via
 * `onSave` and the caller PATCHes the dataset / updates its local rows.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Button,
  Checkbox,
  Collapse,
  Group,
  Menu,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import JsonTreeViewer from '@/components/common/JsonTreeViewer';
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconListCheck,
  IconPlus,
  IconTrash,
  IconWand,
} from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { EvalArgsMatchMode, EvalDatasetItemView, EvalToolDefinitionView } from './types';
import {
  ARGS_MATCH_MODES,
  declaredToolCallIds,
  declaredToolNames,
  draftToItem,
  emptyExpectedToolCallDraft,
  emptyItemDraft,
  emptyJsonPathRuleDraft,
  emptyToolCallDraft,
  emptyToolDraft,
  emptyTurnDraft,
  EVAL_ROLES,
  inferMissingToolNames,
  itemToDraft,
  itemToJsonText,
  jsonTextError,
  parseItemJson,
  toolDefinitionsToDrafts,
  type EvalRoleView,
  type ItemDraft,
  type ToolDraft,
  type TurnDraft,
} from './datasetItemHelpers';

const MONO_INPUT = {
  input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 },
} as const;

const ROLE_PLACEHOLDER: Record<EvalRoleView, string> = {
  system: 'System instructions…',
  user: 'What the user says…',
  assistant: 'Assistant reply (may be empty when only tool calls are issued)…',
  tool: 'Tool result payload (often JSON)…',
};

/* ── Shared compact tools editor (also used for dataset default tools) ── */

export function ToolsEditor({
  tools,
  onChange,
  emptyHint,
}: {
  tools: ToolDraft[];
  onChange: (tools: ToolDraft[]) => void;
  emptyHint?: string;
}) {
  const update = (idx: number, patch: Partial<ToolDraft>) =>
    onChange(tools.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  return (
    <Stack gap="xs">
      {tools.length === 0 && emptyHint ? (
        <Text size="xs" c="dimmed">{emptyHint}</Text>
      ) : null}
      {tools.map((tool, idx) => (
        <Paper key={idx} withBorder radius="md" p="xs">
          <Group gap="xs" align="flex-start" wrap="nowrap" mb={6}>
            <TextInput
              size="xs"
              placeholder="tool_name"
              styles={MONO_INPUT}
              style={{ width: 200 }}
              value={tool.name}
              onChange={(e) => update(idx, { name: e.currentTarget.value })}
            />
            <TextInput
              size="xs"
              placeholder="Description (optional)"
              style={{ flex: 1 }}
              value={tool.description}
              onChange={(e) => update(idx, { description: e.currentTarget.value })}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              aria-label="Remove tool"
              onClick={() => onChange(tools.filter((_, i) => i !== idx))}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
          <Textarea
            size="xs"
            placeholder='Parameters JSON schema (optional) — e.g. { "type": "object", "properties": { "city": { "type": "string" } } }'
            autosize
            minRows={1}
            styles={MONO_INPUT}
            value={tool.parametersText}
            onChange={(e) => update(idx, { parametersText: e.currentTarget.value })}
            error={jsonTextError(tool.parametersText, { requireObject: true })}
          />
        </Paper>
      ))}
      <Button
        variant="light"
        size="compact-xs"
        leftSection={<IconPlus size={12} />}
        onClick={() => onChange([...tools, emptyToolDraft()])}
        style={{ alignSelf: 'flex-start' }}
      >
        Add tool
      </Button>
    </Stack>
  );
}

/* ── The editor overlay ────────────────────────────────────────────── */

export interface DatasetItemEditorProps {
  opened: boolean;
  /** Item to edit; null/undefined → start blank (create). */
  item?: EvalDatasetItemView | null;
  /** Id editable (create flows) or read-only (editing an existing item). */
  idEditable?: boolean;
  /** Ids of OTHER items in the dataset (duplicate-id guard on create). */
  existingIds?: string[];
  /** Suggested id when starting blank. */
  suggestedId?: string;
  /** Dataset default tools, prefilled when the item defines none. */
  defaultTools?: EvalToolDefinitionView[];
  title?: string;
  saving?: boolean;
  onClose: () => void;
  onSave: (item: EvalDatasetItemView) => void;
}

type EditorTab = 'form' | 'json';

export default function DatasetItemEditor({
  opened,
  item = null,
  idEditable = false,
  existingIds = [],
  suggestedId,
  defaultTools,
  title,
  saving = false,
  onClose,
  onSave,
}: DatasetItemEditorProps) {
  const [draft, setDraft] = useState<ItemDraft>(() => emptyItemDraft());
  const [tab, setTab] = useState<EditorTab>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonView, setJsonView] = useState<'edit' | 'tree'>('edit');
  const [tabError, setTabError] = useState<string | null>(null);

  /** Parsed JSON for the collapsible tree view (undefined when invalid). */
  const jsonTreeData = useMemo(() => {
    try {
      return JSON.parse(jsonText) as unknown;
    } catch {
      return undefined;
    }
  }, [jsonText]);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [assertionsOpen, setAssertionsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!opened) return;
    let next = item ? itemToDraft(item) : emptyItemDraft(suggestedId ?? '');
    if (next.tools.length === 0 && defaultTools && defaultTools.length > 0) {
      next = { ...next, tools: toolDefinitionsToDrafts(defaultTools) };
    }
    setDraft(next);
    setTab('form');
    setJsonText('');
    setTabError(null);
    setSaveErrors([]);
    setAssertionsOpen(
      next.mustContain.length > 0 ||
        next.mustNotContain.length > 0 ||
        next.equals !== '' ||
        next.regex !== '' ||
        next.jsonSchemaText !== '' ||
        next.jsonPathRules.length > 0,
    );
    setAdvancedOpen(next.toolResultRows.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  /* ── draft mutation helpers ── */
  const patchDraft = (patch: Partial<ItemDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const setTurn = (idx: number, patch: Partial<TurnDraft>) =>
    setDraft((prev) => ({
      ...prev,
      turns: prev.turns.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    }));
  const addTurn = (at: number, role: EvalRoleView) =>
    setDraft((prev) => {
      const turns = [...prev.turns];
      turns.splice(Math.max(0, Math.min(at, turns.length)), 0, emptyTurnDraft(role));
      return { ...prev, turns };
    });
  const removeTurn = (idx: number) =>
    setDraft((prev) => ({ ...prev, turns: prev.turns.filter((_, i) => i !== idx) }));
  const moveTurn = (idx: number, dir: -1 | 1) =>
    setDraft((prev) => {
      const to = idx + dir;
      if (to < 0 || to >= prev.turns.length) return prev;
      const turns = [...prev.turns];
      [turns[idx], turns[to]] = [turns[to], turns[idx]];
      return { ...prev, turns };
    });

  const toolNames = declaredToolNames(draft.tools);
  const missingTools = useMemo(
    () => inferMissingToolNames(draft.turns, draft.tools),
    [draft.turns, draft.tools],
  );

  /* ── live validity (summary / footer) ── */
  const liveResult = useMemo(() => draftToItem(draft), [draft]);
  const liveJsonError = useMemo(() => {
    if (tab !== 'json') return null;
    const syntax = jsonTextError(jsonText);
    if (syntax) return syntax;
    const parsed = parseItemJson(jsonText);
    return 'error' in parsed ? parsed.error : null;
  }, [tab, jsonText]);

  /* ── tab switching (two-way sync; invalid JSON blocks the switch) ── */
  const switchTab = (next: EditorTab) => {
    if (next === tab) return;
    if (next === 'json') {
      const result = draftToItem(draft);
      if (!result.item) {
        setTabError(`Fix the form before switching to JSON — ${result.errors[0]}`);
        return;
      }
      setJsonText(itemToJsonText(result.item));
      setTab('json');
      setTabError(null);
    } else {
      const parsed = parseItemJson(jsonText);
      if ('error' in parsed) {
        setTabError(parsed.error);
        return;
      }
      setDraft(itemToDraft(parsed.item));
      setTab('form');
      setTabError(null);
    }
  };

  /* ── save ── */
  const handleSave = () => {
    let result;
    if (tab === 'json') {
      const parsed = parseItemJson(jsonText);
      if ('error' in parsed) {
        setSaveErrors([parsed.error]);
        return;
      }
      // Normalize + validate through the same draft pipeline as the form.
      result = draftToItem(itemToDraft(parsed.item));
    } else {
      result = draftToItem(draft);
    }
    if (!result.item) {
      setSaveErrors(result.errors);
      return;
    }
    let finalItem = result.item;
    if (!idEditable && item) {
      // The id is immutable while editing an existing item — even via raw JSON.
      finalItem = { ...finalItem, id: item.id };
    } else if (existingIds.includes(finalItem.id)) {
      setSaveErrors([`An item with id "${finalItem.id}" already exists.`]);
      return;
    }
    setSaveErrors([]);
    onSave(finalItem);
  };

  /* ── summary aside ── */
  const summary = (
    <SummaryGroup title="Item">
      <SummaryKV label="Id" value={draft.id || '—'} mono />
      <SummaryKV label="Turns" value={String(draft.turns.length)} />
      <SummaryKV label="Tools" value={String(draft.tools.length)} />
      <SummaryKV label="Expected calls" value={String(draft.expectedToolCalls.length)} />
      <Checklist
        items={[
          { id: 'id', label: 'Id provided', done: draft.id.trim() !== '' },
          {
            id: 'conv',
            label: 'Conversation has content',
            done: draft.turns.some((t) => t.content.trim() !== '' || t.toolCalls.length > 0),
          },
          { id: 'valid', label: 'All fields valid', done: tab === 'json' ? !liveJsonError : liveResult.errors.length === 0 },
        ]}
      />
    </SummaryGroup>
  );

  const conversationDone = draft.turns.some((t) => t.content.trim() !== '' || t.toolCalls.length > 0);

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconListCheck size={16} />}
      title={title ?? (idEditable ? 'New dataset item' : `Edit item · ${item?.id ?? ''}`)}
      subtitle="Conversation, tools, and expectations for one test case."
      summary={summary}
      footerStatus={
        tab === 'json'
          ? liveJsonError
            ? 'JSON has issues'
            : 'JSON valid'
          : liveResult.errors.length === 0
            ? 'Ready to save'
            : `${liveResult.errors.length} issue(s)`
      }
      primaryAction={{
        label: 'Save item',
        icon: <IconCheck size={13} />,
        loading: saving,
        onClick: handleSave,
      }}
    >
      <Group justify="space-between" align="center" mb={4}>
        <ChipPicker<EditorTab>
          value={tab}
          onChange={(v) => switchTab(v as EditorTab)}
          options={[
            { value: 'form', label: 'Form' },
            { value: 'json', label: 'Raw JSON' },
          ]}
        />
        {tabError ? (
          <Text size="xs" c="red">{tabError}</Text>
        ) : null}
      </Group>

      {saveErrors.length > 0 ? (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Cannot save" mb="sm">
          <Stack gap={2}>
            {saveErrors.map((err, i) => (
              <Text key={i} size="xs">{err}</Text>
            ))}
          </Stack>
        </Alert>
      ) : null}

      {tab === 'json' ? (
        <FormSection number={1} title="Item JSON" done={!liveJsonError}>
          <FormField
            label="Whole item"
            action={
              <SegmentedControl
                size="xs"
                value={jsonView}
                onChange={(v) => setJsonView(v as 'edit' | 'tree')}
                data={[
                  { value: 'edit', label: 'Edit' },
                  { value: 'tree', label: 'Tree' },
                ]}
              />
            }
            hint="Full control — the same item shape the dataset JSON mode accepts. Tree view is read-only with collapsible nodes; switching back to the form validates and syncs this JSON."
          >
            {jsonView === 'tree' ? (
              jsonTreeData !== undefined ? (
                <JsonTreeViewer data={jsonTreeData} initialExpandLevel={2} />
              ) : (
                <Text size="sm" c="red">
                  JSON is not parseable — fix it in Edit view first.
                </Text>
              )
            ) : (
              <Textarea
                autosize
                minRows={18}
                styles={MONO_INPUT}
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.currentTarget.value);
                  setTabError(null);
                }}
                error={jsonTextError(jsonText)}
              />
            )}
          </FormField>
        </FormSection>
      ) : (
        <>
          <FormSection number={1} title="Identity" done={draft.id.trim() !== ''} collapsible>
            <FormRow cols={2}>
              <FormField label="Item id" required hint={idEditable ? undefined : 'Read-only while editing an existing item.'}>
                <TextInput
                  size="sm"
                  styles={MONO_INPUT}
                  value={draft.id}
                  readOnly={!idEditable}
                  disabled={!idEditable}
                  onChange={(e) => patchDraft({ id: e.currentTarget.value })}
                />
              </FormField>
              <FormField label="Tags" optional>
                <TagsInput
                  size="sm"
                  placeholder="Add tag…"
                  value={draft.tags}
                  onChange={(tags) => patchDraft({ tags })}
                />
              </FormField>
            </FormRow>
          </FormSection>

          <FormSection number={2} title="Conversation" done={conversationDone} collapsible>
            <Stack gap="xs">
              {draft.turns.map((turn, idx) => (
                <Paper key={idx} withBorder radius="md" p="xs">
                  <Group gap={6} mb={6} wrap="nowrap">
                    <Select
                      size="xs"
                      data={EVAL_ROLES}
                      value={turn.role}
                      onChange={(v) => v && setTurn(idx, { role: v as EvalRoleView })}
                      allowDeselect={false}
                      style={{ width: 120 }}
                      aria-label="Turn role"
                    />
                    <div style={{ flex: 1 }} />
                    <ActionIcon variant="subtle" color="gray" size="sm" disabled={idx === 0} onClick={() => moveTurn(idx, -1)} aria-label="Move turn up">
                      <IconArrowUp size={14} />
                    </ActionIcon>
                    <ActionIcon variant="subtle" color="gray" size="sm" disabled={idx === draft.turns.length - 1} onClick={() => moveTurn(idx, 1)} aria-label="Move turn down">
                      <IconArrowDown size={14} />
                    </ActionIcon>
                    <Menu withinPortal position="bottom-end" withArrow>
                      <Menu.Target>
                        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Insert turn">
                          <IconPlus size={14} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Label>Add above</Menu.Label>
                        {EVAL_ROLES.map((role) => (
                          <Menu.Item key={`above-${role}`} onClick={() => addTurn(idx, role)}>{role}</Menu.Item>
                        ))}
                        <Menu.Divider />
                        <Menu.Label>Add below</Menu.Label>
                        {EVAL_ROLES.map((role) => (
                          <Menu.Item key={`below-${role}`} onClick={() => addTurn(idx + 1, role)}>{role}</Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      disabled={draft.turns.length === 1}
                      onClick={() => removeTurn(idx)}
                      aria-label="Delete turn"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>

                  <Textarea
                    size="xs"
                    autosize
                    minRows={1}
                    placeholder={ROLE_PLACEHOLDER[turn.role]}
                    styles={MONO_INPUT}
                    value={turn.content}
                    onChange={(e) => setTurn(idx, { content: e.currentTarget.value })}
                  />

                  {turn.role === 'assistant' ? (
                    <Stack gap={6} mt={6}>
                      {turn.toolCalls.map((call, callIdx) => (
                        <Paper key={callIdx} radius="sm" p={6} style={{ background: 'var(--ds-surface-2, var(--mantine-color-default-hover))' }}>
                          <Group gap={6} align="flex-start" wrap="nowrap" mb={4}>
                            <TextInput
                              size="xs"
                              placeholder="call id (optional)"
                              styles={MONO_INPUT}
                              style={{ width: 140 }}
                              value={call.id}
                              onChange={(e) =>
                                setTurn(idx, {
                                  toolCalls: turn.toolCalls.map((c, i) => (i === callIdx ? { ...c, id: e.currentTarget.value } : c)),
                                })
                              }
                            />
                            <Autocomplete
                              size="xs"
                              placeholder="tool name"
                              data={toolNames}
                              styles={MONO_INPUT}
                              style={{ flex: 1 }}
                              value={call.name}
                              onChange={(name) =>
                                setTurn(idx, {
                                  toolCalls: turn.toolCalls.map((c, i) => (i === callIdx ? { ...c, name } : c)),
                                })
                              }
                            />
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              size="sm"
                              aria-label="Remove tool call"
                              onClick={() =>
                                setTurn(idx, { toolCalls: turn.toolCalls.filter((_, i) => i !== callIdx) })
                              }
                            >
                              <IconTrash size={13} />
                            </ActionIcon>
                          </Group>
                          <Textarea
                            size="xs"
                            autosize
                            minRows={1}
                            placeholder='args JSON — e.g. { "city": "Paris" }'
                            styles={MONO_INPUT}
                            value={call.argsText}
                            onChange={(e) =>
                              setTurn(idx, {
                                toolCalls: turn.toolCalls.map((c, i) => (i === callIdx ? { ...c, argsText: e.currentTarget.value } : c)),
                              })
                            }
                            error={jsonTextError(call.argsText, { requireObject: true })}
                          />
                        </Paper>
                      ))}
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        leftSection={<IconPlus size={12} />}
                        onClick={() => setTurn(idx, { toolCalls: [...turn.toolCalls, emptyToolCallDraft()] })}
                        style={{ alignSelf: 'flex-start' }}
                      >
                        Tool call
                      </Button>
                    </Stack>
                  ) : null}

                  {turn.role === 'tool' ? (
                    <Group gap={6} mt={6} wrap="nowrap">
                      <Autocomplete
                        size="xs"
                        placeholder="toolCallId (from an assistant turn above)"
                        data={declaredToolCallIds(draft.turns, idx)}
                        styles={MONO_INPUT}
                        style={{ width: 260 }}
                        value={turn.toolCallId}
                        onChange={(toolCallId) => setTurn(idx, { toolCallId })}
                      />
                      <TextInput
                        size="xs"
                        placeholder="tool name (optional)"
                        styles={MONO_INPUT}
                        style={{ width: 200 }}
                        value={turn.name}
                        onChange={(e) => setTurn(idx, { name: e.currentTarget.value })}
                      />
                    </Group>
                  ) : null}
                </Paper>
              ))}
              <Group gap="xs">
                {EVAL_ROLES.map((role) => (
                  <Button
                    key={role}
                    variant="light"
                    size="compact-xs"
                    leftSection={<IconPlus size={12} />}
                    onClick={() => addTurn(draft.turns.length, role)}
                  >
                    {role}
                  </Button>
                ))}
              </Group>
            </Stack>
          </FormSection>

          <FormSection number={3} title="Tools" done={draft.tools.length > 0} collapsible>
            <FormField
              label="Tool definitions"
              optional
              hint="Tools exposed to the target for this item (never executed). Leave empty to inherit dataset defaults, when configured."
              action={
                <Button
                  variant="subtle"
                  size="compact-xs"
                  leftSection={<IconWand size={12} />}
                  disabled={missingTools.length === 0}
                  onClick={() => patchDraft({ tools: [...draft.tools, ...missingTools.map((n) => emptyToolDraft(n))] })}
                >
                  Load from conversation{missingTools.length > 0 ? ` (${missingTools.length})` : ''}
                </Button>
              }
            >
              <ToolsEditor
                tools={draft.tools}
                onChange={(tools) => patchDraft({ tools })}
                emptyHint="No tools defined for this item."
              />
            </FormField>
          </FormSection>

          <FormSection
            number={4}
            title="Expected"
            done={draft.reference.trim() !== '' || draft.expectedToolCalls.length > 0 || assertionsOpen}
            collapsible
          >
            <FormField label="Reference answer" optional hint="Gold answer used by judge / semantic scorers.">
              <Textarea
                size="sm"
                autosize
                minRows={2}
                placeholder="The ideal answer…"
                value={draft.reference}
                onChange={(e) => patchDraft({ reference: e.currentTarget.value })}
              />
            </FormField>

            <FormField label="Expected tool calls" optional hint="Consumed by the tool-call scorer; argsMatch controls how args are compared.">
              <Stack gap="xs">
                {draft.expectedToolCalls.map((call, idx) => (
                  <Paper key={idx} withBorder radius="md" p="xs">
                    <Group gap={6} wrap="nowrap" mb={call.argsMatch === 'ignore' ? 0 : 4}>
                      <Autocomplete
                        size="xs"
                        placeholder="tool name"
                        data={toolNames}
                        styles={MONO_INPUT}
                        style={{ flex: 1 }}
                        value={call.name}
                        onChange={(name) =>
                          patchDraft({
                            expectedToolCalls: draft.expectedToolCalls.map((c, i) => (i === idx ? { ...c, name } : c)),
                          })
                        }
                      />
                      <Select
                        size="xs"
                        data={ARGS_MATCH_MODES}
                        value={call.argsMatch}
                        allowDeselect={false}
                        onChange={(v) =>
                          v &&
                          patchDraft({
                            expectedToolCalls: draft.expectedToolCalls.map((c, i) =>
                              i === idx ? { ...c, argsMatch: v as EvalArgsMatchMode } : c,
                            ),
                          })
                        }
                        style={{ width: 110 }}
                        aria-label="Args match mode"
                      />
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        aria-label="Remove expected tool call"
                        onClick={() =>
                          patchDraft({ expectedToolCalls: draft.expectedToolCalls.filter((_, i) => i !== idx) })
                        }
                      >
                        <IconTrash size={13} />
                      </ActionIcon>
                    </Group>
                    {call.argsMatch === 'exact' || call.argsMatch === 'subset' ? (
                      <Textarea
                        size="xs"
                        autosize
                        minRows={1}
                        placeholder='expected args JSON — e.g. { "flightId": "AF123" }'
                        styles={MONO_INPUT}
                        value={call.argsText}
                        onChange={(e) =>
                          patchDraft({
                            expectedToolCalls: draft.expectedToolCalls.map((c, i) =>
                              i === idx ? { ...c, argsText: e.currentTarget.value } : c,
                            ),
                          })
                        }
                        error={jsonTextError(call.argsText, { requireObject: true })}
                      />
                    ) : null}
                    {call.argsMatch === 'schema' ? (
                      <Textarea
                        size="xs"
                        autosize
                        minRows={1}
                        placeholder='argsSchema JSON — e.g. { "type": "object", "required": ["flightId"] }'
                        styles={MONO_INPUT}
                        value={call.argsSchemaText}
                        onChange={(e) =>
                          patchDraft({
                            expectedToolCalls: draft.expectedToolCalls.map((c, i) =>
                              i === idx ? { ...c, argsSchemaText: e.currentTarget.value } : c,
                            ),
                          })
                        }
                        error={jsonTextError(call.argsSchemaText, { requireObject: true })}
                      />
                    ) : null}
                  </Paper>
                ))}
                <Button
                  variant="light"
                  size="compact-xs"
                  leftSection={<IconPlus size={12} />}
                  onClick={() => patchDraft({ expectedToolCalls: [...draft.expectedToolCalls, emptyExpectedToolCallDraft()] })}
                  style={{ alignSelf: 'flex-start' }}
                >
                  Expected tool call
                </Button>
              </Stack>
            </FormField>

            <Button
              variant="subtle"
              size="compact-xs"
              leftSection={assertionsOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              onClick={() => setAssertionsOpen((o) => !o)}
              style={{ alignSelf: 'flex-start' }}
            >
              Assertions
            </Button>
            <Collapse in={assertionsOpen}>
              <Stack gap="xs" mt={4}>
                <FormRow cols={2}>
                  <FormField label="Must contain" optional>
                    <TagsInput
                      size="xs"
                      placeholder="Add substring…"
                      value={draft.mustContain}
                      onChange={(mustContain) => patchDraft({ mustContain })}
                    />
                  </FormField>
                  <FormField label="Must NOT contain" optional>
                    <TagsInput
                      size="xs"
                      placeholder="Add substring…"
                      value={draft.mustNotContain}
                      onChange={(mustNotContain) => patchDraft({ mustNotContain })}
                    />
                  </FormField>
                </FormRow>
                <FormRow cols={2}>
                  <FormField label="Equals (exact match)" optional>
                    <TextInput
                      size="xs"
                      styles={MONO_INPUT}
                      value={draft.equals}
                      onChange={(e) => patchDraft({ equals: e.currentTarget.value })}
                    />
                  </FormField>
                  <FormField label="Regex" optional>
                    <TextInput
                      size="xs"
                      styles={MONO_INPUT}
                      placeholder="e.g. ^\\d+$"
                      value={draft.regex}
                      onChange={(e) => patchDraft({ regex: e.currentTarget.value })}
                      error={(() => {
                        if (!draft.regex.trim()) return null;
                        try {
                          new RegExp(draft.regex);
                          return null;
                        } catch {
                          return 'Does not compile';
                        }
                      })()}
                    />
                  </FormField>
                </FormRow>
                <FormField label="JSON schema" optional hint="Parsed output must satisfy this schema.">
                  <Textarea
                    size="xs"
                    autosize
                    minRows={1}
                    placeholder='{ "type": "object", "required": ["name"] }'
                    styles={MONO_INPUT}
                    value={draft.jsonSchemaText}
                    onChange={(e) => patchDraft({ jsonSchemaText: e.currentTarget.value })}
                    error={jsonTextError(draft.jsonSchemaText, { requireObject: true })}
                  />
                </FormField>
                <FormField label="JSON path assertions" optional>
                  <Stack gap={6}>
                    {draft.jsonPathRules.map((rule, idx) => (
                      <Group key={idx} gap={6} wrap="nowrap" align="center">
                        <TextInput
                          size="xs"
                          placeholder="data.items[0].name"
                          styles={MONO_INPUT}
                          style={{ flex: 1 }}
                          value={rule.path}
                          onChange={(e) =>
                            patchDraft({
                              jsonPathRules: draft.jsonPathRules.map((r, i) => (i === idx ? { ...r, path: e.currentTarget.value } : r)),
                            })
                          }
                        />
                        <Checkbox
                          size="xs"
                          label="exists"
                          checked={rule.exists}
                          onChange={(e) =>
                            patchDraft({
                              jsonPathRules: draft.jsonPathRules.map((r, i) => (i === idx ? { ...r, exists: e.currentTarget.checked } : r)),
                            })
                          }
                        />
                        <TextInput
                          size="xs"
                          placeholder="equals (JSON or text)"
                          styles={MONO_INPUT}
                          style={{ width: 180 }}
                          value={rule.equalsText}
                          onChange={(e) =>
                            patchDraft({
                              jsonPathRules: draft.jsonPathRules.map((r, i) => (i === idx ? { ...r, equalsText: e.currentTarget.value } : r)),
                            })
                          }
                        />
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size="sm"
                          aria-label="Remove assertion"
                          onClick={() => patchDraft({ jsonPathRules: draft.jsonPathRules.filter((_, i) => i !== idx) })}
                        >
                          <IconTrash size={13} />
                        </ActionIcon>
                      </Group>
                    ))}
                    <Button
                      variant="light"
                      size="compact-xs"
                      leftSection={<IconPlus size={12} />}
                      onClick={() => patchDraft({ jsonPathRules: [...draft.jsonPathRules, emptyJsonPathRuleDraft()] })}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      Add assertion
                    </Button>
                  </Stack>
                </FormField>
              </Stack>
            </Collapse>
          </FormSection>

          <FormSection number={5} title="Advanced" done={draft.toolResultRows.length > 0} collapsible defaultOpen={false}>
            <Button
              variant="subtle"
              size="compact-xs"
              leftSection={advancedOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              onClick={() => setAdvancedOpen((o) => !o)}
              style={{ alignSelf: 'flex-start' }}
            >
              Canned tool results ({draft.toolResultRows.length})
            </Button>
            <Collapse in={advancedOpen}>
              <FormField
                label="Tool results"
                optional
                hint={<>Key format: <span className="ds-mono">name(&#123;&quot;arg&quot;:&quot;value&quot;&#125;)</span> — canonical JSON args. Values are strict JSON (quote plain strings).</>}
              >
                <Stack gap={6} mt={4}>
                  {draft.toolResultRows.map((row, idx) => (
                    <Group key={idx} gap={6} wrap="nowrap" align="flex-start">
                      <TextInput
                        size="xs"
                        placeholder='search_flights({"city":"Paris"})'
                        styles={MONO_INPUT}
                        style={{ width: 280 }}
                        value={row.key}
                        onChange={(e) =>
                          patchDraft({
                            toolResultRows: draft.toolResultRows.map((r, i) => (i === idx ? { ...r, key: e.currentTarget.value } : r)),
                          })
                        }
                      />
                      <Textarea
                        size="xs"
                        autosize
                        minRows={1}
                        placeholder='{"flights":[{"id":"AF123"}]}'
                        styles={MONO_INPUT}
                        style={{ flex: 1 }}
                        value={row.valueText}
                        onChange={(e) =>
                          patchDraft({
                            toolResultRows: draft.toolResultRows.map((r, i) => (i === idx ? { ...r, valueText: e.currentTarget.value } : r)),
                          })
                        }
                        error={row.valueText.trim() ? jsonTextError(row.valueText) : null}
                      />
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        aria-label="Remove tool result"
                        onClick={() => patchDraft({ toolResultRows: draft.toolResultRows.filter((_, i) => i !== idx) })}
                      >
                        <IconTrash size={13} />
                      </ActionIcon>
                    </Group>
                  ))}
                  <Button
                    variant="light"
                    size="compact-xs"
                    leftSection={<IconPlus size={12} />}
                    onClick={() => patchDraft({ toolResultRows: [...draft.toolResultRows, { key: '', valueText: '' }] })}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Add tool result
                  </Button>
                </Stack>
              </FormField>
            </Collapse>
          </FormSection>
        </>
      )}
    </FormShell>
  );
}
