/**
 * Local metric registry (Milestone 5-A).
 *
 * Counters and gauges accumulated in-process, using
 * OpenTelemetry-compatible metric names. Values persist through
 * the existing SQLite layer.
 *
 * Token metrics are modelled as *optional*: a counter that has
 * never been observed stays `null`, which the API renders as
 * "unavailable" rather than `0`.
 */

import type { Clock } from '../core/types.js';
import type { Span, SpanTokenUsage } from './spans.js';
import { aggregateTokenUsage } from './spans.js';

/** A single accumulated metric. */
export interface MetricValue {
  readonly name: string;
  readonly value: number;
  readonly count: number;
  readonly updatedAt: number;
}

/** Standard metric names, matching common OTel conventions. */
export const METRIC_NAMES = {
  runDuration: 'workflow.run.duration_ms',
  runCount: 'workflow.run.count',
  agentDuration: 'agent.duration_ms',
  taskDuration: 'task.duration_ms',
  toolCalls: 'tool.call.count',
  toolErrors: 'tool.error.count',
  errors: 'error.count',
  retries: 'retry.count',
  repairs: 'repair.count',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  totalTokens: 'gen_ai.usage.total_tokens',
  policyDenials: 'policy.denial.count',
} as const;

/**
 * Accumulating metric store for a single scope (typically one run).
 *
 * Counters add, gauges overwrite, and every mutation bumps `count`
 * so consumers can distinguish "observed once with value 5" from
 * "summed five times to 5".
 */
export class MetricRegistry {
  private readonly metrics = new Map<string, MetricValue>();

  constructor(private readonly clock: Clock) {}

  /** Add to a counter, creating it when absent. */
  add(name: string, delta: number): void {
    const existing = this.metrics.get(name);
    if (existing === undefined) {
      this.metrics.set(name, { name, value: delta, count: 1, updatedAt: this.clock.now() });
      return;
    }
    this.metrics.set(name, {
      name,
      value: existing.value + delta,
      count: existing.count + 1,
      updatedAt: this.clock.now(),
    });
  }

  /** Set a gauge to an absolute value. */
  set(name: string, value: number): void {
    const existing = this.metrics.get(name);
    this.metrics.set(name, {
      name,
      value,
      count: (existing?.count ?? 0) + 1,
      updatedAt: this.clock.now(),
    });
  }

  /** Read a metric; undefined when never observed. */
  get(name: string): MetricValue | undefined {
    return this.metrics.get(name);
  }

  /** Every recorded metric, sorted by name for determinism. */
  list(): MetricValue[] {
    return [...this.metrics.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Remove all metrics. */
  clear(): void {
    this.metrics.clear();
  }

  /**
   * Derive the standard metric set from a run's spans.
   *
   * This is the single place run-level telemetry is computed, so
   * the CLI, the API and the tests all observe identical numbers.
   */
  static fromSpans(spans: readonly Span[]): MetricValue[] {
    const clock = { now: () => 0 } as Clock;
    const registry = new MetricRegistry(clock);
    const now = spans.reduce((max, span) => Math.max(max, span.endedAt ?? span.startedAt), 0);

    for (const span of spans) {
      if (span.durationMs !== undefined) {
        registry.add('span.duration_ms', span.durationMs);
      }
      if (span.status === 'error') {
        registry.add(METRIC_NAMES.errors, 1);
      }

      switch (span.name) {
        case 'agent.execute':
          if (span.durationMs !== undefined) {
            registry.add(METRIC_NAMES.agentDuration, span.durationMs);
          }
          break;
        case 'tool.call':
          registry.add(METRIC_NAMES.toolCalls, 1);
          if (span.status === 'error') {
            registry.add(METRIC_NAMES.toolErrors, 1);
          }
          break;
        case 'task.retry':
          registry.add(METRIC_NAMES.retries, 1);
          break;
        case 'policy.denial':
          registry.add(METRIC_NAMES.policyDenials, 1);
          break;
        case 'workflow.repair':
          registry.add(METRIC_NAMES.repairs, 1);
          break;
        default:
          break;
      }

      // A `task.retry` span already represents exactly one retry, so
      // its `retry.count` attribute must not be added again — that
      // would double count. The attribute is only read from spans
      // that are not themselves retry events.
      if (span.name !== 'task.retry') {
        const retries = span.attributes['retry.count'];
        if (typeof retries === 'number' && retries > 0) {
          registry.add(METRIC_NAMES.retries, retries);
        }
      }
    }

    // Run duration: the workflow span, or the full span window.
    const runSpan = spans.find((span) => span.name === 'workflow.execute');
    if (runSpan?.durationMs !== undefined) {
      registry.set(METRIC_NAMES.runDuration, runSpan.durationMs);
      registry.set(METRIC_NAMES.runCount, 1);
    } else if (spans.length > 0) {
      const starts = Math.min(...spans.map((span) => span.startedAt));
      registry.set(METRIC_NAMES.runDuration, Math.max(0, now - starts));
    }

    // Tokens only when a provider actually reported usage.
    const usage: SpanTokenUsage = aggregateTokenUsage(spans);
    if (usage.inputTokens !== null) registry.set(METRIC_NAMES.inputTokens, usage.inputTokens);
    if (usage.outputTokens !== null) registry.set(METRIC_NAMES.outputTokens, usage.outputTokens);
    if (usage.totalTokens !== null) registry.set(METRIC_NAMES.totalTokens, usage.totalTokens);

    // Stamp every metric with the same deterministic timestamp so
    // persisted output is stable.
    return registry.list().map((metric) => ({ ...metric, updatedAt: now }));
  }
}