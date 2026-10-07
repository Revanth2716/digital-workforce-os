/**
 * Workflow service (Milestone 5-A).
 *
 * Write-side application operations: create and execute runs.
 *
 * This service is a thin, reusable facade over the existing
 * `AIWorkflow` / `Orchestrator` engines. It deliberately does NOT
 * reimplement orchestration: the engine remains the single
 * source of execution truth, so there is no second workflow
 * engine to drift.
 */

import type { AIWorkflow, AIWorkflowOutcome } from '../orchestrator/ai-workflow.js';
import type { RunRepository } from '../persistence/run-repository.js';
import type { TaskGraph, TaskDefinition } from '../graph/task-graph.js';
import type { Orchestrator, RunOutcome } from '../orchestrator/orchestrator.js';
import type { LocalTracer } from '../observability/tracer.js';
import type { IdGenerator } from '../core/types.js';
import type { JsonValue } from '../core/json.js';
import { canonicalJson } from '../core/json.js';

/** A run request. */
export interface CreateRunRequest {
  readonly name: string;
  /** Arbitrary JSON metadata persisted with the run. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/** The created run. */
export interface CreatedRun {
  readonly runId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
}

/** Result of executing an AI workflow. */
export interface WorkflowExecutionResult {
  readonly runId: string;
  readonly workflowId: string;
  readonly objective: string;
  readonly status: 'succeeded' | 'failed';
  readonly repairs: number;
  readonly durationMs: number;
  readonly phaseCount: number;
  /** Deterministic structured summary, safe to return over HTTP. */
  readonly summary: Record<string, JsonValue>;
}

/** Dependencies for the workflow service. */
export interface WorkflowServiceDeps {
  readonly ai: AIWorkflow;
  readonly orchestrator: Orchestrator;
  readonly runs: RunRepository;
  readonly ids: IdGenerator;
  readonly tracer: LocalTracer;
  /** Default maximum repair cycles when a caller does not specify. */
  readonly maxRepairCycles?: number;
}

/**
 * Write-side application service.
 *
 * Both execution paths are traced: the AI workflow and the plain
 * M1 task-graph orchestrator. Spans are finalized and persisted
 * when a run completes so metrics are always durable.
 */
export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  /**
   * Create a run row without executing it.
   *
   * Useful for reserving an id (for example an approval workflow
   * that must exist before an action is approved).
   */
  createRun(request: CreateRunRequest): CreatedRun {
    const runId = this.deps.ids.runId();
    const createdAt = new Date().toISOString();

    this.deps.runs.create({
      id: runId,
      name: request.name,
      status: 'pending',
      createdAt,
      ...(request.metadata !== undefined
        ? { metadata: canonicalJson(request.metadata as Record<string, JsonValue>) }
        : {}),
    });

    return { runId, name: request.name, status: 'pending', createdAt };
  }

  /**
   * Execute an AI workflow for an objective.
   *
   * Delegates entirely to the existing `AIWorkflow`; this method
   * adds only tracing and a transport-friendly summary.
   */
  async executeRun(
    objective: string,
    options: { readonly maxRepairCycles?: number } = {},
  ): Promise<WorkflowExecutionResult> {
    const startedAt = Date.now();

    const span = this.deps.tracer.start({
      runId: 'pending',
      name: 'workflow.execute',
      attributes: {
        'workflow.objective_length': objective.length,
        'workflow.max_repair_cycles': options.maxRepairCycles ?? this.deps.maxRepairCycles ?? 1,
      },
    });

    let outcome: AIWorkflowOutcome;
    try {
      outcome = await this.deps.ai.run(objective);
      this.deps.tracer.end(span, { attributes: { 'workflow.status': outcome.status } });
    } catch (error) {
      this.deps.tracer.end(span, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Persist spans and derived metrics for the workflow run.
    this.deps.tracer.finalizeRun(outcome.workflowId);

    // The workflow id scopes workflow-level evidence, but the
    // orchestrator persists its own run rows underneath. Register a
    // run row for the workflow so it is a first-class resource, and
    // record the member run ids so reads can aggregate across them.
    const memberRunIds = outcome.runs.map((run) => run.runId);
    this.registerWorkflowRun(outcome, memberRunIds, startedAt);

    // Agent and tool spans carry their member run's id, so metrics
    // are finalized per member run as well as for the workflow id.
    for (const memberId of memberRunIds) {
      this.deps.tracer.finalizeRun(memberId);
    }

    return {
      runId: outcome.workflowId,
      workflowId: outcome.workflowId,
      objective: outcome.objective,
      status: outcome.status,
      repairs: outcome.repairs,
      durationMs: outcome.durationMs > 0 ? outcome.durationMs : Date.now() - startedAt,
      phaseCount: outcome.phases.length,
      summary: this.summarize(outcome),
    };
  }

  /**
   * Execute a plain M1-style task graph.
   *
   * Exposed so the API can drive both engines through one service
   * instead of each transport reaching for the orchestrator.
   */
  async executeGraph(
    graph: TaskGraph,
    runName: string,
  ): Promise<RunOutcome> {
    const handle = this.deps.orchestrator.start(graph, runName);
    const span = this.deps.tracer.start({
      runId: handle.runId,
      name: 'workflow.execute',
      attributes: { 'workflow.run_name': runName, 'workflow.engine': 'orchestrator' },
    });

    try {
      const outcome = await handle.promise;
      this.deps.tracer.end(span, { attributes: { 'workflow.status': outcome.status } });
      this.deps.tracer.finalizeRun(handle.runId);
      return outcome;
    } catch (error) {
      this.deps.tracer.end(span, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Register the workflow as a persisted run.
   *
   * `AIWorkflow` scopes its own evidence under `workflowId` but
   * the orchestrator creates a separate run row per phase (planner,
   * main, repairs). Writing a run row for the workflow id makes
   * the whole workflow addressable as one resource, with the member
   * run ids recorded in its metadata so event and evidence reads
   * can span the entire execution.
   */
  private registerWorkflowRun(
    outcome: AIWorkflowOutcome,
    memberRunIds: readonly string[],
    startedAtMs: number,
  ): void {
    const metadata = {
      workflowId: outcome.workflowId,
      // Sorted so the metadata is stable across identical runs.
      memberRunIds: [...memberRunIds].sort(),
      objective: outcome.objective,
      repairs: outcome.repairs,
    };
    const serialized = canonicalJson(metadata);
    const startedIso = new Date(startedAtMs).toISOString();
    const completedIso = new Date(startedAtMs + outcome.durationMs).toISOString();

    const existing = this.deps.runs.get(outcome.workflowId);
    if (existing === null || existing === undefined) {
      this.deps.runs.create({
        id: outcome.workflowId,
        name: outcome.objective,
        status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
        createdAt: startedIso,
        metadata: serialized,
      });
    }

    this.deps.runs.updateStatus(outcome.workflowId, {
      status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
      updatedAt: completedIso,
      startedAt: startedIso,
      completedAt: completedIso,
    });
    this.deps.runs.setMetadata(outcome.workflowId, serialized);
  }

  /** Deterministic, JSON-safe summary of a workflow outcome. */
  private summarize(outcome: AIWorkflowOutcome): Record<string, JsonValue> {
    return {
      status: outcome.status,
      repairs: outcome.repairs,
      taskCount: outcome.plan.tasks.length,
      phases: outcome.phases.map((phase) => ({
        label: phase.label,
        agent: phase.agent,
        status: phase.status,
        durationMs: phase.durationMs,
        ...(phase.verificationPassed !== undefined
          ? { verificationPassed: phase.verificationPassed }
          : {}),
      })),
      ...(outcome.verification !== undefined
        ? {
            verificationPassed: outcome.verification.passed,
            ...(outcome.verification.score !== undefined
              ? { verificationScore: outcome.verification.score }
              : {}),
          }
        : {}),
    };
  }
}

/** Re-exported so callers can type graph inputs without importing graph internals. */
export type WorkflowTask = TaskDefinition;