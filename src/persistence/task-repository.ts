import type Database from 'better-sqlite3';
import type { TaskDefinition } from '../graph/task-graph.js';
import type { JsonValue } from '../core/json.js';
import { canonicalJson } from '../core/json.js';
import type { TaskId } from '../core/types.js';
import type { TaskStatus } from '../core/status.js';

export interface TaskRow {
  readonly id: string;
  readonly runId: string;
  readonly taskName: string;
  readonly agent: string;
  readonly capability?: string;
  /** Full task definition as JSON. */
  readonly definition: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  /** Task input as JSON. */
  readonly input: string;
  /** Task output as JSON, once succeeded. */
  readonly output?: string;
  readonly error?: string;
  /** Dependency ids as a JSON array. */
  readonly dependsOn: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface TaskInsert {
  readonly task: TaskDefinition;
  readonly runId: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
}

export interface TaskUpdate {
  readonly status: TaskStatus;
  readonly updatedAt: string;
  readonly attempts?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly output?: JsonValue;
  readonly error?: string;
}

/**
 * Repository for task state within a run. Output and the full task
 * definition are stored as JSON payloads.
 */
export class TaskRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: TaskInsert): void {
    const { task } = input;
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, run_id, task_name, agent, capability, definition, status,
           attempts, input, depends_on, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        input.runId,
        task.name,
        task.agent,
        task.capability ?? null,
        canonicalJson(task as unknown as JsonValue),
        input.status,
        0,
        canonicalJson(task.input),
        canonicalJson(task.dependsOn as unknown as JsonValue),
        input.createdAt,
        input.createdAt,
      );
  }

  updateStatus(id: TaskId, update: TaskUpdate): void {
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [update.status, update.updatedAt];
    if (update.attempts !== undefined) {
      sets.push('attempts = ?');
      params.push(update.attempts);
    }
    if (update.startedAt !== undefined) {
      sets.push('started_at = ?');
      params.push(update.startedAt);
    }
    if (update.completedAt !== undefined) {
      sets.push('completed_at = ?');
      params.push(update.completedAt);
    }
    if (update.output !== undefined) {
      sets.push('output = ?');
      params.push(canonicalJson(update.output));
    }
    if (update.error !== undefined) {
      sets.push('error = ?');
      params.push(update.error);
    }
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  get(id: TaskId): TaskRow | null {
    return this.mapRow(
      this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Record<string, unknown> | undefined,
    );
  }

  listByRun(runId: string): TaskRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, id')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row) as TaskRow);
  }

  private mapRow(row: Record<string, unknown> | undefined): TaskRow | null {
    if (row === undefined) return null;
    return {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      taskName: row['task_name'] as string,
      agent: row['agent'] as string,
      capability: (row['capability'] as string | null) ?? undefined,
      definition: row['definition'] as string,
      status: row['status'] as TaskStatus,
      attempts: row['attempts'] as number,
      input: row['input'] as string,
      output: (row['output'] as string | null) ?? undefined,
      error: (row['error'] as string | null) ?? undefined,
      dependsOn: row['depends_on'] as string,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      startedAt: (row['started_at'] as string | null) ?? undefined,
      completedAt: (row['completed_at'] as string | null) ?? undefined,
    };
  }
}
