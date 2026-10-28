/**
 * Whether passages handed on are of documents not open to everyone, and marking the work that hands them on
 * (exposure.ts says what the marks are for).
 */

import { anonymousKbCaller } from './caller';
import { noteRestrictedKnowledge, restrictedKnowledgeTag } from './exposure';
import { resolveRagAccess, type RagAccessDocument, type RagAccessModule } from './scope';

export interface RestrictedTagInput {
  tenantDbName: string;
  tenantId: string;
  module: RagAccessModule;
  /** The documents whose passages are handed on; a missing one (a passage naming no document) counts as closed. */
  documents: ReadonlyArray<RagAccessDocument | null | undefined>;
}

/**
 * The module's tag when any of the documents is closed to somebody who holds only `everyone`, else null. A module
 * without access control is open to everyone in its project and never restricts anything.
 */
export async function restrictedTagOf(input: RestrictedTagInput): Promise<string | null> {
  if (input.module.access?.enabled !== true || input.documents.length === 0) return null;
  const tag = restrictedKnowledgeTag(input.module);
  if (input.documents.some((document) => !document)) return tag;
  // Resolved per call: document-level grants do not move the module's revision, so a cached answer could be stale.
  const everyone = await resolveRagAccess({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    module: input.module,
    caller: anonymousKbCaller('public'),
    manage: false,
  });
  return input.documents.some((document) => !everyone.canReadDocument(document as RagAccessDocument)) ? tag : null;
}

/** `restrictedTagOf`, and the current work is marked with it. */
export async function noteRestrictedDocuments(input: RestrictedTagInput): Promise<string | null> {
  const tag = await restrictedTagOf(input);
  if (tag) await noteRestrictedKnowledge([tag]);
  return tag;
}
