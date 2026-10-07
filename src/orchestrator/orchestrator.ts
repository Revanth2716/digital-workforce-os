import type { AgentContext } from '../agents/agent.js';
import type { AgentRegistry } from '../agents/agent-registry.js';
import { AgentNotFoundError, CapabilityMismatchError, TimeoutError } from '../core/errors.js';
import type { JsonValue } from '../core/json.js';
import type { IdGenerator, Clock, RunId, TaskId } from '../core/types.js';
import type { RunStatus, TaskStatus } from '../core/status.js';
import type { TaskDefinition, TaskGraph } from '../graph/task-graph.js';
import type { TypedEventBus } from '../events/event-bus.js';
import type { WorkflowEvent } from '../events/events.js';
import { buildEvent } from '../events/events.js';
import type { EvidenceLog } from '../events/evidence.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { RunRepository } from '../persistence/run-repository.js';
import type { TaskRepository } from '../persistence/task-repository.js';

/** Tunables for a run. */
export interface OrchestratorOptions {
  /** Maximum number of tasks executing concurrently. Defaults to 1 (fully deterministic order). */
  readonly concurrency?: number;
  /** When true (default), the first task failure cancels the whole run. */
  readonly failFast?: boolean;
  /** Base delay for exponential retry backoff. Defaults to 100ms. */
  readonly retryBaseDelayMs?: number;
  /**
   * Optional hook to enrich the agent context per task
   * (Milestone 2 AI layer: objective, previous results,
   * available tools, model metadata). Receives the base context
   * and the task about to run; returns the context handed to
   * the agent. Defaults to the identity function, which leaves
   * Milestone 1 behaviour untouched.
   */
  readonly agentContextFactory?: (base: AgentContext, task: TaskDefinition) => AgentContext;
}

/** Final state of a single task. */
export interface TaskOutcome {
  readonly taskId: TaskId;
  readonly taskName: string;
  readonly agent: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly durationMs: number;
  readonly output?: JsonValue;
  readonly error?: string;
}

/** Final state of a run. */
export interface RunOutcome {
  readonly runId: RunId;
  readonly runName: string;
  readonly status: RunStatus;
  readonly durationMs: number;
  readonly tasks: readonly TaskOutcome[];
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
}

/** Handle to a running workflow. */
export interface RunHandle {
  readonly runId: RunId;
  /** Resolves with the run outcome once every task reached a terminal state. */
  readonly promise: Promise<RunOutcome>;
  /** Request cooperative cancellation. Running agents observe the abort signal. */
  abort(): void;
}

/** Mutable cancellation bookkeeping shared between the handle and the run. */
interface CancellationState {
  byUser: boolean;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Dependency-aware workflow executor.
 *
 * The orchestrator owns the task lifecycle (pending -> ready -> running ->
 * succeeded | failed | cancelled | skipped), schedules tasks only when all
 * dependencies have reached a terminal state, enforces a configurable
 * concurrency limit, retries failed tasks with exponential backoff, and
 * supports cooperative cancellation through an AbortSignal.
 *
 * Dispatch order is deterministic: the ready queue is always sorted by
 * task insertion order. With concurrency = 1, execution order equals the
 * deterministic topological order of the graph.
 */
export class Orchestrator {
  constructor(
    private readonly deps: {
      readonly agents: AgentRegistry;
      readonly tools: ToolRegistry;
      readonly bus: TypedEventBus;
      readonly ids: IdGenerator;
      readonly clock: Clock;
      readonly runs: RunRepository;
      readonly tasks: TaskRepository;
      readonly evidence: EvidenceLog;
      readonly options?: OrchestratorOptions;
    },
  ) {}

  /** Validate and start a run. Does not block; await `handle.promise`. */
  start(graph: TaskGraph, runName: string = 'run'): RunHandle {
    graph.validate();
    const runId = this.deps.ids.runId();
    const controller = new AbortController();
    const cancellation: CancellationState = { byUser: false };

    const promise = this.executeRun(graph, runId, runName, controller, cancellation).catch(
      (error: unknown) => {
        // Infrastructure failure (e.g. persistence): record it, then rethrow.
        const message = error instanceof Error ? error.message : String(error);
        try {
          this.deps.runs.updateStatus(runId, {
            status: 'failed',
            updatedAt: toIso(this.deps.clock.now()),
            completedAt: toIso(this.deps.clock.now()),
            error: message,
          });
        } catch {
          // Persistence itself is broken; surface the original error.
        }
        throw error;
      },
    );

    return {
      runId,
      promise,
      abort: () => {
        cancellation.byUser = true;
        controller.abort();
      },
    };
  }

  /** Convenience: start a run and await its outcome. */
  async execute(graph: TaskGraph, runName?: string): Promise<RunOutcome> {
    const handle = this.start(graph, runName);
    return handle.promise;
  }

  private async executeRun(
    graph: TaskGraph,
    runId: RunId,
    runName: string,
    controller: AbortController,
    cancellation: CancellationState,
  ): Promise<RunOutcome> {
    const { bus, clock, ids, runs, tasks } = this.deps;
    const signal = controller.signal;
    const concurrency = Math.max(1, this.deps.options?.concurrency ?? 1);
    const failFast = this.deps.options?.failFast ?? true;
    const retryBaseDelayMs = this.deps.options?.retryBaseDelayMs ?? 100;

    const startedAt = clock.now();
    runs.create({ id: runId, name: runName, status: 'running', createdAt: toIso(startedAt) });
    bus.emit(
      buildEvent('run.created', { id: ids.eventId(), runId, occurredAt: startedAt }, {
        runName,
        taskCount: graph.size,
      }),
    );

    // ---- mutable run state ---------------------------------------------
    const status = new Map<TaskId, TaskStatus>();
    const attempts = new Map<TaskId, number>();
    const outcomes = new Map<TaskId, TaskOutcome>();
    const indegree = new Map<TaskId, number>();
    const insertionOrder = new Map<TaskId, number>();
    const ready: TaskDefinition[] = [];
    const running = new Map<TaskId, Promise<void>>();
    const settled = new Set<TaskId>();

    for (const [index, task] of graph.tasks.entries()) {
      insertionOrder.set(task.id, index);
      status.set(task.id, 'pending');
      attempts.set(task.id, 0);
      indegree.set(task.id, task.dependsOn.length);
      tasks.create({ task, runId, status: 'pending', createdAt: toIso(startedAt) });
    }

    const emit = (event: WorkflowEvent): void => {
      bus.emit(event);
    };

    const byInsertion = (a: TaskDefinition, b: TaskDefinition): number =>
      (insertionOrder.get(a.id) ?? 0) - (insertionOrder.get(b.id) ?? 0);

    const markReady = (task: TaskDefinition): void => {
      status.set(task.id, 'ready');
      tasks.updateStatus(task.id, { status: 'ready', updatedAt: toIso(clock.now()) });
      emit(
        buildEvent('task.queued', { id: ids.eventId(), runId, taskId: task.id, occurredAt: clock.now() }, {
          taskName: task.name,
          agent: task.agent,
        }),
      );
      ready.push(task);
      ready.sort(byInsertion);
    };

    const cancelTask = (task: TaskDefinition, reason: string): void => {
      const current = status.get(task.id);
      if (current !== 'pending' && current !== 'ready') return;
      const completedAt = clock.now();
      status.set(task.id, 'cancelled');
      outcomes.set(task.id, {
        taskId: task.id,
        taskName: task.name,
        agent: task.agent,
        status: 'cancelled',
        attempts: attempts.get(task.id) ?? 0,
        durationMs: completedAt - startedAt,
      });
      tasks.updateStatus(task.id, {
        status: 'cancelled',
        updatedAt: toIso(completedAt),
        completedAt: toIso(completedAt),
      });
      emit(
        buildEvent('task.cancelled', { id: ids.eventId(), runId, taskId: task.id, occurredAt: completedAt }, {
          taskName: task.name,
          reason,
        }),
      );
      const index = ready.indexOf(task);
      if (index >= 0) ready.splice(index, 1);
    };

    const skipTask = (task: TaskDefinition, reason: string): void => {
      const current = status.get(task.id);
      if (current !== 'pending' && current !== 'ready') return;
      const completedAt = clock.now();
      status.set(task.id, 'skipped');
      outcomes.set(task.id, {
        taskId: task.id,
        taskName: task.name,
        agent: task.agent,
        status: 'skipped',
        attempts: attempts.get(task.id) ?? 0,
        durationMs: completedAt - startedAt,
      });
      tasks.updateStatus(task.id, {
        status: 'skipped',
        updatedAt: toIso(completedAt),
        completedAt: toIso(completedAt),
      });
      emit(
        buildEvent('task.skipped', { id: ids.eventId(), runId, taskId: task.id, occurredAt: completedAt }, {
          taskName: task.name,
          reason,
        }),
      );
      const index = ready.indexOf(task);
      if (index >= 0) ready.splice(index, 1);
    };

    const runTask = async (task: TaskDefinition): Promise<void> => {
      const maxAttempts = 1 + (task.retries ?? 0);
      let attempt = 0;

      for (;;) {
        attempt += 1;
        attempts.set(task.id, attempt);
        const attemptStart = clock.now();
        status.set(task.id, 'running');
        tasks.updateStatus(task.id, {
          status: 'running',
          updatedAt: toIso(attemptStart),
          attempts: attempt,
          startedAt: toIso(attemptStart),
        });
        emit(
          buildEvent('task.started', { id: ids.eventId(), runId, taskId: task.id, occurredAt: attemptStart }, {
            taskName: task.name,
            agent: task.agent,
            attempt,
          }),
        );

        const baseContext: AgentContext = {
          runId,
          taskId: task.id,
          attempt,
          signal,
          clock,
          tools: this.deps.tools,
          evidence: this.deps.evidence,
        };
        const context: AgentContext = this.deps.options?.agentContextFactory
          ? this.deps.options.agentContextFactory(baseContext, task)
          : baseContext;

        try {
          const agent = this.deps.agents.get(task.agent);
          if (task.capability !== undefined && !agent.capabilities.includes(task.capability)) {
            throw new CapabilityMismatchError(agent.name, task.capability);
          }

          const execution = agent.execute(task.input, context);
          const result =
            task.timeoutMs !== undefined
              ? await this.raceTimeout(execution, task.timeoutMs)
              : await execution;

          const completedAt = clock.now();
          const durationMs = completedAt - attemptStart;
          status.set(task.id, 'succeeded');
          outcomes.set(task.id, {
            taskId: task.id,
            taskName: task.name,
            agent: task.agent,
            status: 'succeeded',
            attempts: attempt,
            durationMs,
            output: result.output,
          });
          tasks.updateStatus(task.id, {
            status: 'succeeded',
            updatedAt: toIso(completedAt),
            attempts: attempt,
            completedAt: toIso(completedAt),
            output: result.output,
          });
          emit(
            buildEvent('task.succeeded', { id: ids.eventId(), runId, taskId: task.id, occurredAt: completedAt }, {
              taskName: task.name,
              attempt,
              durationMs,
              summary: truncate(result.summary, 160),
            }),
          );
          return;
        } catch (error) {
          const completedAt = clock.now();
          const durationMs = completedAt - attemptStart;

          // Cooperative cancellation wins over every other failure mode.
          if (signal.aborted) {
            status.set(task.id, 'cancelled');
            outcomes.set(task.id, {
              taskId: task.id,
              taskName: task.name,
              agent: task.agent,
              status: 'cancelled',
              attempts: attempt,
              durationMs,
            });
            tasks.updateStatus(task.id, {
              status: 'cancelled',
              updatedAt: toIso(completedAt),
              attempts: attempt,
              completedAt: toIso(completedAt),
            });
            emit(
              buildEvent('task.cancelled', { id: ids.eventId(), runId, taskId: task.id, occurredAt: completedAt }, {
                taskName: task.name,
                reason: 'aborted',
              }),
            );
            return;
          }

          if (attempt < maxAttempts) {
            const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
            emit(
              buildEvent('task.retried', { id: ids.eventId(), runId, taskId: task.id, occurredAt: completedAt }, {
                taskName: task.name,
                attempt,
                maxAttempts,
                delayMs,
              }),
            );
            await clock.sleep(delayMs);
            continue;
          }

          const message = error instanceof Error ? error.message : String(error);
          status.set(task.id, 'failed');
          outcomes.set(task.id, {
            taskId: task.id,
            taskName: task.name,
            agent: task.agent,
            status: 'failed',
            attempts: attempt,
            durationMs,
            error: message,
          });
          tasks.updateStatus(task.id, {
            status: 'failed',
            updatedAt: toIso(completedAt),
            attempts: attempt,
            completedAt: toIso(completedAt),
            error: message,
          });
          emit(
            buildEvent('task.failed', { id: ids.eventId(), runId, taskId: task.id, occurredAt: completedAt }, {
              taskName: task.name,
              attempt,
              durationMs,
              error: message,
            }),
          );
          return;
        }
      }
    };

    const transitiveDependents = (root: TaskId): TaskDefinition[] => {
      const result: TaskDefinition[] = [];
      const seen = new Set<TaskId>();
      const queue: TaskDefinition[] = [...graph.dependentsOf(root)];
      while (queue.length > 0) {
        const task = queue.shift();
        if (task === undefined) break;
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        result.push(task);
        queue.push(...graph.dependentsOf(task.id));
      }
      return result;
    };

    const handleSettled = (task: TaskDefinition): void => {
      const taskStatus = status.get(task.id);
      if (taskStatus === 'succeeded') {
        for (const dependent of graph.dependentsOf(task.id)) {
          const next = (indegree.get(dependent.id) ?? 0) - 1;
          indegree.set(dependent.id, next);
          if (next === 0 && status.get(dependent.id) === 'pending') {
            markReady(dependent);
          }
        }
        return;
      }
      if (taskStatus === 'failed') {
        if (failFast) {
          // Stop the world: running agents observe the signal and
          // everything not yet terminal is cancelled.
          controller.abort();
          for (const other of graph.tasks) {
            const current = status.get(other.id);
            if (current === 'pending' || current === 'ready') {
              cancelTask(other, 'fail-fast');
            }
          }
        } else {
          // Skip everything downstream of the failure, keep going.
          for (const dependent of transitiveDependents(task.id)) {
            const current = status.get(dependent.id);
            if (current === 'pending' || current === 'ready') {
              skipTask(dependent, `dependency '${task.name}' failed`);
            }
          }
        }
      }
    };

    // ---- scheduler loop --------------------------------------------------
    for (const task of graph.tasks) {
      if ((indegree.get(task.id) ?? 0) === 0) {
        markReady(task);
      }
    }

    while (ready.length > 0 || running.size > 0) {
      while (running.size < concurrency && ready.length > 0) {
        const task = ready.shift();
        if (task === undefined) break;
        if (signal.aborted) {
          cancelTask(task, 'run aborted');
          continue;
        }
        const promise = runTask(task);
        running.set(task.id, promise);
        void promise.then(
          () => {
            settled.add(task.id);
            handleSettled(task);
          },
          () => {
            // runTask only rejects on infrastructure errors; the
            // rejection propagates through Promise.race below.
            settled.add(task.id);
          },
        );
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
      for (const id of [...running.keys()]) {
        if (settled.has(id)) running.delete(id);
      }
    }

    // ---- finalize --------------------------------------------------------
    // User cancellation can leave tasks that were never dispatched.
    // Move every remaining non-terminal task to cancelled so the
    // outcome and the persisted state agree.
    for (const task of graph.tasks) {
      const current = status.get(task.id);
      if (current === 'pending' || current === 'ready') {
        cancelTask(task, 'run ended');
      }
    }

    const completedAt = clock.now();
    const allOutcomes: TaskOutcome[] = graph.tasks.map((task) => {
      const outcome = outcomes.get(task.id);
      if (outcome !== undefined) return outcome;
      // Defensive fallback: every scheduler path terminates its tasks.
      return {
        taskId: task.id,
        taskName: task.name,
        agent: task.agent,
        status: 'cancelled' as TaskStatus,
        attempts: attempts.get(task.id) ?? 0,
        durationMs: completedAt - startedAt,
      };
    });

    const succeeded = allOutcomes.filter((outcome) => outcome.status === 'succeeded').length;
    const failed = allOutcomes.filter((outcome) => outcome.status === 'failed').length;
    const cancelled = allOutcomes.filter((outcome) => outcome.status === 'cancelled').length;
    const skipped = allOutcomes.filter((outcome) => outcome.status === 'skipped').length;

    let runStatus: RunStatus;
    if (cancellation.byUser) {
      runStatus = 'cancelled';
    } else if (failed > 0) {
      runStatus = 'failed';
    } else {
      runStatus = 'succeeded';
    }

    const firstFailure = allOutcomes.find((outcome) => outcome.status === 'failed');
    runs.updateStatus(runId, {
      status: runStatus,
      updatedAt: toIso(completedAt),
      startedAt: toIso(startedAt),
      completedAt: toIso(completedAt),
      error: firstFailure?.error,
    });

    const outcome: RunOutcome = {
      runId,
      runName,
      status: runStatus,
      durationMs: completedAt - startedAt,
      tasks: allOutcomes,
      succeeded,
      failed,
      cancelled,
      skipped,
    };

    if (runStatus === 'succeeded') {
      emit(
        buildEvent('run.completed', { id: ids.eventId(), runId, occurredAt: completedAt }, {
          taskCount: graph.size,
          succeeded,
        }),
      );
    } else if (runStatus === 'failed') {
      emit(
        buildEvent('run.failed', { id: ids.eventId(), runId, occurredAt: completedAt }, {
          taskCount: graph.size,
          succeeded,
          failed,
        }),
      );
    } else {
      emit(
        buildEvent('run.cancelled', { id: ids.eventId(), runId, occurredAt: completedAt }, {
          taskCount: graph.size,
          succeeded,
        }),
      );
    }

    return outcome;
  }

  /** Race an execution against a wall-clock budget. */
  private async raceTimeout(
    execution: Promise<{ readonly output: JsonValue; readonly summary: string }>,
    timeoutMs: number,
  ): Promise<{ readonly output: JsonValue; readonly summary: string }> {
    const timeout = this.deps.clock.sleep(timeoutMs).then(() => {
      throw new TimeoutError(timeoutMs);
    });
    return Promise.race([execution, timeout]);
  }
}
