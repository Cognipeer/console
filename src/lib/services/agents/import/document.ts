/**
 * Reads an agent definition document in whichever envelope it arrives:
 * JSON, YAML, or Markdown with YAML front-matter (Claude Managed Agents'
 * CLI files: `---\n<yaml>\n---\n<system prompt>`).
 *
 * Returns the parsed object plus the Markdown body, if any — the importer
 * decides what the body means (for a Claude agent it is the system prompt).
 */

import YAML from 'yaml';

export interface ParsedAgentDocument {
    data: Record<string, unknown>;
    /** Markdown after the front-matter block, trimmed; undefined for plain JSON/YAML. */
    body?: string;
    envelope: 'json' | 'yaml' | 'markdown';
}

export class AgentDocumentParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AgentDocumentParseError';
    }
}

/** Largest document accepted — an agent definition is a few KB; this is a paste-bomb guard. */
export const MAX_AGENT_DOCUMENT_BYTES = 512 * 1024;

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

function asObject(value: unknown, envelope: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AgentDocumentParseError(`The ${envelope} document must be an object at the top level.`);
    }
    return value as Record<string, unknown>;
}

function parseOr(parse: (text: string) => unknown, text: string, failure: string): unknown {
    try {
        return parse(text);
    } catch (error) {
        throw new AgentDocumentParseError(`${failure}: ${(error as Error).message}`);
    }
}

export function parseAgentDocument(text: string): ParsedAgentDocument {
    if (typeof text !== 'string' || !text.trim()) {
        throw new AgentDocumentParseError('The document is empty.');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_AGENT_DOCUMENT_BYTES) {
        throw new AgentDocumentParseError(`The document is larger than ${MAX_AGENT_DOCUMENT_BYTES / 1024} KB.`);
    }
    const trimmed = text.trim();

    const frontMatter = FRONT_MATTER.exec(trimmed);
    if (frontMatter) {
        const data = parseOr((t) => YAML.parse(t), frontMatter[1], 'Front-matter is not valid YAML');
        const body = frontMatter[2]?.trim();
        return { data: asObject(data, 'front-matter'), ...(body ? { body } : {}), envelope: 'markdown' };
    }

    if (trimmed.startsWith('{')) {
        return { data: asObject(parseOr(JSON.parse, trimmed, 'Not valid JSON'), 'JSON'), envelope: 'json' };
    }

    return { data: asObject(parseOr((t) => YAML.parse(t), trimmed, 'Not valid YAML or JSON'), 'YAML'), envelope: 'yaml' };
}
