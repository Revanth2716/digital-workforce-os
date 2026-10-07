/**
 * Span model (Milestone 5-A).
 *
 * Lightweight, local span primitives that mirror OpenTelemetry's
 * naming and structure (span id, parent span id, name, kind,
 * status, start/end timestamps, attributes) so a future exporter
 * can consume them without reshaping the data.
 *
 * There is deliberately no OTel SDK dependency and no network
 * endpoint: spans live in-process and are persisted to the
 * existing SQLite database.
 */

import { randomUUID } from 'node:crypto';

/** Span kind, following the OpenTelemetry vocabulary. */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/**
 * Span status. `UNSET` means the operation finished without an
 * explicit outcome, which is the OpenTelemetry default.
 */
export type SpanStatus = 'unset' | 'ok' | 'error';

/**
 * Token usage for a model call.
 *
 * `null` means the provider did not report usage. It is kept
 * distinct from `0`, so "no data" is never rendered as "zero
 * tokens used".
 */
export interface SpanTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/** A completed span. */
export interface Span {
  readonly spanId: string;
  readonly runId: string;
  readonly parentSpanId: string | undefined;
  /** Operation name, e.g. `workflow.execute` or `agent.execute`. */
  readonly name: string;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly agent: string | undefined;
  readonly taskId: string | undefined;
  readonly taskName: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly durationMs: number | undefined;
  readonly error: string | undefined;
  /** Free-form attributes (retry counts, tool counts, ...). */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /** Token usage, or undefined when no model call happened. */
  readonly tokenUsage: SpanTokenUsage | undefined;
}

/** A span that has not finished yet. */
export interface SpanContext {
  readonly spanId: string;
  readonly runId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: SpanKind;
  readonly agent: string | undefined;
  readonly taskId: string | undefined;
  readonly taskName: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly startedAt: number;
  readonly attributes: Record<string, string | number | boolean>;
  readonly tokenUsage: SpanTokenUsage | undefined;
}

/** Build a fresh span context with a generated span id. */
export function startSpan(input: {
  readonly runId: string;
  readonly name: string;
  readonly parentSpanId?: string;
  readonly kind?: SpanKind;
  readonly agent?: string;
  readonly taskId?: string;
  readonly taskName?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly startedAt: number;
  readonly attributes?: Record<string, string | number | boolean>;
}): SpanContext {
  return {
    spanId: randomUUID(),
    runId: input.runId,
    parentSpanId: input.parentSpanId,
    name: input.name,
    kind: input.kind ?? 'internal',
    agent: input.agent,
    taskId: input.taskId,
    taskName: input.taskName,
    model: input.model,
    provider: input.provider,
    startedAt: input.startedAt,
    attributes: { ...(input.attributes ?? {}) },
    tokenUsage: undefined,
  };
}

/**
 * Finalize a span context into an immutable `Span`.
 *
 * The status is explicit: `error` when an error message is
 * present, otherwise `ok`. Duration is derived from the supplied
 * end time so callers control the clock (and tests stay
 * deterministic).
 */
export function endSpan(
  context: SpanContext,
  end: {
    readonly endedAt: number;
    readonly error?: string;
    readonly tokenUsage?: SpanTokenUsage;
    readonly attributes?: Record<string, string | number | boolean>;
  },
): Span {
  const error = end.error;
  const attributes: Record<string, string | number | boolean> = {
    ...context.attributes,
    ...(end.attributes ?? {}),
  };

  // Mirror token usage into attributes so an exporter that only
  // reads attributes still sees the numbers.
  const usage = end.tokenUsage ?? context.tokenUsage;
  if (usage !== undefined) {
    if (usage.inputTokens !== null) {
      attributes['gen_ai.usage.input_tokens'] = usage.inputTokens;
    }
    if (usage.outputTokens !== null) {
      attributes['gen_ai.usage.output_tokens'] = usage.outputTokens;
    }
    if (usage.totalTokens !== null) {
      attributes['gen_ai.usage.total_tokens'] = usage.totalTokens;
    }
  }

  return {
    spanId: context.spanId,
    runId: context.runId,
    parentSpanId: context.parentSpanId,
    name: context.name,
    kind: context.kind,
    status: error !== undefined ? 'error' : 'ok',
    agent: context.agent,
    taskId: context.taskId,
    taskName: context.taskName,
    model: context.model,
    provider: context.provider,
    startedAt: context.startedAt,
    endedAt: end.endedAt,
    durationMs: end.endedAt - context.startedAt,
    error,
    attributes,
    tokenUsage: usage,
  };
}

/**
 * Sum token usage across spans.
 *
 * A dimension is reported only when at least one span supplied a
 * value; otherwise it stays `null` so "unavailable" is preserved
 * rather than being flattened to zero.
 */
export function aggregateTokenUsage(spans: readonly Span[]): SpanTokenUsage {
  let input: number | null = null;
  let output: number | null = null;
  let total: number | null = null;

  for (const span of spans) {
    const usage = span.tokenUsage;
    if (usage === undefined) continue;
    if (usage.inputTokens !== null) input = (input ?? 0) + usage.inputTokens;
    if (usage.outputTokens !== null) output = (output ?? 0) + usage.outputTokens;
    if (usage.totalTokens !== null) total = (total ?? 0) + usage.totalTokens;
  }

  return { inputTokens: input, outputTokens: output, totalTokens: total };
}