/**
 * Moving folders and documents as the library asks for it: one folder PATCH each, documents in requests of at most
 * 500. Not React; the API is a parameter so the order and the batching are testable without a network.
 */

import { ragAccessApi, type RagAccessApi } from '@/components/rag/access/ragAccessApi';
import { inBatches, moveCount, type MoveItems, type RagLibraryDocument } from './libraryModel';

/** A refusal in the middle of a move: what the server said, and how much had already moved. */
export class MoveFailedError extends Error {
  readonly moved: number;
  readonly total: number;

  constructor(message: string, moved: number, total: number) {
    super(message);
    this.name = 'MoveFailedError';
    this.moved = moved;
    this.total = total;
  }
}

export interface MoveOutcome {
  folders: number;
  documents: number;
}

/**
 * Moves `items` to `destination` (a folder id, null = the top level). Folders go first: they are what a server
 * refuses most (a name taken at the destination, too deep), so a refusal leaves the documents where they were.
 * The first refusal stops the move and throws `MoveFailedError` with what had moved by then.
 */
export async function moveLibraryItems<D extends RagLibraryDocument>(
  moduleKey: string,
  items: Pick<MoveItems<D>, 'folders' | 'documents'>,
  destination: string | null,
  api: Pick<RagAccessApi, 'updateFolder' | 'moveDocuments'> = ragAccessApi,
): Promise<MoveOutcome> {
  const total = moveCount(items);
  const outcome: MoveOutcome = { folders: 0, documents: 0 };
  try {
    for (const folder of items.folders) {
      await api.updateFolder(moduleKey, folder._id, { parentId: destination });
      outcome.folders += 1;
    }
    for (const batch of inBatches(items.documents.map((doc) => doc._id))) {
      const moved = await api.moveDocuments(moduleKey, batch, destination);
      // The server counts only the documents that were not already there.
      outcome.documents += Math.max(moved, 0);
    }
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message : 'The move failed';
    throw new MoveFailedError(message, outcome.folders + outcome.documents, total);
  }
  return outcome;
}
