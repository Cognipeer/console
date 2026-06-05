/**
 * LLM-as-judge scorer.
 *
 * Builds a rubric-driven grading prompt, calls an injected judge invoker, and
 * parses a `{ score, passed?, reasoning? }` verdict. Scores are normalised to
 * [0, 1] (a 0..10 scale is auto-detected). The judge invoker is injected so
 * this scorer stays free of any model-runtime coupling and is unit-testable.
 */

import type {
  DatasetItem,
  EvalMessage,
  JudgeInvoker,
  LlmJudgeScorerConfig,
  ScoreResult,
  TargetOutput,
} from '../types';
import { extractJson } from './json';

const JUDGE_SYSTEM = [
  'You are a strict, fair evaluation judge.',
  'Grade the ASSISTANT OUTPUT against the rubric and (when provided) the reference answer.',
  'Respond with ONLY a JSON object of the form:',
  '{"score": <number between 0 and 1>, "passed": <true|false>, "reasoning": "<short explanation>"}',
  'Do not include any text outside the JSON object.',
].join('\n');

export function buildJudgePrompt(
  item: DatasetItem,
  output: TargetOutput,
  config: LlmJudgeScorerConfig,
): EvalMessage[] {
  const lastUser = [...item.input].reverse().find((m) => m.role === 'user');
  const sections = [
    `# Rubric\n${config.rubric}`,
    lastUser ? `# User input\n${lastUser.content}` : '',
    item.expected?.reference ? `# Reference answer\n${item.expected.reference}` : '',
    `# Assistant output\n${output.text ?? ''}`,
  ].filter(Boolean);

  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

export interface JudgeVerdict {
  score: number;
  passed?: boolean;
  reasoning?: string;
}

/** Parse + normalise a judge completion into a verdict. */
export function parseJudgeResponse(raw: string): JudgeVerdict {
  const parsed = extractJson(raw);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    throw new Error(`could not parse judge response: ${parsed.ok ? 'not an object' : parsed.error}`);
  }
  const obj = parsed.value as Record<string, unknown>;
  if (typeof obj.score !== 'number' || !Number.isFinite(obj.score)) {
    throw new Error('judge response missing numeric "score"');
  }
  return {
    score: normaliseScore(obj.score),
    passed: typeof obj.passed === 'boolean' ? obj.passed : undefined,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
  };
}

/** Map a raw judge score onto [0, 1] (auto-detecting a 0..10 scale). */
export function normaliseScore(raw: number): number {
  const scaled = raw > 1 ? raw / 10 : raw;
  return Math.min(1, Math.max(0, scaled));
}

export async function scoreLlmJudge(
  item: DatasetItem,
  output: TargetOutput,
  config: LlmJudgeScorerConfig,
  invokeJudge: JudgeInvoker,
): Promise<ScoreResult> {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? 0.5;
  try {
    const raw = await invokeJudge(buildJudgePrompt(item, output, config));
    const verdict = parseJudgeResponse(raw);
    const passed = verdict.passed ?? verdict.score >= threshold;
    return {
      scorerType: 'llm-judge',
      score: verdict.score,
      passed,
      weight,
      detail: { reasoning: verdict.reasoning, threshold },
    };
  } catch (err) {
    return {
      scorerType: 'llm-judge',
      score: 0,
      passed: false,
      weight,
      error: (err as Error).message,
    };
  }
}
