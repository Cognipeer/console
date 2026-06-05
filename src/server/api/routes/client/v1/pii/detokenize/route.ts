import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { detokenizePii } from '@/lib/services/pii';
import type { PiiVault } from '@/lib/services/pii';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-pii');

/**
 * POST /api/client/v1/pii/detokenize
 *
 * Reverse a prior tokenize call. Replace each token in `text` with its original
 * value from `vault`. Unknown tokens are left untouched, so a model that drops
 * or rewrites a token simply leaves it in place. Stateless — no PII is stored.
 *
 * Body:
 *   - text: string (required) — text containing tokens (e.g. an LLM response)
 *   - vault: object (required) — the vault returned by /pii/tokenize
 */
const _POST = async (request: NextRequest) => {
  try {
    await requireApiToken(request);
    const body = await request.json();
    if (typeof body.text !== 'string') {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }
    if (typeof body.vault !== 'object' || body.vault === null || Array.isArray(body.vault)) {
      return NextResponse.json(
        { error: 'vault is required (object returned by /api/client/v1/pii/tokenize)' },
        { status: 400 },
      );
    }
    const result = detokenizePii({ text: body.text, vault: body.vault as PiiVault });
    return NextResponse.json({ output_text: result.outputText });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('PII detokenize error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
};

export const POST = withRequestContext(_POST);
