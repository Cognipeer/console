// @vitest-environment jsdom
/**
 * The exceptions editor in a browser: it opens full-screen over the panel,
 * suggests the tool's argument names from its schema, previews a call with the
 * lines being edited, and hands back only what can be saved.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import AgentToolExceptionsModal from '@/components/agents/studio/AgentToolExceptionsModal';
import type { HitlToolRow } from '@/components/agents/studio/hitlSettings';
import type { AgentToolApprovalException, IAgentHumanInTheLoopConfig } from '@/lib/database';
import { buttonByText, click, installDomStubs, mount, q, qa, setInput, text, wait, type Mounted } from '../helpers/iamCenterUi';

const hitl: IAgentHumanInTheLoopConfig = { toolApproval: { enabled: true, tools: { send_email: 'always' } } };

const row = (over: Partial<HitlToolRow> = {}): HitlToolRow => ({
  name: 'send_email',
  origin: 'client',
  kind: 'writes',
  readOnly: false,
  choice: 'always',
  effective: 'always',
  askChoice: 'default',
  exceptions: [],
  ...over,
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});
beforeAll(() => installDomStubs());

async function open(over: Partial<HitlToolRow> = {}, clientSchema?: unknown) {
  const onApply = vi.fn<(exceptions: AgentToolApprovalException[]) => void>();
  const onClose = vi.fn();
  mounted = await mount(h(AgentToolExceptionsModal, { opened: true, onClose, row: row(over), hitl, clientSchema, onApply }));
  await wait(0);
  return { onApply, onClose };
}

const patternInputs = () => qa<HTMLInputElement>('input[aria-label="Pattern"]');
const fieldInputs = () => qa<HTMLInputElement>('input[aria-label="Argument"]');
const apply = () => buttonByText('Apply');

describe('AgentToolExceptionsModal', () => {
  it('opens full-screen with the tool\'s exceptions as sentences', async () => {
    await open({ exceptions: [{ field: 'to', pattern: '*@acme.com', action: 'allow' }] });
    expect(q('.form-overlay')).not.toBeNull();
    expect(text()).toContain('Exceptions · send_email');
    expect(text()).toContain('This tool asks for approval.');
    expect(fieldInputs()[0].value).toBe('to');
    expect(patternInputs()[0].value).toBe('*@acme.com');
    expect(q<HTMLInputElement>('input[aria-label="Then"]')?.value).toBe('Don’t ask');
  });

  it('adds a line, refuses to apply it half-written, and hands back the cleaned list', async () => {
    const { onApply, onClose } = await open({}, { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } });
    expect(text()).toContain('No exceptions.');
    await click(buttonByText('Add exception'));
    expect(patternInputs()).toHaveLength(1);

    // Blank lines are ignored; a field without a pattern is not.
    await setInput(fieldInputs()[0], ' to ');
    expect(text()).toContain('Write a pattern.');
    expect(apply()?.disabled).toBe(true);

    await setInput(patternInputs()[0], '*@rival.com');
    expect(apply()?.disabled).toBe(false);
    await click(apply());
    expect(onApply).toHaveBeenCalledWith([{ field: 'to', pattern: '*@rival.com', action: 'allow' }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('previews a call with the lines being edited', async () => {
    await open({
      exceptions: [
        { field: 'to', pattern: '*@acme.com', action: 'allow' },
        { field: 'to', pattern: '*@rival.com', action: 'deny' },
      ],
    });
    const sample = q<HTMLTextAreaElement>('textarea[aria-label="Try a call"]')!;
    await setInput(sample, '{"to": "ceo@rival.com"}');
    expect(q('[data-testid="hitl-exception-preview"]')?.textContent).toContain('Blocked');
    expect(q('[data-testid="hitl-exception-preview"]')?.textContent).toContain('Exception 2: to matches “*@rival.com”');

    await setInput(sample, '{"to": "x@other.com"}');
    expect(q('[data-testid="hitl-exception-preview"]')?.textContent).toContain('Asks for approval');
    expect(q('[data-testid="hitl-exception-preview"]')?.textContent).toContain('The tool setting');

    await setInput(sample, '[1]');
    expect(text()).toContain('Not a JSON object.');
  });

  it('fetches a bound tool\'s schema for the argument suggestions', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      tools: [{ key: 'mail', actions: [{ key: 'send_email', inputSchema: { properties: { recipient: {}, cc: {} } } }] }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    await open({ origin: 'tool', sourceKey: 'mail', exceptions: [{ pattern: 'x', action: 'deny' }] });
    await wait(10);
    expect(fetchMock).toHaveBeenCalledWith('/api/tools?status=active', expect.anything());
    // Mantine's Autocomplete lists its options once focused.
    await click(fieldInputs()[0]);
    fieldInputs()[0].focus();
    await wait(10);
    const options = qa('[role="option"]').map((option) => option.textContent);
    expect(options).toEqual(expect.arrayContaining(['recipient', 'cc']));
  });
});
