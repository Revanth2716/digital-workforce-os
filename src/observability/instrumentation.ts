/**
 * Instrumentation (Milestone 5-A).
 *
 * Wires the local tracer into the existing engine without
 * changing any orchestration logic. It observes the signals the
 * system already emits — the synchronous event bus and the
 * append-only evidence log — and turns them into spans.
 *
 * No hooks are added inside agents or the orchestrator, and no
 * existing module is modified, so Milestones 1-4 behaviour is
 * untouched.
 */

import type { TypedEventBus } from '../events/event-bus.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { JsonObject } from '../core/json.js';
import type { Clock } from '../core/types.js';
import type { LocalTracer } from './tracer.js';
import type { SpanContext } from './spans.js';

/** Options for the instrumentation. */
export interface InstrumentationOptions {
  readonly bus: TypedEventBus;
  readonly tracer: LocalTracer;
  readonly clock: Clock;
  readonly tools: ToolRegistry;
  /** Model/provider metadata for model spans. */
  readonly model?: string;
  readonly provider?: string;
}

/** Handle returned by `instrument()`. */
export interface InstrumentationHandle {
  /** Stop observing. Buffered spans remain readable via `tracer`. */
  dispose(): void;
  readonly tracer: LocalTracer;
}

/**
 * Attach instrumentation to a running system.
 *
 * Observed signals:
 * - `agent.start` / `agent.end`      -> `agent.execute` spans
 * - `evidence.recorded: model.call` -> token usage on the agent span
 * - `evidence.recorded: verification` -> `verification` spans
 * - `evidence.recorded: repair.started` -> `workflow.repair` spans
 * - `task.retried`                  -> `task.retry` spans
 * - registry audit                  -> `policy.*` spans
 */
export function instrument(options: InstrumentationOptions): InstrumentationHandle {
  const { bus, tracer, tools } = options;

  /** Currently executing run, used to attribute registry audits. */
  let currentRunId: string | undefined;
  /** taskId -> open agent span. */
  const openAgentSpans = new Map<string, SpanContext>();
  /** runId::callId -> open tool span. */
  const openToolSpans = new Map<string, SpanContext>();
  /** runId::taskId -> accumulated token usage. */
  const tokenUsage = new Map<string, { input: number; output: number; total: number }>();

  const taskKey = (runId: string, taskId: string | undefined): string =>
    `${runId}::${taskId ?? ''}`;

  // ---- Policy / security decisions from the tool registry ----
  const detachAudit = tools.onAudit((audit) => {
    const context = tracer.start({
      runId: currentRunId ?? 'unattributed',
      name: audit.refusalReason !== undefined ? 'policy.denial' : 'policy.decision',
      attributes: {
        'tool.name': audit.tool,
        'policy.decision': audit.policyDecision,
        'policy.allowed': audit.refusalReason === undefined,
        'policy.refusal_reason': audit.refusalReason ?? 'none',
      },
    });
    tracer.end(context);
  });

  // ---- Event-derived spans ----
  const off = bus.onAny((event) => {
    switch (event.type) {
      case 'task.retried': {
        const payload = event.payload as JsonObject;
        tracer.end(
          tracer.start({
            runId: event.runId,
            name: 'task.retry',
            taskId: event.taskId,
            attributes: {
              'retry.attempt': numberOr(payload['attempt'], 0),
              'retry.max_attempts': numberOr(payload['maxAttempts'], 0),
            },
          }),
        );
        return;
      }
      case 'evidence.recorded': {
        // Agent lifecycle, workflow lifecycle, model calls and
        // verification all arrive as evidence records rather than
        // typed events, so they are projected here.
        handleEvidence(event.runId, event.taskId, event.payload as JsonObject);
        return;
      }
      default:
        return;
    }
  });

  function handleEvidence(
    runId: string,
    taskId: string | undefined,
    payload: JsonObject,
  ): void {
    const kind = payload['kind'];
    const data = payload['data'];
    if (!isRecord(data)) return;

    switch (kind) {
      case 'workflow.started': {
        currentRunId = runId;
        return;
      }
      case 'workflow.outcome': {
        currentRunId = undefined;
        return;
      }
      case 'agent.start': {
        const agent = String(data['agent'] ?? 'unknown');
        openAgentSpans.set(
          taskId ?? '',
          tracer.start({
            runId,
            name: 'agent.execute',
            agent,
            taskId,
            ...(options.provider !== undefined ? { provider: options.provider } : {}),
            ...(options.model !== undefined ? { model: options.model } : {}),
            attributes: { 'agent.name': agent },
          }),
        );
        return;
      }
      case 'agent.end': {
        const context = openAgentSpans.get(taskId ?? '');
        if (context === undefined) return;
        openAgentSpans.delete(taskId ?? '');

        const failed = data['status'] === 'failed';
        const usage = tokenUsage.get(taskKey(runId, taskId));
        tracer.end(context, {
          ...(failed ? { error: `agent '${String(data['agent'])}' failed` } : {}),
          tokenUsage:
            usage !== undefined
              ? {
                  inputTokens: usage.input,
                  outputTokens: usage.output,
                  totalTokens: usage.total,
                }
              : undefined,
          attributes: { 'agent.status': String(data['status'] ?? 'unknown') },
        });
        return;
      }
      case 'model.call': {
        // Accumulate usage per task so it can be attached to the
        // enclosing agent span when the agent finishes.
        const key = taskKey(runId, taskId);
        const existing = tokenUsage.get(key) ?? { input: 0, output: 0, total: 0 };
        const prompt = numberOr(data['promptTokens'], 0);
        const completion = numberOr(data['completionTokens'], 0);
        existing.input += prompt;
        existing.output += completion;
        existing.total += numberOr(data['totalTokens'], prompt + completion);
        tokenUsage.set(key, existing);
        return;
      }
      case 'tool.call': {
        // Opened here and closed by the matching tool.result, keyed
        // by call id so concurrent calls stay distinct.
        openToolSpans.set(
          `${runId}::${String(data['callId'] ?? '')}`,
          tracer.start({
            runId,
            name: 'tool.call',
            taskId,
            attributes: { 'tool.name': String(data['tool'] ?? '') },
          }),
        );
        return;
      }
      case 'tool.result': {
        const key = `${runId}::${String(data['callId'] ?? '')}`;
        const context = openToolSpans.get(key);
        openToolSpans.delete(key);
        if (context === undefined) return;

        const ok = data['ok'] === true;
        tracer.end(context, {
          ...(ok ? {} : { error: String(data['error'] ?? 'tool call failed') }),
          attributes: {
            'tool.name': String(data['tool'] ?? ''),
            'tool.ok': ok,
          },
        });
        return;
      }
      case 'verification': {
        tracer.end(
          tracer.start({
            runId,
            name: 'verification',
            taskId,
            attributes: {
              'verification.passed': data['passed'] === true,
              'verification.cycle': numberOr(data['cycle'], 0),
            },
          }),
        );
        return;
      }
      case 'repair.started': {
        tracer.end(
          tracer.start({
            runId,
            name: 'workflow.repair',
            attributes: { 'repair.cycle': numberOr(data['cycle'], 0) },
          }),
        );
        return;
      }
      default:
        return;
    }
  }

  return {
    tracer,
    dispose(): void {
      off();
      detachAudit();
      openAgentSpans.clear();
      openToolSpans.clear();
      tokenUsage.clear();
      currentRunId = undefined;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Re-exported so callers can type a clock parameter. */
export type InstrumentationClock = Clock;