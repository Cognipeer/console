/**
 * Conversation-quality LLM judge. Grades a transcript against a rubric via an
 * injected model invoker and parses a `{ score, passed?, reasoning? }` verdict.
 * Scores are normalised to [0, 1] (a 0..10 scale is auto-detected).
 */

import type { AnalysisConversation, AnalysisMessage, JudgeResult, ModelInvoker } from './types';
import { renderTranscript } from './extraction';
import { extractJson } from './json';

const JUDGE_SYSTEM = [
  'You are a strict, fair conversation-quality judge.',
  'Grade the conversation transcript against the rubric.',
  'Respond with ONLY a JSON object of the form:',
  '{"score": <number between 0 and 1>, "passed": <true|false>, "reasoning": "<short explanation>"}',
  'Do not include any text outside the JSON object.',
].join('\n');

export function buildJudgePrompt(conversation: AnalysisConversation, rubric: string): AnalysisMessage[] {
  const user = [`# Rubric\n${rubric}`, `# Transcript\n${renderTranscript(conversation)}`].join('\n\n');
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: user },
  ];
}

export function normaliseScore(raw: number): number {
  const scaled = raw > 1 ? raw / 10 : raw;
  return Math.min(1, Math.max(0, scaled));
}

export interface ParsedVerdict {
  score: number;
  passed?: boolean;
  reasoning?: string;
}

export function parseJudgeResponse(raw: string): ParsedVerdict {
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

export async function judgeConversation(
  conversation: AnalysisConversation,
  rubric: string,
  threshold: number,
  invoke: ModelInvoker,
): Promise<JudgeResult> {
  try {
    const raw = await invoke(buildJudgePrompt(conversation, rubric));
    const verdict = parseJudgeResponse(raw);
    return {
      score: verdict.score,
      passed: verdict.passed ?? verdict.score >= threshold,
      reasoning: verdict.reasoning,
    };
  } catch (err) {
    return { score: 0, passed: false, error: (err as Error).message };
  }
}
