/**
 * Raised when a Knowledge Engine module exists but an operator switched it off.
 * Routes answer it with a 409 instead of a 500; it is a caller-visible state,
 * not a fault of the knowledge base.
 */
export class RagModuleInactiveError extends Error {
  readonly statusCode = 409;
  constructor() {
    super('Knowledge Engine module is not active');
    this.name = 'RagModuleInactiveError';
  }
}

/**
 * Raised when a re-extract is asked of a document whose original upload was not kept (the module has no file bucket,
 * or the copy could not be stored). Routes answer it with a 409: uploading the file again is the way out.
 */
export class RagOriginalMissingError extends Error {
  readonly statusCode = 409;
  constructor() {
    super('The original file is no longer stored; upload it again.');
    this.name = 'RagOriginalMissingError';
  }
}

/**
 * Raised when a re-index of a document whose text came from OCR cannot read that text back (a storage error, or the
 * extraction never finished). The original is not silently re-converted without OCR; routes answer it with a 409.
 */
export class RagStoredTextUnavailableError extends Error {
  readonly statusCode = 409;
  constructor() {
    super('The extracted text of this document could not be read. Try again, or re-extract the document from its original.');
    this.name = 'RagStoredTextUnavailableError';
  }
}

/**
 * Raised when an explicit re-extract could not finish its OCR (budget, model, time): the document keeps the text it
 * has instead of being replaced by a worse one. Routes answer it with a 409.
 */
export class RagReextractIncompleteError extends Error {
  readonly statusCode = 409;
  constructor(reason: string) {
    super(`The document was not re-extracted: OCR could not finish (${reason}). The previous text was kept.`);
    this.name = 'RagReextractIncompleteError';
  }
}

/**
 * Raised when a file yielded no text because the OCR that should have read it could not run or finish. `warnings` is
 * the report's list, for the record of a failed document (callers store it through `recordedWarnings`).
 */
export class RagOcrIncompleteError extends Error {
  /** The file is there but no text could be read from it: a problem of this upload, not of the server. */
  readonly statusCode = 422;
  readonly code = 'ocr_incomplete';
  constructor(fileName: string, reason: string, readonly warnings: readonly string[]) {
    super(`Failed to convert "${fileName}" to text. OCR could not read it: ${reason}.`);
    this.name = 'RagOcrIncompleteError';
  }
}
