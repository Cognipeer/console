/**
 * Conversation import helpers for the Analysis module — turn Excel / CSV / JSON
 * into ingestable conversations. Spreadsheet and delimited files are parsed by
 * the shared helpers in `@/components/common/spreadsheet` (exceljs for .xlsx and
 * .csv/.tsv, xls-reader for legacy .xls); JSON is parsed directly.
 *
 * Tabular rows map to multi-turn transcripts by grouping on a conversation id
 * column. (case-insensitive headers):
 *   conversation_id / conversation / id / name  → groups rows into one conversation
 *   role                                         → turn role (default "user")
 *   content / message / text                     → turn content
 *   reference / reference_fields (JSON)          → ground-truth fields for accuracy
 * Rows sharing an id form one transcript in sheet order. With no id column,
 * each row becomes its own single-turn conversation.
 */

import {
  downloadSheet,
  isDelimitedFile,
  isSpreadsheetFile,
  readDelimitedRows,
  readSpreadsheetRows,
} from '@/components/common/spreadsheet';

export interface ConversationInput {
  name?: string;
  transcript: Array<{ role: string; content: string }>;
  referenceFields?: Record<string, unknown>;
  tags?: string[];
}

type Row = Record<string, unknown>;

const ALIASES = {
  id: ['conversation_id', 'conversation', 'id', 'name', 'thread', 'thread_id'],
  role: ['role', 'speaker', 'sender'],
  content: ['content', 'message', 'text', 'mesaj'],
  reference: ['reference', 'reference_fields', 'referencefields', 'expected', 'ground_truth'],
  tags: ['tag', 'tags', 'group', 'label', 'category', 'etiket'],
};

/** Split a tags cell ("a, b; c") or JSON array into a clean string[]. */
function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  let parts: string[];
  try {
    const j = JSON.parse(raw);
    parts = Array.isArray(j) ? j.map((t) => String(t)) : String(raw).split(/[,;|]/);
  } catch {
    parts = raw.split(/[,;|]/);
  }
  const tags = parts.map((t) => t.trim()).filter(Boolean);
  return tags.length > 0 ? Array.from(new Set(tags)) : undefined;
}

function pick(row: Row, aliases: string[]): string | undefined {
  for (const key of Object.keys(row)) {
    const norm = key.trim().toLowerCase().replace(/\s+/g, '_');
    if (aliases.includes(norm)) {
      const val = row[key];
      if (val !== null && val !== undefined && String(val).trim() !== '') return String(val).trim();
    }
  }
  return undefined;
}

function parseReference(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Group flat tabular rows into multi-turn conversations. */
export function rowsToConversations(rows: Row[]): ConversationInput[] {
  const order: string[] = [];
  const byId = new Map<string, ConversationInput>();

  rows.forEach((row, i) => {
    const content = pick(row, ALIASES.content);
    if (!content) return;
    const role = pick(row, ALIASES.role) ?? 'user';
    const id = pick(row, ALIASES.id) ?? `row-${i + 1}`;
    const reference = parseReference(pick(row, ALIASES.reference));
    const tags = parseTags(pick(row, ALIASES.tags));

    let convo = byId.get(id);
    if (!convo) {
      convo = { name: id, transcript: [], referenceFields: reference, tags };
      byId.set(id, convo);
      order.push(id);
    }
    if (reference && !convo.referenceFields) convo.referenceFields = reference;
    if (tags) convo.tags = Array.from(new Set([...(convo.tags ?? []), ...tags]));
    convo.transcript.push({ role, content });
  });

  return order.map((id) => byId.get(id)!).filter((c) => c.transcript.length > 0);
}

/** Validate + normalise a raw JSON array of conversations (full control). */
export function parseJsonConversations(raw: string): { conversations: ConversationInput[] } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Paste at least one conversation' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: `Invalid JSON: ${(err as Error).message}` };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const conversations: ConversationInput[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') return { error: `Item ${i} is not an object` };
    if (!Array.isArray(entry.transcript) || entry.transcript.length === 0) {
      return { error: `Item ${i} must have a non-empty "transcript" array` };
    }
    for (const m of entry.transcript) {
      const msg = m as Record<string, unknown>;
      if (typeof msg.role !== 'string' || typeof msg.content !== 'string') {
        return { error: `Item ${i} has a message missing "role"/"content"` };
      }
    }
    conversations.push({
      name: typeof entry.name === 'string' ? entry.name : undefined,
      transcript: entry.transcript as ConversationInput['transcript'],
      referenceFields: (entry.referenceFields as Record<string, unknown> | undefined) ?? undefined,
      tags: Array.isArray(entry.tags) ? entry.tags.map((t) => String(t)).filter(Boolean) : undefined,
    });
  }
  return { conversations };
}

/** Parse an uploaded file (.xlsx/.xls/.csv/.json) into conversations. */
export async function parseConversationFile(file: File): Promise<{ conversations: ConversationInput[] } | { error: string }> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.json')) {
      return parseJsonConversations(await file.text());
    }
    if (isDelimitedFile(name)) {
      return { conversations: rowsToConversations(await readDelimitedRows(file)) };
    }
    if (isSpreadsheetFile(name)) {
      return { conversations: rowsToConversations(await readSpreadsheetRows(file)) };
    }
    return { error: 'Unsupported file type — use .xlsx, .xls, .csv or .json' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to parse file' };
  }
}

const TEMPLATE_HEADERS = ['conversation_id', 'role', 'content', 'tags', 'reference'] as const;
const TEMPLATE_ROWS: Array<Record<string, string>> = [
  { conversation_id: 'call-1042', role: 'caller', content: 'I was charged twice this month.', tags: 'billing, march', reference: '{"intent":"billing","resolved":true}' },
  { conversation_id: 'call-1042', role: 'agent', content: "I've issued a refund for the duplicate charge.", tags: '', reference: '' },
  { conversation_id: 'call-1043', role: 'caller', content: 'How do I reset my password?', tags: 'support', reference: '{"intent":"support"}' },
  { conversation_id: 'call-1043', role: 'agent', content: 'Use the “forgot password” link on the login page.', tags: '', reference: '' },
];

/** Download a starter template (grouped multi-turn format) as .xlsx or .csv. */
export function downloadConversationTemplate(format: 'xlsx' | 'csv'): void {
  // Fire-and-forget: exceljs builds the file asynchronously, but the callers are
  // plain onClick handlers, so the signature stays synchronous as before.
  void downloadSheet({
    headers: TEMPLATE_HEADERS,
    rows: TEMPLATE_ROWS,
    sheetName: 'conversations',
    filename: `analysis-conversations-template.${format}`,
    format,
  }).catch((err) => {
    console.error('Failed to build conversation template', err);
  });
}

export const JSON_CONVERSATION_TEMPLATE = JSON.stringify(
  [
    {
      name: 'Call 1042',
      transcript: [
        { role: 'caller', content: 'I was charged twice.' },
        { role: 'agent', content: "I've issued a refund." },
      ],
      tags: ['billing', 'march'],
      referenceFields: { intent: 'billing', resolved: true },
    },
  ],
  null,
  2,
);
