import type Database from 'better-sqlite3';
import type { WorkflowEvent } from '../events/events.js';
import type { JsonObject, JsonValue } from '../core/json.js';
import { canonicalJson } from '../core/json.js';

/** An event as stored in the append-only event table. */
export interface StoredEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly type: string;
  /** ISO-8601 occurrence timestamp. */
  readonly occurredAt: string;
  readonly payload: JsonObject;
}

/**
 * Append-only event store. Exposes no update or delete operations:
 * events are the durable audit trail of every run.
 */
export class EventRepository {
  constructor(private readonly db: Database.Database) {}

  append(event: WorkflowEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (event_id, run_id, task_id, type, occurred_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.runId,
        event.taskId ?? null,
        event.type,
        new Date(event.occurredAt).toISOString(),
        canonicalJson(event.payload as unknown as JsonValue),
      );
  }

  /** All events for a run, in append order. */
  listByRun(runId: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  listAll(): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.mapRow(row));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return row.n;
  }

  countByRun(runId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?').get(runId) as {
      n: number;
    };
    return row.n;
  }

  private mapRow(row: Record<string, unknown>): StoredEvent {
    return {
      seq: row['seq'] as number,
      eventId: row['event_id'] as string,
      runId: row['run_id'] as string,
      taskId: (row['task_id'] as string | null) ?? undefined,
      type: row['type'] as string,
      occurredAt: row['occurred_at'] as string,
      payload: JSON.parse(row['payload'] as string) as JsonObject,
    };
  }
}
