import { getDatabase } from '@/lib/database';
import type { IGuardrailWordList } from '@/lib/database';
import type { ResolvedWordList } from './wordFilter';
import { generateUniqueSlugKey } from './keyGeneration';

// ── Tenant word lists ─────────────────────────────────────────────────────
// Reusable banned-word lists uploaded by tenants (CSV/TXT or inline) and
// referenced from word-filter policies via `customListKeys`.

/** Hard caps so a hostile upload can't balloon evaluation cost. */
export const WORD_LIST_LIMITS = {
  maxWords: 20_000,
  maxWordLength: 100,
  maxContentBytes: 2 * 1024 * 1024, // 2 MB raw upload
};

export class WordListValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WordListValidationError';
  }
}

/**
 * Parses uploaded CSV/TXT content into a clean word array.
 *
 * Accepts one entry per line and/or comma/semicolon/tab separated values.
 * Quotes are stripped, entries are trimmed and deduplicated (case-insensitive),
 * blank entries and lines starting with `#` are dropped. Multi-word entries
 * are kept — the matcher treats them as phrases.
 */
/**
 * Trims a single entry, enforces the length limit, and appends it to `out`
 * unless blank or a case-insensitive duplicate. Enforces the count limit.
 * Shared by the CSV/text parser and the array normalizer so the limit/dedupe
 * rules live in one place.
 */
function addWord(word: string, seen: Set<string>, out: string[]): void {
  const trimmed = word.trim();
  if (!trimmed) return;
  if (trimmed.length > WORD_LIST_LIMITS.maxWordLength) {
    throw new WordListValidationError(
      `Entry exceeds ${WORD_LIST_LIMITS.maxWordLength} characters: "${trimmed.slice(0, 40)}…"`,
    );
  }
  const dedupeKey = trimmed.toLowerCase();
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  out.push(trimmed);
  if (out.length > WORD_LIST_LIMITS.maxWords) {
    throw new WordListValidationError(`Too many entries (max ${WORD_LIST_LIMITS.maxWords})`);
  }
}

export function parseWordListContent(content: string): string[] {
  if (Buffer.byteLength(content, 'utf8') > WORD_LIST_LIMITS.maxContentBytes) {
    throw new WordListValidationError(
      `Upload too large (max ${WORD_LIST_LIMITS.maxContentBytes / (1024 * 1024)} MB)`,
    );
  }

  const seen = new Set<string>();
  const words: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    for (const cell of trimmedLine.split(/[,;\t]/)) {
      let word = cell.trim();
      // Strip surrounding quotes (CSV exports)
      if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
        word = word.slice(1, -1);
      }
      addWord(word, seen, words);
    }
  }

  return words;
}

export function normalizeWordArray(words: unknown): string[] {
  if (!Array.isArray(words)) {
    throw new WordListValidationError('`words` must be an array of strings');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of words) {
    if (typeof entry !== 'string') {
      throw new WordListValidationError('`words` must contain only strings');
    }
    addWord(entry, seen, out);
  }
  return out;
}

// ── Serialization ─────────────────────────────────────────────────────────

export interface WordListView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  language?: string;
  words: string[];
  wordCount: number;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function serializeWordList(record: IGuardrailWordList, includeWords = true): WordListView {
  const { _id, words, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
    words: includeWords ? words : [],
    wordCount: words?.length ?? 0,
  };
}

// ── Key generation ────────────────────────────────────────────────────────

async function generateUniqueListKey(
  tenantDbName: string,
  projectId: string | undefined,
  desiredKey: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return generateUniqueSlugKey(desiredKey, 'word-list', async (candidate) =>
    Boolean(await db.findGuardrailWordListByKey(candidate, projectId)),
  );
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function createWordList(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: {
    name: string;
    description?: string;
    language?: string;
    words: string[];
    projectId?: string;
  },
): Promise<WordListView> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const key = await generateUniqueListKey(tenantDbName, input.projectId, input.name);
  const record = await db.createGuardrailWordList({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    language: input.language,
    words: input.words,
    createdBy,
  });

  return serializeWordList(record);
}

export async function updateWordList(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  input: {
    name?: string;
    description?: string;
    language?: string;
    words?: string[];
  },
): Promise<WordListView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const updated = await db.updateGuardrailWordList(id, { ...input, updatedBy });
  if (!updated) return null;
  invalidateWordListCache(tenantDbName, updated.key);
  return serializeWordList(updated);
}

export async function deleteWordList(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailWordListById(id);
  const deleted = await db.deleteGuardrailWordList(id);
  if (deleted && record) invalidateWordListCache(tenantDbName, record.key);
  return deleted;
}

export async function getWordList(tenantDbName: string, id: string): Promise<WordListView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailWordListById(id);
  if (!record) return null;
  return serializeWordList(record);
}

export async function listWordLists(
  tenantDbName: string,
  filters?: { projectId?: string; search?: string },
): Promise<WordListView[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const records = await db.listGuardrailWordLists(filters);
  // Summaries only — full word arrays are fetched per-list.
  return records.map((record) => serializeWordList(record, false));
}

// ── Evaluation-time resolver (cached) ─────────────────────────────────────
// evaluateGuardrail runs on every request; hitting the DB for each referenced
// list would double the guardrail's own latency. A short TTL cache keeps
// lookups hot while letting edits propagate within a minute.

const CACHE_TTL_MS = 60_000;
const listCache = new Map<string, { words: string[]; expiresAt: number }>();

function cacheKey(tenantDbName: string, listKey: string): string {
  return `${tenantDbName}:${listKey}`;
}

export function invalidateWordListCache(tenantDbName: string, listKey: string): void {
  listCache.delete(cacheKey(tenantDbName, listKey));
}

/**
 * Resolves policy `customListKeys` into word arrays for the matcher.
 * Unknown keys resolve to empty lists (the guardrail must not fail because a
 * referenced list was deleted).
 */
export async function resolveCustomWordLists(
  tenantDbName: string,
  projectId: string | undefined,
  listKeys: string[],
): Promise<ResolvedWordList[]> {
  if (!listKeys.length) return [];

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const now = Date.now();

  // Cache misses run concurrently so N referenced lists cost one round-trip of
  // latency, not N. Each key's lookup keeps its project → tenant-wide fallback.
  return Promise.all(
    listKeys.map(async (listKey) => {
      const cached = listCache.get(cacheKey(tenantDbName, listKey));
      if (cached && cached.expiresAt > now) {
        return { key: listKey, words: cached.words };
      }
      const record =
        (await db.findGuardrailWordListByKey(listKey, projectId)) ??
        // Fall back to tenant-wide lookup so lists created without a project
        // still resolve from project-scoped guardrails.
        (projectId !== undefined ? await db.findGuardrailWordListByKey(listKey) : null);
      const words = record?.words ?? [];
      listCache.set(cacheKey(tenantDbName, listKey), { words, expiresAt: now + CACHE_TTL_MS });
      return { key: listKey, words };
    }),
  );
}
