/**
 * Deterministic GitHub simulation (Milestone 5-C).
 *
 * Simulates the GitHub side of a pull request — push and PR
 * creation — with **no network access**, so the portfolio demo
 * runs identically on a machine that has never seen GitHub.
 *
 * Two properties matter more than the simulation itself:
 *
 *   1. Every simulated result is explicitly labelled `SIMULATED`,
 *      in the returned data and in the recorded evidence. A
 *      simulated operation must never be mistaken for a real one.
 *   2. Simulated output is deterministic: the same input always
 *      produces the same hashes, numbers and text.
 */

import { createHash } from 'node:crypto';
import type { Clock, RunId, TaskId } from '../core/types.js';
import type { EvidenceLog } from '../events/evidence.js';
import type { GithubAdapter } from './github-adapter.js';

/** A simulated GitHub operation result. */
export interface SimulatedOperation {
  readonly operation: string;
  /** Always 'SIMULATED' — never anything else. */
  readonly label: 'SIMULATED';
  readonly ok: boolean;
  readonly detail: string;
  /** Deterministic pseudo-identifier derived from the inputs. */
  readonly simulatedId: string;
  /** Explicit disclaimer carried in the evidence record. */
  readonly disclaimer: string;
}

/** A fully simulated pull request. */
export interface SimulatedPullRequest {
  readonly label: 'SIMULATED';
  readonly created: boolean;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly files: readonly string[];
  /** True when a real PR was created (always false in simulation). */
  readonly actuallyCreated: boolean;
  readonly simulated: true;
}

export interface GithubSimulationOptions {
  readonly clock: Clock;
  /** Optional live adapter, used only to report availability. */
  readonly adapter?: GithubAdapter;
  /** Repository slug used to build a plausible simulated URL. */
  readonly repoSlug?: string;
  /** Append-only evidence log; simulated operations are recorded here. */
  readonly evidence?: EvidenceLog;
}

/** The disclaimer attached to every simulated result. */
export const SIMULATION_DISCLAIMER =
  'SIMULATED: no network call was made and no GitHub state changed.';

/**
 * Deterministic GitHub simulator.
 *
 * Produces plausible, reproducible output without contacting
 * GitHub. Ids and numbers are derived from a SHA-256 of the
 * inputs, so the same workflow always yields the same values.
 */
export class GithubSimulator {
  private readonly clock: Clock;
  private readonly adapter: GithubAdapter | undefined;
  private readonly repoSlug: string;
  private readonly evidence: EvidenceLog | undefined;

  constructor(options: GithubSimulationOptions) {
    this.clock = options.clock;
    this.adapter = options.adapter;
    this.repoSlug = options.repoSlug ?? 'local/digital-workforce-os';
    this.evidence = options.evidence;
  }

  /** A deterministic 8-character id derived from the inputs. */
  private idFor(operation: string, seed: string): string {
    return createHash('sha256')
      .update(`${operation}\n${seed}`)
      .digest('hex')
      .slice(0, 8);
  }

  /**
   * Simulate pushing a branch.
   *
   * Always succeeds: the simulated remote accepts the ref.
   */
  simulatePush(input: {
    readonly branch: string;
    readonly commits: number;
    readonly files: readonly string[];
  }): SimulatedOperation {
    const seed = `${input.branch}|${input.commits}|${input.files.join(',')}`;
    const simulatedId = this.idFor('push', seed);
    const detail =
      `simulated push of '${input.branch}' ` +
      `(${input.commits} commit(s), ${input.files.length} file(s))`;

    return {
      operation: 'git.push',
      label: 'SIMULATED',
      ok: true,
      detail,
      simulatedId,
      disclaimer: SIMULATION_DISCLAIMER,
    };
  }

  /** Simulate preparing PR metadata (no network). */
  simulatePullRequest(input: {
    readonly title: string;
    readonly body: string;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly files: readonly string[];
  }): SimulatedPullRequest {
    const seed = `${input.title}|${input.headBranch}|${input.files.join(',')}`;
    const simulatedId = this.idFor('pr', seed);
    // A stable, clearly-fake PR number in a reserved-looking range.
    const number = Number.parseInt(simulatedId, 16) % 900 + 100;

    return {
      label: 'SIMULATED',
      created: true,
      number,
      // The URL is explicitly non-routable and marked simulated so
      // it can never be mistaken for a real pull request.
      url: `https://simulated.invalid/${this.repoSlug}/pull/${number} (SIMULATED)`,
      title: input.title,
      body: input.body,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      files: input.files,
      actuallyCreated: false,
      simulated: true,
    };
  }

  /** Simulate a `gh pr create` attempt. */
  simulateCreatePullRequest(input: {
    readonly title: string;
    readonly headBranch: string;
  }): SimulatedOperation {
    const simulatedId = this.idFor('pr-create', `${input.title}|${input.headBranch}`);
    return {
      operation: 'pr.create',
      label: 'SIMULATED',
      ok: true,
      detail: `simulated pull request '${input.title}' from '${input.headBranch}'`,
      simulatedId,
      disclaimer: SIMULATION_DISCLAIMER,
    };
  }

  /**
   * Record a GitHub outcome as a labelled evidence record.
   *
   * Simulated operations always carry `mode: 'simulated'`, which
   * the append-only event log preserves verbatim — so an audit
   * reader can never mistake a simulated action for a real one.
   *
   * Does nothing when no `EvidenceLog` was supplied, because a
   * pure simulation consumer has no event bus to write to.
   */
  recordOutcome(input: {
    readonly runId: RunId;
    readonly taskId?: TaskId;
    readonly operation: string;
    readonly ok: boolean;
    readonly detail: string;
    readonly simulatedId: string;
    readonly extra?: Readonly<Record<string, unknown>>;
  }): void {
    this.evidence?.record({
      runId: input.runId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      kind: 'github.operation',
      data: {
        operation: input.operation,
        // Explicit, machine-readable proof that nothing was posted.
        mode: 'simulated',
        simulated: true,
        label: 'SIMULATED',
        ok: input.ok,
        detail: input.detail,
        simulatedId: input.simulatedId,
        disclaimer: SIMULATION_DISCLAIMER,
        ...(input.extra ?? {}),
      },
    });
  }

  /** Timestamp source, exposed for callers building PR bodies. */
  now(): number {
    return this.clock.now();
  }
}