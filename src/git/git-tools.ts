/**
 * Git tools (Milestone 5-C).
 *
 * `GitService` operations exposed as `Tool` implementations, so
 * they inherit the existing governed execution path for free:
 *
 *   Agent -> ToolCallRequest -> ToolRegistry.execute()
 *        -> schema validation
 *        -> PolicyGate (ALLOW | DENY | REQUIRE_APPROVAL)
 *        -> approval
 *        -> GitService (workspace-bounded)
 *
 * There is no second execution path and no way to call
 * `GitService` as an agent tool without policy evaluation. The
 * read-only operations map to READ; creating a branch maps to
 * WRITE_WORKSPACE; committing maps to COMMIT and therefore always
 * requires human approval.
 */

import type { Tool, ToolContext, Schema } from '../tools/tool.js';
import type { GitService } from './git-service.js';
import { validateBranchName, validateCommitMessage } from './git-service.js';
import { GitError } from './git-error.js';
import type { JsonValue } from '../core/json.js';

function asObject(value: JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read the repository status. */
export class GitStatusTool implements Tool {
  readonly name = 'git.status';
  readonly description = 'Report the current branch and working-tree status';
  readonly inputSchema: Schema = {
    type: 'object',
    properties: {},
    required: [],
  };
  readonly readOnly = true;

  constructor(private readonly git: GitService) {}

  async execute(_args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    return (await this.git.status()) as unknown as JsonValue;
  }
}

/** Inspect a diff, optionally scoped to a workspace path. */
export class GitDiffTool implements Tool {
  readonly name = 'git.diff';
  readonly description = 'Summarize and return the current diff (workspace-bounded)';
  readonly inputSchema: Schema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional path inside the workspace' },
      staged: { type: 'boolean', description: 'Diff the index instead of the working tree' },
    },
    required: [],
  };
  readonly readOnly = true;

  constructor(private readonly git: GitService) {}

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const input = asObject(args);
    const path = typeof input['path'] === 'string' ? input['path'] : undefined;

    return (await this.git.diff({
      ...(path !== undefined ? { path } : {}),
      ...(input['staged'] === true ? { staged: true } : {}),
    })) as unknown as JsonValue;
  }
}

/** Read recent commit history. */
export class GitLogTool implements Tool {
  readonly name = 'git.log';
  readonly description = 'List recent commits, newest first';
  readonly inputSchema: Schema = {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Maximum commits to return' },
    },
    required: [],
  };
  readonly readOnly = true;

  constructor(private readonly git: GitService) {}

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const input = asObject(args);
    const limit = typeof input['limit'] === 'number' ? input['limit'] : 10;
    return { commits: (await this.git.log(limit)) as unknown as JsonValue };
  }
}

/** Report the current branch. */
export class GitCurrentBranchTool implements Tool {
  readonly name = 'git.current_branch';
  readonly description = 'Report the current branch name';
  readonly inputSchema: Schema = {
    type: 'object',
    properties: {},
    required: [],
  };
  readonly readOnly = true;

  constructor(private readonly git: GitService) {}

  async execute(_args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    return { branch: await this.git.currentBranch() };
  }
}

/** Create and check out a branch (requires WRITE_WORKSPACE). */
export class GitCreateBranchTool implements Tool {
  readonly name = 'git.create_branch';
  readonly description = 'Create a branch and check it out';
  readonly inputSchema: Schema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Branch name (letters, digits, . _ - /)' },
    },
    required: ['name'],
  };
  readonly readOnly = false;

  constructor(private readonly git: GitService) {}

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const input = asObject(args);
    const name = input['name'];
    if (typeof name !== 'string') {
      throw new GitError('branch name must be a string');
    }
    return (await this.git.createBranch(validateBranchName(name))) as unknown as JsonValue;
  }
}

/** Stage paths and build a commit message without committing. */
export class GitPrepareCommitTool implements Tool {
  readonly name = 'git.prepare_commit';
  readonly description = 'Stage workspace paths and build a commit without committing';
  readonly inputSchema: Schema = {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Single-line commit message' },
      paths: {
        type: 'array',
        description: 'Workspace-relative paths to stage',
        items: { type: 'string' },
      },
    },
    required: ['message'],
  };
  readonly readOnly = false;

  constructor(private readonly git: GitService) {}

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const input = asObject(args);
    const message = input['message'];
    if (typeof message !== 'string') {
      throw new GitError('commit message must be a string');
    }
    const paths = Array.isArray(input['paths'])
      ? (input['paths'] as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];

    return (await this.git.prepareCommit(
      validateCommitMessage(message),
      paths,
    )) as unknown as JsonValue;
  }
}

/** Execute a commit (requires COMMIT approval). */
export class GitExecuteCommitTool implements Tool {
  readonly name = 'git.commit';
  readonly description = 'Create a commit from the staged change set (requires approval)';
  readonly inputSchema: Schema = {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Single-line commit message' },
      allowEmpty: { type: 'boolean', description: 'Allow a commit with no changes' },
    },
    required: ['message'],
  };
  readonly readOnly = false;

  constructor(private readonly git: GitService) {}

  async execute(args: JsonValue, _context: ToolContext): Promise<JsonValue> {
    const input = asObject(args);
    const message = input['message'];
    if (typeof message !== 'string') {
      throw new GitError('commit message must be a string');
    }
    return (await this.git.executeCommit(validateCommitMessage(message), {
      ...(input['allowEmpty'] === true ? { allowEmpty: true } : {}),
    })) as unknown as JsonValue;
  }
}

/**
 * Register every Git tool on a registry.
 *
 * Callers pass a registry so the tools are visible to the same
 * policy gate and approval flow as every other tool.
 */
export function registerGitTools(
  registry: { register(tool: Tool): void },
  git: GitService,
): void {
  registry.register(new GitStatusTool(git));
  registry.register(new GitDiffTool(git));
  registry.register(new GitLogTool(git));
  registry.register(new GitCurrentBranchTool(git));
  registry.register(new GitCreateBranchTool(git));
  registry.register(new GitPrepareCommitTool(git));
  registry.register(new GitExecuteCommitTool(git));
}