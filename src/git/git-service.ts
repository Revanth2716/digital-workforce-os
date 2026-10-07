/**
 * Safe Git service (Milestone 5-C).
 *
 * Wraps the `git` CLI for the operations an AI engineer actually
 * needs, with two invariants enforced here rather than trusted to
 * callers:
 *
 *   1. **Workspace containment.** Every command runs with `cwd`
 *      inside the configured workspace, and any caller-supplied
 *      path is proven to resolve inside it first.
 *   2. **No silent failure.** A command that fails throws a
 *      `GitError` carrying the exit code and stderr, so a caller
 *      can never mistake a failure for success.
 *
 * This service performs no policy or approval decisions of its
 * own. Sensitive operations are exposed as `Tool` implementations
 * (see `git-tools.ts`) so they flow through the existing
 * ToolRegistry -> PolicyGate -> Approval path.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { WorkspaceGuard } from './workspace.js';
import { GitError, GitNotAvailableError } from './git-error.js';

const execFileAsync = promisify(execFile);

/** Git porcelain status codes. */
export interface GitStatusEntry {
  readonly code: string;
  readonly staged: boolean;
  readonly path: string;
}

export interface GitStatus {
  readonly branch: string;
  readonly clean: boolean;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly entries: readonly GitStatusEntry[];
}

export interface GitCommitInfo {
  readonly hash: string;
  readonly shortHash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface GitDiff {
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly raw: string;
  /** True when the diff exceeded the configured size cap. */
  readonly truncated: boolean;
}

/** A prepared but uncommitted change. */
export interface PreparedCommit {
  readonly branch: string;
  readonly message: string;
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  /** Deterministic content hash of the staged change set. */
  readonly contentHash: string;
}

export interface CommitResult {
  readonly hash: string;
  readonly shortHash: string;
  readonly branch: string;
  readonly message: string;
  readonly filesCommitted: number;
}

export interface GitServiceOptions {
  readonly guard: WorkspaceGuard;
  /** Max diff characters returned. Defaults to 20000. */
  readonly maxDiffChars?: number;
  /** Injectable executor, for tests. */
  readonly exec?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
}

/** Default executor: run a command without a shell. */
async function defaultExec(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  // `shell: false` and an argument array mean no caller-supplied
  // value can be interpreted as a shell metacharacter.
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/** Read-only and write Git operations, workspace-bounded. */
export class GitService {
  private readonly guard: WorkspaceGuard;
  private readonly maxDiffChars: number;
  private readonly exec: NonNullable<GitServiceOptions['exec']>;

  constructor(options: GitServiceOptions) {
    this.guard = options.guard;
    this.maxDiffChars = options.maxDiffChars ?? 20_000;
    this.exec = options.exec ?? defaultExec;
  }

  /** The workspace root this service is bound to. */
  get workspaceRoot(): string {
    return this.guard.root;
  }

  /**
   * Run a git command inside the workspace.
   *
   * `pathArgs` are validated against the workspace before being
   * passed to git.
   */
  private async git(
    args: readonly string[],
    options: { readonly cwdPath?: string } = {},
  ): Promise<string> {
    // The working directory is always resolved through the guard.
    const cwd = options.cwdPath !== undefined
      ? this.guard.resolveInside(options.cwdPath).absolute
      : this.guard.root;

    try {
      const { stdout } = await this.exec('git', args, cwd);
      return stdout;
    } catch (error) {
      const exitCode =
        typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : undefined;
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
      throw new GitError(`git ${args.join(' ')} failed`, { exitCode, stderr: message });
    }
  }

  /** Whether git is installed and the workspace is a repository. */
  async isAvailable(): Promise<boolean> {
    try {
      const stdout = await this.exec('git', ['rev-parse', '--is-inside-work-tree'], this.guard.root);
      return stdout.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Assert git is usable, throwing a typed error otherwise. */
  async assertAvailable(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new GitNotAvailableError(
        `no git repository found at '${this.guard.root}'`,
      );
    }
  }

  /** Current branch name. */
  async currentBranch(): Promise<string> {
    await this.assertAvailable();
    const stdout = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  }

  /** Repository status, parsed from porcelain v1 output. */
  async status(): Promise<GitStatus> {
    await this.assertAvailable();
    // `--porcelain` gives a stable, script-friendly format.
    const stdout = await this.git(['status', '--porcelain=v1', '--branch']);

    const entries: GitStatusEntry[] = [];
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    let branch = '';

    for (const line of stdout.split('\n')) {
      if (line.length === 0) continue;
      if (line.startsWith('## ')) {
        // `## main...origin/main [ahead 1]`
        const ref = line.slice(3).split('...')[0] ?? '';
        branch = ref.trim();
        continue;
      }
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (code === '??') untracked += 1;
      else {
        const indexState = code[0] ?? ' ';
        const workState = code[1] ?? ' ';
        if (indexState !== ' ' && indexState !== undefined) staged += 1;
        if (workState !== ' ' && workState !== undefined) unstaged += 1;
      }
      entries.push({ code, staged: (code[0] ?? ' ') !== ' ', path });
    }

    return {
      branch,
      clean: entries.length === 0,
      staged,
      unstaged,
      untracked,
      entries,
    };
  }

  /**
   * Diff for the working tree (or the index when `staged`).
   * Paths are validated against the workspace.
   */
  async diff(options: { readonly path?: string; readonly staged?: boolean } = {}): Promise<GitDiff> {
    await this.assertAvailable();

    const args = ['diff', '--numstat'];
    if (options.staged === true) args.push('--cached');
    if (options.path !== undefined) {
      // Reject any path that leaves the workspace before git sees it.
      const safe = this.guard.resolveInside(options.path);
      args.push('--', safe.relative);
    }

    const numstat = await this.git(args);

    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.split('\n')) {
      if (line.trim().length === 0) continue;
      const [added, removed, file] = line.split('\t');
      files.push((file ?? '').trim());
      insertions += Number(added ?? '0') || 0;
      deletions += Number(removed ?? '0') || 0;
    }

    // The textual patch is size-capped so a large change cannot
    // flood an LLM prompt or an evidence record.
    const patchArgs = ['diff'];
    if (options.staged === true) patchArgs.push('--cached');
    if (options.path !== undefined) {
      const safe = this.guard.resolveInside(options.path);
      patchArgs.push('--', safe.relative);
    }
    const full = await this.git(patchArgs);
    const truncated = full.length > this.maxDiffChars;

    return {
      files,
      insertions,
      deletions,
      raw: truncated ? full.slice(0, this.maxDiffChars) : full,
      truncated,
    };
  }

  /** Recent commits, newest first. */
  async log(limit: number = 10): Promise<GitCommitInfo[]> {
    await this.assertAvailable();
    const capped = Math.max(1, Math.min(limit, 200));
    const stdout = await this.git([
      'log',
      `-${capped}`,
      '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s',
    ]);

    const commits: GitCommitInfo[] = [];
    for (const line of stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const [hash, shortHash, author, date, subject] = line.split('\x1f');
      commits.push({
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        author: author ?? '',
        date: date ?? '',
        subject: subject ?? '',
      });
    }
    return commits;
  }

  /**
   * Create a branch and switch to it.
   *
   * The branch name is validated against a conservative character
   * set: git branch names can trigger surprising behaviour, and no
   * legitimate name needs shell metacharacters.
   */
  async createBranch(name: string, options: { readonly checkout?: boolean } = {}): Promise<{ branch: string; created: boolean }> {
    await this.assertAvailable();
    const validated = validateBranchName(name);

    // `-b` creates and switches; `git branch` alone just creates.
    if (options.checkout !== false) {
      await this.git(['checkout', '-b', validated]);
      return { branch: validated, created: true };
    }
    await this.git(['branch', validated]);
    return { branch: validated, created: true };
  }

  /**
   * Stage paths and build a commit message, without committing.
   *
   * Preparing is safe and does not require COMMIT approval; only
   * `executeCommit` does.
   */
  async prepareCommit(
    message: string,
    paths: readonly string[] = [],
  ): Promise<PreparedCommit> {
    await this.assertAvailable();
    const subject = validateCommitMessage(message);

    // Every path must resolve inside the workspace before staging.
    const safePaths = paths.map((path) => this.guard.resolveInside(path).relative);

    if (safePaths.length > 0) {
      await this.git(['add', '--', ...safePaths]);
    }

    const staged = await this.diff({ staged: true });
    const branch = await this.currentBranch();

    // A deterministic hash of the staged content, so a prepared
    // commit can be verified later without re-reading the diff.
    const contentHash = sha256Hex(
      `${branch}\n${subject}\n${safePaths.join(',')}\n${staged.raw}`,
    );

    return {
      branch,
      message: subject,
      files: safePaths,
      insertions: staged.insertions,
      deletions: staged.deletions,
      contentHash,
    };
  }

  /**
   * Commit the staged change set.
   *
   * This mutates history and is therefore exposed through the
   * `git.commit` tool, which requires COMMIT approval.
   */
  async executeCommit(message: string, options: { readonly allowEmpty?: boolean } = {}): Promise<CommitResult> {
    await this.assertAvailable();
    const subject = validateCommitMessage(message);

    const args = ['commit', '-m', subject];
    if (options.allowEmpty === true) args.push('--allow-empty');

    const before = await this.status();
    const files = before.entries.filter((entry) => entry.staged).map((entry) => entry.path);

    await this.git(args);

    const branch = await this.currentBranch();
    const stdout = await this.git(['rev-parse', 'HEAD']);

    return {
      hash: stdout.trim(),
      shortHash: stdout.trim().slice(0, 7),
      branch,
      message: subject,
      filesCommitted: files.length,
    };
  }
}

/** Conservative branch-name validation. */
export function validateBranchName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new GitError('branch name must not be empty');
  }
  if (trimmed.length > 200) {
    throw new GitError('branch name is too long');
  }
  // Reject anything outside a safe set; git itself allows far more,
  // but no legitimate automated branch name needs these characters.
  if (!/^[A-Za-z0-9._\-/]+$/.test(trimmed)) {
    throw new GitError(
      `branch name '${trimmed}' contains disallowed characters; allowed: letters, digits, . _ - /`,
    );
  }
  if (trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/')) {
    throw new GitError(`branch name '${trimmed}' has an invalid shape`);
  }
  return trimmed;
}

/** Commit-message validation. */
export function validateCommitMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new GitError('commit message must not be empty');
  }
  if (trimmed.length > 2000) {
    throw new GitError('commit message is too long (max 2000 characters)');
  }
  // Newlines could forge additional headers in a commit message.
  if (/[\r\n]/.test(trimmed)) {
    throw new GitError('commit message must be a single line');
  }
  return trimmed;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}