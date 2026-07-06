'use client';

import { useEffect, useState } from 'react';
import {
  Badge,
  Card,
  Checkbox,
  Divider,
  Group,
  MultiSelect,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconFingerprint,
  IconAlertOctagon,
  IconShieldLock,
  IconRobot,
  IconInfoCircle,
  IconFilterX,
} from '@tabler/icons-react';
import type { IGuardrailPresetPolicy } from '@/lib/database';
import { PII_CATEGORIES, MODERATION_CATEGORIES, WORD_FILTER_BUILTIN_LISTS } from '@/lib/services/guardrail/constants';
import type { PiiCategoryDefinition, ModerationCategoryDefinition } from '@/lib/services/guardrail/constants';

interface ModelOption {
  value: string;
  label: string;
}

interface GuardrailPolicyEditorProps {
  type: 'preset' | 'custom';
  policy: IGuardrailPresetPolicy | undefined;
  customPrompt: string | undefined;
  modelKey: string | undefined;
  models: ModelOption[];
  onChange: (changes: {
    policy?: IGuardrailPresetPolicy;
    customPrompt?: string;
    modelKey?: string;
  }) => void;
  readOnly?: boolean;
}

// ── PII section ───────────────────────────────────────────────────────────

function PiiSection({
  pii,
  onChange,
  readOnly,
}: {
  pii: NonNullable<IGuardrailPresetPolicy['pii']>;
  onChange: (pii: NonNullable<IGuardrailPresetPolicy['pii']>) => void;
  readOnly?: boolean;
}) {
  const enabledCount = Object.values(pii.categories || {}).filter(Boolean).length;

  return (
    <Card withBorder p="sm">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <ThemeIcon size={28} radius="sm" variant="light" color="blue">
              <IconFingerprint size={15} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm">PII Detection</Text>
              <Text size="xs" c="dimmed">Detect sensitive personal information using pattern matching</Text>
            </div>
          </Group>
          <Switch
            checked={pii.enabled}
            onChange={(e) => onChange({ ...pii, enabled: e.currentTarget.checked })}
            disabled={readOnly}
          />
        </Group>

        {pii.enabled && (
          <>
            <Divider />
            <Select
              label="Action on detection"
              size="xs"
              data={[
                { value: 'block', label: 'Block the request' },
                { value: 'redact', label: 'Redact — mask the values and continue' },
                { value: 'warn', label: 'Warn and continue' },
                { value: 'flag', label: 'Flag for review' },
              ]}
              value={pii.action ?? 'block'}
              onChange={(v) => onChange({ ...pii, action: (v ?? 'block') as 'block' | 'redact' | 'warn' | 'flag' })}
              disabled={readOnly}
            />
            <div>
              <Group justify="space-between" mb={6}>
                <Text size="xs" fw={500}>Detect categories</Text>
                <Badge size="xs" variant="light">{enabledCount} enabled</Badge>
              </Group>
              <SimpleGrid cols={2} spacing="xs">
                {PII_CATEGORIES.map((cat: PiiCategoryDefinition) => (
                  <Tooltip key={cat.id} label={cat.description} withArrow multiline w={220} position="top">
                    <Checkbox
                      size="xs"
                      label={cat.label}
                      checked={pii.categories?.[cat.id] ?? false}
                      onChange={(e) =>
                        onChange({
                          ...pii,
                          categories: {
                            ...pii.categories,
                            [cat.id]: e.currentTarget.checked,
                          },
                        })
                      }
                      disabled={readOnly}
                    />
                  </Tooltip>
                ))}
              </SimpleGrid>
            </div>
          </>
        )}
      </Stack>
    </Card>
  );
}

// ── Word filter section ───────────────────────────────────────────────────

interface WordListSummary {
  key: string;
  name: string;
  wordCount: number;
}

function WordFilterSection({
  wordFilter,
  onChange,
  readOnly,
}: {
  wordFilter: NonNullable<IGuardrailPresetPolicy['wordFilter']>;
  onChange: (wf: NonNullable<IGuardrailPresetPolicy['wordFilter']>) => void;
  readOnly?: boolean;
}) {
  const [customLists, setCustomLists] = useState<WordListSummary[]>([]);

  useEffect(() => {
    if (!wordFilter.enabled) return;
    let cancelled = false;
    fetch('/api/guardrails/word-lists', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { wordLists: [] }))
      .then((data) => {
        if (!cancelled) setCustomLists(data.wordLists ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wordFilter.enabled]);

  // Keep deleted-list keys visible in the select so the user can unselect them.
  const customListOptions = [
    ...customLists.map((list) => ({
      value: list.key,
      label: `${list.name} (${list.wordCount} words)`,
    })),
    ...(wordFilter.customListKeys ?? [])
      .filter((key) => !customLists.some((list) => list.key === key))
      .map((key) => ({ value: key, label: `${key} (missing)` })),
  ];

  return (
    <Card withBorder p="sm">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <ThemeIcon size={28} radius="sm" variant="light" color="grape">
              <IconFilterX size={15} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm">Word Filter</Text>
              <Text size="xs" c="dimmed">Deterministic banned-word and profanity matching — no LLM, catches leetspeak and spaced-out evasion</Text>
            </div>
          </Group>
          <Switch
            checked={wordFilter.enabled}
            onChange={(e) => onChange({ ...wordFilter, enabled: e.currentTarget.checked })}
            disabled={readOnly}
          />
        </Group>

        {wordFilter.enabled && (
          <>
            <Divider />
            <Select
              label="Action on detection"
              size="xs"
              data={[
                { value: 'block', label: 'Block the request' },
                { value: 'redact', label: 'Redact — mask the words and continue' },
                { value: 'warn', label: 'Warn and continue' },
                { value: 'flag', label: 'Flag for review' },
              ]}
              value={wordFilter.action ?? 'block'}
              onChange={(v) => onChange({ ...wordFilter, action: (v ?? 'block') as 'block' | 'redact' | 'warn' | 'flag' })}
              disabled={readOnly}
            />
            <div>
              <Text size="xs" fw={500} mb={6}>Built-in lists</Text>
              <SimpleGrid cols={2} spacing="xs">
                {WORD_FILTER_BUILTIN_LISTS.map((list) => (
                  <Tooltip key={list.id} label={list.description} withArrow multiline w={220} position="top">
                    <Checkbox
                      size="xs"
                      label={list.label}
                      checked={wordFilter.builtinLists?.[list.id] ?? list.defaultEnabled}
                      onChange={(e) =>
                        onChange({
                          ...wordFilter,
                          builtinLists: {
                            ...wordFilter.builtinLists,
                            [list.id]: e.currentTarget.checked,
                          },
                        })
                      }
                      disabled={readOnly}
                    />
                  </Tooltip>
                ))}
              </SimpleGrid>
            </div>
            <MultiSelect
              label="Uploaded word lists"
              size="xs"
              description="Tenant word lists (CSV/TXT uploads) to apply. Manage them from the Guardrails page → Word lists."
              placeholder={customListOptions.length ? 'Select lists…' : 'No uploaded lists yet'}
              data={customListOptions}
              value={wordFilter.customListKeys ?? []}
              onChange={(customListKeys) => onChange({ ...wordFilter, customListKeys })}
              disabled={readOnly}
              searchable
              clearable
            />
            <TagsInput
              label="Custom banned words"
              size="xs"
              description="Matched after normalization (case, diacritics, leetspeak). Press Enter to add."
              placeholder="Add a word…"
              value={wordFilter.words ?? []}
              onChange={(words) => onChange({ ...wordFilter, words })}
              disabled={readOnly}
            />
            <Textarea
              label="Custom regex patterns"
              size="xs"
              description="One pattern per line, evaluated case-insensitively against the raw text."
              placeholder={'\\bcompetitor-name\\b\ninternal-codename-\\d+'}
              value={(wordFilter.regexes ?? []).join('\n')}
              onChange={(e) =>
                onChange({
                  ...wordFilter,
                  regexes: e.currentTarget.value.split('\n').filter((line) => line.trim() !== ''),
                })
              }
              minRows={2}
              autosize
              readOnly={readOnly}
            />
          </>
        )}
      </Stack>
    </Card>
  );
}

// ── Moderation section ────────────────────────────────────────────────────

function ModerationSection({
  moderation,
  models,
  onChange,
  readOnly,
}: {
  moderation: NonNullable<IGuardrailPresetPolicy['moderation']>;
  models: ModelOption[];
  onChange: (mod: NonNullable<IGuardrailPresetPolicy['moderation']>) => void;
  readOnly?: boolean;
}) {
  const enabledCount = Object.values(moderation.categories || {}).filter(Boolean).length;

  return (
    <Card withBorder p="sm">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <ThemeIcon size={28} radius="sm" variant="light" color="red">
              <IconAlertOctagon size={15} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm">Content Moderation</Text>
              <Text size="xs" c="dimmed">LLM-based detection of harmful and policy-violating content</Text>
            </div>
          </Group>
          <Switch
            checked={moderation.enabled}
            onChange={(e) => onChange({ ...moderation, enabled: e.currentTarget.checked })}
            disabled={readOnly}
          />
        </Group>

        {moderation.enabled && (
          <>
            <Divider />
            {models.length > 0 && (
              <Select
                label="Model"
                size="xs"
                placeholder="Select an LLM model…"
                data={models}
                value={moderation.modelKey ?? null}
                onChange={(v) => onChange({ ...moderation, modelKey: v ?? undefined })}
                disabled={readOnly}
                description="LLM used to classify content violations"
              />
            )}
            <div>
              <Group justify="space-between" mb={6}>
                <Text size="xs" fw={500}>Categories to detect</Text>
                <Badge size="xs" variant="light">{enabledCount} enabled</Badge>
              </Group>
              <SimpleGrid cols={2} spacing="xs">
                {MODERATION_CATEGORIES.map((cat: ModerationCategoryDefinition) => (
                  <Checkbox
                    key={cat.id}
                    size="xs"
                    label={cat.label}
                    checked={moderation.categories?.[cat.id] ?? false}
                    onChange={(e) =>
                      onChange({
                        ...moderation,
                        categories: {
                          ...moderation.categories,
                          [cat.id]: e.currentTarget.checked,
                        },
                      })
                    }
                    disabled={readOnly}
                  />
                ))}
              </SimpleGrid>
            </div>
          </>
        )}
      </Stack>
    </Card>
  );
}

// ── Prompt Shield section ─────────────────────────────────────────────────

function PromptShieldSection({
  promptShield,
  models,
  onChange,
  readOnly,
}: {
  promptShield: NonNullable<IGuardrailPresetPolicy['promptShield']>;
  models: ModelOption[];
  onChange: (ps: NonNullable<IGuardrailPresetPolicy['promptShield']>) => void;
  readOnly?: boolean;
}) {
  return (
    <Card withBorder p="sm">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <ThemeIcon size={28} radius="sm" variant="light" color="orange">
              <IconShieldLock size={15} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm">Prompt Shield</Text>
              <Text size="xs" c="dimmed">Detect prompt injection and jailbreak attempts</Text>
            </div>
          </Group>
          <Switch
            checked={promptShield.enabled}
            onChange={(e) => onChange({ ...promptShield, enabled: e.currentTarget.checked })}
            disabled={readOnly}
          />
        </Group>

        {promptShield.enabled && (
          <>
            <Divider />
            {models.length > 0 && (
              <Select
                label="Model"
                size="xs"
                placeholder="Select an LLM model…"
                data={models}
                value={promptShield.modelKey ?? null}
                onChange={(v) => onChange({ ...promptShield, modelKey: v ?? undefined })}
                disabled={readOnly}
                description="LLM used to detect injection attempts"
              />
            )}
            <Select
              label="Sensitivity"
              size="xs"
              data={[
                { value: 'low', label: 'Low — only clear violations' },
                { value: 'balanced', label: 'Balanced — recommended' },
                { value: 'high', label: 'High — flag anything suspicious' },
              ]}
              value={promptShield.sensitivity ?? 'balanced'}
              onChange={(v) =>
                onChange({ ...promptShield, sensitivity: (v ?? 'balanced') as 'low' | 'balanced' | 'high' })
              }
              disabled={readOnly}
            />
          </>
        )}
      </Stack>
    </Card>
  );
}

// ── Main editor ───────────────────────────────────────────────────────────

export default function GuardrailPolicyEditor({
  type,
  policy,
  customPrompt,
  modelKey,
  models,
  onChange,
  readOnly,
}: GuardrailPolicyEditorProps) {
  const safePolicy: IGuardrailPresetPolicy = policy ?? {
    pii: { enabled: true, action: 'block', categories: {} },
    moderation: { enabled: false, categories: {} },
    promptShield: { enabled: false, sensitivity: 'balanced' },
  };

  const updatePolicy = (partial: Partial<IGuardrailPresetPolicy>) => {
    onChange({ policy: { ...safePolicy, ...partial } });
  };

  if (type === 'custom') {
    return (
      <Stack gap="md">
        <Card withBorder p="sm">
          <Stack gap="sm">
            <Group gap="xs">
              <ThemeIcon size={28} radius="sm" variant="light" color="teal">
                <IconRobot size={15} />
              </ThemeIcon>
              <div>
                <Text fw={600} size="sm">Custom Rule Configuration</Text>
                <Text size="xs" c="dimmed">The LLM will evaluate each message against your rule</Text>
              </div>
            </Group>
            <Divider />
            {models.length > 0 && (
              <Select
                label="Model"
                placeholder="Select an LLM model…"
                required
                data={models}
                value={modelKey ?? null}
                onChange={(v) => onChange({ modelKey: v ?? undefined })}
                disabled={readOnly}
                description="LLM used to evaluate this guardrail rule"
              />
            )}
            <Textarea
              label="Rule definition"
              description={
                <Group gap={4}>
                  <IconInfoCircle size={12} />
                  <span>Describe what content should FAIL this rule. Be specific and clear.</span>
                </Group>
              }
              placeholder={
                'Example: Block any message that requests personally identifiable information about real individuals, attempts to impersonate authority figures, or contains disguised requests for harmful content.'
              }
              value={customPrompt ?? ''}
              onChange={(e) => onChange({ customPrompt: e.currentTarget.value })}
              minRows={5}
              readOnly={readOnly}
            />
          </Stack>
        </Card>
      </Stack>
    );
  }

  // Preset sections
  return (
    <Stack gap="md">
      <PiiSection
        pii={safePolicy.pii ?? { enabled: true, action: 'block', categories: {} }}
        onChange={(pii) => updatePolicy({ pii })}
        readOnly={readOnly}
      />
      <WordFilterSection
        wordFilter={safePolicy.wordFilter ?? { enabled: false, action: 'block' }}
        onChange={(wordFilter) => updatePolicy({ wordFilter })}
        readOnly={readOnly}
      />
      <ModerationSection
        moderation={safePolicy.moderation ?? { enabled: false, categories: {} }}
        models={models}
        onChange={(moderation) => updatePolicy({ moderation })}
        readOnly={readOnly}
      />
      <PromptShieldSection
        promptShield={safePolicy.promptShield ?? { enabled: false, sensitivity: 'balanced' }}
        models={models}
        onChange={(promptShield) => updatePolicy({ promptShield })}
        readOnly={readOnly}
      />
    </Stack>
  );
}
