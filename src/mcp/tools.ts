import type { JsonValue } from '../core/json.js';

/**
 * MCP tool definitions (Milestone 3).
 *
 * Defines the safe tools exposed by the MCP server. Each tool
 * has a name, description, and JSON Schema input validation.
 * The MCP layer reuses the existing internal ToolRegistry
 * capabilities where appropriate — it does not create a second
 * execution system.
 *
 * All tools are read-only and operate on local data only.
 */

/** Input for repository.inspect. */
export interface RepositoryInspectInput {
  readonly path?: string;
}

/** Input for repository.search. */
export interface RepositorySearchInput {
  readonly query: string;
  readonly path?: string;
  readonly maxResults?: number;
}

/** Input for file.read. */
export interface FileReadInput {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

/** Input for knowledge.search. */
export interface KnowledgeSearchInput {
  readonly query: string;
  readonly topK?: number;
}

/** Input for workflow.status. */
export interface WorkflowStatusInput {
  readonly runId?: string;
}

/** JSON Schema for repository.inspect input. */
export const repositoryInspectSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Optional subdirectory path to inspect' },
  },
  required: [] as string[],
};

/** JSON Schema for repository.search input. */
export const repositorySearchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query string' },
    path: { type: 'string', description: 'Optional path to limit search scope' },
    maxResults: { type: 'integer', description: 'Maximum results to return' },
  },
  required: ['query'] as string[],
};

/** JSON Schema for file.read input. */
export const fileReadSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path to read' },
    offset: { type: 'integer', description: 'Line offset to start reading from' },
    limit: { type: 'integer', description: 'Maximum number of lines to return' },
  },
  required: ['path'] as string[],
};

/** JSON Schema for knowledge.search input. */
export const knowledgeSearchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query for the knowledge base' },
    topK: { type: 'integer', description: 'Maximum number of chunks to return' },
  },
  required: ['query'] as string[],
};

/** JSON Schema for workflow.status input. */
export const workflowStatusSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', description: 'Optional run id to get status for' },
  },
  required: [] as string[],
};

/** All MCP tool names. */
export const MCP_TOOL_NAMES = [
  'repository.inspect',
  'repository.search',
  'file.read',
  'knowledge.search',
  'workflow.status',
] as const;

export type MCPToolName = (typeof MCP_TOOL_NAMES)[number];

/** Get the input schema for an MCP tool. */
export function getToolSchema(toolName: MCPToolName): JsonValue {
  switch (toolName) {
    case 'repository.inspect':
      return repositoryInspectSchema;
    case 'repository.search':
      return repositorySearchSchema;
    case 'file.read':
      return fileReadSchema;
    case 'knowledge.search':
      return knowledgeSearchSchema;
    case 'workflow.status':
      return workflowStatusSchema;
  }
}

/** Validate input against a tool's JSON Schema. */
export function validateToolInput(toolName: MCPToolName, input: unknown): { ok: boolean; issues: string[] } {
  const schema = getToolSchema(toolName);
  const issues: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.push('input must be an object');
    return { ok: false, issues };
  }

  const obj = input as Record<string, unknown>;
  const properties = (schema as { properties?: Record<string, { type: string }> }).properties ?? {};
  const required = (schema as { required?: string[] }).required ?? [];

  for (const req of required) {
    if (!(req in obj)) {
      issues.push(`missing required property: ${req}`);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const propSchema = properties[key];
    if (propSchema === undefined) continue; // allow additional properties

    const expectedType = propSchema.type;
    if (expectedType === 'string' && typeof value !== 'string') {
      issues.push(`${key}: expected string, got ${typeof value}`);
    } else if (expectedType === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) {
      issues.push(`${key}: expected integer, got ${typeof value}`);
    } else if (expectedType === 'number' && typeof value !== 'number') {
      issues.push(`${key}: expected number, got ${typeof value}`);
    } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
      issues.push(`${key}: expected boolean, got ${typeof value}`);
    }
  }

  return { ok: issues.length === 0, issues };
}
