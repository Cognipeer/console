// @vitest-environment jsdom
/**
 * "+ New …" in the pickers: a form that needs something the project does not have yet (a model, a knowledge
 * engine, a guardrail, a PII policy, a memory store, a tool, a vector provider or index) offers to create it in
 * place, over the form, and selects what was created. Only someone who can create in that service is offered it;
 * anyone else reads one line saying who can. A form opened over another one closes alone on Escape.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h, type ComponentProps, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  settle,
  text,
  type Mounted,
} from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/agents',
}));

import FormShell from '@/components/common/ui/FormShell';
import CreateAgentModal from '@/components/agents/CreateAgentModal';
import { KnowledgeBindingsEditor } from '@/components/agents/KnowledgeBindingsEditor';
import GuardrailBindingList from '@/components/guardrails/GuardrailBindingList';
import PiiProtectionField from '@/components/pii/PiiProtectionField';
import AgentMemoryPanel from '@/components/agents/studio/AgentMemoryPanel';
import AgentToolsList from '@/components/agents/studio/AgentToolsList';
import CreateRagModuleModal from '@/components/rag/CreateRagModuleModal';
import { LauncherProvider, type LauncherContextValue } from '@/components/layout/launcher/LauncherContext';
import { canWriteDashboardService } from '@/lib/utils/dashboardServices';
import { NO_PII_POLICIES } from '@/components/pii/piiProtectionForm';
import type { PermissionService, ServicePermissionLevel } from '@/lib/security/rbac';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { piiProtectionEn } from '@/lib/i18n/messages/piiProtection.en';
import { piiProtectionTr } from '@/lib/i18n/messages/piiProtection.tr';

beforeAll(() => installDomStubs());
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

/** The dashboard shell's answer: the person may create only in `writable`. */
function shell(writable: PermissionService[], child: ReactNode) {
  const value: LauncherContextValue = {
    pinned: new Set(),
    recents: [],
    togglePin: () => {},
    recordVisit: () => {},
    services: [],
    pinnedServices: [],
    recentServices: [],
    isTenantAdmin: false,
    openLauncher: () => {},
    hydrated: true,
    canUseService: () => true,
    canWriteService: (service) => writable.includes(service),
  };
  return h(LauncherProvider, { value } as ComponentProps<typeof LauncherProvider>, child);
}

async function render(node: ReactNode) {
  mounted = await mount(h(QueryClientProvider, { client: newTestQueryClient() }, node));
  await settle(50);
}

const noop = () => {};

describe('who may create: canWriteDashboardService', () => {
  const levels = (level: ServicePermissionLevel) =>
    ({ role: 'user', servicePermissions: {}, effectivePermissions: { models: level } }) as Parameters<typeof canWriteDashboardService>[0];

  it('write and admin may create; read and none may not', () => {
    expect(canWriteDashboardService(levels('write'), 'models')).toBe(true);
    expect(canWriteDashboardService(levels('admin'), 'models')).toBe(true);
    expect(canWriteDashboardService(levels('read'), 'models')).toBe(false);
    expect(canWriteDashboardService(levels('none'), 'models')).toBe(false);
  });
});

describe('a form opened over another one', () => {
  it('closes alone on Escape; the form under it stays with what was typed', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    await render(
      h('div', null,
        h(FormShell, { open: true, onClose: outerClose, title: 'Create Agent', children: h('input', { 'aria-label': 'outer' }) }),
        h(FormShell, { open: true, onClose: innerClose, title: 'New model', children: h('input', { 'aria-label': 'inner' }) }),
      ),
    );
    q('input[aria-label="inner"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(10);
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });
});

describe('agent create: + Add model', () => {
  it('a project without a model: someone who can add models gets the button and the hint', async () => {
    installApiMock([['GET', '/api/models', () => ({ models: [], providers: [] })]]);
    await render(shell(['models'], h(CreateAgentModal, { opened: true, onClose: noop, models: [], onCreated: noop })));
    expect(q('[data-testid="agent-create-add-model"]')).not.toBeNull();
    expect(text()).toContain(en.agents.createModal.noModels);
  });

  it('someone who cannot add models reads who can, and gets no button', async () => {
    await render(shell([], h(CreateAgentModal, { opened: true, onClose: noop, models: [], onCreated: noop })));
    expect(q('[data-testid="agent-create-add-model"]')).toBeNull();
    expect(text()).toContain(en.agents.createModal.noModelsReadOnly);
  });

  it('opens the model form over the agent form; "Add provider" goes on without closing either', async () => {
    const onClose = vi.fn();
    const api = installApiMock([
      ['GET', '/api/models', () => ({ models: [], providers: [] })],
      ['GET', '/api/models/providers/drivers', () => ({ drivers: [] })],
    ]);
    await render(shell(['models'], h(CreateAgentModal, { opened: true, onClose, models: [], onCreated: noop })));
    await click(q('[data-testid="agent-create-add-model"]'));
    await settle(100);
    expect(api.to('GET', '/api/models').some((c) => c.query.includeProviders === 'true')).toBe(true);
    expect(text()).toContain('No model providers are available in this project yet');
    await click(buttonByText('Add provider'));
    await settle(100);
    expect(text()).toContain('Add Model Provider');
    expect(onClose).not.toHaveBeenCalled();
    expect(text()).toContain(en.agents.createModal.title);
    // The provider form is on top of the model form, which stays open (it selects the provider created there).
    const overlays = qa('.form-overlay');
    expect(overlays.length).toBe(3);
    expect(overlays[2].textContent).toContain('Add Model Provider');
    expect(overlays[1].textContent).toContain('No model providers are available in this project yet');
  });
});

describe('Model Hub: a provider added from the model form', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/dashboard/models/page.tsx'), 'utf8');
  const form = readFileSync(join(process.cwd(), 'src/components/models/CreateModelModal.tsx'), 'utf8');

  it('comes back to the model form, selected, instead of opening the catalog', () => {
    // "Add provider" no longer closes the model form; the page knows which form asked.
    expect(form).toContain('onClick={() => onAddProvider()}');
    expect(page).toContain("setProviderReturnTo('model');");
    expect(page).toContain("setProviderReturnTo('catalog');");
    expect(page).toMatch(/if \(providerReturnTo === 'model'\) \{\s*setPresetProviderKey\(provider\.key\);\s*return;\s*\}\s*openCatalog\(provider\.key\);/);
  });
});

describe('Vector: Create index', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/dashboard/vector/page.tsx'), 'utf8');

  it('is offered only to someone who can write to Vector, in the header and in the empty list', () => {
    expect(page).toContain("const canWriteVector = useCanWriteService('vector');");
    expect(page).toMatch(/\{canWriteVector \? \(\s*<Button[\s\S]*?Create index\s*<\/Button>\s*\) : null\}/);
    expect(page).toMatch(/primaryAction: canWriteVector\s*\?\s*\{\s*label: 'Create index'/);
  });
});

describe('agent knowledge: + New knowledge engine', () => {
  const editor = (writable: PermissionService[], withCreate = true) =>
    shell(writable, h(KnowledgeBindingsEditor, {
      modules: [],
      bindings: [],
      mode: 'combined',
      onBindingsChange: noop,
      onModeChange: noop,
      onModuleCreated: withCreate ? noop : undefined,
    }));

  it('offered to someone who can edit Knowledge Engine', async () => {
    await render(editor(['rag']));
    expect(q('[data-testid="knowledge-create-inline"]')).not.toBeNull();
    expect(text()).toContain(en.agents.config.knowledgeNone);
  });

  it('not offered to anyone else, nor where the caller cannot list what is created', async () => {
    await render(editor([]));
    expect(q('[data-testid="knowledge-create-inline"]')).toBeNull();
    expect(text()).toContain(en.agents.config.knowledgeNoneReadOnly);
    await mounted?.unmount();
    await render(editor(['rag'], false));
    expect(q('[data-testid="knowledge-create-inline"]')).toBeNull();
  });
});

describe('guardrails: + New guardrail', () => {
  const list = (writable: PermissionService[]) =>
    shell(writable, h(GuardrailBindingList, { options: [], value: [], onChange: noop, surface: 'agent' }));

  it('an empty project: a writer creates one in place, nobody is sent away from the unsaved form', async () => {
    await render(list(['guardrails']));
    expect(q('[data-testid="guardrail-create-inline"]')).not.toBeNull();
    expect(q('a[href="/dashboard/guardrails"]')).toBeNull();
  });

  it('anyone else reads who can create one', async () => {
    await render(list([]));
    expect(q('[data-testid="guardrail-create-inline"]')).toBeNull();
    expect(text()).toContain('Someone who can edit Guardrails has to create one.');
  });

  it('with guardrails to attach, the writer still gets "New guardrail" under the picker', async () => {
    await render(shell(['guardrails'], h(GuardrailBindingList, {
      options: [{ key: 'g1', name: 'Jailbreak', enabled: true }],
      value: [],
      onChange: noop,
      surface: 'agent',
    })));
    expect(q('[data-testid="guardrail-create-inline"]')).not.toBeNull();
  });
});

describe('PII: + New PII policy', () => {
  it('a reader of PII gets no button and reads who can create one', async () => {
    await render(shell([], h(PiiProtectionField, { surface: 'agent', value: null, onChange: noop, policies: NO_PII_POLICIES })));
    expect(q('[data-testid="pii-policy-create-inline"]')).toBeNull();
    expect(text()).toContain(piiProtectionEn.policy.noneReadOnly);
  });

  it('a writer gets it', async () => {
    await render(shell(['pii'], h(PiiProtectionField, { surface: 'agent', value: null, onChange: noop, policies: NO_PII_POLICIES })));
    expect(q('[data-testid="pii-policy-create-inline"]')).not.toBeNull();
  });
});

describe('agent memory: + New memory store', () => {
  const panel = (writable: PermissionService[]) =>
    shell(writable, h(AgentMemoryPanel, { value: { enabled: true }, onChange: noop, stores: [], onStoreCreated: noop }));

  it('a writer of Memory is offered a store in place instead of a link to another tab', async () => {
    await render(panel(['memory']));
    expect(q('[data-testid="memory-store-create-inline"]')).not.toBeNull();
    expect(text()).toContain(en.agents.memoryStore.none);
    expect(q('a[href="/dashboard/memory"]')).toBeNull();
  });

  it('anyone else reads who can create one', async () => {
    await render(panel([]));
    expect(q('[data-testid="memory-store-create-inline"]')).toBeNull();
    expect(text()).toContain(en.agents.memoryStore.noneReadOnly);
  });
});

describe('agent tools: + Add > New custom tool / New MCP server for this agent', () => {
  const list = (writable: PermissionService[]) => {
    installApiMock([
      ['GET', '/api/tools', () => ({ tools: [] })],
      ['GET', '/api/mcp', () => ({ servers: [] })],
    ]);
    return shell(writable, h(AgentToolsList, { agentId: 'agent-1', bindings: [], onBindingsChange: noop }));
  };

  it('each offered only to someone who can create it; adding from the hub and the library always', async () => {
    await render(list(['tools']));
    await click(q('[data-testid="agent-tools-add"]'));
    expect(q('[data-testid="agent-tools-new-tool"]')).not.toBeNull();
    expect(q('[data-testid="agent-tools-new-mcp"]')).toBeNull();
    expect(q('[data-testid="agent-tools-from-library"]')).not.toBeNull();
    await mounted?.unmount();
    await render(list(['mcp']));
    await click(q('[data-testid="agent-tools-add"]'));
    expect(q('[data-testid="agent-tools-new-tool"]')).toBeNull();
    expect(q('[data-testid="agent-tools-new-mcp"]')).not.toBeNull();
    expect(q('[data-testid="agent-tools-from-library"]')).not.toBeNull();
  });
});

describe('Knowledge Engine create: its dependencies in place', () => {
  const form = (writable: PermissionService[]) => {
    installApiMock([
      ['GET', '/api/models', () => ({ models: [] })],
      ['GET', '/api/vector/providers', () => ({ providers: [] })],
      ['GET', '/api/reranker', () => ({ rerankers: [] })],
    ]);
    return shell(writable, h(CreateRagModuleModal, { opened: true, onClose: noop, onCreated: noop }));
  };

  it('a writer of Model Hub and Knowledge Index adds an embedding model and a vector provider from the form', async () => {
    await render(form(['models', 'vector']));
    expect(q('[data-testid="rag-add-embedding-model"]')).not.toBeNull();
    expect(q('[data-testid="rag-add-vector-provider"]')).not.toBeNull();
    // No provider chosen yet: nothing to create an index on.
    expect(q('[data-testid="rag-add-vector-index"]')).toBeNull();
    expect(text()).toContain('This project has no embedding model yet. Add one here');
    expect(text()).toContain('This project has no vector provider yet. Add one here');
  });

  it('anyone else reads who can add them', async () => {
    await render(form([]));
    expect(q('[data-testid="rag-add-embedding-model"]')).toBeNull();
    expect(q('[data-testid="rag-add-vector-provider"]')).toBeNull();
    expect(text()).toContain('Someone who can edit Model Hub has to add one.');
    expect(text()).toContain('Someone who can edit Knowledge Index has to add one.');
  });
});

describe('the new texts read in Turkish too', () => {
  it('has every new key, translated', () => {
    const pairs: Array<[string, string]> = [
      [en.agents.createModal.addModel, tr.agents.createModal.addModel],
      [en.agents.createModal.noModels, tr.agents.createModal.noModels],
      [en.agents.createModal.noModelsReadOnly, tr.agents.createModal.noModelsReadOnly],
      [en.agents.config.knowledgeCreate, tr.agents.config.knowledgeCreate],
      [en.agents.config.knowledgeNone, tr.agents.config.knowledgeNone],
      [en.agents.config.knowledgeNoneReadOnly, tr.agents.config.knowledgeNoneReadOnly],
      [en.agents.memoryStore.create, tr.agents.memoryStore.create],
      [en.agents.memoryStore.none, tr.agents.memoryStore.none],
      [en.agents.memoryStore.noneReadOnly, tr.agents.memoryStore.noneReadOnly],
      [piiProtectionEn.policy.new, piiProtectionTr.policy.new],
      [piiProtectionEn.policy.noneReadOnly, piiProtectionTr.policy.noneReadOnly],
    ];
    for (const [english, turkish] of pairs) {
      expect(turkish).toBeTruthy();
      expect(turkish).not.toBe(english);
    }
  });
});
