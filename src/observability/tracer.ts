/**
 * Local tracer (Milestone 5-A).
 *
 * An in-process tracer that creates spans, supports nesting via a
 * parent span id, and persists finished spans through the existing
 * SQLite layer.
 *
 * It intentionally mirrors OpenTelemetry's API shape
 * (`startSpan` / `endSpan` / `withSpan`) without depending on the
 * OTel SDK or sending anything over a network.
 */

import type { Clock } from '../core/types.js';
import type { ObservabilityRepository } from '../persistence/observability-repository.js';
import type { MetricValue } from './metrics.js';
import { MetricRegistry } from './metrics.js';
import type { Span, SpanContext, SpanKind, SpanTokenUsage } from './spans.js';
import { endSpan, startSpan } from './spans.js';

/** Input for starting a span. */
export interface StartSpanInput {
  readonly runId: string;
  readonly name: string;
  /** Parent span id, for nesting. */
  readonly parentSpanId?: string;
  readonly kind?: SpanKind;
  readonly agent?: string;
  readonly taskId?: string;
  readonly taskName?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly attributes?: Record<string, string | number | boolean>;
}

/** Input for finishing a span. */
export interface EndSpanInput {
  readonly error?: string;
  readonly tokenUsage?: SpanTokenUsage;
  readonly attributes?: Record<string, string | number | boolean>;
}

/**
 * Creates and records spans for a single system.
 *
 * Finished spans are persisted immediately. A span is written once,
 * under the run id it was started with — which matters because a
 * workflow's agent spans belong to the orchestrator's member runs
 * rather than to the workflow id that scopes the workflow itself.
 * Persisting eagerly keeps every span durable regardless of which
 * run is later "finalised".
 */
export class LocalTracer {
  private readonly spans: Span[] = [];
  private readonly persisted = new Set<string>();

  constructor(
    private readonly clock: Clock,
    private readonly repository: ObservabilityRepository,
  ) {}

  /** Begin a span. The returned context must be passed to `end`. */
  start(input: StartSpanInput): SpanContext {
    return startSpan({
      runId: input.runId,
      name: input.name,
      parentSpanId: input.parentSpanId,
      kind: input.kind ?? 'internal',
      agent: input.agent,
      taskId: input.taskId,
      taskName: input.taskName,
      model: input.model,
      provider: input.provider,
      startedAt: this.clock.now(),
      attributes: input.attributes ?? {},
    });
  }

  /** Finish a span, persist it, and return it. */
  end(context: SpanContext, input: EndSpanInput = {}): Span {
    const span = endSpan(context, {
      endedAt: this.clock.now(),
      error: input.error,
      tokenUsage: input.tokenUsage,
      attributes: input.attributes,
    });
    this.spans.push(span);

    // Guard against double-writing a span id.
    if (!this.persisted.has(span.spanId)) {
      this.repository.insertSpan(span);
      this.persisted.add(span.spanId);
    }

    return span;
  }

  /**
   * Run `fn` inside a span, ending it on both success and failure.
   * The error is recorded on the span and rethrown.
   */
  async withSpan<T>(
    input: StartSpanInput,
    fn: (context: SpanContext) => Promise<T>,
  ): Promise<T> {
    const context = this.start(input);
    try {
      const result = await fn(context);
      this.end(context);
      return result;
    } catch (error) {
      this.end(context, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Every span recorded so far, in completion order. */
  listSpans(): readonly Span[] {
    return [...this.spans];
  }

  /** Spans belonging to one run. */
  spansForRun(runId: string): Span[] {
    return this.spans.filter((span) => span.runId === runId);
  }

  /**
 * Derive and persist metrics for a run.
   *
   * Spans are already durable (written on completion); this
   * computes the metric set for the given run id from those spans,
   * so the numbers always agree with the trace. Call it once per
   * run id when that run finishes — including each member run of a
   * workflow, whose agent and tool spans carry the member's id.
   */
  finalizeRun(runId: string): readonly MetricValue[] {
    const spans = this.spansForRun(runId);
    const metrics = MetricRegistry.fromSpans(spans);
    this.repository.mergeMetrics(runId, metrics);
    return metrics;
  }

  /** Drop all buffered spans and persistence bookkeeping. */
  reset(): void {
    this.spans.length = 0;
    this.persisted.clear();
  }
}