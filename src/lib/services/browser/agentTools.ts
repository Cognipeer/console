/**
 * Agent SDK tool factories that drive a live browser session.
 *
 * Each factory returns a `createTool(...)` instance bound to a specific
 * tenant + sessionKey. Tools are created fresh per agent run so they
 * carry the right session reference without globals.
 *
 * HOW A MODEL IS MEANT TO USE THESE
 *
 * `browser_snapshot` returns the accessibility tree with `[ref=e4]` markers.
 * A ref is the cheapest way to address an element and it is what click/type
 * should use — but it is valid ONLY until the next snapshot, so anything the
 * model wants to keep (a step in a flow, a note for later) must use the
 * durable form: `role` + `name`, a `testId`, a label. Every action result
 * carries `resolvedTarget`, which is exactly that durable form for whatever
 * the action just touched.
 *
 * `browser_run_flow` is the other half: rather than rediscovering a task the
 * agent (or someone else) already solved, it replays a recorded flow with no
 * model in the loop. Prefer it whenever a flow exists for the job.
 */

import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import {
  captureScreenshot,
  captureSnapshot,
  closeBrowserSession,
  exportSessionPdf,
  extractFromBrowser,
  readSessionObservations,
  runBrowserAction,
  searchPageText,
} from './browserSessionService';
import { listBrowserFlows, runBrowserFlow } from './browserFlowService';
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

/**
 * The element-addressing fields shared by every targeted tool.
 *
 * Spread into each schema rather than nested under a `target` object: models
 * call flat tools far more reliably than ones with a nested required object,
 * and this shape matches what the HTTP API accepts.
 */
const targetShape = {
  ref: z.string().optional()
    .describe('Aria reference from the most recent browser_snapshot, e.g. "e12". Fastest and unambiguous, but only valid until the next snapshot.'),
  role: z.string().optional()
    .describe('ARIA role such as button, link, textbox, checkbox. Pair with `name`. This is the durable way to address an element.'),
  name: z.string().optional()
    .describe('Accessible name — the visible label, e.g. "Sign in". Exact match unless nameContains is true.'),
  nameContains: z.boolean().optional()
    .describe('Match `name` as a substring instead of in full.'),
  testId: z.string().optional().describe('data-testid value, when the page provides one.'),
  label: z.string().optional().describe('Text of the form label attached to the field.'),
  placeholder: z.string().optional().describe('Placeholder text of an input.'),
  text: z.string().optional().describe('Visible text content of the element.'),
  selector: z.string().optional()
    .describe('CSS selector. Last resort — it breaks when the markup changes.'),
  nth: z.number().int().min(0).optional()
    .describe('Zero-based index when the target above matches several elements.'),
  frame: z.string().optional()
    .describe('CSS selector of an iframe to look inside, for embedded widgets.'),
};

export function buildBrowserAgentTools(ctx: ToolBindCtx) {
  const sessionCtx = {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  };

  const act = (action: BrowserAction) => runBrowserAction(sessionCtx, ctx.sessionKey, action);

  const navigateTool = createTool({
    name: 'browser_navigate',
    description:
      'Navigate the live browser to a fully-qualified URL. Returns the new URL, page title and an aria-snapshot of the page with [ref=…] markers you can use for the next action.',
    schema: z.object({
      url: z.string().url('Must be a valid URL including scheme'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    }),
    func: wrap(ctx, 'browser_navigate', async (input) =>
      act({ type: 'goto', url: input.url, waitUntil: input.waitUntil }),
    ),
  });

  const historyTool = createTool({
    name: 'browser_history',
    description:
      'Go back, go forward, or reload the current page. Use this to recover from a wrong turn instead of re-navigating from scratch.',
    schema: z.object({
      direction: z.enum(['back', 'forward', 'reload']),
    }),
    func: wrap(ctx, 'browser_history', async (input) => act({ type: input.direction })),
  });

  const clickTool = createTool({
    name: 'browser_click',
    description:
      'Click an element. Address it by `ref` from the latest snapshot, or durably by role + name / testId / label / text. Set clickCount: 2 for a double-click.',
    schema: z.object({
      ...targetShape,
      button: z.enum(['left', 'right', 'middle']).optional(),
      clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
      timeout: z.number().int().min(1).max(120_000).optional(),
    }),
    func: wrap(ctx, 'browser_click', async (input) => act({ type: 'click', ...input })),
  });

  const hoverTool = createTool({
    name: 'browser_hover',
    description: 'Hover the mouse over an element — used to open menus that appear on hover.',
    schema: z.object({ ...targetShape }),
    func: wrap(ctx, 'browser_hover', async (input) => act({ type: 'hover', ...input })),
  });

  const typeTool = createTool({
    name: 'browser_type',
    description:
      'Type text into an input or textarea. Set clear: true to wipe the field first, and submit: true to press Enter afterwards.',
    schema: z.object({
      ...targetShape,
      text: z.string(),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
      delay: z.number().int().min(0).max(5_000).optional()
        .describe('Per-keystroke delay in ms. Only needed for inputs that react to individual keys, such as autocompletes.'),
    }),
    func: wrap(ctx, 'browser_type', async (input) => act({ type: 'type', ...input })),
  });

  const pressTool = createTool({
    name: 'browser_press',
    description: 'Press a keyboard key (e.g. "Enter", "Escape", "ArrowDown", "Control+a") on an element.',
    schema: z.object({ ...targetShape, key: z.string() }),
    func: wrap(ctx, 'browser_press', async (input) => act({ type: 'press', ...input })),
  });

  const selectTool = createTool({
    name: 'browser_select',
    description:
      'Choose one or more options in a <select> dropdown. Give `labels` for what the user sees, or `values` for the underlying option values.',
    schema: z.object({
      ...targetShape,
      values: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
    }),
    func: wrap(ctx, 'browser_select', async (input) => act({ type: 'select', ...input })),
  });

  const checkTool = createTool({
    name: 'browser_check',
    description:
      'Set a checkbox or radio to a specific state. Unlike a click this is idempotent: checking an already-checked box leaves it checked.',
    schema: z.object({ ...targetShape, checked: z.boolean().optional() }),
    func: wrap(ctx, 'browser_check', async (input) => act({ type: 'check', ...input })),
  });

  const uploadTool = createTool({
    name: 'browser_upload',
    description:
      'Attach files to a file input. Files are referenced by their id in the Files service, not by a path on disk.',
    schema: z.object({ ...targetShape, fileIds: z.array(z.string()).min(1).max(10) }),
    func: wrap(ctx, 'browser_upload', async (input) => act({ type: 'upload', ...input })),
  });

  const scrollTool = createTool({
    name: 'browser_scroll',
    description:
      'Scroll the page. Give an element target to bring it into view, or x/y pixel offsets to scroll the window (positive y scrolls down).',
    schema: z.object({
      ...targetShape,
      x: z.number().int().optional(),
      y: z.number().int().optional(),
    }),
    func: wrap(ctx, 'browser_scroll', async (input) => act({ type: 'scroll', ...input })),
  });

  const waitTool = createTool({
    name: 'browser_wait',
    description:
      'Wait for a fixed duration, for text to appear, for a selector to reach a visibility state, or for the page to finish loading.',
    schema: z.object({
      ms: z.number().int().positive().max(60000).optional(),
      text: z.string().optional(),
      selector: z.string().optional(),
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
      loadState: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    }),
    func: wrap(ctx, 'browser_wait', async (input) => act({ type: 'wait', ...input })),
  });

  const tabsTool = createTool({
    name: 'browser_tabs',
    description:
      'List, open, switch to, or close browser tabs. A link that opens in a new window makes that tab active automatically — use `list` when you are unsure which page you are on.',
    schema: z.object({
      op: z.enum(['list', 'new', 'switch', 'close']),
      index: z.number().int().min(0).optional(),
      url: z.string().url().optional(),
    }),
    func: wrap(ctx, 'browser_tabs', async (input) => act({ type: 'tab', ...input })),
  });

  const snapshotTool = createTool({
    name: 'browser_snapshot',
    description:
      'Capture the accessibility tree of the current page as YAML, with [ref=…] markers. Use a ref for the very next action; use the role and name it shows when you need a target that stays valid later.',
    schema: z.object({}),
    func: wrap(ctx, 'browser_snapshot', async () => captureSnapshot(sessionCtx, ctx.sessionKey)),
  });

  const findTool = createTool({
    name: 'browser_find',
    description:
      'Find visible occurrences of a string and get a durable target for each. Cheaper than a full snapshot when you already know what you are looking for.',
    schema: z.object({
      text: z.string(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    func: wrap(ctx, 'browser_find', async (input) =>
      searchPageText(sessionCtx, ctx.sessionKey, input.text, { limit: input.limit }),
    ),
  });

  const extractTool = createTool({
    name: 'browser_extract',
    description:
      'Read text, HTML, an attribute, or an input value out of the page. Set multiple: true to read every matching element.',
    schema: z.object({
      ...targetShape,
      mode: z.enum(['text', 'html', 'attr', 'value']).optional(),
      attribute: z.string().optional(),
      multiple: z.boolean().optional(),
    }),
    func: wrap(ctx, 'browser_extract', async (input) =>
      extractFromBrowser(sessionCtx, ctx.sessionKey, input),
    ),
  });

  const diagnosticsTool = createTool({
    name: 'browser_diagnostics',
    description:
      'Read the console messages, failed network requests and last dialog this session saw. Use it when an action succeeded but the page did not do what you expected.',
    schema: z.object({}),
    func: wrap(ctx, 'browser_diagnostics', async () =>
      readSessionObservations(sessionCtx, ctx.sessionKey),
    ),
  });

  const screenshotTool = createTool({
    name: 'browser_screenshot',
    description:
      'Capture a full-page or element screenshot, persist it to the session bucket, and return a download URL.',
    schema: z.object({
      ...targetShape,
      fullPage: z.boolean().optional(),
    }),
    func: wrap(ctx, 'browser_screenshot', async (input) =>
      captureScreenshot(sessionCtx, ctx.sessionKey, { ...input, createdBy: ctx.createdBy }),
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
      exportSessionPdf(sessionCtx, ctx.sessionKey, { ...input, createdBy: ctx.createdBy }),
    ),
  });

  const listFlowsTool = createTool({
    name: 'browser_list_flows',
    description:
      'List the saved, replayable browser flows available in this project. Check here BEFORE working a task out step by step — replaying a flow is faster, cheaper and more reliable than rediscovering it.',
    schema: z.object({
      search: z.string().optional(),
    }),
    func: wrap(ctx, 'browser_list_flows', async (input) => {
      const flows = await listBrowserFlows(sessionCtx, { status: 'active', search: input.search });
      return {
        ok: true,
        flows: flows.map((flow) => ({
          key: flow.key,
          name: flow.name,
          description: flow.description,
          steps: flow.steps.length,
          inputs: (flow.inputs ?? []).map((item) => ({
            name: item.name,
            type: item.type,
            required: item.required ?? false,
            description: item.description,
          })),
        })),
      };
    }),
  });

  const runFlowTool = createTool({
    name: 'browser_run_flow',
    description:
      'Replay a saved browser flow end to end and return its outcome, including any values the flow captured. The flow runs in its own session — it does not disturb the page you are currently on.',
    schema: z.object({
      flowKey: z.string().describe('The flow `key` from browser_list_flows.'),
      inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe('Values for the flow inputs, keyed by input name.'),
    }),
    func: wrap(ctx, 'browser_run_flow', async (input) => {
      const run = await runBrowserFlow(sessionCtx, input.flowKey, {
        inputs: input.inputs,
        trigger: 'agent',
        createdBy: ctx.createdBy,
      });
      return {
        ok: run.status === 'succeeded',
        status: run.status,
        outputs: run.outputs,
        durationMs: run.durationMs,
        failedStepIndex: run.failedStepIndex,
        error: run.errorMessage,
        // The step ledger is what lets a model explain WHERE a flow broke
        // rather than only that it did.
        steps: (run.stepResults ?? []).map((step) => ({
          index: step.index,
          status: step.status,
          error: step.errorMessage,
        })),
      };
    }),
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
    historyTool,
    clickTool,
    hoverTool,
    typeTool,
    pressTool,
    selectTool,
    checkTool,
    uploadTool,
    scrollTool,
    waitTool,
    tabsTool,
    snapshotTool,
    findTool,
    extractTool,
    diagnosticsTool,
    screenshotTool,
    pdfTool,
    listFlowsTool,
    runFlowTool,
    closeTool,
  ];
}
