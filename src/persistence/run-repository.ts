import type Database from 'better-sqlite3';
import { RunNotFoundError } from '../core/errors.js';
import type { RunStatus } from '../core/status.js';

export interface RunRow {
  readonly id: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly metadata?: string;
}

interface RunInsert {
  readonly id: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly metadata?: string;
}

interface RunUpdate {
  readonly status: RunStatus;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

/**
 * Repository for workflow runs. All timestamps are ISO-8601 strings.
 */
export class RunRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: RunInsert): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, name, status, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.status, input.createdAt, input.createdAt, input.metadata ?? null);
  }

  updateStatus(id: string, update: RunUpdate): void {
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [update.status, update.updatedAt];
    if (update.startedAt !== undefined) {
      sets.push('started_at = ?');
      params.push(update.startedAt);
    }
    if (update.completedAt !== undefined) {
      sets.push('completed_at = ?');
      params.push(update.completedAt);
    }
    if (update.error !== undefined) {
      sets.push('error = ?');
      params.push(update.error);
    }
    params.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  get(id: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | {
          id: string;
          name: string;
          status: string;
          created_at: string;
          updated_at: string;
          started_at: string | null;
          completed_at: string | null;
          error: string | null;
          metadata: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      name: row.name,
      status: row.status as RunStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      metadata: row.metadata ?? undefined,
    };
  }

  list(): RunRow[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at, id').all() as Array<{
      id: string;
      name: string;
      status: string;
      created_at: string;
      updated_at: string;
      started_at: string | null;
      completed_at: string | null;
      error: string | null;
      metadata: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status as RunStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      metadata: row.metadata ?? undefined,
    }));
  }

  /** Get a run or throw RunNotFoundError. */
  require(id: string): RunRow {
    const row = this.get(id);
    if (row === null) {
      throw new RunNotFoundError(id);
    }
    return row;
  }
}
