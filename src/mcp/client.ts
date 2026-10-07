import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JsonValue } from '../core/json.js';
import { MCP_TOOL_NAMES } from './tools.js';
import type { MCPToolName } from './tools.js';

/**
 * MCP client (Milestone 3).
 *
 * A client for connecting to the MCP server over stdio.
 * Used for local self-testing: spawn the server as a child
 * process, connect, list tools, invoke tools, and verify
 * results — all locally, deterministically, with zero network
 * access.
 */

/** Result of an MCP tool invocation. */
export interface MCPToolResult {
  readonly ok: boolean;
  readonly tool: string;
  readonly data?: JsonValue;
  readonly error?: string;
}

/** A discovered MCP tool. */
export interface MCPDiscoveredTool {
  readonly name: string;
  readonly description: string;
}

/**
 * Connect to an MCP server via stdio.
 *
 * Spawns the server command as a child process and connects
 * an MCP client over stdin/stdout.
 */
export async function connectMCPServer(command: string, args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command,
    args,
  });
  const client = new Client({
    name: 'digital-workforce-os-self-test',
    version: '0.3.0',
  });
  await client.connect(transport);
  return client;
}

/** List all tools exposed by the MCP server. */
export async function listMCPTools(client: Client): Promise<MCPDiscoveredTool[]> {
  const response = await client.listTools();
  return response.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
  }));
}

/** Invoke an MCP tool with validated input. */
export async function invokeMCPTool(
  client: Client,
  toolName: MCPToolName,
  input: JsonValue,
): Promise<MCPToolResult> {
  try {
    const response = await client.callTool({
      name: toolName,
      arguments: input as Record<string, unknown>,
    });

    if (response.isError === true) {
      const text = (response.content as Array<{ type: string; text: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return { ok: false, tool: toolName, error: text };
    }

    const text = (response.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    let data: JsonValue;
    try {
      data = JSON.parse(text) as JsonValue;
    } catch {
      data = text;
    }

    return { ok: true, tool: toolName, data };
  } catch (error) {
    return {
      ok: false,
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Close the MCP client connection. */
export async function closeMCPClient(client: Client): Promise<void> {
  await client.close();
}

/** All MCP tool names exposed by the server. */
export { MCP_TOOL_NAMES };
export type { MCPToolName };
