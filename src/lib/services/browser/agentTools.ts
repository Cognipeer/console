/**
 * Agent SDK tool factories that drive a live browser session.
 *
 * Each factory returns a `createTool(...)` instance bound to a specific
 * tenant + sessionKey. Tools are created fresh per agent run so they
 * carry the right session reference without globals.
 */

import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import {
  captureScreenshot,
  captureSnapshot,
  closeBrowserSession,
  exportSessionPdf,
  extractFromBrowser,
  runBrowserAction,
} from './browserSessionService';
import type { BrowserAction } from './types';

interface ToolBindCtx {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  sessionKey: string;
  createdBy: string;
  /** Called after each tool call (used by run loop to broadcast progress). */
  onToolCall?: (info: {
    name: string;
    input: unknown;
    output: unknown;
    error?: string;
  }) => void;
}

function wrap<TInput>(
  ctx: ToolBindCtx,
  name: string,
  exec: (input: TInput) => Promise<unknown>,
) {
  return async (input: TInput) => {
    try {
      const output = await exec(input);
      ctx.onToolCall?.({ name, input, output });
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.onToolCall?.({ name, input, output: null, error: message });
      return { ok: false, error: message };
    }
  };
}

export function buildBrowserAgentTools(ctx: ToolBindCtx) {
  const sessionCtx = {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  };

  const navigateTool = createTool({
    name: 'browser_navigate',
    description:
      'Navigate the live browser to a fully-qualified URL. Returns the new URL, page title and an aria-snapshot of the page.',
    schema: z.object({
      url: z.string().url('Must be a valid URL including scheme'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    }),
    func: wrap(ctx, 'browser_navigate', async (input) => {
      const action: BrowserAction = {
        type: 'goto',
        url: input.url,
        waitUntil: input.waitUntil,
      };
      return runBrowserAction(sessionCtx, ctx.sessionKey, action);
    }),
  });

  const clickTool = createTool({
    name: 'browser_click',
    description:
      'Click a clickable element identified by either an aria reference (preferred, from a previous snapshot) or a CSS selector. When both are given, a stale ref falls back to the selector. Optional `timeout` (ms) bounds the wait.',
    schema: z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      timeout: z.number().int().min(1).max(120_000).optional(),
    }),
    func: wrap(ctx, 'browser_click', async (input) =>
      runBrowserAction(sessionCtx, ctx.sessionKey, {
        type: 'click',
        ref: input.ref,
        selector: input.selector,
        timeout: input.timeout,
      }),
    ),
  });

  const hoverTool = createTool({
    name: 'browser_hover',
    description: 'Hover the mouse over an element by ref or CSS selector.',
    schema: z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
    }),
    func: wrap(ctx, 'browser_hover', async (input) =>
      runBrowserAction(sessionCtx, ctx.sessionKey, {
        type: 'hover',
        ref: input.ref,
        selector: input.selector,
      }),
    ),
  });

  const typeTool = createTool({
    name: 'browser_type',
    description:
      'Type text into a text input (textarea / input). Set `clear: true` to wipe the field first.',
    schema: z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string(),
      clear: z.boolean().optional(),
    }),
    func: wrap(ctx, 'browser_type', async (input) =>
      runBrowserAction(sessionCtx, ctx.sessionKey, {
        type: 'type',
        ref: input.ref,
        selector: input.selector,
        text: input.text,
        clear: input.clear,
      }),
    ),
  });

  const pressTool = createTool({
    name: 'browser_press',
    description:
      'Press a keyboard key (e.g., "Enter", "Escape", "ArrowDown") on a focused element.',
    schema: z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      key: z.string(),
    }),
    func: wrap(ctx, 'browser_press', async (input) =>
      runBrowserAction(sessionCtx, ctx.sessionKey, {
        type: 'press',
        ref: input.ref,
        selector: input.selector,
        key: input.key,
      }),
    ),
  });

  const waitTool = createTool({
    name: 'browser_wait',
    description:
      'Wait for a fixed duration (ms) or until a CSS selector reaches a given visibility state.',
    schema: z.object({
      ms: z.number().int().positive().max(60000).optional(),
      selector: z.string().optional(),
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
    }),
    func: wrap(ctx, 'browser_wait', async (input) =>
      runBrowserAction(sessionCtx, ctx.sessionKey, {
        type: 'wait',
        ms: input.ms,
        selector: input.selector,
        state: input.state,
      }),
    ),
  });

  const snapshotTool = createTool({
    name: 'browser_snapshot',
    description:
      'Capture an aria-snapshot of the current page (YAML). Refs in this snapshot can be used for subsequent click/hover/type operations.',
    schema: z.object({}),
    func: wrap(ctx, 'browser_snapshot', async () =>
      captureSnapshot(sessionCtx, ctx.sessionKey),
    ),
  });

  const extractTool = createTool({
    name: 'browser_extract',
    description:
      'Extract text/html/attribute from the page. Either a CSS selector or aria ref must be supplied.',
    schema: z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      mode: z.enum(['text', 'html', 'attr']).optional(),
      attribute: z.string().optional(),
      multiple: z.boolean().optional(),
    }),
    func: wrap(ctx, 'browser_extract', async (input) =>
      extractFromBrowser(sessionCtx, ctx.sessionKey, input),
    ),
  });

  const screenshotTool = createTool({
    name: 'browser_screenshot',
    description:
      'Capture a full-page or element screenshot, persist it to the session bucket, and return a download URL.',
    schema: z.object({
      fullPage: z.boolean().optional(),
      selector: z.string().optional(),
      ref: z.string().optional(),
    }),
    func: wrap(ctx, 'browser_screenshot', async (input) =>
      captureScreenshot(sessionCtx, ctx.sessionKey, {
        ...input,
        createdBy: ctx.createdBy,
      }),
    ),
  });

  const pdfTool = createTool({
    name: 'browser_pdf',
    description:
      'Render the current page to a PDF, persist it to the session bucket, and return a download URL. Only works in headless mode.',
    schema: z.object({
      format: z.enum(['A4', 'Letter', 'Legal', 'A3', 'A5']).optional(),
      landscape: z.boolean().optional(),
      printBackground: z.boolean().optional(),
    }),
    func: wrap(ctx, 'browser_pdf', async (input) =>
      exportSessionPdf(sessionCtx, ctx.sessionKey, {
        ...input,
        createdBy: ctx.createdBy,
      }),
    ),
  });

  const closeTool = createTool({
    name: 'browser_close',
    description:
      'Close the browser session. Use this only when the task is fully complete.',
    schema: z.object({}),
    func: wrap(ctx, 'browser_close', async () =>
      closeBrowserSession(sessionCtx, ctx.sessionKey),
    ),
  });

  return [
    navigateTool,
    clickTool,
    hoverTool,
    typeTool,
    pressTool,
    waitTool,
    snapshotTool,
    extractTool,
    screenshotTool,
    pdfTool,
    closeTool,
  ];
}
