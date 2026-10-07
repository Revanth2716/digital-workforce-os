/**
 * Optional GitHub adapter (Milestone 5-C).
 *
 * Talks to GitHub through the `gh` CLI **only when it is present
 * and authenticated**. GitHub is never required: in deterministic
 * mode nothing here is called, and when `gh` is missing the
 * adapter reports `available: false` rather than pretending.
 *
 * The central rule: **this adapter never fabricates success.**
 * Every result carries an explicit `mode` of `'live'` or
 * `'unavailable'`, and a failure is surfaced as a failure.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** How a GitHub interaction was carried out. */
export type GithubMode = 'live' | 'unavailable';

/** Availability of the GitHub integration. */
export interface GithubAvailability {
  /** True only when `gh` exists AND reports an authenticated user. */
  readonly available: boolean;
  /** Why it is unavailable, when it is. */
  readonly reason?: string;
  readonly cliPresent: boolean;
  readonly authenticated: boolean;
  /** The authenticated account, when known. */
  readonly account?: string;
}

/** Repository metadata. */
export interface GithubRepoInfo {
  readonly mode: GithubMode;
  readonly available: boolean;
  readonly owner?: string;
  readonly name?: string;
  readonly defaultBranch?: string;
  readonly url?: string;
  readonly description?: string;
  /** Set when the operation could not be completed. */
  readonly error?: string;
}

/** Current branch as GitHub sees it. */
export interface GithubBranchInfo {
  readonly mode: GithubMode;
  readonly available: boolean;
  readonly branch?: string;
  readonly upstream?: string;
  readonly aheadBy?: number;
  readonly behindBy?: number;
  readonly error?: string;
}

/** Generated pull-request metadata. Never posted by this method. */
export interface PullRequestMetadata {
  readonly mode: GithubMode;
  readonly available: boolean;
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  /** Files the PR would contain. */
  readonly files: readonly string[];
  /** Set when metadata could not be generated. */
  readonly error?: string;
}

/** Result of an actual PR creation attempt. */
export interface PullRequestResult {
  readonly mode: GithubMode;
  /** True only when GitHub confirmed creation. */
  readonly created: boolean;
  readonly number?: number;
  readonly url?: string;
  /** Set on failure; present precisely when `created` is false. */
  readonly error?: string;
}

/** A GitHub operation outcome, for evidence recording. */
export interface GithubOutcome {
  readonly operation: string;
  readonly mode: GithubMode;
  readonly ok: boolean;
  readonly detail: string;
  /** Always SIMULATED for simulated runs; LIVE otherwise. */
  readonly label: 'LIVE' | 'SIMULATED' | 'UNAVAILABLE';
}

export interface GithubAdapterOptions {
  /** Repository root, used as the working directory. */
  readonly cwd: string;
  /** Injectable executor for tests. */
  readonly exec?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
}

async function defaultExec(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * GitHub adapter backed by the `gh` CLI.
 *
 * Every method checks availability first. When GitHub is not
 * usable, methods return a result with `available: false` and an
 * explanatory error — never a fabricated success.
 */
export class GithubAdapter {
  private readonly cwd: string;
  private readonly exec: NonNullable<GithubAdapterOptions['exec']>;
  /** Cached availability, so repeated calls do not re-probe. */
  private availability: GithubAvailability | undefined;

  constructor(options: GithubAdapterOptions) {
    this.cwd = options.cwd;
    this.exec = options.exec ?? defaultExec;
  }

  /**
   * Probe for the `gh` CLI and an authenticated account.
   *
   * `gh` present but unauthenticated is reported as unavailable:
   * without credentials no real call could succeed.
   */
  async checkAvailability(force: boolean = false): Promise<GithubAvailability> {
    if (this.availability !== undefined && !force) return this.availability;

    let cliPresent = false;
    try {
      await this.exec('gh', ['--version'], this.cwd);
      cliPresent = true;
    } catch {
      this.availability = {
        available: false,
        reason: 'GitHub CLI (gh) is not installed or not on PATH',
        cliPresent: false,
        authenticated: false,
      };
      return this.availability;
    }

    let authenticated = false;
    let account: string | undefined;
    try {
      const { stdout } = await this.exec(
        'gh',
        ['auth', 'status', '--active'],
        this.cwd,
      );
      // `gh auth status` exits non-zero when unauthenticated.
      authenticated = true;
      const match = stdout.match(/Logged in to github\.com account ([^\s(]+)/i);
      account = match?.[1];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.availability = {
        available: false,
        reason: `GitHub CLI is present but not authenticated: ${message.split('\n')[0]}`,
        cliPresent: true,
        authenticated: false,
      };
      return this.availability;
    }

    this.availability = {
      available: true,
      cliPresent: true,
      authenticated: true,
      ...(account !== undefined ? { account } : {}),
    };
    return this.availability;
  }

  /** Whether real GitHub calls can be made. */
  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).available;
  }

  /** Inspect the current repository. */
  async inspectRepository(): Promise<GithubRepoInfo> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      return {
        mode: 'unavailable',
        available: false,
        error: availability.reason ?? 'GitHub integration unavailable',
      };
    }

    try {
      const { stdout } = await this.exec(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url,description'],
        this.cwd,
      );
      const parsed = JSON.parse(stdout) as {
        nameWithOwner?: string;
        defaultBranchRef?: { name?: string };
        url?: string;
        description?: string;
      };
      const [owner, name] = (parsed.nameWithOwner ?? '').split('/');
      return {
        mode: 'live',
        available: true,
        ...(owner !== undefined ? { owner } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(parsed.defaultBranchRef?.name !== undefined
          ? { defaultBranch: parsed.defaultBranchRef.name }
          : {}),
        ...(parsed.url !== undefined ? { url: parsed.url } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      };
    } catch (error) {
      return {
        mode: 'live',
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Report the current branch and its upstream tracking state. */
  async currentBranch(): Promise<GithubBranchInfo> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      return {
        mode: 'unavailable',
        available: false,
        error: availability.reason ?? 'GitHub integration unavailable',
      };
    }

    try {
      const { stdout } = await this.exec(
        'gh',
        ['api', `repos/{owner}/{repo}/branches/${process.env['GITHUB_BRANCH'] ?? 'HEAD'}`],
        this.cwd,
      );
      const parsed = JSON.parse(stdout) as { name?: string };
      return {
        mode: 'live',
        available: true,
        ...(parsed.name !== undefined ? { branch: parsed.name } : {}),
      };
    } catch (error) {
      return {
        mode: 'live',
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Generate pull-request metadata locally.
   *
   * This performs no network call, so it works with or without
   * GitHub. The result is a *proposal*; nothing is created.
   */
  async preparePullRequest(input: {
    readonly title: string;
    readonly body: string;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly files: readonly string[];
  }): Promise<PullRequestMetadata> {
    const availability = await this.checkAvailability();
    // Metadata generation is local, so it succeeds either way — but
    // the mode makes it explicit that nothing was posted.
    return {
      mode: availability.available ? 'live' : 'unavailable',
      available: true,
      title: input.title,
      body: input.body,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      files: input.files,
    };
  }

  /**
   * Create a pull request.
   *
   * Returns `created: false` with an error when GitHub is
   * unavailable or the call fails. It never reports success it did
   * not observe.
   */
  async createPullRequest(input: {
    readonly title: string;
    readonly body: string;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly draft?: boolean;
  }): Promise<PullRequestResult> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      return {
        mode: 'unavailable',
        created: false,
        error: availability.reason ?? 'GitHub integration unavailable',
      };
    }

    try {
      const args = [
        'pr',
        'create',
        '--title',
        input.title,
        '--body',
        input.body,
        '--base',
        input.baseBranch,
        '--head',
        input.headBranch,
      ];
      if (input.draft === true) args.push('--draft');

      const { stdout } = await this.exec('gh', args, this.cwd);
      // `gh pr create` prints the PR URL on success.
      const urlMatch = stdout.match(/https:\/\/\S+/);
      if (urlMatch === null) {
        return {
          mode: 'live',
          created: false,
          error: 'gh pr create did not report a pull-request URL',
        };
      }
      const url = urlMatch[0];
      const numberMatch = url.match(/\/pull\/(\d+)/);
      return {
        mode: 'live',
        created: true,
        url,
        ...(numberMatch?.[1] !== undefined ? { number: Number(numberMatch[1]) } : {}),
      };
    } catch (error) {
      return {
        mode: 'live',
        created: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Record an outcome for evidence, with an explicit label. */
  static outcome(operation: string, mode: GithubMode, ok: boolean, detail: string): GithubOutcome {
    const label = mode === 'live' ? 'LIVE' : 'UNAVAILABLE';
    return { operation, mode, ok, detail, label };
  }
}