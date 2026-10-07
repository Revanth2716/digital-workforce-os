/**
 * Git service tests (Milestone 5-C).
 *
 * Exercises the real `git` CLI against a temporary repository so
 * behaviour is genuine, not mocked. Injectable `exec` is still
 * accepted for the failure-path tests.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/git-service.js';
import { WorkspaceGuard } from '../src/git/workspace.js';
import { GitError, GitNotAvailableError } from '../src/git/git-error.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { DefaultPolicyGate } from '../src/tools/policy-gate.js';
import { ApprovalManager } from '../src/approval/approval-manager.js';
import { PolicyEngine } from '../src/policy/policy-engine.js';
import { registerGitTools } from '../src/git/git-tools.js';
import { FakeClock } from '../src/core/types.js';
import type { JsonValue } from '../src/core/json.js';

const dirs: string[] = [];

function makeRepo(): { dir: string; git: GitService } {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-git-'));
  dirs.push(dir);

  // Configure a deterministic user so commits are reproducible.
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'bot@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'bot'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  const git = new GitService({ guard: new WorkspaceGuard({ root: dir }) });
  return { dir, git };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Git — workspace boundary', () => {
  it('resolves a path inside the workspace', () => {
    const { dir } = makeRepo();
    const guard = new WorkspaceGuard({ root: dir });
    const safe = guard.resolveInside('src/index.ts');
    expect(safe.relative).toBe('src/index.ts');
    expect(safe.absolute.startsWith(dir)).toBe(true);
  });

  it('rejects parent traversal', () => {
    const { dir } = makeRepo();
    const guard = new WorkspaceGuard({ root: dir });
    expect(() => guard.resolveInside('../secret.txt')).toThrow(/escapes/);
    expect(guard.contains('../secret.txt')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    const { dir } = makeRepo();
    const guard = new WorkspaceGuard({ root: dir });
    expect(() => guard.resolveInside('a\0b')).toThrow(/NUL/);
  });

  it('rejects a diff path outside the workspace', async () => {
    const { git } = makeRepo();
    await expect(git.diff({ path: '../outside.txt' })).rejects.toThrow(/escapes/);
  });

  it('does not allow git to leave the workspace cwd', async () => {
    // The guard is exercised even when a caller passes a cwdPath.
    const { git } = makeRepo();
    await expect(git.diff({ path: '../../etc/passwd' })).rejects.toThrow(/escapes/);
  });
});

describe('Git — status/branch/log/diff', () => {
  it('reports the current branch', async () => {
    const { git } = makeRepo();
    expect(await git.currentBranch()).toBe('main');
  });

  it('reports a clean working tree after the initial commit', async () => {
    const { git } = makeRepo();
    const status = await git.status();
    expect(status.clean).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.staged).toBe(0);
  });

  it('detects untracked and modified files', async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, 'new.txt'), 'hello\n');
    writeFileSync(join(dir, 'README.md'), '# demo\nchanged\n');

    const status = await git.status();
    expect(status.clean).toBe(false);
    expect(status.untracked).toBe(1);
    expect(status.unstaged).toBe(1);
  });

  it('lists commits newest first', async () => {
    const { git } = makeRepo();
    const log = await git.log();
    expect(log.length).toBe(1);
    expect(log[0]?.subject).toBe('initial');
    expect(log[0]?.author).toBe('bot');
  });

  it('diffs a modified file', async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, 'README.md'), '# demo\nmore\n');
    const diff = await git.diff();
    expect(diff.files).toContain('README.md');
    expect(diff.insertions).toBe(1);
  });

  it('can create a branch and check it out', async () => {
    const { git } = makeRepo();
    const result = await git.createBranch('feature/demo');
    expect(result.created).toBe(true);
    expect(await git.currentBranch()).toBe('feature/demo');
  });

  it('rejects an invalid branch name', async () => {
    const { git } = makeRepo();
    await expect(git.createBranch('bad;rm -rf /')).rejects.toThrow(/disallowed/);
  });

  it('prepares and executes a commit', async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, 'file.txt'), 'content\n');

    const prepared = await git.prepareCommit('add file', ['file.txt']);
    expect(prepared.files).toContain('file.txt');
    expect(prepared.contentHash).toHaveLength(64);

    const committed = await git.executeCommit('add file');
    expect(committed.filesCommitted).toBe(1);
    expect(committed.branch).toBe('main');

    // The log now contains the new commit.
    const log = await git.log();
    expect(log[0]?.subject).toBe('add file');
  });

  it('refuses an empty or multi-line commit message', async () => {
    const { git } = makeRepo();
    await expect(git.executeCommit('   ')).rejects.toThrow(GitError);
    await expect(git.executeCommit('line1\nline2')).rejects.toThrow(GitError);
  });

  it('caps oversized diff output', async () => {
    const { dir } = makeRepo();
    const git = new GitService({
      guard: new WorkspaceGuard({ root: dir }),
      maxDiffChars: 50,
    });
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(5000));
    try {
      execFileSync('git', ['add', '.'], { cwd: dir });
    } catch { /* not a repo change handler; proceed */ }
    const diff = await git.diff({ staged: true });
    expect(diff.truncated).toBe(true);
    expect(diff.raw.length).toBeLessThanOrEqual(50);
  });

  it('throws a typed error when the workspace is not a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwo-nogit-'));
    dirs.push(dir);
    const git = new GitService({ guard: new WorkspaceGuard({ root: dir }) });
    await expect(git.status()).rejects.toThrow(GitNotAvailableError);
  });
});

describe('Git — tools through the governed path', () => {
  it('allows read-only git tools without approval', async () => {
    const { dir, git } = makeRepo();
    const clock = new FakeClock();
    const tools = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine() }),
    });
    registerGitTools(tools, git);

    const status = await tools.execute('git.status', {}, { clock });
    expect(isObject(status)).toBe(true);
  });

  it('requires approval before committing', async () => {
    const { dir, git } = makeRepo();
    const clock = new FakeClock();
    const tools = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine() }),
    });
    registerGitTools(tools, git);

    // No approval handler => the call is refused.
    await expect(tools.execute('git.commit', { message: 'x' }, { clock })).rejects.toThrow(/refused/);
  });

  it('executes the commit only after approval is granted', async () => {
    const { dir, git } = makeRepo();
    const clock = new FakeClock();
    writeFileSync(join(dir, 'a.txt'), '1\n');
    execFileSync('git', ['add', '.'], { cwd: dir });

    const approvals = new ApprovalManager(async (request) => ({
      requestId: request.id,
      decision: 'APPROVED' as const,
      decidedAt: Date.now(),
    }));
    const tools = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine(), approvalManager: approvals }),
    });
    registerGitTools(tools, git);

    const result = await tools.execute('git.commit', { message: 'add a' }, { clock });
    expect(isObject(result)).toBe(true);
    expect((result as { filesCommitted: number }).filesCommitted).toBe(1);
  });

  it('denies an unmapped git tool by default', async () => {
    const { git } = makeRepo();
    const clock = new FakeClock();
    const tools = new ToolRegistry({
      gate: new DefaultPolicyGate({ policyEngine: new PolicyEngine() }),
    });
    // Register only the status tool; git.commit is not registered, so
    // the registry default-denies it before it ever executes.
    tools.register(new (class {
      readonly name = 'git.status';
      readonly description = 'status';
      readonly inputSchema = { type: 'object', properties: {}, required: [] } as const;
      readonly readOnly = true;
      async execute(): Promise<JsonValue> { return {} as JsonValue; }
    })());

    await expect(tools.execute('git.commit', { message: 'x' }, { clock })).rejects.toThrow(/not registered/);
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}