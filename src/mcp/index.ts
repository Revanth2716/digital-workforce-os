/**
 * MCP layer (Milestone 3).
 *
 * Real Model Context Protocol integration using the official
 * TypeScript SDK. Provides:
 * - A stdio MCP server exposing safe, read-only tools
 * - An MCP client for local self-testing
 * - Input validation and structured tool results
 * - Reuse of existing internal ToolRegistry capabilities
 *
 * All operations are local and deterministic. No network
 * access, no paid services, no API keys.
 */
export * from './tools.js';
export * from './server.js';
export * from './client.js';
