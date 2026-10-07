import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { JsonValue } from '../core/json.js';
import { validateToolInput } from './tools.js';

/**
 * MCP server (Milestone 3).
 *
 * A real stdio MCP server using the official Model Context
 * Protocol TypeScript SDK. Exposes safe, read-only tools that
 * reuse existing internal capabilities (ToolRegistry, KnowledgeStore)
 * rather than creating a second execution system.
 *
 * Tools:
 * - repository.inspect: List repository structure
 * - repository.search: Search repository files
 * - file.read: Read a file (bounded by existing architecture)
 * - knowledge.search: Search the local knowledge base
 * - workflow.status: Get workflow/run status
 *
 * All inputs are validated. All results are structured. All
 * operations are local and deterministic.
 */

/** Dependencies for the MCP server. */
export interface MCPServerDeps {
  readonly knowledgeStore: KnowledgeStore;
  readonly tools: ToolRegistry;
  /** Root directory for repository tools. Defaults to process.cwd(). */
  readonly rootDir?: string;
  /** Optional workflow status provider. */
  readonly getWorkflowStatus?: (runId?: string) => JsonValue;
}

/**
 * Create and configure an MCP server with all tools registered.
 * Returns the configured server (not yet connected).
 */
export function createMCPServer(deps: MCPServerDeps): McpServer {
  const server = new McpServer({
    name: 'digital-workforce-os',
    version: '0.3.0',
  });

  const rootDir = deps.rootDir ?? process.cwd();

  // ---- repository.inspect ----
  server.registerTool(
    'repository.inspect',
    {
      title: 'Repository Inspect',
      description: 'List the repository structure: directories, files, and module boundaries.',
      inputSchema: {
        path: z.string().optional().describe('Optional subdirectory path to inspect'),
      },
    },
    async (args) => {
      const input = args as { path?: string };
      const validation = validateToolInput('repository.inspect', input);
      if (!validation.ok) {
        return errorResult('repository.inspect', validation.issues.join('; '));
      }
      const result = await repositoryInspect(rootDir, input.path);
      return successResult(result);
    },
  );

  // ---- repository.search ----
  server.registerTool(
    'repository.search',
    {
      title: 'Repository Search',
      description: 'Search repository files for a query string.',
      inputSchema: {
        query: z.string().describe('Search query string'),
        path: z.string().optional().describe('Optional path to limit search scope'),
        maxResults: z.number().int().optional().describe('Maximum results to return'),
      },
    },
    async (args) => {
      const input = args as { query: string; path?: string; maxResults?: number };
      const validation = validateToolInput('repository.search', input);
      if (!validation.ok) {
        return errorResult('repository.search', validation.issues.join('; '));
      }
      const result = await repositorySearch(rootDir, input.query, input.path, input.maxResults);
      return successResult(result);
    },
  );

  // ---- file.read ----
  server.registerTool(
    'file.read',
    {
      title: 'File Read',
      description: 'Read a file from the repository. Bounded by the existing architecture.',
      inputSchema: {
        path: z.string().describe('File path to read'),
        offset: z.number().int().optional().describe('Line offset to start reading from'),
        limit: z.number().int().optional().describe('Maximum number of lines to return'),
      },
    },
    async (args) => {
      const input = args as { path: string; offset?: number; limit?: number };
      const validation = validateToolInput('file.read', input);
      if (!validation.ok) {
        return errorResult('file.read', validation.issues.join('; '));
      }
      const result = await fileRead(rootDir, input.path, input.offset, input.limit);
      return successResult(result);
    },
  );

  // ---- knowledge.search ----
  server.registerTool(
    'knowledge.search',
    {
      title: 'Knowledge Search',
      description: 'Search the local knowledge base for relevant chunks with source attribution.',
      inputSchema: {
        query: z.string().describe('Search query for the knowledge base'),
        topK: z.number().int().optional().describe('Maximum number of chunks to return'),
      },
    },
    async (args) => {
      const input = args as { query: string; topK?: number };
      const validation = validateToolInput('knowledge.search', input);
      if (!validation.ok) {
        return errorResult('knowledge.search', validation.issues.join('; '));
      }
      const result = knowledgeSearch(deps.knowledgeStore, input.query, input.topK);
      return successResult(result);
    },
  );

  // ---- workflow.status ----
  server.registerTool(
    'workflow.status',
    {
      title: 'Workflow Status',
      description: 'Get the current status of a workflow run or the overall system.',
      inputSchema: {
        runId: z.string().optional().describe('Optional run id to get status for'),
      },
    },
    async (args) => {
      const input = args as { runId?: string };
      const validation = validateToolInput('workflow.status', input);
      if (!validation.ok) {
        return errorResult('workflow.status', validation.issues.join('; '));
      }
      const result = deps.getWorkflowStatus?.(input.runId) ?? { status: 'no active runs' };
      return successResult(result);
    },
  );

  return server;
}

/** Connect the MCP server to stdio transport. */
export async function startMCPServer(deps: MCPServerDeps): Promise<McpServer> {
  const server = createMCPServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

// ---- Tool implementations ---------------------------------------------------

function successResult(data: JsonValue) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

function errorResult(tool: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

async function repositoryInspect(
  rootDir: string,
  subPath?: string,
): Promise<JsonValue> {
  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');

  const targetDir = subPath ? join(rootDir, subPath) : rootDir;
  const entries: Array<{ name: string; type: string; size?: number }> = [];

  try {
    for (const entry of readdirSync(targetDir).sort()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const fullPath = join(targetDir, entry);
      const stat = statSync(fullPath);
      entries.push({
        name: entry,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? stat.size : undefined,
      });
    }
  } catch (error) {
    return { error: `cannot inspect: ${error instanceof Error ? error.message : String(error)}` };
  }

  return {
    path: subPath ?? '.',
    relativePath: relative(rootDir, targetDir) || '.',
    entries,
  };
}

async function repositorySearch(
  rootDir: string,
  query: string,
  subPath?: string,
  maxResults: number = 10,
): Promise<JsonValue> {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const targetDir = subPath ? join(rootDir, subPath) : rootDir;
  const results: Array<{ path: string; line: number; match: string }> = [];
  const queryLower = query.toLowerCase();

  const searchDir = async (dir: string): Promise<void> => {
    if (results.length >= maxResults) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries.sort()) {
      if (results.length >= maxResults) return;
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        await searchDir(fullPath);
      } else if (stat.isFile() && entry.match(/\.(ts|js|md|json|txt|yaml|yml)$/)) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            const line = lines[i]!;
            if (line.toLowerCase().includes(queryLower)) {
              results.push({
                path: fullPath.slice(rootDir.length + 1),
                line: i + 1,
                match: line.trim().slice(0, 120),
              });
            }
          }
        } catch {
          // Skip unreadable files.
        }
      }
    }
  };

  await searchDir(targetDir);
  return { query, resultCount: results.length, results };
}

async function fileRead(
  rootDir: string,
  filePath: string,
  offset?: number,
  limit?: number,
): Promise<JsonValue> {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, relative } = await import('node:path');

  // Security: ensure the resolved path stays within rootDir.
  const resolved = resolve(rootDir, filePath);
  const rel = relative(rootDir, resolved);
  if (rel.startsWith('..')) {
    return { error: 'path escapes root directory' };
  }

  try {
    const content = readFileSync(resolved, 'utf-8');
    const lines = content.split('\n');
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : lines.length;
    const selected = lines.slice(start, end);

    return {
      path: filePath,
      totalLines: lines.length,
      offset: start,
      limit: selected.length,
      content: selected.join('\n'),
    };
  } catch (error) {
    return { error: `cannot read file: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function knowledgeSearch(
  store: KnowledgeStore,
  query: string,
  topK?: number,
): JsonValue {
  const result = store.retrieve(query, topK ?? 5);
  return {
    query,
    totalCandidates: result.totalCandidates,
    chunks: result.chunks.map((c) => ({
      id: c.chunk.id,
      source: c.chunk.metadata.source,
      score: c.score,
      content: c.chunk.content.slice(0, 200),
    })),
  };
}
