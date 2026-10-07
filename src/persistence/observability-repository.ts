import type Database from 'better-sqlite3';
import type { Span, SpanKind, SpanStatus, SpanTokenUsage } from '../observability/spans.js';
import type { MetricValue } from '../observability/metrics.js';
import { canonicalJson } from '../core/json.js';
import type { JsonValue } from '../core/json.js';

/** A span row as persisted. */
export interface StoredSpan {
  readonly spanId: string;
  readonly runId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly agent?: string;
  readonly taskId?: string;
  readonly taskName?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly error?: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /** Null components mean "not reported", not zero. */
  readonly tokenUsage: SpanTokenUsage | undefined;
}

/**
 * Append-only span store plus an upserting metric table.
 *
 * Spans are never updated after insertion beyond their terminal
 * state (written once when the span ends), and metrics accumulate
 * via `add`/`set` semantics rather than being replaced.
 */
export class ObservabilityRepository {
  constructor(private readonly db: Database.Database) {}

  /** Persist a finished span. */
  insertSpan(span: Span): void {
    this.db
      .prepare(
        `INSERT INTO spans (
           span_id, run_id, parent_span_id, name, kind, status,
           agent, task_id, task_name, model, provider,
           started_at, ended_at, duration_ms, error, attributes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        span.spanId,
        span.runId,
        span.parentSpanId ?? null,
        span.name,
        span.kind,
        span.status,
        span.agent ?? null,
        span.taskId ?? null,
        span.taskName ?? null,
        span.model ?? null,
        span.provider ?? null,
        new Date(span.startedAt).toISOString(),
        span.endedAt !== undefined ? new Date(span.endedAt).toISOString() : null,
        span.durationMs ?? null,
        span.error ?? null,
        canonicalJson(span.attributes as unknown as JsonValue),
      );
  }

  /** All spans for a run, in start order (ties broken by span id). */
  listSpansByRun(runId: string): StoredSpan[] {
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE run_id = ? ORDER BY started_at, span_id')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapSpan(row));
  }

  /**
   * Merge metrics into the stored set for a run.
   *
   * Counters accumulate (value + existing), matching
   * `MetricRegistry.add`; the row's own count tracks how many
   * observations were folded in.
   */
  mergeMetrics(runId: string, metrics: readonly MetricValue[]): void {
    const select = this.db.prepare(
      'SELECT value, count FROM run_metrics WHERE run_id = ? AND name = ?',
    );
    const insert = this.db.prepare(
      `INSERT INTO run_metrics (run_id, name, value, count, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const update = this.db.prepare(
      'UPDATE run_metrics SET value = ?, count = ?, updated_at = ? WHERE run_id = ? AND name = ?',
    );

    const transaction = this.db.transaction(() => {
      for (const metric of metrics) {
        const existing = select.get(runId, metric.name) as
          | { value: number; count: number }
          | undefined;

        if (existing === undefined) {
          insert.run(runId, metric.name, metric.value, metric.count, new Date(metric.updatedAt).toISOString());
        } else {
          update.run(
            existing.value + metric.value,
            existing.count + metric.count,
            new Date(metric.updatedAt).toISOString(),
            runId,
            metric.name,
          );
        }
      }
    });
    transaction();
  }

  /** All metrics for a run, sorted by name. */
  listMetricsByRun(runId: string): MetricValue[] {
    const rows = this.db
      .prepare('SELECT name, value, count, updated_at FROM run_metrics WHERE run_id = ? ORDER BY name')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      name: row['name'] as string,
      value: row['value'] as number,
      count: row['count'] as number,
      updatedAt: new Date(row['updated_at'] as string).getTime(),
    }));
  }

  private mapSpan(row: Record<string, unknown>): StoredSpan {
    const startedAt = row['started_at'] as string;
    const endedAt = (row['ended_at'] as string | null) ?? undefined;

    // Token usage is reconstructed from the mirrored attributes.
    // A missing attribute means the provider never reported it.
    const attributes = JSON.parse(row['attributes'] as string) as Record<string, string | number | boolean>;
    const input = attributes['gen_ai.usage.input_tokens'];
    const output = attributes['gen_ai.usage.output_tokens'];
    const total = attributes['gen_ai.usage.total_tokens'];
    const hasTokens =
      typeof input === 'number' || typeof output === 'number' || typeof total === 'number';

    return {
      spanId: row['span_id'] as string,
      runId: row['run_id'] as string,
      parentSpanId: (row['parent_span_id'] as string | null) ?? undefined,
      name: row['name'] as string,
      kind: row['kind'] as SpanKind,
      status: row['status'] as SpanStatus,
      agent: (row['agent'] as string | null) ?? undefined,
      taskId: (row['task_id'] as string | null) ?? undefined,
      taskName: (row['task_name'] as string | null) ?? undefined,
      model: (row['model'] as string | null) ?? undefined,
      provider: (row['provider'] as string | null) ?? undefined,
      startedAt,
      endedAt,
      durationMs: (row['duration_ms'] as number | null) ?? undefined,
      error: (row['error'] as string | null) ?? undefined,
      attributes,
      tokenUsage: hasTokens
        ? {
            inputTokens: typeof input === 'number' ? input : null,
            outputTokens: typeof output === 'number' ? output : null,
            totalTokens: typeof total === 'number' ? total : null,
          }
        : undefined,
    };
  }
}