/**
 * Run service (Milestone 5-A).
 *
 * Read-side application operations over an existing run: the run
 * itself, its events, its evidence, its evaluation and its
 * observability metrics.
 *
 * This layer contains no orchestration. It reads the same
 * repositories the engine writes, so the CLI, the REST API and
 * any future dashboard all observe identical data.
 */

import type { RunRepository, RunRow } from '../persistence/run-repository.js';
import type { TaskRepository } from '../persistence/task-repository.js';
import type { EventRepository, StoredEvent } from '../persistence/event-repository.js';
import type { ObservabilityRepository, StoredSpan } from '../persistence/observability-repository.js';
import type { MetricValue } from '../observability/metrics.js';
import { METRIC_NAMES, MetricRegistry } from '../observability/metrics.js';
import type { StoredEvent as EvidenceEvent } from '../persistence/event-repository.js';
import { RunNotFoundError } from '../core/errors.js';
import type { JsonObject } from '../core/json.js';

/** An evidence record extracted from the event log. */
export interface EvidenceRecordView {
  readonly evidenceId: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly data: JsonObject;
  readonly hash: string;
}

/** Aggregate dashboard statistics, derived from stored runs. */
export interface RunStatsView {
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly runningRuns: number;
  /** Mean duration of completed runs; null when none completed. */
  readonly averageDurationMs: number | null;
  readonly totalToolCalls: number | null;
  readonly totalErrors: number | null;
  /** True when at least one run reported token usage. */
  readonly tokenUsageAvailable: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/** Dependencies for the run service. */
export interface RunServiceDeps {
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly events: EventRepository;
  readonly observability: ObservabilityRepository;
  /** Maximum events returned by list calls; guards against unbounded reads. */
  readonly maxEvents?: number;
  /**
   * Pending approval count, supplied by the approval service.
   * Injected as a callback so RunService does not depend on it.
   */
  readonly pendingApprovalCount?: () => number;
}

/** Aggregated observability metrics for a run. */
export interface RunMetricsView {
  readonly runId: string;
  readonly durationMs: number | null;
  readonly agentDurationMs: number | null;
  readonly toolCallCount: number | null;
  readonly errorCount: number | null;
  readonly retryCount: number | null;
  readonly policyDenialCount: number | null;
  readonly repairCount: number | null;
  /** Null when no provider reported usage. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** Raw metrics, for callers that want every recorded value. */
  readonly raw: readonly MetricValue[];
  readonly spans: readonly StoredSpan[];
}

/**
 * Read-side application service.
 *
 * Every method is read-only and side-effect free, which makes
 * the service safe to call from HTTP handlers.
 */
export class RunService {
  private readonly maxEvents: number;

  constructor(private readonly deps: RunServiceDeps) {
    this.maxEvents = deps.maxEvents ?? 1000;
  }

  /**
   * Every run id that contributes to a run's view of the world.
   *
   * A workflow run is recorded as its own row, but the engine
   * creates a separate orchestrator run per phase (planner, main,
   * repairs). Reads aggregate across those members so a caller sees
   * one coherent run rather than several fragments.
   */
  scopeRunIds(runId: string): string[] {
    const row = this.deps.runs.get(runId);
    if (row?.metadata === undefined) return [runId];

    try {
      const metadata = JSON.parse(row.metadata) as { memberRunIds?: unknown };
      if (!Array.isArray(metadata.memberRunIds)) return [runId];
      const members = metadata.memberRunIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );
      // The workflow's own id is included because workflow-level
      // evidence (plan.created, repair.*, workflow.outcome) is
      // recorded under it rather than under a member run.
      return [runId, ...members.filter((id) => id !== runId)];
    } catch {
      // Malformed metadata must not break reads; fall back to the
      // run itself.
      return [runId];
    }
  }

  /** Fetch a run, or throw `RunNotFoundError`. */
  getRun(runId: string): RunRow {
    const row = this.deps.runs.get(runId);
    if (row === null || row === undefined) {
      throw new RunNotFoundError(runId);
    }
    return row;
  }

  /** Fetch a run, returning undefined instead of throwing. */
  findRun(runId: string): RunRow | undefined {
    const row = this.deps.runs.get(runId);
    return row ?? undefined;
  }

  /**
 * Every top-level run, newest first.
 *
 * A workflow creates one orchestrator run per phase (planner,
 * main, repairs). Those member runs are implementation detail, not
 * separate units of work, so they are excluded here — otherwise a
 * single workflow would appear as four rows. They remain
 * reachable through their parent via `scopeRunIds`.
 */
  listRuns(limit: number = 100): RunRow[] {
    const all = this.deps.runs.list();
    const memberRunIds = this.memberRunIds(all);

    return all
      .filter((row) => !memberRunIds.has(row.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, limit));
  }

  /**
   * The set of run ids that are phases of some other run.
   *
   * Derived entirely from stored metadata, so no extra state is
   * needed and the result is deterministic.
   */
  private memberRunIds(rows: readonly RunRow[]): Set<string> {
    const members = new Set<string>();
    for (const row of rows) {
      if (row.metadata === undefined) continue;
      try {
        const metadata = JSON.parse(row.metadata) as { memberRunIds?: unknown };
        if (!Array.isArray(metadata.memberRunIds)) continue;
        for (const id of metadata.memberRunIds) {
          if (typeof id === 'string' && id !== row.id) members.add(id);
        }
      } catch {
        // Malformed metadata is ignored; the run stays top-level.
      }
    }
    return members;
  }

  /** Tasks belonging to a run, including those of its member runs. */
  getTasks(runId: string) {
    const scope = this.scopeRunIds(runId);
    if (scope.length === 1) return this.deps.tasks.listByRun(runId);
    // Deduplicated by task id across the scope.
    const seen = new Map<string, ReturnType<TaskRepository['listByRun']>[number]>();
    for (const id of scope) {
      for (const task of this.deps.tasks.listByRun(id)) {
        seen.set(task.id, task);
      }
    }
    return [...seen.values()];
  }

  /** Events for a run in append order, optionally filtered by type. */
  getEvents(runId: string, options: { readonly type?: string; readonly limit?: number } = {}): StoredEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? this.maxEvents, this.maxEvents));
    const scope = this.scopeRunIds(runId);

    // Merge the scope's event streams and re-sort by the global
    // append sequence so ordering is chronological across runs.
    const merged = scope
      .flatMap((id) => this.deps.events.listByRun(id))
      .sort((a, b) => a.seq - b.seq);

    const filtered =
      options.type !== undefined
        ? merged.filter((event) => event.type === options.type)
        : merged;
    return filtered.slice(0, limit);
  }

  /**
   * Evidence records for a run.
   *
   * Evidence lives in the event log as `evidence.recorded`
   * events; they are projected into a stable shape here so
   * callers do not parse raw event payloads.
   */
  getEvidence(runId: string, limit: number = this.maxEvents): EvidenceRecordView[] {
    const records: EvidenceRecordView[] = [];

    for (const event of this.getEvents(runId, { limit: Number.MAX_SAFE_INTEGER })) {
      if (event.type !== 'evidence.recorded') continue;
      const payload = event.payload as {
        evidenceId?: string;
        kind?: string;
        data?: JsonObject;
        hash?: string;
      };
      records.push({
        evidenceId: payload.evidenceId ?? '',
        kind: payload.kind ?? 'unknown',
        createdAt: event.occurredAt,
        data: payload.data ?? {},
        hash: payload.hash ?? '',
      });
      if (records.length >= limit) break;
    }

    return records;
  }

  /** Spans recorded for a run, across its scope. */
  getSpans(runId: string): StoredSpan[] {
    return this.getSpansForScope(runId);
  }

  /**
   * Observability metrics for a run.
   *
   * Any metric that was never observed is reported as `null`
   * rather than `0`, so "no data" is distinguishable from
   * "measured zero".
   */
  getMetrics(runId: string): RunMetricsView {
    // Metrics live on the workflow id; member runs contribute their
    // own if present, so sums are taken across the scope and then
    // the view is derived once from the combined totals.
    const scope = this.scopeRunIds(runId);
    const combined = new Map<string, { value: number; count: number }>();
    for (const id of scope) {
      for (const metric of this.deps.observability.listMetricsByRun(id)) {
        const existing = combined.get(metric.name);
        if (existing === undefined) {
          combined.set(metric.name, { value: metric.value, count: metric.count });
        } else {
          existing.value += metric.value;
          existing.count += metric.count;
        }
      }
    }

    const raw: MetricValue[] = [...combined.entries()]
      .map(([name, totals]) => ({ name, value: totals.value, count: totals.count, updatedAt: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const byName = new Map(raw.map((metric) => [metric.name, metric.value]));
    const read = (name: string): number | null => byName.get(name) ?? null;

    // Spans aggregated across the scope, because the workflow-level
    // span is recorded under the workflow id while agent and tool
    // spans sit under their member runs.
    const spanView = this.getSpans(runId);
    const spanDerived = MetricRegistry.fromSpans(
      spanView.map((span) => ({
        spanId: span.spanId,
        runId: span.runId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        kind: span.kind,
        status: span.status,
        agent: span.agent,
        taskId: span.taskId,
        taskName: span.taskName,
        model: span.model,
        provider: span.provider,
        startedAt: new Date(span.startedAt).getTime(),
        endedAt: span.endedAt !== undefined ? new Date(span.endedAt).getTime() : undefined,
        durationMs: span.durationMs,
        error: span.error,
        attributes: span.attributes,
        tokenUsage: span.tokenUsage,
      })),
    );
    for (const metric of spanDerived) {
      if (byName.has(metric.name)) continue;
      raw.push(metric);
      byName.set(metric.name, metric.value);
    }
    raw.sort((a, b) => a.name.localeCompare(b.name));

    return {
      runId,
      durationMs: read(METRIC_NAMES.runDuration),
      agentDurationMs: read(METRIC_NAMES.agentDuration),
      toolCallCount: read(METRIC_NAMES.toolCalls),
      errorCount: read(METRIC_NAMES.errors),
      retryCount: read(METRIC_NAMES.retries),
      policyDenialCount: read(METRIC_NAMES.policyDenials),
      repairCount: read(METRIC_NAMES.repairs),
      inputTokens: read(METRIC_NAMES.inputTokens),
      outputTokens: read(METRIC_NAMES.outputTokens),
      totalTokens: read(METRIC_NAMES.totalTokens),
      raw,
      spans: spanView,
    };
  }

  /** Counters for a run, useful for dashboards. */
  getCounters(runId: string): { readonly events: number; readonly evidence: number } {
    return {
      // Aggregated across the run's scope rather than a single id.
      events: this.getEvents(runId, { limit: Number.MAX_SAFE_INTEGER }).length,
      evidence: this.getEvidence(runId).length,
    };
  }

  /** Total run duration derived from the run row, when available. */
  getRunDurationMs(runId: string): number | null {
    const row = this.findRun(runId);
    if (row?.startedAt === undefined || row?.completedAt === undefined) return null;
    const started = new Date(row.startedAt).getTime();
    const completed = new Date(row.completedAt).getTime();
    if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
    return Math.max(0, completed - started);
  }

  /** Spans recorded across the run's scope. */
  getSpansForScope(runId: string): StoredSpan[] {
    const seen = new Map<string, StoredSpan>();
    for (const id of this.scopeRunIds(runId)) {
      for (const span of this.deps.observability.listSpansByRun(id)) {
        seen.set(span.spanId, span);
      }
    }
    return [...seen.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /**
   * Aggregate statistics across all runs, for the dashboard.
   *
   * Computed server-side from the same stored data the detail
   * endpoints read, so the frontend does not have to fan out one
   * metrics request per run just to render a summary.
   */
  getStats(): RunStatsView {
    const runs = this.deps.runs.list();
    let successful = 0;
    let failed = 0;
    let running = 0;
    let durationSum = 0;
    let durationSamples = 0;
    let toolCalls: number | null = null;
    let errors: number | null = null;
    let input: number | null = null;
    let output: number | null = null;
    let total: number | null = null;

    for (const run of runs) {
      if (run.status === 'succeeded') successful += 1;
      else if (run.status === 'failed') failed += 1;
      else if (run.status === 'running' || run.status === 'pending') running += 1;

      const duration = this.getRunDurationMs(run.id);
      if (duration !== null) {
        durationSum += duration;
        durationSamples += 1;
      }

      const metrics = this.getMetrics(run.id);
      // `null` means "never observed" for that run; one reported
      // run is enough to make the aggregate available.
      if (metrics.toolCallCount !== null) {
        toolCalls = (toolCalls ?? 0) + metrics.toolCallCount;
      }
      if (metrics.errorCount !== null) {
        errors = (errors ?? 0) + metrics.errorCount;
      }
      if (metrics.inputTokens !== null) input = (input ?? 0) + metrics.inputTokens;
      if (metrics.outputTokens !== null) output = (output ?? 0) + metrics.outputTokens;
      if (metrics.totalTokens !== null) total = (total ?? 0) + metrics.totalTokens;
    }

    return {
      totalRuns: runs.length,
      successfulRuns: successful,
      failedRuns: failed,
      runningRuns: running,
      averageDurationMs:
        durationSamples === 0 ? null : Math.round(durationSum / durationSamples),
      totalToolCalls: toolCalls,
      totalErrors: errors,
      tokenUsageAvailable: total !== null,
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
    };
  }

  /** Pending approval count, or 0 when no approval service is wired. */
  getPendingApprovalCount(): number {
    return this.deps.pendingApprovalCount?.() ?? 0;
  }
}

/** Re-exported for callers that only need the event shape. */
export type RunEventView = StoredEvent;

/** Re-exported so evidence consumers do not import persistence directly. */
export type EvidenceEventView = EvidenceEvent;