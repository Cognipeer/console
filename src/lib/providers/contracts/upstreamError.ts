/**
 * An upstream failure that remembers its HTTP status.
 *
 * The audio, OCR and image runtimes call their upstream with plain `fetch` and
 * used to report a failure as `new Error("… failed (400): {body}")`. That reads
 * fine in a log and is useless everywhere else: `normalizeInferenceError` maps a
 * gateway error to a client status by reading `status` off the error object, and
 * a status that only exists inside a message string is invisible to it. Every
 * upstream fault therefore reached the caller as `500 server_error` — including
 * the 429s a client is supposed to back off from.
 */
export class UpstreamRequestError extends Error {
  readonly status: number;

  readonly body?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = 'UpstreamRequestError';
    this.status = status;
    this.body = body;
  }
}

/** Builds an `UpstreamRequestError` from a failed `fetch` response. */
export async function upstreamError(prefix: string, response: Response): Promise<UpstreamRequestError> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 2000);
  } catch {
    body = response.statusText;
  }
  return new UpstreamRequestError(`${prefix} (${response.status}): ${body}`, response.status, body);
}

/** A caller-side validation failure — always a 400, never a 500. */
export class InvalidRequestError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}
