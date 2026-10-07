import type { TaskId } from '../core/types.js';
import { CycleError, DuplicateTaskError, TaskNotFoundError, ValidationError } from '../core/errors.js';
import type { JsonValue } from '../core/json.js';

/**
 * Declarative definition of a unit of work. Tasks are pure data: the
 * orchestrator interprets them, which keeps the graph serializable and
 * testable without executing anything.
 */
export interface TaskDefinition {
  readonly id: TaskId;
  readonly name: string;
  /** Name of the registered agent that executes this task. */
  readonly agent: string;
  /** Optional capability the executing agent must advertise. */
  readonly capability?: string;
  /** JSON-serializable input handed to the agent. */
  readonly input: JsonValue;
  /** Ids of tasks that must reach a terminal state first. */
  readonly dependsOn: readonly TaskId[];
  /** Number of retries after the first failed attempt. Defaults to 0. */
  readonly retries?: number;
  /** Optional per-attempt wall-clock budget in milliseconds. */
  readonly timeoutMs?: number;
  readonly metadata?: Record<string, string>;
}

/** Convenience factory for task definitions. */
export function createTask(
  id: TaskId,
  name: string,
  agent: string,
  options?: {
    readonly capability?: string;
    readonly input?: JsonValue;
    readonly dependsOn?: readonly TaskId[];
    readonly retries?: number;
    readonly timeoutMs?: number;
    readonly metadata?: Record<string, string>;
  },
): TaskDefinition {
  return {
    id,
    name,
    agent,
    capability: options?.capability,
    input: options?.input ?? null,
    dependsOn: options?.dependsOn ?? [],
    retries: options?.retries,
    timeoutMs: options?.timeoutMs,
    metadata: options?.metadata,
  };
}

/**
 * An immutable directed acyclic graph of tasks. Provides dependency queries,
 * structural validation, cycle detection and a deterministic topological
 * ordering (ties broken by insertion order, so the same construction sequence
 * always yields the same schedule).
 */
export class TaskGraph {
  private readonly taskMap = new Map<TaskId, TaskDefinition>();
  private readonly insertionOrder = new Map<TaskId, number>();
  private readonly dependencies = new Map<TaskId, TaskId[]>();
  private readonly dependents = new Map<TaskId, TaskId[]>();

  /** Add a task. Structural constraints are enforced eagerly. */
  addTask(task: TaskDefinition): void {
    if (this.taskMap.has(task.id)) {
      throw new DuplicateTaskError(task.id);
    }
    if (task.name.trim().length === 0) {
      throw new ValidationError(`Task ${task.id} must have a non-empty name`);
    }
    if (task.agent.trim().length === 0) {
      throw new ValidationError(`Task ${task.id} must reference a non-empty agent`);
    }
    if (task.retries !== undefined && task.retries < 0) {
      throw new ValidationError(`Task ${task.id} retries must be >= 0`);
    }
    if (task.timeoutMs !== undefined && task.timeoutMs <= 0) {
      throw new ValidationError(`Task ${task.id} timeoutMs must be > 0`);
    }
    const seen = new Set<string>();
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        throw new ValidationError(`Task ${task.id} cannot depend on itself`);
      }
      if (seen.has(dep)) {
        throw new ValidationError(`Task ${task.id} lists duplicate dependency ${dep}`);
      }
      seen.add(dep);
    }
    const order = this.taskMap.size;
    this.taskMap.set(task.id, task);
    this.insertionOrder.set(task.id, order);
    this.dependencies.set(task.id, [...task.dependsOn]);
    this.dependents.set(task.id, []);
    for (const dep of task.dependsOn) {
      this.dependents.get(dep)?.push(task.id);
    }
  }

  getTask(id: TaskId): TaskDefinition {
    const task = this.taskMap.get(id);
    if (task === undefined) {
      throw new TaskNotFoundError(id);
    }
    return task;
  }

  hasTask(id: TaskId): boolean {
    return this.taskMap.has(id);
  }

  get size(): number {
    return this.taskMap.size;
  }

  /** All tasks in insertion order. */
  get tasks(): TaskDefinition[] {
    return [...this.taskMap.values()];
  }

  /** Direct dependencies of a task. Throws if the task is unknown. */
  dependenciesOf(id: TaskId): TaskDefinition[] {
    this.getTask(id);
    return (this.dependencies.get(id) ?? []).map((dep) => this.getTask(dep));
  }

  /** Tasks that directly depend on this task. Throws if the task is unknown. */
  dependentsOf(id: TaskId): TaskDefinition[] {
    this.getTask(id);
    return (this.dependents.get(id) ?? []).map((dep) => this.getTask(dep));
  }

  /**
   * Cross-reference validation: every dependency must exist, and the graph
   * must be acyclic. Throws ValidationError or CycleError.
   */
  validate(): void {
    for (const task of this.taskMap.values()) {
      for (const dep of task.dependsOn) {
        if (!this.taskMap.has(dep)) {
          throw new ValidationError(`Task ${task.id} depends on unknown task ${dep}`);
        }
      }
    }
    const cycle = this.detectCycle();
    if (cycle !== null) {
      throw new CycleError(cycle);
    }
  }

  /**
   * Deterministic topological order (Kahn's algorithm). When several tasks
   * are simultaneously schedulable, the earliest-inserted task is emitted
   * first, so ordering is reproducible across runs.
   */
  topologicalOrder(): TaskDefinition[] {
    this.validate();
    const indegree = new Map<TaskId, number>();
    for (const task of this.taskMap.values()) {
      indegree.set(task.id, task.dependsOn.length);
    }
    const byInsertion = (a: TaskDefinition, b: TaskDefinition): number =>
      (this.insertionOrder.get(a.id) ?? 0) - (this.insertionOrder.get(b.id) ?? 0);

    const ready: TaskDefinition[] = [];
    for (const task of this.taskMap.values()) {
      if ((indegree.get(task.id) ?? 0) === 0) {
        ready.push(task);
      }
    }
    ready.sort(byInsertion);

    const result: TaskDefinition[] = [];
    while (ready.length > 0) {
      const task = ready.shift();
      if (task === undefined) break;
      result.push(task);
      const newlyReady: TaskDefinition[] = [];
      for (const dependentId of this.dependents.get(task.id) ?? []) {
        const next = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, next);
        if (next === 0) {
          const dependent = this.taskMap.get(dependentId);
          if (dependent !== undefined) newlyReady.push(dependent);
        }
      }
      if (newlyReady.length > 0) {
        ready.push(...newlyReady);
        ready.sort(byInsertion);
      }
    }
    if (result.length !== this.taskMap.size) {
      // Defensive: validate() above already rules this out.
      throw new CycleError(result.map((task) => task.id));
    }
    return result;
  }

  /**
   * Group tasks into execution waves: every task in wave N has all
   * dependencies in earlier waves. Useful for visualization and batching.
   */
  levels(): TaskDefinition[][] {
    this.validate();
    const levelOf = new Map<TaskId, number>();
    const resolve = (id: TaskId): number => {
      const cached = levelOf.get(id);
      if (cached !== undefined) return cached;
      const deps = this.dependencies.get(id) ?? [];
      const level = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(resolve));
      levelOf.set(id, level);
      return level;
    };
    for (const task of this.taskMap.values()) resolve(task.id);
    const levels: TaskDefinition[][] = [];
    for (const task of this.tasks.values()) {
      const level = levelOf.get(task.id) ?? 0;
      (levels[level] ??= []).push(task);
    }
    return levels;
  }

  /** DFS-based cycle detection. Returns the cycle (closed path) or null. */
  private detectCycle(): TaskId[] | null {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<TaskId, number>();
    const stack: TaskId[] = [];

    const visit = (id: TaskId): TaskId[] | null => {
      color.set(id, GRAY);
      stack.push(id);
      for (const dep of this.dependencies.get(id) ?? []) {
        const state = color.get(dep) ?? WHITE;
        if (state === GRAY) {
          const start = stack.indexOf(dep);
          const cycle = stack.slice(start >= 0 ? start : 0);
          return [...cycle, dep];
        }
        if (state === WHITE) {
          const found = visit(dep);
          if (found !== null) return found;
        }
      }
      color.set(id, BLACK);
      stack.pop();
      return null;
    };

    for (const task of this.taskMap.values()) {
      if ((color.get(task.id) ?? WHITE) === WHITE) {
        const found = visit(task.id);
        if (found !== null) return found;
      }
    }
    return null;
  }
}
