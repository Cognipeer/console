/**
 * Stored copies of passages that not everyone may read.
 *
 * What an agent turn, an MCP call, an answer or an evaluation item does with knowledge base passages is kept: the
 * conversation and its steps, the trace, the model and request logs, evaluation results. A passage of a document that
 * somebody holding only `everyone` could not read makes such a copy restricted. The record is marked with the
 * knowledge bases the passages came from (one tag each), and its views show the content only to the person it was
 * made for and to those who read those knowledge bases through the admin exception anyway.
 *
 * The Knowledge Engine and the knowledge tools mark the work in progress rather than a record: they note what they
 * hand on (`noteRestrictedKnowledge`) in the exposure the work runs in (AsyncLocalStorage, like the turn signal), and
 * the writers read the marks from there. An agent run stores each new mark on its conversation before the passage
 * goes back to the model; a scope inside another one (an agent turn inside an evaluation item) marks both.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** One knowledge base on a restricted record: its project ('' when tenant-wide) and its key. */
export function restrictedKnowledgeTag(module: { key: string; projectId?: string | null }): string {
  return `${module.projectId ?? ''}:${module.key}`;
}

/** The knowledge base a tag names; null for something that is not a tag. Project ids never hold ':'. */
export function parseRestrictedKnowledgeTag(tag: unknown): { key: string; projectId?: string } | null {
  if (typeof tag !== 'string') return null;
  const at = tag.indexOf(':');
  if (at < 0) return null;
  const key = tag.slice(at + 1);
  if (!key) return null;
  const projectId = tag.slice(0, at);
  return projectId ? { key, projectId } : { key };
}

/** The tags of a stored record, cleaned (a record from before the marks has none). */
export function restrictedKnowledgeTagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => parseRestrictedKnowledgeTag(tag) !== null))].sort();
}

export interface KnowledgeExposureBinding {
  /** Marks the work starts with: what its record (the conversation) already holds. */
  seed?: Iterable<string> | null;
  /** Stores marks the record does not hold yet; a failure is thrown to whoever was about to hand the passage on. */
  onRestricted?: (added: string[]) => Promise<void>;
}

export interface KnowledgeExposureOptions extends KnowledgeExposureBinding {
  /** The exposure of the work this one runs inside (it is marked as well). Default: the current one. */
  parent?: KnowledgeExposure | null;
}

/** What one piece of work has drawn from documents not open to everyone. */
export class KnowledgeExposure {
  private readonly tags = new Set<string>();
  /** The marks the record holds (seeded, or stored through `onRestricted`). */
  private readonly stored = new Set<string>();
  private readonly parent: KnowledgeExposure | undefined;
  private onRestricted: KnowledgeExposureBinding['onRestricted'];

  constructor(options: KnowledgeExposureOptions = {}) {
    this.parent = options.parent === undefined ? storage.getStore() : options.parent ?? undefined;
    this.seed(options.seed);
    this.onRestricted = options.onRestricted;
  }

  get restricted(): boolean {
    return this.tags.size > 0;
  }

  /** The marks so far, sorted: what a record of this work stores. */
  list(): string[] {
    return [...this.tags].sort();
  }

  /**
   * Ties the work to the record it writes, once that is known (a turn opens its exposure before it has loaded its
   * conversation): the record's marks become the work's, and marks noted before are stored now.
   */
  async bind(binding: KnowledgeExposureBinding): Promise<void> {
    this.seed(binding.seed);
    if (binding.onRestricted) this.onRestricted = binding.onRestricted;
    await this.store(this.list());
    // The work around this one now carries what the record held.
    if (this.parent && this.restricted) await this.parent.note(this.list());
  }

  /**
   * Marks the work. Resolves once the marks are stored where the work stores them, so a passage is handed on only
   * after its copies can be told apart; a mark that could not be stored is tried again by the next note.
   */
  async note(tags: readonly string[]): Promise<void> {
    const clean = restrictedKnowledgeTagsOf(tags);
    if (clean.length === 0) return;
    for (const tag of clean) this.tags.add(tag);
    // Every mark not stored yet, so one an earlier note failed to store is tried again here.
    await this.store(this.list());
    if (this.parent) await this.parent.note(clean);
  }

  private seed(tags: Iterable<string> | null | undefined): void {
    for (const tag of restrictedKnowledgeTagsOf([...(tags ?? [])])) {
      this.tags.add(tag);
      this.stored.add(tag);
    }
  }

  private async store(tags: readonly string[]): Promise<void> {
    if (!this.onRestricted) return;
    const unstored = tags.filter((tag) => !this.stored.has(tag));
    if (unstored.length === 0) return;
    await this.onRestricted(unstored);
    for (const tag of unstored) this.stored.add(tag);
  }
}

const storage = new AsyncLocalStorage<KnowledgeExposure>();

/** Runs `fn` with `exposure` as the current work's exposure. */
export function runWithKnowledgeExposure<T>(exposure: KnowledgeExposure, fn: () => T): T {
  return storage.run(exposure, fn);
}

/** The exposure of the work this code runs in, if any. */
export function currentKnowledgeExposure(): KnowledgeExposure | undefined {
  return storage.getStore();
}

/** The current work's marks (empty outside any work). */
export function currentRestrictedKnowledgeTags(): string[] {
  return storage.getStore()?.list() ?? [];
}

/** Marks the current work (nothing to mark outside one). */
export async function noteRestrictedKnowledge(tags: readonly string[]): Promise<void> {
  await storage.getStore()?.note(tags);
}

/** Runs `fn` in the current exposure, or in a fresh one, so the writers `fn` reaches can tell what it handled. */
export function withKnowledgeExposure<T>(fn: () => Promise<T>): Promise<T> {
  return storage.getStore() ? fn() : storage.run(new KnowledgeExposure({ parent: null }), fn);
}
