/**
 * Safe Git service (Milestone 5-C).
 *
 * Workspace-bounded Git operations exposed as governed tools, so
 * every commit still passes through ToolRegistry -> PolicyGate ->
 * Approval. GitHub integration is a separate, optional concern
 * (see `src/github/`).
 */
export * from './workspace.js';
export * from './git-error.js';
export * from './git-service.js';
export * from './git-tools.js';