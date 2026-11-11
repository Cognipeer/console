/**
 * Typed errors of the evaluation service.
 *
 * The HTTP plugins map them to a status (conflict → 409, input → 400) instead
 * of sniffing message text. Messages keep the wording older callers match on
 * ("not found", "already in progress"), so both ways keep working.
 */

/** The request is valid but the current state forbids it (a run in flight, a referenced entity). HTTP 409. */
export class EvaluationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationConflictError';
  }
}

/** The request cannot be acted on as given (for example an empty dataset). HTTP 400. */
export class EvaluationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationInputError';
  }
}
