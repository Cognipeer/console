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
