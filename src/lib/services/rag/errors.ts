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
