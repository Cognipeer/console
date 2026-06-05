/**
 * MSW Node server — shared across test files that need HTTP interception.
 *
 * Usage in a test file:
 *   import { mswServer } from '@test/helpers/msw.server';
 *   import { http, HttpResponse } from 'msw';
 *
 *   beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => mswServer.resetHandlers());
 *   afterAll(() => mswServer.close());
 *
 *   // Override for a specific test:
 *   mswServer.use(http.post('https://api.openai.com/v1/chat/completions', () =>
 *     HttpResponse.json({ error: 'rate_limit' }, { status: 429 }),
 *   ));
 */

import { setupServer } from 'msw/node';
import { defaultHandlers } from './msw.handlers';

export const mswServer = setupServer(...defaultHandlers);
