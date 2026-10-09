'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconPlus,
  IconScale,
  IconTrash,
} from '@tabler/icons-react';

interface DecisionPlaygroundProps {
  modelKey: string;
}

type QuestionType = 'choice' | 'boolean' | 'score';

interface QuestionDraft {
  uid: number;
  id: string;
  type: QuestionType;
  instructions: string;
  /** choice: one `key: description` per line. */
  choices: string;
  /** score: one level label per line, lowest first. */
  levels: string;
}

interface AnswerView {
  type: 'choice' | 'boolean' | 'score' | 'refusal';
  choice?: string;
  probability?: number;
  score?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
  confidence?: number;
  confidence_source?: string;
}

interface DecisionResponse {
  answers: Record<string, AnswerView>;
  rationale?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  cost?: { totalCost?: number; currency?: string };
  latency_ms?: number;
  backend?: { kind: string; provider: string };
}

const SAMPLE_INPUT = 'I was charged twice for my subscription this month and nobody has answered my emails.';

let nextUid = 1;
const newQuestion = (partial: Partial<QuestionDraft> = {}): QuestionDraft => ({
  uid: nextUid++,
  id: '',
  type: 'choice',
  instructions: '',
  choices: '',
  levels: '',
  ...partial,
});

const sampleQuestions = (): QuestionDraft[] => [
  newQuestion({
    id: 'department',
    type: 'choice',
    instructions: 'Which team should handle this?',
    choices: 'billing: payments, invoices, refunds\ntechnical: bugs and outages\nother: anything else',
  }),
  newQuestion({ id: 'urgent', type: 'boolean', instructions: 'Is the customer asking for urgent help?' }),
  newQuestion({
    id: 'severity',
    type: 'score',
    instructions: 'How severe is the problem?',
    levels: 'Cosmetic\nWorkaround available\nFully blocked',
  }),
];

/** Builds the `questions` map, or throws an Error whose message names the problem. */
function buildQuestions(drafts: QuestionDraft[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const draft of drafts) {
    const id = draft.id.trim();
    if (!id) throw new Error('Every question needs an id.');
    if (id in out) throw new Error(`Question id "${id}" is used twice.`);
    const base = draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {};
    if (draft.type === 'boolean') {
      out[id] = { type: 'boolean', ...base };
    } else if (draft.type === 'choice') {
      const choices: Record<string, string> = {};
      for (const line of draft.choices.split('\n')) {
        if (!line.trim()) continue;
        const at = line.indexOf(':');
        const key = (at === -1 ? line : line.slice(0, at)).trim();
        if (!key) continue;
        choices[key] = at === -1 ? key : line.slice(at + 1).trim() || key;
      }
      if (Object.keys(choices).length < 2) {
        throw new Error(`Question "${id}" needs at least two choices (one "key: description" per line).`);
      }
      out[id] = { type: 'choice', ...base, choices };
    } else {
      const levels = draft.levels.split('\n').map((l) => l.trim()).filter(Boolean);
      if (levels.length < 2) throw new Error(`Question "${id}" needs at least two levels (one per line).`);
      out[id] = { type: 'score', ...base, levels };
    }
  }
  if (Object.keys(out).length === 0) throw new Error('Add at least one question.');
  return out;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function ProbabilityBars({ probabilities, labels, highlight }: {
  probabilities: Record<string, number>;
  labels?: Record<string, string>;
  highlight?: string;
}) {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return (
    <Stack gap={4}>
      {entries.map(([key, value]) => (
        <div key={key}>
          <Group justify="space-between" gap="xs">
            <Text size="xs" fw={key === highlight ? 700 : 400}>
              {labels?.[key] ? `${key} · ${labels[key]}` : key}
            </Text>
            <Text size="xs" c="dimmed">{pct(value)}</Text>
          </Group>
          <Progress value={value * 100} size="sm" color={key === highlight ? 'violet' : 'gray'} />
        </div>
      ))}
    </Stack>
  );
}

function AnswerCard({ id, answer }: { id: string; answer: AnswerView }) {
  const confidence = typeof answer.confidence === 'number' ? (
    <Badge variant="light" color={answer.confidence_source === 'native' ? 'green' : 'yellow'}>
      confidence {pct(answer.confidence)} · {answer.confidence_source === 'native' ? 'native' : 'self-reported'}
    </Badge>
  ) : null;

  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600} size="sm">{id}</Text>
          <Badge variant="outline" size="sm">{answer.type}</Badge>
        </Group>
        {answer.type === 'refusal' ? (
          <Text size="sm" c="dimmed">The model declined to answer this question.</Text>
        ) : null}
        {answer.type === 'choice' ? (
          <>
            <Group gap="xs"><Badge color="violet" size="lg">{answer.choice}</Badge>{confidence}</Group>
            {answer.probabilities ? (
              <ProbabilityBars probabilities={answer.probabilities} highlight={answer.choice} />
            ) : null}
          </>
        ) : null}
        {answer.type === 'boolean' ? (
          <>
            <Group gap="xs">
              <Badge color={(answer.probability ?? 0) >= 0.5 ? 'green' : 'gray'} size="lg">
                {(answer.probability ?? 0) >= 0.5 ? 'yes' : 'no'}
              </Badge>
            </Group>
            <ProbabilityBars probabilities={{ yes: answer.probability ?? 0, no: 1 - (answer.probability ?? 0) }} highlight={(answer.probability ?? 0) >= 0.5 ? 'yes' : 'no'} />
          </>
        ) : null}
        {answer.type === 'score' ? (
          <>
            <Group gap="xs">
              <Badge color="violet" size="lg">score {answer.score?.toFixed(2)}</Badge>
              {confidence}
            </Group>
            {answer.probabilities ? (
              <ProbabilityBars probabilities={answer.probabilities} labels={answer.legend} />
            ) : null}
          </>
        ) : null}
      </Stack>
    </Paper>
  );
}

export default function DecisionPlayground({ modelKey }: DecisionPlaygroundProps) {
  const [input, setInput] = useState(SAMPLE_INPUT);
  const [questions, setQuestions] = useState<QuestionDraft[]>(sampleQuestions);
  const [includeRationale, setIncludeRationale] = useState(false);
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<DecisionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = (uid: number, patch: Partial<QuestionDraft>) =>
    setQuestions((prev) => prev.map((q) => (q.uid === uid ? { ...q, ...patch } : q)));

  const run = async () => {
    setError(null);
    let body: Record<string, unknown>;
    try {
      if (!input.trim()) throw new Error('Enter the text to decide on.');
      body = {
        model: modelKey,
        input: input.trim(),
        questions: buildQuestions(questions),
        ...(includeRationale ? { options: { include_rationale: true } } : {}),
      };
    } catch (err) {
      notifications.show({
        color: 'orange',
        title: 'Check the request',
        message: err instanceof Error ? err.message : 'Invalid request',
      });
      return;
    }

    setRunning(true);
    setResponse(null);
    try {
      const res = await fetch('/api/dashboard/playground/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
      setResponse(payload as DecisionResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Decision failed';
      setError(message);
      notifications.show({ color: 'red', title: 'Decision failed', message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group gap="xs">
            <IconScale size={18} />
            <Text fw={600}>Decision</Text>
          </Group>

          <Textarea
            label="Input"
            description="The text the model reads. The questions below are asked about it."
            autosize
            minRows={3}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
          />

          <Stack gap="xs">
            <Text size="sm" fw={500}>Questions</Text>
            {questions.map((q) => (
              <Paper key={q.uid} withBorder radius="sm" p="sm">
                <Stack gap="xs">
                  <Group align="flex-end" wrap="nowrap">
                    <TextInput
                      label="Id"
                      placeholder="department"
                      value={q.id}
                      onChange={(e) => update(q.uid, { id: e.currentTarget.value })}
                      style={{ flex: 1 }}
                    />
                    <SegmentedControl
                      value={q.type}
                      onChange={(value) => update(q.uid, { type: value as QuestionType })}
                      data={[
                        { value: 'choice', label: 'Choice' },
                        { value: 'boolean', label: 'Yes / no' },
                        { value: 'score', label: 'Score' },
                      ]}
                    />
                    <ActionIcon
                      color="red"
                      variant="subtle"
                      aria-label="Remove question"
                      onClick={() => setQuestions((prev) => prev.filter((x) => x.uid !== q.uid))}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                  <TextInput
                    label="Instructions"
                    placeholder="What should the model decide?"
                    value={q.instructions}
                    onChange={(e) => update(q.uid, { instructions: e.currentTarget.value })}
                  />
                  {q.type === 'choice' ? (
                    <Textarea
                      label="Choices"
                      description="One per line: key: description"
                      autosize
                      minRows={2}
                      value={q.choices}
                      onChange={(e) => update(q.uid, { choices: e.currentTarget.value })}
                    />
                  ) : null}
                  {q.type === 'score' ? (
                    <Textarea
                      label="Levels"
                      description="One per line, lowest first"
                      autosize
                      minRows={2}
                      value={q.levels}
                      onChange={(e) => update(q.uid, { levels: e.currentTarget.value })}
                    />
                  ) : null}
                </Stack>
              </Paper>
            ))}
            <Group>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconPlus size={14} />}
                onClick={() => setQuestions((prev) => [...prev, newQuestion()])}
              >
                Add question
              </Button>
            </Group>
          </Stack>

          <Switch
            label="Include rationale"
            description="Ask the model to explain its answers (not every backend supports it)."
            checked={includeRationale}
            onChange={(e) => setIncludeRationale(e.currentTarget.checked)}
          />

          <Group>
            <Button leftSection={<IconPlayerPlay size={14} />} loading={running} onClick={run}>
              Decide
            </Button>
            {response?.latency_ms !== undefined ? (
              <Badge variant="light">{Math.round(response.latency_ms)} ms</Badge>
            ) : null}
            {response?.backend ? (
              <Badge variant="light" color="gray">{response.backend.kind} · {response.backend.provider}</Badge>
            ) : null}
            {response?.usage ? (
              <Badge variant="light">
                {response.usage.input_tokens ?? 0} in / {response.usage.output_tokens ?? 0} out tokens
              </Badge>
            ) : null}
            {typeof response?.cost?.totalCost === 'number' ? (
              <Badge variant="light">
                {response.cost.totalCost.toFixed(6)} {response.cost.currency ?? ''}
              </Badge>
            ) : null}
          </Group>
        </Stack>
      </Paper>

      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Decision failed">
          {error}
        </Alert>
      ) : null}

      {response ? (
        <Stack gap="sm">
          {Object.entries(response.answers).map(([id, answer]) => (
            <AnswerCard key={id} id={id} answer={answer} />
          ))}
          {response.rationale ? (
            <Paper withBorder radius="md" p="sm">
              <Text size="xs" c="dimmed" mb={4}>Rationale</Text>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{response.rationale}</Text>
            </Paper>
          ) : null}
          <details>
            <summary><Text span size="xs" c="dimmed">Raw response</Text></summary>
            <Code block mt="xs">{JSON.stringify(response, null, 2)}</Code>
          </details>
        </Stack>
      ) : null}
    </Stack>
  );
}
