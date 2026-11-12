import type { IMcpTool } from '@/lib/database';
import type { OpenApiSpec, OpenApiOperation } from './types';
import { normalizeApiSpec, type SpecFormatHint } from '@/lib/services/specImport';

// ── OpenAPI Parsing ───────────────────────────────────────────────────────

export function parseOpenApiSpec(specString: string, format: SpecFormatHint = 'auto'): {
  spec: OpenApiSpec;
  tools: IMcpTool[];
  baseUrl: string;
  /** Canonical OpenAPI JSON string (YAML/Postman inputs are converted). */
  normalizedSpec: string;
} {
  // Accept OpenAPI JSON/YAML or a Postman collection; normalize to OpenAPI JSON.
  const { openApiJson } = normalizeApiSpec(specString, format);

  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(openApiJson);
  } catch {
    throw new Error('Invalid JSON: could not parse OpenAPI specification');
  }

  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('OpenAPI specification must contain a "paths" object');
  }

  // Extract base URL from servers array
  let baseUrl = '';
  if (spec.servers && spec.servers.length > 0) {
    baseUrl = spec.servers[0].url;
  }

  const tools: IMcpTool[] = [];
  const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of httpMethods) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation) continue;

      const toolName = operation.operationId
        || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const description = operation.summary || operation.description || `${method.toUpperCase()} ${path}`;

      // Build input schema from parameters + requestBody
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      if (operation.parameters) {
        for (const param of operation.parameters) {
          properties[param.name] = {
            type: (param.schema as Record<string, unknown>)?.type || 'string',
            description: param.description || `Parameter: ${param.name} (in ${param.in})`,
            ...(param.schema || {}),
          };
          if (param.required) required.push(param.name);
        }
      }

      if (operation.requestBody?.content) {
        const jsonContent = operation.requestBody.content['application/json'];
        if (jsonContent?.schema) {
          properties['body'] = {
            ...jsonContent.schema,
            description: 'Request body',
          };
          if (operation.requestBody.required) required.push('body');
        }
      }

      const inputSchema: Record<string, unknown> = {
        type: 'object',
        properties,
      };
      if (required.length > 0) inputSchema.required = required;

      tools.push({
        name: toolName,
        ...(operation.summary?.trim() ? { title: operation.summary.trim() } : {}),
        description,
        inputSchema,
        httpMethod: method.toUpperCase(),
        httpPath: path,
      });
    }
  }

  if (tools.length === 0) {
    throw new Error('No operations found in the OpenAPI specification');
  }

  return { spec, tools, baseUrl, normalizedSpec: openApiJson };
}
