import { describe, expect, it } from 'vitest';
import { validateToolInput, getToolSchema, MCP_TOOL_NAMES } from '../src/mcp/tools.js';
import type { MCPToolName } from '../src/mcp/tools.js';

describe('MCP — tool definitions', () => {
  it('exposes all required tools', () => {
    expect(MCP_TOOL_NAMES).toContain('repository.inspect');
    expect(MCP_TOOL_NAMES).toContain('repository.search');
    expect(MCP_TOOL_NAMES).toContain('file.read');
    expect(MCP_TOOL_NAMES).toContain('knowledge.search');
    expect(MCP_TOOL_NAMES).toContain('workflow.status');
  });

  it('has a schema for every tool', () => {
    for (const name of MCP_TOOL_NAMES) {
      const schema = getToolSchema(name);
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('type', 'object');
    }
  });
});

describe('MCP — input validation', () => {
  it('accepts valid repository.inspect input', () => {
    const result = validateToolInput('repository.inspect', { path: 'src' });
    expect(result.ok).toBe(true);
  });

  it('accepts empty repository.inspect input', () => {
    const result = validateToolInput('repository.inspect', {});
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const result = validateToolInput('repository.inspect', 'not an object');
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('accepts valid repository.search input', () => {
    const result = validateToolInput('repository.search', { query: 'test' });
    expect(result.ok).toBe(true);
  });

  it('rejects repository.search without query', () => {
    const result = validateToolInput('repository.search', {});
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('query'))).toBe(true);
  });

  it('rejects wrong type for maxResults', () => {
    const result = validateToolInput('repository.search', { query: 'test', maxResults: 'ten' });
    expect(result.ok).toBe(false);
  });

  it('accepts valid file.read input', () => {
    const result = validateToolInput('file.read', { path: 'src/index.ts' });
    expect(result.ok).toBe(true);
  });

  it('rejects file.read without path', () => {
    const result = validateToolInput('file.read', {});
    expect(result.ok).toBe(false);
  });

  it('accepts valid knowledge.search input', () => {
    const result = validateToolInput('knowledge.search', { query: 'test', topK: 5 });
    expect(result.ok).toBe(true);
  });

  it('rejects knowledge.search without query', () => {
    const result = validateToolInput('knowledge.search', {});
    expect(result.ok).toBe(false);
  });

  it('accepts valid workflow.status input', () => {
    const result = validateToolInput('workflow.status', {});
    expect(result.ok).toBe(true);
  });

  it('accepts workflow.status with runId', () => {
    const result = validateToolInput('workflow.status', { runId: 'run-123' });
    expect(result.ok).toBe(true);
  });
});

describe('MCP — server creation', () => {
  it('creates an MCP server with all tools registered', async () => {
    const { createMCPServer } = await import('../src/mcp/server.js');
    const { KnowledgeStore } = await import('../src/knowledge/knowledge-store.js');
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');

    const store = new KnowledgeStore();
    const tools = new ToolRegistry();

    const server = createMCPServer({
      knowledgeStore: store,
      tools,
    });

    expect(server).toBeDefined();
    // The server is created but not connected — that's fine for this test.
  });

  it('creates a server with custom root directory', async () => {
    const { createMCPServer } = await import('../src/mcp/server.js');
    const { KnowledgeStore } = await import('../src/knowledge/knowledge-store.js');
    const { ToolRegistry } = await import('../src/tools/tool-registry.js');

    const server = createMCPServer({
      knowledgeStore: new KnowledgeStore(),
      tools: new ToolRegistry(),
      rootDir: '/tmp',
    });

    expect(server).toBeDefined();
  });
});

describe('MCP — tool schema validation', () => {
  it('repository.search requires query', () => {
    const schema = getToolSchema('repository.search') as { required?: string[] };
    expect(schema.required).toContain('query');
  });

  it('file.read requires path', () => {
    const schema = getToolSchema('file.read') as { required?: string[] };
    expect(schema.required).toContain('path');
  });

  it('knowledge.search requires query', () => {
    const schema = getToolSchema('knowledge.search') as { required?: string[] };
    expect(schema.required).toContain('query');
  });

  it('repository.inspect has no required fields', () => {
    const schema = getToolSchema('repository.inspect') as { required?: string[] };
    expect(schema.required ?? []).toHaveLength(0);
  });

  it('workflow.status has no required fields', () => {
    const schema = getToolSchema('workflow.status') as { required?: string[] };
    expect(schema.required ?? []).toHaveLength(0);
  });
});
