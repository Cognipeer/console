/**
 * RAG prompt builders.
 *
 * Pure, side-effect-free helpers that turn retrieved chunks + a question into
 * chat messages. Kept separate from `ragAnswerService` so the prompt shape can
 * be unit-tested without touching the model runtime or the database.
 */

import type { RagQueryMatch } from './types';

export interface RagChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type RagHistoryMessage = { role: 'user' | 'assistant'; content: string };

/** Default grounding instruction — answer only from context, cite sources. */
export const DEFAULT_RAG_SYSTEM_PROMPT = [
  'You are a question-answering assistant that answers strictly from the provided context.',
  'Rules:',
  '- Use ONLY the information in the numbered context passages below. Do not rely on prior knowledge.',
  '- If the answer is not contained in the context, reply that you do not know based on the available documents.',
  '- Cite the passages you used with bracketed numbers like [1], [2] that match the passage numbers.',
  '- Be concise and accurate. Do not fabricate sources or facts.',
].join('\n');

/** A retrieved passage paired with the citation number shown to the model. */
export interface NumberedPassage {
  ref: number;
  match: RagQueryMatch;
}

/** Assign 1-based citation numbers to matches in their final ranked order. */
export function numberPassages(matches: RagQueryMatch[]): NumberedPassage[] {
  return matches.map((match, i) => ({ ref: i + 1, match }));
}

/** Render one passage as a labelled block the model can cite. */
export function renderPassage(p: NumberedPassage): string {
  const m = p.match;
  const label = m.fileName
    ? `${m.fileName}${typeof m.chunkIndex === 'number' ? ` #${m.chunkIndex}` : ''}`
    : (m.documentId ?? m.id);
  const content = (m.content ?? '').trim();
  return `[${p.ref}] (source: ${label})\n${content}`;
}

/** Join all passages into a single context block. */
export function renderContext(passages: NumberedPassage[]): string {
  return passages.map(renderPassage).join('\n\n');
}

/**
 * Build the full message list for the "stuff" strategy: system grounding +
 * optional prior turns + the context block followed by the question.
 */
export function buildStuffMessages(params: {
  question: string;
  passages: NumberedPassage[];
  history?: RagHistoryMessage[];
  systemPrompt?: string;
}): RagChatMessage[] {
  const { question, passages, history = [], systemPrompt } = params;
  const messages: RagChatMessage[] = [
    { role: 'system', content: systemPrompt ?? DEFAULT_RAG_SYSTEM_PROMPT },
  ];
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }
  const context = renderContext(passages);
  messages.push({
    role: 'user',
    content: `Context passages:\n\n${context}\n\nQuestion: ${question}`,
  });
  return messages;
}

/**
 * Map step (map_reduce): ask the model to pull only the facts in one passage
 * group that are relevant to the question. Returns "NONE" when nothing applies.
 */
export function buildMapMessages(params: {
  question: string;
  passages: NumberedPassage[];
  systemPrompt?: string;
}): RagChatMessage[] {
  const { question, passages } = params;
  const context = renderContext(passages);
  return [
    {
      role: 'system',
      content:
        'Extract only the facts from the passages below that help answer the question. ' +
        'Preserve the [n] citation markers next to each fact. ' +
        'If nothing in the passages is relevant, reply with exactly "NONE".',
    },
    { role: 'user', content: `Passages:\n\n${context}\n\nQuestion: ${question}` },
  ];
}

/** Reduce step (map_reduce): synthesize a final answer from the map extracts. */
export function buildReduceMessages(params: {
  question: string;
  extracts: string[];
  history?: RagHistoryMessage[];
  systemPrompt?: string;
}): RagChatMessage[] {
  const { question, extracts, history = [], systemPrompt } = params;
  const messages: RagChatMessage[] = [
    { role: 'system', content: systemPrompt ?? DEFAULT_RAG_SYSTEM_PROMPT },
  ];
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }
  const joined = extracts.map((e, i) => `Extract ${i + 1}:\n${e}`).join('\n\n');
  messages.push({
    role: 'user',
    content: `Relevant extracts (with [n] citations):\n\n${joined}\n\nQuestion: ${question}`,
  });
  return messages;
}

/**
 * Refine step: improve an existing answer using one more passage group.
 * When `previousAnswer` is empty this behaves like an initial answer.
 */
export function buildRefineMessages(params: {
  question: string;
  passages: NumberedPassage[];
  previousAnswer: string;
  systemPrompt?: string;
}): RagChatMessage[] {
  const { question, passages, previousAnswer, systemPrompt } = params;
  const context = renderContext(passages);
  if (!previousAnswer.trim()) {
    return buildStuffMessages({ question, passages, systemPrompt });
  }
  return [
    { role: 'system', content: systemPrompt ?? DEFAULT_RAG_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Question: ${question}\n\n` +
        `Current answer:\n${previousAnswer}\n\n` +
        `Additional context passages:\n\n${context}\n\n` +
        'Refine the current answer using the additional passages. ' +
        'Keep it correct if the new passages add nothing. Preserve [n] citations.',
    },
  ];
}

/** Prompt that asks the model for alternative phrasings of a query. */
export function buildMultiQueryMessages(question: string, variants: number): RagChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You rewrite a search query into alternative phrasings to improve document retrieval. ' +
        `Return ${variants} alternative versions, one per line, with no numbering or extra text.`,
    },
    { role: 'user', content: question },
  ];
}

/** Parse the newline-separated variants returned by the multi-query prompt. */
export function parseQueryVariants(text: string, max: number): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, max);
}
