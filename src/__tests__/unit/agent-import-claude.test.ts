import { describe, expect, it } from 'vitest';
import { parseAgentDocument, AgentDocumentParseError } from '@/lib/services/agents/import/document';
import {
    applyToolFilter,
    detectClaudeManagedAgent,
    planClaudeManagedAgent,
} from '@/lib/services/agents/import/claudeManagedAgent';

const CLI_FILE = `---
name: Coding Assistant
model: claude-opus-5-5
description: Assists with code writing
tools:
  - type: agent_toolset_20260401
    configs:
      - name: web_fetch
        enabled: false
  - type: mcp_toolset
    mcp_server_name: github
    configs:
      - name: delete_repo
        enabled: false
  - type: custom
    name: get_weather
    description: Get weather
    input_schema:
      type: object
mcp_servers:
  - type: url
    name: github
    url: https://api.githubcopilot.com/mcp/
  - type: url
    name: unused
    url: https://example.com/mcp
skills:
  - type: anthropic
    skill_id: xlsx
    version: latest
  - type: custom
    skill_id: skill_01AbCd
    version: "2"
multiagent:
  type: coordinator
metadata:
  team: engineering
---

You are a helpful coding agent. Write clean, well-documented code.
`;

const API_RESPONSE = {
    id: 'agent_01HqR2k7vXbZ9mNpL3wYcT8f',
    type: 'agent',
    name: 'Research bot',
    model: { id: 'claude-sonnet-5', speed: 'standard' },
    system: 'You research.',
    tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: false }, configs: [{ name: 'web_search', enabled: true }, { name: 'bash', enabled: true }] }],
    mcp_servers: [],
    skills: [],
    version: 3,
};

describe('parseAgentDocument', () => {
    it('reads Markdown front-matter and keeps the body', () => {
        const doc = parseAgentDocument(CLI_FILE);
        expect(doc.envelope).toBe('markdown');
        expect(doc.data.name).toBe('Coding Assistant');
        expect(doc.body).toBe('You are a helpful coding agent. Write clean, well-documented code.');
    });

    it('reads JSON and YAML', () => {
        expect(parseAgentDocument(JSON.stringify(API_RESPONSE)).envelope).toBe('json');
        expect(parseAgentDocument('name: x\nmodel: claude-opus-5-5').envelope).toBe('yaml');
    });

    it('rejects empty, non-object and oversized documents', () => {
        expect(() => parseAgentDocument('   ')).toThrow(AgentDocumentParseError);
        expect(() => parseAgentDocument('- a\n- b')).toThrow(/object at the top level/);
        expect(() => parseAgentDocument('x'.repeat(600 * 1024))).toThrow(/larger than/);
    });
});

describe('detectClaudeManagedAgent', () => {
    it('is confident about the CLI file and the API response', () => {
        expect(detectClaudeManagedAgent(parseAgentDocument(CLI_FILE))).toBeGreaterThanOrEqual(90);
        expect(detectClaudeManagedAgent(parseAgentDocument(JSON.stringify(API_RESPONSE)))).toBeGreaterThanOrEqual(90);
    });

    it('recognises a minimal definition by its claude model', () => {
        expect(detectClaudeManagedAgent(parseAgentDocument('name: x\nmodel: claude-opus-5-5'))).toBeGreaterThanOrEqual(50);
    });

    it('does not claim a console manifest or an unrelated document', () => {
        expect(detectClaudeManagedAgent(parseAgentDocument('apiVersion: cognipeer.console/v1\nkind: Agent\nmetadata: {}\nspec: {}'))).toBe(0);
        expect(detectClaudeManagedAgent(parseAgentDocument('name: x\nmodel: gpt-5'))).toBe(0);
    });
});

describe('planClaudeManagedAgent', () => {
    it('maps the CLI file: prompt from the body, builtins, MCP filters, skills, unsupported parts', () => {
        const plan = planClaudeManagedAgent(parseAgentDocument(CLI_FILE));
        expect(plan.name).toBe('Coding Assistant');
        expect(plan.model).toBe('claude-opus-5-5');
        expect(plan.systemPrompt).toContain('helpful coding agent');
        expect(plan.builtins).toEqual({
            sandbox: ['bash', 'read', 'write', 'edit', 'glob', 'grep'],
            webSearch: true,
            webFetch: false,
        });
        expect(plan.mcpServers).toEqual([
            { ref: 'github', url: 'https://api.githubcopilot.com/mcp/', toolFilter: { mode: 'all-except', names: ['delete_repo'] }, referenced: true },
            { ref: 'unused', url: 'https://example.com/mcp', toolFilter: { mode: 'only', names: [] }, referenced: false },
        ]);
        expect(plan.skills).toEqual([
            { ref: 'anthropic:xlsx', kind: 'anthropic', skillId: 'xlsx', version: 'latest' },
            { ref: 'custom:skill_01AbCd', kind: 'custom', skillId: 'skill_01AbCd', version: '2' },
        ]);
        expect(plan.unsupported.map((u) => u.code).sort()).toEqual(['custom_tool', 'multiagent']);
        expect(plan.metadata).toEqual({ team: 'engineering' });
    });

    it('maps an API response: model object, default_config disabled → only listed tools, provenance', () => {
        const plan = planClaudeManagedAgent(parseAgentDocument(JSON.stringify(API_RESPONSE)));
        expect(plan.model).toBe('claude-sonnet-5');
        expect(plan.systemPrompt).toBe('You research.');
        expect(plan.builtins).toEqual({ sandbox: ['bash'], webSearch: true, webFetch: false });
        expect(plan.source).toEqual({ id: 'agent_01HqR2k7vXbZ9mNpL3wYcT8f', version: 3 });
    });

    it('prefers `system` over the Markdown body and flags a toolset pointing at a missing server', () => {
        const plan = planClaudeManagedAgent(parseAgentDocument(`---
name: X
system: From system
tools:
  - type: mcp_toolset
    mcp_server_name: ghost
---
From body`));
        expect(plan.systemPrompt).toBe('From system');
        expect(plan.unsupported.some((u) => u.code === 'mcp_missing')).toBe(true);
    });

    it('requires a name', () => {
        expect(() => planClaudeManagedAgent(parseAgentDocument('model: claude-opus-5-5'))).toThrow(/needs a name/);
    });
});

describe('applyToolFilter', () => {
    it('all-except drops the disabled tools; only keeps the enabled ones', () => {
        expect(applyToolFilter(['a', 'b', 'c'], { mode: 'all-except', names: ['b'] })).toEqual(['a', 'c']);
        expect(applyToolFilter(['a', 'b', 'c'], { mode: 'only', names: ['c'] })).toEqual(['c']);
    });
});
